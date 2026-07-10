# Synapsor Demo Video Progress

## Goal

Create a reproducible, caption-led 2-3 minute launch video and teaser GIF from
the real `support-plan-credit` OSS + Cloud flow. Keep generated media local for
manual review; do not merge, publish packages, deploy AWS, upload media, or send
outreach without separate approval.

## Repositories

- OSS repo: this checkout / `https://github.com/Synapsor/Synapsor-Runner`
- OSS branch: `feature/reproducible-launch-demo-video`
- OSS base: `main` / `origin/main` at `8a3c0a985ae1806d3ff4975c54103b8ab67737bc`
- Harness implementation commit: `afe54e6` (`Add reproducible launch demo video harness`)
- Cloud repo: sibling proprietary checkout, inspection only
- Cloud branch: `main` at `1af282f8c6a23218dc0b4cc527cfe7f5e39b4c23`
- Cloud repo is inspection-only for this goal unless a narrow change is separately approved.

## Package Truth

| Package | Local | npm latest |
| --- | --- | --- |
| `@synapsor/runner` | `0.1.12` | `0.1.12` |
| `@synapsor/spec` | `0.1.4` | `0.1.4` |
| `@synapsor/dsl` | `0.1.4` | `0.1.4` |

## Recording Tool Truth

- Node: `v22.22.2`
- pnpm: `10.14.0`
- Docker: `29.5.2`
- Chrome: `148.0.7778.178`
- Free disk: approximately `47 GB`
- Missing globally: FFmpeg, FFprobe, asciinema, VHS, Playwright, shellcheck,
  tesseract, ImageMagick, gifsicle.
- Selected approach: use Chrome to render deterministic HTML/CSS scenes from
  real sanitized transcripts and a pinned Docker FFmpeg image for media
  composition/inspection. Do not install global system packages.

## Baseline Results

Commands run before source edits:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
corepack pnpm test:live-apply
```

Results:

- install: passed
- build: passed
- unit/content suite: passed, 14 files and 223 tests
- live apply: partially passed, then failed in the existing MySQL orders leg
  before this goal changed source
  - Postgres billing: passed tools, proposal, unchanged source, external
    approval, guarded apply, receipt/replay, and stale-row conflict
  - Postgres support: passed the same boundary
  - MySQL orders: tools were listed, then inspect failed with
    `MCP_TOOL_FAILED: Connection lost: The server closed the connection.`

The final post-change live suite passed all four example legs, including MySQL
orders. The baseline failure is recorded here because it preceded harness work;
the successful rerun is recorded below rather than rewriting that history.

## Completed

- [x] Read goal and OSS agent instructions.
- [x] Verify both repositories are clean and synchronized.
- [x] Create dedicated OSS branch.
- [x] Verify npm/local package versions.
- [x] Inspect support-plan-credit contract, config, seed, docs, MCP snippets,
  Cloud push instructions, and expected output.
- [x] Establish build/unit/live baseline.
- [x] Select a no-global-install media tool strategy.
- [x] Fact-check exact support-plan-credit command/output sequence.
- [x] Write the 177-second storyboard, captions, regeneration guide, and launch copy.
- [x] Implement deterministic reset/seed/run/redaction scripts.
- [x] Implement real disposable Cloud setup/push/fetch/UI-capture/cleanup scripts.
- [x] Implement the deterministic scene renderer, Chrome frame capture, pinned
  FFmpeg build, and fail-closed verifier.
- [x] Run a local draft through 1,416 frames and encode MP4/GIF.
- [x] Inspect all 14 local-draft scenes at representative timestamps.
- [x] Run reset plus the product flow repeatedly in local and published modes.
- [x] Perform real disposable Cloud push/registry/bundle capture.
- [x] Render and verify MP4/GIF.
- [x] Inspect all 14 scene layouts and the eight extracted final frames.
- [x] Complete regeneration docs, asset manifest, hashes, and launch copy.

## Final Media Result

- MP4: 177 seconds, 1920x1080, 30 fps, H.264/yuv420p, faststart, 2,768,398 bytes.
- MP4 SHA-256: `f739fec0e6622d9fc9ba53128cb20dd072b11f431f6543fb2a4ca3e1becf350f`.
- GIF: 26 seconds, 960x540, 638,816 bytes.
- GIF SHA-256: `e7911ddeeb2472f580d9af47f3bef5214d70c4a0970f9fcc8282895b5e28a6ee`.
- Canonical Cloud digest:
  `sha256:864a30ac32de9c102354e4843fdc7566c5c5d40f4290c06a4ce5a452cfc1829d`.
- Cloud contract match: passed.
- Runner bundle: 11 files; required entries present; secret scan clean.
- Disposable Cloud account, browser profile, local container, and Docker volume:
  removed.
- Publication status: not published; awaiting manual review.

## Final Verification

```text
corepack pnpm build                 PASS
corepack pnpm test                  PASS (14 files, 223 tests)
corepack pnpm test:live-apply       PASS (Postgres billing/support/credit + MySQL orders)
corepack pnpm demo:video:check      PASS
corepack pnpm demo:video            PASS
corepack pnpm demo:video:verify     PASS
bash -n scripts/demo-video/*.sh     PASS
node --check scripts/demo-video/*.mjs PASS
git diff --check                    PASS
```

The first published-mode attempt resolved a stale globally installed CLI
instead of npm `0.1.12`. The harness now installs the exact requested package
into ignored isolated state and invokes its absolute binary. No global install
was changed.

Cloud account deletion received one gateway timeout during an early failed run.
Cleanup is now bounded, retried, and idempotent; all disposable accounts created
by this goal were confirmed deleted.

## Commands Added

```bash
corepack pnpm demo:video:check
corepack pnpm demo:video:reset
corepack pnpm demo:video -- --local-draft
corepack pnpm demo:video
corepack pnpm demo:video:verify
```

## Exact Next Action

Give the local MP4/GIF to the user for the manual review gate. Do not push,
merge, upload, publish, deploy, or send launch copy without separate approval.
