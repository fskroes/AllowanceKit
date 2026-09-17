import type { SignedAttestation } from "./attestation.ts";
import { networkInfo, CAIP2_ALIASES } from "./live.ts";
import { RPC_DEFAULTS } from "./usdc.ts";

/**
 * On-chain re-verification of a behavior attestation (v2, chain-anchored).
 *
 * v1 (src/attestation.ts) proves the agent's key signed a set of numbers, then
 * trusts those numbers on the Wallie brand. This module removes the brand from
 * the loop for the one claim that is checkable: the payments. It takes the
 * `txHash` evidence the agent chose to expose (`verifiableTxHashes`, opt-in at
 * `summarize`/`attest` time) and, for each hash, reads the transaction receipt
 * from a public RPC and confirms:
 *   1. the transaction settled successfully (status === "success"), and
 *   2. it emitted an ERC-20 `Transfer` whose `from` is the attesting agent —
 *      and, when the seller names the token, that the `Transfer` is USDC.
 *
 * A pass means the agent really moved USDC on-chain from its own key in that
 * transaction. That is no longer self-asserted; a fabricated or borrowed txHash
 * fails. What it deliberately does NOT prove: which seller was paid (the host
 * never leaves the agent) or the exact amount (the evidence is hashes only). So
 * on-chain verification raises the floor from "the agent says it paid N times"
 * to "the agent provably paid N times on-chain", not to a full audit.
 *
 * Privacy cost, stated plainly: a txHash is public. Exposing the hashes lets
 * anyone resolve the counterparties on-chain. v1 keeps them private and trusts
 * the brand; v2 trades that privacy for trustlessness. `includeEvidence` is
 * therefore opt-in — an agent chooses per attestation whether the extra trust
 * is worth the disclosure.
 *
 * x402 settles USDC with EIP-3009 `transferWithAuthorization`, relayed by a
 * facilitator. So the transaction sender (`tx.from`) is the facilitator, NOT the
 * agent. The agent is the `from` inside the `Transfer` log. This module reads
 * the log, never `tx.from`, which is why it works for relayed settlement.
 *
 * Like the rest of attestation, viem is imported lazily, so a seller that never
 * asks for on-chain verification never pulls an RPC client in.
 */

/** keccak256("Transfer(address,address,uint256)") — topic0 of every ERC-20 transfer. */
export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** One log entry, as a viem `getTransactionReceipt` returns it (the subset we read). */
interface ReceiptLog {
  address: string;
  topics: string[];
  data: string;
}

/** A transaction receipt, as a viem `getTransactionReceipt` returns it (subset). */
interface TxReceipt {
  status: "success" | "reverted" | string;
  logs: ReceiptLog[];
}

/**
 * Anything that can read a transaction receipt by hash. A viem public client
 * satisfies it, and a test can inject a fake so the check runs with no network.
 */
export interface TxReader {
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<TxReceipt | null>;
}

export interface OnChainVerifyOptions {
  /** Inject a reader (a viem public client, or a fake). If omitted, one is built from `network`/`rpcUrl`. */
  client?: TxReader;
  /** RPC endpoint to build a client from. Overrides the network default. */
  rpcUrl?: string;
  /** Network name (bare or CAIP-2). Resolves the USDC token to match and a default RPC. */
  network?: string;
  /** USDC token address to match `Transfer` logs against. Defaults to the network's USDC. */
  usdc?: string;
}

/** How a single piece of txHash evidence failed on-chain. */
export interface OnChainFailure {
  txHash: string;
  reason: string;
}

export interface OnChainVerifyResult {
  /** False when the attestation carried no txHash evidence to check (attest with `includeEvidence`). */
  supported: boolean;
  /** Why the check could not run, when `supported` is false. */
  reason?: string;
  /** How many evidence hashes were looked up. */
  checked: number;
  /** How many passed: settled successfully with a matching `Transfer` from the agent. */
  verified: number;
  /** `verifiableTxCount` the summary claimed — evidence length should equal it. */
  claimed: number;
  /** True when no token address was known, so a `Transfer` of any ERC-20 (not just USDC) counted. */
  weak: boolean;
  /** Per-hash failures, for the seller to log or surface. */
  failures: OnChainFailure[];
}

function topicToAddress(topic: string | undefined): string | undefined {
  if (typeof topic !== "string" || topic.length < 42) return undefined;
  // A 32-byte topic left-pads a 20-byte address; the address is the last 40 hex chars.
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
    // Optional peer dependency, resolved at runtime — the core stays zero-dep.
    const name = "viem";
    viem = (await import(name)) as unknown as typeof viem;
  } catch {
    throw new Error("on-chain verification needs viem for JSON-RPC reads: npm i viem");
  }
  return viem.createPublicClient({ transport: viem.http(rpcUrl) });
}

/**
 * Re-check an attestation's txHash evidence on-chain. Reads each hash's receipt,
 * confirms it settled and moved USDC out of the agent's own address, and returns
 * a tally. Never throws for an unverifiable hash — that hash lands in `failures`;
 * it throws only when the reader itself cannot be built (no client/rpc/network).
 *
 * This trusts `att.summary.verifiableTxHashes` as given: run `verifyAttestation`
 * first so the signature has bound that evidence to the agent. The integrated
 * paths (`verifyAttestation({ onChain })`, the gate's `policy.onChain`) do this
 * for you; call this directly only after a signature check has passed.
 */
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

/**
 * On-chain enforcement knobs, layered on the read options. Used by
 * `verifyAttestation({ onChain })` and the seller gate's `policy.onChain`.
 */
export interface OnChainPolicy extends OnChainVerifyOptions {
  /** Minimum evidence txs that must verify on-chain. Default 1. */
  minVerified?: number;
  /** Require every claimed evidence tx to verify (overrides `minVerified`). */
  requireAll?: boolean;
}

/**
 * Run {@link verifyAttestationOnChain} and turn its tally into a pass/fail with a
 * reason, applying an {@link OnChainPolicy}. Shared by `verifyAttestation` and the
 * seller gate so both enforce identically.
 */
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
