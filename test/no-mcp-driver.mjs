// Imports the allowance-kit root entry and uses the core buyer runtime WITHOUT
// touching the MCP surface. The `@modelcontextprotocol/sdk` is a lazily-imported
// optional peer, so a plain SDK consumer must never resolve it. This driver runs
// under the resolve hook; the test asserts the hook never saw the SDK specifier.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as kit from "../src/index.ts";

// Touch the MCP re-exports so a static top-level SDK import (if one existed)
// would have been resolved by now — the point is that it is NOT.
if (typeof kit.createMcpServer !== "function") throw new Error("createMcpServer not exported");
if (typeof kit.runMcpStdio !== "function") throw new Error("runMcpStdio not exported");

// Exercise the core buyer path the way a normal consumer does.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "no-mcp-"));
const agent = kit.createAgent(stateDir);
kit.topUp(agent, 1);
if (kit.allowanceRemaining(agent) <= 0n) throw new Error("allowance not funded");
agent.stopHeartbeat?.();
try {
  fs.rmSync(stateDir, { recursive: true, force: true });
} catch {}
process.exit(0);
