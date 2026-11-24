#!/usr/bin/env node
import { runMcpStdio } from "allowance-kit/mcp";

runMcpStdio().catch((e) => {
  console.error(`wallie-mcp failed to start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
