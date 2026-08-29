import fs from "node:fs";
import path from "node:path";
import { MockChain } from "./chain.ts";
import { Ledger } from "./ledger.ts";
import { PolicyStore, evaluatePolicy, effectiveBudgetMicro, slug, type RuntimePolicy } from "./policy.ts";
import { ApprovalStore, type DecideOptions } from "./approvals.ts";
import { ReservationStore } from "./reservations.ts";
import { withLock } from "./lock.ts";
import { fmtUsdExact, usd } from "./money.ts";
import type { PayContext } from "./payer.ts";
import { CLI } from "./cli-name.ts";
import { NotifyStore, Notifier } from "./notify.ts";
import { readMode, type SettlementMode } from "./mode.ts";

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

  return {
    policy: () => policyStore.load(),

    authorize(amountMicro, url) {
      return withLock(lockPath, async () => {
        const policy = policyStore.load();
        const host = new URL(url).host;
        const windowMs = policy.windowSeconds * 1000;
        const t = ledger.totals(agentName, windowMs);
        const inFlight = reservations.total(agentName);

        // On a live rail the ledger says what the human allowed; the chain says
        // what is actually there. Both have to hold.
        const onChain = input.walletBalance ? await input.walletBalance() : undefined;
        const spendableOnChain =
          onChain === undefined ? undefined : onChain - inFlight > 0n ? onChain - inFlight : 0n;

        const decision = evaluatePolicy(policy, {
          host,
          amountMicro,
          // In-flight payments count as spent until they settle or fail.
          spendTotalMicro: t.spendTotalMicro + inFlight,
          topupsMicro: t.topupsMicro,
          windowSpendMicro: t.windowSpendMicro + reservations.totalSince(agentName, windowMs),
          walletBalanceMicro: spendableOnChain,
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
              `${fmtUsdExact(amountMicro)} is at or above your approval threshold of ` +
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

    async recordPayment(url, host, amountMicro, txHash, reservationId) {
      await withLock(lockPath, () => {
        if (reservationId) reservations.close(reservationId);
        ledger.append({
          t: "payment",
          at: new Date().toISOString(),
          agent: agentName,
          url,
          host,
          amountMicro: amountMicro.toString(),
          txHash,
          balanceAfterMicro: chain.balance(address).toString(),
        });
      });
      // Read the new totals outside the lock: this only reports, and holding a
      // write lock across a webhook call would serialise every parallel payer.
      const totals = ledger.totals(agentName, 0);
      notifier.spendChanged(totals.spendTotalMicro, effectiveBudgetMicro(policyStore.load(), totals.topupsMicro));
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
        const released = reservations.close(id);
        if (released?.grantId) approvals.refund(released.grantId, BigInt(released.amountMicro));
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
  const notifyStore = new NotifyStore(stateDir, agentName);
  const notifier = new Notifier(notifyStore, agentName);

  const marker = readMode(stateDir);
  const live = marker.mode === "live" && Boolean(marker.address);
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
    ...buildPolicyRails({ agentName, address, stateDir, chain: railChain, ledger, policyStore, approvals, reservations, notifier }),
  };

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

/** Spendable right now: the smaller of what was funded and the configured budget, minus spend and in-flight payments. */
export function allowanceRemaining(rt: AllowanceRuntime): bigint {
  const policy = rt.policy();
  const t = rt.ledger.totals(rt.agentName, 0);
  const configured = usd(policy.totalBudgetUsd);
  const budget = configured < t.topupsMicro ? configured : t.topupsMicro;
  const remaining = budget - t.spendTotalMicro - rt.reservations.total(rt.agentName);
  return remaining > 0n ? remaining : 0n;
}

/** Which rail a state directory is wired to, without constructing a runtime. */
export function modeOf(stateDir: string): SettlementMode {
  return readMode(stateDir).mode;
}
