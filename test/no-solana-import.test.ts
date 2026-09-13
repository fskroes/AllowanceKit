import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// EVM regression / isolation: a Base agent that builds and signs a payment must
// never load the Solana libraries. A child process runs the Base flow under a
// resolve hook that records every resolved specifier; we then assert the hook
// saw `viem/accounts` (proof the EVM signing path ran) but never `@solana/kit`
// or `@x402/svm`. See docs/SOLANA-ARCHITECTURE.md §0, §7.
test("a Base createLiveAgent + encode never resolves @solana/kit or @x402/svm", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "resolve-log-")), "specifiers.txt");

  const child = spawnSync(
    process.execPath,
    ["--import", path.join(here, "no-solana-register.mjs"), path.join(here, "no-solana-driver.mjs")],
    { env: { ...process.env, RESOLVE_LOG: logFile }, encoding: "utf8" },
  );

  assert.equal(child.status, 0, `Base driver failed:\n${child.stderr}`);

  const resolved = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean);
  assert.ok(resolved.length > 0, "the resolve hook recorded nothing");

  // The hook works and the EVM signing path ran.
  assert.ok(
    resolved.some((s) => s === "viem/accounts" || s.startsWith("viem")),
    "expected the Base flow to resolve viem — the resolve hook may not be wired",
  );

  const solana = resolved.filter((s) => s.includes("@solana/kit") || s.includes("@x402/svm") || s.includes("@solana-program"));
  assert.deepEqual(solana, [], `a Base flow resolved Solana libraries: ${solana.join(", ")}`);
});
