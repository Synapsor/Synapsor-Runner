# Read activation impact warning

Implemented on `codex/tui-safe-action-control-plane` from clean baseline `5a5ec376e1b2eb27807471d4ac7ecaa4193b8caf`, retaining manual privacy repair `10769818ce1879f35f227193360606e3bdabd786` and prior accounting/publication repairs. Product/tests/design note: `b7e074db5d4d856737329b2dcfa5dbf7e193881b`. Delivery metadata records the following evidence commit separately.

The missing warning is reproduced with an active Read boundary and two active supervised Action outcomes. Only an unused field's label changes. The original confirmation omits both outcome names; the repaired confirmation names both and explains that each needs an Action recheck, then a fresh writer review before supervised execution resumes.

The shared preview replaces only the candidate's same-named Read boundary in the current active set and calls the existing `unavailableReadDependencies` predicate. The predicate's implementation is unchanged. New pauses are distinguished from already-stale dependent outcomes. An unchanged revision, an unrelated boundary, or absent Action authority produces no new-pause warning. Unreadable authority produces a sanitized unavailable assessment.

Interactive direct/manual/conversation confirmations, signed headless activation, review-bundle exports, Workbench preview/activation and Quick Start presentation reuse this display. JSON/headless warning text goes to stderr; impact metadata is outside canonical review bundles, signed decisions and activation records. Workbench's automatic preview-to-activation routes pause at a plain-text impact confirmation. Cancellation preserves existing authority.

No dependency pin, Read/Action digest, execution binding, runtime tool, policy or permission behavior was changed. After the test activation, Action authority/registry/digest are identical to their prior values and the normal runtime refuses `app.request_change` with `SEMANTIC_ACTION_UNAVAILABLE` before reading facts. Action recheck and writer review are still separate operator operations; the warning performs neither.

## Verification

| Check | Actual result |
|---|---|
| Original confirmation replay | Two expected failures: affected outcomes missing |
| Five complete affected test files | 445 passed; exit 0 |
| Guided start and authority codec | 292 passed, 175 PostgreSQL opt-in skips; exit 0 |
| Final six composed cases after test-only type correction | 6 passed; exit 0 |
| Final workspace types | Exit 0 |
| Trusted-core dependency boundary | Exit 0 |
| Offline local package smoke | Exit 0 |
| Public checkout command checks | Exit 0 |

The seven complete file runs cover 737 distinct passing tests on identical product code. They are **not** a full monorepo-suite result. The final test-only correction uses the actual review bundle's mutation bindings; its six affected cases were rerun. Existing real PostgreSQL gates were not enabled, and no external business database/provider was used. No new frozen installation or Stage A/B qualification is claimed.

`ATTEMPTS.md` classifies all earlier setup, measurement and test-type failures; their original logs and exits remain intact. `*-result.json` files contain exact commands, environment, timestamps and log locations. `raw-evidence-index.json` hashes the completed logs; `source-files.json` binds final changed source/test bytes. The owned root contains the complete final source snapshot, earlier snapshot and original boundary-command implementation used for replay.

Tests run with existing dependencies, private HOME and writable /var/tmp, NO_COLOR, umask0077, network isolation and no provider/unrelated credentials. Fixtures and loopback test servers belong to these tests. The snapshot warning adds no synchronization guarantee: concurrent changes may stale it; existing activation/runtime guards remain authoritative. No worker or real writer recovery campaign was introduced.

The original frozen tree `4cdd9cd65389a57de238c07775ca9bb22d824bccf9cf9dd8a1e1adb9e2b44284` reverified unchanged across 7,569 entries. Historical evidence/queues/installations were not run or modified. Stage A remains historical and artifact-specific; original Stage B remains ATTEMPTED NOT PASSED.

See `REVIEWER-HANDOFF.md` for the bounded reproduction and command index. Delivery is only to the verified private `backup` remote. Final delivery metadata is retained in the owned root's `delivery.json`.

Verification completed within the declared budgets (development began 16:30 UTC; final command gate completed 17:02 UTC). All test/gate processes returned their actual exits. Owned test servers were closed by the fixtures and package smoke directories by their normal cleanup. Logs and both source snapshots were retained before delivery; no old evidence directory was removed.
