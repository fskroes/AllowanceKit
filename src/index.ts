/**
 * AllowanceKit public API.
 *
 *   import { payingFetch, createAgent, topUp } from "allowance-kit";
 *
 * Mock settlement (default — simulated funds, nothing real moves):
 *   const agent = createAgent(".allowance");        // same default name the CLI uses
 *   topUp(agent, 5);                                // fund the allowance
 *   const res = await payingFetch(agent.ctx, "https://api.example.com/data");
 *
 * The host allowlist is default-deny, so allow the destination first:
 *   agent.policyStore.save({ allowHostSuffixes: ["api.example.com"] });
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
export type { PaidResult, PayContext, UnsignedPayment, BlockedBy, AuthorizeResult } from "./payer.ts";

export {
  createAgent,
  topUp,
  decideApproval,
  allowanceRemaining,
  buildPolicyRails,
  DEFAULT_AGENT_NAME,
} from "./wallet.ts";
export type { AgentRuntime, PolicyRailsInput } from "./wallet.ts";

export { createLiveAgent, encodePaymentEvm, NETWORKS } from "./live.ts";
export type { LiveAgentOptions, LiveAgentRuntime, NetworkInfo } from "./live.ts";

export { MockChain } from "./chain.ts";
export type { Facilitator } from "./chain.ts";

export { CdpFacilitator } from "./facilitator-cdp.ts";
export type { CdpFacilitatorOptions } from "./facilitator-cdp.ts";

export { paymentGate } from "./seller.ts";
export type { GateOptions } from "./seller.ts";

export {
  PolicyStore,
  evaluatePolicy,
  defaultPolicy,
  validatePolicyPatch,
  policyWarnings,
  effectiveBudgetMicro,
  PolicyValidationError,
  POLICY_FIELDS,
  RULE_LABELS,
} from "./policy.ts";
export type { PolicyConfig, RuntimePolicy, PolicyDecision, PolicyRule, PolicyField } from "./policy.ts";

export { Ledger } from "./ledger.ts";
export type { LedgerEvent, LedgerTotals } from "./ledger.ts";
export { ApprovalStore } from "./approvals.ts";
export type { ApprovalRequest } from "./approvals.ts";
export { ReservationStore } from "./reservations.ts";
export type { Reservation } from "./reservations.ts";

/** The five x402-priced sample APIs behind `allowance demo`. */
export { startSellerApis, describeServers } from "./demo-servers.ts";
export type { DemoServer, PaidApiCatalog } from "./demo-servers.ts";
export { runDemo } from "./demo-run.ts";

export { usd, fmtUsd, fmtUsdExact, MICRO } from "./money.ts";
export type {
  AcceptsEntry,
  PaymentRequiredBody,
  PaymentPayload,
  DecodedPayment,
  VerifyResult,
  SettleResult,
} from "./types.ts";
