import { describe, expect, it, vi } from "vitest";
import { planModelBoundaryJob, type BoundaryJobCurrentState } from "./boundary-job-model.js";

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
});
