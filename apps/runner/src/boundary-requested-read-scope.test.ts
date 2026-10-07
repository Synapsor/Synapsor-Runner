import { describe, expect, it, vi } from "vitest";
import { planModelBoundaryJob, type BoundaryJobCurrentState } from "./boundary-job-model.js";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { generateModelReadWorkload } from "./read-workload-model.js";
import { type ReadWorkloadAssistanceCheckpoint } from "./read-workload-assistance-checkpoint.js";

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
    const boundary = scopeBoundary();
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
  it("does not expand an exact only-request because the model summary names another inspected area", async () => {
    const request = "Read only studio.accounts.";
    const response = { allowed: ["studio.accounts", "studio.payments"].map((resource, index) => ({ id: `extra_${index}`,
      description: `Read ${resource} status`, plan: { kind: "rows", resource, select: ["status"] } })), forbidden: [] };
    const requestJson = vi.fn(async (wire: { body: unknown }) => {
      expect(JSON.stringify(wire.body)).toContain(request);
      return { status: 200, body: { output: [{ type: "function_call", call_id: "unrequested",
        name: "runner__submit_read_workloads", arguments: JSON.stringify(response) }] } };
    });
    await expect(generateModelReadWorkload({ name: "studio_reads", generatedBoundary: scopeBoundary(),
      allowedQuestions: ["Read accounts and payments."], operatorNamingContext: request,
      provider: "openai", model: "declared-scope-fixture", apiKey: "local-fixture-only", egressAcknowledged: true,
      deferNarration: true, dependencies: { requestJson },
    })).rejects.toThrow(/UNREQUESTED|outside.*request/iu);
  });

  it("uses the existing business question when an unqualified request matches two inspected resources", async () => {
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "ambiguous",
      name: "runner__submit_read_workloads", arguments: JSON.stringify({ allowed: [{ id: "accounts", description: "Read account status",
        plan: { kind: "rows", resource: "studio.accounts", select: ["status"] } }], forbidden: [] }) }] } }));
    const clarificationHandler = vi.fn(async () => ({ state: "declined" as const }));
    await expect(generateModelReadWorkload({ name: "studio_reads", generatedBoundary: scopeBoundary([...resources, "archive.accounts"]),
      allowedQuestions: ["Read accounts."], operatorNamingContext: "Read accounts.",
      provider: "openai", model: "declared-scope-fixture", apiKey: "local-fixture-only", egressAcknowledged: true,
      deferNarration: true, dependencies: { requestJson }, clarificationHandler,
    })).rejects.toThrow("READ_WORKLOAD_CLARIFICATION_DECLINED");
    expect(clarificationHandler).toHaveBeenCalledOnce();
    expect(requestJson).toHaveBeenCalledOnce();
  });

  it("reopens the native saved ambiguous question and rejects changed context before another callback", async () => {
    const boundary = scopeBoundary([...resources, "archive.accounts"]);
    const base = { name: "studio_reads", generatedBoundary: boundary, allowedQuestions: ["Read accounts."], operatorNamingContext: "Read accounts.",
      provider: "openai" as const, model: "declared-scope-fixture", apiKey: "local-fixture-only", egressAcknowledged: true, deferNarration: true };
    const mapped = { status: 200, body: { output: [{ type: "function_call", call_id: "saved_ambiguity",
      name: "runner__submit_read_workloads", arguments: JSON.stringify({ allowed: [{ id: "accounts", description: "Read account status",
        plan: { kind: "rows", resource: "studio.accounts", select: ["status"] } }], forbidden: [] }) }] } };
    let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined;
    const first = vi.fn(async () => mapped);
    await expect(generateModelReadWorkload({ ...base, dependencies: { requestJson: first }, clarificationHandler: async () => undefined,
      onCheckpoint: async value => { checkpoint = structuredClone(value); },
    })).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
    expect(first).toHaveBeenCalledOnce();
    expect(checkpoint?.stage).toBe("waiting");
    const retained = structuredClone(checkpoint);
    const noSend = vi.fn(), noAnswer = vi.fn();
    await expect(generateModelReadWorkload({ ...base, operatorNamingContext: "Read payments.", resumeCheckpoint: checkpoint,
      dependencies: { requestJson: noSend }, clarificationHandler: noAnswer,
    })).rejects.toThrow("CHECKPOINT_STALE");
    expect(noSend).not.toHaveBeenCalled();
    expect(noAnswer).not.toHaveBeenCalled();
    expect(checkpoint).toEqual(retained);
    const answer = "Show the live studio.accounts customer records, not archive.accounts historical records.";
    const resumed = vi.fn(async (request: { body: unknown }) => {
      expect(JSON.stringify(request.body)).toContain(answer);
      return mapped;
    });
    const result = await generateModelReadWorkload({ ...base, resumeCheckpoint: checkpoint,
      dependencies: { requestJson: resumed }, clarificationHandler: async request => ({ state: "answered", answer, resource: request.resource }),
      onCheckpoint: async value => { checkpoint = structuredClone(value); },
    });
    expect(result.analysis.status).toBe("ready");
    expect(result.workload.allowed.map(entry => entry.plan.resource)).toEqual(["studio.accounts"]);
    expect(resumed).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ authority_granted: false, source_database_changed: false, source_query_executed: false });
  });

});

function scopeBoundary(ids = resources): ExplorationBoundaryDraft {
  return {
      schema_version: "synapsor.exploration-boundary.v1", activation: "disabled_unreviewed",
      deployment_profile: "staging", source: "local_postgres", compiler_version: "1.7.0", spec_version: "1.9.0",
      reporting_timezone: "UTC", trusted_context: { provider: "environment", tenant_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL_ID" },
      generation_lock_fingerprint: `sha256:${"1".repeat(64)}`, role_posture_fingerprint: `sha256:${"2".repeat(64)}`,
      pack: { name: "studio_review", resources: ids.map(id => ({
        id, schema: "studio", table: id.split(".")[1]!, primary_key: "id", tenant_key: "tenant_id", principal_key: "principal_id",
        field_types: { id: "uuid", tenant_id: "text", principal_id: "text", status: "text" },
        field_enums: {},
        selectable_fields: ["status"], filterable_fields: {}, sortable_fields: [], groupable_fields: [],
        aggregate_measures: [], count_distinct_fields: [], time_bucket_fields: {},
        kept_out_fields: ["id", "tenant_id", "principal_id"], relationships: [],
        minimum_cohort_size: 5, suppression_aware_totals: true,
      })) }, budgets: structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS), unresolved_decisions: [],
    };
}
