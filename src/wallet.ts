import path from "node:path";
import { MockChain } from "./chain.ts";
import { Ledger } from "./ledger.ts";
import { PolicyStore, evaluatePolicy, type RuntimePolicy } from "./policy.ts";
import type { PayContext } from "./payer.ts";

export interface AgentRuntime {
  agentName: string;
  address: string;
  ctx: PayContext;
  chain: MockChain;
  ledger: Ledger;
  policyStore: PolicyStore;
  policy(): RuntimePolicy;
}

export function createAgent(stateDir: string, agentName = "research-agent"): AgentRuntime {
  const chain = new MockChain(path.join(stateDir, "accounts.json"));
  const ledger = new Ledger(stateDir);
  const policyStore = new PolicyStore(stateDir);
  const { address } = chain.createAccount();

  const ctx: PayContext = {
    agentName,
    address,
    chain,
    async authorize(amountMicro, url) {
      const policy = policyStore.load();
      return evaluatePolicy(policy, {
        host: new URL(url).host,
        amountMicro,
        spendTotalMicro: ledger.spendTotal(agentName),
        topupsMicro: ledger.topups(agentName),
        windowSpendMicro: ledger.spendSince(agentName, policy.windowSeconds * 1000),
      });
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

  return { agentName, address, ctx, chain, ledger, policyStore, policy: () => policyStore.load() };
}

export function allowanceRemaining(rt: AgentRuntime): bigint {
  return rt.ledger.topups(rt.agentName) - rt.ledger.spendTotal(rt.agentName);
}
