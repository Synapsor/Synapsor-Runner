import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { ControlPolicyRepository } from "@synapsor-runner/proposal-store";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { AUTO_BOUNDARY_OVERRIDES_VERSION, buildAutoBoundary, explorationBoundaryCandidateDigest } from "./auto-boundary.js";
import { recommendedBoundaryReviewCandidate } from "./boundary-candidate.js";
import { buildActionRuleAuthoringCatalog } from "./action-rule-authoring.js";
import { compileActionRuleModelDraft } from "./action-rule-draft.js";
import { prepareActionVersionField } from "./action-rule-version-review.js";
import { buildActionRuleAuthorityDraft } from "./action-rule-authority.js";
import { createBoundaryReviewProgress } from "./boundary-review-domain.js";
import { readAuthoringCatalog, type StoredReadAuthoring } from "./control-policy-read-authoring.js";
import { readProjectReadAuthoring, saveProjectReadAuthoring, saveProjectReadProgress } from "./control-policy-read-authoring-project.js";
import { encodeOperatorAuthority, validateOperatorPolicySnapshot } from "./control-policy-authority-codec.js";
import { migrateProjectControlPolicies, openBoundProjectControlPolicies } from "./control-policy-store.js";
import { OperatorAuthorityRepository } from "./control-policy-operator-repository.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState,
  type BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const moduleUrl = (file: string) => new URL(`./${file}.ts`, import.meta.url).href;
const resumePath = (root: string) => path.join(root, ".synapsor/boundary-authoring/resume.json");

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function currentPolicies(root: string) {
  const binding = await openBoundProjectControlPolicies(root);
  if (!binding) throw new Error("Missing test control repository");
  try { return await new OperatorAuthorityRepository(binding).current(); }
  finally { await binding.close(); }
}

function edit(authoring: StoredReadAuthoring, maximum: number) {
  const next = structuredClone(authoring), entry = next.entries[0]!;
  const candidate = structuredClone(entry.progress.candidate);
  candidate.budgets.max_top_n = maximum;
  entry.progress = createBoundaryReviewProgress({ draft: entry.draft, candidate, previous: entry.progress,
    confirmedDecisions: entry.progress.confirmed_decisions, revision: entry.progress.revision + 1,
    actor: "storage_test_operator", reason: `Narrow only this disabled Read draft to ${maximum} results.` });
  return next;
}

function answered(previous: BoundaryAuthoringResumeState, answer: string) {
  return buildBoundaryAuthoringResumeState({ binding: previous.binding, stage: "authority_review",
    jobIntent: previous.job_intent, provider: "openai", model: "deterministic-storage-test",
    conversation: [...previous.conversation, { question: "What is the follow-up limit?", answer }],
    previous, action: previous.action, reviewedVersionFields: previous.reviewed_version_fields });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-authoring-storage-")); roots.push(root);
  const inspection: SchemaInspection = {
    engine: "postgres", server_version: "PostgreSQL 16", current_user: "reader", inspected_at: "2026-09-06T00:00:00.000Z",
    schemas: ["inventory"], warnings: [], role_posture: { verified: true, superuser: false, bypass_rls: false,
      read_only: true, writable_relations: [], owned_relations: [], reasons: [] },
    tables: [{ schema: "inventory", name: "items", type: "table", writable: true,
      columns: ["id", "tenant_id", "principal_id", "quantity", "version"].map((name, ordinal_position) => ({
        name, data_type: ["version", "quantity"].includes(name) ? "integer" : "uuid", ordinal_position,
        nullable: false, generated: false, suggestions: { tenant: name === "tenant_id", conflict: name === "version",
          sensitive: false, immutable: name.endsWith("id"), large_or_binary: false },
      })), primary_key: ["id"], unique_constraints: [{ name: "items_pkey", columns: ["id"] }],
      check_constraints: [], foreign_keys: [], row_level_security: false, indexes: [],
      role_posture: { owner: "owner", current_role_is_owner: false, current_role_can_assume_owner: false,
        privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false },
        row_security_forced: false, row_security_effective_for_current_role: false },
      suggestions: { tenant_columns: ["tenant_id"], conflict_columns: ["version"], sensitive_columns: [], default_visible_columns: ["quantity"] },
    }],
  };
  const decision = (value: string) => ({ value, actor: "storage_test_operator", reason: "Exact fixture scope role.",
    decided_at: "2026-09-06T00:00:00.000Z" });
  const build = buildAutoBoundary({ inspection, inspectedSchema: "inventory", sourceEnv: "DATABASE_URL", deploymentProfile: "staging",
    overrides: { schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION, resources: { "inventory.items": {
      tenant_key: decision("tenant_id"), principal_key: decision("principal_id"),
    } } }, project: { root, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
  const candidate = recommendedBoundaryReviewCandidate(build.exploration_boundary);
  // Seed an already-reviewed active baseline only in this owned unit-test repository.
  const active = encodeOperatorAuthority({ type: "read", boundary: { ...candidate, activation: {
    state: "active", digest: explorationBoundaryCandidateDigest(candidate), actor: "original_test_operator",
    activated_at: "2026-09-06T00:00:00.000Z", generation_lock_fingerprint: candidate.generation_lock_fingerprint,
    reviewed_decisions: [],
  } }, generation_lock: build.lock });
  const selection = encodeOperatorAuthority({ type: "read_selection", selected_name: candidate.pack.name });
  const pointer = ({ scope, kind, name, revision_id }: typeof active) => ({ scope, kind, name, revision_id });
  const progress = createBoundaryReviewProgress({ draft: candidate, candidate, confirmedDecisions: candidate.unresolved_decisions,
    actor: "storage_test_operator", revision: 1 });
  const authoring: StoredReadAuthoring = { type: "read_authoring", selected_boundary_id: progress.boundary_id,
    entries: [{ draft: candidate, draft_lock: build.lock, candidate_lock: build.lock, progress, catalog: readAuthoringCatalog(build) }] };
  const prepared = prepareActionVersionField({ context: { readBoundary: candidate,
    readBoundaryDigest: explorationBoundaryCandidateDigest(candidate),
    builtCatalog: buildActionRuleAuthoringCatalog({ boundary: candidate, inspection }) },
    inspection, generationLock: build.lock, resource: "inventory.items", field: "version" });
  const builtCatalog = prepared.builtCatalog;
  const quantityType = builtCatalog.catalog.resources[0]!.fields.find(field => field.name === "quantity")!.type;
  const compiled = compileActionRuleModelDraft({ builtCatalog, readBoundary: candidate,
    readBoundaryDigest: explorationBoundaryCandidateDigest(candidate), activatedAt: "2026-09-06T00:01:00.000Z",
    draft: { schema_version: "synapsor.action-rule-model-draft.v1", name: "inventory.replenish", outcome: "inventory.replenish",
      verification: { name: "inventory.verify", resources: [{ binding: "item", resource: "inventory.items",
        source: { kind: "subject_ref" }, fields: ["quantity", "version"] }] },
      effect: { name: "inventory.effect", operation: "update", target_resource: "inventory.items", target_binding: "item",
        allowed_fields: [{ name: "quantity", minimum: 0, maximum: 10 }],
        set: { quantity: { kind: "literal", value: 5, value_type: quantityType } }, writeback: "proposal_only" },
      require: { kind: "compare", operator: "lt", left: { kind: "field", binding: "item", field: "quantity" },
        right: { kind: "literal", value: 5, value_type: quantityType } }, derive: {}, ttl_seconds: 300,
      approval: { class_name: "inventory.review", mode: "human", required_role: "stock_reviewer", required_approvals: 1, shared_limits: [] },
      review: { when: "Stock is below five.", then: "Set stock to five.", refused: ["Stock is sufficient."],
        human_review: "One stock reviewer.", examples: [{ kind: "eligible", scenario: "One item remains", result: "Create proposal" }] },
    } });
  const action = buildActionRuleAuthorityDraft({ name: "inventory_rules", action_boundary_name: "inventory_changes",
    catalog: compiled.loaded.authority.catalog, approval_classes: compiled.loaded.authority.approval_classes,
    rules: compiled.loaded.authority.rules.map(({ activated_at: _activatedAt, ...rule }) => rule),
    reviews: [{ outcome: compiled.rule.outcome, ...compiled.review }], now: "2026-09-06T00:01:00.000Z" });
  const migrated = await migrateProjectControlPolicies({ projectRoot: root, storePath: path.join(root, "control.db"),
    config: {} as RuntimeConfig, actor: "storage_test_operator", readLegacySnapshot: async () => ({
      revisions: [active, selection], active: [pointer(active), pointer(selection)], drafts: [], provenance: [],
    }), validateSnapshot: async value => validateOperatorPolicySnapshot(value) });
  try {
    const repository = new OperatorAuthorityRepository(migrated.binding);
    await repository.commitReadAuthoring({ expected_epoch: (await repository.current()).epoch, expected_revision_id: null,
      authoring, actor: "storage_test_operator", operation: "seed_disabled_job", additionalDrafts: [{
        key: { scope: { level: "operator" }, kind: "action", name: action.authority.name }, policy: { type: "action", authority: action },
      }] });
  } finally { await migrated.binding.close(); }
  const state = buildBoundaryAuthoringResumeState({ binding: { boundary_name: candidate.pack.name,
    generation_lock_fingerprint: candidate.generation_lock_fingerprint, schema_fingerprint: build.lock.schema_fingerprint,
    role_posture_fingerprint: build.lock.role_posture_fingerprint }, stage: "action_drafting",
    jobIntent: "Replenish stock and prepare a follow-up only after its business limit is supplied.",
    provider: "openai", model: "deterministic-storage-test",
    conversation: [{ question: "What does quantity mean?", answer: "The current stock count." }],
    reviewedVersionFields: [prepared.review],
    action: { intent: "Replenish stock.", strategy: "rule_derived", completed_outcomes: ["inventory.replenish"],
      intents: ["Replenish stock.", "Prepare a follow-up; its limit is unanswered."] } });
  await writeBoundaryAuthoringResumeState(root, state);
  const before = (await readProjectReadAuthoring(root))!;
  return { root, before, state, policies: await currentPolicies(root) };
}

async function expectUnrelatedPreserved(f: Awaited<ReturnType<typeof fixture>>) {
  const current = await currentPolicies(f.root);
  expect(current.active.filter(entry => entry.policy.type !== "read_authoring"))
    .toEqual(f.policies.active.filter(entry => entry.policy.type !== "read_authoring"));
  expect(current.drafts.filter(entry => entry.policy.type === "action"))
    .toEqual(f.policies.drafts.filter(entry => entry.policy.type === "action"));
  expect(current.active.some(entry => entry.policy.type === "action" || entry.policy.type === "execution")).toBe(false);
}

function childProcess(code: string) {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: repoRoot, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.push(child);
  const messages: Array<{ event: string; [key: string]: unknown }> = [];
  let diagnostics = "";
  const exited = once(child, "exit");
  child.on("message", message => { messages.push(message as typeof messages[number]); });
  child.stderr!.on("data", text => { diagnostics = `${diagnostics}${text}`.slice(-4000); });
  return { child, exited, messages, async wait(event: string) {
    await vi.waitFor(() => {
      if (child.exitCode !== null && !messages.some(message => message.event === event)) throw new Error(diagnostics);
      expect(messages.some(message => message.event === event)).toBe(true);
    }, { timeout: 15_000, interval: 10 });
    return messages.find(message => message.event === event)!;
  } };
}

describe("actual governed draft and resume storage boundaries (no provider or source database)", () => {
  it.each(["before_write", "partial_write", "before_rename"] as const)(
    "retains the committed draft and only previously saved answers when resume persistence fails %s", async stage => {
      const f = await fixture(), next = edit(f.before.authoring, 7);
      const oldResume = await fs.readFile(resumePath(f.root), "utf8");
      const token = await saveProjectReadProgress({ projectRoot: f.root, expected: f.before.bindings, progress: next.entries[0]!.progress });
      const proposed = answered(f.state, "Two follow-ups per day.");
      const write = fs.writeFile.bind(fs), rename = fs.rename.bind(fs);
      vi.spyOn(fs, "writeFile").mockImplementation(async (target, data, options) => {
        if (String(target).startsWith(resumePath(f.root)) && stage !== "before_rename") {
          if (stage === "partial_write") await write(target, "{", options);
          throw Object.assign(new Error("Injected resume write failure"), { code: "ENOSPC" });
        }
        return write(target, data, options);
      });
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (to === resumePath(f.root) && stage === "before_rename") throw Object.assign(new Error("Injected resume rename failure"), { code: "EIO" });
        return rename(from, to);
      });
      await expect(writeBoundaryAuthoringResumeState(f.root, proposed)).rejects.toThrow("Injected resume");
      vi.restoreAllMocks();
      expect(await fs.readFile(resumePath(f.root), "utf8")).toBe(oldResume);
      expect(await readBoundaryAuthoringResumeState(f.root, f.state.binding)).toEqual({ status: "ready", value: f.state });
      const reopened = (await readProjectReadAuthoring(f.root))!;
      expect(reopened.authoring).toEqual(next);
      expect(reopened.bindings).toEqual(token);
      expect(reopened.bindings.epoch).toBe(f.before.bindings.epoch + 1);
      expect(JSON.stringify(await readBoundaryAuthoringResumeState(f.root, f.state.binding))).not.toContain("Two follow-ups per day.");
      await expect(saveProjectReadAuthoring({ projectRoot: f.root, expected: f.before.bindings, authoring: next,
        actor: "storage_test_operator", operation: "retry_old_review" })).rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
      await expectUnrelatedPreserved(f);
    });

  it("reopens exact persisted records after process termination between draft commit and resume write", async () => {
    const f = await fixture(), next = edit(f.before.authoring, 7), proposed = answered(f.state, "Three follow-ups per day.");
    const writer = childProcess(`
      import { once } from 'node:events';
      import { saveProjectReadAuthoring } from ${JSON.stringify(moduleUrl("control-policy-read-authoring-project"))};
      import { writeBoundaryAuthoringResumeState } from ${JSON.stringify(moduleUrl("boundary-authoring-resume"))};
      await saveProjectReadAuthoring(${JSON.stringify({ projectRoot: f.root, expected: f.before.bindings,
        authoring: next, actor: "storage_test_operator", operation: "commit_before_restart" })});
      const released = once(process, 'message');
      process.send({ event: 'draft_committed' });
      await released;
      await writeBoundaryAuthoringResumeState(${JSON.stringify(f.root)}, ${JSON.stringify(proposed)});
    `);
    await writer.wait("draft_committed");
    writer.child.kill("SIGKILL"); await writer.exited;
    const reader = childProcess(`
      import { readProjectReadAuthoring } from ${JSON.stringify(moduleUrl("control-policy-read-authoring-project"))};
      import { readBoundaryAuthoringResumeState } from ${JSON.stringify(moduleUrl("boundary-authoring-resume"))};
      const read = await readProjectReadAuthoring(${JSON.stringify(f.root)});
      const resume = await readBoundaryAuthoringResumeState(${JSON.stringify(f.root)}, ${JSON.stringify(f.state.binding)});
      process.send({ event: 'reopened', read, resume }); process.disconnect();
    `);
    const loaded = await reader.wait("reopened"); await reader.exited;
    expect(loaded.read).toMatchObject({ authoring: next, bindings: { epoch: f.before.bindings.epoch + 1 } });
    expect(loaded.resume).toEqual({ status: "ready", value: f.state });
    expect((await fs.stat(resumePath(f.root))).mode & 0o777).toBe(0o600);
    await expectUnrelatedPreserved(f);
  }, 30_000);

  it("allows only one same-base save across independent processes and never persists the losing answer", async () => {
    const f = await fixture();
    const contenders = [7, 8].map(maximum => ({ maximum, authoring: edit(f.before.authoring, maximum),
      resume: answered(f.state, `${maximum} follow-ups per day.`) }));
    const writers = contenders.map(contender => childProcess(`
      import { once } from 'node:events';
      import { saveProjectReadAuthoring } from ${JSON.stringify(moduleUrl("control-policy-read-authoring-project"))};
      import { writeBoundaryAuthoringResumeState } from ${JSON.stringify(moduleUrl("boundary-authoring-resume"))};
      const released = once(process, 'message'); process.send({ event: 'ready' }); await released;
      try {
        const bindings = await saveProjectReadAuthoring(${JSON.stringify({ projectRoot: f.root, expected: f.before.bindings,
          authoring: contender.authoring, actor: "storage_test_operator", operation: "competing_save" })});
        await writeBoundaryAuthoringResumeState(${JSON.stringify(f.root)}, ${JSON.stringify(contender.resume)});
        process.send({ event: 'done', saved: true, bindings });
      } catch (error) { process.send({ event: 'done', saved: false, code: error.code, message: error.message }); }
      process.disconnect();
    `));
    for (const writer of writers) await writer.wait("ready");
    for (const writer of writers) writer.child.send("save");
    const results = [];
    for (const writer of writers) { results.push(await writer.wait("done")); await writer.exited; }
    expect(results.filter(result => result.saved)).toHaveLength(1);
    expect(results.find(result => !result.saved)).toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED",
      message: "The saved Read review changed. Reopen the current draft before applying this decision." });
    const winner = contenders[results.findIndex(result => result.saved)]!;
    expect((await readProjectReadAuthoring(f.root))!.authoring).toEqual(winner.authoring);
    expect((await currentPolicies(f.root)).epoch).toBe(f.before.bindings.epoch + 1);
    expect(await readBoundaryAuthoringResumeState(f.root, f.state.binding)).toEqual({ status: "ready", value: winner.resume });
    await expectUnrelatedPreserved(f);
  }, 30_000);

  it.each(["before_commit", "after_commit"] as const)("retries an uncertain authoring save after %s without a duplicate revision or lost pending work", async stage => {
    const f = await fixture(), next = edit(f.before.authoring, 7);
    const commit = ControlPolicyRepository.prototype.commit;
    let injected = false;
    vi.spyOn(ControlPolicyRepository.prototype, "commit").mockImplementation(async function(this: ControlPolicyRepository, input) {
      if ((input.event.receipt as { operation?: string })?.operation !== "uncertain_save" || injected) return commit.call(this, input);
      injected = true;
      if (stage === "after_commit") await commit.call(this, input);
      throw Object.assign(new Error("Injected uncertain store response"), { code: "TEST_COMMIT_UNCERTAIN" });
    });
    const input = { projectRoot: f.root, expected: f.before.bindings, authoring: next,
      actor: "storage_test_operator", operation: "uncertain_save" };
    await expect(saveProjectReadAuthoring(input)).rejects.toMatchObject({ code: "TEST_COMMIT_UNCERTAIN" });
    vi.restoreAllMocks();
    const reopened = (await readProjectReadAuthoring(f.root))!;
    expect(reopened.authoring).toEqual(stage === "after_commit" ? next : f.before.authoring);
    if (stage === "after_commit") {
      await expect(saveProjectReadAuthoring(input)).rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
      // Only the newly read exact revision is usable; equality is not an old-review receipt.
      await expect(saveProjectReadAuthoring({ ...input, expected: reopened.bindings })).resolves.toEqual(reopened.bindings);
    } else await saveProjectReadAuthoring(input);
    expect((await currentPolicies(f.root)).epoch).toBe(f.before.bindings.epoch + 1);
    expect(await readBoundaryAuthoringResumeState(f.root, f.state.binding)).toEqual({ status: "ready", value: f.state });
    await expectUnrelatedPreserved(f);
  });
});
