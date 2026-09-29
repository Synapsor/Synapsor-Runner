# B33 forward design — not implemented or accepted

This design is preserved alongside executed failing-before controls. It does not resolve the authentic legacy checkpoint and is not a release candidate or a paid-lane authorization.

## Actual affected path

`runAskProviderTurn` records handled transport completion before returning the typed ask result. `generateModelActionRuleDraft` in `action-rule-model.ts` then decides whether it is compiled, mechanical continuation, or an operator clarification. On the clarification path it remembers the reply only in memory and calls `askClarification`; the component checkpoint is written only after an answer. `boundary-commands.ts` displays/waits, while the existing resume writer atomically replaces one integrity-checked resume file under project coordination and compare-and-swap. Fresh-process recovery correctly refuses the unowned handled operation.

## Smallest prospective repair shape

1. At the actual typed clarification consumer, retain the complete unresolved question and exact current Action/intent, Source/context and result/operation association. Mint completion evidence through the real provider-result/consumer path, not from question punctuation or a public arbitrary object.
2. Extend the existing component/resume checkpoint to carry the pending question and linked completion acknowledgement in the SAME atomic resume replacement. Bind exact component checkpoint and operation; do not mark unrelated handled operations resolved. Keep the existing state enum if adequate. Confirm write by existing CAS/readback; no lock across human waiting.
3. Only after this durable commit may the UI wait for an answer or report a successful saved pause. Failures before/at acknowledgement remain honestly fenced. Complete invalid content remains invalid; checkpointing is not policy acceptance.
4. Resume validates the exact committed question/checkpoint/operation relationship and current Source/subject before display. Redisplay is local. Revalidation of component metadata must not silently make an old question applicable to changed Source or authority.
5. Store the attributed owner answer through the existing currentness-checked input path in a later atomic checkpoint; clear pending state only with that commit. Exact repetition/concurrent processes must not overwrite a competing answer or send downstream twice. Preserve history and distinguish an empty answer from approval/consent.
6. Cancellation, EOF and Escape retain the unanswered committed question. Do not require owner agreement in order to acknowledge completed local handling. No retry budget or financial hold is released.

## Acceptance limits

The helper executed the actual producer against controlled local dependencies. Four failing-before controls and two passing companions isolate the forward defect. They do not exercise the installed CLI, transport provenance, full persistence fault matrix or cross-process currentness. Those remain required before any future forward candidate acceptance.

The authentic legacy state lacks the pending question and the independently bound committed host disposition this design would newly record. No prospective record can truthfully be backdated. A supplemental response's own digest plus the genuine request hash does not resolve that gap. The current B33 mandatory legacy public positive is therefore NOT ESTABLISHED. No generic import, force-ack, historical state rewrite or fresh sample is proposed as an implementation detail.
