/** Exercise the actual npm tarballs in a fresh consumer, including MCP over stdio. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "wallie-release-")));
fs.mkdirSync(output, { recursive: true });
const consumer = fs.mkdtempSync(path.join(os.tmpdir(), "wallie-consumer-"));
const cache = path.join(output, "npm-cache");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const wrapper = JSON.parse(fs.readFileSync(path.join(root, "packages/wallie-mcp/package.json"), "utf8"));
const alias = JSON.parse(fs.readFileSync(path.join(root, "packages/wallie/package.json"), "utf8"));
assert.equal(wrapper.version, manifest.version, "release packages must have the same version");
assert.equal(wrapper.dependencies[manifest.name], `^${manifest.version}`, "MCP must depend on this release");
assert.equal(alias.version, manifest.version, "CLI alias must have the same version");
assert.equal(alias.dependencies[manifest.name], `^${manifest.version}`, "CLI alias must depend on this release");

function run(command: string, args: string[], cwd: string, timeout = 180_000): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error?.message ?? result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

run("npm", ["run", "build"], root);
for (const folder of [root, path.join(root, "packages/wallie"), path.join(root, "packages/wallie-mcp")]) {
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", output, "--cache", cache], folder);
}
fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
const tarballs = [`allowance-kit-${manifest.version}.tgz`, `wallie-${manifest.version}.tgz`, `wallie-mcp-${manifest.version}.tgz`];
run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", cache,
  ...tarballs.map((name) => path.join(output, name))], consumer);

// Run the consumer's installed code, rather than resolving any source-tree dependency.
fs.writeFileSync(path.join(consumer, "check.mjs"), `
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createAgent, topUp, payingFetch } from 'allowance-kit';
import { createMcpServer } from 'allowance-kit/mcp';
import { createMcpServer as wrapped } from 'wallie-mcp';
assert.equal(typeof payingFetch, 'function');
assert.equal(typeof createMcpServer, 'function');
assert.equal(typeof wrapped, 'function');
await import('@solana/kit');
await import('@solana-program/token');
await import('@x402/svm/upto/facilitator');
await import('viem');
const agent = createAgent(path.resolve('sdk-state'));
topUp(agent, 1);
const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
  typeof value === 'string' && !/KEY|TOKEN|SECRET|ALLOWANCE|WALLIE|CDP|NOTIFY|WEBHOOK/i.test(key)));
env.ALLOWANCE_STATE_DIR = path.resolve('mcp-state');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve('node_modules/wallie-mcp/bin.js')],
  env,
  stderr: 'pipe',
});
const client = new Client({ name: 'release-consumer-check', version: '1' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  for (const name of ['pay_fetch', 'get_budget', 'list_channels', 'decide_approval', 'reclaim_channel'])
    assert(tools.some(tool => tool.name === name), 'missing installed MCP tool ' + name);
  const budget = await client.callTool({ name: 'get_budget', arguments: {} });
  assert.notEqual(budget.isError, true, 'installed MCP get_budget failed');
  const channels = await client.callTool({ name: 'list_channels', arguments: {} });
  assert.notEqual(channels.isError, true, 'installed MCP list_channels failed');
  console.log('PASS: installed SDK exports, chain libraries, MCP stdio discovery, budget and channels');
} finally {
  await client.close();
  await transport.close();
}
`);
const consumerResult = run(process.execPath, ["check.mjs"], consumer, 30_000).trim();
const aliasVersion = run(process.execPath, [path.join(consumer, "node_modules/wallie/cli.js"), "--version"], consumer, 10_000);
assert(aliasVersion.includes(manifest.version), "installed wallie alias must resolve the matching runtime version");
const demo = run(process.execPath, [path.join(consumer, "node_modules/allowance-kit/dist/cli.js"), "demo"], consumer, 60_000);
assert.match(demo, /BLOCKED/, "installed CLI demo must exercise a spending block");
const report = {
  version: manifest.version,
  checkedAt: new Date().toISOString(),
  node: process.version,
  consumer,
  tarballs: tarballs.map((name) => path.join(output, name)),
  checks: [consumerResult, "PASS: installed CLI alias version", "PASS: installed CLI practice demo"],
};
fs.writeFileSync(path.join(output, "release-verification.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
