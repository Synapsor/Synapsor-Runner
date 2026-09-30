import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTHORING_PROGRAM_CAPACITY, authoringProgramWorkUnit, authoringReviewPage } from "./authoring-program-capacity.js";
import { assertBoundaryAuthoringResumeState, buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState,
  revalidateBoundaryAuthoringResume, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { planModelBoundaryJob } from "./boundary-job-model.js";
const digest = canonicalJsonDigest("owned studio reviewed context");
const binding = { boundary_name: "studio_staging", generation_lock_fingerprint: digest, schema_fingerprint: digest, role_posture_fingerprint: digest };
const base = { binding, stage: "action_drafting" as const, jobIntent: "Prepare the complete selected parcel program with its shared human review requirement.", provider: "openai" as const, model: "owned-offline" };
const intents = (n: number) => Array.from({ length: n }, (_, i) => `Pack parcel type ${i + 1} using the supplied bounded units and human review.`);
const outcomes = (n: number) => Array.from({ length: n }, (_, i) => `studio.pack_${i + 1}`);

describe("owned authoring program dimensions and continuation", () => {
  it("keeps existing submission and transport dimensions separate from work units", () => {
    expect(AUTHORING_PROGRAM_CAPACITY).toEqual({ totalActions: 64, structuredChangedActions: 12,
      recommendedWorkUnitActions: 8, reviewPageActions: 8, structuredDraftBytes: 512 * 1024,
      structuredDraftRecordBytes: 256 * 1024, structuredDraftManifestBytes: 64 * 1024,
      structuredDraftParts: 16, structuredDraftRecords: 192, structuredDraftTotalBytes: 4 * 1024 * 1024 });
    expect(authoringProgramWorkUnit(50, 36)).toMatchObject({ completed: 36, remaining: 14, unit: { index: 5, start: 32, end: 40, next_intent_index: 36 } });
    expect(authoringProgramWorkUnit(50, 50)).toMatchObject({ state: "drafted", unit: null });
    for (const args of [[65, 0], [50, 51], [50, -1], [0, 0]]) expect(() => authoringProgramWorkUnit(...args as [number, number])).toThrow();
  });
  it.each([13, 32, 50, 64])("persists all %i selected intents across restart and metadata revalidation", async n => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-studio-continuation-"));
    try {
      const action = { intent: intents(n)[0]!, intents: intents(n), completed_outcomes: outcomes(12), strategy: "rule_derived" as const };
      const state = buildBoundaryAuthoringResumeState({ ...base, action });
      expect(state.schema_version).toBe("synapsor.boundary-authoring-resume.v2");
      await writeBoundaryAuthoringResumeState(root, state, { expectedRevisionDigest: null });
      const restarted = await readBoundaryAuthoringResumeState(root, binding);
      expect(restarted).toEqual({ status: "ready", value: state });
      const rewritten = buildBoundaryAuthoringResumeState({ ...base, previous: state, stage: "planning" });
      expect(rewritten.action).toEqual(action);
      const changedBinding = { ...binding, schema_fingerprint: canonicalJsonDigest("new studio metadata") };
      const revalidated = revalidateBoundaryAuthoringResume(state, changedBinding);
      expect(revalidated.action).toEqual(action);
      expect(revalidated.authority_granted).toBe(false);
      await expect(writeBoundaryAuthoringResumeState(root, revalidated, { expectedRevisionDigest: digest })).rejects.toThrow("BOUNDARY_AUTHORING_RESUME_CHANGED");
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual(restarted);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("preserves v1 bounds and rejects duplicate progress without mistaking it for completion", () => {
    const legacy = buildBoundaryAuthoringResumeState({ ...base, action: { intent: intents(8)[0]!, intents: intents(8) } });
    expect(legacy.schema_version).toBe("synapsor.boundary-authoring-resume.v1");
    const program = buildBoundaryAuthoringResumeState({ ...base, action: { intent: intents(13)[0]!, intents: intents(13) } });
    expect(() => assertBoundaryAuthoringResumeState({ ...program, schema_version: legacy.schema_version })).toThrow("1-8");
    expect(() => buildBoundaryAuthoringResumeState({ ...base, action: { intent: intents(65)[0]!, intents: intents(65) } })).toThrow("1-64");
    expect(() => buildBoundaryAuthoringResumeState({ ...base, action: { intent: "same", intents: ["same", " same "] } })).toThrow("distinct");
    expect(() => buildBoundaryAuthoringResumeState({ ...base, action: { intent: "one", intents: ["one", "two"], completed_outcomes: ["studio.one", "studio.one"] } })).toThrow("distinct");
  });
  it("enumerates every canonical outcome through bounded pages and isolates search", () => {
    const full = outcomes(4096), pages = Array.from({ length: 512 }, (_, page) => authoringReviewPage(full, page));
    expect(pages.flatMap(page => page.items)).toEqual(full);
    expect(pages.every(page => page.items.length <= 8 && page.total === 4096)).toBe(true);
    expect(authoringReviewPage(full, 0, item => item === "studio.pack_37")).toMatchObject({ items: ["studio.pack_37"], matched: 1, total: 4096 });
    expect(authoringReviewPage(full, 0, () => false)).toMatchObject({ items: [], pages: 1, matched: 0, total: 4096 });
    expect(() => authoringReviewPage(full, 512)).toThrow("PAGE_INVALID");
  });
  it.each([13, 32, 50, 64])("keeps all %i intents through the actual planning encoder and parser", async n => {
    let requests = 0;
    const inventory = intents(n);
    const result = await planModelBoundaryJob({ session: { provider: "openai", model: "owned-offline", apiKey: "offline-placeholder",
      dependencies: { requestJson: async request => {
        requests++;
        expect(JSON.stringify(request.body)).toContain('"maxItems":64');
        return { status: 200, body: { output: [{ type: "function_call", call_id: "owned-studio-plan", name: "runner__plan_boundary_job",
          arguments: JSON.stringify({ status: "planned", read_mode: "reuse", action_mode: "create", action_strategy: "rule_derived",
            action_intent: inventory[0], action_intents: inventory, summary: "Prepare the complete selected program; human review remains shared." }) }] } };
      } } }, jobIntent: base.jobIntent, currentState: { read: { boundary_name: binding.boundary_name, authority: "disabled", fully_reviewed: true,
        resource_ids: ["studio.parcels"], exact_reusable_revision_count: 1 }, actions: [], control_plane: {
          trusted_scope: "runner_injected", approval_history: "runner_proposal_ledger", model_may_supply_scope_values: false, model_may_supply_approval_history: false } }, egressAcknowledged: true });
    expect(result).toMatchObject({ state: "planned", action_intents: inventory, authority_granted: false, source_database_changed: false });
    expect(requests).toBe(1);
  });
});
