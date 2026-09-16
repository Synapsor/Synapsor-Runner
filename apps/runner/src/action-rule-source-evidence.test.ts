import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection, TableInfo } from "@synapsor-runner/schema-inspector";
import { buildAutoBoundary, explorationBoundaryCandidateDigest } from "./auto-boundary.js";
import { buildActionRuleAuthoringCatalog } from "./action-rule-authoring.js";
import { actionRuleModelDraftFromAuthority, compactActionRuleAuthoringCatalog, compileActionRuleModelDraft, type ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { buildActionRuleAuthorityDraft } from "./action-rule-authority.js";
import { prepareActionRuleReadRevision } from "./action-rule-read-revision.js";
import { ACTION_RULE_SOURCE_CONSTRAINT_GUIDANCE, actionRuleSourceConstraints, policySourceConstraintEvidence } from "./action-rule-source-evidence.js";
import { policyCoverageDraft, policyCoverageActionTargets } from "./authoring-policy-evidence.js";
import { parsePolicyCoverage, reviewPolicyCoverage } from "./authoring-policy-coverage.js";
import { authoringDestination, newPolicySourceSession, policyTextSnapshot } from "./authoring-policy-source.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";

const resource = "quality.measurements", outcome = "quality.release";
const uniqueName = "measurement_position_key", checkName = "measurement_position_range";
const columns = ["tenant_id", "principal_id", "lot_id", "sequence_no"];
const keyPath = `/runner_evidence/source_constraints/resources/${resource}/unique_constraints/${uniqueName}`;
const checkPath = `/runner_evidence/source_constraints/resources/${resource}/check_constraints/${checkName}`;
const policy = policyTextSnapshot(Buffer.from("The database enforces positions 1 through 16, unique within each complete tenant/person/lot key."), "quality-policy.txt");
const passage = { start: 1, end: 1, disposition: "implemented", responsibility: "runner",
  interpretation: "The inspected enforced range and complete non-null unique key provide the existing database guarantee.",
  draft_paths: [keyPath, checkPath], evidence_checks: [{ path: `${keyPath}/column_count`, equals: columns.length },
    ...columns.map((column, index) => ({ path: `${keyPath}/columns/${index}`, equals: column })),
    { path: `${keyPath}/all_columns_non_null`, equals: true }, { path: `${checkPath}/enforced`, equals: true },
    { path: `${checkPath}/definition`, equals: "CHECK (sequence_no >= 1 AND sequence_no <= 16)" }] };

describe("exact inspected Action source constraints", () => {
  it("carries exact non-key column nullability through review and rejects changed or missing inspection", () => {
    const f = fixture(), table = f.inspection.tables[1]!;
    // This separately labelled metadata variant is not either original known-case fixture.
    table.columns.push(column("duration", "integer"));
    const fresh = build(f.inspection), read = { ...f.read, generation_lock_fingerprint: canonicalJsonDigest(fresh.lock) };
    const input = { read, decisions: [], actions: [compile(fixture())], source: { inspection: f.inspection, generationLock: fresh.lock } };
    const path = `/runner_evidence/source_constraints/resources/${resource}/columns/duration/nullable`;
    const sourcePolicy = policyTextSnapshot(Buffer.from("Every stored duration is non-null."), "metadata-policy.txt");
    const submission = { passages: [{ start: 1, end: 1, disposition: "implemented", interpretation: "The exact current base column is NOT NULL.",
      draft_paths: [path], evidence_checks: [{ path, equals: false }] }] };
    const draft = policyCoverageDraft(input), before = structuredClone(draft);
    const first = parsePolicyCoverage(submission, sourcePolicy, draft, []);
    expect(parsePolicyCoverage({ passages: first.passages }, sourcePolicy, draft, [])).toEqual(first);
    expect(draft).toEqual(before);
    table.columns.find(column => column.name === "duration")!.nullable = true;
    expect(() => policyCoverageDraft(input)).toThrow("POLICY_SOURCE_EVIDENCE_STALE");
    const next = build(f.inspection);
    const changed = policyCoverageDraft({ ...input, read: { ...read, generation_lock_fingerprint: canonicalJsonDigest(next.lock) },
      source: { inspection: f.inspection, generationLock: next.lock } });
    expect(() => parsePolicyCoverage(submission, sourcePolicy, changed, [])).toThrow("Mechanical evidence mismatch");
    expect(() => parsePolicyCoverage(submission, sourcePolicy, policyCoverageDraft({ read, decisions: [], actions: [] }), [])).toThrow("Draft pointer");
  });

  it("exports complete keys and enforced checks for private-only sources without changing canonical authority", () => {
    const f = fixture(), before = structuredClone(f);
    const evidence = f.built.authoring.resources.find(entry => entry.name === resource)!.source_constraints!;
    expect(evidence.unique_constraints[uniqueName]).toEqual({ columns, column_count: columns.length, non_null_columns: columns, all_columns_non_null: true, unconditional: true });
    expect(evidence.check_constraints[checkName]).toEqual({ definition: "CHECK (sequence_no >= 1 AND sequence_no <= 16)", enforced: true });
    expect(compactActionRuleAuthoringCatalog(f.built.authoring).resources.find(entry => entry.name === resource)!.source_constraints).toEqual(evidence);
    expect(f.read.pack.resources.map(entry => entry.id)).toEqual(["quality.lots"]);
    expect(f.built.authoring.resources.find(entry => entry.name === resource)!.fields.every(field => field.role !== "model_visible")).toBe(true);
    expect(f.built.catalog.resources.every(entry => !Object.hasOwn(entry, "source_constraints"))).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("unreviewed comment");
    expect(f).toEqual(before);
  });

  it("binds private source evidence to current coverage without inventing a Read entry", () => {
    const f = fixture(), compiled = compile(f), input = { read: f.read, decisions: [], actions: [compiled], source: source(f) };
    const before = structuredClone(input), draft = policyCoverageDraft(input);
    expect(draft.runner_evidence.read_access).not.toHaveProperty(resource);
    expect(draft.runner_evidence.source_constraints!.resources[resource]!.unique_constraints[uniqueName]!.columns).toEqual(columns);
    expect(parsePolicyCoverage({ passages: [passage] }, policy, draft, []).passages[0]!.disposition).toBe("implemented");
    expect(input).toEqual(before);
  });

  it("keeps exact bound field nullability and receipt modes separate from deployment readiness", () => {
    const f = fixture(), compiled = compile(f);
    const draft = policyCoverageDraft({ read: f.read, decisions: [], actions: [compiled], source: source(f) });
    const action = draft.runner_evidence.actions[outcome]!;
    for (const binding of compiled.verification_boundary.resources) for (const field of binding.fields) {
      expect(action.scoped_bindings[binding.binding]!.fields[field.name]!.nullable).toBe(field.nullable);
      expect(action.scoped_bindings[binding.binding]!.source).toEqual(binding.source);
    }
    const contract = draft.runner_evidence.runtime_contract;
    expect(contract.receipts).toContain("runner_ledger");
    expect(contract.receipts).toContain("it is not a source-atomic receipt");
    expect(contract.receipts).toContain("source_db records the applied receipt in the same source transaction");
    expect(contract.deployment_prerequisites.runner_execution_setup).toMatchObject({ supported: true,
      receipt_modes_supported: ["runner_ledger", "source_db"], receipt_mode_checked: false, configuration_checked: false, verified: false });
    const path = "/runner_evidence/runtime_contract/deployment_prerequisites/runner_execution_setup";
    const receiptPolicy = policyTextSnapshot(Buffer.from("A source-atomic receipt requires a separately reviewed receipt table and writer."), "receipt-policy.txt");
    const requirement = { start: 1, end: 1, disposition: "needs_decision", responsibility: "deployment", issue_kind: "missing_configuration",
      deployment_prerequisite: "runner_execution_setup", draft_paths: [path],
      interpretation: "Review and verify the source_db receipt object and writer separately; disabled compilation does not configure them." };
    expect(parsePolicyCoverage({ passages: [requirement] }, receiptPolicy, draft, []).passages[0]!.disposition).toBe("needs_decision");
    const missing = policyCoverageDraft({ read: f.read, decisions: [], actions: [], source: source(f) });
    expect(missing.runner_evidence.runtime_contract.deployment_prerequisites.runner_execution_setup.receipt_modes_supported).toEqual([]);
    expect(() => parsePolicyCoverage({ passages: [requirement] }, receiptPolicy, missing, [])).toThrow("Execution setup can remain pending only");
  });

  it("excludes unrelated inspected sources from the current Read and Action evidence bundle", () => {
    const f = fixture(), unrelated = structuredClone(f.inspection.tables[1]!);
    unrelated.name = "unreviewed_measurements";
    f.inspection.tables.push(unrelated);
    const fresh = build(f.inspection), read = { ...f.read, generation_lock_fingerprint: canonicalJsonDigest(fresh.lock) };
    const draft = policyCoverageDraft({ read, decisions: [], actions: [compile(fixture())],
      source: { inspection: f.inspection, generationLock: fresh.lock } });
    expect(Object.keys(draft.runner_evidence.source_constraints!.resources)).toEqual(["quality.lots", resource]);
    expect(JSON.stringify(draft)).not.toContain("unreviewed_measurements");
    expect(() => parsePolicyCoverage({ passages: [{ ...passage,
      draft_paths: [keyPath.replace(resource, "quality.unreviewed_measurements")] }] }, policy, draft, [])).toThrow("Draft pointer");
  });

  it("retains unchanged rules and fresh constraints through a writer-policy metadata refresh", () => {
    const f = fixture(), compiled = compile(f), existing = savedAuthority(compiled);
    const nextInspection = structuredClone(f.inspection);
    nextInspection.tables[1]!.row_level_security_policies = [{ name: "dedicated_lock_policy", command: "UPDATE", permissive: true,
      roles: ["dedicated_writer"], using_expression: "tenant_id = current_setting('app.tenant')::uuid AND principal_id = current_setting('app.person')::uuid" }];
    const next = build(nextInspection), read = { ...structuredClone(f.read), generation_lock_fingerprint: canonicalJsonDigest(next.lock) };
    const before = structuredClone(existing);
    const replacement = prepareActionRuleReadRevision({ existing, previousLock: f.lock, nextLock: next.lock,
      nextBoundary: read, inspection: nextInspection, revalidateMetadata: true });
    const rebuilt = buildActionRuleAuthoringCatalog({ boundary: read, inspection: nextInspection, retainedCatalog: replacement.authority.catalog });
    expect(rebuilt.authoring.resources.find(entry => entry.name === resource)!.source_constraints)
      .toEqual(f.built.authoring.resources.find(entry => entry.name === resource)!.source_constraints);
    const restored = actionRuleModelDraftFromAuthority({ authority: replacement.authority, outcome, review: proposed().review, preserveVerificationFields: true });
    const previousDraft = actionRuleModelDraftFromAuthority({ authority: existing.authority, outcome, review: proposed().review, preserveVerificationFields: true });
    expect(restored).toEqual(previousDraft);
    const draft = policyCoverageDraft({ read, decisions: [], actions: [], authority: replacement,
      source: { inspection: nextInspection, generationLock: next.lock } });
    expect(parsePolicyCoverage({ passages: [passage] }, policy, draft, []).passages[0]!.disposition).toBe("implemented");
    expect(draft.runner_evidence.source_constraints!.generation_lock_fingerprint).not.toBe(f.read.generation_lock_fingerprint);
    expect(draft.runner_evidence.read_access).not.toHaveProperty(resource);
    expect(existing).toEqual(before);
  });

  it.each(["key", "range", "lock", "engine"])("refuses stale inspected %s evidence instead of binding it to a current review", change => {
    const f = fixture(), current = source(f);
    if (change === "key") current.inspection.tables[1]!.unique_constraints = [];
    if (change === "range") current.inspection.tables[1]!.check_constraints = [];
    if (change === "lock") current.generationLock.evidence_fingerprint = canonicalJsonDigest("different review");
    if (change === "engine") current.inspection.engine = "mysql";
    expect(() => policySourceConstraintEvidence({ source: current, read: f.read, resources: [resource] })).toThrow("POLICY_SOURCE_EVIDENCE_STALE");
  });

  it.each(["partial", "unusable", "expression"])("does not promote an unusable %s key to unconditional uniqueness", kind => {
    const table = fixture().inspection.tables[1]!;
    table.indexes.push({ name: uniqueName, columns: [...columns], unique: true, catalog_key_columns: [...columns],
      catalog_partial: kind === "partial", catalog_usable: kind !== "unusable", catalog_full_columns: kind !== "expression" });
    expect(actionRuleSourceConstraints(table).unique_constraints).toEqual({});
  });

  it("retains nullable key semantics and never treats a larger key as a smaller duplicate-free tuple", () => {
    const f = fixture();
    f.inspection.tables[1]!.columns.find(column => column.name === "sequence_no")!.nullable = true;
    const evidence = actionRuleSourceConstraints(f.inspection.tables[1]!);
    expect(evidence.unique_constraints[uniqueName]).toMatchObject({ columns, all_columns_non_null: false,
      non_null_columns: columns.slice(0, 3) });
    const fresh = build(f.inspection), read = { ...f.read, generation_lock_fingerprint: canonicalJsonDigest(fresh.lock) };
    const draft = policyCoverageDraft({ read, decisions: [], actions: [compile(fixture())],
      source: { inspection: f.inspection, generationLock: fresh.lock } });
    expect(() => parsePolicyCoverage({ passages: [passage] }, policy, draft, [])).toThrow("Mechanical evidence mismatch");
    const smaller = { ...passage, evidence_checks: [{ path: `${keyPath}/column_count`, equals: 3 }] };
    expect(() => parsePolicyCoverage({ passages: [smaller] }, policy, draft, [])).toThrow("Mechanical evidence mismatch");
  });

  it.each(["unique_constraints", "check_constraints"] as const)("does not recover missing %s from a saved authority, policy assertion, label or unrelated source", kind => {
    const f = fixture(), compiled = compile(f), existing = savedAuthority(compiled);
    f.inspection.tables[1]![kind] = [];
    const fresh = build(f.inspection), read = { ...f.read, generation_lock_fingerprint: canonicalJsonDigest(fresh.lock) };
    const draft = policyCoverageDraft({ read, decisions: [], actions: [], authority: existing,
      source: { inspection: f.inspection, generationLock: fresh.lock } });
    expect(draft.runner_evidence.source_constraints!.resources[resource]![kind]).toEqual({});
    expect(() => parsePolicyCoverage({ passages: [passage] }, policy, draft, [])).toThrow("Draft pointer");
    expect(() => policySourceConstraintEvidence({ source: source(fixture()), read: fixture().read,
      resources: ["quality.unreviewed_measurements"] })).toThrow("POLICY_SOURCE_EVIDENCE_MISSING");
    const withoutInspection = policyCoverageDraft({ read: f.read, decisions: [], actions: [compiled] });
    expect(withoutInspection.runner_evidence).not.toHaveProperty("source_constraints");
    expect(() => parsePolicyCoverage({ passages: [passage] }, policy, withoutInspection, [])).toThrow("Draft pointer");
  });

  it("rejects stale coverage and exact-pointer substitutions after an inspected constraint changes", () => {
    const f = fixture(), compiled = compile(f);
    const previous = policyCoverageDraft({ read: f.read, decisions: [], actions: [compiled], source: source(f) });
    const report = parsePolicyCoverage({ passages: [passage] }, policy, previous, []);
    f.inspection.tables[1]!.unique_constraints[0]!.name = "replacement_key";
    const fresh = build(f.inspection), read = { ...f.read, generation_lock_fingerprint: canonicalJsonDigest(fresh.lock) };
    const current = policyCoverageDraft({ read, decisions: [], actions: [compiled], source: { inspection: f.inspection, generationLock: fresh.lock } });
    expect(() => policyCoverageActionTargets({ report, draft: current, passages: report.passages, editableOutcomes: [outcome] })).toThrow("POLICY_COVERAGE_DRAFT_CHANGED");
    expect(() => parsePolicyCoverage({ passages: report.passages }, policy, current, [])).toThrow("Draft pointer");
    for (const pointer of [keyPath.replace(uniqueName, uniqueName.toUpperCase()), keyPath.replace("source_constraints", "read_access"),
      keyPath.replace(resource, "quality.lots"), `${keyPath}/inferred_guarantee`]) {
      expect(() => parsePolicyCoverage({ passages: [{ ...passage, draft_paths: [pointer] }] }, policy, previous, [])).toThrow("Draft pointer");
    }
    expect(() => parsePolicyCoverage({ passages: [passage], runner_evidence: previous.runner_evidence }, policy, previous, [])).toThrow("unexpected top-level keys");
  });

  it("preserves exact escaped constraint names without prototype aliases", () => {
    const f = fixture(), table = f.inspection.tables[1]!;
    table.unique_constraints[0]!.name = "__proto__";
    table.check_constraints![0]!.name = "range/checked~";
    const evidence = actionRuleSourceConstraints(table);
    expect(Object.hasOwn(evidence.unique_constraints, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(evidence.unique_constraints)).toBe(Object.prototype);
    expect(evidence.check_constraints["range/checked~"]!.enforced).toBe(true);
    expect(() => canonicalJsonDigest(evidence)).not.toThrow();
    const fresh = build(f.inspection), read = { ...f.read, generation_lock_fingerprint: canonicalJsonDigest(fresh.lock) };
    const draft = policyCoverageDraft({ read, decisions: [], actions: [compile(fixture())],
      source: { inspection: f.inspection, generationLock: fresh.lock } });
    const escaped = { ...passage,
      draft_paths: [keyPath.replace(uniqueName, "__proto__"), checkPath.replace(checkName, "range~1checked~0")],
      evidence_checks: passage.evidence_checks.map(check => ({ ...check,
        path: check.path.replace(uniqueName, "__proto__").replace(checkName, "range~1checked~0") })) };
    expect(parsePolicyCoverage({ passages: [escaped] }, policy, draft, []).passages[0]!.draft_paths).toEqual(escaped.draft_paths);
    for (const pointer of [checkPath.replace(checkName, "range/checked~"), keyPath.replace(uniqueName, "constructor")]) {
      expect(() => parsePolicyCoverage({ passages: [{ ...escaped, draft_paths: [pointer] }] }, policy, draft, [])).toThrow("Draft pointer");
    }
    table.unique_constraints.push(structuredClone(table.unique_constraints[0]!));
    expect(() => actionRuleSourceConstraints(table)).toThrow("SOURCE_CONSTRAINT_METADATA_AMBIGUOUS");
  });

  it("supplies exact source links and structural guidance to bounded coverage review", async () => {
    const f = fixture(), draft = policyCoverageDraft({ read: f.read, decisions: [], actions: [compile(f)], source: source(f) });
    const before = structuredClone(draft), conversation = createModelAuthoringConversation();
    conversation.policySources = newPolicySourceSession(); conversation.policySources.snapshots = [policy];
    conversation.policySources.active = policy.version;
    conversation.policySources.approvals = [{ digest: policy.digest, destination: authoringDestination({ provider: "openai", model: "fixture" }) }];
    const requests: string[] = [];
    const report = await reviewPolicyCoverage({ source: policy, draft, env: { OPENAI_API_KEY: "test-key" },
      session: { provider: "openai", model: "fixture", conversation, dependencies: { requestJson: async request => {
        requests.push(JSON.stringify(request.body));
        return { status: 200, body: { output: [{ type: "function_call", call_id: "source_constraints",
          name: "runner__review_policy_coverage", arguments: JSON.stringify({ passages: [{ ...passage,
            draft_paths: requests.length === 1 ? [keyPath.replace(uniqueName, "invented_key")] : passage.draft_paths }] }) }] } };
      } } } });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain(keyPath);
    expect(requests[0]).toContain(checkPath);
    expect(requests[0]).toContain(`/runner_evidence/source_constraints/resources/${resource}/columns/sequence_no/nullable`);
    expect(requests[0]).toContain("does not prove a derived expression or optional relationship result is non-null");
    expect(requests[0]).toContain(ACTION_RULE_SOURCE_CONSTRAINT_GUIDANCE);
    expect(requests[1]).toContain("COVERAGE_REFERENCE_MISSING");
    expect(requests[1]).not.toContain("Previous untrusted coverage submission");
    expect(report.passages[0]!.disposition).toBe("implemented");
    expect(draft).toEqual(before);
  });
});

function column(name: string, data_type = "uuid", enum_values?: string[]): TableInfo["columns"][number] {
  return { name, data_type, ...(enum_values ? { enum_values } : {}), nullable: false, generated: false, identity: false, ordinal_position: 1,
    comment: "unreviewed comment", suggestions: { tenant: name === "tenant_id", conflict: name === "row_version", sensitive: false,
      immutable: name.endsWith("_id"), large_or_binary: false } };
}
function build(inspection: SchemaInspection) {
  return buildAutoBoundary({ inspection, sourceEnv: "DATABASE_URL", inspectedSchema: "quality",
    project: { root: "/tmp/source-constraint-unit", package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
}
function fixture() {
  const table = (name: string, fields: TableInfo["columns"]): TableInfo => ({ schema: "quality", name, type: "table", writable: true,
    columns: fields, primary_key: [fields[0]!.name], unique_constraints: [], check_constraints: [], foreign_keys: [], indexes: [],
    suggestions: { tenant_columns: ["tenant_id"], conflict_columns: fields.some(field => field.name === "row_version") ? ["row_version"] : [],
      sensitive_columns: [], default_visible_columns: [] } });
  const lots = table("lots", [column("lot_id"), column("tenant_id"), column("principal_id"), column("lot_number", "text"),
    column("unit_count", "integer"), column("release_status", "text", ["awaiting", "released", "scrapped"]), column("row_version", "integer")]);
  lots.unique_constraints = [{ name: "lot_scope_key", columns: columns.slice(0, 3) }];
  const measurements = table("measurements", [column("measurement_id"), column("tenant_id"), column("principal_id"), column("lot_id"),
    column("sequence_no", "integer"), column("result", "text", ["fail", "pass", "pending"])]);
  measurements.unique_constraints = [{ name: uniqueName, columns: [...columns] }];
  measurements.check_constraints = [{ name: checkName, definition: "CHECK (sequence_no >= 1 AND sequence_no <= 16)" }];
  measurements.foreign_keys = [{ name: "measurement_lot_key", columns: columns.slice(0, 3), referenced_schema: "quality", referenced_table: "lots",
    referenced_columns: columns.slice(0, 3), delete_rule: "RESTRICT" }];
  const inspection: SchemaInspection = { engine: "postgres", server_version: "PostgreSQL 16", current_user: "quality_reader",
    inspected_at: "2026-09-11T00:00:00.000Z", schemas: ["quality"], warnings: [], tables: [lots, measurements] };
  const initial = build(inspection), read = structuredClone(initial.exploration_boundary);
  read.pack = { name: "quality_read", resources: inspection.tables.map(table => ({ id: `quality.${table.name}`, schema: "quality", table: table.name,
    primary_key: table.primary_key[0]!, tenant_key: "tenant_id", principal_key: "principal_id",
    field_types: Object.fromEntries(table.columns.map(column => [column.name, column.data_type])),
    field_enums: Object.fromEntries(table.columns.filter(column => column.enum_values).map(column => [column.name, column.enum_values!])),
    selectable_fields: [], filterable_fields: {}, sortable_fields: [], groupable_fields: [], aggregate_measures: [],
    aggregate_measure_functions: {}, count_distinct_fields: [], time_bucket_fields: {}, kept_out_fields: [], relationships: [],
    minimum_cohort_size: 5, suppression_aware_totals: true,
  })) };
  const retained = buildActionRuleAuthoringCatalog({ boundary: read, inspection }).catalog;
  retained.resources.find(entry => entry.name === resource)!.verification_only = true;
  read.pack.resources = read.pack.resources.filter(entry => entry.id === "quality.lots");
  read.pack.resources[0]!.selectable_fields = ["lot_number", "unit_count", "release_status"];
  const built = buildActionRuleAuthoringCatalog({ boundary: read, inspection, retainedCatalog: retained });
  return { inspection, lock: initial.lock, read, built };
}
function source(f: ReturnType<typeof fixture>) { return { inspection: structuredClone(f.inspection), generationLock: structuredClone(f.lock) }; }
function proposed(): ActionRuleModelDraftV1 {
  return { schema_version: "synapsor.action-rule-model-draft.v1", name: "quality.release.rule", outcome,
    discovery: { title: "Release checked lot", summary: "Release a lot whose complete current measurements pass.", aliases: ["release lot"] },
    verification: { name: "quality.release.verification", resources: [
      { binding: "lot", resource: "quality.lots", source: { kind: "subject_ref" }, fields: ["lot_id", "release_status", "unit_count", "row_version"] },
      { binding: "checks", resource, source: { kind: "relationship", from_binding: "lot", relationship: "measurement_lot_key", direction: "inverse" },
        fields: ["measurement_id", "sequence_no", "result"], max_rows: 16, overflow: "ineligible", collection_consistency: "complete_locked",
        deterministic_order: [{ field: "sequence_no", direction: "asc" }, { field: "measurement_id", direction: "asc" }] },
    ] }, effect: { name: "quality.release.effect", operation: "update", target_resource: "quality.lots", target_binding: "lot",
      allowed_fields: [{ name: "release_status", values: ["released"] }], set: { release_status: { kind: "literal", value: "released",
        value_type: { kind: "string", max_length: 8, comparison: "exact", enum: ["awaiting", "released", "scrapped"] } } }, writeback: "supervised" },
    require: { kind: "all", expressions: [
      { kind: "compare", operator: "eq", left: { kind: "field", binding: "lot", field: "release_status" }, right: { kind: "literal", value: "awaiting",
        value_type: { kind: "string", max_length: 8, comparison: "exact", enum: ["awaiting", "released", "scrapped"] } } },
      { kind: "compare", operator: "gte", left: { kind: "aggregate", operation: "count", binding: "checks" },
        right: { kind: "literal", value: 2, value_type: { kind: "integer", unit: "rows" } } },
      { kind: "not", expression: { kind: "exists", binding: "checks", where: { kind: "compare", operator: "neq",
        left: { kind: "field", binding: "checks", field: "result" }, right: { kind: "literal", value: "pass",
          value_type: { kind: "string", max_length: 7, comparison: "exact", enum: ["fail", "pass", "pending"] } } } } },
    ] }, derive: {}, approval: { class_name: "quality.supervisor", mode: "policy", required_role: "quality_supervisor", required_approvals: 1,
      auto_approve_when: { kind: "compare", operator: "lte", left: { kind: "field", binding: "lot", field: "unit_count" },
        right: { kind: "literal", value: 50, value_type: { kind: "integer" } } },
      shared_limits: [{ id: "release_overall", kind: "count", scope: "capability", capability: outcome, maximum: 10, window_seconds: 86400 },
        { id: "release_tenant", kind: "count", scope: "tenant", capability: outcome, maximum: 3, window_seconds: 86400 }] }, ttl_seconds: 300,
    review: { when: "At least two complete current measurements pass for an awaiting lot.", then: "Release only the selected lot.",
      refused: ["Failed or absent measurements refuse release."], human_review: "Other valid requests need one quality supervisor.",
      examples: [{ kind: "eligible", scenario: "Forty units with complete passing evidence.", result: "Automatic approval within limits." }] } };
}
function compile(f: ReturnType<typeof fixture>) {
  return compileActionRuleModelDraft({ draft: proposed(), builtCatalog: f.built, readBoundary: f.read,
    readBoundaryDigest: explorationBoundaryCandidateDigest(f.read) });
}
function savedAuthority(compiled: ReturnType<typeof compile>) {
  const authority = compiled.loaded.authority;
  return buildActionRuleAuthorityDraft({ name: authority.name, action_boundary_name: authority.action_boundary.name,
    catalog: authority.catalog, rules: authority.rules, approval_classes: authority.approval_classes,
    reviews: [{ outcome, ...compiled.review }], now: "2026-09-11T00:00:00.000Z" });
}
