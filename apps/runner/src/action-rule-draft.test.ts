import type {
  ActionRuleCatalogV1,
} from "@synapsor-runner/action-rules";
import { normalizeActionRule } from "@synapsor-runner/action-rules";
import type { ActionRuleScalarExpressionV1, ActionRuleScalarTypeSpecV1 } from "@synapsor/spec";
import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { actionRuleModelDraftJsonSchema } from "./action-rule-model.js";
import { createSemanticActionRuntime } from "@synapsor-runner/mcp-server";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import type { BuiltActionRuleAuthoringCatalogV1 } from "./action-rule-authoring.js";
import { policyCoverageDraft } from "./authoring-policy-evidence.js";
import { semanticActionBusinessReviewLines } from "./boundary-commands.js";
import {
  ACTION_RULE_MODEL_DRAFT_VERSION,
  actionRuleModelDraftFromAuthority,
  actionRuleDraftDiagnostics,
  compileActionRuleModelDraft,
  hasExactActionRowPath,
  type ActionRuleModelDraftV1,
} from "./action-rule-draft.js";

const lock = `sha256:${"a".repeat(64)}` as const;
const readDigest = `sha256:${"b".repeat(64)}` as const;
const stringId = { kind: "string", max_length: 64, comparison: "exact" } as const;
const statusType: ActionRuleScalarTypeSpecV1 = {
  kind: "string",
  max_length: 8,
  comparison: "exact",
  enum: ["active", "paused"],
};

describe("model-authored Action Rule draft compilation", () => {
  it("exports only draft review fields from a stored outcome-linked review", () => {
    const proposed = draft(), built = builtCatalog();
    const compiled = compileActionRuleModelDraft({ draft: proposed, builtCatalog: built, readBoundary: boundary(), readBoundaryDigest: readDigest });
    const storedReview = { outcome: proposed.outcome, ...proposed.review };
    const before = structuredClone(storedReview);
    const exported = actionRuleModelDraftFromAuthority({ authority: compiled.loaded.authority, outcome: proposed.outcome, review: storedReview });
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(actionRuleModelDraftJsonSchema());
    expect(validate(exported), JSON.stringify(validate.errors)).toBe(true);
    expect(exported.review).toEqual(proposed.review);
    expect(exported.review).not.toHaveProperty("outcome");
    expect(storedReview).toEqual(before);
    expect(() => actionRuleModelDraftFromAuthority({ authority: compiled.loaded.authority, outcome: proposed.outcome,
      review: { ...storedReview, outcome: "other.outcome" } as typeof storedReview })).toThrow("review belongs to another outcome");
    expect(validate({ ...exported, review: storedReview })).toBe(false);
  });
  it("reopens canonical child-first resources in their reviewed parent-first lock order", () => {
    const proposed = draft(), built = relatedBuiltCatalog();
    proposed.verification.resources.push({ binding: "a_policy", resource: "billing.account_policies",
      source: { kind: "relationship", from_binding: "account", relationship: "accounts_policy_fk", direction: "forward" }, fields: ["allow_pause"] });
    proposed.require = { kind: "all", expressions: [proposed.require,
      { kind: "compare", operator: "eq", left: { kind: "field", binding: "a_policy", field: "allow_pause" },
        right: { kind: "literal", value: true, value_type: { kind: "boolean" } } }] };
    const input = { builtCatalog: built, readBoundary: boundary(), readBoundaryDigest: readDigest };
    const compiled = compileActionRuleModelDraft({ ...input, draft: proposed });
    expect(compiled.loaded.authority.rules[0]!.verification_boundary.resources.map(resource => resource.binding))
      .toEqual(["a_policy", "account"]);
    const before = structuredClone(compiled.loaded.authority);
    const restored = actionRuleModelDraftFromAuthority({ authority: compiled.loaded.authority,
      outcome: proposed.outcome, review: proposed.review, preserveVerificationFields: true });
    const reopened = compileActionRuleModelDraft({ ...input, draft: restored });
    expect(reopened.verification_boundary).toEqual(compiled.verification_boundary);
    expect(reopened.effect_envelope).toEqual(compiled.effect_envelope);
    expect(normalizeActionRule(reopened.rule)).toEqual(normalizeActionRule(compiled.rule));
    expect(reopened.approval_class).toEqual(compiled.approval_class);
    expect(compiled.loaded.authority).toEqual(before);
    const resumedAgain = actionRuleModelDraftFromAuthority({ authority: reopened.loaded.authority,
      outcome: proposed.outcome, review: proposed.review, preserveVerificationFields: true });
    expect(resumedAgain).toEqual(restored);
    for (const order of [["account"], ["account", "account"], ["account", "missing"]]) {
      const invalid = structuredClone(before);
      invalid.rules[0]!.verification_boundary.lock_order = order;
      expect(() => actionRuleModelDraftFromAuthority({ authority: invalid,
        outcome: proposed.outcome, review: proposed.review })).toThrow(/inconsistent reviewed verification order/);
    }
  });
  it("round-trips explicit nullable text and timestamp clearing without changing approval settings", () => {
    const built = builtCatalog(), proposed = draft();
    for (const [name, type] of [["drop_reason", { kind: "string", max_length: 32, comparison: "exact", enum: ["prerequisite_error"] }],
      ["dropped_at", { kind: "timestamp" }]] as const) {
      const field = { name, type: structuredClone(type) as ActionRuleScalarTypeSpecV1, nullable: true };
      built.catalog.resources[0]!.fields.push(field);
      built.authoring.resources[0]!.fields.push({ ...field, role: "runner_verification_only", writable: true });
      proposed.effect.allowed_fields.push({ name, values: [null] });
      proposed.effect.set[name] = { kind: "literal", value: null, value_type: field.type };
    }
    const input = { builtCatalog: built, readBoundary: boundary(), readBoundaryDigest: readDigest };
    const compiled = compileActionRuleModelDraft({ ...input, draft: proposed });
    const restored = actionRuleModelDraftFromAuthority({ authority: compiled.loaded.authority, outcome: proposed.outcome, review: proposed.review });
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(actionRuleModelDraftJsonSchema());
    expect(validate(restored), JSON.stringify(validate.errors)).toBe(true);
    expect(restored.effect.set).toEqual(proposed.effect.set);
    expect(restored.effect.allowed_fields).toEqual([...proposed.effect.allowed_fields].sort((a, b) => a.name.localeCompare(b.name)));
    expect(compileActionRuleModelDraft({ ...input, draft: restored }).loaded.authority.approval_classes).toEqual(compiled.loaded.authority.approval_classes);
  });
  it("infers complete collection protection and preserves aggregate-only private fields through edits", () => {
    const built = relatedBuiltCatalog();
    const policy = built.catalog.resources[1]!;
    const authoring = built.authoring.resources[1]!;
    const accountId = { name: "account_id", type: stringId, nullable: false };
    const amount = { name: "amount", type: { kind: "integer" as const, unit: "credits" }, nullable: false };
    policy.fields.push(accountId, amount);
    authoring.fields.push({ ...accountId, role: "guard", writable: false }, { ...amount, role: "runner_verification_only", writable: false });
    const relation = { name: "policies_account_fk", from_resource: policy.name, to_resource: "billing.accounts",
      field_pairs: ["tenant_id", "principal_id", "account_id"].map(field => ({ local_field: field, target_field: field })),
      cardinality: "many_to_one" as const, nullable: false, target_unique: true };
    built.catalog.relationships = [relation]; built.authoring.relationships = [relation];
    const proposed = draft();
    proposed.verification.resources.push({ binding: "policies", resource: policy.name,
      source: { kind: "relationship", from_binding: "account", relationship: relation.name, direction: "inverse" },
      fields: ["allow_pause", "amount"], max_rows: 10, overflow: "unsupported", deterministic_order: [{ field: "policy_id", direction: "asc" }] });
    proposed.require = { kind: "not", expression: { kind: "exists", binding: "policies", where: { kind: "compare", operator: "eq",
      left: { kind: "field", binding: "policies", field: "allow_pause" }, right: { kind: "literal", value: false, value_type: { kind: "boolean" } } } } };
    proposed.derive.total = { kind: "aggregate", operation: "sum", binding: "policies", field: "amount", where: { kind: "compare", operator: "eq",
      left: { kind: "field", binding: "policies", field: "allow_pause" }, right: { kind: "literal", value: true, value_type: { kind: "boolean" } } } };
    const input = { builtCatalog: built, readBoundary: boundary(), readBoundaryDigest: readDigest };
    const invalidOrder = structuredClone(proposed);
    invalidOrder.verification.resources[1]!.deterministic_order = [{ field: "amount", direction: "desc" }];
    let repair: ReturnType<typeof actionRuleDraftDiagnostics>[number] | undefined;
    try { compileActionRuleModelDraft({ ...input, draft: invalidOrder }); }
    catch (error) { repair = actionRuleDraftDiagnostics(error, { builtCatalog: built, verification: invalidOrder.verification })[0]; }
    expect(repair?.code).toBe("ACTION_RULE_UNBOUNDED");
    expect(repair?.correction?.after).toEqual([{ field: "amount", direction: "desc" }, { field: "policy_id", direction: "asc" }]);
    const corrected = structuredClone(invalidOrder);
    corrected.verification.resources[1]!.deterministic_order = repair!.correction!.after;
    const repaired = compileActionRuleModelDraft({ ...input, draft: corrected });
    expect(repaired.draft.require).toEqual(proposed.require);
    expect(repaired.draft.approval).toEqual(proposed.approval);
    expect(repaired.draft.effect).toEqual(proposed.effect);
    const compiled = compileActionRuleModelDraft({ ...input, draft: proposed });
    expect(compiled.verification_boundary.resources[1]!.collection_consistency).toBe("complete_locked");
    expect(compiled.verification_boundary.transaction.isolation).toBe("read_committed");
    expect(proposed.verification.resources[1]!.collection_consistency).toBeUndefined();
    const minimal = actionRuleModelDraftFromAuthority({ authority: compiled.loaded.authority, outcome: proposed.outcome, review: proposed.review });
    expect(minimal.verification.resources[1]!.fields).toContain("amount");
    const restored = actionRuleModelDraftFromAuthority({ authority: compiled.loaded.authority, outcome: proposed.outcome, review: proposed.review, preserveVerificationFields: true });
    expect(restored.verification.resources[1]!.collection_consistency).toBe("complete_locked");
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(actionRuleModelDraftJsonSchema());
    expect(validate(restored), JSON.stringify(validate.errors)).toBe(true);
    restored.approval.required_approvals = 2;
    const edited = compileActionRuleModelDraft({ ...input, draft: restored });
    expect(edited.verification_boundary).toEqual(compiled.verification_boundary);
    expect(edited.rule.require).toEqual(compiled.rule.require);
    expect(edited.rule.derive).toEqual(compiled.rule.derive);
    expect(edited.effect_envelope).toEqual(compiled.effect_envelope);
  });
  it("round-trips one combined action through the model schema, review and a later policy edit", () => {
    const { proposed, built } = atomicDraft();
    const input = { builtCatalog: built, readBoundary: boundary(), readBoundaryDigest: readDigest };
    const compiled = compileActionRuleModelDraft({ ...input, draft: proposed });
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(actionRuleModelDraftJsonSchema());
    expect(validate(compiled.draft), JSON.stringify(validate.errors)).toBe(true);
    expect(compiled.effect_envelope.atomic_updates).toMatchObject([{ target_resource: "billing.account_policies",
      target_binding: "policy", version_advance: { column: "version", strategy: "integer_increment" } }]);
    expect(compiled.rule.atomic_updates).toMatchObject([{ set: { allow_pause: { kind: "literal", value: false } } }]);
    const restored = actionRuleModelDraftFromAuthority({ authority: compiled.loaded.authority,
      outcome: proposed.outcome, review: proposed.review });
    expect(restored.effect.atomic_updates).toEqual(proposed.effect.atomic_updates);
    restored.approval.required_approvals = 2;
    const edited = compileActionRuleModelDraft({ ...input, draft: restored });
    expect(edited.rule.atomic_updates).toEqual(compiled.rule.atomic_updates);
    expect(edited.effect_envelope).toEqual(compiled.effect_envelope);
    expect(edited.verification_boundary).toEqual(compiled.verification_boundary);
    expect(normalizeActionRule(edited.rule).require).toEqual(normalizeActionRule(compiled.rule).require);
    expect(edited.approval_class.required_approvals).toBe(2);
    expect(edited.loaded.authority.rules).toHaveLength(1);
    const review = semanticActionBusinessReviewLines(edited, boundary()).join("\n");
    expect(review).toContain("Also changes");
    expect(review).toContain("allow pause becomes false");
    expect(review).toContain("together");
    expect(policyCoverageDraft({ read: boundary(), decisions: [], actions: [edited] })
      .runner_evidence.actions[proposed.outcome]!.effect.atomic_updates).toMatchObject([
        { version_advance: { column: "version", strategy: "integer_increment" }, source_fields_modified: ["allow_pause", "version"] },
      ]);
  });

  it.each(["duplicate", "unknown_field", "no_version", "read_only", "nested", "insert", "too_many"])(
    "refuses an unsafe companion before saving any action: %s", (failure) => {
      const { proposed, built } = atomicDraft();
      const member = proposed.effect.atomic_updates![0]!;
      if (failure === "duplicate") { member.target_binding = "account"; member.target_resource = "billing.accounts"; }
      if (failure === "unknown_field") member.allowed_fields = [{ name: "made_up" }];
      if (failure === "no_version") {
        delete built.catalog.resources[1]!.version_field;
        delete built.authoring.resources[1]!.selected_version_field;
        built.authoring.resources[1]!.version_candidates = [];
      }
      if (failure === "read_only") built.authoring.resources[1]!.operations.update = false;
      if (failure === "nested") Object.assign(member, { atomic_updates: [structuredClone(member)] });
      if (failure === "insert") Object.assign(member, { operation: "insert" });
      if (failure === "too_many") proposed.effect.atomic_updates = Array(4).fill(member);
      const before = structuredClone(proposed);
      expect(() => compileActionRuleModelDraft({ draft: proposed, builtCatalog: built,
        readBoundary: boundary(), readBoundaryDigest: readDigest })).toThrow();
      expect(proposed).toEqual(before);
    },
  );
  it("retains a private value used only by the companion update when reopening the action", () => {
    const { proposed, built } = atomicDraft();
    const field = { name: "allow_pause_after_use", type: { kind: "boolean" as const }, nullable: false };
    built.catalog.resources[1]!.fields.push(field);
    built.authoring.resources[1]!.fields.push({ ...field, role: "runner_verification_only", writable: false });
    proposed.verification.resources[1]!.fields.push(field.name);
    proposed.effect.atomic_updates![0]!.set.allow_pause = { kind: "field", binding: "policy", field: field.name };
    const input = { builtCatalog: built, readBoundary: boundary(), readBoundaryDigest: readDigest };
    const compiled = compileActionRuleModelDraft({ ...input, draft: proposed });
    const restored = actionRuleModelDraftFromAuthority({ authority: compiled.loaded.authority, outcome: proposed.outcome, review: proposed.review });
    expect(restored.verification.resources.find(resource => resource.binding === "policy")!.fields).toContain(field.name);
    const reopened = compileActionRuleModelDraft({ ...input, draft: restored });
    expect(reopened.rule.atomic_updates).toEqual(compiled.rule.atomic_updates);
    expect(reopened.verification_boundary).toEqual(compiled.verification_boundary);
  });
  it.each(["proposal_only", "supervised"] as const)("business review follows compiled rules, not reassuring model prose (%s)", (writeback) => {
    const proposed = draft();
    proposed.effect.writeback = writeback;
    proposed.review = { ...proposed.review, when: "Everyone is eligible", then: "All changes are complete", refused: ["Nothing is ever refused"] };
    proposed.approval = { ...proposed.approval, mode: "policy", auto_approve_when: proposed.require,
      shared_limits: [{ id: "overall", scope: "capability", kind: "count", maximum: 10, window_seconds: 86400 },
        { id: "account", scope: "tenant", kind: "count", maximum: 3, window_seconds: 86400 }] };
    const read = boundary();
    const compiled = compileActionRuleModelDraft({ draft: proposed, builtCatalog: builtCatalog(), readBoundary: read, readBoundaryDigest: readDigest });
    const before = structuredClone(compiled);
    const summary = semanticActionBusinessReviewLines(compiled, read).join("\n");
    expect(summary).not.toMatch(/Everyone is eligible|All changes are complete|Nothing is ever refused/);
    expect(summary).toContain("Missing or failed eligibility checks are refused");
    expect(summary).toContain("other valid requests, including limit overruns");
    expect(summary).toContain("10 automatic approvals");
    expect(summary).toContain("3 automatic approvals");
    expect(summary).toContain("rolling 24 hours");
    expect(summary).toContain("Target: only the selected account record");
    expect(summary).not.toContain("reviewer reviewer");
    expect(summary).toContain(writeback === "supervised" ? "prepared for separate review, not enabled" : "automatic execution is not configured");
    expect(compiled).toEqual(before);
  });
  it.each([false, true])("business review identifies a verified related target without exposing join keys (composite=%s)", (composite) => {
    const proposed = draft(), built = relatedBuiltCatalog();
    proposed.verification.resources.push({ binding: "policy", resource: "billing.account_policies",
      source: { kind: "relationship", from_binding: "account", relationship: "accounts_policy_fk", direction: "forward" }, fields: ["allow_pause"] });
    const policy = built.authoring.resources.find((resource) => resource.name === "billing.account_policies")!;
    policy.operations.update = true;
    policy.fields.find((field) => field.name === "allow_pause")!.writable = true;
    if (composite) {
      const { local_field: _local, target_field: _target, ...link } = built.catalog.relationships[0]!;
      built.catalog.relationships[0] = { ...link, field_pairs: [
        { local_field: "tenant_id", target_field: "tenant_id" }, { local_field: "policy_id", target_field: "policy_id" },
      ] };
    }
    proposed.effect = { ...proposed.effect, target_resource: "billing.account_policies", target_binding: "policy",
      allowed_fields: [{ name: "allow_pause", values: [true] }],
      set: { allow_pause: { kind: "literal", value: true, value_type: { kind: "boolean" } } } };
    const compiled = compileActionRuleModelDraft({ draft: proposed, builtCatalog: built, readBoundary: boundary(), readBoundaryDigest: readDigest });
    const summary = semanticActionBusinessReviewLines(compiled, boundary()).join("\n");
    expect(summary).toContain("Target: only the record linked to the selected account through the reviewed relationship");
    expect(summary).toContain("allow pause becomes true");
    expect(summary).not.toContain("allow pause from true");
    expect(summary).toContain("verifies that selection and its trusted scope");
    expect(summary).not.toContain("policy_id");
    expect(summary).not.toContain("tenant_id");
  });
  it.each(["proposal_only", "supervised"] as const)("supplies compiled version advancement to policy review without inventing execution authority (%s)", (writeback) => {
    const proposed = draft();
    proposed.effect.writeback = writeback;
    const compiled = compileActionRuleModelDraft({ draft: proposed, builtCatalog: builtCatalog(),
      readBoundary: boundary(), readBoundaryDigest: readDigest });
    const before = structuredClone(compiled);
    const evidence = policyCoverageDraft({ read: boundary(), decisions: [], actions: [compiled] });
    expect(evidence.runner_evidence.runtime_contract.agent_interface).toMatchObject({
      tools: ["app.describe_data", "app.explore_data", "app.describe_actions", "app.request_change"],
      surface: "fixed_four_tools", configuration_checked: false, connection_verified: false,
      limits: expect.stringContaining("Only supported, validated and explicitly activated boundaries"),
    });
    const action = evidence.runner_evidence.actions[compiled.rule.outcome]!;
    expect(action.effect).toMatchObject({ fields: ["status"],
      version_advance: { column: "version", strategy: "integer_increment" },
      source_fields_modified: ["status", "version"] });
    expect(action.execution.configured_mode).toBe(writeback === "supervised" ? "direct_sql" : "none");
    expect(action.execution.activation).toBe("separate_operator_review");
    const deployment = evidence.runner_evidence.runtime_contract.deployment_prerequisites.runner_execution_setup;
    expect(deployment).toMatchObject({ supported: writeback === "supervised", stage: "after_authority_review",
      configuration_checked: false, verified: false,
      outcomes: [{ outcome: compiled.rule.outcome, configured_mode: action.execution.configured_mode }] });
    expect(policyCoverageDraft({ read: boundary(), decisions: [], actions: [] })
      .runner_evidence.runtime_contract.deployment_prerequisites.runner_execution_setup.supported).toBe(false);
    const unsupported = structuredClone(compiled);
    unsupported.effect_envelope.writeback = { mode: "none", supervised_worker: "disabled" };
    expect(policyCoverageDraft({ read: boundary(), decisions: [], actions: [compiled, unsupported] })
      .runner_evidence.runtime_contract.deployment_prerequisites.runner_execution_setup.supported).toBe(false);
    expect(action.effect.unrelated_fields).toContain("source_fields_modified");
    expect(compiled).toEqual(before);
    expect(evidence.read.pack.resources[0]!.selectable_fields).toEqual(["status"]);
    // Absent compiled advancement must not be inferred from a conflict column.
    delete compiled.effect_envelope.version_advance;
    const missing = policyCoverageDraft({ read: boundary(), decisions: [], actions: [compiled] })
      .runner_evidence.actions[compiled.rule.outcome]!;
    expect(missing.effect).toMatchObject({ version_advance: null, source_fields_modified: ["status"] });
  });
  it.each(["boundary", "tenant", "tenant_principal", "tenant_object", "capability"] as const)(
    "derives exact approval-history selectors, not ID-based pools (%s)", (scope) => {
      const compile = (outcome: string, filter: boolean) => {
        const candidate = draft();
        candidate.name = candidate.outcome = outcome;
        candidate.approval = { ...candidate.approval, class_name: `${outcome}.approval`, mode: "policy",
          auto_approve_when: candidate.require, shared_limits: [{ id: `${outcome}.limit`, kind: "count", scope,
            maximum: 3, window_seconds: 86_400, ...(filter ? { capability: outcome } : {}) },
          { id: `${outcome}.required`, kind: "count", scope: scope === "boundary" || scope === "capability" ? "tenant" : "boundary",
            maximum: 100, window_seconds: 86_400 }] };
        return compileActionRuleModelDraft({ draft: candidate, builtCatalog: builtCatalog(), readBoundary: boundary(), readBoundaryDigest: readDigest });
      };
      const actions = [compile("billing.first", false), compile("billing.second", false)];
      const before = structuredClone(actions);
      const evidence = policyCoverageDraft({ read: boundary(), decisions: [], actions });
      const first = evidence.runner_evidence.actions["billing.first"]!.automatic_limits[0]!;
      const second = evidence.runner_evidence.actions["billing.second"]!.automatic_limits[0]!;
      expect(first.id).not.toBe(second.id);
      expect(first.history_selector).toEqual({
        action_boundary_name: actions[0]!.loaded.authority.action_boundary.name, approval_status: "approved",
        window_seconds: 86_400, time_bounds: "inclusive: now - window_seconds through now",
        capability: scope === "capability" ? "billing.first" : null,
        tenant: scope === "boundary" || scope === "capability" ? null : "current_proposal.tenant_id",
        principal: scope === "tenant_principal" ? "current_proposal.principal" : null,
        business_object: scope === "tenant_object" ? "current_proposal.business_object" : null,
        object_id: scope === "tenant_object" ? "current_proposal.object_id" : null,
      });
      expect(first.applies_to_outcome).toBe(true);
      if (scope === "capability") expect(first.history_selector).not.toEqual(second.history_selector);
      else expect(first.history_selector).toEqual(second.history_selector);
      const filtered = policyCoverageDraft({ read: boundary(), decisions: [], actions: [compile("billing.first", true), compile("billing.second", true)] });
      expect(filtered.runner_evidence.actions["billing.first"]!.automatic_limits[0]!.history_selector.capability).toBe("billing.first");
      expect(filtered.runner_evidence.actions["billing.second"]!.automatic_limits[0]!.history_selector.capability).toBe("billing.second");
      expect(evidence.runner_evidence.runtime_contract.approval_counter_selection.not_history_filters)
        .toEqual(["limit.id", "approval_class", "action_boundary_digest"]);
      expect(actions).toEqual(before);
    },
  );
  it("refreshes business search from a reviewed draft without changing tool schemas or touching source state", async () => {
    const compile = (candidate: ActionRuleModelDraftV1) => compileActionRuleModelDraft({ draft: candidate,
      builtCatalog: builtCatalog(), readBoundary: boundary(), readBoundaryDigest: readDigest });
    let registry = compile(draft()).loaded.registry;
    const noSourceAccess = new Proxy({}, { get() { throw new Error("Discovery must not use a source or proposal service"); } }) as never;
    const runtime = createSemanticActionRuntime({ registry: () => registry, store: noSourceAccess, subjectReferences: noSourceAccess,
      resolveContext: async () => { throw new Error("Discovery must not resolve source facts"); },
      resolveCatalogAuthorization: () => ({ scope_key: "reviewed-test-scope", revision: "same-scope" }),
    });
    const tools = runtime.listTools();
    const query = { query: "temporary billing pause" };
    expect(await runtime.callTool("app.describe_actions", query)).toMatchObject({ actions: [] });
    const revised = draft();
    revised.discovery = { title: "Pause billing", summary: "Pause an eligible account with billing review.", aliases: [query.query] };
    registry = compile(revised).loaded.registry;
    expect(await runtime.callTool("app.describe_actions", query)).toMatchObject({
      actions: [{ outcome: revised.outcome, description: revised.discovery.title, eligibility: "not_checked" }],
    });
    expect(runtime.listTools()).toEqual(tools);
  });

  it.each([false, true])("round-trips reviewed discovery vocabulary without changing executable policy (aliases=%s)", (includeAliases) => {
    const input = { builtCatalog: builtCatalog(), readBoundary: boundary(), readBoundaryDigest: readDigest,
      activatedAt: "2026-09-03T01:00:00.000Z" };
    const original = compileActionRuleModelDraft({ ...input, draft: draft() });
    const proposed = draft();
    proposed.discovery = { title: "Pause billing", summary: "Request a temporary account pause with billing review.",
      ...(includeAliases ? { aliases: ["pause my account", "temporary billing pause"] } : {}) };
    const revised = compileActionRuleModelDraft({ ...input, draft: proposed });
    expect(revised.rule["x-runner-discovery"]).toEqual(proposed.discovery);
    expect(revised.rule.require).toEqual(original.rule.require);
    expect(revised.rule.effect).toEqual(original.rule.effect);
    expect(revised.verification_boundary).toEqual(original.verification_boundary);
    expect(revised.effect_envelope).toEqual(original.effect_envelope);
    expect(revised.approval_class).toEqual(original.approval_class);
    expect(revised.loaded.authority.digest).not.toBe(original.loaded.authority.digest);
    expect(actionRuleModelDraftFromAuthority({ authority: revised.loaded.authority,
      outcome: proposed.outcome, review: proposed.review }).discovery).toEqual(proposed.discovery);
    expect(actionRuleModelDraftFromAuthority({ authority: original.loaded.authority,
      outcome: proposed.outcome, review: proposed.review })).not.toHaveProperty("discovery");
  });

  it.each([
    { title: "x".repeat(161), summary: "Pause billing.", aliases: [] },
    { title: "Pause", summary: "Pause billing.", aliases: Array(17).fill("billing") },
    { title: "Pause", summary: "Pause billing.", aliases: ["bad\u001b[31m"] },
    { title: "Pause", summary: "Pause billing.", aliases: [], eligibility: true },
  ])("refuses invalid public discovery metadata without silently truncating it", (discovery) => {
    const proposed = { ...draft(), discovery };
    expect(() => compileActionRuleModelDraft({ draft: proposed, builtCatalog: builtCatalog(),
      readBoundary: boundary(), readBoundaryDigest: readDigest })).toThrow(/discovery/i);
  });

  it.each([false, true])("refuses caller-supplied private conflict versions without relying on input names (derived=%s)", (derived) => {
    const attempted = draft();
    attempted.inputs = [{ name: "customer_choice", description: "A value.", type: { kind: "integer" }, minimum: 0, maximum: 100 }];
    attempted.derive.observed = { kind: "field", binding: "account", field: "version" };
    attempted.require = { kind: "all", expressions: [attempted.require, { kind: "compare", operator: "eq",
      left: derived ? { kind: "derived", name: "observed" } : { kind: "field", binding: "account", field: "version" },
      right: { kind: "input", name: "customer_choice" } }] };
    expect(() => compileActionRuleModelDraft({ draft: attempted, builtCatalog: builtCatalog(), readBoundary: boundary(), readBoundaryDigest: readDigest }))
      .toThrow("Runner binds opaque subjects, captures their observed version");
    attempted.require = draft().require;
    attempted.inputs = [{ name: "state", description: "Requested state.", type: statusType }];
    attempted.require = { kind: "compare", operator: "eq", left: { kind: "field", binding: "account", field: "status" }, right: { kind: "input", name: "state" } };
    expect(() => compileActionRuleModelDraft({ draft: attempted, builtCatalog: builtCatalog(), readBoundary: boundary(), readBoundaryDigest: readDigest })).not.toThrow();
  });
  it("permits only uniquely proven related-row targets", () => {
    const built = relatedBuiltCatalog();
    const root = draft().verification.resources[0]!;
    const link = built.catalog.relationships[0]!;
    const related = { binding: "policy", resource: link.to_resource, source: { kind: "relationship" as const, from_binding: root.binding,
      relationship: link.name, direction: "forward" as const }, fields: [] };
    expect(hasExactActionRowPath(related, [root, related], built.catalog)).toBe(true);
    link.target_unique = false;
    expect(hasExactActionRowPath(related, [root, related], built.catalog)).toBe(false);
    link.target_unique = true;
    link.cardinality = "one_to_many";
    expect(hasExactActionRowPath(related, [root, related], built.catalog)).toBe(false);
  });
  it("resolves trusted mechanics from reviewed metadata and compiles one semantic outcome", () => {
    const result = compileActionRuleModelDraft({
      draft: draft(),
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      activatedAt: "2026-09-03T01:00:00.000Z",
    });

    expect(result.verification_boundary.resources[0]).toMatchObject({
      binding: "account",
      primary_key: "account_id",
      version_field: "version",
      scope: { mode: "columns", tenant_field: "tenant_id", principal_field: "principal_id" },
      lock: "for_update",
    });
    expect(result.verification_boundary.resources[0]!.fields.map((field) => field.name))
      .toEqual(["account_id", "principal_id", "risk_hold", "status", "tenant_id", "version"]);
    expect(result.effect_envelope).toMatchObject({
      operation: "update",
      target_resource: "billing.accounts",
      target_binding: "account",
      conflict_key: "version",
      version_advance: { column: "version", strategy: "integer_increment" },
      allowed_fields: [{ name: "status", type: statusType, values: ["paused"] }],
      writeback: { mode: "none", supervised_worker: "disabled" },
    });
    expect(result.loaded.registry.rules).toHaveLength(1);
    expect(result.loaded.registry.rules[0]).toMatchObject({
      read_boundary_name: "billing_read",
      read_boundary_digest: readDigest,
      compiled: { outcome: "billing.pause_account" },
    });
    expect(result.loaded.registry.approval_classes[0]).toMatchObject({
      mode: "human",
      required_role: "billing_reviewer",
      required_approvals: 1,
    });
  });

  it("canonically fills the only one-row subject target for an UPDATE", () => {
    const attempted = draft();
    delete attempted.effect.target_binding;

    const result = compileActionRuleModelDraft({
      draft: attempted,
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      activatedAt: "2026-09-03T01:00:00.000Z",
    });

    expect(result.draft.effect.target_binding).toBe("account");
    expect(result.effect_envelope.target_binding).toBe("account");
    expect(attempted.effect.target_binding).toBeUndefined();
  });

  it.each([false, true])("adds private relationship keys without asking the model to name join columns (composite=%s)", (composite) => {
    const attempted = draft();
    attempted.verification.resources.push({
      binding: "policy",
      resource: "billing.account_policies",
      source: {
        kind: "relationship",
        from_binding: "account",
        relationship: "accounts_policy_fk",
        direction: "forward",
      },
      fields: ["allow_pause"],
    });
    attempted.require = {
      kind: "all",
      expressions: [
        attempted.require,
        {
          kind: "compare",
          operator: "eq",
          left: { kind: "field", binding: "policy", field: "allow_pause" },
          right: { kind: "literal", value: true, value_type: { kind: "boolean" } },
        },
      ],
    };

    const built = relatedBuiltCatalog();
    if (composite) {
      const { local_field: _local, target_field: _target, ...link } = built.catalog.relationships[0]!;
      built.catalog.relationships[0] = { ...link, field_pairs: [
        { local_field: "tenant_id", target_field: "tenant_id" }, { local_field: "policy_id", target_field: "policy_id" },
      ] };
    }
    const read = boundary();
    const originalRead = structuredClone(read);
    const result = compileActionRuleModelDraft({
      draft: attempted,
      builtCatalog: built,
      readBoundary: read,
      readBoundaryDigest: readDigest,
      activatedAt: "2026-09-03T01:00:00.000Z",
    });
    expect(read).toEqual(originalRead);
    for (const resource of result.verification_boundary.resources) {
      expect(resource.fields.find((field) => field.name === "tenant_id")?.model_visible).not.toBe(true);
      expect(resource.fields.find((field) => field.name === "policy_id")?.model_visible).not.toBe(true);
    }

    const account = result.verification_boundary.resources.find((resource) => resource.binding === "account")!;
    const policy = result.verification_boundary.resources.find((resource) => resource.binding === "policy")!;
    expect(attempted.verification.resources[0]!.fields).not.toContain("policy_id");
    expect(attempted.verification.resources[1]!.fields).not.toContain("policy_id");
    expect(account.fields.map((field) => field.name)).toContain("policy_id");
    expect(policy.fields.map((field) => field.name)).toContain("policy_id");
  });

  it("reconstructs a model-safe edit baseline without trusted scope or lock mechanics", () => {
    const original = draft();
    const compiled = compileActionRuleModelDraft({
      draft: original,
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      activatedAt: "2026-09-03T01:00:00.000Z",
    });

    const reconstructed = actionRuleModelDraftFromAuthority({
      authority: compiled.loaded.authority,
      outcome: original.outcome,
      review: compiled.review,
    });

    const recompiled = compileActionRuleModelDraft({
      draft: reconstructed,
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      activatedAt: "2026-09-03T01:00:00.000Z",
    });
    expect(recompiled.loaded.authority.digest).toBe(compiled.loaded.authority.digest);
    expect(reconstructed.outcome).toBe(original.outcome);
    expect(reconstructed.effect).toEqual(expect.objectContaining({
      operation: original.effect.operation,
      target_resource: original.effect.target_resource,
      target_binding: original.effect.target_binding,
    }));
    expect(JSON.stringify(reconstructed)).not.toContain("tenant_id");
    expect(JSON.stringify(reconstructed)).not.toContain("principal_id");
    expect(JSON.stringify(reconstructed)).not.toContain("generation_lock_fingerprint");
    expect(JSON.stringify(reconstructed)).not.toContain("for_update");
  });

  it("retains unused reviewed verification fields and the exact authority on unchanged resume", () => {
    const original = draft(), catalog = builtCatalog();
    catalog.catalog.resources[0]!.fields.push({ name: "display_name", type: stringId, nullable: false });
    catalog.authoring.resources[0]!.fields.push({ name: "display_name", type: stringId, role: "model_visible", nullable: false, writable: false });
    original.verification.resources[0]!.fields.push("display_name");
    const options = { builtCatalog: catalog, readBoundary: boundary(), readBoundaryDigest: readDigest,
      activatedAt: "2026-09-03T01:00:00.000Z" };
    const compiled = compileActionRuleModelDraft({ ...options, draft: original });
    const reconstructed = actionRuleModelDraftFromAuthority({ authority: compiled.loaded.authority,
      outcome: original.outcome, review: compiled.review, preserveVerificationFields: true });
    expect(reconstructed.verification.resources[0]!.fields).toContain("display_name");
    expect(reconstructed.verification.resources[0]!.fields).not.toContain("tenant_id");
    expect(reconstructed.verification.resources[0]!.fields).not.toContain("principal_id");
    expect(compileActionRuleModelDraft({ ...options, draft: reconstructed }).loaded.authority)
      .toEqual(compiled.loaded.authority);
    const editable = actionRuleModelDraftFromAuthority({ authority: compiled.loaded.authority,
      outcome: original.outcome, review: compiled.review });
    expect(editable.verification.resources[0]!.fields).not.toContain("display_name");
  });

  it("refuses a model attempt to write a trusted guard field", () => {
    const attempted = draft();
    attempted.effect.allowed_fields = [{ name: "tenant_id" }];
    attempted.effect.set = {
      tenant_id: { kind: "trusted", binding: "tenant" },
    };
    expect(() => compileActionRuleModelDraft({
      draft: attempted,
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
    })).toThrow(/tenant_id is not a reviewed writable Action Rule field/u);
  });

  it("returns machine-readable compiler diagnostics for bounded model repair", () => {
    const attempted = draft();
    attempted.require = {
      kind: "compare",
      operator: "gt",
      left: { kind: "field", binding: "account", field: "status" },
      right: literal("active"),
    };
    let diagnostics: ReturnType<typeof actionRuleDraftDiagnostics> = [];
    try {
      compileActionRuleModelDraft({
        draft: attempted,
        builtCatalog: builtCatalog(),
        readBoundary: boundary(),
        readBoundaryDigest: readDigest,
      });
    } catch (error) {
      diagnostics = actionRuleDraftDiagnostics(error);
    }
    expect(diagnostics).toEqual([expect.objectContaining({
      code: "ACTION_RULE_TYPE_MISMATCH",
      repair: "model",
      path: "rule.require",
    })]);
  });

  it("reports an exact bounded diagnostic before canonical hashing sees undefined model data", () => {
    const attempted = draft();
    attempted.derive = {
      invalid: {
        kind: "literal",
        value: undefined,
        value_type: stringId,
      } as unknown as ActionRuleScalarExpressionV1,
    };
    expect(() => compileActionRuleModelDraft({
      draft: attempted,
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
    })).toThrow(/rule\.derive\.invalid\.value must not contain an undefined value/u);
  });

  it("rejects a model name that the portable compiler cannot treat as a qualified outcome", () => {
    const attempted = draft();
    attempted.name = "pause-account";
    expect(() => compileActionRuleModelDraft({
      draft: attempted,
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
    })).toThrow(/dot-qualified fixed name/u);
  });
});

function atomicDraft() {
  const proposed = draft(), built = relatedBuiltCatalog();
  proposed.verification.resources.push({ binding: "policy", resource: "billing.account_policies",
    source: { kind: "relationship", from_binding: "account", relationship: "accounts_policy_fk", direction: "forward" }, fields: ["allow_pause"] });
  proposed.require = { kind: "all", expressions: [proposed.require, {
    kind: "compare", operator: "eq", left: { kind: "field", binding: "policy", field: "allow_pause" },
    right: { kind: "literal", value: true, value_type: { kind: "boolean" } },
  }] };
  const policy = built.authoring.resources[1]!;
  policy.operations.update = true;
  policy.fields.find((field) => field.name === "allow_pause")!.writable = true;
  proposed.effect.atomic_updates = [{ operation: "update", target_resource: policy.name, target_binding: "policy",
    allowed_fields: [{ name: "allow_pause", values: [false] }],
    set: { allow_pause: { kind: "literal", value: false, value_type: { kind: "boolean" } } } }];
  return { proposed, built };
}

function draft(): ActionRuleModelDraftV1 {
  return {
    schema_version: ACTION_RULE_MODEL_DRAFT_VERSION,
    name: "billing.pause_account",
    outcome: "billing.pause_account",
    verification: {
      name: "billing.pause_account_verification",
      resources: [{
        binding: "account",
        resource: "billing.accounts",
        source: { kind: "subject_ref" },
        fields: ["status", "risk_hold"],
      }],
    },
    effect: {
      name: "billing.pause_account_effect",
      operation: "update",
      target_resource: "billing.accounts",
      target_binding: "account",
      allowed_fields: [{ name: "status", values: ["paused"] }],
      set: { status: literal("paused") },
      writeback: "proposal_only",
    },
    require: {
      kind: "all",
      expressions: [
        { kind: "compare", operator: "eq", left: { kind: "field", binding: "account", field: "status" }, right: literal("active") },
        { kind: "compare", operator: "eq", left: { kind: "field", binding: "account", field: "risk_hold" }, right: { kind: "literal", value: false, value_type: { kind: "boolean" } } },
      ],
    },
    derive: {},
    approval: {
      class_name: "billing.human_pause",
      mode: "human",
      required_role: "billing_reviewer",
      required_approvals: 1,
      shared_limits: [],
    },
    ttl_seconds: 300,
    review: {
      when: "The account is active and has no risk hold.",
      then: "Propose setting the account status to paused.",
      refused: ["The account is already paused.", "A risk hold exists."],
      human_review: "Every eligible proposal requires one billing reviewer.",
      examples: [
        { kind: "eligible", scenario: "Active account without a hold", result: "Propose paused" },
        { kind: "ineligible", scenario: "Risk hold is present", result: "Refuse" },
      ],
    },
  };
}

function literal(value: "active" | "paused"): ActionRuleScalarExpressionV1 {
  return { kind: "literal", value, value_type: structuredClone(statusType) };
}

function builtCatalog(): BuiltActionRuleAuthoringCatalogV1 {
  const catalog: ActionRuleCatalogV1 = {
    schema_version: "synapsor.action-rule-catalog.v1",
    generation_lock_fingerprint: lock,
    resources: [{
      name: "billing.accounts",
      source: "local_postgres",
      engine: "postgres",
      schema: "billing",
      table: "accounts",
      primary_key: "account_id",
      tenant_key: "tenant_id",
      principal_scope_key: "principal_id",
      version_field: "version",
      fields: [
        { name: "account_id", type: stringId, nullable: false },
        { name: "tenant_id", type: stringId, nullable: false },
        { name: "principal_id", type: stringId, nullable: false },
        { name: "status", type: statusType, nullable: false },
        { name: "risk_hold", type: { kind: "boolean" }, nullable: false },
        { name: "version", type: { kind: "integer" }, nullable: false },
      ],
    }],
    relationships: [],
  };
  return {
    catalog,
    authoring: {
      schema_version: "synapsor.action-rule-authoring-catalog.v1",
      source: "local_postgres",
      engine: "postgres",
      read_boundary_name: "billing_read",
      generation_lock_fingerprint: lock,
      resources: [{
        name: "billing.accounts",
        primary_key: "account_id",
        tenant_scope: "direct",
        tenant_key: "tenant_id",
        principal_scope: "direct",
        principal_key: "principal_id",
        version_candidates: ["version"],
        selected_version_field: "version",
        operations: { update: true, insert: false },
        fields: catalog.resources[0]!.fields.map((field) => ({
          ...field,
          role: ["account_id", "tenant_id", "principal_id", "version"].includes(field.name)
            ? "guard" as const
            : field.name === "risk_hold"
              ? "runner_verification_only" as const
              : "model_visible" as const,
          writable: field.name === "status" || field.name === "risk_hold",
          ...(field.type.kind === "string" && field.type.enum ? { enum_source: "schema" as const } : {}),
        })),
      }],
      relationships: [],
      supported_language: {
        comparisons: ["eq", "neq", "lt", "lte", "gt", "gte"],
        predicates: ["all", "any", "not", "null_check", "in", "exists"],
        aggregates: ["count", "sum", "min", "max"],
        arithmetic: ["add", "subtract", "min", "max", "multiply", "divide", "clamp", "add_duration", "date_of"],
        effects: ["single_row_update", "single_row_insert"],
      },
      diagnostics: [],
      digest: `sha256:${"c".repeat(64)}`,
    },
  };
}

function relatedBuiltCatalog(): BuiltActionRuleAuthoringCatalogV1 {
  const built = builtCatalog();
  const accountCatalog = built.catalog.resources[0]!;
  const accountAuthoring = built.authoring.resources[0]!;
  accountCatalog.fields.push({ name: "policy_id", type: stringId, nullable: false });
  accountAuthoring.fields.push({
    name: "policy_id",
    type: stringId,
    nullable: false,
    role: "guard",
    writable: false,
  });
  const policyCatalog: ActionRuleCatalogV1["resources"][number] = {
    name: "billing.account_policies",
    source: "local_postgres",
    engine: "postgres",
    schema: "billing",
    table: "account_policies",
    primary_key: "policy_id",
    tenant_key: "tenant_id",
    principal_scope_key: "principal_id",
    version_field: "version",
    fields: [
      { name: "policy_id", type: stringId, nullable: false },
      { name: "tenant_id", type: stringId, nullable: false },
      { name: "principal_id", type: stringId, nullable: false },
      { name: "allow_pause", type: { kind: "boolean" }, nullable: false },
      { name: "version", type: { kind: "integer" }, nullable: false },
    ],
  };
  built.catalog.resources.push(policyCatalog);
  built.catalog.relationships.push({
    name: "accounts_policy_fk",
    from_resource: "billing.accounts",
    to_resource: "billing.account_policies",
    local_field: "policy_id",
    target_field: "policy_id",
    cardinality: "many_to_one",
    nullable: false,
    target_unique: true,
  });
  built.authoring.resources.push({
    name: policyCatalog.name,
    primary_key: policyCatalog.primary_key,
    tenant_scope: "direct",
    tenant_key: policyCatalog.tenant_key,
    principal_scope: "direct",
    principal_key: policyCatalog.principal_scope_key,
    version_candidates: ["version"],
    selected_version_field: "version",
    operations: { update: false, insert: false },
    fields: policyCatalog.fields.map((field) => ({
      ...field,
      role: field.name === "allow_pause" ? "runner_verification_only" as const : "guard" as const,
      writable: false,
    })),
  });
  built.authoring.relationships.push(structuredClone(built.catalog.relationships[0]!));
  return built;
}

function boundary(): ExplorationBoundaryDraft {
  return {
    schema_version: "synapsor.exploration-boundary.v1",
    activation: "disabled_unreviewed",
    deployment_profile: "production",
    source: "local_postgres",
    compiler_version: "test",
    spec_version: "test",
    trusted_context: { provider: "environment", tenant_env: "TENANT", principal_env: "PRINCIPAL" },
    generation_lock_fingerprint: lock,
    role_posture_fingerprint: `sha256:${"d".repeat(64)}`,
    pack: {
      name: "billing_read",
      resources: [{
        id: "billing.accounts",
        schema: "billing",
        table: "accounts",
        primary_key: "account_id",
        tenant_key: "tenant_id",
        principal_key: "principal_id",
        field_types: {},
        field_enums: {},
        selectable_fields: ["status"],
        filterable_fields: {},
        sortable_fields: [],
        groupable_fields: [],
        aggregate_measures: [],
        count_distinct_fields: [],
        time_bucket_fields: {},
        kept_out_fields: ["risk_hold"],
        relationships: [],
        minimum_cohort_size: 5,
        suppression_aware_totals: true,
      }],
    },
    budgets: {
      max_rows: 50,
      max_groups: 50,
      max_top_n: 25,
      max_measures: 3,
      max_dimensions: 3,
      max_time_ranges: 2,
      max_relationship_hops: 2,
      max_response_cells: 500,
      max_response_bytes: 65_536,
      statement_timeout_ms: 3_000,
      max_complexity: 24,
      max_queries_per_session: 1_000,
      max_extracted_cells_per_session: 4_000,
      max_differencing_queries: 16,
      rate_limit_per_minute: 120,
    },
    unresolved_decisions: [],
  };
}
