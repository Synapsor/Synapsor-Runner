# B59: retained request and Read routing summary

Status: characterization WIP; no runtime repair or qualification claim.
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
Reviewer2 public preseal is pending; private oracle is not an implementation input.

Initial declared-facts control separates seven actual inspected areas from an
active-offer summary paraphrase and keeps the existing 500/501 boundary. These are
unit fixtures, not a reconstruction or verdict on the paid incident. Planned
additional controls cover actual omitted/excluded/unrequested areas and another
schema, then original-request/Resume preservation. Characterization runs only
after an own source-fresh build in isolated outside-home HOME/TMP with a populated
decoy and plain 8GiB free floor; no database, provider, or full suite.
