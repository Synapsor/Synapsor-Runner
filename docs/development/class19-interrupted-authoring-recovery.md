# Interrupted authoring: recorded local recovery

An interrupted model request could leave an unresolved generation in Resume.
Normal publication correctly rejected that saved program, but an operator had
no supported way to inspect and dispose of the uncertain result. This change
adds a local recovery adapter to the existing Start, Resume and edit handlers.
It does not accept the interrupted response or mark the request completed.

The operator sees the saved task, retained business state, unknown result and
possible charge. Pause is the initial choice and confirmation defaults to No.
Exact operation identities, checkpoint snapshots and consumed allowances are
available in details. A confirmed disposition freezes the original operation
and appends an attributed record. The project mutation lease and Resume CAS
recheck the complete inspected Read, Action, Source and saved job state before
that record is written. A competing update keeps the recovery pending.

Local review grants no provider allowance. Bounded continuation requires a
provable saved allowance and an exact linked permission. Its old and new
attempts share the original three-attempt chain; the original 6/8 or 12/24
controller allowance and spent correction flags remain binding. A historical
operation without a provable allowance remains fenced for generation. It can
still be inspected and recorded for local current-work review. No counter,
charge, response or uncertainty history is cleared.

Disposed operations cannot later pass transport consumption or Read, Action
and question checkpoint acknowledgement. A recovered generation uses the
ordinary producer, decoder, currentness and save paths; it cannot replay an
old local callback, import a model response, activate authority or perform a
source effect. Existing no-response automatic/manual recovery is unchanged.

If a separately saved Action changed the pending edit's baseline, an explicit
current-draft disposition stores both exact candidates and the original
pending checkpoint. Keeping that candidate proceeds through the existing
Read/dependency review and recompilation path without reinterpreting the
business job. Attached policy reconciliation, publication and activation are
still separate. Rebasing a checkpoint with consumed counters is unavailable
without its own counter-preserving controller; it is not a fresh allowance.

Qualification must distinguish transport-unit safety, public recorded
disposition, bounded ordinary continuation, and complete lifecycle acceptance.
A menu or safe pending result alone does not establish successful onboarding,
editing or a recovered published program. Final settled and installed gates
must run on the integrated revision; earlier passing results are historical.
