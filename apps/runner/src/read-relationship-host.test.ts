import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { loadRuntimeConfigFromFile } from "@synapsor-runner/mcp-server";
import { buildAutoBoundary, emptyReviewOverrides, explorationBoundaryCandidateDigest, loadActivatedExplorationBoundaries } from "./auto-boundary.js";
import { initializeGuidedProject } from "./guided-project.js";
import { initializeFreshGovernedAuthoring } from "./control-policy-fresh-authoring.js";
import { applyManagedBoundaryReviewDecision } from "./boundary-review-domain.js";
import * as mutations from "./boundary-review-mutation.js";
import { boundaryReviewCommand, loadBoundaryReviewContext } from "./boundary-commands.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import type { BoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import { readBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import * as resumePersistence from "./boundary-authoring-resume.js";
import { generateModelReadWorkload } from "./read-workload-model.js";
import type { AskProviderDependencies } from "./model-ask.js";

import { newPolicySourceSession, policyTextSnapshot, savePolicySources, authoringDestination } from "./authoring-policy-source.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(renamed = false, ambiguous = false, declaredRootMeaning = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-read-relationship-host-"));
  roots.push(root);
  const schema = renamed ? "catalog" : "editorial";
  const names = renamed ? ["releases", "assessments", "licenses"] : ["manuscripts", "final_reviews", "rights_clearances"];
  const tenant = renamed ? "organization_code" : "publisher_id";
  const column = (name: string, data_type = "text") => ({ name, data_type, nullable: false, generated: false,
    ordinal_position: 1, suggestions: { tenant: false, sensitive: false, conflict: false, immutable: false, large_or_binary: false } });
  const tables: SchemaInspection["tables"] = names.map(name => ({ schema, name: name!, type: "table", writable: false,
    columns: [column("id", "uuid"), column(tenant), column("business_ref")], primary_key: ["id"],
    unique_constraints: [{ name: `${name}_scope_key`, columns: ["id", tenant] }], indexes: [], foreign_keys: [],
    suggestions: { tenant_columns: [], conflict_columns: [], sensitive_columns: [], default_visible_columns: ["id", tenant, "business_ref"] },
    row_level_security: true,
    row_level_security_policies: [{ name: "scoped_reader", command: "SELECT", permissive: true, roles: ["reader"],
      using_expression: `${tenant} = current_setting('app.organization', true)` }],
    role_posture: { owner: "fixture_owner", current_role_is_owner: false, current_role_can_assume_owner: false,
      row_security_forced: true, row_security_effective_for_current_role: true,
      privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false } },
  }));
  const from = `${schema}.${tables[0]!.name}`;
  for (const [index, target] of tables.slice(1).entries()) {
    const field = `selected_${index + 1}_id`;
    tables[0]!.columns.push(column(field, "uuid"));
    tables[0]!.suggestions.default_visible_columns.push(field);
    tables[0]!.foreign_keys.push({ name: `selected_${index + 1}_fk`, columns: [field, tenant],
      referenced_schema: schema, referenced_table: target.name, referenced_columns: ["id", tenant], delete_rule: "RESTRICT" });
  }
  if (ambiguous) tables[0]!.foreign_keys.push({ ...tables[0]!.foreign_keys[0]!, name: "alternate_review_fk" });
  const inspection: SchemaInspection = { engine: "postgres", server_version: "PostgreSQL 17", current_user: "reader",
    inspected_at: "2026-09-11T00:00:00.000Z", schemas: [schema], warnings: [], tables,
    role_posture: { verified: true, superuser: false, bypass_rls: false, read_only: true, writable_relations: [], owned_relations: [], reasons: [] } };
  let overrides = emptyReviewOverrides();
  for (const table of tables) {
    const decision = { resource_id: `${schema}.${table.name}`, actor: "synthetic-reviewer",
      reason: "Review the synthetic exact scope and field privacy.", decided_at: inspection.inspected_at };
    overrides = applyManagedBoundaryReviewDecision(overrides, { ...decision, kind: "tenant_key", value: tenant });
    for (const field of table.columns.filter(c => c.name !== tenant && c.name !== "business_ref")) {
      overrides = applyManagedBoundaryReviewDecision(overrides, { ...decision, kind: "field_exposure", field: field.name,
        exposure: "withhold_from_model" });
    }
  }
  const build = buildAutoBoundary({ inspection, overrides, sourceEnv: "DATABASE_URL", inspectedSchema: schema,
    project: { root, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
  expect(build.exploration_boundary.pack.resources.find(r => r.id === from)!.relationships).toHaveLength(ambiguous ? 3 : 2);
  const guided = await initializeGuidedProject({ projectRoot: root, build, runnerVersion: "1.8.0" });
  const config = loadRuntimeConfigFromFile(guided.config_path);
  await initializeFreshGovernedAuthoring({ projectRoot: root, build, config, storePath: guided.store_path, actor: "synthetic-reviewer" });
  const removed = await mutations.prepareBoundaryResourceReviewMutation(root, { resource_id: from, relationship_ids: [],
    actor: "synthetic-reviewer", reason: "Leave inspected relationships pending for a later explicit review." }, async () => inspection);
  await mutations.commitBoundaryResourceReviewMutation(root, removed);
  const before = await loadBoundaryReviewContext(root);
  if (declaredRootMeaning) {
    // Sealed owner fact visible to the actual model. FK consent below is only structural.
    const source = newPolicySourceSession();
    source.snapshots = [policyTextSnapshot(Buffer.from(`${from} contains business references.`), "declared-reference-meaning.txt")];
    source.active = 1;
    source.approvals = [{ digest: source.snapshots[0]!.digest, destination: authoringDestination({ provider: "openai", model: "gpt-test" }) }];
    await savePolicySources(root, source);
  }
  expect(before.candidate.pack.resources.find(r => r.id === from)!.relationships).toEqual([]);
  return { root, from, tenant, inspection, before };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Choose = NonNullable<BoundaryReviewInteractiveSession["chooseOption"]>;
const job = "Read business references with the two selected related business references.";

function response(value: unknown) {
  return { status: 200, body: { output: [{ type: "function_call", call_id: "read_mapping",
    name: "runner__submit_read_workloads", arguments: JSON.stringify(value) }] } };
}

async function runHost(f: Fixture, options: {
  choose?: Choose;
  beforeRequest?: (call: number) => Promise<void>;
  afterMapped?: () => Promise<void>;
  stopAfterLinks?: number;
} = {}) {
  let calls = 0;
  const choices: string[] = [];
  const failures: string[] = [];
  const snapshots: Awaited<ReturnType<typeof loadBoundaryReviewContext>>[] = [];
  const requestJson = vi.fn<NonNullable<AskProviderDependencies["requestJson"]>>(async request => {
    calls++;
    await options.beforeRequest?.(calls);
    const current = await loadBoundaryReviewContext(f.root);
    snapshots.push(current);
    const links = current.candidate.pack.resources.find(r => r.id === f.from)!.relationships;
    const text = JSON.stringify(request.body);
    const catalogStart = text.lastIndexOf("Structural catalog:");
    expect(catalogStart).toBeGreaterThanOrEqual(0);
    for (const privateField of [f.tenant, "selected_1_id", "selected_2_id"]) {
      expect(text.slice(catalogStart)).not.toContain(privateField);
    }
    for (const link of links) expect(text).toContain(link.id);
    if (links.length < (options.stopAfterLinks ?? 2)) {
      return response({ clarification_request: { resource: f.from, category: "relationship_support",
        reason: "A requested selected reference has no reviewed link.", question: "Prepare the exact selected reference link." } });
    }
    return response({ allowed: [{ id: "references", description: "Read selected business references", plan: {
      kind: "rows", resource: f.from, select: ["business_ref"], related: links.map(link => ({ relationship: link.id, select: ["business_ref"] })),
    } }], forbidden: [] });
  });
  const session: BoundaryReviewInteractiveSession = {
    chooseResource: async (_resources, _overview, options) => {
      if (options?.notice) failures.push(options.notice.title, ...options.notice.lines,
        ...(options.notice.footer ? [options.notice.footer] : []));
      return undefined;
    },
    editFieldTiers: async () => undefined,
    promptText: async prompt => {
      if (prompt === "What job are you giving this agent?") return job;
      throw new Error(`Unexpected host text prompt: ${prompt}`);
    },
    chooseOption: async (title, items, config) => {
      if (title === "CLIENT FOR THIS JOB") return "later";
      if (title === "START BOUNDARY DRAFTING") return items.some(i => i.value === "resume") ? "resume" : "model";
      if (title === "RESUME BOUNDARY DRAFTING") return "resume";
      if (title === "MODEL FOR BOUNDARY DRAFTING") return "current";
      if (title === "REVIEW AND STAGE READ RELATIONSHIP") {
        expect(config?.initialValue).toBe("pending");
        expect(config?.requireExplicitSelection).toBe(true);
        const selected = options.choose ? await options.choose(title, items, config) : items.find(i => i.value !== "pending")!.value;
        if (selected !== undefined) choices.push(selected);
        return selected;
      }
      if (title === "ACTIVATE READ BOUNDARY") return "finish";
      if (title === "SETUP NEEDS ATTENTION" || title === "READ BOUNDARY MODEL DRAFT FAILED") {
        failures.push(...config?.context ?? []);
        return title === "SETUP NEEDS ATTENTION" ? "pause" : "back";
      }
      throw new Error(`Unexpected host choice: ${title}; ${JSON.stringify(config)}`);
    },
    confirm: async prompt => {
      if (prompt.includes("reviewed structural context")) return true;
      throw new Error(`Unexpected host confirmation: ${prompt}`);
    },
    confirmReviewedDisabled: async () => false,
    confirmActivation: async () => { throw new Error("Relationship preparation must not activate authority."); },
  };
  const chat: BoundaryAuthoringChat = {
    session: { ...session, presentationMode: "conversation" },
    actionPrompter: { choose: async () => undefined, text: async () => undefined, confirm: async () => undefined, message: async () => undefined },
    setModel: vi.fn(), setPermissionGuide: vi.fn(), runner: vi.fn(), model: vi.fn(), checkpoint: vi.fn(),
    streamRunner: async () => undefined, streamCheckpoint: async () => undefined, streamModel: async () => undefined,
    rememberDetails: vi.fn(), showDetails: vi.fn(), providerStream: vi.fn(),
    progress: async (_message, operation) => operation(), close: vi.fn(),
  };
  const mapper = vi.fn(async (input: Parameters<typeof generateModelReadWorkload>[0]) => {
    const result = await generateModelReadWorkload({ ...input, dependencies: { requestJson } });
    expect(result.analysis.status).toBe("ready");
    await options.afterMapped?.();
    return result;
  });
  const operation = boundaryReviewCommand(["--project-root", f.root, "--access", "--job-first"], async () => f.inspection,
    session, undefined, { startWithAgentJob: true, modelAuthoringSession: { provider: "openai", model: "gpt-test", apiKey: "synthetic-secret" },
      modelReadWorkloadGenerator: mapper, modelAuthoringNarrator: async () => "The Read draft remains disabled.",
      boundaryAuthoringChatFactory: () => chat });
  return { operation, requestJson, choices, snapshots, mapper, failures };
}

async function resumeState(f: Fixture) {
  const context = await loadBoundaryReviewContext(f.root);
  return readBoundaryAuthoringResumeState(f.root, { boundary_name: context.candidate.pack.name,
    generation_lock_fingerprint: context.bundle.authority.generation_lock_fingerprint,
    schema_fingerprint: context.bundle.authority.schema_fingerprint,
    role_posture_fingerprint: context.bundle.authority.role_posture_fingerprint });
}

describe("public host Read relationship preparation", () => {
  it("keeps business root association unresolved when only exact structural paths were reviewed", async () => {
    const f = await fixture(false, false, false);
    const run = await runHost(f);
    await expect(run.operation).resolves.toBe(0);
    expect(run.failures.join("\n")).toContain("READ_WORKLOAD_SCOPE_AMBIGUOUS");
    expect((await loadBoundaryReviewContext(f.root)).candidate.pack.resources.find(r => r.id === f.from)!.relationships).toHaveLength(2);
    expect(run.snapshots.map(s => s.candidate.pack.resources.find(r => r.id === f.from)!.relationships.length)).toEqual([0, 1, 2]);
    await expect(loadActivatedExplorationBoundaries(f.root)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("retains an unavailable structural request and checks it locally on restart without another model call", async () => {
    const f = await fixture();
    f.from = "editorial.final_reviews"; // Included, but has no outgoing FK; never invent an inverse.
    const first = await runHost(f);
    await expect(first.operation).resolves.toBe(0);
    expect(first.requestJson).toHaveBeenCalledOnce();
    expect(first.failures.join("\n")).toContain("Read root: editorial.final_reviews");
    expect(first.failures.join("\n")).toContain("no generated outgoing path");
    expect(first.failures.join("\n")).toContain("private verification facts");
    expect(await resumeState(f)).toMatchObject({status:"ready",value:{pending_read_relationship:{resource:f.from},job_intent:job,stage:"read_mapping"}});
    const retained = await resumeState(f);
    if (retained.status !== "ready") throw new Error("Missing acknowledged relationship checkpoint.");
    const restarted = await runHost(f);
    await expect(restarted.operation).resolves.toBe(0);
    expect(restarted.requestJson).not.toHaveBeenCalled();
    // The resumed consumer checks its genuine checkpoint locally. It must
    // not issue a replacement generation for the same missing prerequisite.
    expect(restarted.mapper).toHaveBeenCalledOnce();
    expect(restarted.mapper.mock.calls[0]![0].resumeCheckpoint).toEqual(retained.value.read_assistance);
    expect(restarted.failures).toEqual(first.failures);
    const after = await resumeState(f);
    expect(after.status).toBe("ready");
    if (after.status === "ready") {
      expect(after.value.owner_handoffs).toEqual(retained.value.owner_handoffs);
      expect(after.value.read_assistance).toEqual(retained.value.read_assistance);
      expect(after.value.generation_recovery).toEqual(retained.value.generation_recovery);
    }
    expect((await loadBoundaryReviewContext(f.root)).candidate).toEqual(f.before.candidate);
    await expect(loadActivatedExplorationBoundaries(f.root)).rejects.toMatchObject({code:"ENOENT"});
  }, 30_000);

  it("resumes a declined supported path through exact review before returning to the model", async () => {
    const f = await fixture();
    const first = await runHost(f,{choose:async()=>"pending"});
    await expect(first.operation).resolves.toBe(0);
    expect(await resumeState(f)).toMatchObject({status:"ready",value:{pending_read_relationship:{resource:f.from}}});
    const resumed=await runHost(f);
    await expect(resumed.operation).resolves.toBe(0);
    expect(resumed.failures).toEqual([]);
    expect(resumed.snapshots.map(s=>s.candidate.pack.resources.find(r=>r.id===f.from)!.relationships.length)).toEqual([1,2]);
    const state=await resumeState(f);
    expect(state.status).toBe("ready");
    if(state.status==='ready') expect(state.value.pending_read_relationship).toBeUndefined();
  },30_000);

  it.each([false, true])("persists each accepted exact link before rebuilding the model catalog (renamed=%s)", async renamed => {
    const f = await fixture(renamed);
    const run = await runHost(f);
    await expect(run.operation).resolves.toBe(0);
    expect(run.failures).toEqual([]);
    expect(run.requestJson).toHaveBeenCalledTimes(3);
    expect(run.choices).toHaveLength(2);
    expect(run.snapshots.map(s => s.candidate.pack.resources.find(r => r.id === f.from)!.relationships.length)).toEqual([0, 1, 2]);
    const after = await loadBoundaryReviewContext(f.root);
    expect(after.candidate.pack.resources.find(r => r.id === f.from)!.relationships).toHaveLength(2);
    for (const resource of after.candidate.pack.resources) {
      const before = f.before.candidate.pack.resources.find(r => r.id === resource.id)!;
      expect(resource.kept_out_fields).toEqual(before.kept_out_fields);
      expect(resource.model_withheld_fields).toEqual(before.model_withheld_fields);
      expect(resource.tenant_key).toBe(before.tenant_key);
    }
    await expect(loadActivatedExplorationBoundaries(f.root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await resumeState(f)).toMatchObject({ status: "ready", value: { job_intent: job } });
  }, 30_000);

  it.each(["pending", undefined])("keeps declined/cancelled paths pending without a second provider turn (%s)", async choice => {
    const f = await fixture();
    const save = vi.spyOn(mutations, "commitExactBoundaryCandidateMutation");
    const run = await runHost(f, { choose: async () => choice });
    await expect(run.operation).resolves.toBe(0);
    expect(run.failures.join("\n")).toContain("READ_RELATIONSHIP_REVIEW_PENDING");
    expect(run.requestJson).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect((await loadBoundaryReviewContext(f.root)).candidate).toEqual(f.before.candidate);
    expect(await resumeState(f)).toMatchObject({ status: "ready", value: { job_intent: job, stage: "read_mapping" } });
    await expect(loadActivatedExplorationBoundaries(f.root)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("does not infer a path when multiple exact constraints reach the same target", async () => {
    const f = await fixture(false, true);
    const run = await runHost(f, { stopAfterLinks: 1, choose: async (_title, items) => {
      expect(items.filter(i => i.detail?.includes("editorial.final_reviews"))).toHaveLength(2);
      return items.find(i => i.detail?.includes("alternate_review_fk"))!.value;
    } });
    await expect(run.operation).resolves.toBe(0);
    expect(run.failures).toEqual([]);
    const current = await loadBoundaryReviewContext(f.root);
    expect(current.candidate.pack.resources.find(r => r.id === f.from)!.relationships.map(r => r.id)).toEqual(["alternate_review_fk"]);
    expect(run.choices).toHaveLength(1);
    await expect(loadActivatedExplorationBoundaries(f.root)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it.each(["before_review", "during_review"])("rejects changed inspected FK proof (%s)", async stage => {
    const f = await fixture();
    const change = () => { f.inspection.tables[0]!.foreign_keys[0]!.name = "changed_constraint"; };
    const save = vi.spyOn(mutations, "commitExactBoundaryCandidateMutation");
    const run = await runHost(f, {
      beforeRequest: async call => { if (stage === "before_review" && call === 1) change(); },
      choose: async () => { change(); return "0"; },
    });
    await expect(run.operation).resolves.toBe(0);
    expect(run.failures.join("\n")).toContain("READ_WORKLOAD_STALE");
    expect(run.choices).toHaveLength(stage === "before_review" ? 0 : 1);
    expect(run.requestJson).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect((await loadBoundaryReviewContext(f.root)).candidate).toEqual(f.before.candidate);
    await expect(loadActivatedExplorationBoundaries(f.root)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("preserves a concurrent disabled Read edit instead of saving the old selection", async () => {
    const f = await fixture();
    let raced: Awaited<ReturnType<typeof loadBoundaryReviewContext>> | undefined;
    const save = vi.spyOn(mutations, "commitExactBoundaryCandidateMutation");
    const run = await runHost(f, { choose: async () => {
      const revision = await mutations.prepareBoundaryResourceReviewMutation(f.root, { resource_id: f.from,
        minimum_cohort_size: 4, actor: "other-reviewer", reason: "Raise the exact aggregate privacy threshold." }, async () => f.inspection);
      await mutations.commitBoundaryResourceReviewMutation(f.root, revision);
      raced = await loadBoundaryReviewContext(f.root);
      return "0";
    } });
    await expect(run.operation).resolves.toBe(0);
    expect(run.failures.join("\n")).toContain("READ_RELATIONSHIP_CANDIDATE_STALE");
    expect(run.requestJson).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect((await loadBoundaryReviewContext(f.root)).candidate).toEqual(raced!.candidate);
    expect(raced!.candidate.pack.resources.find(r => r.id === f.from)!.relationships).toEqual([]);
  }, 30_000);

  it.each(["failed", "noop", "false_ack"])("does not continue from an unverified exact relationship save (%s)", async mode => {
    const f = await fixture();
    const save = vi.spyOn(mutations, "commitExactBoundaryCandidateMutation").mockImplementation(async (_root, preview) => {
      if (mode === "failed") throw new Error("TEST_RELATIONSHIP_SAVE_FAILED");
      const current = await loadBoundaryReviewContext(f.root);
      return { candidate_digest: mode === "noop" ? current.bundle.candidate_digest : preview.candidate_digest,
        review_revision: current.bundle.mutation_bindings.review_revision, authoring_binding: current.bundle.mutation_bindings.authoring,
        semantic_diff: [], source_database_changed: false, authority_activated: false };
    });
    const run = await runHost(f);
    await expect(run.operation).resolves.toBe(0);
    expect(run.failures.join("\n")).toContain(mode === "failed" ? "TEST_RELATIONSHIP_SAVE_FAILED"
      : mode === "noop" ? "READ_RELATIONSHIP_SAVE_UNCONFIRMED" : "READ_BOUNDARY_REVISION_CHANGED_AFTER_SAVE");
    expect(run.requestJson).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect((await loadBoundaryReviewContext(f.root)).candidate).toEqual(f.before.candidate);
    expect(await resumeState(f)).toMatchObject({ status: "ready", value: { stage: "read_mapping", job_intent: job } });
    await expect(loadActivatedExplorationBoundaries(f.root)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("does not save a relationship after another session changes the saved job during consent", async () => {
    const f = await fixture();
    const save = vi.spyOn(mutations, "commitExactBoundaryCandidateMutation");
    let raced: Awaited<ReturnType<typeof resumeState>> | undefined;
    const run = await runHost(f, { choose: async () => {
      const state = await resumeState(f);
      if (state.status !== "ready") throw new Error("Expected current synthetic job checkpoint.");
      const next = resumePersistence.buildBoundaryAuthoringResumeState({ binding: state.value.binding, stage: state.value.stage,
        jobIntent: state.value.job_intent, provider: state.value.model.provider, model: state.value.model.name,
        previous: state.value, pendingJobRevision: "Read only the root reference after the concurrent review." });
      await resumePersistence.writeBoundaryAuthoringResumeState(f.root, next, { expectedRevisionDigest: state.value.revision_digest });
      raced = await resumeState(f);
      return "0";
    } });
    await expect(run.operation).resolves.toBe(0);
    expect(run.failures.join("\n")).toContain("BOUNDARY_AUTHORING_RESUME_CHANGED");
    expect(save).not.toHaveBeenCalled();
    expect(run.requestJson).toHaveBeenCalledOnce();
    expect(await resumeState(f)).toEqual(raced);
    expect((await loadBoundaryReviewContext(f.root)).candidate).toEqual(f.before.candidate);
  }, 30_000);

  it.each(["failed", "noop"])("stops after a saved disabled path if its following job checkpoint is not durable (%s)", async mode => {
    const f = await fixture();
    const realWrite = resumePersistence.writeBoundaryAuthoringResumeState;
    vi.spyOn(resumePersistence, "writeBoundaryAuthoringResumeState").mockImplementation(async (...args) => {
      const current = await loadBoundaryReviewContext(f.root);
      if (current.candidate.pack.resources.find(r => r.id === f.from)!.relationships.length > 0) {
        if (mode === "failed") throw new Error("TEST_RESUME_SAVE_FAILED");
        return ".synapsor/boundary-authoring-resume.json";
      }
      return realWrite(...args);
    });
    const run = await runHost(f);
    await expect(run.operation).resolves.toBe(0);
    expect(run.failures.join("\n")).toMatch(/CHECKPOINT_NOT_SAVED|BOUNDARY_AUTHORING_RESUME_CHANGED/);
    expect(run.requestJson).toHaveBeenCalledOnce();
    const current = await loadBoundaryReviewContext(f.root);
    expect(current.candidate.pack.resources.find(r => r.id === f.from)!.relationships).toHaveLength(1);
    expect(await resumeState(f)).toMatchObject({ status: "ready", value: { stage: "read_mapping", job_intent: job } });
    await expect(loadActivatedExplorationBoundaries(f.root)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("retains the exact saved path and refuses restart after an unobserved generation failure", async () => {
    const f = await fixture();
    const first = await runHost(f, { beforeRequest: async call => {
      if (call === 2) throw new Error("TEST_PAUSE_AFTER_ONE_SAVED_RELATIONSHIP");
    } });
    await expect(first.operation).resolves.toBe(0);
    expect(first.choices).toHaveLength(1);
    expect(first.failures.join("\n")).toContain("without sufficient transport-phase evidence");
    expect(first.failures.join("\n")).not.toContain("TEST_PAUSE_AFTER_ONE_SAVED_RELATIONSHIP");
    expect(first.requestJson).toHaveBeenCalledTimes(2);
    const paused = await loadBoundaryReviewContext(f.root);
    const accepted = paused.candidate.pack.resources.find(r => r.id === f.from)!.relationships;
    expect(accepted).toHaveLength(1);
    expect(await resumeState(f)).toMatchObject({ status: "ready", value: { stage: "read_mapping", job_intent: job } });
    const saved = await resumeState(f);
    expect(saved).toMatchObject({ status: "ready", value: { generation_recovery: { operations: expect.arrayContaining([
      expect.objectContaining({ state: "partial" }),
    ]) } } });
    const restarted = await runHost(f);
    await expect(restarted.operation).resolves.toBe(0);
    expect(restarted.requestJson).not.toHaveBeenCalled();
    expect(restarted.choices).toEqual([]);
    expect(restarted.failures.join("\n")).toContain("unfinished generation");
    const reopened = await resumeState(f);
    expect(reopened.status).toBe("ready");
    if (saved.status !== "ready" || reopened.status !== "ready") throw new Error("Expected retained current job.");
    expect(Date.parse(reopened.value.updated_at)).toBeGreaterThanOrEqual(Date.parse(saved.value.updated_at));
    expect(Date.parse(reopened.value.updated_at)).toBeLessThanOrEqual(Date.now());
    const { revision_digest: reopenedDigest, ...reopenedCore } = reopened.value;
    expect(reopenedDigest).toBe(canonicalJsonDigest(reopenedCore));
    expect(reopened).toEqual({ ...saved, value: { ...saved.value,
      updated_at: reopened.value.updated_at, revision_digest: reopened.value.revision_digest } });
    expect((await loadBoundaryReviewContext(f.root)).candidate).toEqual(paused.candidate);
    await expect(loadActivatedExplorationBoundaries(f.root)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("repeated fenced Read restart preserves its saved dispatch and native allowance", async () => {
    const f = await fixture();
    const first = await runHost(f, { beforeRequest: async call => {
      if (call === 2) throw new Error("TEST_PAUSE_AFTER_ONE_SAVED_RELATIONSHIP");
    } });
    await expect(first.operation).resolves.toBe(0);
    expect(first.requestJson).toHaveBeenCalledTimes(2);
    const saved = await resumeState(f), candidate = (await loadBoundaryReviewContext(f.root)).candidate;
    expect(saved.status).toBe("ready");
    if (saved.status !== "ready") throw new Error("Expected the exact retained dispatch.");
    for (let reopened = 0; reopened < 3; reopened++) {
      const next = await runHost(f);
      await expect(next.operation).resolves.toBe(0);
      expect(next.requestJson).not.toHaveBeenCalled(); expect(next.choices).toEqual([]);
      expect(next.failures.join("\n")).toContain("unfinished generation");
      const current = await resumeState(f);
      expect(current.status).toBe("ready");
      if (current.status !== "ready") throw new Error("The retained job was lost.");
      expect(current.value.read_assistance).toEqual(saved.value.read_assistance);
      expect(current.value.generation_recovery).toEqual(saved.value.generation_recovery);
      expect(current).toEqual({ ...saved, value: { ...saved.value,
        updated_at: current.value.updated_at, revision_digest: current.value.revision_digest } });
      const { revision_digest, ...core } = current.value;
      expect(revision_digest).toBe(canonicalJsonDigest(core));
      expect((await loadBoundaryReviewContext(f.root)).candidate).toEqual(candidate);
    }
    await expect(loadActivatedExplorationBoundaries(f.root)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("restarts an ordinarily paused exact-path review and reviews only the remaining one", async () => {
    const f = await fixture();
    let selections = 0;
    const first = await runHost(f, { choose: async (_title, choices) => ++selections === 1
      ? choices.find(choice => choice.value !== "pending")!.value : "pending" });
    await expect(first.operation).resolves.toBe(0);
    expect(first.requestJson).toHaveBeenCalledTimes(2);
    expect(first.failures.join("\n")).toContain("READ_RELATIONSHIP_REVIEW_PENDING");
    const paused = await loadBoundaryReviewContext(f.root);
    const accepted = paused.candidate.pack.resources.find(r => r.id === f.from)!.relationships;
    expect(accepted).toHaveLength(1);
    expect(await resumeState(f)).toMatchObject({ status: "ready", value: { pending_read_relationship: { resource: f.from } } });
    const restarted = await runHost(f, { choose: async (_title, choices) => {
      expect(choices.filter(choice => choice.value !== "pending")).toHaveLength(1);
      expect(choices.every(choice => !choice.detail?.includes(accepted[0]!.id))).toBe(true);
      return choices.find(choice => choice.value !== "pending")!.value;
    } });
    await expect(restarted.operation).resolves.toBe(0);
    expect(restarted.failures).toEqual([]);
    expect(restarted.requestJson).toHaveBeenCalledOnce();
    expect(restarted.choices).toHaveLength(1);
    expect(restarted.snapshots.map(s => s.candidate.pack.resources.find(r => r.id === f.from)!.relationships.length)).toEqual([2]);
    const current = await loadBoundaryReviewContext(f.root);
    expect(current.candidate.pack.resources.find(r => r.id === f.from)!.relationships).toEqual(expect.arrayContaining(accepted));
    for (const resource of current.candidate.pack.resources) {
      const before = f.before.candidate.pack.resources.find(r => r.id === resource.id)!;
      expect(resource.kept_out_fields).toEqual(before.kept_out_fields);
      expect(resource.model_withheld_fields).toEqual(before.model_withheld_fields);
      expect(resource.tenant_key).toBe(before.tenant_key);
    }
    await expect(loadActivatedExplorationBoundaries(f.root)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});
