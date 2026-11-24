export const RPC_DEFAULTS: Record<string, string> = {
  base: "https://mainnet.base.org",
  "base-sepolia": "https://sepolia.base.org",
};

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

  invalidate(): void {
    this.at = 0;
  }
}
