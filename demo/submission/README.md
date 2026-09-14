# Submission media

`story.json` contains the six-scene pitch and ten-scene walkthrough. `build.ts`
renders the scenes, captures the actual MCP demo output, synthesizes generic
computer narration locally, and produces MP4 videos, captions, transcripts,
posters, and provenance metadata.

Requirements: Node 24+, macOS `say`, FFmpeg/FFprobe, Playwright, and a Chrome or
Chromium executable. Pass tool and output paths to the builder rather than
storing machine-specific paths in the source. Run `node demo/submission/build.ts
--help` for the supported arguments.

```bash
npm run demo:mcp > /tmp/mcp-transcript.txt
node demo/submission/build.ts \
  --output-dir /tmp/wallie-media \
  --playwright-module "$PLAYWRIGHT_MODULE" \
  --browser "$CHROME_EXECUTABLE" \
  --demo-transcript /tmp/mcp-transcript.txt \
  --devnet-proof /tmp/devnet-settlement.json
```

Set `PLAYWRIGHT_MODULE` to the installed Playwright `index.mjs` and
`CHROME_EXECUTABLE` to the browser executable. The devnet proof is the finalized
JSON response from Solana's `getTransaction` for the signature in the recorded
canary, requested with `encoding: "jsonParsed"` and
`maxSupportedTransactionVersion: 0`. The builder validates the recorded slot,
transfer amounts, and buyer refund before rendering.

The pitch is 180 seconds and the walkthrough is 300 seconds. They distinguish the
local practice exact purchase, the offline Solana channel simulation, and the
separate public devnet transaction. Never substitute invented terminal output or
an abbreviated example signature for the public proof.

The website serves the outputs under `/media/`. MP4s and other generated media
are deployment artifacts and must not be committed to this repository. The
submission page is maintained in the adjacent `onewallie-site` repository.
