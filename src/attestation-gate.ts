import type { IncomingMessage, ServerResponse } from "node:http";
import type { DecodedPayment } from "./types.ts";
import { payerOf } from "./types.ts";
import type { BehaviorSummary, SignedAttestation } from "./attestation.ts";
import { verifyAttestation } from "./attestation.ts";
import type { OnChainPolicy, OnChainVerifyResult } from "./attestation-chain.ts";
import type { IdentityPolicy, IdentityVerifyResult } from "./attestation-identity.ts";

export type AttestedHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  meter?: unknown,
) => void | Promise<void>;

export interface AttestationPolicy {
  header?: string;
  minPayments?: number;
  minVerifiableTxCount?: number;
  minApprovalsApproved?: number;
  minDistinctHosts?: number;
  minSpendMicro?: bigint;
  maxAgeSecs?: number;
  agents?: string[];
  bindToPayer?: boolean;
  onChain?: OnChainPolicy;
  identity?: IdentityPolicy;
  accept?: (summary: BehaviorSummary, signer: string) => boolean | Promise<boolean>;
  now?: number;
  onReject?: (reason: string, req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

export interface VerifiedAttestation {
  signer: string;
  summary: BehaviorSummary;
  onChain?: OnChainVerifyResult;
  identity?: IdentityVerifyResult;
}

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

    let identity: IdentityVerifyResult | undefined;
    if (policy.identity) {
      const { enforceIdentity } = await import("./attestation-identity.ts");
      let id: Awaited<ReturnType<typeof enforceIdentity>>;
      try {
        id = await enforceIdentity(att, policy.identity);
      } catch (e) {
        return deny(`registry identity error: ${e instanceof Error ? e.message : String(e)}`, req, res);
      }
      if (!id.ok) return deny(id.reason, req, res);
      identity = id.result;
    }

    let onChain: OnChainVerifyResult | undefined;
    if (policy.onChain) {
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

    (req as { attestation?: VerifiedAttestation }).attestation = { signer, summary, onChain, identity };
    await handler(req, res, meter);
  };
}
