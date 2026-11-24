#!/usr/bin/env node
import { runMcpStdio } from "./mcp.ts";

runMcpStdio().catch((e) => {
  console.error(`wallie-mcp failed to start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
