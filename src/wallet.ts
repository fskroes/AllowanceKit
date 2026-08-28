import fs from "node:fs";
import path from "node:path";
import { MockChain } from "./chain.ts";
import { Ledger } from "./ledger.ts";
import { PolicyStore, evaluatePolicy, type RuntimePolicy } from "./policy.ts";
import { ApprovalStore } from "./approvals.ts";
import { ReservationStore } from "./reservations.ts";
import { withLock } from "./lock.ts";
import { fmtUsdExact, usd } from "./money.ts";
import type { PayContext } from "./payer.ts";

interface AgentIdentity {
  address: string;
  agentName: string;
}

export interface AgentRuntime {
  agentName: string;
  address: string;
  stateDir: string;
  ctx: PayContext;
  chain: MockChain;
  ledger: Ledger;
  policyStore: PolicyStore;
  approvals: ApprovalStore;
  reservations: ReservationStore;
  policy(): RuntimePolicy;
}

function loadOrCreateIdentity(chain: MockChain, stateDir: string, agentName: string): string {
  const file = path.join(stateDir, "agent.json");
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

export interface PolicyRailsInput {
  agentName: string;
  address: string;
  stateDir: string;
  chain: PayContext["chain"];
  ledger: Ledger;
  policyStore: PolicyStore;
  approvals: ApprovalStore;
  reservations?: ReservationStore;
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
  const lockPath = path.join(stateDir, "allowance.lock");

  return {
    policy: () => policyStore.load(),

    authorize(amountMicro, url) {
      return withLock(lockPath, () => {
        const policy = policyStore.load();
        const host = new URL(url).host;
        const windowMs = policy.windowSeconds * 1000;
        const t = ledger.totals(agentName, windowMs);

        const decision = evaluatePolicy(policy, {
          host,
          amountMicro,
          // In-flight payments count as spent until they settle or fail.
          spendTotalMicro: t.spendTotalMicro + reservations.total(agentName),
          topupsMicro: t.topupsMicro,
          windowSpendMicro: t.windowSpendMicro + reservations.totalSince(agentName, windowMs),
        });
        if (!decision.allowed) return decision;

        // The pre-flight check (amount 0) only screens the destination — there
        // is nothing to approve or reserve until the seller has quoted a price.
        if (amountMicro <= 0n) return { allowed: true as const };

        if (amountMicro >= usd(policy.requireApprovalAboveUsd) && !approvals.grantCovers(host, amountMicro)) {
          const req = approvals.findOrCreate(agentName, url, host, amountMicro);
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
              `Approve it with \`npx allowance-kit approve ${req.id}\` or on the dashboard, then retry.`,
            recoverable: true,
            requestId: req.id,
            quotedMicro: amountMicro,
            capMicro: usd(policy.requireApprovalAboveUsd),
          };
        }

        const res = reservations.open(agentName, url, host, amountMicro);
        return { allowed: true as const, reservationId: res.id };
      });
    },

    recordPayment(url, host, amountMicro, txHash, reservationId) {
      return withLock(lockPath, () => {
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
    },

    recordBlocked(url, host, rule, detail, attemptedMicro) {
      return withLock(lockPath, () => {
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
    },

    releaseReservation(id) {
      return withLock(lockPath, () => {
        reservations.close(id);
      });
    },
  };
}

export function createAgent(stateDir: string, agentName = DEFAULT_AGENT_NAME): AgentRuntime {
  fs.mkdirSync(stateDir, { recursive: true });
  const chain = new MockChain(path.join(stateDir, "accounts.json"));
  const ledger = new Ledger(stateDir);
  const policyStore = new PolicyStore(stateDir);
  const approvals = new ApprovalStore(stateDir);
  const reservations = new ReservationStore(stateDir);
  const address = loadOrCreateIdentity(chain, stateDir, agentName);

  const ctx: PayContext = {
    agentName,
    address,
    chain,
    ...buildPolicyRails({ agentName, address, stateDir, chain, ledger, policyStore, approvals, reservations }),
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
    policy: () => policyStore.load(),
  };
}

/**
 * Funds the agent's allowance. Both halves matter: the mock chain needs the
 * balance to settle against, and the ledger needs the top-up event or the
 * policy engine will report a funded wallet as `budget_exhausted`.
 */
export function topUp(rt: AgentRuntime, amountUsd: number, source = "human::sdk"): bigint {
  if (!(amountUsd > 0)) throw new Error(`top-up must be a positive amount of dollars, got ${amountUsd}`);
  if (amountUsd > 1_000_000) throw new Error(`top-up of $${amountUsd} looks like a typo — the maximum is $1,000,000`);
  const micro = usd(amountUsd);
  rt.chain.faucet(rt.address, micro);
  rt.ledger.append({
    t: "topup",
    at: new Date().toISOString(),
    agent: rt.agentName,
    amountMicro: micro.toString(),
    source,
    balanceAfterMicro: rt.chain.balance(rt.address).toString(),
  });
  return allowanceRemaining(rt);
}

export function decideApproval(rt: AgentRuntime, id: string, approve: boolean): boolean {
  const req = rt.approvals.decide(id, approve);
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
export function allowanceRemaining(rt: AgentRuntime): bigint {
  const policy = rt.policy();
  const t = rt.ledger.totals(rt.agentName, 0);
  const configured = usd(policy.totalBudgetUsd);
  const budget = configured < t.topupsMicro ? configured : t.topupsMicro;
  const remaining = budget - t.spendTotalMicro - rt.reservations.total(rt.agentName);
  return remaining > 0n ? remaining : 0n;
}
