import type { IncomingMessage, ServerResponse } from "node:http";
import type { Facilitator } from "./chain.ts";
import type { AcceptsEntry, DecodedPayment, PaymentRequiredBody } from "./types.ts";
import { flatAmount, payeeOf } from "./types.ts";
import { NETWORKS, family } from "./live.ts";
import { solanaNetworkInfo } from "./solana.ts";

export interface GateOptions {
  priceMicro: bigint;
  description: string;
  payTo: string;
  facilitator: Facilitator;
  /** e.g. "mock-ledger", "base-sepolia", "base", or a Solana id ("solana", "solana-devnet", CAIP-2). */
  network?: string;
}

/**
 * The x402 protocol version the gate advertises for a network. EVM stays v1 so
 * the Base 402 body is byte-identical to what it always emitted. Solana `exact`
 * is a v2-era scheme (CAIP-2 network, mint asset, an unsigned fee-payer slot),
 * so a Solana gate advertises v2.
 */
function versionFor(network: string): number {
  return family(network) === "solana" ? 2 : 1;
}

/**
 * The offers this gate advertises for `resource`. Returned as an array because a
 * v2 seller may list several and the buyer's `selectOffer` takes a list; a gate
 * is single-network today, so the array holds one offer.
 *
 * EVM: the asset is the USDC contract address and `extra` carries that
 * contract's exact EIP-712 domain — facilitators reconstruct the signing domain
 * from these and reject any mismatch.
 *
 * Solana: the asset is the USDC mint, the network is the canonical CAIP-2 id
 * (so the facilitator's v2 body carries CAIP-2, whatever alias the caller
 * passed), and `extra.feePayer` is the facilitator's fee payer from
 * `/supported` — left unsigned for the buyer to build its transaction around.
 * There is no EIP-712 `extra` on this rail.
 */
async function advertise(opts: GateOptions, resource: string): Promise<AcceptsEntry[]> {
  const network = opts.network ?? "mock-ledger";

  if (family(network) === "solana") {
    const sinfo = solanaNetworkInfo(network)!;
    const feePayer = await solanaFeePayer(opts.facilitator, network);
    return [{
      scheme: "exact",
      network: sinfo.caip2,
      maxAmountRequired: opts.priceMicro.toString(),
      resource,
      description: opts.description,
      mimeType: "application/json",
      payTo: opts.payTo,
      asset: sinfo.mint,
      maxTimeoutSeconds: 30,
      extra: feePayer ? { feePayer } : {},
    }];
  }

  const info = NETWORKS[network];
  return [{
    scheme: "exact",
    network,
    maxAmountRequired: opts.priceMicro.toString(),
    resource,
    description: opts.description,
    mimeType: "application/json",
    payTo: opts.payTo,
    asset: info?.usdc ?? "USDC",
    maxTimeoutSeconds: 30,
    extra: info ? { name: info.domainName, version: info.domainVersion } : { name: "USDC", version: "1" },
  }];
}

/**
 * The facilitator's fee payer for a Solana network, read from its x402 v2
 * `/supported` advertisement. `undefined` when the facilitator has no
 * `/supported` (e.g. the mock ledger) or lists no matching Solana `exact` kind —
 * the offer then carries no feePayer and the buyer's encoder fails loudly rather
 * than signing a one-signature transaction the facilitator cannot co-pay.
 */
async function solanaFeePayer(fac: Facilitator, network: string): Promise<string | undefined> {
  if (!fac.supported) return undefined;
  const sinfo = solanaNetworkInfo(network)!;
  const kinds = await fac.supported();
  const match = kinds.find(
    (k) => k.scheme === "exact" && (k.network === sinfo.caip2 || k.network === sinfo.v1Name),
  );
  return match?.extra?.feePayer;
}

export function paymentGate(opts: GateOptions, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const network = opts.network ?? "mock-ledger";
  const isSolana = family(network) === "solana";
  const version = versionFor(network);

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = req.headers.host ?? "localhost";
    const resource = `http://${host}${req.url ?? "/"}`;
    const header = req.headers["x-payment"];

    if (typeof header !== "string" || !header) {
      const body: PaymentRequiredBody = {
        x402Version: version,
        error: "X-PAYMENT header is required",
        accepts: await advertise(opts, resource),
      };
      res.writeHead(402, { "Content-Type": "application/json", "Accept": "application/json" });
      res.end(JSON.stringify(body, null, 2));
      return;
    }

    let payload: DecodedPayment;
    try {
      payload = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as DecodedPayment;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "malformed X-PAYMENT header" }));
      return;
    }

    // Local sanity check before hitting the facilitator; works for the flat mock
    // shape and the nested x402 v1 EVM shape. A Solana payment hides its amount
    // and payee inside the signed v0 transaction — there is nothing to read from
    // JSON here, so the facilitator verifies the transfer's amount and
    // destination instead.
    let presented: string | null = null;
    if (!isSolana) {
      presented = flatAmount(payload);
      const payee = payeeOf(payload);
      if (presented === null || BigInt(presented) !== opts.priceMicro || payee !== opts.payTo) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "payment payload does not match advertised price/payee" }));
        return;
      }
    }

    const requirements = (await advertise(opts, resource))[0];
    const verification = await opts.facilitator.verify(payload, requirements);
    if (!verification.isValid) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ x402Version: version, error: `payment rejected: ${verification.invalidReason}`, accepts: [] }));
      return;
    }

    const settlement = await opts.facilitator.settle(payload, requirements);
    if (!settlement.success) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ x402Version: version, error: `settlement failed: ${settlement.error}`, accepts: [] }));
      return;
    }

    res.setHeader("X-PAYMENT-RESPONSE", Buffer.from(
      JSON.stringify({ success: true, network: settlement.network, txHash: settlement.txHash, amountMicro: presented ?? opts.priceMicro.toString() }),
    ).toString("base64"));
    await handler(req, res);
  };
}
