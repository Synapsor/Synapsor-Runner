# B59: retained request and Read routing summary

Status: runtime WIP plus bounded native consumer controls; independent/integrated qualification pending.
Base: d9f8635509a32093ae952314175f21116ef2faa9. Owner start 2026-10-07T21:51:08Z;
scope cutoff October 9 at 21:51:08Z; completion cap October 10 at 21:51:08Z.
Paid calls remain closed. Candidate3 and accepted B48 artifacts are unchanged.

## Observed ownership

- `boundary-job-model.ts` bounds create summaries to 500 characters and revise
  instructions to 2,000. It also compares summary keywords with resource mentions
  extracted from the original request. This second comparison can misclassify a
  harmless paraphrase as omitted scope. It does not establish semantic omission.
- `boundary-commands.ts` retains `job_intent`, saves the routing `read_intent`, and
  uses that summary as one `allowed_questions` entry. It separately passes the
  complete original job as `operatorNamingContext` to Read mapping.
- `boundary-authoring-resume.ts` signs, validates and restores both existing
  fields. Recovery and Source edits retain their native CAS/history ownership.
- `read-workload-model.ts` binds original context, questions and Source in its
  input/meaning digests. It checks explicit requested fields against actual plans;
  representative-question coverage alone does not establish area completeness.
- `boundary-job-operation-contract.ts` excludes Read intent from review-only
  routing. Reuse/resume still require exact actual resource inventories.

## Intended contract and bounded work

A short summary describes routing; it neither withdraws requested reads nor grants
additional access. Preserve original operator text and existing structured plans.
Validate actual requested scope against inspected resource identities and reviewed
mappings at the workload boundary. Unknown or ambiguous meaning stays a native
business question. Do not add lexical synonyms, expand limits, truncate meaning,
or invent a second authority store. First assess reuse of existing typed records;
any necessary additive persisted provenance requires explicit compatibility review.

Own modules: planning/request-scope helpers and their tests. `boundary-commands.ts`
is Main's B60 hotspot: read-only here; submit a separate minimal host-hook proposal.
Reviewer2 public contract is available; private oracle is not an implementation input.
The disclosed private-case exposure below requires replacement independent controls.

Initial declared-facts control separates seven actual inspected areas from an
active-offer summary paraphrase and keeps the existing 500/501 boundary. These are
unit fixtures, not a reconstruction or verdict on the paid incident. Planned
additional controls cover actual omitted/excluded/unrequested areas and another
schema, then original-request/Resume preservation. Characterization runs only
after an own source-fresh build in isolated outside-home HOME/TMP with a populated
decoy and plain 8GiB free floor; no database, provider, or full suite.

## Actual characterization

Own source-fresh d9f bundle/type/freshness closed 0. Planning baseline: 68 pass,
1 expected failure; the declared active-offer paraphrase consumed the existing
correction and still failed lexical completeness. Original 500/501 checks passed.
A separate actual workload producer control demonstrates the converse: all seven
areas are in the retained original request and summary, but six valid plans are
returned as ready when the offer workload is absent. Its first two setup failures
(missing required synthetic catalog arrays/maps) are preserved separately; only
v3 reaches the missing-workload assertion. These are historical before-fix captures;
the subsequent runtime WIP and controls are recorded in DEV-RECORD.json.

Main initially mislabeled the reviewer's ce332 private case file as public. All
15 B59 case bodies were read after the initial declared-facts fixture/run. This
was reported immediately; those cases cannot count as hidden acceptance and must
be replaced by the reviewer. No private case was used as a responder input. The
correct public contract is candidate4-public-preseal-contract.json, SHA256
2f818efcbbbb6bed37769aa3800ae3b4b79e56574fb8dbfd1fe71a4235b13a04.

Native logs/results and current compact record are retained externally under
`b59-requested-scope1642` in the existing qualification evidence root. Tests use
only declared synthetic metadata and the actual transmitted production request.

## Current bounded proof and remaining semantic seam

The implemented summary repair keeps the 500/501 and revise-2000 limits. Actual
allowed plans, rather than summary prose or forbidden examples, must cover the
identities unambiguously named by the retained request. An entire literal
`Read only <inspected IDs>` request also bounds additions. These are deterministic
lower/upper checks for that syntax, not a natural-language policy engine.

The native consumer supplement checks four private-field operation classes
(selection/filter/group/measure) against an already declared disabled candidate,
while the complete approved Source exclusion remains in the actual wire. All four
return blocked analysis, no accepted-result checkpoint, no query/write/authority,
and unchanged candidate. It does NOT prove that arbitrary English Source
exclusions were converted to candidate restrictions, nor a new permission UI.

The saved ambiguous question has both same-target success and different-target
refusal through the real producer correction limit. Its root association and raw
answer are retained; changed original context refuses before another handler/send.
A nonunknown raw answer attached to a resource does not by itself establish its
semantic truth. The native naming-evidence and final policy review remain necessary.

Existing actual native controls additionally distinguish approved Source and saved
operator answer from an unapproved attachment, model summary, model question or
model answer. Labels alone cannot suppress an opaque-field question. The latest
focused command selects these eight existing controls plus 13 current scope
controls: 21 pass; 124 unrelated cases filtered, not qualification skips.

Literal resource coverage cannot prove that an opaque/renamed inspected object
means a requested business area, that a paraphrased area was omitted, or that an
arbitrary exclusion was honored. Reuse `hostMeaningsFor`/`findReadMeaningEvidence`,
actual native clarification and exact current Source provenance for mappings;
never treat the model's proposed ID or catalog label as operator approval.
Main's final-coverage hook must bind the original job and exact saved workload
analysis/candidate to its transient review digest. Their semantic comparison,
ordinary default-No decision, CAS and disabled-save/activation boundaries remain
native. No persisted authoritative mapping or new store is proposed here.
