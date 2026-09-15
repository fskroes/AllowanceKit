#!/usr/bin/env node
/** Build narrated, reproducible submission videos without a hosted media API. */
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";

const execFile = promisify(execFileCallback);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const SCENE_SECONDS = 30;
const VOICE_RATE = 155;

type Scene = { eyebrow: string; title: string; subtitle: string; visual: string; narration: string };
type Story = { pitch: Scene[]; walkthrough: Scene[] };
type DevnetEvidence = { signature: string; slot: number; sellerMicro: string; refundMicro: string; buyerRefundMicro: string };

function options(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--") || !argv[i + 1]) throw new Error(`Expected --name value, got ${argv[i] ?? "end of arguments"}`);
    result[argv[i].slice(2)] = argv[++i];
  }
  return result;
}

function need(opts: Record<string, string>, key: string): string {
  if (!opts[key]) throw new Error(`Missing required argument --${key}`);
  return path.resolve(opts[key]);
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function run(command: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
  try {
    const { stdout, stderr } = await execFile(command, args, { maxBuffer });
    if (stderr.trim()) process.stderr.write(stderr);
    return stdout.trim();
  } catch (error) {
    const e = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    throw new Error(`${command} ${args.join(" ")} failed (${e.code ?? "error"}): ${e.stderr || e.message}`);
  }
}

function parseDevnetProof(input: unknown): DevnetEvidence {
  const root = input as any;
  const result = root?.result ?? root;
  const signature = result?.transaction?.signatures?.[0];
  const slot = Number(result?.slot);
  if (slot !== 498210157) throw new Error(`Expected recorded devnet slot 498210157, received ${slot}`);
  if (!signature || result?.meta?.err !== null) throw new Error("Devnet proof needs a signature and meta.err=null");

  const transfers: string[] = [];
  const visit = (value: any): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    if (value.type === "transferChecked") {
      const amount = value.info?.tokenAmount?.amount;
      if (amount !== undefined) transfers.push(String(amount));
    }
    if (value.parsed?.info?.instructions) visit(value.parsed.info.instructions);
    if (value.instructions) visit(value.instructions);
  };
  visit(result?.meta?.innerInstructions ?? []);
  if (!transfers.includes("30000") || !transfers.includes("70000")) {
    throw new Error(`Devnet proof must show 30000 and 70000 micro unit transfers, received ${transfers.join(",")}`);
  }
  const buyer = "47bZuXM3Pq3DXxyQ9bDmYZvQeENxTScLBhQiV1nLJ2LU";
  const balance = (rows: any[], owner: string) => rows?.find((row) => row.owner === owner)?.uiTokenAmount?.amount;
  const before = balance(result.meta.preTokenBalances, buyer);
  const after = balance(result.meta.postTokenBalances, buyer);
  if (before !== "19840000" || after !== "19910000") throw new Error("Devnet buyer balance delta does not match the recorded 0.07 USDC refund");
  return { signature, slot, sellerMicro: "30000", refundMicro: "70000", buyerRefundMicro: "70000" };
}

function transcriptParts(raw: string) {
  const lines = raw.split(/\r?\n/);
  const capture = (start: string, end?: string) => {
    const from = lines.findIndex((line) => line.includes(start));
    if (from < 0) throw new Error(`Captured MCP transcript is missing required section: ${start}`);
    let to = end ? lines.findIndex((line, i) => i > from && line.includes(end)) : -1;
    if (end && to < 0) throw new Error(`Captured MCP transcript section ${start} is missing end marker: ${end}`);
    if (to < 0) to = lines.length;
    const excerpt = lines.slice(from, to).join("\n").trim();
    if (!excerpt) throw new Error(`Captured MCP transcript section is empty: ${start}`);
    return excerpt;
  };
  const toolLine = lines.find((line) => line.includes("tools/list →"));
  if (!toolLine) throw new Error("Captured MCP transcript is missing the tools/list result");
  const toolNames = toolLine.split("→")[1]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  if (!toolNames.length) throw new Error("Captured MCP transcript has an empty tools/list result");
  const paymentLine = lines.find((line) => line.includes("PAID") && line.includes("refunded $0.070000"));
  if (!paymentLine) throw new Error("Captured MCP transcript is missing the actual $0.030000 paid and $0.070000 refunded result");
  const exactExcerpt = capture("Buy weather data", "Try the enterprise feed");
  const blockExcerpt = capture("Try the enterprise feed", "get_budget()");
  const uptoExcerpt = capture("Phase 2 — Solana devnet", "Read 30 metered rows");
  const refundExcerpt = capture("Read 30 metered rows", "list_channels()");
  if (!exactExcerpt.includes("PAID") || !blockExcerpt.includes("BLOCKED") || !refundExcerpt.includes("refunded $0.070000")) {
    throw new Error("Captured MCP transcript does not contain the required exact, blocked, and refunded outcomes");
  }
  return {
    toolNames,
    toolLines: paymentLine.trim(),
    exactExcerpt,
    blockExcerpt,
    uptoExcerpt,
    refundExcerpt,
  };
}

function sentenceCues(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]+(?:[”\"])?|[^.!?]+$/g) ?? [text]).map((s) => s.trim()).filter(Boolean);
}

function stamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(r).padStart(3, "0")}`;
}

function makeVtt(scenes: Scene[], durations: number[]): string {
  const cues: string[] = ["WEBVTT", ""];
  let offset = 0;
  scenes.forEach((scene, index) => {
    const sentences = sentenceCues(scene.narration);
    const totalWords = sentences.reduce((sum, sentence) => sum + sentence.split(/\s+/).length, 0);
    let cursor = offset;
    const speech = durations[index];
    sentences.forEach((sentence, sentenceIndex) => {
      const wordCount = sentence.split(/\s+/).length;
      const cueDuration = speech * (wordCount / totalWords);
      cues.push(`${stamp(cursor)} --> ${stamp(cursor + cueDuration)}`);
      cues.push(sentence);
      cues.push("");
      cursor += cueDuration;
      if (sentenceIndex < sentences.length - 1) cursor += Math.min(0.16, cueDuration * 0.01);
    });
    offset += SCENE_SECONDS;
  });
  return cues.join("\n");
}

function transcript(scenes: Scene[]): string {
  return scenes.map((scene, index) => `${String(index + 1).padStart(2, "0")}  ${scene.eyebrow}\n${scene.title}\n\n${scene.narration}`).join("\n\n---\n\n") + "\n";
}

function concatFilePath(file: string): string {
  return file.replace(/'/g, "'\\''");
}

const RECORDED_EXTENSIONS = [".m4a", ".wav", ".aiff", ".aif", ".mp3", ".caf", ".flac", ".webm", ".ogg", ".mp4"];

async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const file of candidates) {
    try {
      await fs.access(file);
      return file;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// Mastering chain applied to a human recording before loudness normalization.
// Order matters: strip rumble and boxiness, then even out the dynamics with a
// gentle compressor so the loudness stage never has to slam loud syllables. The
// first cut sent raw phone audio (crest factor ~12) straight into a single-pass
// dynamic loudnorm, which pumped and clipped the loud words and lifted the room
// tone into a hollow sound.
const RECORDED_PRE_FILTER = [
  "highpass=f=90",                    // remove sub-bass rumble and handling noise
  "equalizer=f=300:t=q:w=1.4:g=-3",   // cut boxy low-mid so the voice is less hollow
  "equalizer=f=4200:t=q:w=2:g=2.5",   // gentle presence lift for intelligibility
  "acompressor=threshold=-21dB:ratio=3:attack=6:release=140:makeup=3:knee=6",
].join(",");
const LOUDNORM_TARGET = "I=-16:TP=-2.0:LRA=11";

const TARGET_LUFS = -16;

/** Measure the filtered source integrated loudness (LUFS) with ffmpeg loudnorm pass one. */
async function measureLoudness(recorded: string): Promise<number> {
  const { stderr } = await execFile("ffmpeg", [
    "-y", "-hide_banner", "-i", recorded, "-ac", "1", "-ar", "48000",
    "-af", `${RECORDED_PRE_FILTER},loudnorm=${LOUDNORM_TARGET}:print_format=json`,
    "-f", "null", "-",
  ], { maxBuffer: 8 * 1024 * 1024 });
  const match = stderr.match(/"input_i"\s*:\s*"(-?\d+(?:\.\d+)?)"/);
  if (!match) throw new Error("loudnorm measurement did not return an integrated loudness value");
  return Number(match[1]);
}

/**
 * Produce one scene's narration aiff. A human recording named `<base>.<ext>` in
 * voiceDir wins; otherwise fall back to local macOS `say`. A recording is
 * mastered in place with ffmpeg (mono 48 kHz, high-pass, de-box EQ, compression,
 * a single static gain to the target loudness, then a look-ahead true-peak
 * limiter). The pipeline stays fully local and never touches a hosted speech API.
 *
 * The first cut used a single-pass dynamic loudnorm, whose time-varying gain
 * pumped and clipped the loud words and lifted the room tone into a hollow sound.
 * The compressor now evens the dynamics, one measured static gain sets the
 * loudness (no time-varying gain, so no pumping), and the limiter alone holds the
 * -2 dBTP ceiling, catching only the few isolated peaks (<1.8 dB here).
 */
async function narrate(args: { voiceDir: string; base: string; narration: string; voice: string; out: string }): Promise<"recorded" | "say"> {
  const { voiceDir, base, narration, voice, out } = args;
  const recorded = await firstExisting(RECORDED_EXTENSIONS.map((ext) => path.join(voiceDir, base + ext)));
  if (recorded) {
    const gainDb = (TARGET_LUFS - (await measureLoudness(recorded))).toFixed(2);
    await run("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error", "-i", recorded,
      "-ac", "1", "-ar", "48000",
      "-af", `${RECORDED_PRE_FILTER},volume=${gainDb}dB,alimiter=limit=0.794:level=false`, out,
    ]);
    return "recorded";
  }
  await run("say", ["-v", voice, "-r", String(VOICE_RATE), "-o", out, "--", narration]);
  return "say";
}

async function probeDuration(file: string): Promise<number> {
  const raw = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file]);
  return Number(raw);
}

async function renderSet(args: {
  name: "pitch" | "walkthrough";
  scenes: Scene[];
  targetDuration: number;
  outDir: string;
  tmpDir: string;
  page: any;
  template: string;
  css: string;
  evidence: Record<string, any>;
  voice: string;
  voiceDir: string;
}) {
  const { name, scenes, targetDuration, outDir, tmpDir, page, template, css, evidence, voice, voiceDir } = args;
  if (scenes.length * SCENE_SECONDS !== targetDuration) throw new Error(`${name} scene count does not match its ${targetDuration}s target`);
  const clips: string[] = [];
  const speechDurations: number[] = [];
  let recordedScenes = 0;

  for (const [index, scene] of scenes.entries()) {
    const base = `${name}-${String(index + 1).padStart(2, "0")}`;
    const frame = path.join(tmpDir, `${base}.png`);
    const audio = path.join(tmpDir, `${base}.aiff`);
    const clip = path.join(tmpDir, `${base}.mp4`);
    await page.setContent(template.replace("{{STYLES}}", css), { waitUntil: "load" });
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.evaluate(({ sceneData, evidenceData }) => (window as any).renderScene(sceneData, evidenceData), { sceneData: scene, evidenceData: evidence });
    await page.screenshot({ path: frame, type: "png" });

    const source = await narrate({ voiceDir, base, narration: scene.narration, voice, out: audio });
    if (source === "recorded") recordedScenes += 1;
    const rawSpeechDuration = await probeDuration(audio);
    const tempo = rawSpeechDuration > 28.2 ? rawSpeechDuration / 28.2 : 1;
    if (tempo > 1.22) throw new Error(`${name} scene ${index + 1} narration needs atempo ${tempo.toFixed(2)}; shorten its story text`);
    speechDurations.push(rawSpeechDuration / tempo);

    const videoFilter = `[0:v]zoompan=z='min(zoom+0.000018,1.018)':d=${FPS * SCENE_SECONDS}:s=${WIDTH}x${HEIGHT}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':fps=${FPS},format=yuv420p,setpts=PTS-STARTPTS[v]`;
    // Leave a tiny silent AAC tail so its packet rounding cannot extend the MP4
    // beyond the exact 30 second video track at each scene boundary.
    const audioFilter = `[1:a]atempo=${tempo.toFixed(5)},apad=whole_dur=${SCENE_SECONDS},atrim=duration=${SCENE_SECONDS - 0.06},asetpts=PTS-STARTPTS[a]`;
    await run("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-framerate", String(FPS), "-i", frame, "-i", audio,
      "-filter_complex", `${videoFilter};${audioFilter}`, "-map", "[v]", "-map", "[a]", "-frames:v", String(FPS * SCENE_SECONDS), "-t", String(SCENE_SECONDS),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS), "-bf", "0",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", clip,
    ]);
    clips.push(clip);
    if (index === 0) await fs.copyFile(frame, path.join(outDir, `${name}-poster.png`));
    process.stdout.write(`${name}: rendered scene ${index + 1}/${scenes.length} (${source} narration)\n`);
  }

  const listPath = path.join(tmpDir, `${name}-concat.txt`);
  await fs.writeFile(listPath, clips.map((file) => `file '${concatFilePath(file)}'`).join("\n") + "\n");
  const videoPath = path.join(outDir, `${name}.mp4`);
  const audioVideoFilter = `[0:v]setpts=PTS-STARTPTS,fps=${FPS},format=yuv420p[v];[0:a]asetpts=PTS-STARTPTS,apad=whole_dur=${targetDuration},atrim=duration=${targetDuration}[a]`;
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath,
    "-filter_complex", audioVideoFilter, "-map", "[v]", "-map", "[a]", "-frames:v", String(targetDuration * FPS), "-t", String(targetDuration),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS), "-bf", "0",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", videoPath,
  ]);
  const captions = makeVtt(scenes, speechDurations);
  await fs.writeFile(path.join(outDir, `${name}.vtt`), captions);
  await fs.writeFile(path.join(outDir, `${name}-transcript.txt`), transcript(scenes));

  const duration = await probeDuration(videoPath);
  const ffprobe = JSON.parse(await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type,pix_fmt,width,height", "-of", "json", videoPath]));
  const videoStream = ffprobe.streams.find((stream: any) => stream.codec_type === "video");
  const audioStream = ffprobe.streams.find((stream: any) => stream.codec_type === "audio");
  if (Math.abs(duration - targetDuration) > 0.001) throw new Error(`${name} duration is ${duration}s; expected exactly ${targetDuration}s`);
  if (videoStream?.codec_name !== "h264" || videoStream?.pix_fmt !== "yuv420p" || audioStream?.codec_name !== "aac") {
    throw new Error(`${name} has unexpected streams: ${JSON.stringify(ffprobe.streams)}`);
  }
  return { file: videoPath, duration, streams: ffprobe.streams, recordedScenes, totalScenes: scenes.length };
}

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write("Usage: node demo/submission/build.ts --output-dir DIR --playwright-module FILE --browser FILE --demo-transcript FILE --devnet-proof FILE [--story FILE] [--voice Samantha] [--voice-dir DIR]\n");
    return;
  }
  const opts = options(process.argv.slice(2));
  const outDir = need(opts, "output-dir");
  const playwrightModule = need(opts, "playwright-module");
  const browserPath = need(opts, "browser");
  const transcriptPath = need(opts, "demo-transcript");
  const proofPath = need(opts, "devnet-proof");
  const voice = opts.voice || "Samantha";
  const voiceDir = path.resolve(opts["voice-dir"] || path.join(HERE, "voice"));
  const storyPath = path.resolve(opts.story || path.join(HERE, "story.json"));
  const story = JSON.parse(await fs.readFile(storyPath, "utf8")) as Story;
  const transcriptSource = await fs.readFile(transcriptPath, "utf8");
  const devnet = parseDevnetProof(JSON.parse(await fs.readFile(proofPath, "utf8")));
  const sceneTemplate = await fs.readFile(path.join(HERE, "scene.html"), "utf8");
  const sceneCss = await fs.readFile(path.join(HERE, "scene.css"), "utf8");
  if (!transcriptSource.includes("PAID     $0.001000") || !transcriptSource.includes("BLOCKED  Over your per-payment limit") || !transcriptSource.includes("refunded $0.070000")) {
    throw new Error("Captured MCP transcript is missing the exact, block, or offline refund evidence");
  }
  if (story.pitch.length !== 6 || story.walkthrough.length !== 10) throw new Error("Expected six pitch scenes and ten walkthrough scenes");

  await fs.mkdir(outDir, { recursive: true });
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "wallet-pay-submission-render-"));
  const playwright = await import(pathToFileURL(playwrightModule).href);
  const browser = await playwright.chromium.launch({ headless: true, executablePath: browserPath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const evidence = { devnet, demo: transcriptParts(transcriptSource) };
  const startedAt = new Date().toISOString();
  try {
    const pitch = await renderSet({ name: "pitch", scenes: story.pitch, targetDuration: 180, outDir, tmpDir: workDir, page, template: sceneTemplate, css: sceneCss, evidence, voice, voiceDir });
    const walkthrough = await renderSet({ name: "walkthrough", scenes: story.walkthrough, targetDuration: 300, outDir, tmpDir: workDir, page, template: sceneTemplate, css: sceneCss, evidence, voice, voiceDir });
    await fs.copyFile(transcriptPath, path.join(outDir, "mcp-transcript.txt"));
    const inputs = [storyPath, transcriptPath, proofPath, path.join(HERE, "build.ts"), path.join(HERE, "scene.html"), path.join(HERE, "scene.css")];
    const inputHashes: Record<string, string> = {};
    for (const input of inputs) inputHashes[path.basename(input)] = sha256(await fs.readFile(input));
    const outputNames = ["pitch.mp4", "walkthrough.mp4", "pitch.vtt", "walkthrough.vtt", "pitch-poster.png", "walkthrough-poster.png", "pitch-transcript.txt", "walkthrough-transcript.txt", "mcp-transcript.txt"];
    const outputHashes: Record<string, string> = {};
    for (const name of outputNames) outputHashes[name] = sha256(await fs.readFile(path.join(outDir, name)));
    const manifest = {
      generatedAt: startedAt,
      entrypoint: "demo/submission/build.ts",
      sourceCommand: "node demo/submission/build.ts --output-dir <OUTPUT_DIR> --playwright-module <PLAYWRIGHT_MODULE> --browser <BROWSER_EXECUTABLE> --demo-transcript mcp-transcript.txt --devnet-proof <DEVNET_PROOF_JSON>",
      arguments: {
        outputDir: "<OUTPUT_DIR>",
        playwrightModule: "<PLAYWRIGHT_MODULE>",
        browserExecutable: path.basename(browserPath),
        demoTranscript: path.basename(transcriptPath),
        devnetProof: path.basename(proofPath),
        story: path.basename(storyPath),
      },
      renderer: {
        width: WIDTH,
        height: HEIGHT,
        fps: FPS,
        sceneSeconds: SCENE_SECONDS,
        voice,
        narration: {
          recordedScenes: pitch.recordedScenes + walkthrough.recordedScenes,
          synthesizedScenes: (pitch.totalScenes + walkthrough.totalScenes) - (pitch.recordedScenes + walkthrough.recordedScenes),
          source: pitch.recordedScenes + walkthrough.recordedScenes > 0 ? "human recordings (ffmpeg highpass+de-box EQ+compressor+static loudness gain+true-peak limiter), macOS say fallback" : "macOS say",
        },
        audio: "ffmpeg AAC 192k",
        video: "ffmpeg libx264 yuv420p faststart",
      },
      evidence: { devnetSlot: devnet.slot, devnetSignature: devnet.signature, sellerMicro: devnet.sellerMicro, refundMicro: devnet.refundMicro, demoTranscript: "mcp-transcript.txt" },
      inputSha256: inputHashes,
      outputSha256: outputHashes,
      videos: {
        pitch: { ...pitch, file: path.basename(pitch.file) },
        walkthrough: { ...walkthrough, file: path.basename(walkthrough.file) },
      },
    };
    await fs.writeFile(path.join(outDir, "build-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    process.stdout.write(`Built ${path.join(outDir, "pitch.mp4")} (${pitch.duration}s)\nBuilt ${path.join(outDir, "walkthrough.mp4")} (${walkthrough.duration}s)\n`);
  } finally {
    await page.close();
    await browser.close();
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
