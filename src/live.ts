import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AcceptsEntry } from "./types.ts";
import { offerAmount, offerAsset, offerPayTo } from "./types.ts";
import type { PayContext, UnsignedPayment, UptoBuyer } from "./payer.ts";
import { Ledger } from "./ledger.ts";
import { PolicyStore } from "./policy.ts";
import { ApprovalStore } from "./approvals.ts";
import { ReservationStore } from "./reservations.ts";
import { NotifyStore, Notifier, startCloudHeartbeat } from "./notify.ts";
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
import { ChannelStore } from "./channels.ts";
import { withLock } from "./lock.ts";
import { usd } from "./money.ts";

/**
 * Live-network agent runtime: same policy rails, approvals and audit ledger
 * as the mock agent, but payments are real x402 v1 EVM payloads
 * (EIP-3009 TransferWithAuthorization, EIP-712 signed) usable against any
 * live x402 endpoint whose seller settles through a standard facilitator.
 *
 * Two things separate this from the practice-money runtime, and both exist
 * because the money is real:
 *
 *   - The allowance is a ceiling, not a balance. `topUp` records what a human
 *     is willing to let the agent spend; the USDC itself arrives by being sent
 *     to `runtime.address`. Both are enforced — see `insufficient_funds`.
 *   - The configured network is a hard constraint. A seller quoting a chain the
 *     agent was not configured for is refused before anything is signed, so a
 *     testnet agent can never be talked into signing a mainnet authorization.
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

/**
 * x402 v2 identifies networks in CAIP-2 (`eip155:<chainId>`); v1 used bare
 * names. Every live seller now quotes CAIP-2 (x402-compat.md §3, §4). Map both
 * ways so a v2 seller quoting `eip155:84532` resolves to the same chain as a v1
 * agent configured for `base-sepolia`, and bare names keep working unchanged.
 */
export const CAIP2_ALIASES: Record<string, string> = {
  "eip155:8453": "base",
  "eip155:84532": "base-sepolia",
};

/**
 * Resolve a bare name or a CAIP-2 id to its EVM NetworkInfo (undefined if it is
 * not an EVM network). Solana ids resolve through `solanaNetworkInfo` in
 * `src/solana.ts` instead — see `family`.
 */
export function networkInfo(network: string): NetworkInfo | undefined {
  return NETWORKS[network] ?? NETWORKS[CAIP2_ALIASES[network] ?? ""];
}

/** Which rail an identifier names: EVM, Solana, or neither. */
export function family(network: string): "evm" | "solana" | undefined {
  if (networkInfo(network)) return "evm";
  if (solanaNetworkInfo(network)) return "solana";
  return undefined;
}

/**
 * True when the identifier names a live *mainnet* — real money — by either its
 * bare name or its CAIP-2 id. Base mainnet and Solana mainnet qualify; their
 * testnets (`base-sepolia`, `solana-devnet`) do not. The CLI's real-money
 * guards go through this so a CAIP-2 alias (`eip155:8453`,
 * `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`) can never slip past a bare-string
 * `=== "base"` check.
 */
export function isMainnet(network: string): boolean {
  const sol = solanaNetworkInfo(network);
  if (sol) return sol.v1Name === "solana";
  return networkInfo(network) !== undefined && (CAIP2_ALIASES[network] ?? network) === "base";
}

/** The canonical bare name of a live mainnet, for prompts ("base" / "solana"). */
export function mainnetName(network: string): string {
  return solanaNetworkInfo(network) ? "solana" : "base";
}

/**
 * True when two identifiers name the same chain, whether written bare or as
 * CAIP-2. The live agent's hard network constraint (x402-compat.md §6.3) uses
 * this so `eip155:84532` is accepted for a `base-sepolia` agent but `eip155:8453`
 * (a genuinely different chain) is still refused. Two Solana ids match when they
 * resolve to the same cluster (CAIP-2 id or v1 name); a Solana id never matches
 * an EVM one.
 */
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

/**
 * Pick the offer a live agent on `network` can actually settle. A real v2 seller
 * advertises several at once — different chains (mainnet *and* testnet), price
 * tiers, and sometimes mechanisms this signer does not implement. Taking
 * `accepts[0]` blindly pays the wrong one: QuickNode's first Base-Sepolia offer
 * is a $1 "credit drawdown" tier that then demands SIWX, and a mainnet offer may
 * sit ahead of the testnet one. Keep only `exact`-scheme offers on our chain
 * that settle as a plain USDC `TransferWithAuthorization` — our EIP-712 domain
 * uses the USDC asset as `verifyingContract`, so an `extra.verifyingContract`
 * naming a *different* contract (e.g. Circle Gateway's batcher) is a mechanism
 * we cannot sign for and is dropped. Among what remains, take the cheapest.
 * Returns undefined when nothing is fulfillable, so the buyer reports "no
 * acceptable payment methods" rather than signing a doomed payload.
 *
 * A Solana seller may advertise `upto` (a metered payment channel) beside
 * `exact` (§4.2). Both are kept; the preference is: `exact` when it exists and
 * its price is at or below the per-call cap, otherwise `upto` (whose ceiling the
 * policy still checks). `opts.preferScheme` overrides. An `upto` offer with no
 * self-facilitation keys in `extra` is unbuildable and dropped. On an EVM agent
 * there are no `upto` offers, so this returns the cheapest `exact` exactly as
 * before — no behaviour change for Base.
 */
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
      // Solana: the asset must be the USDC mint for that cluster (base58, case
      // matters). There is no verifyingContract on this rail.
      const sinfo = solanaNetworkInfo(o.network);
      if (!(sinfo !== undefined && asset === sinfo.mint)) return false;
    } else {
      const extra = o.extra as { verifyingContract?: string } | undefined;
      if (extra?.verifyingContract && asset && extra.verifyingContract.toLowerCase() !== asset.toLowerCase())
        return false;
    }
    // `upto` needs the seller's self-facilitation keys to build the open; an
    // offer missing them is a doomed payload, so drop it.
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
  /**
   * The payer wallet's private key. Format follows the network (§2.4): a hex
   * secp256k1 key ("0x…") for EVM, or a base58 64-byte secret / a JSON array of
   * 64 bytes for Solana.
   */
  privateKey: string;
  /**
   * The only chain this agent will sign for. Defaults to Base Sepolia: an
   * agent that reaches mainnet has to be told to, in writing.
   */
  network?: keyof typeof NETWORKS | string;
  /** JSON-RPC endpoint used to read the wallet's USDC balance. Defaults per network. */
  rpcUrl?: string;
  /** How long a balance reading stays good enough to authorize against. */
  balanceTtlMs?: number;
  /**
   * Set false to spend on the allowance ledger alone, without checking that the
   * wallet can actually cover it. Only sensible when an RPC is unreachable.
   */
  checkOnChainBalance?: boolean;
  /**
   * Solana only: force a scheme when a seller advertises both `exact` and
   * `upto` (§4.2). The default prefers `exact` at or below the per-call cap and
   * falls back to `upto` above it. No effect on EVM (there is no `upto`).
   */
  preferScheme?: "exact" | "upto";
}

export interface LiveAgentRuntime extends AllowanceRuntime {
  mode: "live";
  network: string;
  rpcUrl: string;
  /** The wallet's real USDC balance right now, straight from the chain. */
  walletBalanceMicro(): Promise<bigint>;
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

  // Each rail resolves the same three things: the payer address, how to read
  // its USDC balance, and how to encode a signed payment. Everything after this
  // branch is shared, so a Base agent runs the identical path it did before.
  let address: string;
  let readBalance: () => Promise<bigint>;
  let encode: (unsigned: UnsignedPayment) => Promise<string>;
  let rpcUrl: string;
  // Solana `upto` buyer hooks — built only on a Solana network (§4.3). A Base
  // agent leaves this undefined, so `payingFetch` never takes the upto path.
  let upto: UptoBuyer | undefined;
  // Reads the escrow locked in open channels for the budget rail (§5). Set only
  // on Solana; a Base agent has no channels, so the rails see zero escrow.
  let escrowedMicro: ((openReservationIds?: ReadonlySet<string>) => bigint) | undefined;

  if (fam === "solana") {
    const sinfo = solanaNetworkInfo(network)!;
    rpcUrl = opts.rpcUrl ?? sinfo.defaultRpc;
    const signer = solanaSigner(normalizeSolanaKey(opts.privateKey));
    address = signer.address;
    readBalance = () => usdcBalanceMicroSolana(rpcUrl, sinfo.mint, address);
    encode = (unsigned) => encodePaymentSolanaExact(signer, unsigned, { rpcUrl });

    // Escrow is a third money state (§0, §3.3): the channel store is the buyer's
    // book of open deposits. It shares the allowance lock so a channel mutation
    // and a reservation never interleave. The store loads no Solana library.
    const channels = new ChannelStore(stateDir);
    escrowedMicro = (openReservationIds) =>
      channels.escrowedMicro(agentName, openReservationIds ? { excludeReservationIds: openReservationIds } : {});
    const lockPath = path.join(stateDir, "allowance.lock");
    upto = {
      open: async (unsigned, meta) => {
        // Encode outside the lock (it may build a transaction / read a
        // blockhash), then persist the escrow row under the lock before the send.
        const { header, channel } = await encodePaymentSolanaUpto(signer, unsigned, { rpcUrl });
        await withLock(lockPath, () =>
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
        return { header, channelId: channel.channelId, depositMicro: channel.depositMicro };
      },
      resolve: async (channelId, outcome) => {
        await withLock(lockPath, () => {
          if (outcome.kind === "settled") channels.settle(channelId, outcome.settledMicro);
          else if (outcome.kind === "refunded") channels.refund(channelId);
          else channels.markUnknown(channelId);
        });
      },
    };
  } else {
    const info = NETWORKS[network];
    if (!info)
      throw new Error(`unsupported network "${network}" (known: ${Object.keys(NETWORKS).join(", ")})`);
    rpcUrl = opts.rpcUrl ?? RPC_DEFAULTS[network];
    if (!rpcUrl) throw new Error(`no default RPC for "${network}" — pass rpcUrl`);

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
    address = account.address;
    readBalance = () => usdcBalanceMicro(rpcUrl, info.usdc, account.address);
    encode = (unsigned) => encodePaymentEvm(account, unsigned);
  }

  const ledger = new Ledger(stateDir);
  const policyStore = new PolicyStore(stateDir, agentName);
  const approvals = new ApprovalStore(stateDir, agentName);
  const reservations = new ReservationStore(stateDir);
  const notifyStore = new NotifyStore(stateDir, agentName);
  const notifier = new Notifier(notifyStore, agentName, undefined, { network, mode: "live" });

  const balances = new BalanceCache(readBalance, opts.balanceTtlMs ?? 15_000, (e) =>
    console.warn(`could not read the wallet's USDC balance: ${e instanceof Error ? e.message : String(e)}`),
  );

  // Anyone reading this directory afterwards — the CLI, the dashboard — needs
  // to know the money here is real before it prints "practice money" at a human.
  writeMode(stateDir, { mode: "live", network, address, rpcUrl });

  const rails = buildPolicyRails({
    agentName,
    address,
    stateDir,
    // Accounting-only: the ledger, not a simulated chain, is the balance of
    // record here. Settlement happens on-chain via the seller's facilitator.
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
    // A live seller often offers several tiers/chains at once; pick the cheapest
    // one this agent can actually settle on its own chain, not just accepts[0].
    // On Solana it may also weigh `exact` against `upto` (§4.2), so the per-call
    // cap is read live from the policy at selection time.
    chooseOffer: (offers) =>
      selectOffer(offers, network, {
        preferScheme: opts.preferScheme,
        perCallMaxMicro: usd(policyStore.load().perCallMaxUsd),
      }),
    encodePayment: async (unsigned) => {
      // Same-chain, not same-string: a v2 seller quoting `eip155:84532` is the
      // same chain as a `base-sepolia` agent and is signed; a different chain
      // (or an unknown one) is still refused before anything is signed.
      if (!sameChain(unsigned.requirements.network, network))
        throw new Error(
          `seller wants payment on "${unsigned.requirements.network}" but this agent is configured for "${network}" — ` +
            `nothing was signed. Create the agent with network: "${unsigned.requirements.network}" if that is what you meant.`,
        );
      // A settled payment changes the balance; make the next authorize read it.
      balances.invalidate();
      return encode(unsigned);
    },
    ...rails,
    // Present only on a Solana network; a Base agent never opens a channel.
    ...(upto ? { upto } : {}),
  };

  // A live agent is exactly the kind that runs headless on a server, so the
  // heartbeat belongs here, not only in the dashboard. Unref'd; stop it on exit.
  const stopHeartbeat = startCloudHeartbeat(notifyStore.load().cloud, {
    agent: agentName,
    network,
    mode: "live",
    version: runtimeVersion(),
  });

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
    ...(escrowedMicro ? { escrowedMicro } : {}),
    stopHeartbeat,
  };
}

/**
 * Builds and signs a real x402 payment payload: EIP-712
 * TransferWithAuthorization over the USDC asset described by the seller's
 * requirements (`extra.name` / `extra.version` / `asset`). The signing itself is
 * identical between v1 and v2 — only the JSON envelope differs, so the shape is
 * chosen from `unsigned.x402Version` (x402-compat.md §5, §6.4):
 *   - v1: flat `{ x402Version, scheme, network, resource, payload:{…} }`
 *   - v2: nested `{ x402Version:2, resource?, accepted:{requirements}, payload:{…} }`
 */
export async function encodePaymentEvm(
  account: { address: string; signTypedData: (args: unknown) => Promise<string> },
  unsigned: UnsignedPayment,
): Promise<string> {
  const reqs = unsigned.requirements;
  // Resolve either a bare name ("base-sepolia") or a CAIP-2 id ("eip155:84532").
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

  // signTypedData needs uint256 fields as BigInt, but the x402 wire format
  // carries them as decimal strings — and BigInt is not JSON-serializable.
  const wireAuthorization = {
    ...authorization,
    value: authorization.value.toString(),
    validAfter: authorization.validAfter.toString(),
    validBefore: authorization.validBefore.toString(),
  };

  if (unsigned.x402Version >= 2) {
    // v2 PaymentPayload (spec §5.2.2): the chosen requirements go under
    // `accepted`; scheme/network live inside it, not at the top level. Echo the
    // seller's offer verbatim — a facilitator matches `accepted` against what it
    // advertised, so our normalized copy's extra fields (`maxAmountRequired`, a
    // synthesized `resource`) make it throw ("Unexpected error verifying
    // payment"). The top-level `resource` is a ResourceInfo object, not the URL
    // string we carry, so omit it rather than send the wrong type (it is optional).
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
