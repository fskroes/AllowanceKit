/**
 * AllowanceKit public API.
 *
 *   import { payingFetch, createAgent } from "allowance-kit";
 *
 * Mock settlement (default, simulated funds):
 *   const agent = createAgent(".allowance", "my-agent");
 *   const res = await payingFetch(agent.ctx, "https://api.example.com/data");
 *
 * Live networks (real x402 endpoints on Base):
 *   import { createLiveAgent } from "allowance-kit";
 *   const live = await createLiveAgent({ stateDir: ".allowance", privateKey: "0x…" });
 *   await payingFetch(live.ctx, "https://paid.example.com/x");
 *
 * Sellers: drop `paymentGate` into any node:http route with a facilitator
 * (MockChain for local/simulated, CdpFacilitator for Coinbase CDP).
 */
export { payingFetch } from "./payer.ts";
export type { PaidResult, PayContext, UnsignedPayment } from "./payer.ts";

export { createAgent, decideApproval, allowanceRemaining, buildPolicyRails } from "./wallet.ts";
export type { AgentRuntime } from "./wallet.ts";

export { createLiveAgent, encodePaymentEvm, NETWORKS } from "./live.ts";
export type { LiveAgentOptions, LiveAgentRuntime, NetworkInfo } from "./live.ts";

export { MockChain } from "./chain.ts";
export type { Facilitator } from "./chain.ts";

export { CdpFacilitator } from "./facilitator-cdp.ts";
export type { CdpFacilitatorOptions } from "./facilitator-cdp.ts";

export { paymentGate } from "./seller.ts";
export type { GateOptions } from "./seller.ts";

export { PolicyStore, evaluatePolicy, defaultPolicy } from "./policy.ts";
export type { PolicyConfig, RuntimePolicy, PolicyDecision } from "./policy.ts";

export { Ledger } from "./ledger.ts";
export type { LedgerEvent } from "./ledger.ts";
export { ApprovalStore } from "./approvals.ts";
export type { ApprovalRequest } from "./approvals.ts";

export { usd, fmtUsd, fmtUsdExact, MICRO } from "./money.ts";
export type {
  AcceptsEntry,
  PaymentRequiredBody,
  PaymentPayload,
  DecodedPayment,
  VerifyResult,
  SettleResult,
} from "./types.ts";
