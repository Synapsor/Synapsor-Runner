# Synapsor Launch Demo Asset Manifest

Publication status: **NOT PUBLISHED - awaiting manual review**

## Source

- OSS commit: `b33b1f58d1bce30b18974943bfd59e0a2779b9a7`
- Runner execution mode: `local`
- Runner version: `0.1.12`
- `@synapsor/spec`: `0.1.4`
- `@synapsor/dsl`: `0.1.4`
- Harness package version: `0.1.12`
- Canonical contract digest: `sha256:864a30ac32de9c102354e4843fdc7566c5c5d40f4290c06a4ce5a452cfc1829d`
- Cloud contract version: `1`
- Synthetic object: `CUS-3001`

## Assets

| Asset | Duration | Dimensions | Codec / format | Size | SHA-256 |
| --- | ---: | --- | --- | ---: | --- |
| `docs/launch/out/synapsor-launch-demo.mp4` | 177.000 s | 1920x1080 | h264 / yuv420p | 2768833 bytes | `2bc525b578336acec4f344a8ed498e238e6dcf71b6cb2ec2f502c4b0dcd6aa6e` |
| `docs/launch/out/synapsor-launch-demo.gif` | 26.000 s | 960x540 | GIF | 632660 bytes | `7c0fea324117dd208a3f21a2f82127662559175c80080eb2bb60fcffec35c76c` |

Captions: `docs/launch/captions.srt`

## Generation

```bash
corepack pnpm demo:video
corepack pnpm demo:video:verify
```

The harness used a disposable localhost Postgres container, a disposable
Synapsor Cloud development workspace, synthetic support data, a clean headless
Chrome profile, and the pinned FFmpeg image documented in
`docs/launch/record-demo.md`.

## Proven State

- Proposal ID: `wrp_888fe169da44bf46a09a`
- Evidence ID: `ev_e5354b114b8f33c038fe`
- Receipt hash: `sha256:92ad59721e4cb5337f004696522cab26fac719798d8ebb092ae9e2f1fd6dab8b`
- Source before proposal: 0 cents
- Source after proposal: 0 cents
- Source after guarded apply: 10000 cents
- Rows affected: 1
- Cloud exact-contract comparison: passed
- Runner-bundle secret scan: passed
- Disposable Cloud account cleanup: passed
- Disposable local Postgres cleanup: passed

## Manual Steps

No manual product-state editing or browser interaction is required. An operator
must provide `SYNAPSOR_DEMO_ADMIN_TOKEN` in the environment before generation;
the value is never rendered, logged, or stored in a public artifact.
