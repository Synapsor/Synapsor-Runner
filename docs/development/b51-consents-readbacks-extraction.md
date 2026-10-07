# B51 slice 6: Input and Version presentation

This slice extracts the existing Input and Version question, attributed readback,
and saved-pending presentation from `boundary-commands.ts` into
`authoring-question-presenter.ts`. The two inline callbacks are removed and the
production composition calls the new adapters. The adapters render existing
typed views and return the same binding, literal raw answer or explicit decision.
They have no generation, persistence, authority or admission ports.

The existing Input/Version hosts and controllers remain the lifecycle owners.
They retain currentness after waits, cancellation, raw-answer persistence,
mapping, Source append, Resume CAS, consumer handoff and finite budgets. No
saved format or permission changes. Activation, technical administration and
the other consent families remain outside this bounded extraction.

Stage differences stay explicit. Input shows its exact question material, splits
question text for chat and has its existing terminal fallback. Version performs
its explicit check before question display and readback, streams one text item
and uses the chat reader. Both preserve whitespace, avoid registering policy
answers at the reader, retain default-No and exact attributed readback details,
and keep the saved decision pending unless the operator chooses Answer. Input's
unanswerable pending state remains a local explanation and Keep, not a new ask.

The shared private readback helper only renders these existing bounded business
readbacks. It does not replace either host's binding/currentness checks or add a
generic consent engine. The existing business context transforms the primary
display; optional exact details retain the literal lines unchanged.

Baseline 8eb8a88ebbc21495d2d5828328e44f6860b3f14f characterization: 88 pass.
After extraction: 114 pass, comprising the unchanged 76 logic tests, 7 chat
controls, one different-schema ordinary public Input Resume route, four ordinary
public Version routes, 25 new presentation contracts and one real Input terminal
sample. Existing expectations and model-call counts are unchanged. Typecheck
and trusted-core dependency checks pass. All owned processes are closed and
source/dependency/generated manifests are unchanged across execution.

The public Input and Version routes invoke the new production presenter through
`boundary-commands.ts`; injected-interact cold-host fixtures are not adoption
proof. The terminal sample uses genuine ordinary public unanswered preparation,
then default production IO and real Escape/Enter keys. Cancel captures no raw;
default-No retains the raw/proposal without confirmation; default-Keep retains
the exact saved question and counters. Source bytes and inactive authority stay
unchanged. No provider, HTTP responder, database, publication or activation.
Version physical terminal/cold-process presenter adoption is not claimed.

Detailed seals and raw results:
[slice evidence](</home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/authoring-reliability-20260930/authoring-dead-end-lab-20261002/operator-conversation-470/b51-consents6-dev1579-v1/AFTER-RESULT-SEAL.json>).
Independent Reviewer verdict and this slice's ONE full8 gate remain pending;
the heavy gate is held until candidate2 freeze gates finish. This branch is
separate from candidate2 and the frozen demo; no acceptance transfer is claimed.
