import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { base58Encode } from "../src/base58.ts";
import {
  VOUCHER_MAGIC,
  VOUCHER_PAYLOAD_SIZE,
  encodeVoucher,
  decodeVoucher,
  signVoucher,
  verifyVoucher,
  checkVoucher,
  type Voucher,
} from "../src/voucher.ts";

// The System Program address is exactly 32 zero bytes, a mapping we can assert
// without leaning on the base58 decoder that encodeVoucher itself uses.
const ZERO_CHANNEL = "11111111111111111111111111111111";

// A fresh Ed25519 key, split into the seed and public halves the way a Solana
// 64-byte secret is laid out.
function freshKey(): { secret: Uint8Array; address: string; seed: Uint8Array; pub: Uint8Array } {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  const seed = new Uint8Array(pkcs8.subarray(pkcs8.length - 32));
  const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const pub = new Uint8Array(spki.subarray(spki.length - 32));
  const secret = new Uint8Array(64);
  secret.set(seed, 0);
  secret.set(pub, 32);
  return { secret, address: base58Encode(pub), seed, pub };
}

test("encodeVoucher lays out exactly the 50 spec bytes", () => {
  const voucher: Voucher = { channelId: ZERO_CHANNEL, cumulativeAmount: 30_000n, expiresAt: 1_760_000_000n };

  // Build the expected bytes with Node's own little-endian writers — an oracle
  // independent of the hand-rolled writers under test.
  const expected = Buffer.alloc(VOUCHER_PAYLOAD_SIZE);
  expected[0] = 0x56;
  expected[1] = 0x01;
  // bytes 2..34 stay zero (the System Program address)
  expected.writeBigUInt64LE(30_000n, 34);
  expected.writeBigInt64LE(1_760_000_000n, 42);

  const got = encodeVoucher(voucher);
  assert.equal(got.length, VOUCHER_PAYLOAD_SIZE);
  assert.deepEqual(Buffer.from(got), expected);
  assert.deepEqual([got[0], got[1]], [VOUCHER_MAGIC[0], VOUCHER_MAGIC[1]]);
});

test("expires_at is a signed i64: 0 means no expiry, negatives round-trip", () => {
  const zero = encodeVoucher({ channelId: ZERO_CHANNEL, cumulativeAmount: 1n, expiresAt: 0n });
  assert.deepEqual(Buffer.from(zero.subarray(42, 50)), Buffer.alloc(8));

  // A negative expiry is nonsense on-chain (fails closed) but must encode as
  // two's-complement and decode back to the same negative number.
  const neg = encodeVoucher({ channelId: ZERO_CHANNEL, cumulativeAmount: 1n, expiresAt: -1n });
  assert.deepEqual(Buffer.from(neg.subarray(42, 50)), Buffer.from("ffffffffffffffff", "hex"));
  assert.equal(decodeVoucher(neg).expiresAt, -1n);
});

test("decodeVoucher is the exact inverse of encodeVoucher", () => {
  const { address } = freshKey(); // any real 32-byte address
  const voucher: Voucher = { channelId: address, cumulativeAmount: 18_446_744_073_709_551_615n, expiresAt: 2_000_000_000n };
  const round = decodeVoucher(encodeVoucher(voucher));
  assert.deepEqual(round, voucher);
});

test("decodeVoucher rejects the wrong length and bad magic", () => {
  assert.throws(() => decodeVoucher(new Uint8Array(49)), /50 bytes/);
  const bad = encodeVoucher({ channelId: ZERO_CHANNEL, cumulativeAmount: 1n, expiresAt: 0n });
  bad[1] = 0x02; // corrupt the format-version byte
  assert.throws(() => decodeVoucher(bad), /bad voucher magic/);
});

test("encodeVoucher rejects a channel that is not 32 bytes and out-of-range ints", () => {
  assert.throws(() => encodeVoucher({ channelId: "1111", cumulativeAmount: 1n, expiresAt: 0n }), /32 bytes/);
  assert.throws(() => encodeVoucher({ channelId: ZERO_CHANNEL, cumulativeAmount: -1n, expiresAt: 0n }), /u64/);
  assert.throws(() => encodeVoucher({ channelId: ZERO_CHANNEL, cumulativeAmount: 1n << 64n, expiresAt: 0n }), /u64/);
});

test("signVoucher / verifyVoucher round-trip with node:crypto Ed25519", () => {
  const key = freshKey();
  const voucher: Voucher = { channelId: key.address, cumulativeAmount: 42_000n, expiresAt: 0n };

  const sig = signVoucher(key.secret, voucher);
  assert.equal(sig.length, 64);
  assert.equal(verifyVoucher(key.address, voucher, sig), true);

  // A bare 32-byte seed signs identically to the 64-byte secret.
  assert.deepEqual(signVoucher(key.seed, voucher), sig);
});

test("verifyVoucher rejects a tampered amount, a wrong signer, and a short signature", () => {
  const key = freshKey();
  const other = freshKey();
  const voucher: Voucher = { channelId: key.address, cumulativeAmount: 42_000n, expiresAt: 0n };
  const sig = signVoucher(key.secret, voucher);

  assert.equal(verifyVoucher(key.address, { ...voucher, cumulativeAmount: 42_001n }, sig), false);
  assert.equal(verifyVoucher(other.address, voucher, sig), false);
  assert.equal(verifyVoucher(key.address, voucher, sig.subarray(0, 63)), false);
});

test("checkVoucher enforces the on-chain gate in program order", () => {
  const base: Voucher = { channelId: ZERO_CHANNEL, cumulativeAmount: 50_000n, expiresAt: 0n };
  const state = { settledMicro: 10_000n, depositMicro: 100_000n, nowSeconds: 1_000n };

  assert.deepEqual(checkVoucher(base, state), { ok: true });

  // cumulative must be strictly greater than the watermark
  assert.deepEqual(checkVoucher({ ...base, cumulativeAmount: 10_000n }, state), {
    ok: false,
    reason: "watermark_not_monotonic",
  });
  // cumulative must not exceed the deposit
  assert.deepEqual(checkVoucher({ ...base, cumulativeAmount: 100_001n }, state), { ok: false, reason: "over_deposit" });
  // now == expires_at is already expired
  assert.deepEqual(checkVoucher({ ...base, expiresAt: 1_000n }, state), { ok: false, reason: "expired" });
  // a future expiry is fine
  assert.deepEqual(checkVoucher({ ...base, expiresAt: 1_001n }, state), { ok: true });
});
