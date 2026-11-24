import crypto from "node:crypto";
import { base58Decode, base58Encode, looksLikeAddress } from "./base58.ts";
import type { UnsignedPayment } from "./payer.ts";
import { offerAmount, offerAsset, offerPayTo } from "./types.ts";
import { RpcError } from "./usdc.ts";

export interface SolanaNetworkInfo {
  caip2: string;
  v1Name: string;
  mint: string;
  defaultRpc: string;
  tokenProgram: string;
}

const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

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

export const SOLANA_NETWORKS: Record<string, SolanaNetworkInfo> = {
  [MAINNET.caip2]: MAINNET,
  [MAINNET.v1Name]: MAINNET,
  [DEVNET.caip2]: DEVNET,
  [DEVNET.v1Name]: DEVNET,
};

export function solanaNetworkInfo(network: string): SolanaNetworkInfo | undefined {
  return SOLANA_NETWORKS[network];
}

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface SolanaSigner {
  address: string;
  signTransactions(
    transactions: ReadonlyArray<{ messageBytes: Uint8Array }>,
  ): Promise<ReadonlyArray<Readonly<Record<string, Uint8Array>>>>;
}

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

export interface SolanaEncodeConfig {
  rpcUrl?: string;
}

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

export interface UptoChannelFacts {
  channelId: string;
  depositMicro: bigint;
  withdrawDelay: number;
  expiresAt: number;
  openSlot?: number;
  payer?: string;
  payee?: string;
  authorizedSigner?: string;
  mint?: string;
}

export interface UptoOpenResult {
  header: string;
  channel: UptoChannelFacts;
}

interface BuiltUptoPayload {
  channelId?: unknown;
  deposit?: unknown;
  maxAmount?: unknown;
  expiresAt?: unknown;
  from?: unknown;
  openSlot?: unknown;
  openTransaction?: unknown;
  nonce?: unknown;
  authorizedSigner?: unknown;
  validAfter?: unknown;
}

export async function encodePaymentSolanaUpto(
  signer: SolanaSigner,
  unsigned: UnsignedPayment,
  config: SolanaEncodeConfig = {},
): Promise<UptoOpenResult> {
  const reqs = unsigned.requirements;
  const info = solanaNetworkInfo(reqs.network);
  if (!info)
    throw new Error(`unsupported Solana network "${reqs.network}" (known: ${Object.keys(SOLANA_NETWORKS).join(", ")})`);
  if (reqs.scheme !== "upto") throw new Error(`encodePaymentSolanaUpto needs an \`upto\` offer, got "${reqs.scheme}"`);

  const amount = offerAmount(reqs);
  if (amount === undefined) throw new Error("seller upto offer carries no ceiling `amount`");
  const asset = offerAsset(reqs);
  if (!asset) throw new Error("seller upto offer carries no `asset` (the USDC mint)");
  const payTo = offerPayTo(reqs);
  if (!payTo) throw new Error("seller upto offer carries no `payTo`");

  const extra = (reqs.extra as Record<string, unknown>) ?? {};
  if (!extra.feePayer)
    throw new Error("seller upto offer `extra` carries no `feePayer` — the seller must self-facilitate the open");
  if (!extra.receiverAuthorizer) throw new Error("seller upto offer `extra` carries no `receiverAuthorizer`");
  const withdrawDelay = Number(extra.withdrawDelay ?? 900) || 900;

  let UptoSvmScheme: new (
    signer: unknown,
    config?: { rpcUrl?: string },
  ) => {
    createPaymentPayload(
      x402Version: number,
      requirements: Record<string, unknown>,
    ): Promise<{ x402Version?: number; payload: BuiltUptoPayload }>;
  };
  try {
    ({ UptoSvmScheme } = (await import("@x402/svm/upto/client")) as never);
  } catch {
    throw new Error("Solana `upto` needs @x402/svm and @solana/kit: npm i @x402/svm @solana/kit");
  }

  const scheme = new UptoSvmScheme(signer, config.rpcUrl ? { rpcUrl: config.rpcUrl } : undefined);
  const requirements = {
    scheme: "upto",
    network: reqs.network,
    asset,
    amount,
    maxAmountRequired: amount,
    payTo,
    maxTimeoutSeconds: reqs.maxTimeoutSeconds ?? 300,
    extra,
  };

  const version = unsigned.x402Version >= 2 ? 2 : 1;
  const built = await scheme.createPaymentPayload(version, requirements);
  const payload = built.payload;

  const channelId = typeof payload.channelId === "string" ? payload.channelId : String(payload.channelId ?? "");
  if (!channelId) throw new Error("the upto scheme did not return a channelId");
  const depositRaw = payload.deposit ?? payload.maxAmount ?? amount;
  const expiresAt = Number(payload.expiresAt);

  const channel: UptoChannelFacts = {
    channelId,
    depositMicro: BigInt(String(depositRaw)),
    withdrawDelay,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    openSlot: payload.openSlot === undefined ? undefined : Number(payload.openSlot),
    payer: typeof payload.from === "string" ? payload.from : signer.address,
    payee: String(extra.feePayer),
    authorizedSigner: String(extra.receiverAuthorizer),
    mint: asset,
  };

  const envelope = { x402Version: version, accepted: unsigned.acceptedOffer ?? reqs, payload };
  const header = Buffer.from(JSON.stringify(envelope)).toString("base64");
  return { header, channel };
}

export async function probeSolanaLibs(): Promise<{ ok: boolean; detail: string }> {
  try {
    await import("@x402/svm/exact/client");
    await import("@solana/kit");
    return { ok: true, detail: "installed — Solana signing available" };
  } catch {
    return { ok: false, detail: "not installed — run `npm i @x402/svm @solana/kit` (needed only for Solana networks)" };
  }
}

export function describeSolanaKeyFormat(network: string): string {
  const info = solanaNetworkInfo(network);
  const name = info?.v1Name ?? network;
  return `on ${name}, AGENT_PRIVATE_KEY is a base58 64-byte secret (Phantom export) or a JSON array of 64 bytes (solana-keygen)`;
}
