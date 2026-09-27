import { describe, expect, it, vi } from "vitest";
import { planModelBoundaryJob, type BoundaryJobCurrentState } from "./boundary-job-model.js";

const state: BoundaryJobCurrentState = {
  read: { boundary_name: "operations", authority: "active", fully_reviewed: true,
    resource_ids: ["operations.units"], exact_reusable_revision_count: 1 },
  actions: ["operations.release_units_06", "operations.allocate_units_10"].map(outcome => ({
    capability: outcome, outcome, kind: "rule_derived" as const, authority: "active" as const,
  })),
  control_plane: { trusted_scope: "runner_injected", approval_history: "runner_proposal_ledger",
    model_may_supply_scope_values: false, model_may_supply_approval_history: false },
};

describe("Action edit preserving an existing Read", () => {
  it.each([
    "Change only Action 37, operations.release_units_06: reduce the maximum caller units from 25 to 20. Keep the same saved job and Read Boundary, all other 49 Actions, every other guard, exact subtract effect, private eligibility, human approval, shared allocation domain and execution disabled.",
    "Change only operations.release_units_06 maximum caller units from25 to20. Keep the same Read Boundary and all private operations.eligibility verification facts; no disclosure change and execution disabled.",
    "Reuse the existing Read Boundary and preserve private operations.eligibility verification. Change only operations.release_units_06.",
    "Leave the current Read Boundary unchanged, retaining private operations.eligibility. Change only operations.release_units_06.",
    "Keep the current Read Boundary and private operations.eligibility verification unchanged. Do not show eligibility to customers. Change only operations.release_units_06.",
    "Keep private eligibility out of Read. Change only operations.release_units_06 maximum caller units from25 to20. Keep existing Read Boundary unchanged; execution disabled.",
  ])("does not turn a preservation instruction into extra Read access: %s", async jobIntent => {
    const before = structuredClone(state);
    const requestJson = vi.fn(async () => response());
    const result = await planModelBoundaryJob({ session: { provider: "openai", model: "fixture", apiKey: "test-key",
      dependencies: { requestJson } }, jobIntent, currentState: state,
      availableResourceIds: ["operations.units", "operations.eligibility"], egressAcknowledged: true });
    expect(result).toMatchObject({ state: "planned", read_mode: "reuse", action_mode: "revise",
      action_outcome: "operations.release_units_06", correction_used: false, authority_granted: false,
      source_database_changed: false });
    expect(requestJson).toHaveBeenCalledOnce();
    expect(state).toEqual(before);
  });

  it.each([
    "Show operations.eligibility to the customer as well as the existing units fields. Change only operations.release_units_06.",
    "Keep the same Read Boundary and show operations.eligibility. Change only operations.release_units_06.",
    "Keep the existing Read Boundary; inspect operations.eligibility as well. Change only operations.release_units_06.",
    "Read operations.eligibility. Keep all other access unchanged. Change only operations.release_units_06.",
    "Change the Read Boundary to show operations.eligibility. Change only operations.release_units_06.",
    "Keep the same Read Boundary but include operations.eligibility. Change only operations.release_units_06.",
    "Do not show units but show operations.eligibility. Change only operations.release_units_06.",
  ])("still refuses omitted genuinely requested access: %s", async jobIntent => {
    const before = structuredClone(state);
    const requestJson = vi.fn(async () => response());
    await expect(planModelBoundaryJob({ session: { provider: "openai", model: "fixture", apiKey: "test-key",
      dependencies: { requestJson } }, jobIntent, currentState: state,
      availableResourceIds: ["operations.units", "operations.eligibility"], egressAcknowledged: true }))
      .rejects.toThrow("does not contain explicitly requested reviewed reads: operations.eligibility");
    expect(requestJson).toHaveBeenCalledTimes(2); // Existing bounded planner correction, local DERIVED responses.
    expect(state).toEqual(before);
  });
});

function response() {
  return { status: 200, body: { output: [{ type: "function_call", call_id: "derived-plan",
    name: "runner__plan_boundary_job", arguments: JSON.stringify({ status: "planned", read_mode: "reuse",
      action_mode: "revise", action_strategy: "rule_derived", action_outcome: "operations.release_units_06",
      action_intent: "Reduce only maximum caller units from 25 to 20; preserve all other guards and the exact subtraction.",
      summary: "Revise the selected Action only; preserve access and other work." }) }] } };
}
