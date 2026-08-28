import fs from "node:fs";
import path from "node:path";

/**
 * A small mutex used to make "read the ledger → decide → reserve" atomic.
 *
 * Two layers, because both kinds of concurrency are real:
 *   - in-process: agents fan out with `Promise.all`, so the same runtime races itself
 *   - cross-process: the CLI, the dashboard and the agent all touch one state dir
 *
 * The cross-process layer uses `mkdir`, which is atomic on every platform we
 * target. A lock older than `staleMs` is assumed to belong to a crashed process
 * and is broken, so a hard kill can never wedge an agent's allowance forever.
 */

const chains = new Map<string, Promise<unknown>>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LockOptions {
  /** Give up waiting after this long and throw. */
  timeoutMs?: number;
  /** Treat a lock held longer than this as abandoned. */
  staleMs?: number;
}

async function acquire(dir: string, opts: Required<LockOptions>): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        const age = Date.now() - fs.statSync(dir).mtimeMs;
        if (age > opts.staleMs) {
          fs.rmSync(dir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // vanished between statting and now — retry immediately
      }
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for the allowance lock at ${dir} (another process may be stuck)`);
      await sleep(2 + Math.floor(Math.random() * 6));
    }
  }
}

/** Runs `fn` with exclusive access to `lockPath`, in-process and across processes. */
export function withLock<T>(lockPath: string, fn: () => T | Promise<T>, options: LockOptions = {}): Promise<T> {
  const opts = { timeoutMs: options.timeoutMs ?? 10_000, staleMs: options.staleMs ?? 30_000 };
  const previous = chains.get(lockPath) ?? Promise.resolve();
  const run = previous.then(async () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    await acquire(lockPath, opts);
    try {
      return await fn();
    } finally {
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
  });
  // Keep the in-process chain alive even if this caller rejects.
  chains.set(
    lockPath,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
