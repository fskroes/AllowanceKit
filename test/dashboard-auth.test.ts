import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDashboard } from "../src/dashboard-server.ts";
import { createAgent, topUp, listAgents } from "../src/wallet.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "allowance-dash-"));
}

/** Bring the dashboard up on a loopback ephemeral port and hand back the token the page would have. */
async function serve(stateDir: string): Promise<{ base: string; token: string; close(): Promise<void> }> {
  const primary = createAgent(stateDir);
  const { server, token } = await startDashboard(primary, 0);
  const { port } = server.address() as { port: number };
  // The served page reads the control token out of the state dir — read it the same way.
  const onDisk = fs.readFileSync(path.join(stateDir, "dashboard-token"), "utf8").trim();
  assert.equal(onDisk, token, "the injected token is the one written under the state dir");
  return {
    base: `http://127.0.0.1:${port}`,
    token,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("an unauthenticated GET /api/state is rejected with 401", async () => {
  const dir = tmpDir();
  const s = await serve(dir);
  try {
    const res = await fetch(`${s.base}/api/state`);
    assert.equal(res.status, 401, "reads are gated by the same token as mutations");
    const body = (await res.json()) as { ok?: boolean };
    assert.equal(body.ok, false);

    // A wrong token is no better than none.
    const wrong = await fetch(`${s.base}/api/state`, { headers: { "x-allowance-token": "not-the-token" } });
    assert.equal(wrong.status, 401);
  } finally {
    await s.close();
  }
});

test("an authenticated GET /api/state returns 200 and every agent in the directory", async () => {
  const dir = tmpDir();
  // Two distinct agents share the one state directory; each leaves a ledger row
  // so `listAgents` can see it.
  const primary = createAgent(dir);
  const second = createAgent(dir, "second-agent");
  topUp(primary, 20);
  topUp(second, 5);

  const roster = listAgents(dir);
  assert.ok(roster.includes(primary.agentName) && roster.includes("second-agent"), "listAgents sees both");
  assert.ok(roster.length >= 2, "the directory holds more than one agent");

  const { server, token } = await startDashboard(primary, 0);
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { "x-allowance-token": token } });
    assert.equal(res.status, 200, "the right token gets in");
    const state = (await res.json()) as {
      selected: string;
      agents: string[];
      states: Record<string, { agent: string; topupsMicro: string }>;
    };

    // The switcher is fed straight from listAgents.
    assert.deepEqual([...state.agents].sort(), [...roster].sort(), "state lists exactly the directory's agents");
    assert.equal(state.selected, primary.agentName, "it defaults to the agent the dashboard was started for");

    // Every agent carries its own slice, keyed by name.
    for (const name of roster) {
      assert.ok(state.states[name], `state includes ${name}`);
      assert.equal(state.states[name].agent, name);
    }
    // And the slices are genuinely per-agent, not the same numbers repeated.
    assert.equal(state.states[primary.agentName].topupsMicro, (20_000_000).toString());
    assert.equal(state.states["second-agent"].topupsMicro, (5_000_000).toString());
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
