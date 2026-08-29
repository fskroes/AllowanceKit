/**
 * Reading the wallet's real USDC balance, over plain JSON-RPC.
 *
 * The allowance ledger is bookkeeping: it records what a human said the agent
 * may spend. On a live network that says nothing about whether the money is
 * actually there. Without this check a wallet holding $0 passes every rail and
 * fails at the facilitator, which is the one place a spend-control tool should
 * never let a surprise happen.
 *
 * `eth_call` over `fetch` keeps the zero-dependency promise: no RPC client, no
 * ABI encoder. USDC is 6 decimals, which is the same unit the ledger uses, so
 * the returned number needs no scaling.
 */

/** Public endpoints, overridable — they rate-limit, so bring your own for anything busy. */
export const RPC_DEFAULTS: Record<string, string> = {
  base: "https://mainnet.base.org",
  "base-sepolia": "https://sepolia.base.org",
};

/** `balanceOf(address)` — the first 4 bytes of keccak256("balanceOf(address)"). */
const BALANCE_OF = "0x70a08231";

export class RpcError extends Error {}

export async function usdcBalanceMicro(
  rpcUrl: string,
  token: string,
  owner: string,
  timeoutMs = 8000,
): Promise<bigint> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new RpcError(`"${token}" is not a token address`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new RpcError(`"${owner}" is not a wallet address`);
  const data = BALANCE_OF + owner.slice(2).toLowerCase().padStart(64, "0");

  let res: Response;
  try {
    res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data }, "latest"] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new RpcError(`could not reach ${hostOf(rpcUrl)}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new RpcError(`HTTP ${res.status} from ${hostOf(rpcUrl)}`);

  const body = (await res.json().catch(() => null)) as { result?: string; error?: { message?: string } } | null;
  if (!body) throw new RpcError(`${hostOf(rpcUrl)} did not answer with JSON`);
  if (body.error) throw new RpcError(body.error.message ?? "RPC error");
  const result = body.result;
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]*$/.test(result))
    throw new RpcError(`unexpected eth_call result from ${hostOf(rpcUrl)}`);
  return result === "0x" ? 0n : BigInt(result);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * A balance the policy engine can consult without paying for an RPC round trip
 * on every call. Stale within `ttlMs`, and deliberately fail-open: if the RPC
 * is unreachable the rails fall back to the allowance ledger alone rather than
 * freezing an agent because someone else's node is down.
 */
export class BalanceCache {
  private value: bigint | undefined;
  private at = 0;
  private inFlight: Promise<bigint | undefined> | null = null;

  private read: () => Promise<bigint>;
  private ttlMs: number;
  private onError: (e: unknown) => void;

  constructor(read: () => Promise<bigint>, ttlMs = 15_000, onError: (e: unknown) => void = () => undefined) {
    this.read = read;
    this.ttlMs = ttlMs;
    this.onError = onError;
  }

  /** Last known balance, refreshed if older than the TTL. `undefined` when never readable. */
  async get(): Promise<bigint | undefined> {
    if (this.value !== undefined && Date.now() - this.at < this.ttlMs) return this.value;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.read()
      .then((v) => {
        this.value = v;
        this.at = Date.now();
        return v;
      })
      .catch((e: unknown) => {
        this.onError(e);
        return this.value;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Forces the next `get()` to hit the network. */
  invalidate(): void {
    this.at = 0;
  }
}
