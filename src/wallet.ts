import fs from "node:fs";
import path from "node:path";
import { MockChain } from "./chain.ts";
import { Ledger } from "./ledger.ts";
import { PolicyStore, evaluatePolicy, type RuntimePolicy } from "./policy.ts";
import { ApprovalStore } from "./approvals.ts";
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
  policy(): RuntimePolicy;
}

function loadOrCreateIdentity(chain: MockChain, stateDir: string, agentName: string): string {
  const file = path.join(stateDir, "agent.json");
  if (fs.existsSync(file)) {
    const { address } = JSON.parse(fs.readFileSync(file, "utf8")) as AgentIdentity;
    if (!chain.hasAccount(address))
      throw new Error(`agent identity ${address} missing from chain state — restore ${stateDir}accounts.json or delete ${file} to reprovision`);
    return address;
  }
  const { address } = chain.createAccount();
  fs.writeFileSync(file, JSON.stringify({ address, agentName } satisfies AgentIdentity, null, 2));
  return address;
}

export function createAgent(stateDir: string, agentName = "research-agent"): AgentRuntime {
  fs.mkdirSync(stateDir, { recursive: true });
  const chain = new MockChain(path.join(stateDir, "accounts.json"));
  const ledger = new Ledger(stateDir);
  const policyStore = new PolicyStore(stateDir);
  const approvals = new ApprovalStore(stateDir);
  const address = loadOrCreateIdentity(chain, stateDir, agentName);

  const ctx: PayContext = {
    agentName,
    address,
    chain,
    async authorize(amountMicro, url) {
      const policy = policyStore.load();
      const decision = evaluatePolicy(policy, {
        host: new URL(url).host,
        amountMicro,
        spendTotalMicro: ledger.spendTotal(agentName),
        topupsMicro: ledger.topups(agentName),
        windowSpendMicro: ledger.spendSince(agentName, policy.windowSeconds * 1000),
      });
      if (!decision.allowed) return decision;
      if (amountMicro >= usd(policy.requireApprovalAboveUsd)) {
        const host = new URL(url).host;
        if (approvals.grantCovers(host, amountMicro)) return { allowed: true };
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
          allowed: false,
          rule: "human_approval_required",
          detail: `${fmtUsdExact(amountMicro)} ≥ approval threshold $${policy.requireApprovalAboveUsd.toFixed(2)} — request ${req.id} queued; approve with \`node src/cli.ts approve ${req.id}\` or on the dashboard`,
          requestId: req.id,
        };
      }
      return { allowed: true };
    },
    recordPayment(url, host, amountMicro, txHash) {
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
    },
    recordBlocked(url, host, rule, detail, attemptedMicro) {
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
    },
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
    policy: () => policyStore.load(),
  };
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

export function allowanceRemaining(rt: AgentRuntime): bigint {
  return rt.ledger.topups(rt.agentName) - rt.ledger.spendTotal(rt.agentName);
}
