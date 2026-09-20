# Fresh fixture bootstrap and restoration contract

This is the reproducible public setup route for the known software fixture, not onboarding qualification. No provider is needed. `R` is the raw root recorded in PLAN.json. Only `R/sealed-starts/{t0,t1}` are independent tester starts. Historical worker-handoff W1/W2 and this task's post-request snapshots are inspection-only.

## Restore an untouched start

Use a NEW owned PostgreSQL 17 container (image identity recorded in sealed manifest), a new loopback port and a fresh administrator password. Do not share databases with a live schedule. Create the exact database name from the chosen start in this new cluster. Execute its credential-free `roles.sql` before restoring `source-complete.sql`; set fresh passwords via private stdin, never a shell argument, saved log or Git. The dump includes the exact schema, business rows, RLS policies, receipt infrastructure and grants. Role names remain exact because reviewed writer posture is bound to them. Reader is NOSUPERUSER/NOBYPASSRLS/NOINHERIT. Writer grants stay narrow; do not substitute administrator credentials.

Extract `project.tgz` into a NEW owned physical directory. Extract `operator-private.tgz` separately with umask 0077. This is an authorized synthetic test signing key, not production credentials; keep it mode 0600, outside project/client configuration. Confirm hashes against the sealed manifest before opening any store.

The archive is logically bound to its original absolute project path recorded in the manifest. Use bubblewrap whole-directory mounts: restored project at that exact logical project path, restored home at the original case home, restored private key directory at the original operator-private path, new private writable `/tmp` and `/var/tmp`, remaining filesystem read-only. Set HOME to the logical case home, NO_COLOR=1, umask 0077 and 100x30 terminal size. Never edit migration/identity/policy bindings to relocate the project.

Supply only the new reader `DATABASE_URL` and the exact writer environment NAME from `administrator-provisioning.json`, pointing to the restored database with its fresh password. No provider credential, inherited tenant/principal environment or administrator credential is passed to Runner. Use the archived reviewed local identity through the generated launcher. Supply `--identity recovery_operator --identity-key <logical-case>/operator-private/recovery.pem` only to operator/worker controls, never MCP. The immutable installation and entrypoint come from ARTIFACT.json.

Before requests, run the existing `public-preflight.mts` in this namespace and inspect the effective local store. Run public `worker check --supervised --config synapsor.actions.runner.json --capability release.seal_candidate --json`, the generated four-tool launcher, and own-context Explore. Compare every control table, all 504 business rows and empty source receipts to sealed readback. If live metadata/posture legitimately differs, retain that attempt and perform supported public rescan/review as preparation; do not forge equivalence.

## Fresh-key fallback from empty state

If an archive cannot be restored faithfully, use the tested from-empty public setup sequence. This also provides fresh reader, writer and operator credentials without carrying a private key from an archive. For a fresh operator key, this recipe rebuilds and separately reviews configuration from empty; it does not claim a hot key-rotation route. Never rewrite stored bindings to make a replacement fixture appear identical.

1. Use the recorded original schema and source-facts hashes in `operational-preparation.json`. `prepare-operational.py` shows the row-safe import algorithm. Use a new task-owned cluster/database/project; do not rerun it against existing destinations. The schema has 116 candidates, 116 slots and 272 private checks. Source facts and schema are copied into the final private bootstrap package. Create a fresh read-only role password without changing grants, RLS, relationships or records.
2. Initialize an empty Git project boundary, then run the new frozen installation:

   ```sh
   synapsor-runner onboard db --project-root . --from-env DATABASE_URL --schema release_ops --json
   ```

3. BEFORE disabled Action drafting/activation, configure the existing signed-key operator shape in the new `synapsor.runner.json` (documented in `runner-config-reference.md`). Generate RSA 2048 keys; store public key `./operators/recovery.pub.pem`, private key outside the project, private modes. Set `provider:signed_key`, `apply_roles:[recovery_operator]`, and operator `recovery_operator` with that role. `prepare-operator.py` records this exact setup and refuses an existing Action runtime. No active pointer or ledger row is inserted. This is initial documented operator configuration, not automatic key rotation.
4. Export the current typed draft, prepare the exact known Action/access input using `prepare-typed-input.py`, dry-run it, then save it disabled:

   ```sh
   synapsor-runner onboard db --project-root . --export-draft export.json --json
   synapsor-runner onboard db --project-root . --draft reviewed-input.json --dry-run --json
   synapsor-runner onboard db --project-root . --draft reviewed-input.json --json
   synapsor-runner boundary review --project-root . --access
   synapsor-runner action review --project-root .
   ```

5. Review and activate Read, then exact Action proposal authority, separately. Select `source_db` through public `writeback setup --config synapsor.actions.runner.json --outcome release.seal_candidate --receipt-mode source_db --write-url-env <EXACT_WRITER_ENV> --schema release_ops --table synapsor_writeback_receipts --json`. Preview first; save only with its freshly displayed `--save-selection --confirm "SAVE RECEIPT SETUP sha256:<exact>"`. Do not reuse another fixture's digest.
6. In `action review`, choose the active boundary, supervised execution review, retain exact receipt selection, and prepare administrator instructions. A source owner applies only that generated receipt DDL and narrow grants in the new database; generate a fresh writer password. `apply-reviewed-writer.py` records exact SQL hashes and an explicit role-name substitution when several databases share one cluster. No business rows change.
7. Restart public Action review with the writer reference present. Verify the real writer and rolled-back receipt probe, then explicitly confirm the separate default-No execution review. Continue client setup, use supported reviewed local-development identity, install the project launcher and verify its four tools. Decline indefinite worker startup.
8. Run the own-context Read and worker check, inventory all tables/rows, then seal the entire project/home/private-key state, schema/data/complete dumps, credential-free role definitions and full manifests BEFORE any request. The private identity values stay in owned hidden operator input and private fixture records; no authoring conversation exists.

Exact executed commands, confirmation gestures and exits are in each case's `invocation-*.json` and `terminal-*/events.json`. Generated SQL plus independent role/receipt readbacks remain in each sealed source and preparation record. A command or preview exit zero alone does not establish readiness.

## Operational boundary

Only after tester restoration validation, the implementer runs R0/R1/R2 within PLAN.json caps. Tester uses its own T0/T1 copy and separately authorized schedule. There are exactly four runtime tools. Receipt failures, unknown outcomes and legacy W2 records do not become eligible merely by operator confirmation. Closure is not retry, compensation or approval; prior failed evidence and allowance remain.
