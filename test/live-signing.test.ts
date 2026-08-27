import assert from "node:assert/strict";
import test from "node:test";
import { NETWORKS, encodePaymentEvm } from "../src/live.ts";
import { paymentGate } from "../src/seller.ts";
import type { AcceptsEntry } from "../src/types.ts";

// A signature is only spendable if the EIP-712 domain matches the token
// contract byte for byte. These are the values reported by name()/version()
// on the live contracts; a mismatch silently recovers a different signer.
const ON_CHAIN_DOMAINS = {
  "base-sepolia": { name: "USDC", version: "2" },
  base: { name: "USD Coin", version: "2" },
} as const;

for (const [network, expected] of Object.entries(ON_CHAIN_DOMAINS)) {
  test(`${network} EIP-712 domain matches the deployed USDC contract`, () => {
    const info = NETWORKS[network];
    assert.ok(info, `NETWORKS is missing "${network}"`);
    assert.equal(info.domainName, expected.name);
    assert.equal(info.domainVersion, expected.version);
  });
}

test("seller advertises the contract address and its real domain, not placeholders", async () => {
  for (const network of Object.keys(ON_CHAIN_DOMAINS)) {
    let advertised: AcceptsEntry | undefined;
    const gate = paymentGate(
      { priceMicro: 10000n, description: "d", payTo: "0x000000000000000000000000000000000000dEaD", network, facilitator: {} as never },
      () => {},
    );
    const res = {
      statusCode: 0, setHeader() {}, writeHead() { return res; },
      end(body: string) { advertised = JSON.parse(body).accepts[0]; },
    };
    await gate({ headers: { host: "x" }, url: "/" } as never, res as never);

    assert.ok(advertised, "gate did not advertise requirements");
    assert.equal(advertised.asset, NETWORKS[network].usdc, "asset must be the USDC contract address");
    assert.match(advertised.asset, /^0x[0-9a-fA-F]{40}$/);
    assert.deepEqual(advertised.extra, {
      name: ON_CHAIN_DOMAINS[network as keyof typeof ON_CHAIN_DOMAINS].name,
      version: ON_CHAIN_DOMAINS[network as keyof typeof ON_CHAIN_DOMAINS].version,
    });
  }
});

test("encoded payment is JSON-serializable with string uint256 fields", async () => {
  const { privateKeyToAccount } = await import("viem/accounts");
  const acct = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const net = NETWORKS["base-sepolia"];
  const reqs: AcceptsEntry = {
    scheme: "exact", network: "base-sepolia", maxAmountRequired: "10000",
    resource: "https://x/y", description: "d", mimeType: "application/json",
    payTo: "0x000000000000000000000000000000000000dEaD", asset: net.usdc,
    maxTimeoutSeconds: 300, extra: { name: net.domainName, version: net.domainVersion },
  };

  // Regression: authorization fields were BigInt, so JSON.stringify threw and
  // encodePaymentEvm could never produce a payload on any live network.
  const b64 = await encodePaymentEvm(acct as never, { x402Version: 1, requirements: reqs } as never);
  const auth = JSON.parse(Buffer.from(b64, "base64").toString()).payload.authorization;

  for (const field of ["value", "validAfter", "validBefore"]) {
    assert.equal(typeof auth[field], "string", `${field} must serialize as a decimal string`);
  }
  assert.equal(auth.value, "10000");
  assert.equal(auth.from, acct.address);
});

test("signature recovers to the payer under the advertised domain", async () => {
  const { privateKeyToAccount } = await import("viem/accounts");
  const { verifyTypedData } = await import("viem");
  const acct = privateKeyToAccount(`0x${"22".repeat(32)}`);
  const net = NETWORKS["base-sepolia"];
  const reqs: AcceptsEntry = {
    scheme: "exact", network: "base-sepolia", maxAmountRequired: "10000",
    resource: "https://x/y", description: "d", mimeType: "application/json",
    payTo: "0x000000000000000000000000000000000000dEaD", asset: net.usdc,
    maxTimeoutSeconds: 300, extra: { name: net.domainName, version: net.domainVersion },
  };
  const decoded = JSON.parse(Buffer.from(
    await encodePaymentEvm(acct as never, { x402Version: 1, requirements: reqs } as never), "base64").toString());
  const a = decoded.payload.authorization;

  const ok = await verifyTypedData({
    address: acct.address,
    domain: { name: net.domainName, version: net.domainVersion, chainId: net.chainId, verifyingContract: net.usdc as `0x${string}` },
    types: { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" },
      { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "TransferWithAuthorization",
    message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
    signature: decoded.payload.signature,
  });
  assert.equal(ok, true, "signature does not recover to the payer — domain mismatch");
});
