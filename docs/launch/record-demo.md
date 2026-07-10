# Regenerate The Synapsor Launch Demo

This harness creates the caption-led launch MP4 and teaser GIF from the real
`support-plan-credit` Runner flow and a disposable Synapsor Cloud development
workspace. It uses synthetic data only. It does not call a paid LLM API,
publish npm packages, deploy AWS infrastructure, or upload the generated media.

## Prerequisites

- Linux with at least 5 GB free disk
- Node.js 22+
- Corepack and pnpm
- Docker Engine with Compose
- Google Chrome or Chrome-compatible `google-chrome`
- Git, npm, `unzip`, and `sha256sum`
- access to a short-lived Synapsor development operator token

The harness uses this pinned container for encoding and inspection, so FFmpeg
does not need to be installed on the host:

```text
jrottenberg/ffmpeg:7.1-alpine@sha256:8ec1ee1f6a0fcd37c97725827b6b7832795c9596e3439b8da56d7700d61ae778
```

Check the machine without changing product state:

```bash
corepack pnpm demo:video:check
```

## Credentials

Load the development operator token into the current shell without putting it
in command history or a command-line argument:

```bash
read -rsp "Synapsor demo operator token: " SYNAPSOR_DEMO_ADMIN_TOKEN
printf '\n'
export SYNAPSOR_DEMO_ADMIN_TOKEN
```

The harness creates a synthetic `@example.com` account and a free disposable
project on `https://dev-console.synapsor.ai`. It stores the temporary session
under ignored `.synapsor/demo-video/private/` state with mode `0600`, never
renders the value, and deletes the account and browser profile before the build
is considered complete.

## One-Command Build

Use the published stable Runner for the public-facing recording:

```bash
SYNAPSOR_DEMO_RUNNER_MODE=published \
SYNAPSOR_DEMO_RUNNER_VERSION=0.1.12 \
corepack pnpm demo:video
```

Published mode installs the exact requested version into the ignored demo
state and invokes that binary by absolute path. It does not rely on a global
install or on `npx` command resolution, so a stale global alias cannot shadow
the recorded package.

That one command:

1. checks prerequisites;
2. resets and seeds the disposable Postgres example;
3. creates a disposable Cloud account and workspace;
4. runs audit, inspect, proposal, approval, guarded apply, receipt, and replay;
5. pushes the exact canonical contract to Cloud;
6. downloads and secret-scans the real Runner bundle;
7. captures the authenticated Contract registry in a clean Chrome profile;
8. renders deterministic 1920x1080 frames from captured product state;
9. encodes the MP4 and GIF;
10. deletes Cloud credentials/resources and the local Docker volume;
11. verifies media, product state, required scenes, and redaction.

Output:

```text
docs/launch/out/synapsor-launch-demo.mp4
docs/launch/out/synapsor-launch-demo.gif
docs/launch/captions.srt
docs/launch/asset-manifest.md
```

The `out/` directory is ignored by Git.

## Development Draft

Use local source while editing the harness:

```bash
SYNAPSOR_DEMO_RUNNER_MODE=local \
corepack pnpm demo:video -- --local-draft
```

This produces local media without Cloud. It is deliberately not a releasable
asset: `corepack pnpm demo:video:verify` will fail until a real Cloud push,
registry capture, bundle verification, and cleanup have completed.

During development, test local changes with `./bin/synapsor-runner` or a packed
tarball. `npx` tests the currently published package, not uncommitted source.

## Individual Commands

```bash
corepack pnpm demo:video:reset
./scripts/demo-video/run-demo.sh
./scripts/demo-video/capture-cloud-ui.sh
corepack pnpm demo:video:capture
corepack pnpm demo:video:verify
```

The individual Cloud commands require the ignored private state created by the
top-level build. Prefer the one-command build unless debugging a specific step.

## Cleanup After An Interrupted Run

If an interrupted run reports that private Cloud state remains, keep the
operator token in the environment and run:

```bash
./scripts/demo-video/cleanup-cloud.sh
docker compose -f examples/support-plan-credit/docker-compose.yml down -v --remove-orphans
```

Do not delete `.synapsor/demo-video/private/cloud-private.json` before Cloud
cleanup. It is the bounded credential needed to identify and remove the
disposable account. `demo:video:reset` refuses to proceed while that file exists.

## Verification And Review

Run verification again without regenerating media:

```bash
corepack pnpm demo:video:verify
```

The verifier checks duration, resolution, frame rate, H.264/yuv420p, faststart,
MP4/GIF size, caption stages, product invariants, canonical Cloud digest,
authenticated registry capture, Runner-bundle contents, black frames, and
secret-like strings. It extracts eight frames under:

```text
.synapsor/demo-video/render/review-frames/
```

For local browser review only:

```bash
python3 -m http.server 4173 --directory docs/launch/out
```

Open `http://127.0.0.1:4173/synapsor-launch-demo.mp4`.

## Troubleshooting

- `SYNAPSOR_DEMO_ADMIN_TOKEN is required`: load a short-lived development
  operator token as described above. Do not paste it into a script.
- `Disposable Cloud credentials still exist`: run `cleanup-cloud.sh` before
  reset; this prevents orphaning an account.
- `Cloud registry capture did not prove the expected boundary`: inspect the
  real UI manually before changing selectors. Do not replace it with a static
  screenshot.
- `Disposable Postgres did not become ready`: inspect
  `docker compose -f examples/support-plan-credit/docker-compose.yml logs` and
  rerun reset after the container is healthy.
- media exceeds the target size: keep the resolution and readable text; adjust
  encoder quality only after representative-frame review.

Publication status: generated for local manual review only. The harness does
not merge, release, deploy, or upload anything.
