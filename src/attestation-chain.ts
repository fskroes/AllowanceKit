import type { SignedAttestation } from "./attestation.ts";
import { networkInfo, CAIP2_ALIASES } from "./live.ts";
import { RPC_DEFAULTS } from "./usdc.ts";

export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

interface ReceiptLog {
  address: string;
  topics: string[];
  data: string;
}

interface TxReceipt {
  status: "success" | "reverted" | string;
  logs: ReceiptLog[];
}

export interface TxReader {
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<TxReceipt | null>;
}

export interface OnChainVerifyOptions {
  client?: TxReader;
  rpcUrl?: string;
  network?: string;
  usdc?: string;
}

export interface OnChainFailure {
  txHash: string;
  reason: string;
}

export interface OnChainVerifyResult {
  supported: boolean;
  reason?: string;
  checked: number;
  verified: number;
  claimed: number;
  weak: boolean;
  failures: OnChainFailure[];
}

function topicToAddress(topic: string | undefined): string | undefined {
  if (typeof topic !== "string" || topic.length < 42) return undefined;
  return ("0x" + topic.slice(topic.length - 40)).toLowerCase();
}

function resolveUsdc(opts: OnChainVerifyOptions): string | undefined {
  if (opts.usdc) return opts.usdc;
  if (opts.network) return networkInfo(opts.network)?.usdc;
  return undefined;
}

function resolveRpc(opts: OnChainVerifyOptions): string | undefined {
  if (opts.rpcUrl) return opts.rpcUrl;
  const n = opts.network;
  if (!n) return undefined;
  return RPC_DEFAULTS[n] ?? RPC_DEFAULTS[CAIP2_ALIASES[n] ?? ""];
}

async function buildClient(opts: OnChainVerifyOptions): Promise<TxReader> {
  const rpcUrl = resolveRpc(opts);
  if (!rpcUrl)
    throw new Error(
      "on-chain verification needs a client, an rpcUrl, or a known network (base, base-sepolia)",
    );
  let viem: { createPublicClient: (a: unknown) => TxReader; http: (u: string) => unknown };
  try {
    const name = "viem";
    viem = (await import(name)) as unknown as typeof viem;
  } catch {
    throw new Error("on-chain verification needs viem for JSON-RPC reads: npm i viem");
  }
  return viem.createPublicClient({ transport: viem.http(rpcUrl) });
}

export async function verifyAttestationOnChain(
  att: SignedAttestation,
  opts: OnChainVerifyOptions = {},
): Promise<OnChainVerifyResult> {
  const claimed = att.summary.verifiableTxCount;
  const hashes = att.summary.verifiableTxHashes;
  if (!hashes || hashes.length === 0) {
    return {
      supported: false,
      reason: "attestation carries no txHash evidence — the agent must attest with includeEvidence:true",
      checked: 0,
      verified: 0,
      claimed,
      weak: false,
      failures: [],
    };
  }

  const agent = att.agent.toLowerCase();
  const usdc = resolveUsdc(opts)?.toLowerCase();
  const client = opts.client ?? (await buildClient(opts));

  let verified = 0;
  const failures: OnChainFailure[] = [];

  for (const txHash of hashes) {
    try {
      const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
      if (!receipt) {
        failures.push({ txHash, reason: "transaction not found on chain" });
        continue;
      }
      if (receipt.status !== "success") {
        failures.push({ txHash, reason: `transaction did not succeed (status ${receipt.status})` });
        continue;
      }
      const paidByAgent = (receipt.logs ?? []).some(
        (log) =>
          log.topics?.[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC &&
          (!usdc || log.address.toLowerCase() === usdc) &&
          topicToAddress(log.topics[1]) === agent,
      );
      if (paidByAgent) verified++;
      else
        failures.push({
          txHash,
          reason: usdc
            ? "no USDC Transfer from the agent in this transaction"
            : "no ERC-20 Transfer from the agent in this transaction",
        });
    } catch (e) {
      failures.push({ txHash, reason: `receipt lookup failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  return { supported: true, checked: hashes.length, verified, claimed, weak: usdc === undefined, failures };
}

export interface OnChainPolicy extends OnChainVerifyOptions {
  minVerified?: number;
  requireAll?: boolean;
}

export async function enforceOnChain(
  att: SignedAttestation,
  policy: OnChainPolicy,
): Promise<{ ok: true; result: OnChainVerifyResult } | { ok: false; reason: string; result: OnChainVerifyResult }> {
  const result = await verifyAttestationOnChain(att, policy);
  if (!result.supported) return { ok: false, reason: result.reason ?? "on-chain evidence missing", result };
  const need = policy.requireAll ? result.claimed : policy.minVerified ?? 1;
  if (result.verified < need)
    return {
      ok: false,
      reason: `on-chain check failed: ${result.verified}/${result.checked} evidence txs verified, needed ${need}`,
      result,
    };
  return { ok: true, result };
}
