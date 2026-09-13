# Quota interpretation, semantic receipts and merged 1.8.0 verification

The two named integration repairs are implemented. Fresh **known-case** tournament and software runs reached actual execution receipts and completed their planned ordinary-language edits on one unchanged merged installation. Two tournament recovery paths and four additional PostgreSQL recovery-UI tests remain stopped failures. This is not a blanket pass: **Original Stage B remains NOT PASSED**, and historical Stage A acceptance still applies only to its previously accepted artifact.

The complete row-level verdict is [final-scorecard.json](final-scorecard.json). Earlier checkpoints, unsuccessful attempts and their verdicts remain preserved.

## Exact source and package

- Baseline: `454a0d29c0c2f5fbaec9b883a54ee0df2cff3a60`, retaining product `dba1800d069406e6d1e45ce3ef4e19721ef76617` and frozen source `7eef52206b2c43ae9c88c1b3760cc1ddf6d6529d`.
- Quota repair: `d7c4e0162eecbb29098dec2b4c7169fb8dd7ff5e`. Receipt integration: `c3c35d19a1b7a60d91aa3b599dd03cb4b8817197`. Final product correction, forwarding the explicit control-store environment in the new receipt lookup: `eda73ae035272335f70507824e9ee0250e9ff97c`.
- Finding 9 merged with both parents retained at `48728e01ab16c59742a45e0020e65801e6884bf5`. Its branch remains at `7431f89ad0c05d927e23c5241be6788249d0a536`, containing counter product `811ed6a33a00d113c5c35d5f3a10c4fa9363dc66`. Help deliberately retains both `--review-counters` and the receipt setup options; neither side was taken wholesale.
- Frozen source/evidence checkpoint: `fbf5efdab77fa5011544524592d58fa007388e95`. Later delivery commits contain qualification harnesses and reports, not changed product behavior.
- **Installed tree: `432ed6f05baa07c0d755b3b569ea45ae0b2972cdabcca5cb218ca344234b70ef`**, 7,569 entries, Runner 1.8.0 and local Spec 1.11.0. Full manifest hash `3c4e309471338d89ca90e74eb21d9067f72cd6b8fe505d17082e2fa909ff8487`; complete archive hash `748500f796d89494e91f3a62c4ca69b2e7dfd3d623130ae9033e1ce1e7bcdfb1`; lockfile hash `8de5486a4232f127bdce4ad739c7543c6e7e11e19c8d85366ec258e93bdd45d6`.

[final-installed-identity.json](final-installed-identity.json) records dependencies, package hashes, Node identity and entrypoints; the complete manifest is adjacent. The installed tree was recomputed before launches and after both public runs, including file modes and symlink targets. The unrelated `.claude/` directory observed during freezing was excluded from packaging and was not read or removed by this task. No frozen installation was patched.

Finding 9's prior installed qualification does not transfer to this tree. Its 126 saved evidence files and branch are unchanged. Its result remains **implementer-owned, pending independent acceptance**.

## What changed

The quota guard conflated a role glossary with a limiting requirement. In the traced composed call, “each principal is an assigned referee” led to a correction demanding `tenant_principal` accounting despite the actual policy specifying only six overall and two shared by the tenant. `action-policy-scope.ts` now locates limiting clauses and applies ordered, explicit operator decisions; `action-rule-model.ts` uses that distinction when preserving requested scopes. A role keyword or “each” is insufficient. Genuine per-principal requirements, cross-sentence requirements, negations, explicit changes and unresolved ambiguity retain their tests and bounded clarification behavior. Prior generated repair prose and an unwanted disabled cap do not become accepted operator policy.

The earlier quantified-definition checkpoint fix is retained. It is a different guard from downstream quota interpretation. Mixed private-value tests remain enabled. Before/after material and the reproduced call are in [authoring-context-before-after.json](authoring-context-before-after.json). No fixture names, domain exceptions or rescue sentences were added to product prompts; no prompt template was changed.

Semantic source writes previously appeared not applicable to receipt setup when no legacy proposal capabilities existed. The new shared execution handoff exposes the saved receipt requirement and an exact operator-reviewed selection. `action review` → supervised execution setup and `writeback setup` share this record. CLI preview accepts `--outcome`, `--receipt-mode`, `--write-url-env`; saving requires `--save-selection` and the exact displayed confirmation. Selection stages deployment requirements without changing active execution, source objects or business authority.

Source-database mode uses the existing `source_db`/`precreated` engine. It requires the reviewed source relation, narrow writer permissions, actual source/writer inspection and a rollback receipt probe, followed by separate execution review. It never silently substitutes Runner-ledger receipts. The binding includes the project/deployment, source, effect, Read contract, saved policy context and writer reference. Relevant changes require renewed review; ordinary approval-limit edits retain the exact receipt selection. Preview does not prove readiness. Legacy no-write and Runner-ledger paths remain covered.

The public handoff generates the existing receipt migration and narrow grants, never applies them. In software the owner reviewed and applied only the generated receipt infrastructure and dedicated role grants, then separately enabled local LOGIN. Existing UUID tenant/principal RLS was already applicable to the new role. No policy, business fact, private eligibility rule or reader permission was changed to obtain compatibility. The generator's inability to synthesize a policy repair was recorded; subsequent actual writer verification established the applicable fixture prerequisites.

## Automated verification

All commands, source manifests, timestamps and actual exits are preserved in their `*-exit.json` records and raw logs. Stable source was not edited while its suite ran.

| Check | Actual result |
|---|---|
| Initial full suite | Exit 1: 6,177 passed, 14 failed, 461 skipped. Preserved, not combined with reruns. |
| Corrected stable full suite | **Exit 0: 6,203 passed, 461 skipped**, 298 passing files and 21 skipped files. Whole suite completed. |
| Final types | Exit 0 on the same source manifest. |
| Final offline/package sequence | All 10 commands exited 0: trusted core, licenses, human commands, DSL sources, Cursor plugin, MCP configs, local package, bundle freshness, public commands and packed offline installation. |
| Merged structured/boundary/scope/deployment group | Exit 0: 523 passed, 1 skipped, before the final narrowly scoped environment-forwarding fix; final full suite also covers normal discovery. |
| Merged Finding 9 focused regressions | Exit 0: 33 passed. Both focused files run after merge. |
| Final live PostgreSQL gate | Exit 0: 42 passed across three files. SQLite and real PostgreSQL control-store accounting/publication are distinguished from PostgreSQL business-source/SQLite-control receipt-engine tests. |
| Additional PostgreSQL explicit-environment recovery UI | **Four failed cases remain FAILED**; see below. Twelve selected current-path cases passed separately. |

The first full suite exposed test prerequisites that still expected the pre-selection flow, plus a real interactive callback-cloning defect reproduced separately and corrected in the receipt change. Original failures and focused correction results remain available. The declared one full run plus one demonstrated-correction rerun were both consumed; no further full-suite restart was hidden. The 461 normal skips do not replace the explicitly executed backend gate.

The final-source live receipt tests retain the candidate-plus-slot engine, receipt-persistence-failure rollback, replay and accounting/publication controls. The prepared public software deployment additionally proved a trigger-observed failure after both effects followed by rollback of both business changes and the new source receipt. That prepared run used historical development tree `0deb78b36ba762be1d8c05d437abe30c42a67a53b512523da9af8b1605dbf3ad`; its installed result is not attributed to the final tree.

## Public known-case results on the final tree

Fixture manifests confirm **104 tournament rows** (8 events, 96 results) and **504 software rows** (116 candidates, 116 slots, 272 checks). [fixture-baselines.json](fixture-baselines.json) records the original row and input hashes. Fresh preparation preserved every original business row. Only separately reviewed receipt infrastructure/grants were added for software.

| Named path | Tournament | Software |
|---|---|---|
| Fresh model-assisted authoring | 39 calls, original policy, public exact reviews | 34 calls including one failed TLS call; original policy, public exact reviews |
| Deployment | Explicit Runner-ledger selection, generated narrow writer, unchanged reader rescan, separate execution review | Explicit source_db selection, generated receipt objects/narrow writer, unchanged reader rescan, actual writer/probe and separate execution review |
| Client | Reviewed local default identity, own 24 rows, exactly four tools | Reviewed local default identity, own 29 rows, exactly four tools; own-context positive after a new MCP process also passed |
| Actual execution | R01 ratified/version+1; canonical applied receipt, independent readback | B01 sealed and its slot consumed, both versions+1; actual source receipt plus control audit copy, independent readback |
| Replay | Same original request and stored receipt, no extra effect | Same original request and stored receipt, no extra effect or source receipt |
| Valid human-review case | Championship R17 routed to review, separately supervisor-approved without execution | Valid 300-second B19 persisted pending review; supervisor execution not tested |
| Invalid/private controls | Invalid scores, integrity hold and closed event refused; private fields refused | Excess duration, failed/pending/too-few/overflow checks, hold and unavailable slot refused; private field and check collection Read refused |
| Ordinary-language edit | Tenant allowance 2→1 only; overall 6 retained | Automatic duration 120→60 only; eligibility 600 and overall/tenant 8/3 retained |
| Edit pause/resume | Disabled checkpoint, public publication and separate execution re-review | Disabled checkpoint, public publication and separate execution re-review |
| Same connected client after edit | Fresh R02 eligible but human-review pending | Fresh 90-second B18 eligible but human-review pending; a separate normal client still auto-approved 40-second B03 |
| Retained history / old work | Earlier automatic and human approvals and receipt retained; current worker did not dispatch old R17 | Earlier approvals and source/control receipts retained; current worker did not dispatch old 90-second B17 |

Tournament used 8 reserved edit calls and 15 runtime provider calls; software used 8 edit calls and 11 runtime calls. Both persistent runtime sessions spanned publication. Each used two finite worker invocations: one actual effect and one old-work non-dispatch check. Existing worker concurrency remained one. There was no measurement or claim of simultaneous effect transactions.

Tournament receipt-byte SHA-256 is `85c9b6dae585fee7a4d2b0b62ef842b04423e05793e38d93b13e6e6f8855e649`; software control receipt-byte SHA-256 is `eea142cc958f75ac97a4c4291f821fde46ac4b3534674197e03a3f48221f1dac`. Independent source receipts are separately retained, not equated with control audit copies or worker diagnostic hashes. See [fresh-tournament-summary.json](fresh-tournament-summary.json) and [fresh-software-summary.json](fresh-software-summary.json) for exact stored records and raw-file hashes.

Source receipt mode and writer/source bindings survived the software edit unchanged. Both edits changed only the requested business value plus derived digests/timestamp metadata. Old queues were still inside their 86,400-second queue TTL, not merely expired 300-second discovery references. No already-dispatched behavior was exercised or changed. No cancellation, refund or requeue was added.

These runs required coordinator operation and exact policy inspection. Tournament included engineering explanation separating compiled policy from pending infrastructure work, and a repeated all-writers counter confirmation. Software used owner-sheet counter, synthetic-resource and organization/coordinator answers. One software TLS bad-record-MAC response was saved, then resumed once within the original 50-call/75-minute budget. Tournament's zero-call runtime startup harness failure and a post-edit JSON-object measurement correction are preserved separately; neither changed product behavior or the original runtime deadline. The runtime model also gave an inaccurate description of software's slot effect; the governed atomic update and stored records, not that description, establish the result.

[trial-measurements.json](trial-measurements.json) retains per-command elapsed times, provider waits and incomplete captures. These include coordinator pauses and are not human usability measurements. Hands-on time, exact first fully reviewable draft and exact time-to-first-verified-receipt/edit are unknown. [review-cycle-observations.json](review-cycle-observations.json) records 12 tournament and 10 software policy-interpretation/recheck submissions, including 2 and 4 adjacent repeated coverage-topic submissions respectively. These are model submissions, not a measured count of accepted operator review cycles; that exact count is unknown. Fewer calls are not evidence of usability. Original add/remove qualification rows remain **NOT RUN** for both cases; no unseen case or complete new Stage B attempt is claimed.

## Stopped results and next repair decisions

1. **Authoring recovery correctness:** original tournament recovery reached the correct 6/2 quota set, then generated “tenant: maximum 2” triggered the existing literal-identity checkpoint guard. Five calls, no authority/effect; exact installed failure and punctuation control are in [remaining-checkpoint-prose.md](remaining-checkpoint-prose.md). Assisted recovery removed the unrequested principal cap, but added capability selectors to the two existing limits without the required exact acceptance. Sixteen calls (15 complete; final review cancelled), no activation/effect. [assisted-recovery-verdict.json](assisted-recovery-verdict.json) and [assisted-first-saved-diff.json](assisted-first-saved-diff.json) preserve that mismatch. Neither is an exact-recovery pass; no additional rescue loop or product patch was attempted.
2. **Explicit PostgreSQL review environment:** four `control-policy-authority-codec.test.ts` cases for disabled/revoked/revoked_execution/revoked_unconfirmed Read authority still fail to open saved-job recovery review because an older caller loses the supplied `TEST_POLICY_URL` environment. Expected inspectable recovery; actual missing-variable refusal. The omission is present in saved baseline source, but an unchanged-baseline test was not run. [remaining-postgres-review-env.md](remaining-postgres-review-env.md) contains the exact reproduction and diagnosis boundary. Independent passing gates do not overwrite it.

## Preservation and limits

All originals passed final comparison: **145,974 entries, zero changed or added**, including the separately acknowledged independent FINDINGS update from before this assignment. The prior `240f6c...` and accepted `278b66c...` installations remain immutable. All owned source containers were saved with logs and database dumps, then stopped without removal; saved queues were never used as execution fixtures. The test PostgreSQL container had zero other client backends before stopping. No unrelated resources were stopped.

Private writable `/var/tmp`, `NO_COLOR=1`, controlled HOME and umask 0077 were retained. Provider credentials were absent from database gates and public operator commands; authoring/runtime providers received only their scoped authorized configuration. Source-owner credentials and concrete identity values were not put in authoring conversations or committed.

Existing admission-time assumptions remain limitations: timestamps follow all admission coordination and the database writer lock; no backwards-clock, unsynchronized-process-clock or mixed-version tolerance is established. Cooperating admission/publication processes must run the compatible code and be restarted together when upgrading. Committed approvals consume rolling allowance even when later execution blocks; history is not refunded. Local reviewed identities are not production authentication. These results establish neither multi-host durability, universal exactly-once execution, self-serve onboarding nor production readiness.

Delivery is solely to the verified private backup remote on `codex/tui-safe-action-control-plane`. [REPRODUCE.md](REPRODUCE.md) and [owned-raw-evidence-index.json](owned-raw-evidence-index.json) locate commands, fixtures, exact oracles and the immutable package for the separate verifier. **STOP for review.**
