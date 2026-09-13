#!/usr/bin/env node
// Wallie's MCP server is allowance-kit's MCP server. The `allowance-kit/mcp`
// subpath export points at the compiled dist/mcp.js; `runMcpStdio` resolves the
// runtime from the state dir (live vs practice from mode.json, the payer key
// from AGENT_PRIVATE_KEY) exactly as the CLI does, then serves over stdio.
import { runMcpStdio } from "allowance-kit/mcp";

runMcpStdio().catch((e) => {
  console.error(`wallie-mcp failed to start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
