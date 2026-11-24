import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as kit from "../src/index.ts";

if (typeof kit.createMcpServer !== "function") throw new Error("createMcpServer not exported");
if (typeof kit.runMcpStdio !== "function") throw new Error("runMcpStdio not exported");

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "no-mcp-"));
const agent = kit.createAgent(stateDir);
kit.topUp(agent, 1);
if (kit.allowanceRemaining(agent) <= 0n) throw new Error("allowance not funded");
agent.stopHeartbeat?.();
try {
  fs.rmSync(stateDir, { recursive: true, force: true });
} catch {}
process.exit(0);
