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
 * Live networks (real x402 endpoints on Base) — real USDC moves:
 *   import { createLiveAgent, topUp } from "allowance-kit";
 *   const live = await createLiveAgent({
 *     stateDir: ".allowance",
 *     privateKey: process.env.AGENT_KEY!,
 *     network: "base-sepolia",          // "base" is mainnet; ask for it explicitly
 *   });
 *   topUp(live, 5);                     // the ceiling. The USDC itself you send to live.address
 *   await payingFetch(live.ctx, "https://paid.example.com/x");
 *
 * On a live agent the allowance and the wallet are both enforced: a payment the
 * allowance permits but the wallet cannot cover is blocked as `insufficient_funds`.
 *
 * Sellers: drop `paymentGate` into any node:http route with a facilitator
 * (MockChain for local/simulated, CdpFacilitator for Coinbase CDP).
 */
export { payingFetch } from "./payer.ts";
export type {
  PaidResult,
  PayContext,
  UnsignedPayment,
  BlockedBy,
  AuthorizeResult,
  PaymentAnnotations,
  UptoBuyer,
  UptoOpen,
  UptoOutcome,
} from "./payer.ts";

export {
  createAgent,
  topUp,
  decideApproval,
  allowanceRemaining,
  buildPolicyRails,
  listAgents,
  modeOf,
  DEFAULT_AGENT_NAME,
} from "./wallet.ts";
export type { AgentRuntime, AllowanceRuntime, PolicyRailsInput } from "./wallet.ts";

export { readMode, writeMode, describeMode, describeTopUp, PRACTICE_BANNER } from "./mode.ts";
export type { ModeInfo, SettlementMode } from "./mode.ts";

export { usdcBalanceMicro, BalanceCache, RPC_DEFAULTS, RpcError } from "./usdc.ts";

export { createLiveAgent, encodePaymentEvm, NETWORKS } from "./live.ts";
export type { LiveAgentOptions, LiveAgentRuntime, NetworkInfo } from "./live.ts";

export {
  SOLANA_NETWORKS,
  solanaSigner,
  usdcBalanceMicroSolana,
  solBalanceLamportsSolana,
  encodePaymentSolanaExact,
  encodePaymentSolanaUpto,
} from "./solana.ts";
export type { SolanaNetworkInfo, SolanaSigner, UptoOpenResult, UptoChannelFacts } from "./solana.ts";

// SOL-03: the Solana `upto` channel primitives and the buyer's escrow store.
export {
  VOUCHER_MAGIC,
  VOUCHER_PAYLOAD_SIZE,
  encodeVoucher,
  decodeVoucher,
  signVoucher,
  verifyVoucher,
  checkVoucher,
} from "./voucher.ts";
export type { Voucher, VoucherState, VoucherRejection } from "./voucher.ts";
export {
  ChannelStore,
  PAYMENT_CHANNELS_PROGRAM,
  CHANNEL_STATUS,
  decodeChannelAccount,
  solanaAccountRpc,
  reconcileChannels,
  reclaimChannel,
  planReclaim,
  buildReclaimInstructions,
} from "./channels.ts";
export type {
  OpenChannelInput,
  ChannelRpc,
  ChannelOnChain,
  ReconcileChange,
  ReclaimOptions,
  ReclaimResult,
  ReclaimStep,
  ReclaimPlan,
  ChannelInstruction,
  ReclaimAddresses,
} from "./channels.ts";

export { MockChain } from "./chain.ts";
export type { Facilitator } from "./chain.ts";

export { CdpFacilitator } from "./facilitator-cdp.ts";
export type { CdpFacilitatorOptions } from "./facilitator-cdp.ts";

export { paymentGate } from "./seller.ts";
export type { GateOptions, GateHandler, UptoConfig, SolanaOperatorEnv } from "./seller.ts";

// SOL-04: the self-facilitated Solana `upto` seller.
export {
  Meter,
  uptoPaymentGate,
  advertiseUptoOffer,
  InMemoryUptoOperator,
  createSolanaUptoOperator,
  toFacilitatorUptoPayload,
  checkTreasuryAta,
  DEFAULT_WITHDRAW_DELAY,
  PAYMENT_CHANNELS_TREASURY_OWNER,
} from "./seller-upto.ts";
export type {
  UptoOperator,
  UptoGateOptions,
  UptoHandler,
  UptoPaymentEnvelope,
  DepositOutcome,
  ClaimOutcome,
  OfferExtraInput,
  BeforeServeInfo,
  BeforeServeDecision,
  InMemoryUptoOperatorOptions,
  SolanaUptoOperatorOptions,
  TreasuryAtaCheck,
} from "./seller-upto.ts";

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
  policyFileName,
} from "./policy.ts";
export type { PolicyConfig, RuntimePolicy, PolicyDecision, PolicyRule, PolicyField } from "./policy.ts";

export {
  NotifyStore,
  Notifier,
  deliver,
  deliverCloud,
  startHeartbeat,
  startCloudHeartbeat,
  cloudWhoami,
  stripQuery,
  defaultNotifyConfig,
  providerEnvVar,
  TWILIO_ENV,
  CLOUD_ENV,
  CLOUD_DEFAULT_URL,
} from "./notify.ts";
export type {
  NotifyConfig,
  NotifyEvent,
  Message as NotifyMessage,
  DeliveryResult,
  DeliveryFailure,
  CloudConfig,
  CloudEvent,
  CloudEventKind,
  CloudHeartbeat,
} from "./notify.ts";

export { Ledger } from "./ledger.ts";
export type { LedgerEvent, LedgerTotals } from "./ledger.ts";
export { ApprovalStore, DEFAULT_GRANT_TTL_MS } from "./approvals.ts";
export type { ApprovalRequest, DecideOptions } from "./approvals.ts";
export { ReservationStore } from "./reservations.ts";
export type { Reservation } from "./reservations.ts";

/** The five x402-priced sample APIs behind `allowance demo`. */
export { startSellerApis, describeServers, startUptoDemoServer } from "./demo-servers.ts";
export type { DemoServer, PaidApiCatalog, UptoDemoServer } from "./demo-servers.ts";
export { runDemo } from "./demo-run.ts";

export { usd, fmtUsd, fmtUsdExact, MICRO } from "./money.ts";
export type {
  AcceptsEntry,
  PaymentRequiredBody,
  PaymentPayload,
  DecodedPayment,
  VerifyResult,
  SettleResult,
  SolanaExactPayload,
  UptoPayload,
  ChannelRecord,
  ChannelStatus,
} from "./types.ts";
