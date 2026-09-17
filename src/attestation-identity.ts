import type { SignedAttestation } from "./attestation.ts";
import { networkInfo, CAIP2_ALIASES } from "./live.ts";
import { RPC_DEFAULTS } from "./usdc.ts";

/**
 * Registry-resolvable identity for a behavior attestation (v2, the second half).
 *
 * v1 (src/attestation.ts) proves the agent's key signed the numbers, then trusts
 * them on the Wallie brand: `summary.issuer === "wallie"` is a tag a seller keys
 * trust on, not a fact the seller can check. This module removes the brand from
 * the identity too. It anchors the agent in the ERC-8004 Identity Registry — a
 * canonical, chain-wide contract where agents register as NFTs — so a seller
 * that has never heard of Wallie can still resolve the identity: "this address
 * is the registered wallet of agent #N in the ERC-8004 registry."
 *
 * ERC-8004 v2 (github.com/erc-8004/erc-8004-contracts) is agentId-centric: an
 * agent registers and gets an ERC-721 tokenId (== agentId). There is no on-chain
 * reverse index from address to agentId, so the agent states its `agentId` in
 * the signed summary (`registryAgentId`, opt-in at attest time), and the seller
 * confirms the registry maps that agentId back to the attesting address. The
 * agentId rides inside the summary, so the EIP-712 digest binds it: an agent
 * cannot borrow another's registration without breaking the signature.
 *
 * Two registry reads settle it, and the attesting address must equal one of them:
 *   - getAgentWallet(agentId) — the agent's operational wallet, the key it pays
 *     and signs with (what an x402 agent uses); or
 *   - ownerOf(agentId) — the NFT owner, for an agent that pays from the owner key
 *     and never set a separate wallet.
 * A pass means the attesting key is the registered identity of a real ERC-8004
 * agent. It does NOT prove the agent's *behavior* (that is v1 + the on-chain
 * payment re-check in attestation-chain.ts); it proves *who the agent is*,
 * portably, without the brand tag.
 *
 * Like the rest of attestation, viem is imported lazily, so a seller that never
 * asks for registry resolution never pulls an RPC client in.
 */

/** The zero address — getAgentWallet returns it when an agent set no separate wallet. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Canonical ERC-8004 Identity Registry deployments (v2.0.0), keyed by the same
 * bare network names as `NETWORKS`. Override with `opts.registry` for any other
 * chain or a private deployment.
 * Source: github.com/erc-8004/erc-8004-contracts README (master).
 */
export const ERC8004_IDENTITY_REGISTRY: Record<string, string> = {
  base: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  "base-sepolia": "0x8004A818BFB912233c491871b3d84c89A494BD9e",
};

/** The two registry views this module reads, as viem `readContract` exposes them. */
const IDENTITY_ABI = [
  {
    type: "function",
    name: "getAgentWallet",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "wallet", type: "address" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
] as const;

/**
 * Anything that can resolve an ERC-8004 agentId to its on-chain addresses. The
 * built-in implementation wraps a viem public client; a test injects a fake so
 * the check runs with no network. A read returns `null` when the registry has no
 * such entry (a nonexistent tokenId reverts, an unset wallet reads as zero).
 */
export interface RegistryReader {
  /** The agent's operational wallet, or null when unset/zero. */
  getAgentWallet(agentId: bigint): Promise<string | null>;
  /** The NFT owner of the agentId, or null when the token does not exist. */
  ownerOf(agentId: bigint): Promise<string | null>;
}

export interface IdentityVerifyOptions {
  /** Inject a reader (usually a fake in tests). If omitted, one is built from `network`/`rpcUrl` + `registry`. */
  reader?: RegistryReader;
  /** RPC endpoint to build a client from. Overrides the network default. */
  rpcUrl?: string;
  /** Network name (bare or CAIP-2). Resolves the default registry address and a default RPC. */
  network?: string;
  /** Identity Registry contract address. Defaults to the network's canonical ERC-8004 registry. */
  registry?: string;
}

export interface IdentityVerifyResult {
  /** False when the attestation carried no `registryAgentId` — nothing to resolve (attest with `registryAgentId`). */
  supported: boolean;
  /** Why the check could not run or did not pass. */
  reason?: string;
  /** The agentId that was resolved (decimal string), when the attestation carried one. */
  agentId?: string;
  /** True when the registry maps `agentId` to the attesting address (by wallet or owner). */
  registered: boolean;
  /** Which registry field equalled the attesting address. */
  matchedBy?: "wallet" | "owner";
  /** The registered operational wallet, when set. */
  wallet?: string;
  /** The registered NFT owner, when the token exists. */
  owner?: string;
}

function resolveRegistry(opts: IdentityVerifyOptions): string | undefined {
  if (opts.registry) return opts.registry;
  if (!opts.network) return undefined;
  return ERC8004_IDENTITY_REGISTRY[opts.network] ?? ERC8004_IDENTITY_REGISTRY[CAIP2_ALIASES[opts.network] ?? ""];
}

function resolveRpc(opts: IdentityVerifyOptions): string | undefined {
  if (opts.rpcUrl) return opts.rpcUrl;
  const n = opts.network;
  if (!n) return undefined;
  return RPC_DEFAULTS[n] ?? RPC_DEFAULTS[CAIP2_ALIASES[n] ?? ""];
}

/**
 * A contract read that reverts (nonexistent tokenId) or returns no data is a
 * "not registered" answer, not an error. A transport failure (RPC down) is a
 * real error and must propagate, so the caller does not read a network outage as
 * "this agent is unregistered".
 *
 * viem wraps EVERY `readContract` failure — a genuine revert, an empty-data
 * response, AND a transport error (timeout, DNS, RPC 500) — in the same outer
 * `ContractFunctionExecutionError`, so the outer `.name` cannot tell them apart.
 * The distinction lives in the cause chain: only a genuine revert or empty-data
 * response puts a `ContractFunctionRevertedError` / `ContractFunctionZeroDataError`
 * in it. So walk the chain (viem's `BaseError.walk`, or `.cause` links for a
 * plain error) and return true only when one of those specific causes is present.
 * Exported for tests, which feed it viem-shaped errors this module never builds
 * itself.
 */
export function isContractRevert(e: unknown): boolean {
  const isRevertCause = (c: unknown): boolean => {
    const name = (c as { name?: string })?.name ?? "";
    return name === "ContractFunctionRevertedError" || name === "ContractFunctionZeroDataError";
  };
  // viem's BaseError.walk(fn) returns the first matching error in the chain, or null.
  const walk = (e as { walk?: (fn: (c: unknown) => boolean) => unknown }).walk;
  if (typeof walk === "function") return Boolean(walk.call(e, isRevertCause));
  // Fallback for a plain error: follow `.cause` links, guarding against a cycle.
  let cur: unknown = e;
  const seen = new Set<unknown>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (isRevertCause(cur)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

async function buildReader(opts: IdentityVerifyOptions): Promise<RegistryReader> {
  const registry = resolveRegistry(opts);
  if (!registry)
    throw new Error(
      "registry identity needs a registry address or a known network (base, base-sepolia)",
    );
  const rpcUrl = resolveRpc(opts);
  if (!rpcUrl)
    throw new Error("registry identity needs an rpcUrl or a known network (base, base-sepolia)");

  let viem: { createPublicClient: (a: unknown) => { readContract: (a: unknown) => Promise<unknown> }; http: (u: string) => unknown };
  try {
    // Optional peer dependency, resolved at runtime — the core stays zero-dep.
    const name = "viem";
    viem = (await import(name)) as unknown as typeof viem;
  } catch {
    throw new Error("registry identity needs viem for JSON-RPC reads: npm i viem");
  }
  const client = viem.createPublicClient({ transport: viem.http(rpcUrl) });

  const read = async (functionName: "getAgentWallet" | "ownerOf", agentId: bigint): Promise<string | null> => {
    try {
      const out = await client.readContract({ address: registry, abi: IDENTITY_ABI, functionName, args: [agentId] });
      return typeof out === "string" ? out : null;
    } catch (e) {
      if (isContractRevert(e)) return null; // registry reachable, entry absent
      throw e; // transport error — surface it, do not read as "unregistered"
    }
  };

  return {
    getAgentWallet: (id) => read("getAgentWallet", id),
    ownerOf: (id) => read("ownerOf", id),
  };
}

/**
 * Resolve an attestation's `registryAgentId` against the ERC-8004 Identity
 * Registry and confirm the attesting address is that agent's registered wallet
 * or owner. Reads two registry views; never throws for an absent entry (that is
 * `registered: false`); throws only when the reader cannot be built (no
 * reader/rpc/network/registry) or the RPC transport itself fails.
 *
 * Run `verifyAttestation` first so the signature has bound `registryAgentId` to
 * the agent. The integrated paths (`verifyAttestation({ identity })`, the gate's
 * `policy.identity`) do this for you.
 */
export async function verifyAttestationIdentity(
  att: SignedAttestation,
  opts: IdentityVerifyOptions = {},
): Promise<IdentityVerifyResult> {
  const rawId = att.summary.registryAgentId;
  if (rawId === undefined || rawId === null || rawId === "") {
    return {
      supported: false,
      reason: "attestation carries no registryAgentId — the agent must attest with registryAgentId set",
      registered: false,
    };
  }
  if (!/^\d+$/.test(rawId)) {
    return { supported: true, reason: `registryAgentId "${rawId}" is not a valid uint256`, registered: false, agentId: rawId };
  }

  const agentId = BigInt(rawId);
  const agent = att.agent.toLowerCase();
  const reader = opts.reader ?? (await buildReader(opts));

  const [walletRaw, ownerRaw] = await Promise.all([reader.getAgentWallet(agentId), reader.ownerOf(agentId)]);
  const wallet = walletRaw && walletRaw.toLowerCase() !== ZERO_ADDRESS ? walletRaw : undefined;
  const owner = ownerRaw && ownerRaw.toLowerCase() !== ZERO_ADDRESS ? ownerRaw : undefined;

  if (!wallet && !owner) {
    return { supported: true, reason: `agentId ${rawId} is not registered in the identity registry`, registered: false, agentId: rawId };
  }

  if (wallet && wallet.toLowerCase() === agent)
    return { supported: true, registered: true, agentId: rawId, matchedBy: "wallet", wallet, owner };
  if (owner && owner.toLowerCase() === agent)
    return { supported: true, registered: true, agentId: rawId, matchedBy: "owner", wallet, owner };

  return {
    supported: true,
    reason: `attesting address ${att.agent} is neither the registered wallet nor the owner of agentId ${rawId}`,
    registered: false,
    agentId: rawId,
    wallet,
    owner,
  };
}

/** Enforcement knobs layered on the read options, for `verifyAttestation` and the gate. */
export interface IdentityPolicy extends IdentityVerifyOptions {
  /**
   * Require the agentId to resolve to the attesting address. Default true. Set
   * false to attach the resolution (`result.identity`) without failing a claim
   * that carries no registryAgentId or an unregistered one.
   */
  requireRegistered?: boolean;
}

/**
 * Run {@link verifyAttestationIdentity} and turn it into a pass/fail with a
 * reason, applying an {@link IdentityPolicy}. Shared by `verifyAttestation` and
 * the seller gate so both enforce identically.
 */
export async function enforceIdentity(
  att: SignedAttestation,
  policy: IdentityPolicy,
): Promise<{ ok: true; result: IdentityVerifyResult } | { ok: false; reason: string; result: IdentityVerifyResult }> {
  const result = await verifyAttestationIdentity(att, policy);
  const require = policy.requireRegistered !== false;
  if (!require) return { ok: true, result };
  if (!result.supported) return { ok: false, reason: result.reason ?? "no registry identity to resolve", result };
  if (!result.registered) return { ok: false, reason: result.reason ?? "agent is not registered in the identity registry", result };
  return { ok: true, result };
}
