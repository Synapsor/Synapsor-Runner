import { defineCapability } from "@synapsor/runner/authoring";

export const waiveLateFee = defineCapability({
  name: "billing.propose_late_fee_waiver",
  kind: "proposal",
  context: "local_operator",
  source: "app_postgres",
  subject: { resource: "billing.invoice", primary_key: "id", tenant_key: "tenant_id" },
  args: {
    invoice_id: { type: "string", required: true, max_length: 128 },
    reason: { type: "string", required: true, max_length: 500 },
  },
  lookup: { id_from_arg: "invoice_id" },
  visible_fields: ["id", "tenant_id", "late_fee_cents", "waiver_reason", "updated_at"],
  kept_out_fields: ["card_token", "internal_risk_note"],
  evidence: { required: true, query_audit: true },
  max_rows: 1,
  proposal: {
    action: "waive_late_fee",
    operation: { kind: "update" },
    allowed_fields: ["late_fee_cents", "waiver_reason"],
    patch: { late_fee_cents: { fixed: 0 }, waiver_reason: { from_arg: "reason" } },
    numeric_bounds: { late_fee_cents: { minimum: 0, maximum: 10000 } },
    conflict_guard: { column: "updated_at" },
    approval: { mode: "human", required_role: "billing_lead" },
    writeback: { mode: "direct_sql" },
  },
});
