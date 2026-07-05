import Fastify from "fastify";

const port = Number(process.env.PORT || 8787);
const expectedToken = process.env.SYNAPSOR_APP_WRITEBACK_TOKEN || "dev-handler-token";

const app = Fastify({ logger: true });

app.post("/synapsor/writeback", async (request, reply) => {
  const auth = request.headers.authorization || "";
  if (auth !== `Bearer ${expectedToken}`) {
    return reply.code(401).send({ status: "failed", error_code: "UNAUTHORIZED" });
  }

  const body = request.body || {};
  const changeSet = body.change_set || {};

  if (!body.proposal_id || !body.idempotency_key || !changeSet.scope?.tenant_id) {
    return reply.code(400).send({ status: "failed", error_code: "BAD_WRITEBACK_REQUEST" });
  }

  if (body.dry_run) {
    return {
      status: "applied",
      rows_affected: 0,
      source_database_mutated: false,
      details: { dry_run: true },
    };
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
   * Put your app-owned transaction here.
   *
   * Examples:
   * - insert a refund_review row;
   * - insert an account_credit row;
   * - open a support_ticket row;
   * - update invoice + ledger rows together.
   *
   * Re-check:
   * - tenant and principal authorization;
   * - idempotency_key has not already been applied;
   * - row/version guards still match;
   * - requested business action is allowed by your app policy.
   */

  return {
    status: "applied",
    rows_affected: 1,
    previous_version: String(changeSet.guards?.expected_version?.value || ""),
    new_version: new Date().toISOString(),
    source_database_mutated: true,
  };
});

app.listen({ host: "127.0.0.1", port });
