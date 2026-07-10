import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const [repoRoot, resultsPath, capturePath, screenshotPath, mp4MetadataPath, gifMetadataPath, captionsPath, mp4Path, gifPath, framesDir] = process.argv.slice(2);
if ([repoRoot, resultsPath, capturePath, screenshotPath, mp4MetadataPath, gifMetadataPath, captionsPath, mp4Path, gifPath, framesDir].some((value) => !value)) {
  throw new Error("verify-media.mjs received an incomplete argument list");
}

const fail = (message) => { throw new Error(message); };
const results = JSON.parse(await readFile(resultsPath, "utf8"));
const capture = JSON.parse(await readFile(capturePath, "utf8"));
const mp4Meta = JSON.parse(await readFile(mp4MetadataPath, "utf8"));
const gifMeta = JSON.parse(await readFile(gifMetadataPath, "utf8"));
const captions = await readFile(captionsPath, "utf8");
const mp4Stats = await stat(mp4Path);
const gifStats = await stat(gifPath);

const video = mp4Meta.streams?.find((stream) => stream.codec_type === "video");
const gif = gifMeta.streams?.find((stream) => stream.codec_type === "video");
const duration = Number(mp4Meta.format?.duration ?? video?.duration);
const gifDuration = Number(gifMeta.format?.duration ?? gif?.duration);
const fraction = (value) => {
  const [numerator, denominator = "1"] = String(value ?? "0").split("/").map(Number);
  return denominator ? numerator / denominator : 0;
};

if (!video || video.codec_name !== "h264") fail(`Expected H.264, got ${video?.codec_name ?? "none"}`);
if (video.width !== 1920 || video.height !== 1080) fail(`Expected 1920x1080, got ${video.width}x${video.height}`);
if (video.pix_fmt !== "yuv420p") fail(`Expected yuv420p, got ${video.pix_fmt}`);
if (duration < 120 || duration > 180) fail(`Expected a 120-180 second MP4, got ${duration}`);
if (Math.abs(fraction(video.avg_frame_rate) - 30) > 0.05) fail(`Expected 30 fps, got ${video.avg_frame_rate}`);
if (mp4Stats.size <= 0 || mp4Stats.size >= 40 * 1024 * 1024) fail(`MP4 size is outside 0-40 MB: ${mp4Stats.size}`);

const mp4Bytes = await readFile(mp4Path);
const moov = mp4Bytes.indexOf(Buffer.from("moov"));
const mdat = mp4Bytes.indexOf(Buffer.from("mdat"));
if (moov < 0 || mdat < 0 || moov > mdat) fail("MP4 is not web optimized with the moov atom before media data");

if (!gif || gif.codec_name !== "gif") fail(`Expected GIF codec, got ${gif?.codec_name ?? "none"}`);
if (gif.width !== 960 || gif.height !== 540) fail(`Expected 960x540 GIF, got ${gif.width}x${gif.height}`);
if (gifDuration < 20 || gifDuration > 45) fail(`Expected a 20-45 second GIF, got ${gifDuration}`);
if (gifStats.size <= 0 || gifStats.size >= 15 * 1024 * 1024) fail(`GIF size is outside 0-15 MB: ${gifStats.size}`);

const frameNames = (await readdir(framesDir)).filter((name) => /^frame-\d+\.jpg$/.test(name));
if (frameNames.length !== 8 * 177) fail(`Expected 1416 capture frames, got ${frameNames.length}`);

const screenshot = await readFile(screenshotPath);
if (screenshot.length < 100_000 || screenshot.subarray(1, 4).toString("ascii") !== "PNG") fail("Cloud screenshot is missing or implausibly small");
const screenshotWidth = screenshot.readUInt32BE(16);
const screenshotHeight = screenshot.readUInt32BE(20);
if (screenshotWidth !== 1600 || screenshotHeight !== 1000) fail(`Expected 1600x1000 Cloud screenshot, got ${screenshotWidth}x${screenshotHeight}`);

if (!results.cloud?.complete || !results.cloud?.exact_contract_match) fail("Cloud contract verification is incomplete");
if (results.cloud.digest !== results.cloud.local_contract_digest) fail("Cloud and local canonical contract digests differ");
if (!results.cloud.bundle?.required_entries_present || results.cloud.bundle?.secret_scan !== "clean") fail("Runner bundle verification is incomplete");
if (!capture.ok || !capture.hasContract || !capture.hasBundle || !capture.hasKeptOut || capture.hasRawSql) fail("Cloud registry capture does not prove the expected boundary");
if (results.proposal.source_database_changed !== false || results.source_state.after_proposal.plan_credit_cents !== 0) fail("Proposal mutated source before approval");
if (results.writeback.state !== "applied" || results.writeback.rows_affected !== 1 || results.source_state.after_apply.plan_credit_cents !== 10000) fail("Guarded one-row writeback evidence is invalid");
for (const event of ["proposal_created", "evidence_recorded", "proposal_approved", "writeback_applied"]) {
  if (!results.replay.events.includes(event)) fail(`Replay is missing ${event}`);
}
for (const excluded of ["execute_sql / raw query tools", "approval tools", "commit/apply tools", "database URLs", "write credentials", "model-controlled tenant authority"]) {
  if (!results.tools.excluded.includes(excluded)) fail(`MCP exclusion proof is missing ${excluded}`);
}

const cues = [...captions.matchAll(/\n(\d{2}):(\d{2}):(\d{2}),\d{3} --> (\d{2}):(\d{2}):(\d{2}),\d{3}\n/g)];
if (cues.length !== 14) fail(`Expected 14 caption cues, got ${cues.length}`);
for (const phrase of ["execute_sql", "trusted context", "proposal", "outside the model-facing MCP surface", "Guarded writeback", "receipt and replay", "Synapsor Cloud", "design partners"]) {
  if (!captions.includes(phrase)) fail(`Captions are missing required stage: ${phrase}`);
}

async function collectTextFiles(root) {
  const collected = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "out") continue;
      collected.push(...await collectTextFiles(full));
    } else if (/\.(?:md|srt|sh|mjs)$/.test(entry.name)) {
      collected.push(full);
    }
  }
  return collected;
}

const textFiles = [
  ...await collectTextFiles(path.join(repoRoot, "scripts/demo-video")),
  ...await collectTextFiles(path.join(repoRoot, "docs/launch")),
];
const stateTextFiles = [resultsPath, capturePath, path.join(path.dirname(resultsPath), "cloud-public.json")];
const unfinishedMarker = new RegExp(`\\b(?:${["TO", "DO"].join("")}|${["FIX", "ME"].join("")}|${["T", "BD"].join("")})\\b`, "i");
const secretPatterns = [
  [/(?:postgres(?:ql)?|mysql):\/\/[^\s"']+:[^\s"']{4,}@/i, "database URL with credentials"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, "AWS access key"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{12,}\b/, "JWT"],
  [/Authorization:\s*Bearer\s+(?!<)[A-Za-z0-9._~+/=-]{16,}/i, "bearer token"],
  [/\bsyn_(?:sess|ops|inv)_[A-Za-z0-9_-]{12,}\b/, "Synapsor token"],
  [/\/home\/[A-Za-z0-9._-]+\//, "personal home path"],
  [unfinishedMarker, "unfinished placeholder"],
];
for (const file of [...textFiles, ...stateTextFiles]) {
  const content = await readFile(file, "utf8");
  const labelPath = path.relative(repoRoot, file);
  for (const [pattern, label] of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) fail(`Text scan found ${label} in ${labelPath}`);
  }
  const emails = content.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) ?? [];
  for (const email of emails) {
    if (!email.endsWith("@example.com") && !email.endsWith("@synapsor.ai")) fail(`Text scan found unapproved email in ${labelPath}: ${email}`);
  }
}

console.log(JSON.stringify({
  ok: true,
  mp4: { duration_seconds: duration, width: video.width, height: video.height, codec: video.codec_name, pixel_format: video.pix_fmt, frame_rate: fraction(video.avg_frame_rate), size_bytes: mp4Stats.size, faststart: true },
  gif: { duration_seconds: gifDuration, width: gif.width, height: gif.height, size_bytes: gifStats.size },
  capture_frames: frameNames.length,
  cloud: { exact_contract_match: true, registry_capture: true, runner_bundle_secret_scan: "clean" },
  text_and_secret_scan: "clean",
}, null, 2));
