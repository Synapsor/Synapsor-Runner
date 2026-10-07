# Read revision checkpoint host

Scope: extract the existing `persistReadRevision` coordinator from boundary commands. Native producers, checkpoint parsers, mutation rollback, exact Source/currentness checks, Resume CAS and final guarded disabled Read save keep their existing ownership.

The caller supplies existing state access and native ports. Dispatch is saved without consumer acknowledgement before I/O. Parent/private prerequisite completions remain real native associations. Ordinary answered clarification appends Source testimony before recomputing context and recording the answer; private prerequisite decisions do not append Source. A parsed result records consumption with retained history, not a saved or active Read.

Baseline at d902: existing revision checkpoint/model tests 95 passed, no failures. Extraction WIP: focused host tests and types still pending. No new persisted shape, budgets, permission or recovery authority.
