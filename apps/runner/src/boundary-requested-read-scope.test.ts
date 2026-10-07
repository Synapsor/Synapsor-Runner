import { describe, expect, it, vi } from "vitest";
import { planModelBoundaryJob, type BoundaryJobCurrentState } from "./boundary-job-model.js";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { generateModelReadWorkload } from "./read-workload-model.js";

// Public fixture facts: seven requested areas and their actual inspected IDs.
// The response is a routing summary, not a replacement business policy.
const resources = ["studio.accounts", "studio.subscriptions", "studio.service_lines", "studio.usage_daily",
  "studio.invoices", "studio.payments", "studio.plan_change_offers"];
const original = "Read the customer's own accounts, subscriptions, service lines, recent usage, invoices, payments, and plan change offers. "
  + "Plan change offers are the currently active offers available to that customer. Keep internal identifiers private. "
  + "No proposal, approval, execution, or source write is requested.";
const state: BoundaryJobCurrentState = {
  read: { boundary_name: "studio_review", authority: "disabled", fully_reviewed: false,
    resource_ids: [], exact_reusable_revision_count: 0 }, actions: [],
  control_plane: { trusted_scope: "runner_injected", approval_history: "runner_proposal_ledger",
    model_may_supply_scope_values: false, model_may_supply_approval_history: false },
};

function planning(readIntent: string) {
  const frames: string[] = [];
  const requestJson = vi.fn(async (request: { body: unknown }) => {
    frames.push(JSON.stringify(request.body));
    return { status: 200, body: { output: [{ type: "function_call", call_id: `plan_${frames.length}`,
      name: "runner__plan_boundary_job", arguments: JSON.stringify({ status: "planned", read_mode: "create",
        read_intent: readIntent, action_mode: "none", summary: "Prepare the seven requested read areas." }) }] } };
  });
  return { frames, requestJson, run: () => planModelBoundaryJob({ jobIntent: original,
    availableResourceIds: resources, currentState: structuredClone(state), egressAcknowledged: true,
    session: { provider: "openai", model: "declared-scope-fixture", apiKey: "local-fixture-only", dependencies: { requestJson } } }) };
}

describe("original requested Read scope versus routing summary", () => {
  it("accepts declared active-offer paraphrase without alleging an omitted requested area", async () => {
    const summary = "Customer accounts, subscriptions, service lines, recent usage, invoices, payments, and active offers.";
    const probe = planning(summary);
    await expect(probe.run()).resolves.toMatchObject({ state: "planned", read_intent: summary,
      correction_used: false, authority_granted: false, source_database_changed: false });
    expect(probe.requestJson).toHaveBeenCalledOnce();
    expect(probe.frames[0]).toContain(original);
    expect(probe.frames[0]).toContain("studio.plan_change_offers");
  });

  it.each([500, 501])("keeps the existing %i-character summary boundary without truncating business text", async size => {
    const summary = "Read accounts, subscriptions, service lines, recent usage, invoices, payments, and plan change offers."
      .padEnd(size, "x");
    const probe = planning(summary);
    if (size === 500) await expect(probe.run()).resolves.toMatchObject({ state: "planned", read_intent: summary });
    else await expect(probe.run()).rejects.toThrow("maximum is 500");
    expect(probe.frames[0]).toContain(original);
  });

  it.each(["studio.usage_daily", "studio.plan_change_offers"])("refuses actual missing %s even when the routing summary lists every area", async omitted => {
    const boundary: ExplorationBoundaryDraft = {
      schema_version: "synapsor.exploration-boundary.v1", activation: "disabled_unreviewed",
      deployment_profile: "staging", source: "local_postgres", compiler_version: "1.7.0", spec_version: "1.9.0",
      reporting_timezone: "UTC", trusted_context: { provider: "environment", tenant_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL_ID" },
      generation_lock_fingerprint: `sha256:${"1".repeat(64)}`, role_posture_fingerprint: `sha256:${"2".repeat(64)}`,
      pack: { name: "studio_review", resources: resources.map(id => ({
        id, schema: "studio", table: id.split(".")[1]!, primary_key: "id", tenant_key: "tenant_id", principal_key: "principal_id",
        field_types: { id: "uuid", tenant_id: "text", principal_id: "text", status: "text" },
        field_enums: {},
        selectable_fields: ["status"], filterable_fields: {}, sortable_fields: [], groupable_fields: [],
        aggregate_measures: [], count_distinct_fields: [], time_bucket_fields: {},
        kept_out_fields: ["id", "tenant_id", "principal_id"], relationships: [],
        minimum_cohort_size: 5, suppression_aware_totals: true,
      })) }, budgets: structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS), unresolved_decisions: [],
    };
    const bodies: string[] = [];
    const requestJson = vi.fn(async (request: { body: unknown }) => {
      const wire = JSON.stringify(request.body);
      bodies.push(wire);
      // Every submitted identity/field is actually present in this transmitted catalog.
      for (const id of resources) expect(wire).toContain(id);
      expect(wire).toContain(original);
      return { status: 200, body: { output: [{ type: "function_call", call_id: `map_${bodies.length}`,
        name: "runner__submit_read_workloads", arguments: JSON.stringify({
          allowed: resources.filter(resource => resource !== omitted).map((resource, index) => ({ id: `read_${index}`, description: `Read ${resource} status`,
            plan: { kind: "rows", resource, select: ["status"] } })), forbidden: [],
        }) }] } };
    });
    await expect(generateModelReadWorkload({ name: "studio_reads", generatedBoundary: boundary,
      allowedQuestions: ["Read accounts, subscriptions, service lines, recent usage, invoices, payments, and plan change offers."],
      operatorNamingContext: original, provider: "openai", model: "declared-scope-fixture", apiKey: "local-fixture-only",
      egressAcknowledged: true, deferNarration: true, dependencies: { requestJson },
    })).rejects.toThrow(/OMITTED|requested.*workload/iu);
  });
});
