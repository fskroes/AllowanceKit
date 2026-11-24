import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AcceptsEntry, ChannelRecord } from "./types.ts";
import { offerAmount, offerAsset, offerPayTo } from "./types.ts";
import type { PayContext, UnsignedPayment, UptoBuyer } from "./payer.ts";
import { Ledger } from "./ledger.ts";
import { PolicyStore } from "./policy.ts";
import { ApprovalStore } from "./approvals.ts";
import { ReservationStore } from "./reservations.ts";
import { NotifyStore, Notifier, startCloudHeartbeat, type CloudHeartbeat, type ChannelPhase } from "./notify.ts";
import { runtimeVersion } from "./version.ts";
import { buildPolicyRails, DEFAULT_AGENT_NAME, type AllowanceRuntime } from "./wallet.ts";
import { writeMode } from "./mode.ts";
import { BalanceCache, RPC_DEFAULTS, usdcBalanceMicro } from "./usdc.ts";
import {
  SOLANA_NETWORKS,
  solanaNetworkInfo,
  solanaSigner,
  normalizeSolanaKey,
  usdcBalanceMicroSolana,
  encodePaymentSolanaExact,
  encodePaymentSolanaUpto,
} from "./solana.ts";
import { ChannelStore, reconcileAndNotify, solanaAccountRpc } from "./channels.ts";
import { withLock } from "./lock.ts";
import { usd } from "./money.ts";
import { attestFromLedger, type AttestOptions, type AttestationSigner, type SignedAttestation } from "./attestation.ts";

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

export const CAIP2_ALIASES: Record<string, string> = {
  "eip155:8453": "base",
  "eip155:84532": "base-sepolia",
};

export function networkInfo(network: string): NetworkInfo | undefined {
  return NETWORKS[network] ?? NETWORKS[CAIP2_ALIASES[network] ?? ""];
}

export function family(network: string): "evm" | "solana" | undefined {
  if (networkInfo(network)) return "evm";
  if (solanaNetworkInfo(network)) return "solana";
  return undefined;
}

export function isMainnet(network: string): boolean {
  const sol = solanaNetworkInfo(network);
  if (sol) return sol.v1Name === "solana";
  return networkInfo(network) !== undefined && (CAIP2_ALIASES[network] ?? network) === "base";
}

export function mainnetName(network: string): string {
  return solanaNetworkInfo(network) ? "solana" : "base";
}

export function sameChain(a: string, b: string): boolean {
  const fa = family(a);
  if (fa !== family(b)) return false;
  if (fa === "evm") {
    const ia = networkInfo(a);
    const ib = networkInfo(b);
    return ia !== undefined && ib !== undefined && ia.chainId === ib.chainId;
  }
  if (fa === "solana") {
    const sa = solanaNetworkInfo(a);
    const sb = solanaNetworkInfo(b);
    return sa !== undefined && sb !== undefined && sa.caip2 === sb.caip2;
  }
  return false;
}

export function selectOffer(
  offers: AcceptsEntry[],
  network: string,
  opts: { preferScheme?: "exact" | "upto"; perCallMaxMicro?: bigint } = {},
): AcceptsEntry | undefined {
  const usable = (offers ?? []).filter((o) => {
    if (o.scheme !== "exact" && o.scheme !== "upto") return false;
    if (!sameChain(o.network, network)) return false;
    const amount = offerAmount(o);
    if (amount === undefined || !/^\d+$/.test(amount)) return false;
    const asset = offerAsset(o);
    if (family(o.network) === "solana") {
      const sinfo = solanaNetworkInfo(o.network);
      if (!(sinfo !== undefined && asset === sinfo.mint)) return false;
    } else {
      const extra = o.extra as { verifyingContract?: string } | undefined;
      if (extra?.verifyingContract && asset && extra.verifyingContract.toLowerCase() !== asset.toLowerCase())
        return false;
    }
    if (o.scheme === "upto") {
      const extra = o.extra as { feePayer?: unknown; receiverAuthorizer?: unknown } | undefined;
      if (!extra?.feePayer || !extra?.receiverAuthorizer) return false;
    }
    return true;
  });
  if (!usable.length) return undefined;

  const cheapest = (list: AcceptsEntry[]): AcceptsEntry | undefined =>
    list.length ? list.reduce((best, o) => (BigInt(offerAmount(o)!) < BigInt(offerAmount(best)!) ? o : best)) : undefined;
  const bestExact = cheapest(usable.filter((o) => o.scheme === "exact"));
  const bestUpto = cheapest(usable.filter((o) => o.scheme === "upto"));

  if (opts.preferScheme === "upto") return bestUpto ?? bestExact;
  if (opts.preferScheme === "exact") return bestExact ?? bestUpto;
  if (bestExact) {
    if (opts.perCallMaxMicro === undefined || BigInt(offerAmount(bestExact)!) <= opts.perCallMaxMicro) return bestExact;
    return bestUpto ?? bestExact;
  }
  return bestUpto;
}

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
  privateKey: string;
  network?: keyof typeof NETWORKS | string;
  rpcUrl?: string;
  balanceTtlMs?: number;
  checkOnChainBalance?: boolean;
  preferScheme?: "exact" | "upto";
}

export interface LiveAgentRuntime extends AllowanceRuntime {
  mode: "live";
  network: string;
  rpcUrl: string;
  walletBalanceMicro(): Promise<bigint>;
  attest(opts?: AttestOptions): Promise<SignedAttestation>;
}

export async function createLiveAgent(opts: LiveAgentOptions): Promise<LiveAgentRuntime> {
  const agentName = opts.agentName ?? DEFAULT_AGENT_NAME;
  const stateDir = path.resolve(opts.stateDir);
  fs.mkdirSync(stateDir, { recursive: true });

  const network = opts.network ?? "base-sepolia";
  const fam = family(network);
  if (!fam)
    throw new Error(
      `unsupported network "${network}" (known: ${[...Object.keys(NETWORKS), ...Object.keys(SOLANA_NETWORKS)].join(", ")})`,
    );

  let address: string;
  let readBalance: () => Promise<bigint>;
  let encode: (unsigned: UnsignedPayment) => Promise<string>;
  let rpcUrl: string;
  let attestSigner: AttestationSigner | undefined;
  let upto: UptoBuyer | undefined;
  const channels = new ChannelStore(stateDir);
  const escrowedMicro = (openReservationIds?: ReadonlySet<string>) =>
    channels.escrowedMicro(agentName, openReservationIds ? { excludeReservationIds: openReservationIds } : {});
  let heartbeatBeat: (() => Promise<Partial<CloudHeartbeat>>) | undefined;

  const notifyStore = new NotifyStore(stateDir, agentName);
  const notifier = new Notifier(notifyStore, agentName, undefined, { network, mode: "live" });

  if (fam === "solana") {
    const sinfo = solanaNetworkInfo(network)!;
    rpcUrl = opts.rpcUrl ?? sinfo.defaultRpc;
    const signer = solanaSigner(normalizeSolanaKey(opts.privateKey));
    address = signer.address;
    readBalance = () => usdcBalanceMicroSolana(rpcUrl, sinfo.mint, address);
    encode = (unsigned) => encodePaymentSolanaExact(signer, unsigned, { rpcUrl });

    const lockPath = path.join(stateDir, "allowance.lock");
    const reconcileRpc = solanaAccountRpc(rpcUrl);
    upto = {
      open: async (unsigned, meta) => {
        balances.invalidate();
        const { header, channel } = await encodePaymentSolanaUpto(signer, unsigned, { rpcUrl });
        const rec = await withLock(lockPath, () =>
          channels.add({
            channelId: channel.channelId,
            agent: agentName,
            url: meta.url,
            host: meta.host,
            network,
            depositMicro: channel.depositMicro,
            withdrawDelay: channel.withdrawDelay,
            openSlot: channel.openSlot,
            payer: channel.payer ?? address,
            payee: channel.payee,
            authorizedSigner: channel.authorizedSigner,
            mint: channel.mint,
            reservationId: meta.reservationId,
          }),
        );
        notifier.channel("opened", rec);
        return { header, channelId: channel.channelId, depositMicro: channel.depositMicro };
      },
      resolve: async (channelId, outcome) => {
        let resolved: { phase: ChannelPhase; rec: ChannelRecord } | undefined;
        await withLock(lockPath, () => {
          const current = channels.get(channelId);
          if (current && ["settled", "refunded", "reclaimed"].includes(current.status)) {
            if (outcome.kind !== "unknown" && BigInt(current.settledMicro) !== (outcome.kind === "settled" ? outcome.settledMicro : 0n))
              throw new Error(`channel ${channelId} receipt conflicts with recovered settlement`);
            return;
          }
          if (outcome.kind === "settled") resolved = { phase: "settled", rec: channels.settle(channelId, outcome.settledMicro, outcome.txHash) };
          else if (outcome.kind === "refunded") resolved = { phase: "refunded", rec: channels.refund(channelId, outcome.txHash) };
          else channels.markUnknown(channelId);
        });
        if (resolved) notifier.channel(resolved.phase, resolved.rec);
        balances.invalidate();
      },
    };
    heartbeatBeat = async () => {
      if (channels.active(agentName).length) {
        await reconcileAndNotify(reconcileRpc, channels, (phase, rec) => notifier.channel(phase, rec), {
          agent: agentName,
          network,
          lock: (fn) => withLock(lockPath, fn),
        });
      }
      return { escrowedMicro: channels.escrowedMicro(agentName).toString() };
    };
  } else {
    const info = NETWORKS[network];
    if (!info)
      throw new Error(`unsupported network "${network}" (known: ${Object.keys(NETWORKS).join(", ")})`);
    rpcUrl = opts.rpcUrl ?? RPC_DEFAULTS[network];
    if (!rpcUrl) throw new Error(`no default RPC for "${network}" — pass rpcUrl`);

    let privateKeyToAccount: (pk: string) => { address: string; signTypedData: (args: unknown) => Promise<string> };
    try {
      const viemAccounts = "viem/accounts";
      ({ privateKeyToAccount } = await import(viemAccounts));
    } catch {
      throw new Error("live networks need viem for EIP-712 signing: npm i viem");
    }
    if (typeof privateKeyToAccount !== "function")
      throw new Error("viem is installed but does not export privateKeyToAccount from viem/accounts — check the viem version");
    const account = privateKeyToAccount(normalizePk(opts.privateKey));
    address = account.address;
    attestSigner = account;
    readBalance = () => usdcBalanceMicro(rpcUrl, info.usdc, account.address);
    encode = (unsigned) => encodePaymentEvm(account, unsigned);
  }

  const ledger = new Ledger(stateDir);
  const policyStore = new PolicyStore(stateDir, agentName);
  const approvals = new ApprovalStore(stateDir, agentName);
  const reservations = new ReservationStore(stateDir);

  const balances = new BalanceCache(readBalance, opts.balanceTtlMs ?? 15_000, (e) =>
    console.warn(`could not read the wallet's USDC balance: ${e instanceof Error ? e.message : String(e)}`),
  );

  writeMode(stateDir, { mode: "live", network, address, rpcUrl });

  const rails = buildPolicyRails({
    agentName,
    address,
    stateDir,
    chain: {
      sign: () => {
        throw new Error("mock signing unavailable on a live agent");
      },
      balance: () => ledger.topups(agentName) - ledger.spendTotal(agentName),
    },
    ledger,
    policyStore,
    approvals,
    reservations,
    notifier,
    walletBalance: opts.checkOnChainBalance === false ? undefined : () => balances.get(),
    escrowedMicro,
  });

  const ctx: PayContext = {
    agentName,
    address,
    chain: {
      sign: () => {
        throw new Error("mock signing unavailable on a live agent");
      },
      balance: () => ledger.topups(agentName) - ledger.spendTotal(agentName),
    },
    chooseOffer: (offers) =>
      selectOffer(offers, network, {
        preferScheme: opts.preferScheme,
        perCallMaxMicro: usd(policyStore.load().perCallMaxUsd),
      }),
    encodePayment: async (unsigned) => {
      if (!sameChain(unsigned.requirements.network, network))
        throw new Error(
          `seller wants payment on "${unsigned.requirements.network}" but this agent is configured for "${network}" — ` +
            `nothing was signed. Create the agent with network: "${unsigned.requirements.network}" if that is what you meant.`,
        );
      balances.invalidate();
      return encode(unsigned);
    },
    ...rails,
    ...(upto ? { upto } : {}),
  };

  const stopHeartbeat = startCloudHeartbeat(
    notifyStore.load().cloud,
    {
      agent: agentName,
      network,
      mode: "live",
      version: runtimeVersion(),
    },
    heartbeatBeat ? { beat: heartbeatBeat } : {},
  );

  return {
    agentName,
    address,
    stateDir,
    ctx,
    ledger,
    policyStore,
    approvals,
    reservations,
    notifyStore,
    mode: "live",
    network,
    rpcUrl,
    walletBalanceMicro: readBalance,
    policy: () => policyStore.load(),
    escrowedMicro,
    stopHeartbeat,
    attest: async (attestOpts: AttestOptions = {}) => {
      if (!attestSigner)
        throw new Error(
          `behavior attestation needs an EVM signer; this agent is on "${network}". EIP-712 attestation is EVM-only in v1.`,
        );
      return attestFromLedger(attestSigner, ledger, address, { ...attestOpts, ledgerKey: agentName });
    },
  };
}

export async function encodePaymentEvm(
  account: { address: string; signTypedData: (args: unknown) => Promise<string> },
  unsigned: UnsignedPayment,
): Promise<string> {
  const reqs = unsigned.requirements;
  const info = networkInfo(reqs.network);
  if (!info)
    throw new Error(
      `unsupported network "${reqs.network}" (known: ${[...Object.keys(NETWORKS), ...Object.keys(CAIP2_ALIASES)].join(", ")})`,
    );

  const amount = offerAmount(reqs);
  if (amount === undefined) throw new Error("seller offer carries neither `amount` nor `maxAmountRequired`");

  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address as `0x${string}`,
    to: (offerPayTo(reqs) ?? "") as `0x${string}`,
    value: BigInt(amount),
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

  const wireAuthorization = {
    ...authorization,
    value: authorization.value.toString(),
    validAfter: authorization.validAfter.toString(),
    validBefore: authorization.validBefore.toString(),
  };

  if (unsigned.x402Version >= 2) {
    const payloadV2 = {
      x402Version: 2,
      accepted: unsigned.acceptedOffer ?? reqs,
      payload: { signature, authorization: wireAuthorization },
    };
    return Buffer.from(JSON.stringify(payloadV2)).toString("base64");
  }

  const payload = {
    x402Version: unsigned.x402Version,
    scheme: reqs.scheme,
    network: reqs.network,
    resource: { url: reqs.resource, description: reqs.description ?? "", mimeType: reqs.mimeType ?? "" },
    payload: { signature, authorization: wireAuthorization },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function evmDomain(reqs: AcceptsEntry, info: NetworkInfo): { name: string; version: string; chainId: number; verifyingContract: `0x${string}` } {
  const extra = reqs.extra as { name?: string; version?: string } | undefined;
  const asset = offerAsset(reqs) ?? "";
  return {
    name: extra?.name ?? info.domainName,
    version: extra?.version ?? info.domainVersion,
    chainId: info.chainId,
    verifyingContract: ((/^0x[0-9a-fA-F]{40}$/.test(asset) ? asset : info.usdc)) as `0x${string}`,
  };
}

function normalizePk(pk: string): `0x${string}` {
  const trimmed = pk.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}
