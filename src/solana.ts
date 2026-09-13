import crypto from "node:crypto";
import { base58Decode, base58Encode, looksLikeAddress } from "./base58.ts";
import type { UnsignedPayment } from "./payer.ts";
import { offerAmount, offerAsset, offerPayTo } from "./types.ts";
import { RpcError } from "./usdc.ts";

/**
 * The Solana rail for the buyer `exact` scheme.
 *
 * Everything a Base agent never touches lives behind lazy `import()`: only
 * `encodePaymentSolanaExact` loads `@x402/svm` and `@solana/kit`, and only when
 * it runs. Constructing a Solana agent — the network table, the signer, the
 * balance read — needs no Solana library at all, so a Base agent that imports
 * this module still resolves nothing solana-shaped. base58 is hand-rolled here
 * for exactly that reason: it keeps the signer and the key parser zero-dep.
 *
 * The buyer signs the v0 message with a `node:crypto` Ed25519 key; the seller's
 * `extra.feePayer` stays the second, unsigned signature. The buyer needs USDC
 * and no SOL (docs/SOLANA-ARCHITECTURE.md §1, §4.1).
 */

export interface SolanaNetworkInfo {
  /** CAIP-2 id used on the x402 v2 wire (e.g. `solana:5eykt4Us…`). */
  caip2: string;
  /** v1 bare name (`solana` / `solana-devnet`). */
  v1Name: string;
  /** USDC mint address for this cluster. */
  mint: string;
  /** JSON-RPC endpoint used to read balances when none is passed. */
  defaultRpc: string;
  /** SPL token program that owns the USDC mint. */
  tokenProgram: string;
}

const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// IDs verified against @x402/svm 2.25.0 and docs/SOLANA-ARCHITECTURE.md §1.
// The devnet CAIP-2 id is `EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, not the wrong
// devnet string a prior session wrote (docs §1) — that appears in no package.
const MAINNET: SolanaNetworkInfo = {
  caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  v1Name: "solana",
  mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  defaultRpc: "https://api.mainnet-beta.solana.com",
  tokenProgram: SPL_TOKEN_PROGRAM,
};

const DEVNET: SolanaNetworkInfo = {
  caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  v1Name: "solana-devnet",
  mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  defaultRpc: "https://api.devnet.solana.com",
  tokenProgram: SPL_TOKEN_PROGRAM,
};

/**
 * Both the CAIP-2 id and the v1 bare name resolve to the same entry, so a v2
 * seller quoting `solana:EtWT…` and a v1 agent configured for `solana-devnet`
 * land on one network.
 */
export const SOLANA_NETWORKS: Record<string, SolanaNetworkInfo> = {
  [MAINNET.caip2]: MAINNET,
  [MAINNET.v1Name]: MAINNET,
  [DEVNET.caip2]: DEVNET,
  [DEVNET.v1Name]: DEVNET,
};

/** Resolve a CAIP-2 id or a v1 bare name to its Solana network (undefined if unknown). */
export function solanaNetworkInfo(network: string): SolanaNetworkInfo | undefined {
  return SOLANA_NETWORKS[network];
}

// ---------------------------------------------------------------------------
// Key parsing and the Ed25519 signer. base58 lives in ./base58.ts so the
// voucher codec can share one implementation without loading a Solana library.
// ---------------------------------------------------------------------------

// PKCS#8 header for a raw 32-byte Ed25519 seed. node:crypto builds a private
// key from `header || seed` with no external library.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * A minimal `TransactionPartialSigner` (@solana/kit): the object the buyer
 * `exact` scheme signs with. `signTransactions` returns one signature
 * dictionary per transaction, keyed by this signer's address.
 */
export interface SolanaSigner {
  address: string;
  signTransactions(
    transactions: ReadonlyArray<{ messageBytes: Uint8Array }>,
  ): Promise<ReadonlyArray<Readonly<Record<string, Uint8Array>>>>;
}

/**
 * Parse `AGENT_PRIVATE_KEY` for a Solana network into the 64-byte secret key.
 * Accepts a base58 string (what Phantom exports) or a JSON array of 64 bytes
 * (what `solana-keygen` writes). §2.4: one env var, format by network.
 */
export function normalizeSolanaKey(pk: string): Uint8Array {
  const trimmed = pk.trim();

  if (trimmed.startsWith("[")) {
    let arr: unknown;
    try {
      arr = JSON.parse(trimmed);
    } catch {
      throw new Error(
        "AGENT_PRIVATE_KEY looks like a JSON array but does not parse — expected 64 numbers like `[12,34,…]` from `solana-keygen`",
      );
    }
    if (!Array.isArray(arr) || arr.length !== 64 || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255))
      throw new Error("AGENT_PRIVATE_KEY as a JSON array must hold exactly 64 byte values (0-255)");
    return Uint8Array.from(arr as number[]);
  }

  let decoded: Uint8Array;
  try {
    decoded = base58Decode(trimmed);
  } catch {
    throw new Error(
      "AGENT_PRIVATE_KEY for a Solana network must be a base58-encoded 64-byte secret key (Phantom export) or a JSON array of 64 bytes (solana-keygen)",
    );
  }
  if (decoded.length !== 64)
    throw new Error(
      `AGENT_PRIVATE_KEY decoded to ${decoded.length} bytes, expected a 64-byte Solana secret key (base58 Phantom export or a 64-number JSON array)`,
    );
  return decoded;
}

/**
 * Build a `node:crypto` Ed25519 signer from a 64-byte Solana secret key. The
 * signer is a plain `TransactionPartialSigner`: no `@solana/kit` key handling.
 * The base58 `address` is derived from the public key and checked against the
 * public half of the secret so a truncated or swapped key fails loudly here,
 * not at settlement.
 */
export function solanaSigner(secret: Uint8Array): SolanaSigner {
  if (secret.length !== 64) throw new Error(`solanaSigner needs a 64-byte secret key, got ${secret.length} bytes`);
  const seed = secret.subarray(0, 32);
  const declaredPub = secret.subarray(32, 64);

  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
  const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const pub = new Uint8Array(spki.subarray(spki.length - 32));

  if (Buffer.compare(Buffer.from(pub), Buffer.from(declaredPub)) !== 0)
    throw new Error("AGENT_PRIVATE_KEY is inconsistent: its public-key half does not match the private half");

  const address = base58Encode(pub);
  return {
    address,
    async signTransactions(transactions) {
      return transactions.map((tx) =>
        Object.freeze({ [address]: new Uint8Array(crypto.sign(null, Buffer.from(tx.messageBytes), privateKey)) }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Balance, over plain JSON-RPC (no library, mirrors src/usdc.ts).
// ---------------------------------------------------------------------------

/**
 * The wallet's USDC balance in micro-dollars, read with `getTokenAccountsByOwner`
 * filtered by mint. Plain JSON-RPC over `fetch` — no client, no ATA derivation.
 * USDC is 6 decimals, the same unit the ledger uses, so no scaling. Sums every
 * matching token account (normally one) and returns 0 when the owner holds none.
 */
export async function usdcBalanceMicroSolana(
  rpcUrl: string,
  mint: string,
  owner: string,
  timeoutMs = 8000,
): Promise<bigint> {
  if (!looksLikeAddress(mint)) throw new RpcError(`"${mint}" is not a mint address`);
  if (!looksLikeAddress(owner)) throw new RpcError(`"${owner}" is not a wallet address`);

  let res: Response;
  try {
    res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [owner, { mint }, { encoding: "jsonParsed" }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new RpcError(`could not reach ${hostOf(rpcUrl)}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new RpcError(`HTTP ${res.status} from ${hostOf(rpcUrl)}`);

  const body = (await res.json().catch(() => null)) as
    | { result?: { value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }> }; error?: { message?: string } }
    | null;
  if (!body) throw new RpcError(`${hostOf(rpcUrl)} did not answer with JSON`);
  if (body.error) throw new RpcError(body.error.message ?? "RPC error");

  const accounts = body.result?.value;
  if (!Array.isArray(accounts)) throw new RpcError(`unexpected getTokenAccountsByOwner result from ${hostOf(rpcUrl)}`);

  let total = 0n;
  for (const a of accounts) {
    const amount = a.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (typeof amount === "string" && /^\d+$/.test(amount)) total += BigInt(amount);
  }
  return total;
}

/**
 * The wallet's native SOL balance in lamports, over plain JSON-RPC `getBalance`.
 * The buyer needs no SOL for the happy path, but the channel escape path
 * (`channels reclaim`) is payer-signed and payer-fee-paid, so `doctor` warns
 * when the wallet is empty of SOL on a Solana network (§2.5). 1 SOL = 1e9 lamports.
 */
export async function solBalanceLamportsSolana(rpcUrl: string, owner: string, timeoutMs = 8000): Promise<bigint> {
  if (!looksLikeAddress(owner)) throw new RpcError(`"${owner}" is not a wallet address`);
  let res: Response;
  try {
    res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [owner] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new RpcError(`could not reach ${hostOf(rpcUrl)}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new RpcError(`HTTP ${res.status} from ${hostOf(rpcUrl)}`);
  const body = (await res.json().catch(() => null)) as { result?: { value?: number }; error?: { message?: string } } | null;
  if (!body) throw new RpcError(`${hostOf(rpcUrl)} did not answer with JSON`);
  if (body.error) throw new RpcError(body.error.message ?? "RPC error");
  const value = body.result?.value;
  if (typeof value !== "number") throw new RpcError(`unexpected getBalance result from ${hostOf(rpcUrl)}`);
  return BigInt(value);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Encoder — the only place a Solana library loads.
// ---------------------------------------------------------------------------

export interface SolanaEncodeConfig {
  /** RPC endpoint the scheme uses for the single mint read (and blockhash, if unpinned). */
  rpcUrl?: string;
}

/**
 * Builds and signs a real Solana `exact` payment payload and wraps it in the
 * x402 header envelope (base64 JSON), mirroring `encodePaymentEvm`'s v1/v2
 * branch so the header codec stays ours — `@x402/core/http` (which pulls zod)
 * is never imported.
 *
 * `@x402/svm`'s `ExactSvmScheme` builds a v0 transaction (compute budget,
 * TransferChecked, memo), signs the payer with our `node:crypto` signer and
 * leaves `extra.feePayer` unsigned. It makes one RPC call to read the mint's
 * decimals; when `extra.recentBlockhash` is present it makes no blockhash call.
 */
export async function encodePaymentSolanaExact(
  signer: SolanaSigner,
  unsigned: UnsignedPayment,
  config: SolanaEncodeConfig = {},
): Promise<string> {
  const reqs = unsigned.requirements;
  const info = solanaNetworkInfo(reqs.network);
  if (!info)
    throw new Error(
      `unsupported Solana network "${reqs.network}" (known: ${Object.keys(SOLANA_NETWORKS).join(", ")})`,
    );

  const amount = offerAmount(reqs);
  if (amount === undefined) throw new Error("seller offer carries neither `amount` nor `maxAmountRequired`");
  const asset = offerAsset(reqs);
  if (!asset) throw new Error("seller offer carries no `asset` (the USDC mint)");
  const payTo = offerPayTo(reqs);
  if (!payTo) throw new Error("seller offer carries no `payTo`");

  // Lazy — a Base agent never reaches this line, so it never resolves these.
  let ExactSvmScheme: new (signer: unknown, config?: { rpcUrl?: string }) => {
    createPaymentPayload(
      x402Version: number,
      requirements: Record<string, unknown>,
    ): Promise<{ payload: { transaction: string } }>;
  };
  try {
    ({ ExactSvmScheme } = (await import("@x402/svm/exact/client")) as never);
  } catch {
    throw new Error("Solana networks need @x402/svm and @solana/kit: npm i @x402/svm @solana/kit");
  }

  const scheme = new ExactSvmScheme(signer, config.rpcUrl ? { rpcUrl: config.rpcUrl } : undefined);
  const requirements = {
    scheme: reqs.scheme,
    network: reqs.network,
    asset,
    amount,
    payTo,
    maxTimeoutSeconds: reqs.maxTimeoutSeconds ?? 300,
    extra: (reqs.extra as Record<string, unknown>) ?? {},
  };

  const version = unsigned.x402Version >= 2 ? 2 : 1;
  const built = await scheme.createPaymentPayload(version, requirements);
  const payload = { transaction: built.payload.transaction };

  if (version >= 2) {
    // Echo the seller's offer verbatim under `accepted` (a facilitator matches
    // it against what it advertised), exactly like the EVM v2 shape.
    const payloadV2 = {
      x402Version: 2,
      accepted: unsigned.acceptedOffer ?? reqs,
      payload,
    };
    return Buffer.from(JSON.stringify(payloadV2)).toString("base64");
  }

  const payloadV1 = {
    x402Version: unsigned.x402Version,
    scheme: reqs.scheme,
    network: reqs.network,
    resource: { url: reqs.resource, description: reqs.description ?? "", mimeType: reqs.mimeType ?? "" },
    payload,
  };
  return Buffer.from(JSON.stringify(payloadV1)).toString("base64");
}

// ---------------------------------------------------------------------------
// doctor rows (SOL-01 scope: libs + key format only; SOL-for-reclaim and the
// seller treasury ATA rows belong to later tickets). Wired into `doctor` by a
// follow-up; kept here so the check text lives with the rail.
// ---------------------------------------------------------------------------

/** Probe the optional Solana peers the way `viem` is probed in `doctor`. */
export async function probeSolanaLibs(): Promise<{ ok: boolean; detail: string }> {
  try {
    await import("@x402/svm/exact/client");
    await import("@solana/kit");
    return { ok: true, detail: "installed — Solana signing available" };
  } catch {
    return { ok: false, detail: "not installed — run `npm i @x402/svm @solana/kit` (needed only for Solana networks)" };
  }
}

/** The `AGENT_PRIVATE_KEY` format `doctor` should name for a Solana network. */
export function describeSolanaKeyFormat(network: string): string {
  const info = solanaNetworkInfo(network);
  const name = info?.v1Name ?? network;
  return `on ${name}, AGENT_PRIVATE_KEY is a base58 64-byte secret (Phantom export) or a JSON array of 64 bytes (solana-keygen)`;
}
