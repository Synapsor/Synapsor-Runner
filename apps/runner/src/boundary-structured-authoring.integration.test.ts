import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InspectOptions, SchemaInspection } from "@synapsor-runner/schema-inspector";
import { onboard } from "./guided-start.js";
import { structuredBoundaryAuthoringCommand } from "./boundary-structured-authoring.js";
import { readProjectReadAuthoring } from "./control-policy-read-authoring-project.js";
import { activateActionRuleAuthority, readActionRuleAuthorityActivation, readActionRuleAuthorityDraft, writeActionRuleAuthorityDraft } from "./action-rule-authority.js";
import { activateExplorationBoundary, explorationBoundaryCandidateDigest, loadActivatedExplorationBoundaries } from "./auto-boundary.js";
import type { ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { applyModelReadBoundaryExposureRevision, loadBoundaryReviewContext, prepareModelReadBoundaryExposureRevision, reloadReadReviewForModelRevision, reviewSavedBoundaryPolicy } from "./boundary-commands.js";
import { commitBoundaryReviewMutationBatch } from "./boundary-review-mutation.js";
import * as reviewMutation from "./boundary-review-mutation.js";
import { policyCoverageDraft } from "./authoring-policy-evidence.js";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { authoringDestination, newPolicySourceSession, policyTextSnapshot, savePolicySources, loadPolicySources } from "./authoring-policy-source.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("public structured Boundary authoring integration", () => {
  it.each(["complete", "competing_save", "declined_ownership"] as const)("reviews a saved Action through publication without manufacturing a draft (%s)", async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-published-review-")); roots.push(root);
    vi.stubEnv("TEST_READ_URL", "postgresql://fixture.invalid/not-used");
    vi.stubEnv("OPENAI_API_KEY", "local-transport-fixture");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const inspect = vi.fn(async (_input: InspectOptions) => inspection());
    expect(await onboard(["db", "--project-root", root, "--from-env", "TEST_READ_URL", "--schema", "warehouse", "--json"],
      {interactive: false, schemaInspector: inspect})).toBe(0);
    const run = (args: string[]) => structuredBoundaryAuthoringCommand(["--project-root", root, ...args], inspect);
    expect(await run(["--export-draft", "draft.json"])).toBe(0);
    const request = JSON.parse(await fs.readFile(path.join(root, "draft.json"), "utf8"));
    request.read.resources = [{resource_id: "warehouse.items", include: true, principal_key: "principal_id", row_identity: "item_id", tenant_key: "tenant_id",
      selectable_fields: ["sku", "q_av", "version"], keep_out_fields: ["internal_note"], withhold_from_model_fields: ["version"], private_model_fields: ["version"]}];
    const rule = action("quantity", "q_av", 50, 20);
    rule.approval = {class_name: "warehouse.shared", mode: "human", required_role: "warehouse_manager", required_approvals: 1, shared_limits: []};
    request.actions = [rule];
    await fs.writeFile(path.join(root, "draft.json"), JSON.stringify(request));
    expect(await run(["--draft", "draft.json"])).toBe(0);
    const context = await loadBoundaryReviewContext(root);
    const authority = (await readActionRuleAuthorityDraft(root, `${context.candidate.pack.name}_rules`))!;
    const sources = newPolicySourceSession(), snapshot = policyTextSnapshot(Buffer.from("Set an available item's quantity to the requested units, with human approval."), "rules.txt");
    sources.snapshots = [snapshot]; sources.active = snapshot.version;
    sources.approvals = [{digest: snapshot.digest, destination: authoringDestination({provider: "openai", model: "fixture"})}];
    await savePolicySources(root, sources);
    const binding = {boundary_name: context.candidate.pack.name, generation_lock_fingerprint: context.candidate.generation_lock_fingerprint,
      schema_fingerprint: context.lock.schema_fingerprint, role_posture_fingerprint: context.lock.role_posture_fingerprint};
    const resume = buildBoundaryAuthoringResumeState({binding, stage: "authority_review", jobIntent: "Maintain quantity",
      provider: "openai", model: "fixture", policySourceSession: sources.id,
      action: {intent: "Maintain quantity", outcome: rule.outcome, strategy: "rule_derived"}});
    await writeBoundaryAuthoringResumeState(root, resume, {expectedRevisionDigest: null});
    let calls = 0;
    const notices: string[] = [];
    const review = async () => {
      const reopened = await readBoundaryAuthoringResumeState(root, binding); expect(reopened.status).toBe("ready");
      if(reopened.status !== "ready") throw new Error("fixture resume unavailable");
      const current = await loadPolicySources(root, sources.id), conversation = createModelAuthoringConversation(); conversation.policySources = current;
      return reviewSavedBoundaryPolicy({projectRoot: root, resume: reopened.value, sources: current, request: "Review attached rules",
        selectCurrentContext: true, schemaInspector: inspect,
        session: {confirm: async () => true, chooseResource: async () => undefined, editFieldTiers: async () => undefined,
          promptText: async () => undefined, chooseOption: async () => mode === "declined_ownership" ? "back" : "assign",
          rememberDetails: (_title, lines) => { notices.push(...lines); }},
        modelSession: {provider: "openai", model: "fixture", conversation, dependencies: {requestJson: async () => {
          calls++;
          if(mode === "competing_save") await writeActionRuleAuthorityDraft(root, {...authority, created_at: "2026-09-21T00:00:00.000Z"});
          return {status: 200, body: {output: [{type: "function_call", call_id: `review_${calls}`, name: "runner__review_policy_coverage",
            arguments: JSON.stringify({passages: [{start: 1, end: 1, disposition: "implemented", responsibility: "runner",
              interpretation: "The saved action checks availability, uses the supplied bounded units and requires human approval.",
              draft_paths: ["/actions/0/require", "/actions/0/effect", "/actions/0/approval"]}]})}]}};
        }}}});
    };
    const first = await review();
    if(mode !== "complete") {
      expect(first).toMatchObject({tone: "warning"});
      const state = await readBoundaryAuthoringResumeState(root, binding);
      expect(state.status === "ready" && state.value.pending_policy_review).toBeTruthy();
      expect(state.status === "ready" && state.value.completed_policy_reviews?.length).toBeFalsy();
      const source = await loadPolicySources(root, sources.id);
      expect(source.application_assignments ?? []).toHaveLength(0);
      if(mode === "competing_save") expect(first.lines.join("\n")).toContain("POLICY_REVIEW_SUBJECT_CHANGED");
      expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
      return;
    }
    expect(first, JSON.stringify(first)).toMatchObject({tone: "success"});
    const currentRead = await loadBoundaryReviewContext(root);
    await activateExplorationBoundary({projectRoot: root, candidate: context.candidate, expectedDigest: explorationBoundaryCandidateDigest(context.candidate),
      confirmation: `ACTIVATE ${explorationBoundaryCandidateDigest(context.candidate)}`, actor: "fixture reviewer",
      confirmedDecisions: context.candidate.unresolved_decisions, currentInspection: inspection(),
      reviewDraft: context.draft, generationLock: context.lock, expectedAuthoring: currentRead.bundle.mutation_bindings.authoring});
    const active = await activateActionRuleAuthority({projectRoot: root, name: authority.authority.name, expected_digest: authority.digest,
      confirmation: `ACTIVATE ${authority.digest}`, actor: "fixture reviewer"});
    const published = await review(); expect(published, JSON.stringify(published)).toMatchObject({tone: "success"});
    expect(notices.join("\n")).toContain("Action subject (active published)");
    const count = calls, again = await review(); expect(again, JSON.stringify(again)).toMatchObject({tone: "success"});
    expect(calls).toBe(count); expect(again.lines.join("\n")).toContain("validated_reuse");
    expect(await readActionRuleAuthorityDraft(root, authority.authority.name)).toBeUndefined();
    expect(await readActionRuleAuthorityActivation(root)).toEqual(active);
    const state = await readBoundaryAuthoringResumeState(root, binding);
    expect(state.status === "ready" && state.value.completed_policy_reviews?.at(-1)?.request.action_subject?.location).toBe("active");
    expect(inspect.mock.calls.every(([input]) => input.databaseUrlEnv === "TEST_READ_URL")).toBe(true);
  }, 30_000);
  it("prepares private coded fields and two joint-limited actions through the real disabled-authority path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-structured-public-")); roots.push(root);
    vi.stubEnv("TEST_READ_URL", "postgresql://fixture.invalid/not-used");
    vi.stubEnv("SYNAPSOR_DATABASE_WRITE_URL", "postgresql://writer.invalid/not-used");
    vi.stubEnv("OPENAI_API_KEY", undefined); vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("SYNAPSOR_TENANT_ID", undefined); vi.stubEnv("SYNAPSOR_PRINCIPAL", undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const inspect = vi.fn(async (_input: InspectOptions) => inspection());
    expect(await onboard(["db", "--project-root", root, "--from-env", "TEST_READ_URL", "--schema", "warehouse", "--json"],
      { interactive: false, schemaInspector: inspect })).toBe(0);
    const initialized = await readProjectReadAuthoring(root);
    expect(initialized?.selected).toBeDefined();
    const configBefore = await fs.readFile(path.join(root, "synapsor.runner.json"), "utf8");
    const run = (args: string[]) => structuredBoundaryAuthoringCommand(["--project-root", root, ...args], inspect);
    expect(await run(["--export-draft", "draft.json"])).toBe(0);
    const request = JSON.parse(await fs.readFile(path.join(root, "draft.json"), "utf8"));
    expect(request.read_authoring_catalog.resources.some((resource: { id: string }) => resource.id === "warehouse.items")).toBe(true);
    expect(request.action_rule_draft_json_schema.properties).toHaveProperty("verification");
    request.read.resources = [{ resource_id: "warehouse.items", include: true,
      principal_key: "principal_id", row_identity: "item_id", tenant_key: "tenant_id",
      selectable_fields: ["sku", "q_av", "reorder_point", "available", "item_id", "version"],
      withhold_from_model_fields: ["item_id", "version", "available"],
      private_model_fields: ["item_id", "version", "available"],
      keep_out_fields: ["internal_note"],
      field_metadata: [{ field: "q_av", label: "Available units", description: "Stock counted in individual units, not packs." }],
    }];
    request.actions = [action("quantity", "q_av", 50, 20), action("reorder", "reorder_point", 30, 10)];
    request.actions[1].approval.shared_limits.reverse();
    const guardComparison = structuredClone(request);
    guardComparison.actions[0].verification.resources[0].fields.push("version");
    guardComparison.actions[0].approval.auto_approve_when = { kind: "compare", operator: "eq",
      left: { kind: "input", name: "units" }, right: { kind: "field", binding: "item", field: "version" } };
    await fs.writeFile(path.join(root, "invalid-guard.json"), JSON.stringify(guardComparison));
    expect(await run(["--draft", "invalid-guard.json", "--dry-run", "--json"])).toBe(2);
    expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("Caller business inputs must not supply or compare");
    expect(await readProjectReadAuthoring(root)).toEqual(initialized);
    await fs.writeFile(path.join(root, "draft.json"), JSON.stringify(request));
    expect(await run(["--draft", "draft.json", "--dry-run"])).toBe(0);
    expect(await readProjectReadAuthoring(root)).toEqual(initialized);
    expect(await readActionRuleAuthorityDraft(root, `${initialized!.selected!.progress.candidate.pack.name}_rules`)).toBeUndefined();
    expect(await run(["--draft", "draft.json"])).toBe(0);
    const saved = await readProjectReadAuthoring(root);
    const resource = saved!.selected!.progress.candidate.pack.resources.find((item) => item.id === "warehouse.items")!;
    expect(resource.model_withheld_fields).toEqual(expect.arrayContaining(["item_id", "version", "available"]));
    expect(resource.kept_out_fields).toContain("internal_note");
    const authority = await readActionRuleAuthorityDraft(root, `${saved!.selected!.progress.candidate.pack.name}_rules`);
    expect(authority!.authority.rules.map((entry) => entry.rule.outcome).sort()).toEqual(["warehouse.quantity", "warehouse.reorder"]);
    expect(authority!.authority.approval_classes).toHaveLength(1);
    expect(authority!.authority.approval_classes[0]!.shared_limits).toEqual(
      action("quantity", "q_av", 50, 20).approval.shared_limits.sort((left, right) => left.id.localeCompare(right.id)),
    );
    await expect(loadActivatedExplorationBoundaries(root)).rejects.toThrow("No exploration boundary is active.");
    expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
    expect(await fs.readFile(path.join(root, "synapsor.runner.json"), "utf8")).toBe(configBefore);
    expect(await run(["--export-draft", "next.json"])).toBe(0);
    const exported = JSON.parse(await fs.readFile(path.join(root, "next.json"), "utf8"));
    expect(exported.actions.map((entry: ActionRuleModelDraftV1) => entry.outcome).sort()).toEqual(["warehouse.quantity", "warehouse.reorder"]);
    expect(exported.actions.every((entry: ActionRuleModelDraftV1) => entry.approval.shared_limits.length === 4)).toBe(true);
    expect(await run(["--draft", "next.json", "--dry-run", "--json"])).toBe(0);
    expect(await readProjectReadAuthoring(root)).toEqual(saved);
    expect(await readActionRuleAuthorityDraft(root, authority!.authority.name)).toEqual(authority);
    expect(exported.actions.every((entry: ActionRuleModelDraftV1) => !Object.hasOwn(entry.review, "outcome"))).toBe(true);
    const rulesBefore = authority!.authority.rules.map((entry) => ({
      rule: entry.rule, effect: entry.effect_envelope, verification: entry.verification_boundary.resources,
    }));
    exported.read.resources = [{ resource_id: "warehouse.items", include: true,
      field_metadata: [{ field: "q_av", label: "Units on hand", description: "Available individual units, not packs." }],
    }];
    exported.actions = [];
    await fs.writeFile(path.join(root, "next.json"), JSON.stringify(exported));
    expect(await run(["--draft", "next.json"])).toBe(0);
    const revised = await readActionRuleAuthorityDraft(root, authority!.authority.name);
    expect(revised!.authority.rules.map((entry) => ({
      rule: entry.rule, effect: entry.effect_envelope, verification: entry.verification_boundary.resources,
    }))).toEqual(rulesBefore);
    expect(revised!.authority.approval_classes).toEqual(authority!.authority.approval_classes);
    const revisedRead = await readProjectReadAuthoring(root);
    const revisedResource = revisedRead!.selected!.progress.candidate.pack.resources.find((item) => item.id === "warehouse.items")!;
    expect(revisedResource.model_withheld_fields).toEqual(resource.model_withheld_fields);
    expect(revisedResource.kept_out_fields).toEqual(resource.kept_out_fields);
    await expect(loadActivatedExplorationBoundaries(root)).rejects.toThrow("No exploration boundary is active.");
    expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
    expect(await run(["--draft", "next.json", "--json"])).toBe(2);
    expect(await readProjectReadAuthoring(root)).toEqual(revisedRead);
    expect(await readActionRuleAuthorityDraft(root, authority!.authority.name)).toEqual(revised);
    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("STRUCTURED_DRAFT_STALE");
    expect(output).toContain("Export a new structured draft");
    expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join("")).not.toContain("fixture.invalid");
    expect(inspect.mock.calls.every(([input]) => input.databaseUrlEnv === "TEST_READ_URL")).toBe(true);

    // A same-job Action save advances the shared epoch even when Read is
    // unchanged. It must not trap the following label/privacy repair.
    const beforeActionSave = await loadBoundaryReviewContext(root);
    const completeCoverage = policyCoverageDraft({ read: beforeActionSave.candidate, decisions: [], actions: [], authority: revised! });
    expect(completeCoverage.actions.map((action) => action.outcome).sort())
      .toEqual(revised!.authority.rules.map((entry) => entry.rule.outcome).sort());
    expect(completeCoverage.actions).toHaveLength(2);
    for (const entry of revised!.authority.rules) {
      const covered = completeCoverage.actions.find((action) => action.outcome === entry.rule.outcome)!;
      const approval = revised!.authority.approval_classes.find((item) => item.name === entry.rule.approval_class)!;
      expect(covered.require).toEqual(entry.rule.require);
      expect(covered.effect.set).toEqual(entry.rule.effect.set);
      expect(covered.approval.shared_limits).toEqual(approval.shared_limits);
      expect(completeCoverage.runner_evidence.actions[entry.rule.outcome]!.scoped_bindings)
        .toHaveProperty(entry.verification_boundary.resources[0]!.binding);
    }
    await writeActionRuleAuthorityDraft(root, revised!);
    const labelRevision = { changes: [], policy_changes: [{ resource: "warehouse.items",
      settings: { field_metadata: [{ field: "q_av", label: "Reviewed stock units" }] } }] };
    await expect(prepareModelReadBoundaryExposureRevision({ projectRoot: root, schemaInspector: inspect,
      context: beforeActionSave, revision: labelRevision })).rejects.toThrow("authoring mismatch");
    const refreshed = await reloadReadReviewForModelRevision(root, beforeActionSave, revised!);
    expect(refreshed.bundle.mutation_bindings.authoring!.epoch).toBeGreaterThan(beforeActionSave.bundle.mutation_bindings.authoring!.epoch);
    expect(refreshed.bundle.mutation_bindings.authoring!.revision_id).toBe(beforeActionSave.bundle.mutation_bindings.authoring!.revision_id);
    expect(refreshed.candidate).toEqual(beforeActionSave.candidate);
    const preview = await prepareModelReadBoundaryExposureRevision({ projectRoot: root, schemaInspector: inspect,
      context: refreshed, revision: labelRevision });
    expect(preview.candidate.pack.resources[0]!.field_metadata?.q_av?.label).toBe("Reviewed stock units");
    expect(preview.candidate.pack.resources[0]!.model_withheld_fields).toEqual(resource.model_withheld_fields);
    expect(await readActionRuleAuthorityDraft(root, revised!.authority.name)).toEqual(revised);

    // Refreshing is only before a new preview, never a bypass for a stale
    // commit or an independently changed Read/Action revision.
    await writeActionRuleAuthorityDraft(root, revised!);
    await expect(commitBoundaryReviewMutationBatch(root, preview)).rejects.toThrow("authoring mismatch");
    const refreshedAgain = await reloadReadReviewForModelRevision(root, refreshed, revised!);
    const currentPreview = await prepareModelReadBoundaryExposureRevision({ projectRoot: root, schemaInspector: inspect,
      context: refreshedAgain, revision: labelRevision });
    await commitBoundaryReviewMutationBatch(root, currentPreview);
    await expect(reloadReadReviewForModelRevision(root, refreshedAgain, revised!)).rejects.toThrow("READ_BOUNDARY_REVISION_CHANGED");
    const currentRead = await loadBoundaryReviewContext(root);
    await expect(reloadReadReviewForModelRevision(root, currentRead, authority!)).rejects.toThrow("ACTION_BOUNDARY_REVISION_CHANGED");

    // A second editor commits after this operation's save but before its reload.
    // Never record a workload for B with A's revision or rebind Actions to B.
    const workloadsPath = path.join(root, ".synapsor/read-workloads");
    await expect(fs.access(workloadsPath)).rejects.toMatchObject({ code: "ENOENT" });
    const realCommit = reviewMutation.commitBoundaryReviewMutationBatch;
    vi.spyOn(reviewMutation, "commitBoundaryReviewMutationBatch").mockImplementationOnce(async (...args) => {
      const firstCommit = await realCommit(...args);
      const otherContext = await loadBoundaryReviewContext(root);
      const otherPreview = await prepareModelReadBoundaryExposureRevision({ projectRoot: root, schemaInspector: inspect,
        context: otherContext, revision: { changes: [], policy_changes: [{ resource: "warehouse.items",
          settings: { field_metadata: [{ field: "q_av", label: "Another editor's label" }] } }] } });
      await realCommit(root, otherPreview);
      return firstCommit;
    });
    const onCommitted = vi.fn();
    await expect(applyModelReadBoundaryExposureRevision({ projectRoot: root, schemaInspector: inspect,
      context: currentRead, revision: labelRevision, onCommitted })).rejects.toThrow("READ_BOUNDARY_REVISION_CHANGED_AFTER_SAVE");
    expect(onCommitted).toHaveBeenCalledOnce();
    expect((await loadBoundaryReviewContext(root)).candidate.pack.resources[0]!.field_metadata?.q_av?.label)
      .toBe("Another editor's label");
    await expect(fs.access(workloadsPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readActionRuleAuthorityDraft(root, revised!.authority.name)).toEqual(revised);
    const recovered = await applyModelReadBoundaryExposureRevision({ projectRoot: root, schemaInspector: inspect,
      context: await loadBoundaryReviewContext(root), revision: labelRevision });
    expect(recovered.context.bundle.candidate_digest).toBe(recovered.committed.candidate_digest);
    expect(recovered.workload.review?.candidate_digest).toBe(recovered.committed.candidate_digest);
    expect(recovered.context.bundle.mutation_bindings.review_revision).toBe(recovered.committed.review_revision);
    expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
    await expect(loadActivatedExplorationBoundaries(root)).rejects.toThrow("No exploration boundary is active.");
  });

  it("authors a private 16-credit approval condition without making credits a proposed patch or caller argument", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-student-public-")); roots.push(root);
    vi.stubEnv("TEST_READ_URL", "postgresql://fixture.invalid/not-used");
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const schema = inspection(), table = schema.tables[0]!;
    schema.schemas = ["university"]; table.schema = "university"; table.name = "registration_cases";
    const rename: Record<string, string> = { item_id: "registration_id", tenant_id: "institution_id", principal_id: "student_id",
      q_av: "registration_state", reorder_point: "credits" };
    table.columns = table.columns.map((column) => ({ ...column, name: rename[column.name] ?? column.name,
      ...(column.name === "q_av" ? { data_type: "text", enum_values: ["waitlisted", "enrolled"] } : {}) }));
    table.primary_key = ["registration_id"]; table.unique_constraints = [{ name: "registration_pkey", columns: ["registration_id"] }];
    table.suggestions.tenant_columns = ["institution_id"]; table.suggestions.default_visible_columns = ["registration_state"];
    const inspect = async () => schema;
    expect(await onboard(["db", "--project-root", root, "--from-env", "TEST_READ_URL", "--schema", "university", "--json"],
      { interactive: false, schemaInspector: inspect })).toBe(0);
    const run = (args: string[]) => structuredBoundaryAuthoringCommand(["--project-root", root, ...args], inspect);
    expect(await run(["--export-draft", "draft.json"])).toBe(0);
    const request = JSON.parse(await fs.readFile(path.join(root, "draft.json"), "utf8"));
    request.read.resources = [{ resource_id: "university.registration_cases", include: true,
      tenant_key: "institution_id", principal_key: "student_id", row_identity: "registration_id",
      selectable_fields: ["registration_state", "credits", "available", "registration_id", "version"],
      withhold_from_model_fields: ["credits", "available", "registration_id", "version"],
      private_model_fields: ["credits", "available", "registration_id", "version"] }];
    const rule = action("enroll", "registration_state", 50, 16);
    rule.name = rule.outcome = "university.enroll"; rule.inputs = [];
    rule.verification.resources = [{ binding: "item", resource: "university.registration_cases", source: { kind: "subject_ref" }, fields: ["available", "credits"] }];
    rule.effect.target_resource = "university.registration_cases";
    rule.effect.allowed_fields = [{ name: "registration_state" }];
    rule.effect.set = { registration_state: { kind: "literal", value: "enrolled", value_type: { kind: "string", max_length: 16, comparison: "exact" } } };
    rule.effect.writeback = "proposal_only";
    rule.approval.class_name = "university.enrollment"; rule.approval.required_role = "registrar_reviewer";
    rule.approval.auto_approve_when = { kind: "compare", operator: "lte", left: { kind: "field", binding: "item", field: "credits" },
      right: { kind: "literal", value: 16, value_type: { kind: "integer" } } };
    rule.approval.shared_limits = [{ id: "overall", kind: "count", scope: "boundary", maximum: 10, window_seconds: 86400 },
      { id: "per_student", kind: "count", scope: "tenant_principal", maximum: 2, window_seconds: 86400 }];
    request.actions = [rule];
    await fs.writeFile(path.join(root, "draft.json"), JSON.stringify(request));
    expect(await run(["--draft", "draft.json", "--json"]), output.mock.calls.map(([chunk]) => String(chunk)).join("")).toBe(0);
    const read = await readProjectReadAuthoring(root);
    const saved = await readActionRuleAuthorityDraft(root, `${read!.selected!.progress.candidate.pack.name}_rules`);
    expect(saved!.authority.approval_classes[0]!.rules[0]!.auto_approve_when).toEqual(rule.approval.auto_approve_when);
    const entry = saved!.authority.rules[0]!;
    expect(entry.rule.inputs).toEqual([]);
    expect(entry.effect_envelope.allowed_fields.map((field) => field.name)).toEqual(["registration_state"]);
    expect(entry.verification_boundary.resources[0]!.fields).toContainEqual(expect.objectContaining({ name: "credits", type: { kind: "integer" } }));
    expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
    await expect(loadActivatedExplorationBoundaries(root)).rejects.toThrow("No exploration boundary is active.");
  });

  it("exports incomplete saved intents as view-only skeletons without turning catalog candidates into actions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-structured-skeleton-")); roots.push(root);
    vi.stubEnv("TEST_READ_URL", "postgresql://fixture.invalid/not-used");
    const inspect = vi.fn(async (_input: InspectOptions) => inspection());
    expect(await onboard(["db", "--project-root", root, "--from-env", "TEST_READ_URL", "--schema", "warehouse", "--json"],
      { interactive: false, schemaInspector: inspect })).toBe(0);
    const context = await loadBoundaryReviewContext(root);
    await writeBoundaryAuthoringResumeState(root, buildBoundaryAuthoringResumeState({
      binding: {
        boundary_name: context.candidate.pack.name,
        generation_lock_fingerprint: context.candidate.generation_lock_fingerprint,
        schema_fingerprint: context.lock.schema_fingerprint,
        role_posture_fingerprint: context.lock.role_posture_fingerprint,
      },
      stage: "action_drafting",
      jobIntent: "Maintain warehouse item settings",
      provider: "openai",
      model: "test",
      action: { intent: "Change the reorder threshold", intents: ["Change the reorder threshold", "Change available quantity"], strategy: "rule_derived" },
      now: "2026-09-10T00:00:00.000Z",
    }));
    expect(await structuredBoundaryAuthoringCommand(["--project-root", root, "--export-draft", "skeleton.json"], inspect)).toBe(0);
    const exported = JSON.parse(await fs.readFile(path.join(root, "skeleton.json"), "utf8"));
    expect(exported.action_skeletons).toHaveLength(2);
    expect(exported.action_skeletons.map((entry: { intent: string }) => entry.intent))
      .toEqual(["Change the reorder threshold", "Change available quantity"]);
    expect(exported.action_skeletons.every((entry: { state: string; continuation: { state: string } }) =>
      entry.state === "incomplete" && entry.continuation.state === "unprepared")).toBe(true);
    expect(exported.action_skeletons[0].candidates.resources).toEqual(expect.any(Array));
    expect(exported.action_skeletons[0].candidates.subject_ref_resource_candidates).toEqual(expect.any(Array));
    expect(exported.actions).toEqual([]);
    expect(exported.notes.instructions).toContain("action_skeletons are view-only");
  }, 15_000);
});

function action(name: string, field: string, maximum: number, automaticMaximum: number): ActionRuleModelDraftV1 {
  return {
    schema_version: "synapsor.action-rule-model-draft.v1", name: `warehouse.${name}`, outcome: `warehouse.${name}`,
    inputs: [{ name: "units", description: "Requested individual units.", type: { kind: "integer" }, minimum: 1, maximum }],
    verification: { name: `warehouse.${name}_verification`, resources: [{ binding: "item", resource: "warehouse.items", source: { kind: "subject_ref" }, fields: ["available"] }] },
    effect: { name: `warehouse.${name}_effect`, operation: "update", target_resource: "warehouse.items", target_binding: "item",
      allowed_fields: [{ name: field, minimum: 1, maximum }], set: { [field]: { kind: "input", name: "units" } }, writeback: "supervised" },
    require: { kind: "compare", operator: "eq", left: { kind: "field", binding: "item", field: "available" },
      right: { kind: "literal", value: true, value_type: { kind: "boolean" } } },
    derive: {}, approval: { class_name: "warehouse.shared", mode: "policy", required_role: "warehouse_manager", required_approvals: 1,
      auto_approve_when: { kind: "compare", operator: "lte", left: { kind: "input", name: "units" },
        right: { kind: "literal", value: automaticMaximum, value_type: { kind: "integer" } } },
      shared_limits: [{ id: "joint_overall", kind: "count", scope: "boundary", maximum: 10, window_seconds: 86400 },
        { id: "joint_company", kind: "count", scope: "tenant", maximum: 3, window_seconds: 86400 },
        { id: "quantity_limit", kind: "count", scope: "capability", capability: "warehouse.quantity", maximum: 8, window_seconds: 86400 },
        { id: "reorder_limit", kind: "count", scope: "capability", capability: "warehouse.reorder", maximum: 7, window_seconds: 86400 }] },
    ttl_seconds: 300, review: { when: "The selected item is available.", then: `Set ${field} to the requested units.`,
      refused: ["The item is unavailable or the units are outside the hard range."], human_review: "One warehouse manager reviews valid exceptions.",
      examples: [{ kind: "eligible", scenario: "Available item, routine units", result: "Automatic approval within shared limits" },
        { kind: "ineligible", scenario: "Unavailable item", result: "Refuse" }] },
  };
}

function inspection(): SchemaInspection {
  const names = ["item_id", "tenant_id", "principal_id", "sku", "q_av", "reorder_point", "available", "version", "internal_note"];
  return { engine: "postgres", server_version: "PostgreSQL 16", current_user: "reader", inspected_at: "2026-09-08T00:00:00.000Z",
    schemas: ["warehouse"], warnings: [], role_posture: { verified: true, superuser: false, bypass_rls: false, read_only: true,
      writable_relations: [], owned_relations: [], reasons: [] }, tables: [{ schema: "warehouse", name: "items", type: "table", writable: true,
      columns: names.map((name, ordinal_position) => ({ name, data_type: ["q_av", "reorder_point", "version"].includes(name) ? "integer" : name === "available" ? "boolean" : "text",
        ordinal_position, nullable: false, generated: false, suggestions: { tenant: name === "tenant_id", conflict: name === "version",
          sensitive: name === "internal_note", immutable: name.endsWith("_id"), large_or_binary: false } })),
      primary_key: ["item_id"], unique_constraints: [{ name: "items_pkey", columns: ["item_id"] }], check_constraints: [], foreign_keys: [],
      row_level_security: false, indexes: [], role_posture: { owner: "owner", current_role_is_owner: false, current_role_can_assume_owner: false,
        privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false },
        row_security_forced: false, row_security_effective_for_current_role: false },
      suggestions: { tenant_columns: ["tenant_id"], conflict_columns: ["version"], sensitive_columns: ["internal_note"], default_visible_columns: ["sku", "q_av", "reorder_point"] } }],
  };
}
