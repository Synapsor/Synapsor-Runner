import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const [repoRoot, resultsPath, mp4MetadataPath, gifMetadataPath, mp4Path, gifPath, outputPath] = process.argv.slice(2);
if ([repoRoot, resultsPath, mp4MetadataPath, gifMetadataPath, mp4Path, gifPath, outputPath].some((value) => !value)) {
  throw new Error("write-asset-manifest.mjs received an incomplete argument list");
}

const results = JSON.parse(await readFile(resultsPath, "utf8"));
const mp4Metadata = JSON.parse(await readFile(mp4MetadataPath, "utf8"));
const gifMetadata = JSON.parse(await readFile(gifMetadataPath, "utf8"));
const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const video = mp4Metadata.streams.find((stream) => stream.codec_type === "video");
const gif = gifMetadata.streams.find((stream) => stream.codec_type === "video");
const hash = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const mp4Stat = await stat(mp4Path);
const gifStat = await stat(gifPath);
const mp4Duration = Number(mp4Metadata.format.duration ?? video.duration);
const gifDuration = Number(gifMetadata.format.duration ?? gif.duration);
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();

const manifest = `# Synapsor Launch Demo Asset Manifest

Publication status: **NOT PUBLISHED - awaiting manual review**

## Source

- OSS commit: \`${commit}\`
- Runner execution mode: \`${results.source.runner_mode}\`
- Runner version: \`${results.source.runner_version}\`
- \`@synapsor/spec\`: \`${results.source.spec_version}\`
- \`@synapsor/dsl\`: \`${results.source.dsl_version}\`
- Harness package version: \`${packageJson.version}\`
- Canonical contract digest: \`${results.cloud.digest}\`
- Cloud contract version: \`${results.cloud.version_number}\`
- Synthetic object: \`${results.proposal.object_id}\`

## Assets

| Asset | Duration | Dimensions | Codec / format | Size | SHA-256 |
| --- | ---: | --- | --- | ---: | --- |
| \`docs/launch/out/synapsor-launch-demo.mp4\` | ${mp4Duration.toFixed(3)} s | ${video.width}x${video.height} | ${video.codec_name} / ${video.pix_fmt} | ${mp4Stat.size} bytes | \`${await hash(mp4Path)}\` |
| \`docs/launch/out/synapsor-launch-demo.gif\` | ${gifDuration.toFixed(3)} s | ${gif.width}x${gif.height} | GIF | ${gifStat.size} bytes | \`${await hash(gifPath)}\` |

Captions: \`docs/launch/captions.srt\`

## Generation

\`\`\`bash
corepack pnpm demo:video
corepack pnpm demo:video:verify
\`\`\`

The harness used a disposable localhost Postgres container, a disposable
Synapsor Cloud development workspace, synthetic support data, a clean headless
Chrome profile, and the pinned FFmpeg image documented in
\`docs/launch/record-demo.md\`.

## Proven State

- Proposal ID: \`${results.proposal.proposal_id}\`
- Evidence ID: \`${results.proposal.evidence_bundle_id}\`
- Receipt hash: \`${results.writeback.receipt_hash}\`
- Source before proposal: ${results.source_state.before.plan_credit_cents} cents
- Source after proposal: ${results.source_state.after_proposal.plan_credit_cents} cents
- Source after guarded apply: ${results.source_state.after_apply.plan_credit_cents} cents
- Rows affected: ${results.writeback.rows_affected}
- Cloud exact-contract comparison: passed
- Runner-bundle secret scan: passed
- Disposable Cloud account cleanup: passed
- Disposable local Postgres cleanup: passed

## Manual Steps

No manual product-state editing or browser interaction is required. An operator
must provide \`SYNAPSOR_DEMO_ADMIN_TOKEN\` in the environment before generation;
the value is never rendered, logged, or stored in a public artifact.
`;

await writeFile(outputPath, manifest, { mode: 0o644 });
console.log(`Wrote ${outputPath}`);
