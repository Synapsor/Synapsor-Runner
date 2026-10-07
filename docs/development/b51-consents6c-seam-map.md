# B51 6c: AI-egress consent seam map

Read-only characterization at `6590dc82c3d5808eeeaa15a8826e3ae8944ac9bf`
(6b extraction in independent review). No product edits or test execution in
this lane. Reconcile anchors with accepted 6b before implementation. Candidate 2
`8eb8a88e` and its frozen artifact are outside this worktree and unchanged.

## Bounded extraction

Move metadata-egress and complete-policy-attachment presentation into typed
views/adapters alongside `authoring-question-presenter.ts`. Reuse existing
session/chat ports; do not introduce a consent engine, new controller, model
request, saved format, authority flag or permission cache. Existing hosts still
decide whether a consent is required and what an answer permits. Display returns
the existing literal decision, including cancellation/undefined.

| Existing owner / anchor | Presentation seam | Ownership that stays |
| --- | --- | --- |
| `boundary-commands.ts:5102` `confirmModelEgress` | Provider/destination, concise prompt/context, exact detail lines, default-No | Load current private Read mapping; compute digest; after-wait reload/compare; reject changed mapping; update host digest; separately request policy transfer |
| `boundary-commands.ts:5392` saved consent reuse | Existing saved-permission detail record | Exact saved job/provider/model/destination/mapping checks, rescan invalidation, `modelEgressAcknowledged` and Resume persistence |
| `boundary-commands.ts:5420` declined metadata route | Existing local continuation options | Cards/review/change-model/pause transitions; no automatic request or fresh permission inference |
| `authoring-policy-source-ui.ts:43` preview | Full numbered local text, name/version/bytes/lines/digest, untrusted-context notice | Read literal path/paste; validate bounded complete snapshot; keep text local before explicit send |
| `authoring-policy-source-ui.ts:50` `replace` | Review checkpoint; send/view/cancel menu; ready checkpoint; optional review/continue menu | Local preview loop; exact snapshot/destination approval; Source save before memory update and `onChange`; explicit existing draft review callback |
| `authoring-policy-source-ui.ts:157` `reviewTransfer` | Same attachment-consent view when needed | No extra prompt for exact approved digest+destination; destination change requires consent, not another attachment version |

The first product diff should extract these views and rendering callbacks and
remove their old inline bodies. It must not relocate unrelated `/rules` removal,
coverage interpretation, Source-answer recording, or activation logic merely
because the same file contains them. If including the local continuation menu
would widen the diff, leave that host-owned menu for recovery work and document
the remaining inline surface.

## Exact contracts to characterize before extraction

* Metadata and attached text are two permissions. Metadata Yes does not authorize
  an unapproved attachment or a replacement destination. Metadata No/EOF leaves
  model generation unopened. Exact details remain available before the decision.
* Metadata view includes the complete existing private Read metadata/meaning
  and its fingerprint when present; no additional Source sampling or values.
  Renderer gets already-established data, never a database/provider capability.
* Host checks mapping currentness **after** the operator wait. Presenter must not
  move or swallow `PRIVATE_READ_METADATA_CHANGED`, update the digest early, or
  turn a declined second gate into a successful first-gate continuation.
* Saved consent reuse is conditional on the existing Resume binding and selected
  model; OpenAI-compatible destination and private mapping digest have explicit
  checks. Preserve existing rescan/revalidation behavior; do not broaden reuse.
* Attachment preview stays local, complete and numbered from 1. Send is never
  the default: menu initially selects Cancel. Preview returns to the same gate.
  Existing local `chooseOption` deliberately bypasses model permission narration.
* Explicit Send persists the snapshot and exact digest+destination approval,
  then calls `onChange`. Permission is neither activation nor policy correctness.
  Cancel/EOF preserves the old snapshot, draft, approvals and authority.
* Optional review of an attached policy remains a second explicit decision,
  default Continue. Its callback and `reviewed` return stay host-owned.
* `authoring-policy-source.ts:354` owns destination normalization; `:367` owns
  UTF-8/size/line/version validation; `:410` owns exact approved transfer history;
  `:439` owns persistence/concurrency. Presenter must not duplicate those rules.
* Resume restores the protected snapshot, not the old filesystem path. Missing
  Source recovery and answer-history/CAS handling remain in current owners.

## Existing evidence to reuse, not manufacture

| Existing tests | Actual coverage visible in source |
| --- | --- |
| `authoring-policy-source.test.ts:142` | Cancel replacement, changed-destination reconsent, retained overrides/removal |
| Same file `:211`, `:224`, `:244`, `:262` | Complete history; exact snapshot despite changed/deleted original path; invalid input refusal; new-version consent and byte integrity |
| Same file `:323`, `:346`, `:357` | Real chat adapter local preview/no permission-guide call; first-job attachment wording; preview→same gate→cancel |
| `read-prerequisite-revision.test.ts:17` | Ordinary public Boundary route displays saved private mapping before permission; allow/decline; zero mapper/narrator when job prompt cancels |
| `boundary-authoring-resume.test.ts:495`, `:506` | Destination/private-metadata digest integrity and rescan invalidation |
| `boundary-cli.test.ts:10530`, `:11085` | Model replacement requires new metadata review |
| `authoring-public-input-resume-withheld.test.ts`, `authoring-public-policy-wait-derived.test.ts` | Existing public nested attachment/cancel routes; select affected cases after reading their sealed controls |

These are source-inspected controls, not new PASS claims. The metadata test's
model-free cancelled job is not positive producer-egress proof. Main1593 used
the real compiled policy assembler/attachment callback through isolated
diagnostic exports; it is useful disclosure characterization, not a public CLI
adoption proof for 6c. Tester owns installed candidate-2 wire admission.

Before 6c implementation, preseal a small matrix with the independent Reviewer:
metadata accept/decline/EOF; absent/present private mapping; mapping changed while
waiting; saved same destination vs replacement/rescan; local policy preview then
cancel/send; exact approved transfer reuse vs new bytes/destination; optional
review decline/accept; return from nested attachment without accepting a stale
parent default. Use declared synthetic policy/metadata and model-visible inputs
only. Tests should assert bindings, defaults, absence/presence of calls, saved
state and next step rather than exact prose. Preserve literal target/detail
checks where those are the permission contract.

There is no direct test mention of `PRIVATE_READ_METADATA_CHANGED` in the
searched runner test files; add a targeted after-wait characterization or identify
equivalent existing coverage before claiming that boundary. This is a coverage
item, not a reproduced product defect. Keep small actual public chat/terminal
samples for adoption; test most combinations below the UI.

## Boundaries and next step

Do not touch `installPermissionGuide`, activation semantics or
`activationChoicePresentation`: those belong to 6d, where structured activation
views replace string rewriting. Observed-value egress, runtime Source access,
budget/retry policy, B50 wording and B51 editing are also outside this slice.
No historical evidence is relabelled; STOP1570 remains UNCLASSIFIED.

Next: after 6b acceptance, reconcile this map to the integrated pin, preseal
characterization and Reviewer variants, then perform one bounded extraction.
Use isolated resources, focused tests and types first; the normal single full8
DEV gate follows review. Tester/Luna retains priority and its applied deadline
is 2026-10-08T05:00:00Z with the unchanged cumulative $20 ceiling.
