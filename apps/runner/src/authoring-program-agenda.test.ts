import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planModelBoundaryJob, type BoundaryJobCurrentState } from "./boundary-job-model.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState, revalidateBoundaryAuthoringResume } from "./boundary-authoring-resume.js";

const state: BoundaryJobCurrentState = { read: { boundary_name: "warehouse", authority: "disabled", fully_reviewed: false, resource_ids: ["warehouse.parcels"], exact_reusable_revision_count: 0 }, actions: [], control_plane: { trusted_scope: "runner_injected", approval_history: "runner_proposal_ledger", model_may_supply_scope_values: false, model_may_supply_approval_history: false } };
const intents = ["Flag the selected parcel with its exact note.", "Defer the selected parcel until its reviewed date."];
const outcomes = ["warehouse.flag_parcel", "warehouse.defer_parcel"];
const plan = { status: "planned", read_mode: "create", read_intent: "Read the selected parcels.", action_mode: "create", action_strategy: "rule_derived", action_intent: intents[0], action_intents: intents, action_outcomes: outcomes, summary: "Prepare the complete program; authority stays disabled." };
const broad = { status: "planned", read_mode: "create", read_intent: "Read the reviewed Boundary state and preserved resources needed to separate the operator’s complete 50-action program into Read vs Action work without changing the draft.", action_mode: "create", action_intent: "Draft the complete supported 50-action program in declared order with all four shapes, private guards, shared allocation domain, and execution disabled; preserve unresolved duties and do not activate or complete.", action_strategy: "rule_derived", summary: "Split the operator’s one full job into a new read-side Boundary plan and a new action-side Boundary plan before any draft changes, preserving the complete 50-action program, unresolved duties, shared allocation domain, and disabled execution." };
async function run(replies: unknown[], extra: object = {}, provider: "openai" | "openrouter" = "openai") {
  const requests: any[] = [];
  const result = planModelBoundaryJob({ session: { provider, model: provider === "openrouter" ? "openai/offline-fixture" : "offline-fixture", apiKey: "offline-fixture", dependencies: { requestJson: async request => { requests.push(request.body); const value = replies[Math.min(requests.length - 1, replies.length - 1)]; return { status: 200, body: provider === "openai" ? { output: [{ type: "function_call", call_id: `p${requests.length}`, name: "runner__plan_boundary_job", arguments: JSON.stringify(value) }] } : { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: `p${requests.length}`, type: "function", function: { name: "runner__plan_boundary_job", arguments: JSON.stringify(value) } }] } }] } }; } } }, jobIntent: "Prepare the complete source-backed program.", workflow: "program", currentState: state, egressAcknowledged: true, ...extra });
  return { result, requests };
}
describe("explicit complete program agenda", () => {
  it.each(["openai", "openrouter"] as const)("delivers bounded correction for authentic omitted-inventory plan through %s", async provider => {
    const { result, requests } = await run([broad, plan], {}, provider);
    expect(await result).toMatchObject({ state: "planned", action_intents: intents, action_outcomes: outcomes, correction_used: true });
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain("AUTHORING_PROGRAM_INVENTORY_REQUIRED");
    expect(JSON.stringify(requests[0].tools)).toContain("action_outcomes");
  });
  it.each([
    { ...plan, action_intents: undefined }, { ...plan, action_intents: [] },
    { ...plan, action_intents: [intents[0], intents[0]] }, { ...plan, action_outcomes: undefined },
    { ...plan, action_outcomes: [outcomes[0], outcomes[0]] }, { ...plan, action_outcomes: [outcomes[0]] },
  ])("refuses incomplete or duplicate inventory %j", async bad => {
    const { result, requests } = await run([bad]);
    await expect(result).rejects.toThrow(); expect(requests).toHaveLength(2);
  });
  it.each([{ changed: [outcomes[0]] }, { changed: [outcomes[0], "warehouse.renamed"] }, { changed: [...outcomes, "warehouse.extra"] }])("rejects identity drift against reviewed agenda %j", async ({ changed }) => {
    const { result } = await run([{ ...plan, action_outcomes: changed, action_intents: changed.map((_, i) => intents[i] ?? "Extra") }], { expectedActionOutcomes: outcomes });
    await expect(result).rejects.toThrow("inventory");
  });
  it("keeps legacy single Action and honest clarification", async () => {
    const { result } = await run([broad], { workflow: undefined });
    expect(await result).toMatchObject({ state: "planned", action_intent: broad.action_intent, correction_used: false });
    const clarified = await run([{ status: "clarification", question: "Which independent outcomes belong in the requested program?" }]);
    expect(await clarified.result).toMatchObject({ state: "clarification" });
  });
  const hash = `sha256:${"a".repeat(64)}` as const;
  const binding = { boundary_name: "warehouse", draft_digest: hash, candidate_digest: hash, generation_lock_fingerprint: hash, schema_fingerprint: hash, role_posture_fingerprint: hash, review_revision: 1 };
  function saved(completed: string[] = []) { return buildBoundaryAuthoringResumeState({ binding, stage: "action_drafting", jobIntent: "Prepare the parcel program", provider: "openai", model: "offline-fixture", actionWorkflow: "program", action: { intent: intents[0]!, intents, intended_outcomes: outcomes, completed_outcomes: completed, strategy: "rule_derived" } }); }
  it("persists exact agenda and partial durable progress without a readiness claim", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-agenda-"));
    try { const first = saved(); await writeBoundaryAuthoringResumeState(root, first, { expectedRevisionDigest: null });
      const next = buildBoundaryAuthoringResumeState({ binding, stage: "action_drafting", jobIntent: first.job_intent, provider: "openai", model: "offline-fixture", previous: first, action: { ...first.action!, completed_outcomes: [outcomes[0]!] } });
      await writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: first.revision_digest });
      const loaded = await readBoundaryAuthoringResumeState(root, binding); expect(loaded).toMatchObject({ status: "ready", value: { action_workflow: "program", stage: "action_drafting", action: { intended_outcomes: outcomes, completed_outcomes: [outcomes[0]] } } });
      await expect(writeBoundaryAuthoringResumeState(root, first, { expectedRevisionDigest: first.revision_digest })).rejects.toThrow("changed");
      expect(revalidateBoundaryAuthoringResume(next, { ...binding, generation_lock_fingerprint: `sha256:${"b".repeat(64)}` })).toMatchObject({ action_workflow: "program", action: { intended_outcomes: outcomes } });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it.each([{ completed: [outcomes[1]] }, { completed: [outcomes[0], "warehouse.renamed"] }, { completed: [outcomes[0], outcomes[0]] }])("does not convert matching count to completed identity %j", ({ completed }) => { expect(() => saved(completed as string[])).toThrow(); });
});
