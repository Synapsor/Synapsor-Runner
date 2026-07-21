import { defineCapability } from "@synapsor/runner/authoring";

// Disabled authoring source. Editing this file never changes active Runner tools.
export default defineCapability({
  name: "support.propose_plan_credit",
  description: "Propose one bounded support plan credit after reviewing customer evidence.",
  kind: "proposal",
  context: "support_agent_context",
  source: "local_postgres",
  subject: {
    schema: "public", table: "customers", primary_key: "id",
    tenant_key: "tenant_id", conflict_key: "updated_at",
  },
  args: {
    customer_id: { type: "string", required: true, max_length: 128 },
    credit_cents: { type: "number", required: true, minimum: 1, maximum: 50000 },
    reason: { type: "string", required: true, max_length: 500 },
  },
  lookup: { id_from_arg: "customer_id" },
  visible_fields: ["id", "tenant_id", "customer_id", "plan", "invoice_status", "support_ticket_reason", "plan_credit_cents", "credit_reason", "updated_at"],
  kept_out_fields: ["card_token", "raw_payment_method", "internal_risk_score", "private_notes"],
  evidence: { required: true, query_audit: true },
  max_rows: 1,
  proposal: {
    action: "grant_plan_credit",
    operation: { kind: "update" },
    allowed_fields: ["plan_credit_cents", "credit_reason"],
    patch: { plan_credit_cents: { from_arg: "credit_cents" }, credit_reason: { from_arg: "reason" } },
    numeric_bounds: { plan_credit_cents: { minimum: 1, maximum: 50000 } },
    conflict_guard: { column: "updated_at" },
    approval: { mode: "policy", policy: "support_propose_plan_credit_auto_approval", required_role: "support_reviewer" },
    writeback: { mode: "direct_sql" },
  },
});
