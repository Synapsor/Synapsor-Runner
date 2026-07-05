#!/usr/bin/env node

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

const request = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
const changeSet = request.change_set || {};

if (!request.proposal_id || !request.idempotency_key || !changeSet.scope?.tenant_id) {
  process.stdout.write(JSON.stringify({
    status: "failed",
    safe_error_code: "BAD_WRITEBACK_REQUEST",
    source_database_mutated: false,
  }));
  process.exit(0);
}

if (request.dry_run) {
  process.stdout.write(JSON.stringify({
    status: "applied",
    rows_affected: 0,
    source_database_mutated: false,
    details: { dry_run: true },
  }));
  process.exit(0);
}

/*
 * IMPORTANT: your app handler owns the final business write.
 * Runner creates the proposal and calls your handler only after approval,
 * but your handler must still enforce tenant/scope, expected-version or
 * conflict guard, idempotency key, allowed business action,
 * transaction/rollback, and safe error receipt.
 *
 * If you skip those checks, you can reintroduce cross-tenant writes,
 * lost updates, or duplicate writes. Keep handler credentials out of MCP.
 *
 * Put your app-owned command transaction here.
 *
 * Examples:
 * - call an internal service;
 * - enqueue a review job;
 * - run an app migration-safe script that uses your normal ORM.
 *
 * Re-check tenant/principal authorization, idempotency, row/version guards,
 * and business policy before mutating application state.
 */

process.stdout.write(JSON.stringify({
  status: "applied",
  rows_affected: 1,
  previous_version: String(changeSet.guards?.expected_version?.value || ""),
  new_version: new Date().toISOString(),
  source_database_mutated: true,
}));
