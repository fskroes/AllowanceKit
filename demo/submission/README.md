# Submission media

`story.json` contains the six-scene pitch and ten-scene walkthrough. `build.ts`
renders the scenes, captures the actual MCP demo output, adds narration (a human
recording per scene when present, otherwise a local `say` fallback), and produces
MP4 videos, captions, transcripts, posters, and provenance metadata. No hosted
LLM or speech API is used at any step.

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

## Narrate in your own voice

The default `say` fallback is robotic. Record the narration yourself instead. It
stays fully local: the browser captures your microphone, the builder cleans each
take with FFmpeg (mono, 80 Hz high-pass, `loudnorm` to −16 LUFS), and no audio
ever leaves the machine.

1. Serve the teleprompter over http (a browser will not read `story.json` from a
   `file://` path):

   ```bash
   cd demo/submission && python3 -m http.server 8765
   ```

   Open `http://localhost:8765/teleprompter.html`.

2. For each scene: press **Record** (or `R`), read the line at a steady pace, and
   **Stop**. Aim for 22–28 s; the timer turns amber past 28 s and red past 30 s
   (each scene slot is a hard 30 s). Re-record until it feels natural.

3. **Download** each take. The file is already named for the builder
   (`pitch-01.webm`, `pitch-02.webm`, … `walkthrough-10.webm`). Move them into
   `demo/submission/voice/`. Accepted extensions: `.webm .ogg .m4a .mp4 .wav
   .aiff .mp3 .caf .flac`.

4. Rebuild. `build.ts` uses `voice/<scene>.<ext>` when it exists and falls back to
   `say` for any scene you did not record, so you can rebuild after each scene:

   ```bash
   npm run demo:mcp > /tmp/mcp-transcript.txt
   node demo/submission/build.ts \
     --output-dir /tmp/wallie-media \
     --playwright-module "$PLAYWRIGHT_MODULE" \
     --browser "$CHROME_EXECUTABLE" \
     --demo-transcript /tmp/mcp-transcript.txt \
     --devnet-proof /tmp/devnet-settlement.json \
     --voice-dir demo/submission/voice
   ```

   `build-manifest.json` records how many scenes used a real recording versus the
   `say` fallback. `voice/` is git-ignored; recordings are not committed.

Recording tips: use a quiet room, keep the mic a hand's width away and off-axis to
avoid plosives, and leave a beat of silence at the start and end of each take.

## Ship the rebuilt media

The website serves the outputs under `/media/`, which `vercel.json` in
`onewallie-site` rewrites to the GitHub release
`fskroes/AllowanceKit@v0.6.0`. Replacing the videos judges see means uploading the
new `pitch.mp4` / `walkthrough.mp4` (and `.vtt` / poster / transcript) to that
release, not only deploying the site. MP4s and other generated media are
deployment artifacts and must not be committed to this repository. The submission
page is maintained in the adjacent `onewallie-site` repository.
