# Prospective review snapshot correction

Owner requested no docs/non-test copies in future review/test snapshots. The later explicit cleanup approval was applied only to the 38 finished, sealed copied-doc directories described below. Frozen candidates, protected containers, sessions, source code, and active runs remain untouched.

| Lane | Method | Measured logical bytes | Allocated bytes |
| --- | --- | ---: | ---: |
| R2 component reviews | pinned production/build closure + explicit test assets | 16,202,581 | 17,850,368 |
| B66 / Action helper | filtered tracked source/tests/build inputs | 36,869,411 | 40,652,800 |
| Ask support | pinned source + explicit sealed test/assets | 14,827,186 | 16,314,368 |
| B65 public Tester | filtered source plus retained source tar | 72,236,625 | 77,291,520 |
| Main / Read / R1 | reuse existing fixed worktree; source hashes recorded | 0 source-copy overhead | 0 source-copy overhead |
| Runtime diagnosis | fixed worktree + manifest | 0 source-copy overhead | 0 source-copy overhead |

These are measured prebuild copies, not complete postbuild/database evidence sizes. R2 previous same-pin tracked inputs were 440,743,284 logical / 462,102,528 allocated bytes; new logical source size is 96.3% smaller. Tester retains a 36,577,280-byte tar and 35,217,686-byte source tree, so its figure counts both.

- R2 helper: `/home/sandesh-tiwari/Documents/Codex/2026-10-06/b51-independent-reviewer-2/work/reviewer2-read8/snapshot_compact_v2.py`, with `run-b64-pinned-component-source-v2.py`; private evidence commit `7c8a0f9a`. Included/source manifests verified, missing assets refused. Original v1 remains historical and is superseded for future runs.
- B66 helper: `../b57-fixture-prep/scripts/experiments/b65/create-filtered-review-snapshot.py`, private commit `36d74555`; manifest `/var/tmp/synapsor-b66-filtered-snapshot-qualification-v2-20261009/SOURCE-MANIFEST.json`. Exact blobs rehashed; absolute/escaping links rejected; network-off Vitest help succeeds. No product test result claimed.
- Tester helper: `../b65-native-review/docs/development/b65-sequential-public-review/slim-snapshot.py`, private commit `87ceb1cd`; manifest `/var/tmp/synapsor-b65-slim-metadata-independent-owned/SOURCE-MANIFEST.json`. Included 1,675 files and confined product dependency links verified. Actual D01 build failures remain recorded separately; snapshot conversion does not excuse them.
- Main manifests: `/var/tmp/synapsor-main-read-consumers-owned.7rkceia5/SOURCE-MANIFEST.json` and `/var/tmp/synapsor-main-receipt-typed-owned.t0iafzzl/SOURCE-MANIFEST.json`; actual21 and197 focused tests pass respectively.
- Read rule recorded in private commit `c784598a`; R1 reuse/manifests in `ae1bef7b`; Runtime manifest references actual included inputs without copying the repo.
- Ask helper `../b64-ask-typed/docs/development/b64-ask-typed/run-pinned-support.py` converted in `803fbae9`; measurement record `294d19ec`. Manifest `/var/tmp/synapsor-b64-ask-owned/filtered-support-prospective-v1/SOURCE-MANIFEST.json` hashes all625 included files, sealed test and dependency content. The historical full-archive captures remain untouched. No runtime qualification is inferred from the storage measurement.

Required test assets must be explicit and exact-pin hashed; no assertion may be removed or skipped because an asset was excluded. Documentation/package gates need their actual declared asset set and cannot silently use the compact component profile. The alleged missing root Vitest config was corrected: none exists at the inspected current pins; future actual configs are included.

Storage audit `ba6d04c8`: reviewer root 25.938 GiB; 58 copied qualification-evidence trees occupy 21.177 GiB (81.64%). Logs/results/manifests total 0.098 GiB. Metadata birth times are not a reliable historical net-growth measurement.

Approved cleanup completed at 2026-10-09T02:12:40Z: exactly 38 `source/docs` directories removed, reducing their allocated footprint by **15,241,277,440 bytes = 15.241 GB = 14.195 GiB**. All 226 top-level evidence files retain their original hashes; all source siblings retain their identities/modes. Eligibility was independently confirmed by R2 against finished timestamps, sealed results, exact pinned doc blobs, and no current use. The fixed cutoff was 2026-10-08T23:01:53Z, over three hours before removal.

The [exact cleanup report](/home/sandesh-tiwari/Desktop/C++/synapsor-b51-workspaces/b64-visibility-retirement/docs/development/storage-cleanup-20261009-reviewer2/REPORT.txt), approval, inventory, executor, and per-path verification are privately pushed as `27f3e087`. Filesystem available space increased to 68,176,551,936 bytes; only the per-path allocated reduction is attributed to cleanup, since other lanes write concurrently. No further deletion is performed or authorized by this checkpoint.
