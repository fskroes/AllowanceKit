/**
 * base58 (Bitcoin alphabet), hand-rolled to stay dependency-free.
 *
 * Both the Solana rail (`src/solana.ts`) and the voucher codec (`src/voucher.ts`)
 * need to turn 32-byte Solana addresses to and from text, and both must do it
 * without loading `@solana/kit` — a Base agent that imports either module must
 * resolve nothing Solana-shaped. This is the single implementation they share.
 */

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // Start empty, not `[0]`: an all-zero input must encode to just its leading
  // "1"s, and a seeded zero would leak a spurious trailing digit.
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let k = digits.length - 1; k >= 0; k--) out += B58_ALPHABET[digits[k]];
  return out;
}

export function base58Decode(str: string): Uint8Array {
  const map: Record<string, number> = {};
  for (let i = 0; i < B58_ALPHABET.length; i++) map[B58_ALPHABET[i]] = i;
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  // Start empty, not `[0]`: an all-"1" string decodes to just its leading zero
  // bytes, and a seeded zero would leak an extra byte (a 32-byte address → 33).
  const bytes: number[] = [];
  for (let i = zeros; i < str.length; i++) {
    const v = map[str[i]];
    if (v === undefined) throw new Error(`"${str[i]}" is not a base58 character`);
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let k = 0; k < bytes.length; k++) out[zeros + bytes.length - 1 - k] = bytes[k];
  return out;
}

/** True when a string looks like a base58-encoded Solana address (32 bytes). */
export function looksLikeAddress(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return base58Decode(s).length === 32;
  } catch {
    return false;
  }
}
