import type { IncomingMessage, ServerResponse } from "node:http";
import type { Facilitator } from "./chain.ts";
import type { AcceptsEntry, DecodedPayment, PaymentRequiredBody } from "./types.ts";
import { flatAmount, payeeOf } from "./types.ts";
import { NETWORKS } from "./live.ts";

export interface GateOptions {
  priceMicro: bigint;
  description: string;
  payTo: string;
  facilitator: Facilitator;
  /** e.g. "mock-ledger", "base-sepolia", "base" */
  network?: string;
}

function advertise(opts: GateOptions, resource: string): AcceptsEntry {
  const network = opts.network ?? "mock-ledger";
  // On a real EVM network the asset must be the USDC contract address and
  // `extra` must carry that contract's exact EIP-712 domain — facilitators
  // reconstruct the signing domain from these and reject any mismatch.
  const info = NETWORKS[network];
  return {
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
  };
}

export function paymentGate(opts: GateOptions, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = req.headers.host ?? "localhost";
    const resource = `http://${host}${req.url ?? "/"}`;
    const header = req.headers["x-payment"];

    if (typeof header !== "string" || !header) {
      const body: PaymentRequiredBody = {
        x402Version: 1,
        error: "X-PAYMENT header is required",
        accepts: [advertise(opts, resource)],
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

    // Local sanity check before hitting the facilitator; works for both the
    // flat mock shape and the nested x402 v1 EVM shape.
    const presented = flatAmount(payload);
    const payee = payeeOf(payload);
    if (presented === null || BigInt(presented) !== opts.priceMicro || payee !== opts.payTo) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "payment payload does not match advertised price/payee" }));
      return;
    }

    const requirements = advertise(opts, resource);
    const verification = await opts.facilitator.verify(payload, requirements);
    if (!verification.isValid) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ x402Version: 1, error: `payment rejected: ${verification.invalidReason}`, accepts: [] }));
      return;
    }

    const settlement = await opts.facilitator.settle(payload, requirements);
    if (!settlement.success) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ x402Version: 1, error: `settlement failed: ${settlement.error}`, accepts: [] }));
      return;
    }

    res.setHeader("X-PAYMENT-RESPONSE", Buffer.from(
      JSON.stringify({ success: true, network: settlement.network, txHash: settlement.txHash, amountMicro: presented }),
    ).toString("base64"));
    await handler(req, res);
  };
}
