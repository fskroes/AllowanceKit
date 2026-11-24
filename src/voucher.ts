import crypto from "node:crypto";
import { base58Decode, base58Encode } from "./base58.ts";

export const VOUCHER_MAGIC = Uint8Array.of(0x56, 0x01);

export const VOUCHER_PAYLOAD_SIZE = 50;

export interface Voucher {
  channelId: string;
  cumulativeAmount: bigint;
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
  writeU64LE(out, offset, value < 0n ? value + (1n << 64n) : value);
}

function readI64LE(bytes: Uint8Array, offset: number): bigint {
  const u = readU64LE(bytes, offset);
  return u > I64_MAX ? u - (1n << 64n) : u;
}

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

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

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
  settledMicro: bigint;
  depositMicro: bigint;
  nowSeconds?: bigint;
}

export type VoucherRejection =
  | "expired"
  | "over_deposit"
  | "watermark_not_monotonic";

export function checkVoucher(voucher: Voucher, state: VoucherState): { ok: true } | { ok: false; reason: VoucherRejection } {
  const now = state.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  if (voucher.expiresAt !== 0n && now >= voucher.expiresAt) return { ok: false, reason: "expired" };
  if (voucher.cumulativeAmount > state.depositMicro) return { ok: false, reason: "over_deposit" };
  if (voucher.cumulativeAmount <= state.settledMicro) return { ok: false, reason: "watermark_not_monotonic" };
  return { ok: true };
}
