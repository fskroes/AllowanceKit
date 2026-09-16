/**
 * Behavior-derived attestation demo (PoC).
 *
 *   node demo/attestation.ts
 *
 * Shows the whole first-demo loop with no network and no real money:
 *   1. an agent runs, leaving a normal audit ledger (payments, a block, an
 *      approval, a policy change);
 *   2. the agent compresses that ledger and signs it with its own payer key —
 *      a portable, non-custodial reputation claim;
 *   3. a seller verifies the signature recovers to the agent and reads the
 *      claim, the way it would gate access on it;
 *   4. a tampered claim is shown being rejected.
 *
 * Needs viem (a dev/optional peer dep, already installed): npm i viem
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger } from "../src/ledger.ts";
import { summarize, attest, verifyAttestation, type SignedAttestation } from "../src/attestation.ts";

function line(s = ""): void {
  process.stdout.write(s + "\n");
}

async function main(): Promise<void> {
  const { privateKeyToAccount } = await import("viem/accounts");
  // A throwaway key: in a real agent this is the same key createLiveAgent pays with.
  const account = privateKeyToAccount(`0x${"a7".repeat(32)}`);
  const agent = account.address;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallie-attest-demo-"));
  const ledger = new Ledger(dir);

  // 1. A day in the life of the agent — the rows it would write on its own.
  ledger.append({ t: "topup", at: "2026-09-01T09:00:00.000Z", agent, amountMicro: "5000000", source: "manual", balanceAfterMicro: "5000000" });
  ledger.append({ t: "payment", at: "2026-09-02T10:00:00.000Z", agent, url: "https://weather.example/api", host: "weather.example", amountMicro: "1500", txHash: "0x11aa", balanceAfterMicro: "4998500" });
  ledger.append({ t: "payment", at: "2026-09-03T11:00:00.000Z", agent, url: "https://search.example/api", host: "search.example", amountMicro: "3000", txHash: "0x22bb", balanceAfterMicro: "4995500" });
  ledger.append({ t: "payment", at: "2026-09-04T12:00:00.000Z", agent, url: "https://weather.example/api", host: "weather.example", amountMicro: "1500", txHash: "0x33cc", balanceAfterMicro: "4994000" });
  ledger.append({ t: "blocked", at: "2026-09-05T13:00:00.000Z", agent, url: "https://sketchy.example/api", host: "sketchy.example", rule: "host_not_allowed", detail: "not on the allowlist", attemptedMicro: "9000" });
  ledger.append({ t: "approval_requested", at: "2026-09-06T14:00:00.000Z", agent, id: "r1", url: "https://data.example/bulk", host: "data.example", amountMicro: "800000" });
  ledger.append({ t: "approval_decided", at: "2026-09-06T14:03:00.000Z", agent, id: "r1", approved: true, host: "data.example", amountMicro: "800000" });

  line("=== 1. The agent's private ledger (never leaves the agent) ===");
  line(`   ${ledger.read().length} rows for ${agent}`);
  line();

  // 2. The agent issues a signed behavior claim.
  const summary = summarize(ledger, agent);
  line("=== 2. Behavior summary derived from the ledger (counts, not raw rows) ===");
  line(JSON.stringify(summary, null, 2));
  line();

  const attestation = await attest(account as never, summary, { ttlSecs: 7 * 24 * 60 * 60 });
  line("=== 3. Signed, portable attestation (this is what a seller receives) ===");
  line(`   agent      ${attestation.agent}`);
  line(`   issuedAt   ${new Date(attestation.issuedAt * 1000).toISOString()}`);
  line(`   expiresAt  ${new Date(attestation.expiresAt * 1000).toISOString()}`);
  line(`   digest     ${attestation.digest}`);
  line(`   signature  ${attestation.signature.slice(0, 34)}...`);
  line();

  // 3. The seller verifies it.
  const ok = await verifyAttestation(attestation);
  line("=== 4. Seller verifies ===");
  if (ok.valid) {
    line(`   VALID — signature recovers to ${ok.signer}`);
    line(`   The seller now reads a real track record: ${ok.summary.payments} payments,`);
    line(`   ${ok.summary.verifiableTxCount} chain-checkable, ${ok.summary.blocks} attempts stopped by the rails,`);
    line(`   ${ok.summary.distinctHosts} distinct counterparties, ${ok.summary.approvalsApproved} human-approved.`);
    line("   In v1 it trusts these numbers on the Wallie brand once the signature is proven.");
  } else {
    line(`   INVALID: ${ok.reason}`);
    process.exitCode = 1;
  }
  line();

  // 4. A forged claim is rejected.
  const forged: SignedAttestation = { ...attestation, summary: { ...attestation.summary, payments: 9999, blocks: 0 } };
  const bad = await verifyAttestation(forged);
  line("=== 5. A tampered claim (payments inflated to 9999) ===");
  line(bad.valid ? "   BUG: forgery accepted" : `   REJECTED: ${bad.reason}`);
  if (bad.valid) process.exitCode = 1;

  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
