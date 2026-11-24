import fs from "node:fs";
import path from "node:path";

const chains = new Map<string, Promise<unknown>>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LockOptions {
  timeoutMs?: number;
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
        continue;
      }
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for the allowance lock at ${dir} (another process may be stuck)`);
      await sleep(2 + Math.floor(Math.random() * 6));
    }
  }
}

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
  chains.set(
    lockPath,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
