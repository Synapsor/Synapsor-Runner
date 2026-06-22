# Local UI

`synapsor ui` starts a lightweight browser review surface for a local Runner
store.

From a source checkout, use `./bin/synapsor ui ...` if the global binary is not
linked yet.

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner ui --config ./synapsor.runner.json --store ./.synapsor/local.db
```

By default it binds to localhost only and prints a per-run URL:

```text
Synapsor Runner local UI: http://127.0.0.1:51234/?token=...
```

Use the UI after `synapsor mcp serve` has created local proposals. The UI is a
review surface; it is not a raw SQL console and it does not serve MCP tools.

## The Review Console

Selecting a proposal opens a **Review** tab that tells the story of what
happened, step by step, instead of leading with raw JSON:

1. **Agent requested a change** — the semantic tool that was called and the
   object it targeted (for example `billing.propose_late_fee_waiver for
   INV-3001`). The model could request, but had no SQL, approve, or commit
   tools.
2. **Synapsor Runner created a proposal** — proposal id, tenant, and principal.
3. **The proposed change** — an exact before/proposed field diff.
4. **Safety result** — `Source database changed: No/Yes`.
5. **Approval boundary** — “Approval happened outside MCP. The model did not get
   approve or commit tools,” plus the current approval status.
6. **Commit result** — the terminal outcome in plain language, e.g. “Conflict:
   the row changed after the proposal. No write applied,” with an expandable
   guard checklist.
7. **Replay** — a timeline of evidence, proposal, approval, writeback receipt,
   and conflict events.

A second **View raw JSON** tab exposes the full proposal, events, receipts, and
evidence payloads for developers who want the underlying records. Each
configuration card also keeps its raw JSON behind a per-card drawer.

## What It Shows

The setup summary shows:

- config path and local store path;
- Runner mode;
- source engine and environment-variable names;
- trusted context binding;
- selected table/view targets;
- semantic capabilities;
- config validation status;
- whether forbidden model-facing tools such as raw SQL or approval/commit tools
  are present.

The tools view shows:

- semantic tool names;
- read/proposal labels;
- target table/view;
- input schema;
- hidden trusted bindings;
- visible columns;
- allowed patch columns;
- conflict guard;
- clear “No raw SQL” status.

The proposals view shows:

- pending, approved, rejected, applied, conflict, and failed states;
- tenant/object/principal;
- source database changed: yes/no;
- source row before approval/writeback;
- proposed patch values;
- expected version guard;
- exact before/proposed field diff;
- evidence handle and summary;
- receipts when present.

The review panel lets a local reviewer:

- approve outside the model-facing MCP tool surface;
- reject with a reason;
- see the message “The model can propose this change. It cannot approve or
  commit it.” before execution;
- see “Commit executed by trusted runner” after terminal writeback;
- see “Conflict: source row changed after proposal” for stale-row cases;
- inspect the guard checklist for tenant scope, allowed columns, primary key,
  conflict/version column, idempotency key, and affected-row count;
- inspect writeback mode and executor status;
- inspect replay for the selected proposal.

Approval and rejection record the reviewer identity against the exact proposal
hash/version in the local SQLite proposal store.

## Security Boundary

The local UI keeps the same authority split as the CLI:

```text
MCP tool call = request/proposal authority
Trusted local UI/CLI reviewer = approval authority
Trusted runner apply path = execution authority
```

Security behavior:

- binds to `127.0.0.1` by default;
- refuses non-localhost binding unless `--allow-remote-bind` is explicitly
  passed;
- requires a per-run local session token;
- sets the local session token in an HttpOnly SameSite cookie after the first
  token URL load;
- requires a CSRF token for approve/reject actions;
- does not expose database URLs, passwords, bearer tokens, runner tokens, or
  obvious secret strings in JSON API responses;
- does not expose a raw SQL editor;
- does not expose approval, commit, or writeback tools through MCP;
- does not allow widening configured tables, columns, or mutable fields from the
  browser.

The UI displays proposal business data from the local store, so use reviewed
visible columns and denied-column rules before creating proposals. Obvious
secret-looking fields and connection strings are redacted defensively, but the
UI is not a replacement for selecting safe capability projections.

## Remote Binding

For normal use, do not bind the UI to anything except localhost.

For a deliberate trusted local-network demo:

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner ui --host 0.0.0.0 --allow-remote-bind
```

Do this only in an isolated environment. The local UI is not a hosted
multi-user approval product; use Synapsor Cloud when a team needs shared RBAC,
approval queues, audit retention, and hosted replay search.

## Current Limits

The UI is intentionally small in the current alpha:

- proposal review and replay only;
- no graphical capability builder;
- no raw SQL editor;
- no direct writeback apply button;
- no hosted/team auth;
- no Cloud approval queue replacement.

Use the CLI apply path after approval:

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner proposals writeback-job wrp_123 --store ./.synapsor/local.db --output job.json
SYNAPSOR_ENGINE=postgres \
SYNAPSOR_DATABASE_URL="$SYNAPSOR_DATABASE_WRITE_URL" \
npx -y -p @synapsor/runner@alpha synapsor-runner apply --job job.json --config synapsor.runner.json --store ./.synapsor/local.db
```
