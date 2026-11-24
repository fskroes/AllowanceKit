import type { SignedAttestation } from "./attestation.ts";
import { networkInfo, CAIP2_ALIASES } from "./live.ts";
import { RPC_DEFAULTS } from "./usdc.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const ERC8004_IDENTITY_REGISTRY: Record<string, string> = {
  base: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  "base-sepolia": "0x8004A818BFB912233c491871b3d84c89A494BD9e",
};

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

export interface RegistryReader {
  getAgentWallet(agentId: bigint): Promise<string | null>;
  ownerOf(agentId: bigint): Promise<string | null>;
}

export interface IdentityVerifyOptions {
  reader?: RegistryReader;
  rpcUrl?: string;
  network?: string;
  registry?: string;
}

export interface IdentityVerifyResult {
  supported: boolean;
  reason?: string;
  agentId?: string;
  registered: boolean;
  matchedBy?: "wallet" | "owner";
  wallet?: string;
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

export function isContractRevert(e: unknown): boolean {
  const isRevertCause = (c: unknown): boolean => {
    const name = (c as { name?: string })?.name ?? "";
    return name === "ContractFunctionRevertedError" || name === "ContractFunctionZeroDataError";
  };
  const walk = (e as { walk?: (fn: (c: unknown) => boolean) => unknown }).walk;
  if (typeof walk === "function") return Boolean(walk.call(e, isRevertCause));
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
      if (isContractRevert(e)) return null;
      throw e;
    }
  };

  return {
    getAgentWallet: (id) => read("getAgentWallet", id),
    ownerOf: (id) => read("ownerOf", id),
  };
}

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

export interface IdentityPolicy extends IdentityVerifyOptions {
  requireRegistered?: boolean;
}

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
