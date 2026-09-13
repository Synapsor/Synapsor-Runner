# Deferred harness checks while stable source is frozen

Do not edit code during stable-full. After that exact process exits, before
freezing/running installed fixtures, finish these measurement assertions:

* A1: identify its new canonical proposal by ledger difference (already corrected
  missing response-ID equality). Assert the new stored receipt belongs to it,
  status applied, rows_affected1, semantic_verification reverified, and record the
  actual receipt_hash. Independent row readback remains mandatory.
* A3: correlate operator process/result PIDs and record source transaction states.
  Existing worker concurrency is1. Start the second worker while the first is
  observed blocked; observe its result under that limit before releasing the
  owned blocker. Report actual serialization/overlap, never infer simultaneous
  source transactions from two Promise calls. Keep drain/readback/receipt checks.
* Exact automatic edit: after real operator publication compare authority catalog,
  rule/verification/effect source (ignoring activation timestamps), and approval
  class semantics. Only the existing tenant limit maximum3->1 may change; overall8,
  window86400, inputs/threshold/private collection/effects stay identical.
  The prepared request driver uses an existing byte-preserving fact-response hold.
  Prepare the normal Action review up to its final confirmation before starting
  this20second publication schedule; do not stretch normal request timeouts.

These are measurement/harness work, not additional product repairs. The installed
artifact does not exist yet; all copied scripts are prepared, not executed.
