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

/**
 * Everything an allowance needs, independent of how payments actually settle.
 *
 * The CLI, the dashboard, `topUp` and `decideApproval` all work against this
 * shape, so a live-network agent gets the same funding, approval and audit
 * machinery as a practice-money one instead of a second, thinner copy of it.
 */
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
  /** Which rail this runtime settles on — practice money, or real USDC. */
  mode: SettlementMode;
  /** Present only on practice money: the simulated ledger that holds the balance. */
  chain?: { faucet(address: string, amountMicro: bigint): void; balance(address: string): bigint };
  policy(): RuntimePolicy;
  /**
   * Micro-USDC locked in open payment channels (Solana `upto`).
   * `allowanceRemaining` and the dashboard subtract it alongside spend and
   * reservations (§5). Pass the still-open reservation ids so a channel already
   * counted as `reserved` is not counted twice; omit them for a gross on-chain
   * escrow figure. Zero — and usually absent — off Solana.
   */
  escrowedMicro?(openReservationIds?: ReadonlySet<string>): bigint;
  /**
   * Stops the cloud heartbeat this runtime started, if any. The timer is unref'd
   * so a short-lived process need not call it; long-running callers (dashboard,
   * a headless agent) should, on shutdown.
   */
  stopHeartbeat?(): void;
}

export interface AgentRuntime extends AllowanceRuntime {
  chain: MockChain;
}

/** The default agent keeps `agent.json`; every other agent in the directory gets its own. */
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

/**
 * The name every ledger entry is filed under. Spend, top-ups and the remaining
 * allowance are all per-agent-name, so the CLI and the SDK must agree on it or
 * an agent will look unfunded. Override deliberately when running more than
 * one agent against a single state dir.
 */
export const DEFAULT_AGENT_NAME = "research-agent";

/** Every agent name that has ever appeared in a directory's audit ledger. */
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
  /**
   * Live rails only: the payer wallet's real on-chain balance. Consulted inside
   * the allowance lock, so it must be cheap — cache it. Returning `undefined`
   * (an unreachable node) falls back to the ledger rather than freezing the
   * agent over someone else's outage.
   */
  walletBalance?: () => Promise<bigint | undefined>;
  /**
   * Solana `upto` only: micro-USDC locked in open payment channels, read under
   * the allowance lock so a channel mutation and a policy decision never
   * interleave. The budget rail subtracts it (§5). `openReservationIds` are the
   * reservations still in flight; a channel opened by one of them is already
   * counted as `reserved`, so it is skipped here to avoid double-counting the
   * same ceiling. Absent off Solana, where it is always zero.
   */
  escrowedMicro?: (openReservationIds?: ReadonlySet<string>) => bigint;
}

/**
 * The allowance rails — policy evaluation, reservation of in-flight spend, and
 * audit logging — shared by every agent runtime regardless of settlement rail
 * (mock or real).
 *
 * `authorize` runs under a state-dir lock and reserves the amount it approves,
 * so parallel calls cannot each authorize against the same stale ledger total.
 */
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
        // Deposits locked in open channels are money committed but not yet a
        // `payment` row; the budget rail subtracts them (§5). A channel still
        // backed by an open reservation is already counted in `inFlight`, so it
        // is excluded here — reserved and escrowed must not overlap. Read under
        // the same lock as everything else. Zero off Solana.
        const reservationIds = new Set(openReservations.map((r) => r.id));
        const escrowedMicro = input.escrowedMicro?.(reservationIds) ??
          channels.escrowedMicro(agentName, { excludeReservationIds: reservationIds });

        // On a live rail the ledger says what the human allowed; the chain says
        // what is actually there. Both have to hold. Escrow has already left the
        // wallet, so the on-chain figure need not net it out again.
        const onChain = input.walletBalance ? await input.walletBalance() : undefined;
        const spendableOnChain =
          onChain === undefined ? undefined : onChain - inFlight > 0n ? onChain - inFlight : 0n;

        const decision = evaluatePolicy(policy, {
          host,
          amountMicro,
          // In-flight payments count as spent until they settle or fail. A
          // Solana `upto` open counts here as a reservation for its ceiling
          // (opened in `authorize`), which is how velocity "counts opens" (§5).
          spendTotalMicro: t.spendTotalMicro + inFlight,
          topupsMicro: t.topupsMicro,
          windowSpendMicro: t.windowSpendMicro + reservations.totalSince(agentName, windowMs),
          walletBalanceMicro: spendableOnChain,
          escrowedMicro,
          scheme,
        });
        if (!decision.allowed) return decision;

        // The pre-flight check (amount 0) only screens the destination — there
        // is nothing to approve or reserve until the seller has quoted a price.
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
        // A grant is spent, not just checked: draw it down now and hand it back
        // in `releaseReservation` if this payment never settles.
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
        // A grant is drawn down by the reserved amount at authorize. On `exact`
        // that equals the settled amount, so this is a no-op; on `upto` the
        // reservation held the ceiling and the seller charged `amountMicro`, so
        // the difference goes back to the grant — draw down by ceiling, refund by
        // refundMicro (§5).
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
          // Solana `upto` only: the actual charge stays in `amountMicro` (so
          // budget/velocity are unchanged); these annotate the escrow settlement.
          ...(annotations?.scheme ? { scheme: annotations.scheme } : {}),
          ...(annotations?.depositMicro !== undefined ? { depositMicro: annotations.depositMicro.toString() } : {}),
          ...(annotations?.refundMicro !== undefined ? { refundMicro: annotations.refundMicro.toString() } : {}),
          ...(annotations?.channelId ? { channelId: annotations.channelId } : {}),
        });
      });
      // Read the new totals outside the lock: this only reports, and holding a
      // write lock across a webhook call would serialise every parallel payer.
      const totals = ledger.totals(agentName, 0);
      notifier.spendChanged(totals.spendTotalMicro, effectiveBudgetMicro(policyStore.load(), totals.topupsMicro));
      // The cloud feed gets every paid row, not just the ones that cross a threshold.
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
        // Unknown escrow still owns this grant commitment, even after the
        // short reservation is released or expires. Recovery refunds it once.
        const escrow = channels.active(agentName).find((c) => c.reservationId === id);
        const released = reservations.close(id);
        if (released?.grantId && !escrow) approvals.refund(released.grantId, BigInt(released.amountMicro));
      });
    },
  };
}

/**
 * The management runtime for a state directory: limits, approvals, funding and
 * the audit ledger, with practice-money settlement attached.
 *
 * A directory a live agent has claimed keeps its real payer address and reports
 * `mode: "live"`, because the CLI and the dashboard read this and a human must
 * never be shown a simulated address or the words "practice money" over an
 * allowance that governs real USDC. Signing still lives in `createLiveAgent` —
 * this side never holds a private key.
 */
export function createAgent(stateDir: string, agentName = DEFAULT_AGENT_NAME): AgentRuntime {
  fs.mkdirSync(stateDir, { recursive: true });
  const chain = new MockChain(path.join(stateDir, "accounts.json"));
  const ledger = new Ledger(stateDir);
  const policyStore = new PolicyStore(stateDir, agentName);
  const approvals = new ApprovalStore(stateDir, agentName);
  const reservations = new ReservationStore(stateDir);
  // The buyer's book of open channels. Practice money never opens one, so this
  // reports zero escrow in normal use; it exists here so every runtime — mock or
  // live — subtracts escrow uniformly, and so a directory a live agent later
  // claims already reads its channels back (§5).
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
  // On a live directory the simulated balance is meaningless; the ledger is the
  // only number that means anything without a private key in hand.
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

  // A headless agent on a server is covered too: the heartbeat runs whenever a
  // runtime exists, not only while the local dashboard is open. Unref'd, so a
  // one-shot CLI command still exits at once.
  const stopHeartbeat = startCloudHeartbeat(
    notifyStore.load().cloud,
    {
      agent: agentName,
      network: marker.network,
      mode: live ? "live" : "practice",
      version: runtimeVersion(),
    },
    // Report locked value so the cloud overview shows escrow without waiting for
    // an event (SOL-08, §6). No chain reconcile here — this generic runtime holds
    // no RPC; the live Solana agent (createLiveAgent) does that in its own beat.
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

/**
 * Funds the agent's allowance.
 *
 * On practice money both halves matter: the mock chain needs the balance to
 * settle against, and the ledger needs the top-up event or the policy engine
 * will report a funded wallet as `budget_exhausted`.
 *
 * On a live rail there is no faucet — real USDC arrives by being sent to the
 * agent's wallet. This records the *ceiling* the human is willing to let the
 * agent spend out of that wallet. Both numbers are enforced: see
 * `insufficient_funds`.
 */
export function topUp(rt: AllowanceRuntime, amountUsd: number, source = "human::sdk"): bigint {
  if (!(amountUsd > 0)) throw new Error(`top-up must be a positive amount of dollars, got ${amountUsd}`);
  if (amountUsd > 1_000_000) throw new Error(`top-up of $${amountUsd} looks like a typo — the maximum is $1,000,000`);
  const micro = usd(amountUsd);
  // Real money has no faucet: on a live rail this records the ceiling only.
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

/**
 * Spendable right now: the smaller of what was funded and the configured budget,
 * minus spend, in-flight reservations, and micro-USDC locked in open channels.
 * With one open channel this is exactly `budget − spent − reserved − escrowed`
 * (§5) — escrow is money committed on-chain but not yet a settled `payment` row.
 */
export function allowanceRemaining(rt: AllowanceRuntime): bigint {
  const policy = rt.policy();
  const t = rt.ledger.totals(rt.agentName, 0);
  const configured = usd(policy.totalBudgetUsd);
  const budget = configured < t.topupsMicro ? configured : t.topupsMicro;
  const openReservations = rt.reservations.list(rt.agentName);
  const reserved = openReservations.reduce((s, r) => s + BigInt(r.amountMicro), 0n);
  // Exclude channels still backed by an open reservation — their ceiling is in
  // `reserved` already, so counting the escrow too would subtract it twice (§5).
  const escrowed = rt.escrowedMicro?.(new Set(openReservations.map((r) => r.id))) ?? 0n;
  const remaining = budget - t.spendTotalMicro - reserved - escrowed;
  return remaining > 0n ? remaining : 0n;
}

/** Which rail a state directory is wired to, without constructing a runtime. */
export function modeOf(stateDir: string): SettlementMode {
  return readMode(stateDir).mode;
}
