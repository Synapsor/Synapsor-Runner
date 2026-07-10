# Synapsor Launch Demo Asset Manifest

Publication status: **NOT PUBLISHED - awaiting manual review**

## Source

- OSS commit: `afe54e64142bb764f704ae2dbe419d81281a4414`
- Runner execution mode: `published`
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
| `docs/launch/out/synapsor-launch-demo.mp4` | 177.000 s | 1920x1080 | h264 / yuv420p | 2768398 bytes | `f739fec0e6622d9fc9ba53128cb20dd072b11f431f6543fb2a4ca3e1becf350f` |
| `docs/launch/out/synapsor-launch-demo.gif` | 26.000 s | 960x540 | GIF | 638816 bytes | `e7911ddeeb2472f580d9af47f3bef5214d70c4a0970f9fcc8282895b5e28a6ee` |

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
- Evidence ID: `ev_8cd6189eff264bf8e1d9`
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
