import type { IncomingMessage, ServerResponse } from "node:http";
import type { DecodedPayment } from "./types.ts";
import { payerOf } from "./types.ts";
import type { BehaviorSummary, SignedAttestation } from "./attestation.ts";
import { verifyAttestation } from "./attestation.ts";
import type { OnChainPolicy, OnChainVerifyResult } from "./attestation-chain.ts";

/**
 * Seller-side reputation gate (PoC, v1). A buyer presents a signed
 * behavior attestation (docs/attestation.md); this middleware verifies the
 * signature, checks the claim clears the seller's bar, and only then runs the
 * protected handler. It is the seller half of the two-sided trust primitive:
 * `paymentGate` gates on money, `requireAttestation` gates on track record.
 *
 * It has the same Node handler shape as a `paymentGate` handler, so it composes
 * either side of one:
 *   - reputation first:  requireAttestation(policy, paymentGate(gateOpts, h))
 *   - payment first:     paymentGate(gateOpts, requireAttestation(policy, h))
 *
 * Wire: the buyer sends the attestation as base64-encoded JSON in the
 * `X-Attestation` header (same encoding convention as `X-PAYMENT`).
 *
 * Replay: an attestation is signed but not secret, so a low-reputation buyer
 * could copy another agent's attestation. Set `bindToPayer: true` when the same
 * request also carries an `X-PAYMENT` header (payment-first composition): the
 * gate then requires the payment's payer address to equal the attestation
 * agent, so a replayed attestation from an address that did not pay is refused.
 */

/** A protected handler; `meter` is forwarded untouched so this composes with `paymentGate`. */
export type AttestedHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  meter?: unknown,
) => void | Promise<void>;

export interface AttestationPolicy {
  /** Header the attestation arrives in (lowercase). Default `"x-attestation"`. */
  header?: string;
  /** Minimum settled payments the agent must have. */
  minPayments?: number;
  /** Minimum on-chain-checkable payments (`verifiableTxCount`). */
  minVerifiableTxCount?: number;
  /** Minimum human-approved payments. */
  minApprovalsApproved?: number;
  /** Minimum distinct counterparties. */
  minDistinctHosts?: number;
  /** Minimum total spent, micro-dollars. */
  minSpendMicro?: bigint;
  /** Reject a claim older than this many seconds, even if it has not expired. */
  maxAgeSecs?: number;
  /** Allowlist of agent addresses (case-insensitive). Omit to accept any address that clears the bar. */
  agents?: string[];
  /** Require the request's `X-PAYMENT` payer to equal the attestation agent (anti-replay). */
  bindToPayer?: boolean;
  /**
   * Re-check the txHash evidence on-chain (v2). The buyer must have attested with
   * `includeEvidence`. Adds an RPC round-trip per evidence tx, so prefer gating
   * before pricing and caching per agent. Names the network (or a `client`/
   * `rpcUrl`) and how many must verify (`minVerified`/`requireAll`).
   */
  onChain?: OnChainPolicy;
  /** Last-word predicate; return false (or throw) to reject after all built-in checks pass. */
  accept?: (summary: BehaviorSummary, signer: string) => boolean | Promise<boolean>;
  /** Override "now" (unix seconds), for tests. */
  now?: number;
  /** Custom rejection response. Default: 403 JSON `{ error: "attestation_rejected", reason }`. */
  onReject?: (reason: string, req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

/** What a passing check attaches to the request for the handler to read. */
export interface VerifiedAttestation {
  signer: string;
  summary: BehaviorSummary;
  /** The on-chain tally, present only when `policy.onChain` ran. */
  onChain?: OnChainVerifyResult;
}

/** Read the verified attestation a `requireAttestation` gate attached to a served request. */
export function attestationOf(req: IncomingMessage): VerifiedAttestation | undefined {
  return (req as { attestation?: VerifiedAttestation }).attestation;
}

function decodeHeader(raw: string): SignedAttestation | null {
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as SignedAttestation;
  } catch {
    return null;
  }
}

/**
 * Wrap a handler so it runs only for a buyer whose signed attestation verifies
 * and clears `policy`. Returns a Node handler with the same shape `paymentGate`
 * expects and produces.
 */
export function requireAttestation(policy: AttestationPolicy, handler: AttestedHandler): AttestedHandler {
  const headerName = policy.header ?? "x-attestation";
  const allow = policy.agents?.map((a) => a.toLowerCase());

  const deny = async (reason: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (policy.onReject) {
      await policy.onReject(reason, req, res);
      return;
    }
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "attestation_rejected", reason }));
  };

  return async (req: IncomingMessage, res: ServerResponse, meter?: unknown): Promise<void> => {
    const rawHeader = req.headers[headerName];
    const raw = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (typeof raw !== "string" || !raw) return deny("attestation required", req, res);

    const att = decodeHeader(raw);
    if (!att) return deny("malformed attestation header", req, res);

    const now = policy.now;
    // Signature/window/digest only here. The on-chain re-check is the expensive
    // step (an RPC per evidence tx), so it runs last, after the cheap floors have
    // rejected any request that would fail anyway.
    const result = await verifyAttestation(att, now === undefined ? {} : { now });
    if (!result.valid) return deny(result.reason, req, res);

    const { summary, signer } = result;
    const nowSecs = now ?? Math.floor(Date.now() / 1000);

    if (policy.maxAgeSecs !== undefined && nowSecs - att.issuedAt > policy.maxAgeSecs)
      return deny(`attestation is stale (older than ${policy.maxAgeSecs}s)`, req, res);

    if (allow && !allow.includes(signer.toLowerCase()))
      return deny("agent is not on the seller's allowlist", req, res);

    if (policy.minPayments !== undefined && summary.payments < policy.minPayments)
      return deny(`needs >= ${policy.minPayments} payments, has ${summary.payments}`, req, res);
    if (policy.minVerifiableTxCount !== undefined && summary.verifiableTxCount < policy.minVerifiableTxCount)
      return deny(`needs >= ${policy.minVerifiableTxCount} on-chain-checkable payments, has ${summary.verifiableTxCount}`, req, res);
    if (policy.minApprovalsApproved !== undefined && summary.approvalsApproved < policy.minApprovalsApproved)
      return deny(`needs >= ${policy.minApprovalsApproved} approved payments, has ${summary.approvalsApproved}`, req, res);
    if (policy.minDistinctHosts !== undefined && summary.distinctHosts < policy.minDistinctHosts)
      return deny(`needs >= ${policy.minDistinctHosts} distinct counterparties, has ${summary.distinctHosts}`, req, res);
    if (policy.minSpendMicro !== undefined && BigInt(summary.spendTotalMicro) < policy.minSpendMicro)
      return deny(`needs >= ${policy.minSpendMicro} micro-dollars spent, has ${summary.spendTotalMicro}`, req, res);

    if (policy.bindToPayer) {
      const payHeader = req.headers["x-payment"];
      const payRaw = Array.isArray(payHeader) ? payHeader[0] : payHeader;
      if (typeof payRaw !== "string" || !payRaw)
        return deny("bindToPayer is set but the request carries no X-PAYMENT to bind to", req, res);
      let payer: string | null;
      try {
        payer = payerOf(JSON.parse(Buffer.from(payRaw, "base64").toString("utf8")) as DecodedPayment);
      } catch {
        payer = null;
      }
      if (!payer) return deny("could not read the payer from X-PAYMENT to bind the attestation", req, res);
      if (payer.toLowerCase() !== signer.toLowerCase())
        return deny("attestation agent does not match the paying address", req, res);
    }

    if (policy.accept) {
      let ok: boolean;
      try {
        ok = await policy.accept(summary, signer);
      } catch (e) {
        return deny(`policy predicate threw: ${e instanceof Error ? e.message : String(e)}`, req, res);
      }
      if (!ok) return deny("rejected by the seller's policy predicate", req, res);
    }

    let onChain: OnChainVerifyResult | undefined;
    if (policy.onChain) {
      // Lazy import: a gate without an onChain policy never pulls an RPC client in.
      const { enforceOnChain } = await import("./attestation-chain.ts");
      let chain: Awaited<ReturnType<typeof enforceOnChain>>;
      try {
        chain = await enforceOnChain(att, policy.onChain);
      } catch (e) {
        return deny(`on-chain verification error: ${e instanceof Error ? e.message : String(e)}`, req, res);
      }
      if (!chain.ok) return deny(chain.reason, req, res);
      onChain = chain.result;
    }

    (req as { attestation?: VerifiedAttestation }).attestation = { signer, summary, onChain };
    await handler(req, res, meter);
  };
}
