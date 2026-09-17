import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Ledger } from "../src/ledger.ts";
import { summarize, attestFromLedger, verifyAttestation, type SignedAttestation } from "../src/attestation.ts";
import { requireAttestation, attestationOf, type AttestationPolicy } from "../src/attestation-gate.ts";
import {
  verifyAttestationIdentity,
  enforceIdentity,
  isContractRevert,
  ERC8004_IDENTITY_REGISTRY,
  type RegistryReader,
} from "../src/attestation-identity.ts";

const ZERO = "0x0000000000000000000000000000000000000000";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wallie-identity-"));
}

async function testAccount(seedByte = "55") {
  const { privateKeyToAccount } = await import("viem/accounts");
  return privateKeyToAccount(`0x${seedByte.repeat(32)}` as `0x${string}`);
}

/** A minimal ledger so the summary has real numbers behind the identity claim. */
function seed(ledger: Ledger, agent: string): void {
  ledger.append({ t: "topup", at: "2026-09-01T00:00:00.000Z", agent, amountMicro: "5000000", source: "manual", balanceAfterMicro: "5000000" });
  ledger.append({ t: "payment", at: "2026-09-02T00:00:00.000Z", agent, url: "https://a.com/x", host: "a.com", amountMicro: "1000", txHash: "0xaa", balanceAfterMicro: "4999000" });
}

/** A signed attestation carrying an ERC-8004 registryAgentId. */
async function idAttFor(seedByte: string, agentId = "42"): Promise<{ att: SignedAttestation; agent: string }> {
  const account = await testAccount(seedByte);
  const ledger = new Ledger(tmpDir());
  seed(ledger, account.address);
  const att = await attestFromLedger(account as never, ledger, account.address, { registryAgentId: agentId });
  return { att, agent: account.address };
}

/**
 * A fake registry over a fixed map of agentId -> { wallet, owner }. A missing
 * field reads as null, exactly as the viem reader maps an unset wallet (zero) or
 * a nonexistent tokenId (revert) to null. `calls` records every read so a test
 * can assert the registry was never touched.
 */
function registry(entries: Record<string, { wallet?: string; owner?: string }>): RegistryReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getAgentWallet(id) {
      calls.push(`wallet:${id}`);
      return entries[id.toString()]?.wallet ?? null;
    },
    async ownerOf(id) {
      calls.push(`owner:${id}`);
      return entries[id.toString()]?.owner ?? null;
    },
  };
}

/** A reader whose reads throw, standing in for an RPC transport failure. */
const downReader: RegistryReader = {
  async getAgentWallet() {
    throw new Error("RPC down");
  },
  async ownerOf() {
    throw new Error("RPC down");
  },
};

/**
 * Build an error shaped like viem's readContract failure: an outer
 * ContractFunctionExecutionError wrapping a cause chain, with a `walk(fn)` that
 * returns the first matching error in the chain (viem's BaseError.walk). Crucial
 * to the test: the OUTER name is the same for a revert and a transport error, so
 * only the chain contents can tell them apart.
 */
function viemReadError(chain: { name: string }[]): unknown {
  const nodes = [{ name: "ContractFunctionExecutionError" }, ...chain];
  return {
    name: "ContractFunctionExecutionError",
    cause: chain[0],
    walk(fn: (c: unknown) => boolean) {
      for (const n of nodes) if (fn(n)) return n;
      return null;
    },
  };
}

// --- isContractRevert (the revert-vs-transport classifier) ------------------

test("isContractRevert treats a genuine revert or empty-data response as 'absent'", () => {
  assert.equal(isContractRevert(viemReadError([{ name: "ContractFunctionRevertedError" }])), true, "nonexistent tokenId reverts -> not registered");
  assert.equal(isContractRevert(viemReadError([{ name: "ContractFunctionZeroDataError" }])), true, "empty return -> not registered");
});

test("isContractRevert does NOT swallow a transport error wrapped in the same outer type", () => {
  // An RPC outage: viem still wraps it in ContractFunctionExecutionError, but the
  // cause chain has no revert node. This must propagate, not read as unregistered.
  const transport = viemReadError([{ name: "CallExecutionError" }, { name: "HttpRequestError" }]);
  assert.equal(isContractRevert(transport), false, "network failure is an error, not an 'unregistered' answer");
});

test("isContractRevert falls back to the plain .cause chain when there is no walk()", () => {
  const revert = { name: "ContractFunctionExecutionError", cause: { name: "ContractFunctionRevertedError" } };
  assert.equal(isContractRevert(revert), true);
  const timeout = { name: "SomeError", cause: { name: "TimeoutError" } };
  assert.equal(isContractRevert(timeout), false);
  const cyclic: { name: string; cause?: unknown } = { name: "A" };
  cyclic.cause = cyclic; // must not loop forever
  assert.equal(isContractRevert(cyclic), false);
});

// --- summarize stamps the id ------------------------------------------------

test("summarize stamps registryAgentId only when asked (v1 digest by default)", async () => {
  const ledger = new Ledger(tmpDir());
  seed(ledger, "agent");

  const off = summarize(ledger, "agent");
  assert.equal(off.registryAgentId, undefined, "no registry id by default");

  const on = summarize(ledger, "agent", { registryAgentId: "42" });
  assert.equal(on.registryAgentId, "42");

  const blank = summarize(ledger, "agent", { registryAgentId: "" });
  assert.equal(blank.registryAgentId, undefined, "an empty id is not stamped");
});

test("the registry id rides inside the signed digest, so it cannot be swapped after signing", async () => {
  const { att } = await idAttFor("50");
  const forged: SignedAttestation = { ...att, summary: { ...att.summary, registryAgentId: "999" } };
  const res = await verifyAttestation(forged);
  assert.equal(res.valid, false, "changing the id breaks the digest");
});

// --- verifyAttestationIdentity ----------------------------------------------

test("registered when the agentId's wallet is the attesting address", async () => {
  const { att, agent } = await idAttFor("51");
  const reader = registry({ "42": { wallet: agent } });
  const r = await verifyAttestationIdentity(att, { reader, network: "base-sepolia" });
  assert.equal(r.supported, true);
  assert.equal(r.registered, true);
  assert.equal(r.matchedBy, "wallet");
  assert.equal(r.agentId, "42");
});

test("registered by owner when the operational wallet is unset", async () => {
  const { att, agent } = await idAttFor("52");
  // Wallet reads as zero (unset); the owner key is the one that pays and signs.
  const reader = registry({ "42": { wallet: ZERO, owner: agent } });
  const r = await verifyAttestationIdentity(att, { reader, network: "base-sepolia" });
  assert.equal(r.registered, true);
  assert.equal(r.matchedBy, "owner");
});

test("the operational wallet takes precedence over the owner", async () => {
  const { att, agent } = await idAttFor("53");
  const other = "0x00000000000000000000000000000000000000aa";
  const reader = registry({ "42": { wallet: agent, owner: other } });
  const r = await verifyAttestationIdentity(att, { reader, network: "base-sepolia" });
  assert.equal(r.registered, true);
  assert.equal(r.matchedBy, "wallet");
});

test("not registered when the agentId is absent from the registry", async () => {
  const { att } = await idAttFor("54");
  const reader = registry({}); // agentId 42 has no wallet and no owner
  const r = await verifyAttestationIdentity(att, { reader, network: "base-sepolia" });
  assert.equal(r.supported, true);
  assert.equal(r.registered, false);
  assert.match(r.reason!, /not registered/);
});

test("not registered when the attesting address is neither wallet nor owner", async () => {
  const { att } = await idAttFor("56");
  const someoneElse = "0x00000000000000000000000000000000000000bb";
  const anotherOwner = "0x00000000000000000000000000000000000000cc";
  const reader = registry({ "42": { wallet: someoneElse, owner: anotherOwner } });
  const r = await verifyAttestationIdentity(att, { reader, network: "base-sepolia" });
  assert.equal(r.registered, false);
  assert.match(r.reason!, /neither the registered wallet nor the owner/);
  assert.equal(r.wallet, someoneElse, "it still reports what the registry held");
  assert.equal(r.owner, anotherOwner);
});

test("an attestation with no registryAgentId is unsupported for identity resolution", async () => {
  const account = await testAccount("57");
  const ledger = new Ledger(tmpDir());
  seed(ledger, account.address);
  const att = await attestFromLedger(account as never, ledger, account.address); // no registryAgentId
  const reader = registry({});
  const r = await verifyAttestationIdentity(att, { reader, network: "base-sepolia" });
  assert.equal(r.supported, false);
  assert.match(r.reason!, /registryAgentId/);
  assert.equal(reader.calls.length, 0, "nothing to resolve, so the registry is never read");
});

test("a malformed registryAgentId is a failure, not an unsupported claim", async () => {
  const { att } = await idAttFor("58", "not-a-number");
  const reader = registry({});
  const r = await verifyAttestationIdentity(att, { reader, network: "base-sepolia" });
  assert.equal(r.supported, true, "the agent did present an id");
  assert.equal(r.registered, false);
  assert.match(r.reason!, /not a valid uint256/);
  assert.equal(reader.calls.length, 0, "a bad id never reaches the registry");
});

test("known ERC-8004 registry addresses are wired for base and base-sepolia", () => {
  assert.match(ERC8004_IDENTITY_REGISTRY["base-sepolia"], /^0x8004/);
  assert.match(ERC8004_IDENTITY_REGISTRY["base"], /^0x8004/);
});

// --- enforceIdentity --------------------------------------------------------

test("enforceIdentity fails a claim that does not resolve, passes one that does", async () => {
  const { att, agent } = await idAttFor("59");
  const good = registry({ "42": { wallet: agent } });
  const bad = registry({});

  const passed = await enforceIdentity(att, { reader: good, network: "base-sepolia" });
  assert.equal(passed.ok, true);

  const failed = await enforceIdentity(att, { reader: bad, network: "base-sepolia" });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.match(failed.reason, /not registered/);
});

test("requireRegistered:false attaches the resolution without failing an unresolved claim", async () => {
  const { att } = await idAttFor("5a");
  const bad = registry({});
  const r = await enforceIdentity(att, { reader: bad, network: "base-sepolia", requireRegistered: false });
  assert.equal(r.ok, true, "not required, so an unregistered agent still passes");
  assert.equal(r.result.registered, false, "but the resolution is still reported");
});

// --- verifyAttestation identity opt -----------------------------------------

test("verifyAttestation folds the identity resolution into a valid result", async () => {
  const { att, agent } = await idAttFor("5b");
  const reader = registry({ "42": { wallet: agent } });
  const res = await verifyAttestation(att, { identity: { reader, network: "base-sepolia" } });
  assert.equal(res.valid, true);
  if (res.valid) {
    assert.equal(res.identity?.registered, true);
    assert.equal(res.identity?.matchedBy, "wallet");
  }
});

test("verifyAttestation fails when the agent does not resolve in the registry", async () => {
  const { att } = await idAttFor("5c");
  const reader = registry({});
  const res = await verifyAttestation(att, { identity: { reader, network: "base-sepolia" } });
  assert.equal(res.valid, false);
  if (!res.valid) assert.match(res.reason, /not registered/);
});

// --- seller gate policy.identity --------------------------------------------

function res() {
  const r = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: "",
    writeHead(code: number, hdrs?: Record<string, unknown>) { r.statusCode = code; if (hdrs) Object.assign(r.headers, hdrs); return r; },
    end(b?: string) { r.body = b ?? ""; },
  };
  return r;
}

function okHandler() {
  const state = { served: false, req: undefined as unknown };
  const handler = (rq: unknown, rs: { writeHead: (c: number, h?: Record<string, unknown>) => unknown; end: (b?: string) => void }) => {
    state.served = true;
    state.req = rq;
    rs.writeHead(200, { "Content-Type": "application/json" });
    rs.end(JSON.stringify({ ok: true }));
  };
  return { state, handler };
}

async function run(policy: AttestationPolicy, att: SignedAttestation) {
  const { state, handler } = okHandler();
  const gate = requireAttestation(policy, handler);
  const r = res();
  const header = Buffer.from(JSON.stringify(att), "utf8").toString("base64");
  await gate({ headers: { "x-attestation": header }, url: "/", method: "GET" } as unknown as IncomingMessage, r as unknown as ServerResponse);
  return { state, r };
}

test("the gate resolves the registry identity and attaches it to the request", async () => {
  const { att, agent } = await idAttFor("5d");
  const reader = registry({ "42": { wallet: agent } });
  const { state, r } = await run({ minPayments: 1, identity: { reader, network: "base-sepolia" } }, att);
  assert.equal(state.served, true);
  assert.equal(r.statusCode, 200);
  assert.equal(attestationOf(state.req as IncomingMessage)?.identity?.registered, true);
  assert.equal(attestationOf(state.req as IncomingMessage)?.identity?.matchedBy, "wallet");
});

test("the gate refuses a buyer whose agentId does not resolve", async () => {
  const { att } = await idAttFor("5e");
  const reader = registry({});
  const { state, r } = await run({ identity: { reader, network: "base-sepolia" } }, att);
  assert.equal(state.served, false);
  assert.equal(r.statusCode, 403);
  assert.match(JSON.parse(r.body).reason, /not registered/);
});

test("the gate surfaces an RPC transport error as a rejection, not a crash", async () => {
  const { att } = await idAttFor("5f");
  const { state, r } = await run({ identity: { reader: downReader, network: "base-sepolia" } }, att);
  assert.equal(state.served, false);
  assert.equal(r.statusCode, 403);
  assert.match(JSON.parse(r.body).reason, /registry identity error: RPC down/);
});

test("the gate rejects on a cheap floor before ever touching the registry", async () => {
  const { att } = await idAttFor("60");
  const reader = registry({}); // any read would fail the resolve; it must never run
  const { state, r } = await run({ minPayments: 99, identity: { reader, network: "base-sepolia" } }, att);
  assert.equal(state.served, false);
  assert.equal(r.statusCode, 403);
  assert.match(JSON.parse(r.body).reason, /needs >= 99 payments/);
  assert.equal(reader.calls.length, 0, "the registry read is spent only on a request that clears the floors");
});

test("identity resolves before the per-hash on-chain check, so an unregistered agent skips it", async () => {
  const { att } = await idAttFor("61");
  const reader = registry({}); // not registered -> identity fails first
  // An onChain client that throws on any lookup: it must never be reached.
  const onChainClient = {
    async getTransactionReceipt(): Promise<never> {
      throw new Error("on-chain must not be reached when identity already failed");
    },
  };
  const { state, r } = await run(
    { identity: { reader, network: "base-sepolia" }, onChain: { client: onChainClient, network: "base-sepolia" } },
    att,
  );
  assert.equal(state.served, false);
  assert.equal(r.statusCode, 403);
  assert.match(JSON.parse(r.body).reason, /not registered/, "failed at identity, before the on-chain loop");
});
