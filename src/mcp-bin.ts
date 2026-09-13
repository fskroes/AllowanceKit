#!/usr/bin/env node
/**
 * `allowance-mcp` (and, via the alias package, `wallie-mcp`): serve the allowance
 * agent over MCP stdio. The runtime is resolved from the state directory the
 * same way the CLI resolves it — `ALLOWANCE_STATE_DIR` (default `.allowance`),
 * live vs practice from `mode.json`, the payer key from `AGENT_PRIVATE_KEY`.
 */
import { runMcpStdio } from "./mcp.ts";

runMcpStdio().catch((e) => {
  console.error(`wallie-mcp failed to start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
