import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Replace a state snapshot without exposing a partial JSON document to readers. */
export function writeStateFile(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    const directory = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
