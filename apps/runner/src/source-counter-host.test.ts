import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { buildAutoBoundary, writeAutoBoundaryArtifacts, loadActivatedExplorationBoundaries, activateExplorationBoundary } from "./auto-boundary.js";
import { boundaryReviewCommand, loadBoundaryReviewContext } from "./boundary-commands.js";
import { buildActionRuleAuthoringCatalog } from "./action-rule-authoring.js";
import { compileActionRuleModelDraft, type ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { buildActionRuleAuthorityDraft, writeActionRuleAuthorityDraft, readActionRuleAuthorityDraft,
  readActionRuleAuthorityActivation, activateActionRuleAuthority } from "./action-rule-authority.js";
import { saveBoundaryReviewProgress } from "./boundary-review-persistence.js";
import { createBoundaryReviewProgress } from "./boundary-review-domain.js";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { newPolicySourceSession, policyTextSnapshot, authoringDestination, savePolicySources, loadPolicySources } from "./authoring-policy-source.js";
import { buildReadWorkloadPlanCards, readWorkloadFromPlanCards, analyzeReadWorkloadSet } from "./read-workload-assist.js";
import { storeReadWorkloadAnalysis, recordReadWorkloadReview } from "./read-workloads.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import type { BoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import { AskError } from "./model-ask.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-existing-counter-host-"));
  const inspection: SchemaInspection = { engine: "postgres", server_version: "PostgreSQL 17", current_user: "reader",
    inspected_at: "2026-09-11T00:00:00Z", schemas: ["public"], warnings: [],
    role_posture: { verified: true, read_only: true, superuser: false, bypass_rls: false, owned_relations: [], writable_relations: [], reasons: [] },
    tables: ["records", "checks"].map(name => ({ schema: "public", name, type: "table", writable: true,
      columns: [["id", "uuid"], ["tenant_id", "uuid"], ["status", "text"], ["version", "integer"]].map(([field, type], i) => ({
        name: field!, data_type: type!, nullable: false, generated: false, ordinal_position: i + 1,
        ...(field === "status" ? { enum_values: ["ready", "done"] } : {}),
        suggestions: { tenant: field === "tenant_id", conflict: field === "version", sensitive: false,
          immutable: field === "id" || field === "tenant_id", large_or_binary: false },
      })),
      primary_key: ["id"], unique_constraints: [{ name: `${name}_pk`, columns: ["id"] }],
      indexes: [{ name: `${name}_pk`, columns: ["id"], unique: true }], foreign_keys: [], row_level_security: true,
      row_level_security_policies: [{ name: "scoped_read", command: "SELECT", permissive: true, roles: ["reader"],
        using_expression: "tenant_id = current_setting('app.tenant_id')::uuid" }],
      role_posture: { owner: "owner", current_role_is_owner: false, current_role_can_assume_owner: false,
        privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false },
        row_security_forced: true, row_security_effective_for_current_role: true, row_security_applicable_policies: ["scoped_read"] },
      suggestions: { tenant_columns: ["tenant_id"], conflict_columns: ["version"], sensitive_columns: [], default_visible_columns: ["status"] },
    })) };
  const build = buildAutoBoundary({ inspection, sourceEnv: "DATABASE_URL", inspectedSchema: "public",
    project: { root, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
  await writeAutoBoundaryArtifacts({ projectRoot: root, build });
  const context = await loadBoundaryReviewContext(root), catalog = buildActionRuleAuthoringCatalog({ boundary: context.candidate, inspection });
  expect(catalog.catalog.resources.every(resource => resource.version_field === "version")).toBe(true);
  const status = catalog.catalog.resources[0]!.fields.find(field => field.name === "status")!.type;
  const draft: ActionRuleModelDraftV1 = { schema_version: "synapsor.action-rule-model-draft.v1", name: "work.finish", outcome: "work.finish",
    verification: { name: "work.verify", resources: ["records", "checks"].map(binding => ({ binding, resource: `public.${binding}`,
      source: { kind: "subject_ref" }, fields: ["status"] })) },
    effect: { name: "work.effect", operation: "update", target_resource: "public.records", target_binding: "records", writeback: "supervised",
      allowed_fields: [{ name: "status", values: ["done"] }], set: { status: { kind: "literal", value: "done", value_type: status } },
      atomic_updates: [{ operation: "update", target_resource: "public.checks", target_binding: "checks",
        allowed_fields: [{ name: "status", values: ["done"] }], set: { status: { kind: "literal", value: "done", value_type: status } } }] },
    require: { kind: "all", expressions: ["records", "checks"].map(binding => ({ kind: "compare", operator: "eq",
      left: { kind: "field", binding, field: "status" }, right: { kind: "literal", value: "ready", value_type: status } })) },
    derive: {}, approval: { mode: "human", class_name: "work.review", required_role: "reviewer", required_approvals: 1, shared_limits: [] },
    ttl_seconds: 300, review: { when: "Both selected records are ready.", then: "Complete both atomically.",
      refused: ["One is not ready."], human_review: "One reviewer.", examples: [{ kind: "eligible", scenario: "Both ready", result: "Review" }] },
  };
  const compiled = compileActionRuleModelDraft({ draft, builtCatalog: catalog, readBoundary: context.candidate, readBoundaryDigest: context.bundle.candidate_digest });
  const loaded = compiled.loaded.authority;
  const authority = buildActionRuleAuthorityDraft({ name: "reviewed_staging_rules", action_boundary_name: loaded.action_boundary.name,
    catalog: loaded.catalog, rules: loaded.rules, approval_classes: loaded.approval_classes, reviews: [{ outcome: draft.outcome, ...compiled.review }] });
  await writeActionRuleAuthorityDraft(root, authority);
  await saveBoundaryReviewProgress(root, createBoundaryReviewProgress({ draft: context.draft, candidate: context.candidate,
    confirmedDecisions: context.candidate.unresolved_decisions, actor: "fixture-reviewer", reason: "Establish unrelated active fixture authority before recovery.",
    revision: (context.progress?.revision ?? 0) + 1 }));
  await activateExplorationBoundary({ projectRoot: root, candidate: context.candidate, expectedDigest: context.bundle.candidate_digest,
    actor: "fixture-reviewer", confirmation: `ACTIVATE ${context.bundle.candidate_digest}`,
    confirmedDecisions: context.candidate.unresolved_decisions, currentInspection: inspection });
  await activateActionRuleAuthority({ projectRoot: root, name: authority.authority.name, expected_digest: authority.digest,
    confirmation: `ACTIVATE ${authority.digest}`, actor: "fixture-reviewer" });
  const source = newPolicySourceSession();
  source.snapshots = [policyTextSnapshot(Buffer.from("Every source writer must maintain each updated counter. Preserve both atomic changes.\nThe separate allocation limit is unanswered; keep that future action pending."), "Rules.txt")];
  source.active = 1;
  source.approvals = [{ digest: source.snapshots[0]!.digest, destination: authoringDestination({ provider: "openai", model: "gpt-test" }) }];
  await savePolicySources(root, source);
  const cards = buildReadWorkloadPlanCards(context.candidate), workload = readWorkloadFromPlanCards({ cards, selectedIds: cards.map(card => card.id) });
  const read = await storeReadWorkloadAnalysis({ projectRoot: root, generatedBoundary: context.candidate,
    source: workload.source, analysis: analyzeReadWorkloadSet({ workload, generatedBoundary: context.candidate }) });
  await recordReadWorkloadReview({ projectRoot: root, workload: read, candidateDigest: context.bundle.candidate_digest, reviewRevision: 1 });
  const binding = { boundary_name: context.candidate.pack.name, generation_lock_fingerprint: context.candidate.generation_lock_fingerprint,
    schema_fingerprint: context.lock.schema_fingerprint, role_posture_fingerprint: context.candidate.role_posture_fingerprint };
  await writeBoundaryAuthoringResumeState(root, buildBoundaryAuthoringResumeState({ binding, stage: "authority_review",
    jobIntent: "Review the saved two-record atomic update; preserve the unanswered separate allocation limit.", provider: "openai", model: "gpt-test",
    intendedClient: "later", policySourceSession: source.id, read: { analysis_id: read.analysis_id, analysis_digest: read.analysis_digest },
    action: { intent: "Preserve both atomic changes.", strategy: "rule_derived", intents: ["Preserve both atomic changes."], completed_outcomes: [draft.outcome] } }));
  return { root, inspection, context, binding, authority, source, outcome: draft.outcome };
}

describe("existing compiled counter host review before policy coverage", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(["confirm", "decline", "save_failed", "save_noop", "cancel_after_save", "concurrent_read", "concurrent_action"] as const)("retains exact authority and durable confirmation semantics (%s)", async mode => {
    const f = await fixture(), { root } = f, resumePath = path.join(root, ".synapsor/boundary-authoring/resume.json");
    let round = 1, reviewCount = 0, failSave = false, cancellation = new AbortController();
    const events: string[] = [], records: Array<{ round: number; reviews: unknown[]; saved: unknown[] }> = [];
    const messages: string[] = [];
    const actualRename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (failSave && String(to) === resumePath) {
        if (mode === "save_noop") return;
        throw new Error("COUNTER_HOST_SAVE_FAILED");
      }
      await actualRename(from, to);
      if (mode === "cancel_after_save" && round === 1 && reviewCount === 1 && String(to) === resumePath) cancellation.abort();
    });
    const saved = async () => {
      const result = await readBoundaryAuthoringResumeState(root, f.binding);
      if (result.status !== "ready") throw new Error(`Expected saved current job: ${result.status}`);
      return result.value;
    };
    const initialRead = await loadActivatedExplorationBoundaries(root), initialAction = await readActionRuleAuthorityActivation(root);
    const baselineRead = structuredClone(f.context.candidate), initialInspection = structuredClone(f.inspection);
    const generator = vi.fn(async () => { throw new Error("Existing counter confirmation must not invoke a model Action rewrite."); });
    const planner = vi.fn(async () => { throw new Error("The saved job must not be replanned."); });
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined, editFieldTiers: async () => undefined, promptText: async () => undefined,
      confirm: async () => true, confirmActivation: vi.fn(async () => false), confirmReviewedDisabled: async () => true,
      chooseOption: async (title, _choices, options) => {
        if (title === "START BOUNDARY DRAFTING") return "resume";
        if (title === "REVIEW CHANGED-RECORD PROTECTION") {
          events.push("review"); reviewCount++;
          expect(options).toMatchObject({ initialValue: "pending", requireExplicitSelection: true });
          if (round === 1 && reviewCount === 2 && ["save_failed", "save_noop"].includes(mode)) failSave = true;
          if (round === 1 && reviewCount === 1 && mode === "concurrent_action") {
            const changed = structuredClone(f.authority);
            changed.reviews[0]!.then = "A competing review changed this record.";
            await writeActionRuleAuthorityDraft(root, buildActionRuleAuthorityDraft({ name: changed.authority.name,
              action_boundary_name: changed.authority.action_boundary.name, catalog: changed.authority.catalog,
              rules: changed.authority.rules, approval_classes: changed.authority.approval_classes, reviews: changed.reviews }));
          }
          if (round === 1 && reviewCount === 1 && mode === "concurrent_read") {
            const { prepareBoundaryResourceReviewMutation, commitBoundaryResourceReviewMutation } = await import("./boundary-review-mutation.js");
            const preview = await prepareBoundaryResourceReviewMutation(root, { resource_id: "public.records", metadata: { label: "Changed current resource" },
              actor: "fixture-owner", reason: "Concurrent reviewed vocabulary edit." }, async () => f.inspection);
            await commitBoundaryResourceReviewMutation(root, preview);
          }
          return mode === "decline" && round === 1 ? "pending" : "confirm";
        }
        if (["FINISH ATTACHED RULES REVIEW", "ACTIVATE READ BOUNDARY", "FINISH BOUNDARY REVIEW", "REPLACE ACTIVE READ BOUNDARY"].includes(title)) return title === "FINISH ATTACHED RULES REVIEW" ? "pause" : "finish";
        throw new Error(`Unexpected host review: ${title}; ${JSON.stringify(options)}; ${messages.join("\n")}`);
      },
    };
    const run = () => boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], async () => f.inspection, session, undefined, {
      startWithAgentJob: true, modelAuthoringSession: { provider: "openai", model: "gpt-test", apiKey: "session-secret", dependencies: { requestJson: async request => {
        const input = (request.body as { input: Array<{ content?: string }> }).input;
        const prefix = "Current draft (JSON pointer root): ";
        const line = input.flatMap(message => (message.content ?? "").split("\n")).find(line => line.startsWith(prefix));
        if (!line) throw new Error("Only the coverage provider callback may run.");
        const draft = JSON.parse(line.slice(prefix.length)), effect = draft.runner_evidence.actions[f.outcome].effect;
        const reviews = [effect.source_counter_maintenance, effect.atomic_updates[0].source_counter_maintenance];
        records.push({ round, reviews, saved: (await saved()).reviewed_version_fields ?? [] }); events.push("coverage");
        expect(draft.runner_evidence.runtime_contract.authoring_provider).toMatchObject({ provider: "openai", model: "gpt-test" });
        for (const item of reviews.filter(Boolean)) expect(records.at(-1)!.saved).toContainEqual({ resource: item.resource,
          field: item.field, maintenance: item.maintenance, proof_digest: item.proof_digest });
        cancellation.abort(); throw new AskError("ASK_CANCELLED", "Stop after actual host coverage input was inspected.", 499);
      } } },
      modelBoundaryJobPlanner: planner, modelActionRuleGenerator: generator,
      modelReadWorkloadGenerator: async () => { throw new Error("Current saved Read must not be regenerated."); },
      modelAuthoringNarrator: async () => "Review the exact current source counters.", actionProjectInspector: async () => f.inspection,
      boundaryAuthoringChatFactory: () => ({ session: { ...session, presentationMode: "conversation" }, signal: cancellation.signal,
        actionPrompter: { choose: async () => undefined, text: async () => undefined, confirm: async () => undefined, message: async () => undefined },
        setModel: vi.fn(), setPermissionGuide: vi.fn(), runner: vi.fn(), model: vi.fn(), checkpoint: (title, lines) => messages.push(title, ...(lines ?? [])),
        streamRunner: async () => undefined, streamCheckpoint: async () => undefined, streamModel: async () => undefined,
        rememberDetails: (title, lines) => messages.push(title, ...lines), showDetails: vi.fn(), providerStream: vi.fn(),
        progress: async (_message, operation) => operation(), close: vi.fn(), readOperator: async () => undefined,
      } satisfies BoundaryAuthoringChat),
    });
    try {
      await expect(run()).resolves.toBe(0);
      expect(reviewCount, messages.join("\n")).toBe(["cancel_after_save", "concurrent_read", "concurrent_action"].includes(mode) ? 1 : 2);
      expect(generator).not.toHaveBeenCalled(); expect(planner).not.toHaveBeenCalled();
      expect(session.confirmActivation).not.toHaveBeenCalled();
      expect(await loadActivatedExplorationBoundaries(root)).toEqual(initialRead);
      expect(await readActionRuleAuthorityActivation(root)).toEqual(initialAction);
      expect(f.inspection).toEqual(initialInspection);
      expect((await loadPolicySources(root, f.source.id))!.snapshots).toEqual(f.source.snapshots);
      if (!mode.startsWith("concurrent")) {
        expect((await loadBoundaryReviewContext(root)).candidate).toEqual(baselineRead);
        expect(await readActionRuleAuthorityDraft(root, f.authority.authority.name)).toEqual(f.authority);
        const first = await saved();
        expect(first.job_intent).toContain("unanswered separate allocation limit");
        expect(first.reviewed_version_fields ?? []).toHaveLength(mode === "confirm" ? 2 : mode === "decline" ? 0 : 1);
        if (mode === "confirm") {
          expect(events.slice(0, 3)).toEqual(["review", "review", "coverage"]);
          expect(records[0]!.reviews.every(Boolean)).toBe(true);
        } else expect(records).toHaveLength(0);
        if (["decline", "save_failed", "save_noop"].includes(mode)) expect(messages.filter(message => message === "SOURCE COUNTER REVIEW PENDING")).toHaveLength(1);
        round++; failSave = false; cancellation = new AbortController();
        await expect(run()).resolves.toBe(0);
        expect(reviewCount).toBe(mode === "confirm" || mode === "cancel_after_save" ? 2 : mode === "decline" ? 4 : 3);
        expect((await saved()).reviewed_version_fields).toHaveLength(2);
        expect(records.at(-1)!.reviews.every(Boolean)).toBe(true);
        expect(await readActionRuleAuthorityDraft(root, f.authority.authority.name)).toEqual(f.authority);
        expect((await loadBoundaryReviewContext(root)).candidate).toEqual(baselineRead);
        expect(await loadActivatedExplorationBoundaries(root)).toEqual(initialRead);
        expect(await readActionRuleAuthorityActivation(root)).toEqual(initialAction);
        expect(generator).not.toHaveBeenCalled(); expect(planner).not.toHaveBeenCalled();
      } else {
        expect(records).toHaveLength(0);
        expect(messages.join("\n")).toContain(mode === "concurrent_read" ? "READ_BOUNDARY_REVISION_CHANGED" : "ACTION_BOUNDARY_REVISION_CHANGED");
      }
    } finally { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
