import fs from "node:fs";
import path from "node:path";
import { MockChain } from "./chain.ts";
import { Ledger } from "./ledger.ts";
import { PolicyStore, evaluatePolicy, effectiveBudgetMicro, slug, type RuntimePolicy } from "./policy.ts";
import { ApprovalStore, type DecideOptions } from "./approvals.ts";
import { ReservationStore } from "./reservations.ts";
import { ChannelStore } from "./channels.ts";
import { withLock } from "./lock.ts";
import { fmtUsdExact, usd } from "./money.ts";
import type { PayContext } from "./payer.ts";
import { CLI } from "./cli-name.ts";
import { NotifyStore, Notifier, startCloudHeartbeat } from "./notify.ts";
import { readMode, type SettlementMode } from "./mode.ts";
import { runtimeVersion } from "./version.ts";

interface AgentIdentity {
  address: string;
  agentName: string;
}

export interface AllowanceRuntime {
  agentName: string;
  address: string;
  stateDir: string;
  ctx: PayContext;
  ledger: Ledger;
  policyStore: PolicyStore;
  approvals: ApprovalStore;
  reservations: ReservationStore;
  notifyStore: NotifyStore;
  mode: SettlementMode;
  chain?: { faucet(address: string, amountMicro: bigint): void; balance(address: string): bigint };
  policy(): RuntimePolicy;
  escrowedMicro?(openReservationIds?: ReadonlySet<string>): bigint;
  stopHeartbeat?(): void;
}

export interface AgentRuntime extends AllowanceRuntime {
  chain: MockChain;
}

function identityFileName(agentName: string): string {
  return agentName === DEFAULT_AGENT_NAME ? "agent.json" : `agent.${slug(agentName)}.json`;
}

function loadOrCreateIdentity(chain: MockChain, stateDir: string, agentName: string): string {
  const file = path.join(stateDir, identityFileName(agentName));
  if (fs.existsSync(file)) {
    const { address } = JSON.parse(fs.readFileSync(file, "utf8")) as AgentIdentity;
    if (!chain.hasAccount(address))
      throw new Error(
        `agent identity ${address} missing from chain state — restore ${path.join(stateDir, "accounts.json")} ` +
          `or delete ${file} to reprovision`,
      );
    return address;
  }
  const { address } = chain.createAccount();
  fs.writeFileSync(file, JSON.stringify({ address, agentName } satisfies AgentIdentity, null, 2));
  return address;
}

export const DEFAULT_AGENT_NAME = "research-agent";

export function listAgents(stateDir: string): string[] {
  const seen = new Set<string>();
  try {
    for (const e of new Ledger(stateDir).read()) seen.add(e.agent);
  } catch {
    return [];
  }
  if (fs.existsSync(path.join(stateDir, "agent.json"))) seen.add(DEFAULT_AGENT_NAME);
  return [...seen].sort();
}

export interface PolicyRailsInput {
  agentName: string;
  address: string;
  stateDir: string;
  chain: PayContext["chain"];
  ledger: Ledger;
  policyStore: PolicyStore;
  approvals: ApprovalStore;
  reservations?: ReservationStore;
  notifier?: Notifier;
  walletBalance?: () => Promise<bigint | undefined>;
  escrowedMicro?: (openReservationIds?: ReadonlySet<string>) => bigint;
}

export function buildPolicyRails(
  input: PolicyRailsInput,
): Pick<PayContext, "authorize" | "recordPayment" | "recordBlocked" | "releaseReservation" | "policy"> {
  const { agentName, address, stateDir, chain, ledger, policyStore, approvals } = input;
  const reservations = input.reservations ?? new ReservationStore(stateDir);
  const notifier = input.notifier ?? new Notifier(new NotifyStore(stateDir, agentName), agentName);
  const lockPath = path.join(stateDir, "allowance.lock");
  const channels = new ChannelStore(stateDir);

  return {
    policy: () => policyStore.load(),

    authorize(amountMicro, url, scheme) {
      return withLock(lockPath, async () => {
        channels.repairAccounting(agentName);
        const policy = policyStore.load();
        const host = new URL(url).host;
        const windowMs = policy.windowSeconds * 1000;
        const t = ledger.totals(agentName, windowMs);
        const openReservations = reservations.list(agentName);
        const inFlight = openReservations.reduce((s, r) => s + BigInt(r.amountMicro), 0n);
        const reservationIds = new Set(openReservations.map((r) => r.id));
        const escrowedMicro = input.escrowedMicro?.(reservationIds) ??
          channels.escrowedMicro(agentName, { excludeReservationIds: reservationIds });

        const onChain = input.walletBalance ? await input.walletBalance() : undefined;
        const spendableOnChain =
          onChain === undefined ? undefined : onChain - inFlight > 0n ? onChain - inFlight : 0n;

        const decision = evaluatePolicy(policy, {
          host,
          amountMicro,
          spendTotalMicro: t.spendTotalMicro + inFlight,
          topupsMicro: t.topupsMicro,
          windowSpendMicro: t.windowSpendMicro + reservations.totalSince(agentName, windowMs),
          walletBalanceMicro: spendableOnChain,
          escrowedMicro,
          scheme,
        });
        if (!decision.allowed) return decision;

        if (amountMicro <= 0n) return { allowed: true as const };

        const needsApproval = amountMicro >= usd(policy.requireApprovalAboveUsd);
        const grant = needsApproval ? approvals.grantFor(host, amountMicro) : undefined;
        if (needsApproval && !grant) {
          const req = approvals.findOrCreate(agentName, url, host, amountMicro);
          notifier.approvalQueued(req.id, host, amountMicro, CLI);
          ledger.append({
            t: "approval_requested",
            at: new Date().toISOString(),
            agent: agentName,
            id: req.id,
            url,
            host,
            amountMicro: amountMicro.toString(),
          });
          return {
            allowed: false as const,
            rule: "human_approval_required" as const,
            detail:
              `${fmtUsdExact(amountMicro)}${scheme === "upto" ? " ceiling" : ""} is at or above your approval threshold of ` +
              `$${policy.requireApprovalAboveUsd.toFixed(2)} — request ${req.id} is queued for a human. ` +
              `Approve it with \`${CLI} approve ${req.id}\` or on the dashboard, then retry.`,
            recoverable: true,
            requestId: req.id,
            quotedMicro: amountMicro,
            capMicro: usd(policy.requireApprovalAboveUsd),
          };
        }

        const res = reservations.open(agentName, url, host, amountMicro, grant?.id);
        if (grant) approvals.commit(grant.id, amountMicro);
        return { allowed: true as const, reservationId: res.id };
      });
    },

    async recordPayment(url, host, amountMicro, txHash, reservationId, annotations) {
      await withLock(lockPath, () => {
        if (annotations?.channelId) {
          const existing = ledger.read().find((e) => e.t === "payment" && e.channelId === annotations.channelId);
          if (existing?.t === "payment") {
            if (existing.agent !== agentName || existing.amountMicro !== amountMicro.toString())
              throw new Error(`channel ${annotations.channelId} settlement conflicts with its audit payment`);
            return;
          }
          const channel = channels.get(annotations.channelId);
          if (channel) {
            if (amountMicro === 0n) channels.refund(channel.channelId, txHash);
            else channels.settle(channel.channelId, amountMicro, txHash);
            return;
          }
        }
        const closed = reservationId ? reservations.close(reservationId) : undefined;
        if (closed?.grantId) approvals.settleCommitment(closed.grantId, BigInt(closed.amountMicro), amountMicro);
        ledger.append({
          t: "payment",
          at: new Date().toISOString(),
          agent: agentName,
          url,
          host,
          amountMicro: amountMicro.toString(),
          txHash,
          balanceAfterMicro: chain.balance(address).toString(),
          ...(annotations?.scheme ? { scheme: annotations.scheme } : {}),
          ...(annotations?.depositMicro !== undefined ? { depositMicro: annotations.depositMicro.toString() } : {}),
          ...(annotations?.refundMicro !== undefined ? { refundMicro: annotations.refundMicro.toString() } : {}),
          ...(annotations?.channelId ? { channelId: annotations.channelId } : {}),
        });
      });
      const totals = ledger.totals(agentName, 0);
      notifier.spendChanged(totals.spendTotalMicro, effectiveBudgetMicro(policyStore.load(), totals.topupsMicro));
      notifier.paid(url, host, amountMicro, txHash);
    },

    async recordBlocked(url, host, rule, detail, attemptedMicro) {
      await withLock(lockPath, () => {
        ledger.append({
          t: "blocked",
          at: new Date().toISOString(),
          agent: agentName,
          url,
          host,
          rule,
          detail,
          attemptedMicro: attemptedMicro.toString(),
        });
      });
      notifier.blocked(host, rule, detail, attemptedMicro);
    },

    releaseReservation(id) {
      return withLock(lockPath, () => {
        const escrow = channels.active(agentName).find((c) => c.reservationId === id);
        const released = reservations.close(id);
        if (released?.grantId && !escrow) approvals.refund(released.grantId, BigInt(released.amountMicro));
      });
    },
  };
}

export function createAgent(stateDir: string, agentName = DEFAULT_AGENT_NAME): AgentRuntime {
  fs.mkdirSync(stateDir, { recursive: true });
  const chain = new MockChain(path.join(stateDir, "accounts.json"));
  const ledger = new Ledger(stateDir);
  const policyStore = new PolicyStore(stateDir, agentName);
  const approvals = new ApprovalStore(stateDir, agentName);
  const reservations = new ReservationStore(stateDir);
  const channels = new ChannelStore(stateDir);
  const escrowedMicro = (openReservationIds?: ReadonlySet<string>) =>
    channels.escrowedMicro(agentName, openReservationIds ? { excludeReservationIds: openReservationIds } : {});
  const notifyStore = new NotifyStore(stateDir, agentName);

  const marker = readMode(stateDir);
  const live = marker.mode === "live" && Boolean(marker.address);
  const notifier = new Notifier(notifyStore, agentName, undefined, {
    network: marker.network,
    mode: live ? "live" : "practice",
  });
  const address = live ? marker.address! : loadOrCreateIdentity(chain, stateDir, agentName);
  const railChain: PayContext["chain"] = live
    ? {
        sign: () => {
          throw new Error("this runtime cannot sign live payments — use createLiveAgent");
        },
        balance: () => ledger.topups(agentName) - ledger.spendTotal(agentName),
      }
    : chain;

  const ctx: PayContext = {
    agentName,
    address,
    chain: railChain,
    ...buildPolicyRails({ agentName, address, stateDir, chain: railChain, ledger, policyStore, approvals, reservations, notifier, escrowedMicro }),
  };

  const stopHeartbeat = startCloudHeartbeat(
    notifyStore.load().cloud,
    {
      agent: agentName,
      network: marker.network,
      mode: live ? "live" : "practice",
      version: runtimeVersion(),
    },
    { beat: () => ({ escrowedMicro: escrowedMicro().toString() }) },
  );

  return {
    agentName,
    address,
    stateDir,
    ctx,
    chain,
    ledger,
    policyStore,
    approvals,
    reservations,
    notifyStore,
    mode: live ? "live" : "practice",
    policy: () => policyStore.load(),
    escrowedMicro,
    stopHeartbeat,
  };
}

export function topUp(rt: AllowanceRuntime, amountUsd: number, source = "human::sdk"): bigint {
  if (!(amountUsd > 0)) throw new Error(`top-up must be a positive amount of dollars, got ${amountUsd}`);
  if (amountUsd > 1_000_000) throw new Error(`top-up of $${amountUsd} looks like a typo — the maximum is $1,000,000`);
  const micro = usd(amountUsd);
  const simulated = rt.mode !== "live" ? rt.chain : undefined;
  simulated?.faucet(rt.address, micro);
  const t = rt.ledger.totals(rt.agentName, 0);
  const balanceAfter = simulated
    ? simulated.balance(rt.address)
    : t.topupsMicro + micro - t.spendTotalMicro;
  rt.ledger.append({
    t: "topup",
    at: new Date().toISOString(),
    agent: rt.agentName,
    amountMicro: micro.toString(),
    source,
    balanceAfterMicro: balanceAfter.toString(),
  });
  return allowanceRemaining(rt);
}

export function decideApproval(
  rt: AllowanceRuntime,
  id: string,
  approve: boolean,
  opts: DecideOptions = {},
): boolean {
  const req = rt.approvals.decide(id, approve, opts);
  if (!req) return false;
  rt.ledger.append({
    t: "approval_decided",
    at: new Date().toISOString(),
    agent: rt.agentName,
    id: req.id,
    approved: approve,
    host: req.host,
    amountMicro: req.amountMicro,
  });
  return true;
}

export function allowanceRemaining(rt: AllowanceRuntime): bigint {
  const policy = rt.policy();
  const t = rt.ledger.totals(rt.agentName, 0);
  const configured = usd(policy.totalBudgetUsd);
  const budget = configured < t.topupsMicro ? configured : t.topupsMicro;
  const openReservations = rt.reservations.list(rt.agentName);
  const reserved = openReservations.reduce((s, r) => s + BigInt(r.amountMicro), 0n);
  const escrowed = rt.escrowedMicro?.(new Set(openReservations.map((r) => r.id))) ?? 0n;
  const remaining = budget - t.spendTotalMicro - reserved - escrowed;
  return remaining > 0n ? remaining : 0n;
}

export function modeOf(stateDir: string): SettlementMode {
  return readMode(stateDir).mode;
}
