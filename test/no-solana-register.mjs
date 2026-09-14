// Registers the resolve hook before the driver module loads, so every
// resolution the Base flow triggers passes through it.
import { register } from "node:module";

register("./no-solana-hook.mjs", import.meta.url);
