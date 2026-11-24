import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger } from "../src/ledger.ts";
import { summarize, attest, verifyAttestation, type SignedAttestation } from "../src/attestation.ts";
import { verifyAttestationOnChain, ERC20_TRANSFER_TOPIC, type TxReader } from "../src/attestation-chain.ts";
import { verifyAttestationIdentity, type RegistryReader } from "../src/attestation-identity.ts";

function line(s = ""): void {
  process.stdout.write(s + "\n");
}

async function main(): Promise<void> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(`0x${"a7".repeat(32)}`);
  const agent = account.address;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallie-attest-demo-"));
  const ledger = new Ledger(dir);

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

  const summary = summarize(ledger, agent, { includeEvidence: true, registryAgentId: "42" });
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

  const forged: SignedAttestation = { ...attestation, summary: { ...attestation.summary, payments: 9999, blocks: 0 } };
  const bad = await verifyAttestation(forged);
  line("=== 5. A tampered claim (payments inflated to 9999) ===");
  line(bad.valid ? "   BUG: forgery accepted" : `   REJECTED: ${bad.reason}`);
  if (bad.valid) process.exitCode = 1;
  line();

  const usdc = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const padTopic = (a: string) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
  const fakeRpc: TxReader = {
    async getTransactionReceipt({ hash }) {
      const seller = "0x00000000000000000000000000000000000000ca";
      return { status: "success", logs: [{ address: usdc, topics: [ERC20_TRANSFER_TOPIC, padTopic(agent), padTopic(seller)], data: "0x3e8" }] };
    },
  };
  line("=== 6. Seller re-checks the payment evidence on-chain (v2) ===");
  const chain = await verifyAttestationOnChain(attestation, { client: fakeRpc, network: "base-sepolia" });
  line(`   ${chain.verified}/${chain.checked} evidence txs confirmed: each settled and moved USDC from ${agent.slice(0, 10)}...`);
  line("   These payments no longer rest on the Wallie brand — the chain says so.");
  if (chain.verified !== chain.checked) process.exitCode = 1;

  const liar: SignedAttestation = {
    ...attestation,
    summary: { ...attestation.summary, verifiableTxHashes: ["0xf0f0"] },
  };
  const missReader: TxReader = { async getTransactionReceipt() { return null; } };
  const miss = await verifyAttestationOnChain(liar, { client: missReader, network: "base-sepolia" });
  line(`   A made-up txHash: ${miss.verified}/${miss.checked} verified (${miss.failures[0]?.reason ?? ""}).`);
  line();

  const fakeRegistry: RegistryReader = {
    async getAgentWallet(id) {
      return id === 42n ? agent : null;
    },
    async ownerOf(id) {
      return id === 42n ? agent : null;
    },
  };
  line("=== 7. Seller resolves the agent in the ERC-8004 Identity Registry (v2) ===");
  const ident = await verifyAttestationIdentity(attestation, { reader: fakeRegistry, network: "base-sepolia" });
  if (ident.registered) {
    line(`   REGISTERED — agentId ${ident.agentId} resolves to ${agent.slice(0, 10)}... (matched by ${ident.matchedBy}).`);
    line("   The identity no longer rests on the Wallie brand — any seller reads it from the registry.");
  } else {
    line(`   NOT REGISTERED: ${ident.reason}`);
    process.exitCode = 1;
  }

  const strangerRegistry: RegistryReader = {
    async getAgentWallet() { return "0x00000000000000000000000000000000000000ff"; },
    async ownerOf() { return "0x00000000000000000000000000000000000000ff"; },
  };
  const borrowed: SignedAttestation = {
    ...attestation,
    summary: { ...attestation.summary, registryAgentId: "43" },
  };
  const borrowedResult = await verifyAttestationIdentity(borrowed, { reader: strangerRegistry, network: "base-sepolia" });
  line(`   A borrowed agentId 43: registered=${borrowedResult.registered} (${borrowedResult.reason ?? ""}).`);
  line("   (Note: this borrowed claim also fails the signature check, since the id is inside the digest.)");

  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
