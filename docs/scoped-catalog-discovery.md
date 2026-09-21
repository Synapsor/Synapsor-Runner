# Bounded Catalog Discovery

The four MCP tool names do not change. Business rules change the reviewed
catalog, not `tools/list`. Refresh discovery when a request reports changed
authority; a previous discovery result never authorizes a later request.

## Agent Workflow

1. Search `app.describe_data` or `app.describe_actions` with `query` and `limit`.
2. Fetch exact details with `resource` (optionally `boundary`) or `outcome`.
3. Copy the selected contract into Explore or `app.request_change`.

Search/list takes an optional query of at most 256 characters, a limit of
1-20 (default 5), and an opaque returned cursor. Exact detail cannot be mixed
with query, limit or cursor. Listing indicates metadata availability, not
this customer's eligibility. Empty search results mean no matches to that
query; browse or try other words, rather than concluding no action exists.
`limit` is a maximum: a whole-record page may contain fewer entries to fit
the byte budget. Follow `next_cursor` until it is null, not until a page is
short. `empty_search` is present only when a search actually has no matches.

Search uses deterministic lexical terms in reviewed identifiers, descriptions
and labels. Action Rules may include reviewed `x-runner-discovery` metadata:
`title` (160 characters), `summary` (400), and `aliases` (up to 16, 80 each).
The extension is part of the exact rule revision. It cannot change scope or
eligibility. No embedding/model request or implicit source-row coverage query
is made for discovery.
Model-guided Action creation and edits can supply this vocabulary through the
existing rule draft tool. A vocabulary-only revision preserves outcome identity,
eligibility, effects and approval settings; the public title, summary and search
phrases appear in the exact review and revision diff. Existing rules without
reviewed vocabulary retain their identifier-derived fallback until reviewed.

## Compatibility

This release changes the discovery input schema once. Existing clients that
cache schemas must refresh them; later business-rule updates need no new
tool or client configuration. Empty Action discovery preserves full request
contracts, but only for a bounded first page. Explicit `query` or `limit`
returns summaries. Fetch one `outcome` for its complete input types, required
subjects, bounds, effect summary and review behavior.
Exact Action detail omits the generic example request; the selected action's
`request_shape` is the concrete contract. Discovery reports worker liveness as
unknown and execution enablement as not reported. A proposal-only tool does
not imply a separately operated worker is disabled. Only an execution receipt
establishes completion; approval by itself does not.

Approval information is partial. `approval_information.disclosure` and each
Action's `approval.disclosure` describe the information returned, not a new
approval decision. Summaries use `not_reported`; available policy-based exact
detail uses `mode_only` without exposing private conditions or thresholds.
`manual_only` is used only for an available, current human-review contract.
Paused or absent authority uses `unavailable`, not manual-only.

An omitted condition does not mean automatic approval is absent. A human-review
fallback does not mean every request requires it. `proposal_only` separates a
request from source execution; it does not mean approval is always manual.
Any automatic route still depends on current eligibility, policy and available
allowance. Use the actual request disposition; `app.request_change` is a business
request, not a read-only eligibility probe. Discovery grants no approval or
execution authority, and cannot establish an undisclosed threshold.

Empty Read discovery returns a bounded resource shortlist, not full field
details. Exact `resource` returns the complete reviewed contract. Public Read
v2 details retain `valid_plan_examples.rows` and `.aggregate`, but omit the
duplicate legacy `valid_plan_example` and operator vocabulary statistics.
The global `vocabulary_policy.exact_ids_required_in_plans` replaces repeated
per-field `plan_reference: exact_id_only`. The resource operation maps and
`field_enums` retain the complete permissions and allowed values. Per-field
`operations` and `allowed_values` copies are omitted only when every fact is
exactly reconstructible from those maps (including false/empty operations and
model-withheld status). Novel or differing per-field constraints stay intact.
Missing membership grants no operation. Labels, descriptions, privacy limits,
model-withheld fields and complete relationship grammar are not truncated.
Ready vocabulary omits only redundant empty warnings; nonempty warnings,
inconsistent readiness and additional facts remain. Compact v2 guidance retains
the requirement not to guess business meaning from codes or opaque names.
`boundary_name` replaces a duplicate `pack` name only when they are equal.
Public Read continuations are opaque strings; numeric zero is accepted only as a legacy
first-page request, not as an offset. Operator inspection APIs retain their
separate numeric pagination and explicit opt-in time-coverage checks.

## Limits And Authorization

Both catalogs have a 16 KiB complete MCP response budget, including both text
and structured content, and a 12 KiB maximum individual contract. A contract
must also fit the complete response, so usable size depends on its encoding.
Summary pages contain identifiers and reviewed business descriptions, not
empty field grammar or executable examples. Records are paginated whole; required constraints are
never shortened to fit. The individual-entry check uses the actual model
projection, not its larger intermediate operator record. Read review checks
Discovery compatibility, and both Read and Action activation refuse
unrepresentable contracts before replacing authority. Existing/imported
authority is still checked at runtime.
Read activation measures the same complete metadata projection that discovery
serves, including private-scope-safe reviewable relationship metadata from the
current project draft. It rechecks all resulting active Read contracts under
the authority lock before publishing; an unrelated or outdated caller-supplied
draft cannot substitute for that runtime state.
Each connection has at most 80 discovery calls, 300 returned records and
256 KiB aggregate disclosure per catalog. These counters do not reset on a
catalog edit. Search is bounded to 16 terms and 10,000 indexed entries.

Server-held random cursors expire in five minutes. They bind the trusted
scope, catalog revision, query/filter, page size and order. Reuse the same
query and limit for continuation. A successful continuation consumes its
cursor. Changed/revoked authority, another session or tampering requires
fresh discovery. Tokens contain no readable authority hashes or identities.

Authorization filtering precedes search and snippets. Exact denied and
unknown entries have the same unavailable result. Private verification
predicates and source identities are not part of the public Action contract.
Request and execution validation remain independent of discovery.

## An Oversized Exact Contract

`CATALOG_CONTRACT_TOO_LARGE` reports the measured bytes, applicable entry or
complete-response limit, and `retryable: false` for the authorized contract.
The response includes no incomplete permission contract. Reducing listing
page size, adding the same boundary name or repeating the lookup cannot repair
an exact-entry overflow; the agent must not guess a valid plan.

The operator can resume Boundary review, open **Discovery compatibility**,
and revise the saved draft with the model or manual editor. Shorten redundant
reviewed descriptions or divide a broad Read scope into separately reviewed
resources/boundaries when appropriate. Keep required permissions and privacy
controls intact. Review dependent Actions and explicitly activate the new
revision. Until then, the previous authority remains unchanged.

## Runtime Cost

An Action authority supports up to 4,096 rules and approval classes, with a
64 MiB complete stored-artifact limit. These are implementation ceilings, not
recommendations to load every action into a model context. Guided authoring
still limits each job to eight independent intents. Per-action verification,
effect and request-contract complexity limits remain in force.

Bundle compilation indexes one owned catalog snapshot and reuses it for its
rules. A long-lived runtime retains one immutable compiled Action snapshot.
It verifies current active and immutable revision file contents on every
load, and checks current Read dependencies independently. Claimed digests,
timestamps and cache TTLs alone are insufficient. Mutation, deletion and
dependency revocation fail closed; a newly activated bundle replaces the
cached snapshot without changing the tool list.

This file-backed loader still reads bounded authority bytes and Read metadata
on warm calls. It avoids repeated parsing/compilation and rebuilding unchanged
discovery indexes; it is not a constant-I/O authoritative repository. Store
migration must preserve those checks while moving to indexed revision pointers.
Discovery rechecks authority and authorization after asynchronous loading,
before returning a page or exact contract.
