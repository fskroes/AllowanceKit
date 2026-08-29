import fs from "node:fs";
import path from "node:path";

/**
 * Which rail a state directory settles on, recorded where every reader can see
 * it.
 *
 * The CLI, the dashboard and the SDK all operate on a directory, not on a
 * runtime, so "is this practice money?" cannot be answered from the object in
 * hand — a live agent and the CLI share one directory and only the live agent
 * knows a private key. Writing the answer down is what stops `topup` from
 * printing "no real money can move" over an allowance that governs real USDC.
 */

export type SettlementMode = "practice" | "live";

export interface ModeInfo {
  mode: SettlementMode;
  /** Live only: the chain payments are signed for. */
  network?: string;
  /** Live only: the payer address derived from the private key. */
  address?: string;
  /** Live only: JSON-RPC endpoint used to read the wallet's real USDC balance. */
  rpcUrl?: string;
  /** When this directory was first marked. */
  at?: string;
}

const FILE = "mode.json";

export const PRACTICE_BANNER = "Practice money — this is a local simulated ledger, no real money can move";

export function readMode(stateDir: string): ModeInfo {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, FILE), "utf8")) as Partial<ModeInfo>;
    if (raw.mode === "live") return { ...raw, mode: "live" };
  } catch {
    // No marker, or one that no longer parses. Practice is the safe reading:
    // it never claims real money is at stake when it is not.
  }
  return { mode: "practice" };
}

export function writeMode(stateDir: string, info: ModeInfo): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const existing = readMode(stateDir);
  const next: ModeInfo = { ...info, at: existing.at ?? new Date().toISOString() };
  fs.writeFileSync(path.join(stateDir, FILE), JSON.stringify(next, null, 2));
}

/** One line telling a human exactly what their limits are made of. */
export function describeMode(info: ModeInfo): string {
  if (info.mode !== "live") return PRACTICE_BANNER;
  return `REAL MONEY — payments settle in USDC on ${info.network ?? "a live network"}`;
}

/** What `topup` actually did, which differs by rail. */
export function describeTopUp(info: ModeInfo): string {
  if (info.mode !== "live")
    return "Practice money — the allowance and the simulated balance both went up, nothing real moved";
  return (
    "REAL MONEY — this raised the ceiling only. No USDC was transferred: " +
    "send USDC to the agent's wallet yourself, then check it with `status`."
  );
}
