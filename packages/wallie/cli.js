#!/usr/bin/env node
// Wallie's CLI is allowance-kit's CLI, imported in-process (not spawned) so that
// `src/cli-name.ts` reads `argv[1]` as `wallie` and every hint it prints back
// says `npx wallie`. The `allowance-kit/cli` subpath export points at the
// compiled dist/cli.js, whose top-level `main()` runs on import.
import "allowance-kit/cli";
