// A module-resolution hook that records every specifier the loader resolves.
// Runs on the dedicated hooks thread, so it reports what was resolved by
// writing to the file named in RESOLVE_LOG rather than to shared memory.
import { appendFileSync } from "node:fs";

const LOG = process.env.RESOLVE_LOG;

export async function resolve(specifier, context, nextResolve) {
  if (LOG) {
    try {
      appendFileSync(LOG, specifier + "\n");
    } catch {}
  }
  return nextResolve(specifier, context);
}
