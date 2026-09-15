# Provider response bounds — final report

The local repair and verification passed. The new immutable installation is ready for the independent cross-vendor rerun. No live provider call was made, and a completed non-OpenAI review journey remains NOT ESTABLISHED.

## Source and artifact identity

- Canonical branch: `codex/tui-safe-action-control-plane`; baseline `1ae76e5a6865ec4e9c54358451594dcfad69def9`.
- Product and tests: `fbbb52b823314973e8097d07da4f05ddd936cbec`. Frozen source/evidence checkpoint: `29000841a0a27c50ef436ccf1de76fd98ecf4772`. Final report/delivery revision is recorded separately in `delivery.json` under the owned evidence root.
- Full installed tree: **`072ab87a11ecde0ec1e0a0928bfc6ba036fede08b6e75cfc073b1de263c631ef`**, 7,569 entries (file hashes, modes, directories and symlink targets).
- Full manifest SHA-256: `99abcda0c0cf1f958bb272c17584961c45e5d39cff18027768e0d3a02fab7684`.
- Whole-installation archive SHA-256: `8e17bf9cdf6073ddd7145dc8ac2abcad8a9070731cccc98db2d5eb92e4f74cbd`.
- Installed dependency lock SHA-256: `4fb68d0775df8c3306cf26d5628b372e4ca5af1137198f722c8096d242966d04`.
- Runner pack: `45ae0866f1454fec7963459a5501fc5fffa3134de1bfd6f9f3335b810a585bab`. Local Spec pack: `27cfef8a1f3d85e8897b5da378e50518e67e69facfced6b566b7731c8376f12e`.
- Installation: `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/provider-response-bounds-1ae76e5-20260915/frozen/installed`. Node identity, dependency inventory, exact entrypoints and complete tree are in `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/provider-response-bounds-1ae76e5-20260915/frozen/installed-artifact-manifest.json`. The install was sealed before hashing and checked under read-only mounts; it was never patched.

The previous `5c5c5eeb0d8a42305d857d5bcc0841c12861dd9bf26798679b2107e2e5a28d35` installation remains unchanged. The G2 report and terminal log were hashed anew because that report was legitimately appended before this task; older manifests were not rewritten. `preservation-after.json` records both installation checks and the exact external-file comparisons.

## Repair and rationale

The recorded G2 coverage failure was a streamed private-continuation refusal at 64 KiB, after successful non-OpenAI planning on the timeout-repaired build. The same cap existed again on nonstream/continuation reuse. The three reported inline checks were therefore not the complete surface. Tool arguments also had checks in Responses decoding, chat decoding, history reencoding and string parsing; the already-parsed Anthropic object path lacked the equivalent serialized-size check.

| Bound | Before | Now | Reason |
|---|---|---|---|
| Private continuation per response | 64 KiB | 512 KiB serialized UTF-8 array | Eightfold headroom, still half the unchanged complete-response limit. Opaque/encrypted blocks and JSON framing have no portable bytes/token relationship; fixed byte limit, not token scaling or a new setting. |
| Tool arguments per call | 32,768 UTF-16 units on string paths; object path inconsistent | 128 KiB serialized UTF-8 across parsing/stream/history paths | Matches existing schema/result budgets; accommodates larger structured coverage while retaining depth, key and array guards. |
| Total request | 256 KiB | 1 MiB | Bounded room for the former request allowance plus one 512 KiB continuation and framing. Accumulated history can still exceed it and refuses without dropping continuation. |
| Complete response / wire stream | 1 MiB / 8 MiB | unchanged | Outer limits still apply even when each component fits its individual cap. |
| Ordinary Ask | 6 rounds / 8 calls / 4 per response | unchanged | Limits completed round trips, execution fanout and spending, not private reasoning fragments. |
| Conversational authoring | 12 rounds / 24 calls / 4 per response | unchanged, now named | Already separate from ordinary Ask. Structured authoring still requires exactly one named initial call. |

After the round ceiling, the existing final answer-only request may occur (seventh or thirteenth request); it cannot execute another tool. Caller-level bounded corrections remain separate calls. No timeout defaults, output-token limits, OpenRouter privacy routing, fallback restrictions or incomplete-call rules changed. No prompt, policy, authority, identity, accounting, publication, receipt, worker or adapter redesign. The four runtime tools are unchanged.

Stream accounting now measures the retained array, including brackets and commas, independently of chunking. Opaque blocks stay in order and are never emitted as UI events or ordinary provider history. The byte caps do not claim a measured peak-RSS guarantee. The G2 envelope was not captured in full: 512 KiB is justified bounded headroom, not proof that Grok's eventual complete answer will fit.

## Evidence and exits

| Check | Result |
|---|---|
| Before repair at 1ae76e5 | Five expected failures, exit 1: streamed/nonstream continuation, chat/Responses arguments, and oversized Anthropic object acceptance. Synthetic threshold reproductions, not invented Grok captures. |
| Initial repaired controls | 5 passed, exit 0. |
| Final focused provider/transport run | 225 passed, exit 0 (17 new controls, 192 existing model-ask, 16 OpenRouter). |
| Stable full Vitest suite | **6,440 passed / 463 skipped, exit 0**; 311 passed files / 21 skipped. One run, 27m29s. Source manifest unchanged. |
| Types | Exit 0; source bytes match the stable tested product. |
| Ten offline checks | All exit 0: trusted core, licenses, human commands, DSL sources, Cursor plugin, MCP client configs, local package, bundle freshness, public commands, packed offline install. |
| Frozen installed commands | Start, onboard db and try ask help each exited 0. Constant inspection passed after a harness-only correction. This is installed command/byte evidence, not a live review journey. |
| Live provider / explicit database campaign | Not run. Provider call budget zero; integration opt-ins remain skips. Existing automated tests used their task-isolated fixtures. |

Boundary controls cover exactly-at/one-byte-over limits, 128-way stream fragmentation, Unicode argument bytes, malformed continuation, incomplete streams, exact continuation replay, Responses history reencoding and cumulative request refusal. The last confirms prior completed tool callbacks remain completed when a later HTTP request is refused; there is no whole-turn rollback claim. Both adapter execution loops retain the exact 4/8/6 and 4/24/12 limits. Existing timeout, outer stream/payload, cancellation, private routing and partial-response refusal tests pass.

Three harness issues remain visible: the expanded tests initially expected a nonexistent incomplete-stream error code (two failures); the copied package phase launcher had a Path/filename precedence error before any package command; the installed constant inspector assumed inline var initialization instead of esbuild's initialization block. Original scripts/logs/results are retained. Corrections changed only measurement/setup, no product behavior, no frozen bytes, no assertions weakened to accept an oversized or incomplete call. Completed source checks and installed help commands were not repeated.

## Reproduction, preservation and classification

Exact commands and environment manifests are in `*-exit.json`, `offline-package-plan-attempt1.json` and `REVIEWER-HANDOFF.md`. Private HOME, writable task-owned /var/tmp, umask 0077, NO_COLOR=1, no provider/unrelated credentials and network isolation were used. Offline packaging used the local Spec and a separate writable cache copy. Source was not edited during the stable run. Original installations, stopped jobs and queues were not run in place; no saved-job worker or live database campaign was launched. Owned automated-test state and logs remain under `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/provider-response-bounds-1ae76e5-20260915`.

The reviewer independently established valid non-OpenAI planning on the older timeout candidate; coverage stopped at the 64 KiB bound. Do not repeat the broader claim that no non-OpenAI operation contract was reached. Completed cross-vendor coverage/review is still unverified on this new artifact. Historical Stage A remains artifact-specific; original Stage B remains NOT PASSED. The receipt-review and TRUSTED_BINDING_MISSING findings remain separate.

Next decision: the independent reviewer can repeat the already-declared Grok journey on this exact new installation and a fresh owned starting copy, keeping --timeout 300 and existing consent/privacy restrictions. Preserve any subsequent failure instead of assuming a larger memory budget proves compatibility. Delivery is only to the verified private backup remote; no public release or deployment. Then STOP for review.
