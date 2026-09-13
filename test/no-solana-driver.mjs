// Drives a Base (EVM) buyer flow end to end: build a live agent, then sign a
// payment through ctx.encodePayment. This exercises the viem signing path so
// the resolve hook records `viem/accounts`; it must never reach the Solana
// encoder, so no `@solana/kit` / `@x402/svm` specifier should be resolved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLiveAgent } from "../src/live.ts";
import { NETWORKS } from "../src/live.ts";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "no-solana-"));

const rt = await createLiveAgent({
  stateDir,
  privateKey: "0x" + "11".repeat(32),
  network: "base-sepolia",
  checkOnChainBalance: false,
});

const net = NETWORKS["base-sepolia"];
const offer = {
  scheme: "exact",
  network: "base-sepolia",
  amount: "10000",
  maxAmountRequired: "10000",
  resource: "https://seller.example/data",
  description: "d",
  mimeType: "application/json",
  payTo: "0x000000000000000000000000000000000000dEaD",
  asset: net.usdc,
  maxTimeoutSeconds: 300,
  extra: { name: net.domainName, version: net.domainVersion },
};

const unsigned = {
  x402Version: 2,
  scheme: offer.scheme,
  network: offer.network,
  resource: offer.resource,
  from: rt.address,
  payTo: offer.payTo,
  amount: offer.amount,
  nonce: "n",
  timestamp: Date.now(),
  requirements: offer,
  acceptedOffer: offer,
};

const header = await rt.ctx.encodePayment(unsigned);
if (!header || typeof header !== "string") throw new Error("Base encode produced no header");

rt.stopHeartbeat?.();
try {
  fs.rmSync(stateDir, { recursive: true, force: true });
} catch {}
process.exit(0);
