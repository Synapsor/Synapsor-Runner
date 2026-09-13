import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";

const mocked = vi.hoisted(() => ({
  context: vi.fn(),
  prepare: vi.fn(),
  compile: vi.fn(),
  commit: vi.fn(),
  readAction: vi.fn(),
  activeAction: vi.fn(),
  reconstruct: vi.fn(),
  catalog: vi.fn(),
}));

vi.mock("./boundary-commands.js", () => ({ loadBoundaryReviewContext: mocked.context }));
vi.mock("./auto-boundary.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./auto-boundary.js")>(),
  schemaFingerprintForInspection: () => digest("4"),
  rolePostureFingerprint: () => digest("5"),
}));
vi.mock("./boundary-review-mutation.js", () => ({ prepareBoundaryReviewMutationBatch: mocked.prepare }));
vi.mock("./boundary-review-decision-file.js", () => ({
  parseBoundaryReviewDecisionFile: (value: unknown) => value,
  boundaryReviewRequestsFromDecisionFile: (value: { resources: unknown[] }) => value.resources,
  parseBoundaryReviewResources: (value: unknown[]) => value,
}));
vi.mock("./action-rule-authoring.js", () => ({
  buildActionRuleAuthoringCatalog: mocked.catalog,
}));
vi.mock("./action-rule-draft.js", () => ({
  ACTION_RULE_MODEL_DRAFT_VERSION: "synapsor.action-rule-model-draft.v1",
  actionRuleModelDraftFromAuthority: mocked.reconstruct,
  compactActionRuleAuthoringCatalog: (value: Record<string, unknown>) => value,
  compileActionRuleModelDraft: mocked.compile,
}));
vi.mock("./action-rule-authority.js", () => ({
  readActionRuleAuthorityDraft: mocked.readAction,
  readActionRuleAuthorityActivation: mocked.activeAction,
  buildActionRuleAuthorityDraft: (value: Record<string, unknown>) => ({ state: "disabled", digest: digest(String(value.reviews && (value.reviews as Array<{ outcome: string }>)[0]!.outcome)), authority: { name: value.name, action_boundary: { name: value.action_boundary_name }, catalog: value.catalog, rules: value.rules, approval_classes: value.approval_classes }, reviews: value.reviews, created_at: "2026-09-08T00:00:00.000Z" }),
  mergeActionRuleAuthorityDraft: ({ existing, incoming }: { existing?: Record<string, unknown>; incoming: Record<string, unknown> }) => existing
    ? { ...incoming, authority: { ...(incoming.authority as Record<string, unknown>), rules: [...((existing.authority as { rules: unknown[] }).rules), ...((incoming.authority as { rules: unknown[] }).rules)] } }
    : incoming,
}));
vi.mock("./boundary-review-domain.js", () => ({
  createBoundaryReviewProgress: (value: Record<string, unknown>) => ({ boundary_id: "bnd_12345678901234567890123456789012", candidate: value.candidate, revision: value.revision }),
}));
vi.mock("./control-policy-read-authoring-project.js", () => ({
  readProjectReadAuthoring: vi.fn(async () => ({ bindings: bindings(), selected: { progress: { boundary_id: "bnd_12345678901234567890123456789012" }, catalog: {} }, authoring: { type: "read_authoring", selected_boundary_id: "bnd_12345678901234567890123456789012", entries: [{ progress: { boundary_id: "bnd_12345678901234567890123456789012" } }] } })),
}));
vi.mock("./control-policy-read-authoring.js", () => ({ readAuthoringCatalog: () => ({}) }));
vi.mock("./control-policy-store.js", () => ({ openBoundProjectControlPolicies: vi.fn(async () => ({
  repository_id: "00000000-0000-4000-8000-000000000001", deployment_id: "00000000-0000-4000-8000-000000000002",
  project_id: "00000000-0000-4000-8000-000000000003", close: vi.fn(),
  repository: { scopeSnapshot: vi.fn(async () => ({ active: [], drafts: [] })) },
})) }));
vi.mock("./control-policy-operator-repository.js", () => ({
  OperatorAuthorityRepository: class {
    async current() {
      return { epoch: 1, active: [{ revision: { revision_id: bindings().authoring.revision_id }, policy: { type: "read_authoring" } }], drafts: [] };
    }
    async commitReadAuthoring(value: unknown) { mocked.commit(value); return { epoch: 9, changes: [] }; }
    async commit(value: unknown) { mocked.commit(value); return { epoch: 9, changes: [] }; }
  },
}));

import { structuredBoundaryAuthoringCommand } from "./boundary-structured-authoring.js";
import { prepareActionRuleReadRevision } from "./action-rule-read-revision.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("structured boundary authoring", () => {
  beforeEach(() => {
    mocked.context.mockReset(); mocked.prepare.mockReset(); mocked.compile.mockReset(); mocked.commit.mockReset();
    mocked.readAction.mockReset(); mocked.activeAction.mockReset(); mocked.reconstruct.mockReset();
    mocked.catalog.mockReset();
    mocked.catalog.mockImplementation(({ boundary, retainedCatalog }) => ({
      catalog: { schema_version: "catalog", resources: [], relationships: [], ...retainedCatalog,
        generation_lock_fingerprint: boundary.generation_lock_fingerprint },
      authoring: { schema_version: "authoring", digest: digest("d"), resources: [], relationships: [], diagnostics: [] },
    }));
    mocked.readAction.mockResolvedValue(undefined); mocked.activeAction.mockResolvedValue(undefined);
    mocked.reconstruct.mockImplementation(({ outcome }: { outcome: string }) => ({ schema_version: "synapsor.action-rule-model-draft.v1", name: outcome, outcome,
      approval: { class_name: "billing.standard", mode: "human", required_role: "reviewer", required_approvals: 1, shared_limits: [] } }));
    mocked.context.mockResolvedValue({
      bundle: { bundle_digest: digest("a"), candidate_digest: digest("b"), mutation_bindings: bindings() },
      candidate: { pack: { name: "billing_read", resources: [] }, generation_lock_fingerprint: digest("3") },
      lock: { engine: "postgres", source_env: "DATABASE_URL", inspected_schema: "public", schema_fingerprint: digest("4"), role_posture_fingerprint: digest("5") },
    });
    mocked.prepare.mockResolvedValue(preview());
    mocked.compile.mockImplementation(({ draft }: { draft: { outcome: string } }) => {
      if (draft.outcome.includes("invalid")) throw Object.assign(new Error("ACTION_RULE_DRAFT_INVALID: unsupported scope/effect"), { code: "ACTION_RULE_DRAFT_INVALID" });
      return compiled(draft.outcome);
    });
  });

  it("validates two and then three semantic actions before one disabled atomic commit", async () => {
    const root = await project(["billing.pause", "billing.resume"]);
    await expect(run(["--project-root", root, "--draft", "draft.json", "--dry-run"])).resolves.toBe(0);
    expect(mocked.compile).toHaveBeenCalledTimes(2);
    expect(mocked.commit).not.toHaveBeenCalled();

    await fs.writeFile(path.join(root, "draft.json"), JSON.stringify(input(["billing.pause", "billing.resume", "billing.cancel"])));
    await expect(run(["--project-root", root, "--draft", "draft.json"])).resolves.toBe(0);
    expect(mocked.compile).toHaveBeenCalledTimes(5);
    expect(mocked.commit).toHaveBeenCalledOnce();
    expect(mocked.commit.mock.calls[0]![0]).toMatchObject({
      actor: "external_draft",
      operation: "save_structured_disabled_read_and_action",
      additionalDrafts: [{ policy: { type: "action" } }],
    });
  });

  it.each(["billing.invalid_scope", "billing.invalid_effect"])("rejects %s without a partial disabled commit", async (outcome) => {
    const root = await project(["billing.pause", outcome]);
    await expect(run(["--project-root", root, "--draft", "draft.json"])).rejects.toThrow("ACTION_RULE_DRAFT_INVALID");
    expect(mocked.commit).not.toHaveBeenCalled();
  });

  it("does not publish the first action when a later compiler pass fails", async () => {
    const root = await project(["billing.pause", "billing.invalid_scope", "billing.resume"]);
    await expect(run(["--project-root", root, "--draft", "draft.json"])).rejects.toThrow("ACTION_RULE_DRAFT_INVALID");
    expect(mocked.compile).toHaveBeenCalledTimes(2);
    expect(mocked.commit).not.toHaveBeenCalled();
  });

  it("allows a Read-only disabled revision without requiring an Action", async () => {
    const root = await project([]);
    await expect(run(["--project-root", root, "--draft", "draft.json", "--dry-run"])).resolves.toBe(0);
    expect(mocked.compile).not.toHaveBeenCalled();
    expect(mocked.commit).not.toHaveBeenCalled();
  });

  it("publishes a Read-only revision without replacing any Action authority", async () => {
    const root = await project([]);
    await expect(run(["--project-root", root, "--draft", "draft.json"])).resolves.toBe(0);
    expect(mocked.commit).toHaveBeenCalledOnce();
    expect(mocked.commit.mock.calls[0]![0]).not.toHaveProperty("additionalDrafts");
  });

  it("recompiles a saved Action draft for a Read-only revision as a disabled companion", async () => {
    mocked.readAction.mockResolvedValue({
      state: "disabled", digest: digest("z"), created_at: "2026-09-08T00:00:00.000Z",
      authority: { name: "billing_read_rules", action_boundary: { name: "billing_read_actions" }, catalog: { generation_lock_fingerprint: digest("3") },
        rules: [{ read_boundary_name: "billing_read", read_boundary_digest: digest("b"), rule: { outcome: "billing.pause" } }], approval_classes: [] },
      reviews: [{ outcome: "billing.pause", when: "when", then: "then", refused: [], human_review: "human", examples: [] }],
    });
    const root = await project([]);
    await expect(run(["--project-root", root, "--draft", "draft.json"])).resolves.toBe(0);
    expect(mocked.reconstruct).toHaveBeenCalledWith(expect.objectContaining({ outcome: "billing.pause" }));
    expect(mocked.commit.mock.calls[0]![0]).toMatchObject({
      additionalDrafts: [{ key: { kind: "action", name: "billing_read_rules" }, policy: { type: "action" } }],
    });
  });

  it("allows an Action-only disabled revision without fabricating a Read request", async () => {
    const root = await project(["billing.pause"], []);
    await expect(run(["--project-root", root, "--draft", "draft.json", "--dry-run"])).resolves.toBe(0);
    expect(mocked.prepare).not.toHaveBeenCalled();
    expect(mocked.compile).toHaveBeenCalledOnce();
  });

  it.each(["omitted", "unchanged baseline"])("preserves the exact foreign Read dependency, rule source and review when %s", async (foreignInput) => {
    const { existing, foreignDraft } = multiReadFixture();
    const original = structuredClone(existing);
    const root = await project(["billing.pause"], []);
    if (foreignInput === "unchanged baseline") {
      const request = input(["billing.pause"], []);
      request.actions.push(structuredClone(foreignDraft));
      await fs.writeFile(path.join(root, "draft.json"), JSON.stringify(request));
    }
    await expect(run(["--project-root", root, "--draft", "draft.json"])).resolves.toBe(0);

    expect(mocked.commit).toHaveBeenCalledOnce();
    const saved = mocked.commit.mock.calls[0]![0].drafts[0].policy.authority;
    expect(saved.state).toBe("disabled");
    expect(saved.authority.name).toBe(original.authority.name);
    expect(saved.authority.action_boundary.name).toBe(original.authority.action_boundary.name);
    expect(saved.authority.rules.map((entry: { rule: { outcome: string } }) => entry.rule.outcome).sort())
      .toEqual(["billing.pause", "billing.unrelated"]);
    expect(saved.authority.rules.find((entry: { rule: { outcome: string } }) => entry.rule.outcome === "billing.unrelated"))
      .toEqual(original.authority.rules[1]);
    expect(saved.reviews.find((entry: { outcome: string }) => entry.outcome === "billing.unrelated"))
      .toEqual(original.reviews[1]);
    expect(saved.authority.approval_classes).toEqual(original.authority.approval_classes);
    expect(mocked.compile.mock.calls.map(([value]) => value.draft.outcome)).toEqual(["billing.pause"]);
    expect(existing).toEqual(original);
  });

  it("rejects an explicit foreign outcome edit with guided Read selection and no save", async () => {
    const { existing, foreignDraft } = multiReadFixture();
    const original = structuredClone(existing);
    const root = await project(["billing.unrelated"], []);
    const request = input([], []);
    request.actions = [{ ...structuredClone(foreignDraft), ttl_seconds: foreignDraft.ttl_seconds + 1 }];
    await fs.writeFile(path.join(root, "draft.json"), JSON.stringify(request));
    const result = await run(["--project-root", root, "--draft", "draft.json"])
      .then(() => undefined, (error: unknown) => error);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("STRUCTURED_DRAFT_READ_DEPENDENCY_REQUIRED");
    expect((result as Error).message).toMatch(/billing\.unrelated/);
    expect((result as Error).message).toMatch(/independent_read/);
    expect((result as Error).message).toMatch(/select|switch/iu);
    expect((result as Error).message).toMatch(/boundary/iu);
    expect((result as Error).message).toMatch(/export/iu);
    expect(mocked.compile).not.toHaveBeenCalled();
    expect(mocked.commit).not.toHaveBeenCalled();
    expect(existing).toEqual(original);
  });

  it("refuses a Read generation-lock change with a foreign dependency using the existing joint-review guard", async () => {
    const { existing, lock } = multiReadFixture();
    const original = structuredClone(existing);
    const nextLock = { ...lock, reviewed_overrides_digest: digest("9") };
    const prepared = preview();
    prepared.candidate.generation_lock_fingerprint = canonicalJsonDigest(nextLock);
    prepared.build.exploration_boundary = prepared.candidate;
    prepared.build.lock = nextLock;
    mocked.prepare.mockResolvedValue(prepared);
    const helperInput = { existing, previousLock: lock, nextLock,
      nextBoundary: prepared.candidate, inspection: {} };
    expect(() => prepareActionRuleReadRevision(helperInput as never)).toThrow("ACTION_RULE_READ_REVIEW_REQUIRED");
    const root = await project([]);

    await expect(run(["--project-root", root, "--draft", "draft.json"]))
      .rejects.toThrow("ACTION_RULE_READ_REVIEW_REQUIRED");
    expect(mocked.compile).not.toHaveBeenCalled();
    expect(mocked.commit).not.toHaveBeenCalled();
    expect(existing).toEqual(original);
  });

  it("refuses an invalid approval wire shape before temporary joint-class compilation", async () => {
    const root = await project(["billing.pause"]);
    const draft = input(["billing.pause"]);
    draft.actions[0]!.approval = { ...draft.actions[0]!.approval, mode: "not_a_mode" } as never;
    await fs.writeFile(path.join(root, "draft.json"), JSON.stringify(draft));
    await expect(run(["--project-root", root, "--draft", "draft.json"])).rejects.toThrow("ACTION_RULE_DRAFT_SHAPE_INVALID");
    expect(mocked.compile).not.toHaveBeenCalled();
    expect(mocked.commit).not.toHaveBeenCalled();
  });

  it("returns a bounded JSON failure envelope instead of leaking an input-path error", async () => {
    const root = await project(["billing.pause"]);
    await expect(run(["--project-root", root, "--draft", "missing.json", "--json"])).resolves.toBe(2);
    expect(mocked.commit).not.toHaveBeenCalled();
  });

});

async function project(outcomes: string[], resources = [{ resource_id: "billing.accounts", include: true }]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-structured-authoring-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "draft.json"), JSON.stringify(input(outcomes, resources)));
  return root;
}

function run(args: string[]) {
  return structuredBoundaryAuthoringCommand(args, async () => ({}) as never);
}

function input(outcomes: string[], resources = [{ resource_id: "billing.accounts", include: true }]) {
  return { schema_version: "synapsor.boundary-draft-input.v1", review_bundle_digest: digest("a"), bindings: bindings(),
    read: { resources },
    actions: outcomes.map(actionDraft), };
}

function actionDraft(outcome: string) {
  return {
    schema_version: "synapsor.action-rule-model-draft.v1", name: outcome, outcome,
    inputs: [{ name: "units", description: "Requested units.", type: { kind: "integer" }, minimum: 1, maximum: 10 }],
    verification: { name: `${outcome}_verification`, resources: [{ binding: "account", resource: "billing.accounts",
      source: { kind: "subject_ref" }, fields: ["available"] }] },
    effect: { name: `${outcome}_effect`, operation: "update", target_resource: "billing.accounts", target_binding: "account",
      allowed_fields: [{ name: "balance", minimum: 1, maximum: 10 }],
      set: { balance: { kind: "input", name: "units" } }, writeback: "supervised" },
    require: { kind: "compare", operator: "eq", left: { kind: "field", binding: "account", field: "available" },
      right: { kind: "literal", value: true, value_type: { kind: "boolean" } } },
    derive: {}, ttl_seconds: 300,
    approval: { class_name: "billing.standard", mode: "human", required_role: "reviewer", required_approvals: 1, shared_limits: [] },
    review: { when: "The account is eligible.", then: "Apply the requested units.",
      refused: ["The account is ineligible."], human_review: "A reviewer decides.",
      examples: [{ kind: "eligible", scenario: "Eligible account", result: "Review." },
        { kind: "ineligible", scenario: "Ineligible account", result: "Refuse." }] },
  };
}

function preview() {
  return { bindings: bindings(), candidate_digest: digest("b"), candidate: { pack: { name: "billing_read", resources: [] }, generation_lock_fingerprint: digest("3") },
    build: { exploration_boundary: { pack: { name: "billing_read", resources: [] }, generation_lock_fingerprint: digest("3") }, lock: { engine: "postgres", source_env: "DATABASE_URL", inspected_schema: "public", schema_fingerprint: digest("4"), role_posture_fingerprint: digest("5") }, overrides: {} },
    previous_progress: undefined };
}

function compiled(outcome: string) {
  return { rule: { outcome }, review: { when: "when", then: "then", refused: [], human_review: "human", examples: [] },
    approval_class: { name: "billing.standard", mode: "human", required_role: "reviewer", required_approvals: 1,
      shared_limits: [], rules: [{ outcome }] },
    loaded: { authority: { name: "billing_read_rules", action_boundary: { name: "billing_read_actions" }, catalog: { schema_version: "catalog", generation_lock_fingerprint: digest("c"), resources: [], relationships: [] },
      rules: [{ read_boundary_name: "billing_read", read_boundary_digest: digest("b"), rule: { outcome }, verification_boundary: {}, effect_envelope: {} }], approval_classes: [] } } };
}

function multiReadFixture() {
  const lock = { schema_version: "synapsor.generation-lock.v1", compiler_version: "test", spec_version: "test",
    engine: "postgres", source_env: "DATABASE_URL", inspected_schema: "public",
    schema_fingerprint: digest("4"), role_posture_fingerprint: digest("5"), evidence_fingerprint: digest("6"),
    generated_contract_digest: digest("7"), reviewed_overrides_digest: digest("8"), protected_authority: [] };
  const fingerprint = canonicalJsonDigest(lock);
  mocked.context.mockResolvedValue({
    bundle: { bundle_digest: digest("a"), candidate_digest: digest("b"), mutation_bindings: bindings() },
    candidate: { pack: { name: "billing_read", resources: [] }, generation_lock_fingerprint: fingerprint }, lock,
  });
  const current = compiled("billing.pause");
  const foreign = compiled("billing.unrelated");
  const foreignDraft = actionDraft("billing.unrelated");
  foreignDraft.ttl_seconds = 123;
  foreignDraft.review.when = "Keep the separately reviewed eligibility explanation.";
  const existing = {
    state: "disabled", digest: digest("e"), created_at: "2026-09-08T00:00:00.000Z",
    authority: { name: "billing_read_rules", action_boundary: { name: "billing_reviewed_actions" },
      catalog: { ...current.loaded.authority.catalog, generation_lock_fingerprint: fingerprint },
      rules: [current.loaded.authority.rules[0], {
        ...foreign.loaded.authority.rules[0], read_boundary_name: "independent_read", read_boundary_digest: digest("f"),
        rule: { outcome: foreignDraft.outcome, require: foreignDraft.require, derive: foreignDraft.derive,
          ttl_seconds: foreignDraft.ttl_seconds },
        verification_boundary: { name: foreignDraft.verification.name, generation_lock_fingerprint: fingerprint,
          resources: foreignDraft.verification.resources },
        effect_envelope: { ...foreignDraft.effect, version_advance: { kind: "integer_increment", field: "version" } },
      }],
      approval_classes: [{ ...current.approval_class, rules: [{ outcome: "billing.pause" }, { outcome: "billing.unrelated" }] }],
    },
    reviews: [{ outcome: "billing.pause", ...current.review },
      { outcome: "billing.unrelated", ...foreignDraft.review }],
  };
  mocked.reconstruct.mockImplementation(({ outcome }) => structuredClone(
    outcome === foreignDraft.outcome ? foreignDraft : actionDraft(outcome),
  ));
  mocked.readAction.mockResolvedValue(existing);
  return { existing, lock, foreignDraft };
}

function bindings() {
  return { draft_digest: digest("1"), candidate_digest: digest("2"), generation_lock_fingerprint: digest("3"), schema_fingerprint: digest("4"), role_posture_fingerprint: digest("5"), review_revision: 1,
    authoring: { repository_id: "00000000-0000-4000-8000-000000000001", deployment_id: "00000000-0000-4000-8000-000000000002", project_id: "00000000-0000-4000-8000-000000000003", epoch: 1, revision_id: `policy:${"6".repeat(64)}` } };
}

function digest(value: string): `sha256:${string}` { return `sha256:${value.repeat(64).slice(0, 64)}`; }
