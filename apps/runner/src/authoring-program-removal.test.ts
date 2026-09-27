import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { actionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import { isPreparedProgramRemoval } from "./authoring-program-completion.js";
import { expect, it, vi } from "vitest";
import { onboard } from "./guided-start.js";
import { structuredBoundaryAuthoringCommand } from "./boundary-structured-authoring.js";
import { loadBoundaryReviewContext } from "./boundary-commands.js";
import { readActionRuleAuthorityDraft, writeActionRuleAuthorityDraftIfCurrent } from "./action-rule-authority.js";
import { prepareSavedActionRuleRemoval } from "./action-rule-removal.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { assertCompleteSelectedActionProgram, readSavedActionJobReview, unfinishedActionIntents } from "./saved-action-job-review.js";
import { newPolicySourceSession, policyTextSnapshot, savePolicySources } from "./authoring-policy-source.js";
import { ownedProgramDraft, ownedProgramInspection } from "./test-fixtures/owned-authoring-program.js";

/** Small coherent host integration, not the installed public50 journey. Uses
 * public disabled producers and the real removal/CAS/agenda factories. */
it("permits only the exact prepared v2 removal while retaining its pending publication history", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-studio-prepared-removal-"));
  const previousUrl = process.env.OWNED_STUDIO_READ_URL;
  process.env.OWNED_STUDIO_READ_URL = "postgresql://fixture.invalid/not-used";
  let output = "";
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output += String(chunk); return true; });
  try {
    const inspection = async () => ownedProgramInspection();
    expect(await onboard(["db", "--project-root", root, "--from-env", "OWNED_STUDIO_READ_URL", "--schema", "studio", "--json"],
      { interactive: false, schemaInspector: inspection }), output).toBe(0);
    const command = (args: string[]) => structuredBoundaryAuthoringCommand(["--project-root", root, ...args], inspection);
    output = ""; expect(await command(["--export-draft", "two.json", "--json"]), output).toBe(0);
    const request = JSON.parse(await fs.readFile(path.join(root, "two.json"), "utf8"));
    request.read.resources = [{ resource_id: "studio.parcels", include: true, tenant_key: "tenant_id", principal_key: "principal_id", row_identity: "parcel_id",
      selectable_fields: ["label", "units", "available", "version"], keep_out_fields: ["internal_note"],
      withhold_from_model_fields: ["available", "version"], private_model_fields: ["available", "version"] }];
    request.actions = [ownedProgramDraft(1), ownedProgramDraft(2)];
    await fs.writeFile(path.join(root, "two.json"), JSON.stringify(request));
    output = ""; expect(await command(["--draft", "two.json", "--json"]), output).toBe(0);
    const context = await loadBoundaryReviewContext(root);
    const binding = { boundary_name: context.candidate.pack.name, generation_lock_fingerprint: context.candidate.generation_lock_fingerprint,
      schema_fingerprint: context.lock.schema_fingerprint, role_posture_fingerprint: context.lock.role_posture_fingerprint };
    const earlier = buildBoundaryAuthoringResumeState({ binding, stage: "action_drafting", jobIntent: "Keep the selected parcel program.",
      provider: "openai", model: "owned-offline", action: { intent: "Parcel one", intents: Array.from({ length: 9 }, (_, i) => `Parcel ${i + 1}`) } });
    // A deliberately reduced larger agenda keeps v2 semantics; no coverage,
    // permission or readiness is fabricated by this host progress record.
    let state = buildBoundaryAuthoringResumeState({ binding, previous: earlier, stage: "authority_review", jobIntent: earlier.job_intent,
      provider: "openai", model: "owned-offline", action: { intent: "Parcel one", intents: ["Parcel one", "Parcel two"],
        completed_outcomes: request.actions.map((action: { outcome: string }) => action.outcome) } });
    await writeBoundaryAuthoringResumeState(root, state, { expectedRevisionDigest: null });
    const original = (await readActionRuleAuthorityDraft(root, `${context.candidate.pack.name}_rules`))!;
    await expect(assertCompleteSelectedActionProgram({ projectRoot: root, draft: original })).resolves.toBeUndefined();
    const removed = request.actions[1].outcome;
    const prepared = await prepareSavedActionRuleRemoval(root, removed);
    if (prepared.mode === "deactivate") throw new Error("Expected a retained replacement.");
    await writeActionRuleAuthorityDraftIfCurrent(root, prepared.draft, prepared.baseline);
    const pending = { outcome: removed, authority_name: prepared.draft.authority.name, draft_digest: prepared.draft.digest };
    const next = buildBoundaryAuthoringResumeState({ binding, previous: state, stage: "authority_review", jobIntent: state.job_intent,
      provider: "openai", model: "owned-offline", action: { intent: "Parcel one", intents: ["Parcel one"],
        completed_outcomes: prepared.retainedOutcomes }, pendingActionRemoval: pending });
    await writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: state.revision_digest });
    state = next;
    expect(unfinishedActionIntents(state, prepared.retainedOutcomes)).toEqual([`Requested removal: ${removed}`]);
    await expect(assertCompleteSelectedActionProgram({ projectRoot: root, draft: prepared.draft })).resolves.toBeUndefined();
    expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: state });
    expect(isPreparedProgramRemoval(state, prepared.draft)).toBe(true);
    const interrupted = buildBoundaryAuthoringResumeState({ binding, previous: state, stage: "authority_review", jobIntent: state.job_intent,
      provider: "openai", model: "owned-offline", pendingActionRemoval: pending,
      action: { ...state.action!, checkpoint: actionRuleAuthoringCheckpoint({ intent_digest: canonicalJsonDigest(state.action!.intent),
        context_digest: canonicalJsonDigest(binding), components: {} }) } });
    expect(isPreparedProgramRemoval(interrupted, prepared.draft)).toBe(false);
    const display = await readSavedActionJobReview({ projectRoot: root, boundaryName: binding.boundary_name,
      currentOutcomes: prepared.retainedOutcomes, currentDraft: prepared.draft });
    expect(display.completeProgram?.draftsComplete).toBe(true);
    expect(display.summary.join("\n")).toContain(`Removal of ${removed} remains pending until separate publication`);
    expect((await readSavedActionJobReview({ projectRoot: root, boundaryName: binding.boundary_name,
      currentOutcomes: prepared.retainedOutcomes })).completeProgram?.draftsComplete).toBe(false);
    for (const fault of ["digest", "name", "still_present", "deactivate", "unprepared"] as const) {
      const pendingActionRemoval = fault === "digest" ? { ...pending, draft_digest: original.digest }
        : fault === "name" ? { ...pending, authority_name: "different_saved_bundle" }
        : fault === "still_present" ? { ...pending, outcome: prepared.retainedOutcomes[0]! }
        : fault === "deactivate" ? { ...pending, mode: "deactivate" as const }
        : pending;
      const changed = buildBoundaryAuthoringResumeState({ binding, previous: state, stage: fault === "unprepared" ? "action_drafting" : "authority_review",
        jobIntent: state.job_intent, provider: "openai", model: "owned-offline", pendingActionRemoval });
      await writeBoundaryAuthoringResumeState(root, changed, { expectedRevisionDigest: state.revision_digest });
      state = changed;
      await expect(assertCompleteSelectedActionProgram({ projectRoot: root, draft: prepared.draft })).rejects.toThrow("AUTHORING_PROGRAM_NOT_READY");
      expect((await readActionRuleAuthorityDraft(root, prepared.draft.authority.name))!.digest).toBe(prepared.draft.digest);
    }
    const sources = newPolicySourceSession();
    const source = policyTextSnapshot(Buffer.from("Every retained parcel must refuse unavailability. External audit remains pending."), "owned-removal-source.txt");
    sources.snapshots = [source]; sources.active = source.version;
    await savePolicySources(root, sources, { expectedDigest: null });
    const uncovered = buildBoundaryAuthoringResumeState({ binding, previous: state, stage: "authority_review", jobIntent: state.job_intent,
      provider: "openai", model: "owned-offline", pendingActionRemoval: pending, policySourceSession: sources.id });
    await writeBoundaryAuthoringResumeState(root, uncovered, { expectedRevisionDigest: state.revision_digest });
    await expect(assertCompleteSelectedActionProgram({ projectRoot: root, draft: prepared.draft })).rejects.toThrow("Full attached source coverage");
    expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: uncovered });
  } finally {
    stdout.mockRestore();
    if (previousUrl === undefined) delete process.env.OWNED_STUDIO_READ_URL; else process.env.OWNED_STUDIO_READ_URL = previousUrl;
    await fs.rm(root, { recursive: true, force: true });
  }
}, 20000);
