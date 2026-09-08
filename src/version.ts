import fs from "node:fs";
import path from "node:path";

/**
 * The package version — the same value `--version` prints — resolved once from
 * `package.json`. Used by the cloud heartbeat (C-10) so the control plane can
 * show which runtime an agent is on, and by the CLI's `--version`.
 *
 * Works whether the code runs from `src/` (sources, `../package.json`) or the
 * published `dist/` (`../../package.json`), matching the CLI's original lookup.
 */
let cached: string | null = null;

export function runtimeVersion(): string {
  if (cached !== null) return cached;
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const file = path.join(import.meta.dirname ?? ".", rel);
      cached = (JSON.parse(fs.readFileSync(file, "utf8")) as { version: string }).version;
      return cached;
    } catch {}
  }
  cached = "unknown";
  return cached;
}
