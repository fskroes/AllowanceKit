/**
 * The Wallie MCP server (docs/SOLANA-ARCHITECTURE.md §8, SOL-07).
 *
 * Exposes an allowance-governed agent over the Model Context Protocol so an MCP
 * client — Claude Desktop, an agent framework, the example agent in
 * `demo/mcp-agent/` — can pay x402 APIs through the same policy rails, ledger and
 * escrow book the CLI uses. Five tools, stdio transport:
 *
 *   pay_fetch(url, method?, body?, headers?)  → pay an x402 endpoint (exact or upto)
 *   get_budget()                              → funded / spent / reserved / escrowed / remaining + window
 *   list_channels()                           → the buyer's Solana `upto` escrow book
 *   decide_approval(id, approve)              → approve or deny a queued payment (§8 `approve`/`deny`)
 *   reclaim_channel(id)                       → sweep an orphaned channel's deposit back
 *
 * The server binds ONE runtime, resolved from the state directory exactly like
 * the CLI: a live directory (`mode.json` says so) builds a `createLiveAgent`
 * from `AGENT_PRIVATE_KEY`; anything else is practice money via `createAgent`.
 * So the same server serves whichever rail the directory is wired to — a Base or
 * Solana live agent settles real USDC, a fresh directory simulates it — and
 * `pay_fetch` chooses `exact` vs `upto` per offer without the caller knowing.
 *
 * The `@modelcontextprotocol/sdk` is an optional peer, imported lazily here, so
 * the core buyer runtime stays zero-dependency: importing `allowance-kit` never
 * pulls the MCP stack in, only `allowance-kit/mcp` does.
 */
import { createAgent, DEFAULT_AGENT_NAME, decideApproval, allowanceRemaining, type AllowanceRuntime } from "./wallet.ts";
import { createLiveAgent, type LiveAgentRuntime } from "./live.ts";
import { readMode } from "./mode.ts";
import { ChannelStore, reclaimChannel } from "./channels.ts";
import { RULE_LABELS, type PolicyRule } from "./policy.ts";
import { solanaSigner, normalizeSolanaKey, solanaNetworkInfo } from "./solana.ts";
import { payingFetch } from "./payer.ts";
import { fmtUsdExact } from "./money.ts";
import { runtimeVersion } from "./version.ts";
import type { ChannelRecord } from "./types.ts";

// The SDK's low-level types, declared locally so the build never depends on the
// optional peer's type surface (the same trick solana.ts uses for @x402/svm).
interface McpServerLike {
  setRequestHandler(schema: unknown, handler: (req: McpRequest) => Promise<McpToolResult>): void;
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}
interface McpRequest {
  params: { name: string; arguments?: Record<string, unknown> };
}
interface McpToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Runtime resolution — the same mock-vs-live decision the CLI makes.
// ---------------------------------------------------------------------------

export interface McpRuntimeOptions {
  /** State directory. Defaults to `ALLOWANCE_STATE_DIR` or `.allowance`, like the CLI. */
  stateDir?: string;
  agentName?: string;
  /** Live rails only: the payer key. Defaults to `AGENT_PRIVATE_KEY`. */
  privateKey?: string;
  /** Skip resolution and serve this runtime directly (tests, the example agent). */
  runtime?: AllowanceRuntime;
}

/** What the tool handlers need beyond the runtime: the key, so `reclaim_channel` can sign. */
export interface McpBinding {
  runtime: AllowanceRuntime;
  network?: string;
  rpcUrl?: string;
  /** Present only on a Solana live agent — a key is required to build the reclaim transactions. */
  privateKey?: string;
}

/** The default state directory, matching the CLI (`ALLOWANCE_STATE_DIR` overrides). */
export function defaultStateDir(): string {
  return process.env.ALLOWANCE_STATE_DIR ?? ".allowance";
}

/**
 * Build the runtime the server will govern. A directory a live agent has claimed
 * (`mode.json`) needs the private key and reconstructs the live agent; every
 * other directory is practice money. Mirrors `src/cli.ts` so the MCP server and
 * the CLI never disagree about what a directory means.
 */
export async function resolveBinding(opts: McpRuntimeOptions = {}): Promise<McpBinding> {
  if (opts.runtime) {
    const rt = opts.runtime as LiveAgentRuntime;
    return { runtime: opts.runtime, network: rt.network, rpcUrl: rt.rpcUrl, privateKey: opts.privateKey };
  }
  const stateDir = opts.stateDir ?? defaultStateDir();
  const agentName = opts.agentName ?? DEFAULT_AGENT_NAME;
  const mode = readMode(stateDir);
  if (mode.mode === "live") {
    const privateKey = opts.privateKey ?? process.env.AGENT_PRIVATE_KEY;
    if (!privateKey)
      throw new Error(
        `state dir ${stateDir} is a live agent — set AGENT_PRIVATE_KEY to the payer key before starting the MCP server`,
      );
    const live = await createLiveAgent({
      stateDir,
      agentName,
      privateKey,
      network: mode.network,
      rpcUrl: mode.rpcUrl,
    });
    return { runtime: live, network: live.network, rpcUrl: live.rpcUrl, privateKey };
  }
  return { runtime: createAgent(stateDir, agentName) };
}

// ---------------------------------------------------------------------------
// Money formatting helpers — every amount goes out as micro string, a USD number
// and a human string, so a client can display or compute without guessing.
// ---------------------------------------------------------------------------

function money(micro: bigint): { micro: string; usd: number; text: string } {
  return { micro: micro.toString(), usd: Number(micro) / 1_000_000, text: fmtUsdExact(micro) };
}

// ---------------------------------------------------------------------------
// The five tools. Each handler is a pure function of the binding so it can be
// tested without the MCP transport; the server just routes to them.
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS = [
  {
    name: "pay_fetch",
    description:
      "Fetch an x402-priced URL, paying autonomously inside the allowance rails. Returns the response plus what was " +
      "spent. Chooses `exact` or `upto` per the seller's offer; a refused payment comes back as `blocked` with the " +
      "reason, never an exception.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The resource URL to fetch and, if it answers 402, pay for." },
        method: { type: "string", description: "HTTP method. Defaults to GET." },
        body: { type: "string", description: "Request body for POST/PUT etc. Sent as-is." },
        headers: { type: "object", additionalProperties: { type: "string" }, description: "Extra request headers." },
      },
      required: ["url"],
    },
  },
  {
    name: "get_budget",
    description:
      "The allowance right now: funded ceiling, spent, reserved (in-flight), escrowed (open Solana channels), and " +
      "what remains, plus the velocity window state. Read this before a spending spree.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_channels",
    description:
      "The buyer's book of Solana `upto` payment channels — each deposit's status, what settled, and what was " +
      "refunded. Empty on non-Solana rails.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "decide_approval",
    description:
      "Approve or deny a payment that the rails queued for a human (a charge at or above your approval threshold). " +
      "Approving mints a time-boxed, budget-limited grant so the next retry of that call goes through.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The approval request id (from get_budget or a prior pay_fetch block)." },
        approve: { type: "boolean", description: "true approves and grants; false denies." },
      },
      required: ["id", "approve"],
    },
  },
  {
    name: "reclaim_channel",
    description:
      "Sweep an orphaned Solana `upto` channel's deposit back to the wallet after its grace period. Needs a Solana " +
      "live agent with its key; a no-op with a clear message on other rails.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The channel id (PDA) to reclaim." } },
      required: ["id"],
    },
  },
] as const;

async function toolPayFetch(b: McpBinding, args: Record<string, unknown>): Promise<McpToolResult> {
  const url = String(args.url ?? "");
  if (!url) return errorResult("pay_fetch needs a `url`");
  const method = typeof args.method === "string" ? args.method : undefined;
  const body = typeof args.body === "string" ? args.body : undefined;
  const headers = isStringMap(args.headers) ? (args.headers as Record<string, string>) : undefined;

  const init: RequestInit = {};
  if (method) init.method = method;
  if (body !== undefined) {
    init.body = body;
    // A body with no method almost always means a POST; default it, and give the
    // body a content type unless the caller set one.
    if (!method) init.method = "POST";
    init.headers = { "content-type": "application/json", ...(headers ?? {}) };
  } else if (headers) {
    init.headers = headers;
  }

  const res = await payingFetch(b.runtime.ctx, url, init);

  const structured: Record<string, unknown> = {
    ok: res.ok,
    status: res.status,
    cost: money(res.costMicro),
    quoted: money(res.quotedMicro),
  };
  if (res.txHash) structured.txHash = res.txHash;
  if (res.channelId) structured.channelId = res.channelId;
  if (res.refundMicro !== undefined) structured.refund = money(res.refundMicro);
  if (res.error) structured.error = res.error;
  if (res.body !== undefined && res.body !== null) structured.body = res.body;
  else if (res.raw) structured.raw = res.raw;

  let summary: string;
  if (res.blockedBy) {
    // The one thing judges must see: the human label for the rule, not the enum.
    const label = RULE_LABELS[res.blockedBy.rule];
    structured.blocked = {
      rule: res.blockedBy.rule,
      label,
      detail: res.blockedBy.detail,
      recoverable: res.blockedBy.recoverable,
      ...(res.blockedBy.requestId ? { requestId: res.blockedBy.requestId } : {}),
      ...(res.blockedBy.quotedMicro !== undefined ? { quoted: money(res.blockedBy.quotedMicro) } : {}),
      ...(res.blockedBy.capMicro !== undefined ? { cap: money(res.blockedBy.capMicro) } : {}),
    };
    summary = `BLOCKED  ${label} — ${res.blockedBy.detail}`;
  } else if (res.error) {
    summary = `ERROR    ${res.error}`;
  } else if (res.costMicro > 0n || res.txHash) {
    const refund = res.refundMicro !== undefined && res.refundMicro > 0n ? `, refunded ${fmtUsdExact(res.refundMicro)}` : "";
    summary = `PAID     ${fmtUsdExact(res.costMicro)}${refund}  ${url}`;
  } else {
    summary = `${res.ok ? "OK" : `HTTP ${res.status}`}   ${url}`;
  }

  return { content: [{ type: "text", text: summary }], structuredContent: structured };
}

function toolGetBudget(b: McpBinding): McpToolResult {
  const rt = b.runtime;
  const policy = rt.policy();
  const totals = rt.ledger.totals(rt.agentName, 0);
  const windowMs = policy.windowSeconds * 1000;
  const windowSpend = rt.ledger.totals(rt.agentName, windowMs).windowSpendMicro;
  const openReservations = rt.reservations.list(rt.agentName);
  const reservedMicro = openReservations.reduce((s, r) => s + BigInt(r.amountMicro), 0n);
  // Escrow, netted the same way `allowanceRemaining` nets it (§5): a channel
  // still backed by an open reservation has its ceiling in `reserved` already, so
  // it is excluded here. Reserved and escrowed never overlap, which keeps
  // `funded − spent − reserved − escrowed` equal to `remaining` even mid-payment.
  const escrowedMicro = rt.escrowedMicro?.(new Set(openReservations.map((r) => r.id))) ?? 0n;
  const remaining = allowanceRemaining(rt);

  const structured = {
    mode: rt.mode,
    network: b.network ?? null,
    address: rt.address,
    funded: money(totals.topupsMicro),
    spent: money(totals.spendTotalMicro),
    reserved: money(reservedMicro),
    escrowed: money(escrowedMicro),
    remaining: money(remaining),
    budgetCeiling: policy.totalBudgetUsd,
    perCallMaxUsd: policy.perCallMaxUsd,
    requireApprovalAboveUsd: policy.requireApprovalAboveUsd,
    killSwitch: policy.killSwitch,
    window: {
      seconds: policy.windowSeconds,
      limit: { usd: policy.windowLimitUsd },
      spent: money(windowSpend),
    },
    payments: totals.payments,
    blocks: totals.blocks,
  };

  const summary =
    `Allowance (${rt.mode}${b.network ? ` · ${b.network}` : ""}): ${fmtUsdExact(remaining)} remaining ` +
    `of ${fmtUsdExact(totals.topupsMicro)} funded — spent ${fmtUsdExact(totals.spendTotalMicro)}, ` +
    `reserved ${fmtUsdExact(reservedMicro)}, escrowed ${fmtUsdExact(escrowedMicro)}. ` +
    `Window: ${fmtUsdExact(windowSpend)} of $${policy.windowLimitUsd.toFixed(2)} in ${policy.windowSeconds}s.`;

  return { content: [{ type: "text", text: summary }], structuredContent: structured };
}

function toolListChannels(b: McpBinding): McpToolResult {
  const store = new ChannelStore(b.runtime.stateDir);
  const records = store.list(b.runtime.agentName);
  const channels = records.map((c) => ({
    channelId: c.channelId,
    status: c.status,
    host: c.host,
    url: c.url,
    network: c.network,
    deposit: money(BigInt(c.depositMicro)),
    settled: money(BigInt(c.settledMicro)),
    refund: money(BigInt(c.refundMicro)),
    withdrawDelay: c.withdrawDelay,
    openedAt: c.at,
    ...(c.orphanedAt ? { orphanedAt: c.orphanedAt } : {}),
  }));
  const escrowedMicro = store.escrowedMicro(b.runtime.agentName);

  const summary =
    channels.length === 0
      ? "No payment channels (channels are Solana `upto` only)."
      : `${channels.length} channel(s), ${fmtUsdExact(escrowedMicro)} escrowed:\n` +
        channels
          .map((c) => `  ${c.status.padEnd(9)} ${c.channelId.slice(0, 12)}…  ${c.host}  deposit ${c.deposit.text} settled ${c.settled.text}`)
          .join("\n");

  return {
    content: [{ type: "text", text: summary }],
    structuredContent: { channels, escrowed: money(escrowedMicro) },
  };
}

function toolDecideApproval(b: McpBinding, args: Record<string, unknown>): McpToolResult {
  const id = String(args.id ?? "");
  if (!id) return errorResult("decide_approval needs an `id`");
  if (typeof args.approve !== "boolean") return errorResult("decide_approval needs `approve` as true or false");
  const decided = decideApproval(b.runtime, id, args.approve);
  if (!decided) {
    const pending = b.runtime.approvals.pending().map((r) => r.id);
    return {
      content: [
        {
          type: "text",
          text: `No pending approval "${id}".${pending.length ? ` Pending: ${pending.join(", ")}.` : " Nothing is queued."}`,
        },
      ],
      structuredContent: { ok: false, id, pending },
      isError: false,
    };
  }
  const verb = args.approve ? "approved" : "denied";
  return {
    content: [{ type: "text", text: `Request ${id} ${verb}.` }],
    structuredContent: { ok: true, id, approved: args.approve },
  };
}

async function toolReclaimChannel(b: McpBinding, args: Record<string, unknown>): Promise<McpToolResult> {
  const id = String(args.id ?? "");
  if (!id) return errorResult("reclaim_channel needs an `id`");
  const store = new ChannelStore(b.runtime.stateDir);
  const record = store.get(id) as ChannelRecord | undefined;
  // Scope to this agent, like list_channels — one agent sharing a directory must
  // not reclaim another's channel by id.
  if (!record || record.agent !== b.runtime.agentName) return errorResult(`no channel "${id}" in this directory`);

  // Reclaim builds and sends real Solana transactions, so it needs a Solana live
  // agent and the payer key. Say so plainly rather than throwing a library error.
  const isSolana = Boolean(solanaNetworkInfo(record.network));
  if (!isSolana) return errorResult(`channel ${id} is on "${record.network}", which has no reclaim (Solana \`upto\` only)`);
  if (!b.privateKey || !b.rpcUrl)
    return errorResult(
      `reclaiming ${id} needs a Solana live agent with its key and RPC — start the server on the channel's ` +
        `Solana directory with AGENT_PRIVATE_KEY set`,
    );

  const signer = solanaSigner(normalizeSolanaKey(b.privateKey));
  const result = await reclaimChannel(record, signer, { rpcUrl: b.rpcUrl });

  // Nothing was swept — the channel was already resolved on-chain. Reconcile the
  // local row so it stops counting as escrow, but say plainly that no money moved.
  if (!result.reclaimed) {
    return {
      content: [{ type: "text", text: `Nothing to reclaim for ${id}: ${result.note ?? "already resolved"}.` }],
      structuredContent: { ok: false, channelId: id, reclaimed: false, note: result.note ?? null },
    };
  }

  const updated = store.markReclaimed(id, result.refundMicro);
  return {
    content: [
      { type: "text", text: `Reclaimed ${id}, ${fmtUsdExact(result.refundMicro)} back to the wallet.` },
    ],
    structuredContent: {
      ok: true,
      channelId: id,
      status: updated.status,
      refund: money(result.refundMicro),
      signatures: result.signatures,
    },
  };
}

function errorResult(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], structuredContent: { ok: false, error: message }, isError: true };
}

function isStringMap(v: unknown): v is Record<string, string> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
}

/** Route one `tools/call` to its handler, turning any throw into a tool error. */
export async function handleToolCall(
  b: McpBinding,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  try {
    switch (name) {
      case "pay_fetch":
        return await toolPayFetch(b, args);
      case "get_budget":
        return toolGetBudget(b);
      case "list_channels":
        return toolListChannels(b);
      case "decide_approval":
        return toolDecideApproval(b, args);
      case "reclaim_channel":
        return await toolReclaimChannel(b, args);
      default:
        return errorResult(`unknown tool "${name}"`);
    }
  } catch (e) {
    return errorResult(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// The server. Built on the SDK's low-level Server so tool schemas are plain
// JSON Schema and no `zod` dependency creeps in.
// ---------------------------------------------------------------------------

/**
 * Build (but do not connect) an MCP server governing `binding`'s runtime. The
 * caller attaches a transport — {@link runMcpStdio} uses stdio; a test uses a
 * linked in-memory pair.
 */
export async function createMcpServer(binding: McpBinding): Promise<McpServerLike> {
  let ServerCtor: new (info: { name: string; version: string }, opts: { capabilities: { tools: object } }) => McpServerLike;
  let ListToolsRequestSchema: unknown;
  let CallToolRequestSchema: unknown;
  try {
    ({ Server: ServerCtor } = (await import("@modelcontextprotocol/sdk/server/index.js")) as never);
    ({ ListToolsRequestSchema, CallToolRequestSchema } = (await import("@modelcontextprotocol/sdk/types.js")) as never);
  } catch {
    throw new Error("the MCP server needs @modelcontextprotocol/sdk: npm i @modelcontextprotocol/sdk");
  }

  const server = new ServerCtor(
    { name: "wallie-mcp", version: runtimeVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }) as never);
  server.setRequestHandler(CallToolRequestSchema, async (req: McpRequest) =>
    handleToolCall(binding, req.params.name, req.params.arguments ?? {}),
  );

  return server;
}

/** Resolve the runtime, build the server, and serve it over stdio. Blocks until the transport closes. */
export async function runMcpStdio(opts: McpRuntimeOptions = {}): Promise<void> {
  const binding = await resolveBinding(opts);
  const server = await createMcpServer(binding);
  const { StdioServerTransport } = (await import("@modelcontextprotocol/sdk/server/stdio.js")) as never as {
    StdioServerTransport: new () => unknown;
  };
  await server.connect(new StdioServerTransport());
  // The runtime may have started a cloud heartbeat; stop it when stdio closes so
  // the process can exit cleanly.
  const stop = (binding.runtime as { stopHeartbeat?(): void }).stopHeartbeat;
  const cleanup = () => stop?.();
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}
