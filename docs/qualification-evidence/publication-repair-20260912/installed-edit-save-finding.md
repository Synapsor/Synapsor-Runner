# Next repair decision: installed structured Action draft save requires execution context

Product blocker, preserved and STOPPED. Source f9d2839, publication product b16f92a,
installed tree b2ec50b72e3c178cdb8fd67ed8f7af8250a00840720d0ceca33de8f21a14c8b0.
Owned fixture: runtime/edit under the publication-repair-779b2dc-20260912 task root.
Its reviewed identity already passed doctor on synapsor.actions.runner.json,
normal four-tool startup and own-scope positive read. No model was called.

The real installed operator commands were:

1. `onboard db --project-root . --export-draft automatic-limit-edit.json --json`:
   exit 0, exported.
2. Edit ONLY reserve_adjustment_per_insurer_24h maximum from 3 to 1 in the exported
   Action approval.shared_limits. Scope tenant and rolling window_seconds 86400,
   overall maximum 8, source rules, inputs, effects and all other content unchanged.
3. `onboard db --project-root . --draft automatic-limit-edit.json --dry-run --json`:
   exit 0, validated_disabled_preview; Action digest
   sha256:815042d655b7d3fa74ff889809209e8a123bb938cf7ba789865e899cacff110d.
4. The same save without --dry-run: exit 2, POLICY_EXECUTION_CONTEXT_REQUIRED.
   Expected a saved disabled exact draft; actual no draft publication. It explicitly
   reported active_authority_changed=false, disabled_authority_changed=false and
   source_database_changed=false. Independent final store/source comparison is
   saved separately; no success claim rests on this message alone.

Static trace: boundary-structured-authoring.ts persistStructuredDraft constructs
OperatorAuthorityRepository(binding) with no runtimeConfig, then calls current().
control-policy-operator-repository.ts currentState(false) includes execution records
and validates them with that undefined context. control-policy-execution.ts
parseOperatorExecutionPolicy requires runtimeConfig and throws the observed code.
The structured command accepts project-root/export/draft/json/dry-run only, so
adding --config is not an available fixture correction. These three source files
were not changed by this publication repair. This is a separately discovered
operator persistence defect; no product repair or bypass was attempted here.

Evidence: installed-edit-prepare.log and -exit.json, installed/edit/edit-preparation.json,
installed/edit/edit-export-before.json and automatic-limit-edit.json; the original
owned ledger/configuration are retained. The save path is not retried in place.
No active pointer, execution binding, identity, review or policy hash is rewritten.
No worker ran against this edit fixture, and no installed publication-order schedule
was started. The prepared a5-publication-edit.mjs is NOT an executed result.
Host integration covers both publication orders on SQLite and real PostgreSQL;
that cannot be relabeled as this installed public-path check passing.

A separate assignment must decide how to supply the exact reviewed execution
context to structured persistence without weakening validation, then qualify the
exact installed operator edit and waiting request on a fresh copy. Additional
independent blocker: the prepared reviewed local identity setup cannot represent
alternate principals/insurers sharing one durable allowance; see
installed-identity-prerequisites.md. Stage A NOT PASSED; Stage B NOT STARTED.
