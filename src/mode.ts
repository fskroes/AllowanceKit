import fs from "node:fs";
import path from "node:path";

export type SettlementMode = "practice" | "live";

export interface ModeInfo {
  mode: SettlementMode;
  network?: string;
  address?: string;
  rpcUrl?: string;
  at?: string;
}

const FILE = "mode.json";

export const PRACTICE_BANNER = "Practice money — this is a local simulated ledger, no real money can move";

export function readMode(stateDir: string): ModeInfo {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, FILE), "utf8")) as Partial<ModeInfo>;
    if (raw.mode === "live") return { ...raw, mode: "live" };
  } catch {
  }
  return { mode: "practice" };
}

export function writeMode(stateDir: string, info: ModeInfo): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const existing = readMode(stateDir);
  const next: ModeInfo = { ...info, at: existing.at ?? new Date().toISOString() };
  fs.writeFileSync(path.join(stateDir, FILE), JSON.stringify(next, null, 2));
}

export function describeMode(info: ModeInfo): string {
  if (info.mode !== "live") return PRACTICE_BANNER;
  return `REAL MONEY — payments settle in USDC on ${info.network ?? "a live network"}`;
}

export function describeTopUp(info: ModeInfo): string {
  if (info.mode !== "live")
    return "Practice money — the allowance and the simulated balance both went up, nothing real moved";
  return (
    "REAL MONEY — this raised the ceiling only. No USDC was transferred: " +
    "send USDC to the agent's wallet yourself, then check it with `status`."
  );
}
