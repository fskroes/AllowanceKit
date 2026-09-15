# Wallie MCP

**A spending allowance for your MCP client.** Point Claude Desktop, an agent
framework — anything that speaks the Model Context Protocol — at `wallie-mcp`, and
it pays any x402-priced API on its own, inside hard limits *you* set, with a kill
switch and a receipt for every cent.

`wallie-mcp` serves [`allowance-kit`](https://www.npmjs.com/package/allowance-kit)'s
runtime over stdio. It binds one agent, resolved from the state directory exactly
as the CLI resolves it: a fresh directory is practice money, a directory you have
marked live (with `AGENT_PRIVATE_KEY` set) settles real USDC on Base or Solana.

```bash
export ALLOWANCE_STATE_DIR=.allowance   # optional, this is the default
npx wallie-mcp@0.6.0                    # speaks MCP over stdio
```

In a client config, e.g. `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wallie": { "command": "npx", "args": ["--yes", "wallie-mcp@0.6.0"], "env": { "ALLOWANCE_STATE_DIR": ".allowance" } }
  }
}
```

Five tools: `pay_fetch`, `get_budget`, `list_channels`, `decide_approval`, and
`reclaim_channel`. `pay_fetch` chooses `exact` or `upto` per the seller's offer;
a refused payment comes back as a `blocked` reason in plain language, never an
exception.

The package includes the MCP SDK and the Base and Solana signing libraries, so a
fresh `npx` installation can resolve the live runtime's optional peers. The core
`allowance-kit` package keeps those peers optional for SDK users.

`decide_approval` is administrative authority. A client given this tool can
approve its own queued requests. Only expose it to a trusted client; it is not a
separate human authentication boundary. Spending that bypasses Wallie is outside
its allowance controls.

The same surface is importable from the SDK:

```js
import { createMcpServer, runMcpStdio } from "wallie-mcp"; // or from "allowance-kit/mcp"
```

Full documentation, the changelog, and the source live in the
[`allowance-kit` repository](https://github.com/fskroes/AllowanceKit).
