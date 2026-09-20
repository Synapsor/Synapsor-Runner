# Worker handoff and blocked-work reporting — bounded closure

Implementer verification completed on 20 September 2026 UTC. **O2 handoff, local
process preflight, P1 reporting, W1 and W2 PASS within the tested scope.** W3's
synthetic renderer controls pass. Terminal blocked-work recovery is **not
implemented**. This is not “P1 fully fixed.” Independent review of this candidate
is pending. Original Stage B remains **ATTEMPTED / NOT PASSED**; independent M4
E2/E3 remain **NOT ESTABLISHED**.

## Exact build

- Canonical branch: `codex/tui-safe-action-control-plane`; baseline delivery
  `63aa6648e49c7eb7b3e5d9589835ac5d21b99346`, retained as ancestor.
- Product and tests: `3a20a24f992e9f0828d2b457ae55daabbb3d512c`.
- Frozen source checkpoint: `904b1e5782828f0448026e78099ef7fb27c989b0`.
- Complete installed tree:
  `33bf5f661c93cbd5a93677ff59b66dd558053a7ed62b054b9544769d84706c5b`.
  All 7,569 file/directory/mode/symlink entries, local Spec 1.11.0, dependencies,
  lockfile and five entrypoints are covered. Runner version is 1.8.0; version
  alone is not identity. See `ARTIFACT.json` and the raw full manifest.
- Product/test bytes were unchanged throughout the successful full suite,
  packaging and final public checks. Later edits affect evidence/harness only.

The independently accepted M6 tree remains
`9ae3a71d4dd5aeac4121b24a6ef6f5ac7b799023cf10242aac79252530fca3ea`.
Its supplied review and bundle hashes were verified. That scoped PASS permitted
the dependent trial; it is not independent acceptance of this new artifact.
M6 default/cancellation/receipt controls were rerun as implementer evidence.

## Change and before/after evidence

The baseline live PostgreSQL reproduction reached guarded apply **after claim**,
then recorded missing trusted context as blocked, attempt 1. The renderer
reproduction established that JSON already counted blocked work; the human
summary omitted it, displayed attempts as `1/5`, and incorrectly called an empty
dead-letter filter an empty queue. Earlier renderer setup failures remain
separate from that product assertion (`status04-before`).

One shared assessment now drives execution-review handoff, the real public
`worker check --supervised` command and supervised startup. It uses the selected
Action config, existing trusted-context/local-identity resolver and exact writer
binding. Store selection is validated first. Applicable local failures stop
before startup reconciliation/sweeps, enqueue, lease, attempt or job writes.
It shows reference names/presence, local-development identity provenance,
configured versus selected receipt mode, selection currency and execution match.
It quotes paths and separates check-only from actual worker startup.

This assessment handles one selected semantic outcome or the single configured
outcome. Unselected multi-outcome and other per-item modes remain explicitly
unassessed; it neither unions unrelated credentials nor invents a global identity.
A passing check does not connect/probe the writer, authorize execution or cache
permission. Existing per-item authority, scope, facts, version, source, receipt,
lease and identity checks remain mandatory. No accounting, retry classification,
queue recovery or receipt engine changed. See `IMPLEMENTATION-NOTE.md`.

Status preserves existing machine fields and reports full matching counts
separately from displayed pages. Completed attempts exclude an in-flight lease;
only durable retry-wait state claims a retry time. Blocked and reconciliation
states do not imply scheduled retry or proven no effect. Separate reads are
explicitly labelled non-atomic. Item inspection remains read-only and cannot
turn blocked work into dead-letter work.

## Final installed observations

| Row | Result and durable oracle |
| --- | --- |
| O2 | PASS: actual 100×30 public execution review named each fixture's current config, renamed writer reference, missing effective identity inputs and separate check/run commands. After supported identity setup, check reported the authentic reviewed default reference and both effective bindings present. |
| W1 preflight | PASS: one normally issued public request produced one approval and a queued item, attempts 0. Omitting only the required writer reference produced check exit 2 and run exit 1, `SEMANTIC_ACTION_WRITER_URL_MISSING`. All 42 control tables, configs, 504 business rows and source receipts were identical before/after. Restoring the legitimate input and running check still left that same item untouched. |
| W1 execution | PASS: a separately invoked finite worker, exit 0, completed that same item on attempt 1. Exactly candidate state → sealed and related slot state → consumed, each version +1; every other row/value matched. One source-db idempotency/semantic receipt and one canonical control receipt were independently read back. The approval was retained. |
| W2 | PASS: a second fresh public request queued normally. The fixture owner then incremented only its candidate version once. Worker exit 0 describes a completed invocation, **not business success**: stored receipt failed with `SEMANTIC_AUTHORITY_STALE`, rows affected 0; queue blocked, attempt 1, proposal failed. No Runner business effect or source receipt appeared. All 504 rows matched the post-owner-change baseline; approval remained. |
| W2 restart/status | PASS: fresh status/detail processes and a 100×30 terminal frame showed one blocked item, one completed attempt, no automatic retry, and the supported inspection command. Dead-letter listing reported “No dead-letter items.” All 42 tables and source/receipt state stayed unchanged around inspection. |
| W3 | PASS, labelled synthetic implementation evidence: mixed blocked/retry/leased/reconciliation/completed states, genuine empty, unmatched filter and bounded pages through actual worker/store status APIs. No extra live business effects were created to manufacture these states. Missing receipt/authority/writer controls remain in explicit deterministic/live gates. |
| Existing blocked recovery | GAP RETAINED: blocked state is not admitted by pending cancellation or dead-letter requeue. No recovery transition was executed. |

`OPERATIONAL-RESULT.json` records counts/table differences. Each fixture ends with
one proposal, approval, queue item, writeback job and control receipt. Ordinary
Read/request/worker audit tables changed legitimately; no whole-ledger byte
identity is asserted across execution. Exact canonical control receipt hashes:

- W1: `8a3c43520bd70a440892c7e4c346fcfe83b5e8e8f921edc9888066fad334aadc`
- W2: `b4028beefe98cea3c14993568528604547e2da46b267b0abef48835c308d94b3`

Source receipt records and worker diagnostic hashes are separately retained;
neither is relabelled as canonical control receipt bytes. This success/readback
test adds no crash, uncertain-COMMIT or universal exactly-once guarantee.

## Gates and attempt history

| Gate | Actual result |
| --- | --- |
| First full suite | Interrupted intentionally for a demonstrated receipt-label correction; child -15 / wrapper 143. Preserved, not a pass. |
| Full stable02 | Exit 1: 15 failed, 6,606 passed, 470 skipped. Thirteen isolated mocked fixtures lacked authority for the new assessor; one asserted old command ordering; one supplied request context but omitted the separate worker's inputs. Exact original failures and narrowly corrected fixtures are retained. No product guards or timing assertions were weakened. |
| Full stable03 | **Exit 0: 6,621 passed, 470 skipped; 320 files passed, 21 skipped.** 1,544.68 seconds; source digest identical before/after. |
| Types-final | Exit 0. Earlier type-error attempts remain recorded. |
| Explicit PostgreSQL worker/receipt/bridge/cancellation gate | Exit 0, 58 passed. This includes real PostgreSQL control-store bridge/cancellation coverage and separately identified PostgreSQL business-source/SQLite-control worker/receipt cases. |
| Explicit codec/freshness gate | Exit 0, 4 passed, 418 filtered: same-repository/forged-bridge and long-running client revocation schedules on SQLite and real PostgreSQL control stores. |
| SQLite lease/status gate | Exit 0, 8 passed, 75 filtered; separate existing expiry-before-lease control exit 0, 1 passed, 79 filtered. |
| Ten offline checks, attempt3 | All exit 0: trusted dependencies, licenses, human command surface, DSL sources, Cursor plugin, MCP configs, local package, bundle freshness, public commands, packed offline installation. |

The full suite used four file workers, existing resource-appropriate 20-second
outer test/hook bounds, isolated HOME, private writable `/var/tmp`, umask 0077,
NO_COLOR and no provider/unrelated credentials. Explicit database gates alone
received the owned test URL. Offline packaging used a copied cache and disabled
network. Earlier source-only packaging attempts are historical, not combined
into attempt3. Every command and exit is retained in the adjacent JSON records;
complete logs are indexed under the raw root.

## Fixtures, budgets and preservation

Both fresh software sources used 116 candidates, 116 slots and 272 checks:
**504 original business rows**, hash
`a6b86b36a7bc56e3e4b9001207b036cf84995848c11cacb069f2928f1de8cbaf`.
No inherited authority, proposals, queue or receipts. Model-free exported typed
drafts, exact terminal Read/Action reviews, public receipt selection, generated
narrow administrator instructions, live writer/rollback receipt verification,
separate default-No execution review and supported local identity setup were
actually executed. Both four-tool clients read their own permitted data.
The baseline rows were independently compared in full before the request schedule.

Preparation errors are retained: ancestor discovery refused before application
launch (fixed by fresh Git project boundaries); an unsupported typed harness
property was removed after public validation refused it; the client harness was
corrected to resolve the generated relative project path; an unsent menu gesture
was removed because a present writer skipped the missing-writer screen; and
baseline arrays required canonical row ordering for comparison. No product or
frozen-artifact edit corrected these. Generated roles collided across two fresh
databases in the same owned cluster; the administrator explicitly substituted a
distinct new W2 role in the reviewed SQL, preserving all grants and the first
role. RLS and business policies were not changed. Receipt infrastructure and
fresh restricted LOGIN credentials were provisioned separately; private values
remain outside Git. Original attempts are not silently replaced.

Budgets were not reset: implementation 4h; preparation 2h; stable/package 2h;
final schedule 1h. Preparation and freezing finished within their recorded
deadlines. Final actual totals: **2/4 requests, 3/8 finite worker invocations,
1/1 effect transaction, 1/1 controlled stale refusal, 0 provider calls**.
The final window began at 05:21:55.996 UTC; observations completed within minutes.

Both complete installations and preserved input hashes were reverified unchanged.
Historical queues were never executed. Dumps, credential-free role definitions,
private complete project archives, logs and table/source snapshots were saved
before the one owned PostgreSQL container was removed. Final projects are sealed
read-only. See `PRESERVATION.json`, `CLEANUP.json`, `EVIDENCE-INDEX.json`.

The exact next decision is in `RECOVERY-DECISION.md`: a smallest audited recovery
path for concrete terminal blocked states, with demonstrated source outcome,
current authority, deduplication and receipt/history preservation. No refund is
implied: committed automatic approvals consume allowance for the existing window
even when execution is blocked. Existing clock assumptions and process/version
coordination limitations remain; this establishes neither production identity,
multi-host durability nor an unseen qualification. **STOP for independent review.**
