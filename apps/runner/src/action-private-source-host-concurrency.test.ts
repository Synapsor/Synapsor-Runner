import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { buildAutoBoundary, emptyReviewOverrides, explorationBoundaryCandidateDigest, loadActivatedExplorationBoundaries, writeAutoBoundaryArtifacts } from "./auto-boundary.js";
import { applyManagedBoundaryReviewDecision } from "./boundary-review-domain.js";
import { prepareBoundaryResourceReviewMutation, commitBoundaryResourceReviewMutation } from "./boundary-review-mutation.js";
import { boundaryReviewCommand, loadBoundaryReviewContext } from "./boundary-commands.js";
import { readActionRuleAuthorityActivation } from "./action-rule-authority.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState, type BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { actionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import type { ModelActionRuleDraftInput } from "./action-rule-model.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import type { BoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import { AskError } from "./model-ask.js";
import { buildReadWorkloadPlanCards, readWorkloadFromPlanCards, analyzeReadWorkloadSet } from "./read-workload-assist.js";
import { storeReadWorkloadAnalysis } from "./read-workloads.js";

const roots: string[] = [];
const parent = "public.service_visits", child = "public.visit_freezes";
const intent = "Prepare a verified visit change using its private freeze facts.";
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-private-source-host-")); roots.push(root);
  const tables: SchemaInspection["tables"] = ["service_visits", "visit_freezes"].map(name => ({
    schema: "public", name, type: "table", writable: true,
    columns: ["id", "tenant_id", "principal_id", "status", "version", ...(name === "visit_freezes" ? ["visit_id"] : [])].map((field, i) => ({
      name: field, data_type: field === "version" ? "integer" : field === "status" ? "text" : "uuid", nullable: false,
      generated: false, ordinal_position: i + 1, ...(field === "status" ? { enum_values: ["scheduled", "completed"] } : {}),
      suggestions: { tenant: field === "tenant_id", conflict: field === "version", sensitive: false, immutable: field.endsWith("id"), large_or_binary: false },
    })), primary_key: ["id"], unique_constraints: [{ name: `${name}_pkey`, columns: ["id"] }, { name: `${name}_full_scope`, columns: ["id", "tenant_id", "principal_id"] }],
    indexes: [], foreign_keys: [], row_level_security: true,
    row_level_security_policies: [{ name: "scoped_select", command: "SELECT", roles: ["reader"], permissive: true,
      using_expression: "tenant_id = current_setting('app.tenant_id', true)::uuid AND principal_id = current_setting('app.principal_id', true)::uuid" }],
    role_posture: { owner: "owner", current_role_is_owner: false, current_role_can_assume_owner: false,
      row_security_forced: true, row_security_effective_for_current_role: true,
      privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false } },
    suggestions: { tenant_columns: ["tenant_id"], conflict_columns: ["version"], sensitive_columns: [], default_visible_columns: ["id", "status"] },
  }));
  tables[1]!.foreign_keys = [{ name: "visit_freezes_full_scope_fk", columns: ["visit_id", "tenant_id", "principal_id"],
    referenced_schema: "public", referenced_table: "service_visits", referenced_columns: ["id", "tenant_id", "principal_id"], delete_rule: "RESTRICT" }];
  const inspection: SchemaInspection = { engine: "postgres", server_version: "PostgreSQL 17", current_user: "reader",
    inspected_at: "2026-09-11T00:00:00.000Z", schemas: ["public"], warnings: [], tables,
    role_posture: { verified: true, superuser: false, bypass_rls: false, read_only: true, writable_relations: [], owned_relations: [], reasons: [] } };
  let overrides = emptyReviewOverrides();
  for (const resource_id of [parent, child]) overrides = applyManagedBoundaryReviewDecision(overrides, {
    resource_id, kind: "principal_key", value: "principal_id", actor: "test-owner", reason: "Exact synthetic owner scope.", decided_at: inspection.inspected_at,
  });
  const build = buildAutoBoundary({ inspection, overrides, sourceEnv: "DATABASE_URL", inspectedSchema: "public",
    project: { root, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
  await writeAutoBoundaryArtifacts({ projectRoot: root, build });
  await commitBoundaryResourceReviewMutation(root, await prepareBoundaryResourceReviewMutation(root, {
    resource_id: child, exclude: true, actor: "test-owner", reason: "Keep freeze facts available only to separate private verification review.",
  }, async () => inspection));
  const context = await loadBoundaryReviewContext(root);
  const card = buildReadWorkloadPlanCards(context.candidate).find(card => card.plan.kind === "aggregate" && card.plan.resource === parent)!;
  const workload = readWorkloadFromPlanCards({ cards: [card], selectedIds: [card.id] });
  const stored = await storeReadWorkloadAnalysis({ projectRoot: root, generatedBoundary: context.candidate,
    source: workload.source, analysis: analyzeReadWorkloadSet({ workload, generatedBoundary: context.candidate }) });
  await writeBoundaryAuthoringResumeState(root, buildBoundaryAuthoringResumeState({
    binding: { boundary_name: context.candidate.pack.name, generation_lock_fingerprint: context.candidate.generation_lock_fingerprint,
      schema_fingerprint: context.lock.schema_fingerprint, role_posture_fingerprint: context.lock.role_posture_fingerprint },
    stage: "action_drafting", jobIntent: intent, provider: "openai", model: "gpt-test",
    read: { analysis_id: stored.analysis_id, analysis_digest: stored.analysis_digest },
    action: { intent, intents: [intent], strategy: "rule_derived" },
  }));
  return { root, inspection };
}

describe("public Action private-source host freshness", () => {
  it.each(["before_consent", "during_consent", "before_checkpoint"] as const)("rejects same-Read complete job removal at %s without restoring it", async timing => {
    const f = await fixture();
    const resumeFile = path.join(f.root, ".synapsor/boundary-authoring/resume.json");
    let removed: BoundaryAuthoringResumeState | undefined, readBefore: string | undefined;
    const remove = async () => {
      const current = JSON.parse(await fs.readFile(resumeFile, "utf8")) as BoundaryAuthoringResumeState;
      removed = buildBoundaryAuthoringResumeState({ binding: current.binding, stage: "planning", jobIntent: "Read service visits only; withdraw the change job entirely.",
        provider: "openai", model: "gpt-test", previous: current });
      await writeBoundaryAuthoringResumeState(f.root, removed, { expectedRevisionDigest: current.revision_digest });
    };
    const consent = vi.fn(async () => { if (timing === "during_consent") await remove(); return "allow"; });
    const generator = vi.fn(async (request: ModelActionRuleDraftInput) => {
      readBefore = explorationBoundaryCandidateDigest((await loadBoundaryReviewContext(f.root)).candidate);
      expect(request.readBoundary.pack.resources.some(resource => resource.id === child)).toBe(false);
      if (timing === "before_consent") await remove();
      const review = () => request.reviewPrivateSource!({ resource: child, parentResource: parent,
        context: { builtCatalog: request.builtCatalog, readBoundary: request.readBoundary, readBoundaryDigest: request.readBoundaryDigest } });
      if (timing === "before_checkpoint") {
        const reviewed = await review();
        expect(reviewed?.review.resource).toBe(child);
        await remove();
        await expect(request.onCheckpoint!(actionRuleAuthoringCheckpoint({ intent_digest: canonicalJsonDigest(request.intent),
          context_digest: canonicalJsonDigest("pending context"), components: {}, reviewed_private_sources: [reviewed!.review] })))
          .rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
      } else await expect(review()).rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
      throw new AskError("ASK_CANCELLED", "Stop after the deterministic host conflict.", 499);
    });
    await run(f, generator, consent);
    expect(generator).toHaveBeenCalledOnce();
    expect(consent).toHaveBeenCalledTimes(timing === "before_consent" ? 0 : 1);
    expect(removed).toBeDefined();
    expect(await readBoundaryAuthoringResumeState(f.root, removed!.binding)).toEqual({ status: "ready", value: removed });
    expect(removed!.action).toBeUndefined();
    expect(explorationBoundaryCandidateDigest((await loadBoundaryReviewContext(f.root)).candidate)).toBe(readBefore);
    expect(await readActionRuleAuthorityActivation(f.root)).toBeUndefined();
    await expect(loadActivatedExplorationBoundaries(f.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["denied", "uncertain"] as const)("reopens exact saved work after a %s checkpoint save without silently advancing the session baseline", async failure => {
    const f = await fixture(), resumeFile = path.join(f.root, ".synapsor/boundary-authoring/resume.json");
    const readBefore = explorationBoundaryCandidateDigest((await loadBoundaryReviewContext(f.root)).candidate);
    const originalRename = fs.rename;
    let deny = false, runNumber = 1;
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (!deny || String(to) !== resumeFile) return originalRename(from, to);
      if (failure === "uncertain") await originalRename(from, to);
      throw Object.assign(new Error("TEST_PRIVATE_CHECKPOINT_EACCES"), { code: "EACCES" });
    });
    const consent = vi.fn(async () => "allow");
    const checkpoints: ReturnType<typeof actionRuleAuthoringCheckpoint>[] = [];
    const generator = vi.fn(async (request: ModelActionRuleDraftInput) => {
      const previous = request.checkpoint?.reviewed_private_sources?.[0];
      expect(Boolean(previous)).toBe(runNumber === 2 && failure === "uncertain");
      const reviewed = await request.reviewPrivateSource!({ resource: child, parentResource: parent,
        context: { builtCatalog: request.builtCatalog, readBoundary: request.readBoundary, readBoundaryDigest: request.readBoundaryDigest },
        ...(previous ? { previousReview: previous } : {}) });
      expect(reviewed?.review.resource).toBe(child);
      const checkpoint = actionRuleAuthoringCheckpoint({ intent_digest: canonicalJsonDigest(request.intent),
        context_digest: canonicalJsonDigest({ catalog: reviewed!.builtCatalog.catalog, read: request.readBoundaryDigest, baseline: null }),
        components: {}, operator_messages: ["Keep the original private freeze condition pending full validation."],
        reviewed_private_sources: [reviewed!.review] });
      checkpoints.push(checkpoint);
      if (runNumber === 1) {
        deny = true;
        await expect(request.onCheckpoint!(checkpoint)).rejects.toThrow("TEST_PRIVATE_CHECKPOINT_EACCES");
        // A second explicit caller attempt is not an acknowledgement of an
        // uncertain write. Permanent denial also keeps the old saved record.
        await expect(request.onCheckpoint!(checkpoint)).rejects.toThrow(failure === "uncertain"
          ? "BOUNDARY_AUTHORING_RESUME_CHANGED" : "TEST_PRIVATE_CHECKPOINT_EACCES");
      } else await request.onCheckpoint!(checkpoint);
      throw new AskError("ASK_CANCELLED", "Pause after the exact checkpoint boundary.", 499);
    });
    await run(f, generator, consent);
    const first = JSON.parse(await fs.readFile(resumeFile, "utf8")) as BoundaryAuthoringResumeState;
    expect(first.action?.checkpoint).toEqual(failure === "uncertain" ? checkpoints[0] : undefined);
    deny = false; rename.mockRestore(); runNumber = 2;
    await run(f, generator, consent);
    const second = JSON.parse(await fs.readFile(resumeFile, "utf8")) as BoundaryAuthoringResumeState;
    expect(second.action?.checkpoint).toEqual(checkpoints[1]);
    expect(generator).toHaveBeenCalledTimes(2);
    expect(consent).toHaveBeenCalledTimes(failure === "uncertain" ? 1 : 2);
    expect(explorationBoundaryCandidateDigest((await loadBoundaryReviewContext(f.root)).candidate)).toBe(readBefore);
    expect(await readActionRuleAuthorityActivation(f.root)).toBeUndefined();
    await expect(loadActivatedExplorationBoundaries(f.root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function run(f: Awaited<ReturnType<typeof fixture>>, generator: (request: ModelActionRuleDraftInput) => Promise<never>, consent: () => Promise<string>) {
  const session: BoundaryReviewInteractiveSession = {
    chooseResource: async () => undefined, editFieldTiers: async () => undefined,
    promptText: async prompt => { if (prompt === "What job are you giving this agent?") return intent; throw new Error(`Unexpected prompt: ${prompt}`); },
    chooseOption: async (title, _choices, options) => {
      if (title === "CLIENT FOR THIS JOB") return "later";
      if (title === "START BOUNDARY DRAFTING") return "resume";
      if (title === "REVIEW SUPPORTING SOURCE") return consent();
      if (title === "ACTION BOUNDARY MODEL DRAFT FAILED") return "back";
      throw new Error(`Unexpected choice: ${title}; ${JSON.stringify(options?.context)}; ${JSON.stringify(vi.mocked(chat.rememberDetails).mock.calls)}`);
    }, confirm: async () => true, confirmReviewedDisabled: async () => true,
    confirmActivation: async () => { throw new Error("Host freshness test must not activate."); },
  };
  const chat: BoundaryAuthoringChat = {
    session: { ...session, presentationMode: "conversation" },
    actionPrompter: { choose: async () => undefined, text: async () => undefined, confirm: async () => undefined, message: async () => undefined },
    setModel: vi.fn(), setPermissionGuide: vi.fn(), runner: vi.fn(), model: vi.fn(), checkpoint: vi.fn(),
    streamRunner: async () => undefined, streamCheckpoint: async () => undefined, streamModel: async () => undefined,
    rememberDetails: vi.fn(), showDetails: vi.fn(), providerStream: vi.fn(), progress: async (_message, operation) => operation(), close: vi.fn(),
  };
  return boundaryReviewCommand(["--project-root", f.root, "--access", "--job-first"], async () => f.inspection, session, undefined, {
    startWithAgentJob: true, modelAuthoringSession: { provider: "openai", model: "gpt-test", apiKey: "synthetic-secret" },
    modelBoundaryJobPlanner: async () => { throw new Error("The saved job must not be replanned."); },
    modelReadWorkloadGenerator: async () => { throw new Error("The saved Read must not be remapped."); },
    modelActionRuleGenerator: generator, actionProjectInspector: async () => f.inspection,
    modelAuthoringNarrator: async () => "The draft remains disabled.", boundaryAuthoringChatFactory: () => chat,
  });
}
