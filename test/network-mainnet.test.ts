import { test } from "node:test";
import assert from "node:assert/strict";
import { isMainnet, mainnetName, family } from "../src/live.ts";

test("isMainnet is true for Base and Solana mainnet, by bare name and CAIP-2", () => {
  assert.equal(isMainnet("base"), true);
  assert.equal(isMainnet("eip155:8453"), true);
  assert.equal(isMainnet("solana"), true);
  assert.equal(isMainnet("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), true);
});

test("isMainnet is false for testnets, by bare name and CAIP-2", () => {
  assert.equal(isMainnet("base-sepolia"), false);
  assert.equal(isMainnet("eip155:84532"), false);
  assert.equal(isMainnet("solana-devnet"), false);
  assert.equal(isMainnet("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"), false);
});

test("isMainnet is false for unknown and mock networks", () => {
  assert.equal(isMainnet("mock-ledger"), false);
  assert.equal(isMainnet("not-a-network"), false);
  assert.equal(isMainnet(""), false);
});

test("mainnetName gives the canonical bare name for the confirm prompt", () => {
  assert.equal(mainnetName("base"), "base");
  assert.equal(mainnetName("eip155:8453"), "base");
  assert.equal(mainnetName("solana"), "solana");
  assert.equal(mainnetName("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), "solana");
});

test("family agrees on the rail for every spelling isMainnet accepts", () => {
  assert.equal(family("eip155:8453"), "evm");
  assert.equal(family("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), "solana");
});
