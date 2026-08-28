import path from "node:path";

/**
 * The name this process was invoked under.
 *
 * Wallie ships under two npm names — `allowance-kit` and its `wallie` alias —
 * and the alias imports the CLI in-process rather than spawning it, so
 * `argv[1]` is whichever bin the user actually ran. Every hint we print back
 * uses this, so it is always a command they can paste.
 *
 * A basename we do not publish falls back to the canonical name. That covers
 * both `node dist/cli.js` (which would otherwise print `npx cli`) and the SDK,
 * where `argv[1]` is the caller's own script and the honest answer is the
 * package name.
 */
const BIN_NAMES = new Set(["wallie", "allowance", "allowance-kit"]);

function invokedAs(): string {
  const argv1 = process.argv[1];
  if (!argv1) return "allowance-kit";
  const base = path.basename(argv1).replace(/\.[cm]?js$/, "");
  return BIN_NAMES.has(base) ? base : "allowance-kit";
}

/** Bare name: `wallie` or `allowance-kit`. */
export const NAME = invokedAs();

/** Runnable prefix: `npx wallie` or `npx allowance-kit`. */
export const CLI = `npx ${NAME}`;
