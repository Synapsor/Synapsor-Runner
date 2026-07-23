# App-Owned Executors

The canonical guide is [Writeback Executors](writeback-executors.md).

Use app-owned executors when an approved proposal needs a real business
transaction instead of Runner-managed single-row SQL.

Examples:

- create a credit row;
- open a ticket;
- call Stripe or Zendesk;
- write ledger/event rows;
- update multiple tables in one application transaction.

The model-facing MCP tool only creates a proposal. Approval happens outside MCP.
After approval, Runner calls your `http_handler` or `command_handler`, records
the receipt, and includes the result in replay.

> **Important:** your app handler owns the final business write. Runner creates
> the proposal and calls your handler only after approval, but your handler must
> still enforce tenant/scope checks, expected-version or conflict guards,
> idempotency keys, allowed business actions, transaction/rollback, and safe
> error receipts. If you skip those checks, you can reintroduce cross-tenant
> writes, lost updates, or duplicate writes. Keep handler credentials out of MCP.

Runner 1.6.1 strict `proposal_freshness` is limited to same-database direct SQL
writeback. Runner rejects it for `http_handler`, `command_handler`, and
cross-source dependencies because a local preflight cannot be atomic with an
effect executed elsewhere. If supporting evidence matters, the app handler
must lock and re-read those rows inside its own business transaction and fail
closed on drift. See
[Proposal And Evidence Freshness](proposal-evidence-freshness.md).

A handler is your application endpoint or script. It is not a second Synapsor
package that users need to install. Install `@synapsor/runner`, then generate
or copy a handler template only when your approved write needs app-owned
business logic.

Do not use generic SQL for rich business transactions. Let the model propose,
let Synapsor Runner approve/replay, and let your app execute the transaction.

For TypeScript services, prefer the first-party helper in `packages/handler`.
It enforces bearer/HMAC auth, tenant scope, expected-version guards,
idempotency, transaction rollback, and safe receipt formatting around your
business effect. See [Handler Helper](handler-helper.md).
