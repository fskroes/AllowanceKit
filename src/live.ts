import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AcceptsEntry } from "./types.ts";
import type { PayContext, UnsignedPayment } from "./payer.ts";
import { Ledger } from "./ledger.ts";
import { PolicyStore } from "./policy.ts";
import { ApprovalStore } from "./approvals.ts";
import { MockChain } from "./chain.ts";
import { buildPolicyRails, DEFAULT_AGENT_NAME } from "./wallet.ts";

/**
 * Live-network agent runtime: same policy rails, approvals and audit ledger
 * as the mock agent, but payments are real x402 v1 EVM payloads
 * (EIP-3009 TransferWithAuthorization, EIP-712 signed) usable against any
 * live x402 endpoint whose seller settles through a standard facilitator.
 *
 * Signing needs `viem`. It is intentionally an optional peer dependency so
 * the core stays zero-dependency: `npm i viem`.
 */

export interface NetworkInfo {
  chainId: number;
  usdc: string;
  domainName: string;
  domainVersion: string;
}

export const NETWORKS: Record<string, NetworkInfo> = {
  "base-sepolia": {
    chainId: 84532,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    // Testnet USDC reports name() = "USDC"; mainnet reports "USD Coin". The
    // EIP-712 domain must match the contract exactly or the recovered signer
    // is a different address and the transfer fails verification.
    domainName: "USDC",
    domainVersion: "2",
  },
  base: {
    chainId: 8453,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    domainName: "USD Coin",
    domainVersion: "2",
  },
};

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface LiveAgentOptions {
  stateDir: string;
  agentName?: string;
  /** Hex secp256k1 private key of the payer wallet ("0x…"). */
  privateKey: string;
}

export interface LiveAgentRuntime {
  agentName: string;
  address: string;
  stateDir: string;
  ctx: PayContext;
  ledger: Ledger;
}

export async function createLiveAgent(opts: LiveAgentOptions): Promise<LiveAgentRuntime> {
  const agentName = opts.agentName ?? DEFAULT_AGENT_NAME;
  const stateDir = path.resolve(opts.stateDir);
  fs.mkdirSync(stateDir, { recursive: true });

  let privateKeyToAccount: (pk: string) => { address: string; signTypedData: (args: unknown) => Promise<string> };
  try {
    // Optional peer dependency — resolved at runtime so the core stays zero-dep.
    // Signers live in the "viem/accounts" subpath, not the package root.
    const viemAccounts = "viem/accounts";
    ({ privateKeyToAccount } = await import(viemAccounts));
  } catch {
    throw new Error("live networks need viem for EIP-712 signing: npm i viem");
  }
  if (typeof privateKeyToAccount !== "function")
    throw new Error("viem is installed but does not export privateKeyToAccount from viem/accounts — check the viem version");
  const account = privateKeyToAccount(normalizePk(opts.privateKey));

  const ledger = new Ledger(stateDir);
  const policyStore = new PolicyStore(stateDir);
  const approvals = new ApprovalStore(stateDir);
  // Accounting-only stub: balances are derived from the allowance ledger
  // (topups − spend); settlement happens on-chain via the seller's facilitator.
  const accounting = new MockChain();
  const rails = buildPolicyRails({ agentName, address: account.address, stateDir, chain: accounting, ledger, policyStore, approvals });

  const ctx: PayContext = {
    agentName,
    address: account.address,
    chain: {
      sign: () => {
        throw new Error("mock signing unavailable on a live agent");
      },
      balance: (addr) => ledger.topups(agentName) - ledger.spendTotal(agentName),
    },
    encodePayment: (unsigned) => encodePaymentEvm(account, unsigned),
    ...rails,
  };

  return { agentName, address: account.address, stateDir, ctx, ledger };
}

/**
 * Builds and signs a real x402 v1 payment payload (nested EVM shape):
 * EIP-712 TransferWithAuthorization over the USDC asset described by the
 * seller's requirements (`extra.name` / `extra.version` / `asset`).
 */
export async function encodePaymentEvm(
  account: { address: string; signTypedData: (args: unknown) => Promise<string> },
  unsigned: UnsignedPayment,
): Promise<string> {
  const reqs = unsigned.requirements;
  const info = NETWORKS[reqs.network];
  if (!info) throw new Error(`unsupported network "${reqs.network}" (known: ${Object.keys(NETWORKS).join(", ")})`);

  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address as `0x${string}`,
    to: reqs.payTo as `0x${string}`,
    value: BigInt(reqs.maxAmountRequired),
    validAfter: BigInt(now - 60),
    validBefore: BigInt(now + (reqs.maxTimeoutSeconds ?? 300)),
    nonce: `0x${crypto.randomBytes(32).toString("hex")}` as `0x${string}`,
  };

  const signature = await account.signTypedData({
    domain: evmDomain(reqs, info),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });

  const payload = {
    x402Version: unsigned.x402Version,
    scheme: reqs.scheme,
    network: reqs.network,
    resource: { url: reqs.resource, description: reqs.description ?? "", mimeType: reqs.mimeType ?? "" },
    // signTypedData needs uint256 fields as BigInt, but the x402 wire format
    // carries them as decimal strings — and BigInt is not JSON-serializable.
    payload: {
      signature,
      authorization: {
        ...authorization,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function evmDomain(reqs: AcceptsEntry, info: NetworkInfo): { name: string; version: string; chainId: number; verifyingContract: `0x${string}` } {
  const extra = reqs.extra as { name?: string; version?: string } | undefined;
  return {
    name: extra?.name ?? info.domainName,
    version: extra?.version ?? info.domainVersion,
    chainId: info.chainId,
    verifyingContract: ((/^0x[0-9a-fA-F]{40}$/.test(reqs.asset) ? reqs.asset : info.usdc)) as `0x${string}`,
  };
}

function normalizePk(pk: string): `0x${string}` {
  const trimmed = pk.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}
