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
