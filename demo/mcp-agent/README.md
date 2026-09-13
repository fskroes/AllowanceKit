# Wallie MCP example agent

A plain script — no LLM — that drives the [Wallie MCP server](../../packages/wallie-mcp)
the way an agent framework would. It runs the real MCP client/server protocol over a
linked in-process transport, so the whole story is deterministic and offline.

```bash
node demo/mcp-agent/agent.ts      # or: npm run demo:mcp
```

The transcript shows the three things worth seeing:

1. an `exact` buy that settles (practice USDC, mock rail),
2. a payment blocked at the per-call cap, named in plain `RULE_LABELS` language,
3. a Solana `upto` buy that settles below its ceiling and refunds the rest.

The same server the agent talks to is what `npx wallie-mcp` serves over stdio — the
`test/mcp.test.ts` suite proves the bin answers `tools/list` with the five tools over
a real stdio transport.

Why the demo runs the client and server in one process: the two phases use different
rails (a mock EVM agent for `exact`, a Solana devnet agent for `upto`), and a single
MCP server binds one runtime. A linked transport lets one script show both without
spawning two subprocesses or sharing on-chain state across processes. In production
each client points at one `npx wallie-mcp` over stdio.
