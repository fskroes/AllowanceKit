import crypto from "node:crypto";
import { base58Decode, base58Encode } from "./base58.ts";

/**
 * The 50-byte Solana payment-channel voucher: encode, decode, sign, verify.
 *
 * A voucher is the seller's claim on an open channel. It is *not* a wire
 * message with a signature glued on; it is exactly the 50 bytes the on-chain
 * program's Ed25519 precompile signs over, byte-for-byte
 * (docs/spikes/2026-09-13-spike-payment-channels-program.md §3):
 *
 *   offset 0   2  magic              [0x56, 0x01]   ('V', format version 1)
 *   offset 2  32  channel_id         the channel PDA, 32 raw bytes
 *   offset 34  8  cumulative_amount  u64 little-endian
 *   offset 42  8  expires_at         i64 little-endian, unix seconds (0 = no expiry)
 *
 * The amount is **cumulative**, not a delta: it is the total the seller is
 * authorised to have claimed so far. There is no nonce. Replay is stopped
 * on-chain by the strict `settled < cumulative <= deposit` watermark, and by
 * the channel PDA embedding `open_slot` so an address can never be reused.
 *
 * Zero dependencies: `node:crypto` does Ed25519, and base58 is our own. This
 * module exists so the seller (`src/seller-upto.ts`, SOL-04) can double-check
 * what `@x402/svm` signs, and so tests can pin the layout without a library.
 */

/** The two magic bytes that open every voucher: 'V' and format version 1. */
export const VOUCHER_MAGIC = Uint8Array.of(0x56, 0x01);

/** The signed payload is always exactly 50 bytes (`VOUCHER_PAYLOAD_SIZE`). */
export const VOUCHER_PAYLOAD_SIZE = 50;

export interface Voucher {
  /** The channel PDA, base58 — must decode to exactly 32 bytes. */
  channelId: string;
  /** Total authorised so far, in the mint's base units (USDC micro-dollars). */
  cumulativeAmount: bigint;
  /** Unix seconds after which the voucher is void; `0n` means it never expires. */
  expiresAt: bigint;
}

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

function assertU64(value: bigint, field: string): void {
  if (value < 0n || value > U64_MAX) throw new Error(`voucher ${field} must fit in a u64 (0 … 2^64-1), got ${value}`);
}

function assertI64(value: bigint, field: string): void {
  if (value < I64_MIN || value > I64_MAX)
    throw new Error(`voucher ${field} must fit in an i64 (-2^63 … 2^63-1), got ${value}`);
}

function writeU64LE(out: Uint8Array, offset: number, value: bigint): void {
  let v = value;
  for (let i = 0; i < 8; i++) {
    out[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function readU64LE(bytes: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[offset + i]);
  return v;
}

function writeI64LE(out: Uint8Array, offset: number, value: bigint): void {
  // Two's-complement over 64 bits, then the same little-endian byte spill.
  writeU64LE(out, offset, value < 0n ? value + (1n << 64n) : value);
}

function readI64LE(bytes: Uint8Array, offset: number): bigint {
  const u = readU64LE(bytes, offset);
  return u > I64_MAX ? u - (1n << 64n) : u;
}

/** Encode a voucher to its exact 50 signed bytes. Throws on a non-32-byte channel or out-of-range ints. */
export function encodeVoucher(voucher: Voucher): Uint8Array {
  const channel = base58Decode(voucher.channelId);
  if (channel.length !== 32)
    throw new Error(`voucher channelId must decode to 32 bytes, "${voucher.channelId}" decoded to ${channel.length}`);
  assertU64(voucher.cumulativeAmount, "cumulativeAmount");
  assertI64(voucher.expiresAt, "expiresAt");

  const out = new Uint8Array(VOUCHER_PAYLOAD_SIZE);
  out[0] = VOUCHER_MAGIC[0];
  out[1] = VOUCHER_MAGIC[1];
  out.set(channel, 2);
  writeU64LE(out, 34, voucher.cumulativeAmount);
  writeI64LE(out, 42, voucher.expiresAt);
  return out;
}

/** Decode 50 signed bytes back to a voucher. Throws on the wrong length or bad magic. */
export function decodeVoucher(bytes: Uint8Array): Voucher {
  if (bytes.length !== VOUCHER_PAYLOAD_SIZE)
    throw new Error(`a voucher is ${VOUCHER_PAYLOAD_SIZE} bytes, got ${bytes.length}`);
  if (bytes[0] !== VOUCHER_MAGIC[0] || bytes[1] !== VOUCHER_MAGIC[1])
    throw new Error(
      `bad voucher magic: expected [0x56, 0x01], got [0x${bytes[0].toString(16)}, 0x${bytes[1].toString(16)}]`,
    );
  return {
    channelId: base58Encode(bytes.subarray(2, 34)),
    cumulativeAmount: readU64LE(bytes, 34),
    expiresAt: readI64LE(bytes, 42),
  };
}

// PKCS#8 header for a raw 32-byte Ed25519 seed — the same prefix `src/solana.ts`
// uses to load a key with `node:crypto` and no external library.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
// SPKI header for a raw 32-byte Ed25519 public key.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Sign a voucher's 50 bytes with an Ed25519 key, returning the raw 64-byte
 * signature — the bytes the on-chain Ed25519 precompile checks.
 *
 * `secret` is a 64-byte Solana secret key (seed ‖ public, what Phantom and
 * solana-keygen produce) or a bare 32-byte seed.
 */
export function signVoucher(secret: Uint8Array, voucher: Voucher): Uint8Array {
  const seed = secret.length === 64 ? secret.subarray(0, 32) : secret;
  if (seed.length !== 32) throw new Error(`signVoucher needs a 32-byte seed or 64-byte secret key, got ${secret.length}`);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
  return new Uint8Array(crypto.sign(null, Buffer.from(encodeVoucher(voucher)), privateKey));
}

/**
 * Verify a voucher signature against the `authorized_signer` address. This is
 * the cryptographic check only — the watermark, deposit and expiry gates are
 * `checkVoucher`, exactly as the program keeps signature and state separate.
 */
export function verifyVoucher(signerAddress: string, voucher: Voucher, signature: Uint8Array): boolean {
  if (signature.length !== 64) return false;
  const pub = base58Decode(signerAddress);
  if (pub.length !== 32) return false;
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(pub)]),
    format: "der",
    type: "spki",
  });
  try {
    return crypto.verify(null, Buffer.from(encodeVoucher(voucher)), publicKey, Buffer.from(signature));
  } catch {
    return false;
  }
}

export interface VoucherState {
  /** The channel's current settled watermark (on-chain `settled`). */
  settledMicro: bigint;
  /** The channel's deposit ceiling (on-chain `deposit`). */
  depositMicro: bigint;
  /** Now, in unix seconds. Defaults to the wall clock. */
  nowSeconds?: bigint;
}

export type VoucherRejection =
  | "expired"
  | "over_deposit"
  | "watermark_not_monotonic";

/**
 * The on-chain acceptance gate for a voucher against channel state, in the
 * program's own order (spike §3, `voucher.rs:66-98`). Signature and magic are
 * checked elsewhere; this is the state check a seller must run before it
 * settles and a buyer can run to know a voucher will land.
 *
 * - `expires_at == 0 || now < expires_at`  else `expired` (now == expires is expired)
 * - `cumulative <= deposit`                else `over_deposit`
 * - `cumulative >  settled` (strict)       else `watermark_not_monotonic`
 */
export function checkVoucher(voucher: Voucher, state: VoucherState): { ok: true } | { ok: false; reason: VoucherRejection } {
  const now = state.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  if (voucher.expiresAt !== 0n && now >= voucher.expiresAt) return { ok: false, reason: "expired" };
  if (voucher.cumulativeAmount > state.depositMicro) return { ok: false, reason: "over_deposit" };
  if (voucher.cumulativeAmount <= state.settledMicro) return { ok: false, reason: "watermark_not_monotonic" };
  return { ok: true };
}
