import type { IncomingMessage, ServerResponse } from "node:http";
import type { Facilitator } from "./chain.ts";
import type { PaymentPayload, PaymentRequiredBody } from "./types.ts";

export interface GateOptions {
  priceMicro: bigint;
  description: string;
  payTo: string;
  facilitator: Facilitator;
  network?: string;
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
        accepts: [
          {
            scheme: "exact",
            network: opts.network ?? "mock-ledger",
            maxAmountRequired: opts.priceMicro.toString(),
            resource,
            description: opts.description,
            mimeType: "application/json",
            payTo: opts.payTo,
            asset: "USDC",
            maxTimeoutSeconds: 30,
            extra: { name: "USDC", version: "1" },
          },
        ],
      };
      res.writeHead(402, { "Content-Type": "application/json", "Accept": "application/json" });
      res.end(JSON.stringify(body, null, 2));
      return;
    }

    let payload: PaymentPayload;
    try {
      payload = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as PaymentPayload;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "malformed X-PAYMENT header" }));
      return;
    }

    if (BigInt(payload.amount) !== opts.priceMicro || payload.payTo !== opts.payTo) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "payment payload does not match advertised price/payee" }));
      return;
    }

    const verification = await opts.facilitator.verify(payload);
    if (!verification.isValid) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ x402Version: 1, error: `payment rejected: ${verification.invalidReason}`, accepts: [] }));
      return;
    }

    const settlement = await opts.facilitator.settle(payload);
    if (!settlement.success) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ x402Version: 1, error: `settlement failed: ${settlement.error}`, accepts: [] }));
      return;
    }

    res.setHeader("X-PAYMENT-RESPONSE", Buffer.from(
      JSON.stringify({ success: true, network: settlement.network, txHash: settlement.txHash, amountMicro: payload.amount }),
    ).toString("base64"));
    await handler(req, res);
  };
}
