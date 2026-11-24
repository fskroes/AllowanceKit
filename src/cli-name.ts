import path from "node:path";

const BIN_NAMES = new Set(["wallie", "allowance", "allowance-kit"]);

function invokedAs(): string {
  const argv1 = process.argv[1];
  if (!argv1) return "allowance-kit";
  const base = path.basename(argv1).replace(/\.[cm]?js$/, "");
  return BIN_NAMES.has(base) ? base : "allowance-kit";
}

export const NAME = invokedAs();

export const CLI = `npx ${NAME}`;
