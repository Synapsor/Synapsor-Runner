import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { onboard } from "./guided-start.js";
import { structuredBoundaryAuthoringCommand } from "./boundary-structured-authoring.js";
import { loadBoundaryReviewContext, boundaryReviewCommand } from "./boundary-commands.js";
import { activateExplorationBoundary, explorationBoundaryCandidateDigest } from "./auto-boundary.js";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, updateBoundaryPolicyReview } from "./boundary-authoring-resume.js";
import { readActionRuleAuthorityDraft, readActionRuleAuthorityActivation, writeActionRuleAuthorityDraftIfCurrent,
  readActionRuleAuthorityRevisionBaseline, buildActionRuleAuthorityDraft, readActionRuleCoverageLineage, readActionRuleReviewSubjects } from "./action-rule-authority.js";
import { prepareSavedActionRuleRemoval } from "./action-rule-removal.js";
import { activateSemanticActionRuntime } from "./semantic-action-deployment.js";
import { assessActionWithdrawal } from "./action-rule-withdrawal.js";
import { assertCompleteSelectedActionProgram, readSavedActionJobReview } from "./saved-action-job-review.js";
import { savedAuthoringPolicyReview } from "./authoring-saved-review.js";
import { newPolicySourceSession, policyTextSnapshot, savePolicySources, bindPolicyCoverage, loadPolicySources } from "./authoring-policy-source.js";
import { parsePolicyCoverage } from "./authoring-policy-coverage.js";
import { actionRuleModelDraftFromAuthority } from "./action-rule-draft.js";
import { reviewVerifiedActionAuthority } from "./verified-action-review.js";
import { ownedProgramDraft, ownedProgramInspection } from "./test-fixtures/owned-authoring-program.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true }); });

/** DERIVED coherent host fixture, using canonical public preparation, actual
 * dependency assessment and publication. It is not authentic installed50 or
 * provider evidence; no business source connection, worker or effect exists. */
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "withdrawal-current-host-")); roots.push(root);
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output += String(chunk); return true; });
  const inspect = async () => ownedProgramInspection();
  expect(await onboard(["db", "--project-root", root, "--from-env", "OWNED_STUDIO_READ_URL", "--schema", "studio", "--json"],
    { interactive: false, schemaInspector: inspect }), output).toBe(0);
  const command = (args: string[]) => structuredBoundaryAuthoringCommand(["--project-root", root, ...args], inspect);
  expect(await command(["--export-draft", "input.json", "--json"]), output).toBe(0);
  const request = JSON.parse(await fs.readFile(path.join(root, "input.json"), "utf8"));
  request.read.resources = [{ resource_id: "studio.parcels", include: true, tenant_key: "tenant_id", principal_key: "principal_id", row_identity: "parcel_id",
    selectable_fields: ["label", "units", "available", "version"], keep_out_fields: ["internal_note"],
    withhold_from_model_fields: ["available", "version"], private_model_fields: ["available", "version"] }];
  request.actions = [ownedProgramDraft(1), ownedProgramDraft(2)];
  await fs.writeFile(path.join(root, "input.json"), JSON.stringify(request));
  expect(await command(["--draft", "input.json", "--json"]), output).toBe(0);
  const ctx = await loadBoundaryReviewContext(root);
  const readDigest = explorationBoundaryCandidateDigest(ctx.candidate);
  let readVisits = 0;
  expect(await boundaryReviewCommand(["--project-root", root, "--access"], inspect, {
    chooseResource: async () => readVisits++ === 0 ? { action: "confirm" } : undefined,
    editFieldTiers: async () => undefined, promptText: async () => "DERIVED fixture local operator",
    confirm: async () => true, confirmActivation: async () => true,
  }), output).toBe(0);
  const activeDraft = (await readActionRuleAuthorityDraft(root, `${ctx.candidate.pack.name}_rules`))!;
  const active = (await activateSemanticActionRuntime({ projectRoot: root, draft: activeDraft, actor: "DERIVED fixture local operator" })).activation;
  const prepared = await prepareSavedActionRuleRemoval(root, request.actions[1].outcome);
  if (prepared.mode === "deactivate") throw new Error("Expected one retained Action.");
  await writeActionRuleAuthorityDraftIfCurrent(root, prepared.draft, prepared.baseline);
  const draft = prepared.draft;
  const binding = { boundary_name: ctx.candidate.pack.name, generation_lock_fingerprint: ctx.candidate.generation_lock_fingerprint,
    schema_fingerprint: ctx.lock.schema_fingerprint, role_posture_fingerprint: ctx.lock.role_posture_fingerprint };
  const session = newPolicySourceSession();
  const source = policyTextSnapshot(Buffer.from("Keep parcel one and parcel two.\nExternal audit remains pending."), "derived-original-selection.txt");
  session.snapshots = [source]; session.active = source.version;
  const actions = draft.authority.rules.map(r => actionRuleModelDraftFromAuthority({ authority: draft.authority, outcome: r.rule.outcome,
    review: draft.reviews.find(v => v.outcome === r.rule.outcome)!, preserveVerificationFields: true }));
  const report = parsePolicyCoverage({ passages: [
    { start: 1, end: 1, disposition: "needs_decision", interpretation: "One original Action is absent; the original selected job stays pending.", draft_paths: [], responsibility: "operator", issue_kind: "business_choice", next_step: "Retain original job pending." },
    { start: 2, end: 2, disposition: "needs_decision", interpretation: "External audit duty remains pending.", draft_paths: [], responsibility: "operator", issue_kind: "business_choice", next_step: "Resolve external audit ownership separately." },
  ] }, source, { actions, runner_evidence: { runtime_contract: { client_contract: { mode: "interactive_four_tool", client: "unselected" } } } }, []);
  bindPolicyCoverage(session, report, canonicalJsonDigest({ read: readDigest, action: draft.digest }));
  await savePolicySources(root, session, { expectedDigest: null });
  // Use real v2 current agenda factories: earlier selected9, coherent current2,
  // then prepared removal1. Original job and policy are retained, never rewritten.
  const old = buildBoundaryAuthoringResumeState({ binding, stage: "action_drafting", jobIntent: "Original selected parcel job and external audit.",
    provider: "openai", model: "DERIVED-offline", action: { intent: "Parcel one", intents: Array.from({ length: 9 }, (_, i) => `Parcel ${i + 1}`) } });
  const resume = buildBoundaryAuthoringResumeState({ binding, previous: old, stage: "authority_review", jobIntent: old.job_intent,
    provider: "openai", model: "DERIVED-offline", policySourceSession: session.id,
    action: { intent: "Parcel one", intents: ["Parcel one"], completed_outcomes: prepared.retainedOutcomes },
    pendingActionRemoval: { outcome: request.actions[1].outcome, authority_name: draft.authority.name, draft_digest: draft.digest },
    pendingPolicyReview: { operation: "review_rules", request: "Review attached rules and unresolved decisions",
      source_session: session.id, source_digest: source.digest as `sha256:${string}`, read_digest: readDigest,
      action_name: draft.authority.name, action_digest: draft.digest,
      action_subject: (await readActionRuleReviewSubjects(root)).find(s => s.identity.location === "disabled" && s.authority.digest === draft.digest)!.identity } });
  await writeBoundaryAuthoringResumeState(root, resume, { expectedRevisionDigest: null });
  return { root, draft, active, session, binding, readDigest, resume };
}

describe("exact withdrawal without BUSINESS completion", () => {
  it("publishes and reloads exact reduction with pending full-source duties; normal readiness remains false", async () => {
    const f = await fixture();
    const review = await savedAuthoringPolicyReview({ projectRoot: f.root, binding: f.binding, readDigest: f.readDigest, exactActionDraft: f.draft });
    expect(review).toMatchObject({ ready: false, dependencies_current: true });
    await expect(assertCompleteSelectedActionProgram({ projectRoot: f.root, draft: f.draft })).rejects.toThrow("AUTHORING_PROGRAM_NOT_READY");
    const consent = await assessActionWithdrawal({ projectRoot: f.root, draft: f.draft });
    const result = await activateSemanticActionRuntime({ projectRoot: f.root, draft: f.draft, actor: "DERIVED fixture local operator",
      withdrawalContext: consent.review_context_digest });
    expect(result.activation.publication).toEqual(consent);
    expect((await readActionRuleAuthorityActivation(f.root))!.publication).toEqual(consent);
    expect(result.activation.authority.rules).toEqual(f.draft.authority.rules);
    expect(await loadPolicySources(f.root, f.session.id)).toEqual(f.session);
    expect(await readBoundaryAuthoringResumeState(f.root, f.binding)).toEqual({ status: "ready", value: f.resume });
    const status = await readSavedActionJobReview({ projectRoot: f.root, boundaryName: f.binding.boundary_name,
      currentOutcomes: f.draft.authority.rules.map(r => r.rule.outcome), currentActivation: result.activation });
    expect(status.completeProgram?.draftsComplete).toBe(false);
    expect(status.summary.join("\n")).toContain("original job and source duties remain pending");
    expect(status.details).toContain(f.resume.job_intent);
    const lineage = await readActionRuleCoverageLineage(f.root, result.activation, f.readDigest);
    expect(lineage?.origins.some(o => o.authority.digest === f.active.digest && o.transitions.some(t => t.removed_outcomes.includes("studio.pack_parcel_2")))).toBe(true);
  }, 20000);

  it.each([false, undefined])("ordinary adapter defaults No/cancel and preserves authority/history (%s)", async answer => {
    const f = await fixture(); const before = await readActionRuleAuthorityRevisionBaseline(f.root);
    let step = 0;
    const confirm = vi.fn(async (_title, options) => { expect(options.defaultValue).toBe(false); expect(options.context.join("\n")).toContain("BUSINESS review remain pending"); return answer; });
    const result = await reviewVerifiedActionAuthority({ projectRoot: f.root, boundaryName: f.binding.boundary_name, draft: f.draft, active: f.active,
      session: { chooseOption: async (_title, choices) => { expect(choices.some(c => c.value === "withdraw")).toBe(true); return step++ === 0 ? "withdraw" : "back"; },
        confirm, promptText: async () => undefined, chooseResource: async () => undefined, editFieldTiers: async () => undefined } });
    expect(confirm).toHaveBeenCalledOnce(); expect(result).toBeDefined();
    expect(await readActionRuleAuthorityRevisionBaseline(f.root)).toEqual(before);
    expect(await loadPolicySources(f.root, f.session.id)).toEqual(f.session);
  }, 20000);

  it("ordinary adapter Yes records withdrawal, never original-job completion", async () => {
    const f = await fixture();
    const result = await reviewVerifiedActionAuthority({ projectRoot: f.root, boundaryName: f.binding.boundary_name, draft: f.draft, active: f.active,
      session: { chooseOption: async (_title, choices, opts) => { expect(opts?.initialValue).not.toBe("withdraw"); expect(choices.some(c => c.value === "withdraw")).toBe(true); return "withdraw"; },
        confirm: async (_title, opts) => { expect(opts?.defaultValue).toBe(false); return true; },
        promptText: async () => undefined, chooseResource: async () => undefined, editFieldTiers: async () => undefined } });
    expect(result.title).toContain("withdrawal published");
    expect((await readActionRuleAuthorityActivation(f.root))!.publication?.business_review_completed).toBe(false);
  }, 20000);

  it.each(["source", "operator", "draft", "resume", "configuration"])("refuses obsolete consent after %s changes; no partial publication", async fault => {
    const f = await fixture(); const consent = await assessActionWithdrawal({ projectRoot: f.root, draft: f.draft });
    if (fault === "source" || fault === "operator") {
      const changed = structuredClone(f.session);
      if (fault === "source") { const v2 = policyTextSnapshot(Buffer.from("A new exception outside prior coverage."), "changed.txt", 2); changed.snapshots.push(v2); changed.active = v2.version; }
      else changed.operator_messages = ["Separate current operator message."];
      await savePolicySources(f.root, changed, { expectedDigest: canonicalJsonDigest(f.session) });
    } else if (fault === "draft") {
      const { activated_at: _at, ...retained } = f.draft.authority.rules[0]!;
      const changed = buildActionRuleAuthorityDraft({ name: f.draft.authority.name, action_boundary_name: f.draft.authority.action_boundary.name,
        catalog: f.draft.authority.catalog, rules: [{ ...retained, rule: { ...retained.rule, ttl_seconds: retained.rule.ttl_seconds - 1 } }],
        approval_classes: f.draft.authority.approval_classes, reviews: f.draft.reviews, now: f.draft.created_at });
      await writeActionRuleAuthorityDraftIfCurrent(f.root, changed, await readActionRuleAuthorityRevisionBaseline(f.root));
    } else if (fault === "configuration") {
      const file = path.join(f.root, "synapsor.actions.runner.json");
      const changed = JSON.parse(await fs.readFile(file, "utf8"));
      changed.server = { ...changed.server, name: "competing-configuration" };
      await fs.writeFile(file, JSON.stringify(changed));
    } else {
      const changed = buildBoundaryAuthoringResumeState({ binding: f.binding, previous: f.resume, stage: "authority_review",
        jobIntent: f.resume.job_intent, provider: "openai", model: "DERIVED-offline", pendingJobRevision: "Another current job" });
      await writeBoundaryAuthoringResumeState(f.root, changed, { expectedRevisionDigest: f.resume.revision_digest });
    }
    const before = await readActionRuleAuthorityRevisionBaseline(f.root);
    await expect(activateSemanticActionRuntime({ projectRoot: f.root, draft: f.draft, actor: "DERIVED fixture local operator",
      withdrawalContext: consent.review_context_digest })).rejects.toThrow("ACTION_RULE_WITHDRAWAL_NOT_CURRENT");
    expect(await readActionRuleAuthorityRevisionBaseline(f.root)).toEqual(before);
    expect((await readActionRuleAuthorityActivation(f.root))!.digest).toBe(f.active.digest);
  }, 20000);
  it.each(["source", "session", "read", "action", "name", "store", "record", "missing_subject"])("retains and refuses a foreign pending-review %s binding", async fault => {
    const f = await fixture(); const pending = structuredClone(f.resume.pending_policy_review!);
    const foreign = `sha256:${"0".repeat(64)}` as const;
    if (fault === "source") pending.source_digest = foreign;
    if (fault === "session") pending.source_session = "00000000-0000-4000-8000-000000000001";
    if (fault === "read") pending.read_digest = foreign;
    if (fault === "action") pending.action_digest = foreign;
    if (fault === "name") pending.action_name = "another_authority";
    if (fault === "store") pending.action_subject!.store = foreign;
    if (fault === "record") pending.action_subject!.record = "foreign-policy-record";
    if (fault === "missing_subject") delete pending.action_subject;
    const changed = updateBoundaryPolicyReview(f.resume, { pending });
    await writeBoundaryAuthoringResumeState(f.root, changed, { expectedRevisionDigest: f.resume.revision_digest });
    const before = await readActionRuleAuthorityRevisionBaseline(f.root);
    await expect(assessActionWithdrawal({ projectRoot: f.root, draft: f.draft })).rejects.toThrow("pending review is not bound");
    expect(await readActionRuleAuthorityRevisionBaseline(f.root)).toEqual(before);
    expect(await readBoundaryAuthoringResumeState(f.root, f.binding)).toEqual({ status: "ready", value: changed });
  }, 20000);

});
