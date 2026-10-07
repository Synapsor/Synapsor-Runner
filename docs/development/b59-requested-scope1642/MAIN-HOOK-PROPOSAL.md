# Unapplied B59 final-consumer hook proposal

No boundary-commands.ts or B60-owned evidence edits have been made by this lane.
This is a design seam for Main's serial integration, not an accepted patch.

Current d9f main flow already forwards complete `jobIntent` through
`operatorNamingContext` into Read mapping; Resume retains that original separately
from `read_intent`. No new Resume field is needed for this preservation.
`currentPolicyCoverageDraft` (boundary-commands.ts around 6977) and the saved-source
review equivalent (around 12317) pass the candidate, Source and accepted
clarifications, but do not explicitly bind the original job or selected workload
analysis as a distinct final-review input. Model history is not a durable guarantee
that every final consumer sees the entire request.

Proposed minimal interface, pending Main/B60 review: add a transient requested-Read
evidence value to `policyCoverageDraft`, built from existing original job text and
exact current saved workload analysis when available. The ordinary host supplies
`jobIntent`; the Resume host supplies `resume.job_intent` and loads its exact
`resume.read` analysis through existing binding validation. Preserve absence as
unavailable, never fabricate a scope list or infer acceptance for a legacy record.
Include original text, actual workload identity/digest and current candidate binding
in the draft digest. Model-facing text must distinguish original operator evidence
from proposed plans/labels and from already reviewed authority. Do not append a
fake Source passage or mark whole policy fulfilled from resource counts.

This does not solve semantic completeness by itself: native review must compare
actual final access with the original request and attached Source, preserve genuine
unresolved meaning, and keep separate default-No save/activation. A new model
response field or persisted provenance variant would require a separate concrete
compatibility design; none is introduced by the current WIP.
