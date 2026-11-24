import fs from "node:fs";
import path from "node:path";

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
