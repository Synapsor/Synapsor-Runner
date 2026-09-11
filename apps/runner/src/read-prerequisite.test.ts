import { describe, expect, it } from "vitest";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION, buildAutoBoundary, seedConfiguredPrincipalBindingReview,
  type ConfiguredTrustedContextAuthority } from "./auto-boundary.js";
import { rebaseSavedBoundaryForRescan } from "./boundary-library.js";
import {
  assertReviewedReadCurrentStatePrerequisite,
  compileReadPrerequisiteGate,
  compileReadPrerequisitePredicate,
  listSupportedReadCurrentStatePrerequisiteCandidates,
  listReadCurrentStatePrerequisiteSources,
  prepareReviewedReadCurrentStatePrerequisite,
  type ReadPrerequisiteBoundaryContext,
} from "./read-prerequisite.js";

const boundary: ReadPrerequisiteBoundaryContext = {
  trusted_context: { provider: "environment", principal_env: "SYNAPSOR_PRINCIPAL" },
  pack: { resources: [{ schema: "public", table: "student_admissions", tenant_key: "institution_id", principal_key: "student_id" }] },
};

describe("Read current-state prerequisite", () => {
  describe("reviewed scope proof", () => {
    const known = {
      ...boundary,
      pack: { resources: [{ schema: "public", table: "student_admissions", tenant_key: "institution_id", principal_key: "student_id" }] },
    };
    it("does not advertise the reverse of existing reviewed source identity", () => {
      const candidates = listSupportedReadCurrentStatePrerequisiteCandidates(admissionInspection(), known);
      expect(candidates).toHaveLength(2);
      expect(candidates.every(candidate => candidate.subject.tenant_column === "institution_id"
        && candidate.subject.principal_column === "student_id")).toBe(true);
    });
    it("rejects an explicitly selected reversed identity before preparing authority", () => {
      const selection = validSelection();
      selection.subject.tenant_column = "student_id";
      selection.subject.principal_column = "institution_id";
      expect(() => prepareReviewedReadCurrentStatePrerequisite(selection, admissionInspection(), known))
        .toThrow(/scope|exact supported inspected candidate/i);
    });
    it("does not infer a private source's identity from another table's column names", () => {
      const unrelated = { ...known, pack: { resources: [{ ...known.pack.resources[0]!, table: "unrelated" }] } };
      expect(() => listSupportedReadCurrentStatePrerequisiteCandidates(admissionInspection(), unrelated))
        .toThrow(/READ_PREREQUISITE_SCOPE_PROOF_MISSING/);
      expect(() => listReadCurrentStatePrerequisiteSources(admissionInspection(), unrelated))
        .toThrow(/READ_PREREQUISITE_SCOPE_PROOF_MISSING/);
    });
  });
  it("narrows metadata review without truncating or blocking exact validation on unrelated sources", () => {
    const inspection = admissionInspection();
    for (let index = 0; index < 40; index++) {
      inspection.tables.push({ ...structuredClone(inspection.tables[0]!), name: `other_status_${index}` });
    }
    const context = { ...boundary, pack: { resources: inspection.tables.map(table => ({
      ...boundary.pack.resources[0]!, schema: table.schema, table: table.name,
    })) } };
    const before = structuredClone(inspection);
    expect(() => listSupportedReadCurrentStatePrerequisiteCandidates(inspection, context)).toThrow("READ_PREREQUISITE_CATALOG_TOO_LARGE");
    const sources = listReadCurrentStatePrerequisiteSources(inspection, context);
    expect(sources).toHaveLength(41);
    expect(sources).toContainEqual({ schema: "public", table: "other_status_39" });
    const candidates = listSupportedReadCurrentStatePrerequisiteCandidates(inspection, context, { source: validSelection().source });
    expect(candidates).toHaveLength(2);
    expect(candidates.every(candidate => candidate.source.table === "student_admissions")).toBe(true);
    const reviewed = prepareReviewedReadCurrentStatePrerequisite(validSelection(), inspection, boundary);
    assertReviewedReadCurrentStatePrerequisite(reviewed, inspection);
    expect(() => prepareReviewedReadCurrentStatePrerequisite({ ...validSelection(), source: { schema: "public", table: "invented" } }, inspection, boundary))
      .toThrow("not an exact supported inspected candidate");
    expect(inspection).toEqual(before);
  });
  it("lists catalog-only exact-one candidates and binds one reviewed selection", () => {
    const inspection = admissionInspection();
    const candidates = listSupportedReadCurrentStatePrerequisiteCandidates(inspection, boundary);
    expect(candidates).toContainEqual(expect.objectContaining({
      source: { schema: "public", table: "student_admissions" },
      subject: { tenant_column: "institution_id", principal_column: "student_id", unique_constraint: "student_admissions_subject_key" },
      current_state: expect.objectContaining({
        state_column: "status",
        positive_states: ["admitted", "not_admitted", "withdrawn"],
        interval: "[effective_from,effective_until)",
        clock: "database_utc",
      }),
    }));
    const reviewed = prepareReviewedReadCurrentStatePrerequisite({
      source: { schema: "public", table: "student_admissions" },
      subject: { tenant_column: "institution_id", principal_column: "student_id", unique_constraint: "student_admissions_subject_key" },
      current_state: {
        state_column: "status",
        positive_state: "admitted",
        effective_from_column: "effective_from",
        effective_until_column: "effective_until",
        interval: "[effective_from,effective_until)",
        clock: "database_utc",
      },
      semantic_consent: {
        source_description: "Registrar-maintained current admission record for one student at one institution.",
        positive_state_description: "Only admitted establishes current admission.",
        confirmed: true,
      },
    }, inspection, boundary);
    expect(reviewed.dependency.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(reviewed)).not.toContain("tenant-acme");
    assertReviewedReadCurrentStatePrerequisite(reviewed, inspection);

    const untypedSelection = { ...validSelection(), rls_session: { tenant_setting: "model.supplied" } } as any;
    const hostBound = prepareReviewedReadCurrentStatePrerequisite(untypedSelection, inspection, boundary);
    expect(hostBound.rls_session).toBeUndefined();
  });

  it("refuses non-unique identity, unsupported time representation, and stale RLS/enum metadata", () => {
    const inspection = admissionInspection();
    const selection = validSelection();
    const nonUnique = structuredClone(inspection);
    nonUnique.tables[0]!.unique_constraints = [];
    expect(() => prepareReviewedReadCurrentStatePrerequisite(selection, nonUnique, boundary))
      .toThrow(/exact supported inspected candidate/i);

    const ambiguousTime = structuredClone(inspection);
    ambiguousTime.tables[0]!.columns.find((column) => column.name === "effective_until")!.data_type = "timestamp";
    expect(() => prepareReviewedReadCurrentStatePrerequisite(selection, ambiguousTime, boundary))
      .toThrow(/exact supported inspected candidate/i);

    const reviewed = prepareReviewedReadCurrentStatePrerequisite(selection, inspection, boundary);
    const drifted = structuredClone(inspection);
    drifted.tables[0]!.columns.find((column) => column.name === "status")!.enum_values = ["admitted", "withdrawn"];
    expect(() => assertReviewedReadCurrentStatePrerequisite(reviewed, drifted))
      .toThrow(/stale|changed/i);
    drifted.tables[0]!.columns.find((column) => column.name === "status")!.enum_values = ["admitted", "not_admitted", "withdrawn"];
    drifted.tables[0]!.row_level_security_policies![0]!.using_expression = "institution_id = current_setting('app.other')";
    expect(() => assertReviewedReadCurrentStatePrerequisite(reviewed, drifted))
      .toThrow(/stale|changed/i);
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])("combines compatible reviewed RLS roles (reverse=%s, optional=%s)", (reverse, optional) => {
    const resources = [
      { rls_session: { tenant_setting: "app.institution_id" } },
      { ...boundary.pack.resources[0]!, rls_session: { tenant_setting: "app.institution_id", principal_setting: "app.student_id" } },
      { rls_session: { ...(optional ? { tenant_setting: undefined } : {}), principal_setting: "app.student_id" } },
      {},
    ];
    const context = { ...boundary, pack: { resources: reverse ? resources.reverse() : resources } };
    const before = structuredClone(context);
    const reviewed = prepareReviewedReadCurrentStatePrerequisite(validSelection(), admissionInspection(), context);
    expect(reviewed.rls_session).toEqual({ tenant_setting: "app.institution_id", principal_setting: "app.student_id" });
    expect(context).toEqual(before);
    assertReviewedReadCurrentStatePrerequisite(reviewed, admissionInspection());
  });

  it.each([
    [{ tenant_setting: "app.institution_id" }, { tenant_setting: "app.other_institution" }],
    [{ principal_setting: "app.student_id" }, { principal_setting: "app.other_student" }],
    [{ tenant_setting: "app.identity" }, { principal_setting: "app.identity" }],
  ])("rejects conflicting reviewed RLS roles without changing the draft: %j", (...sessions) => {
    const context = { ...boundary, pack: { resources: sessions.map((rls_session) => ({ principal_key: "student_id", rls_session })) } };
    const before = structuredClone(context);
    expect(() => prepareReviewedReadCurrentStatePrerequisite(validSelection(), admissionInspection(), context))
      .toThrow(/conflicting reviewed RLS|distinct.*settings/i);
    expect(context).toEqual(before);
  });

  it("compiles trusted identity predicates and one opaque gate without a caller-selected record", () => {
    const reviewed = prepareReviewedReadCurrentStatePrerequisite(validSelection(), admissionInspection(), boundary);
    const quote = (identifier: string, engine: "postgres" | "mysql") =>
      engine === "postgres" ? `\"${identifier}\"` : `\`${identifier}\``;
    const placeholder = (index: number, engine: "postgres" | "mysql") => engine === "postgres" ? `$${index}` : "?";
    const params: Array<string | number | boolean | null> = [];
    const postgres = compileReadPrerequisitePredicate({
      prerequisite: reviewed,
      context: { tenant: "tenant-acme", principal: "student-1" },
      params,
      engine: "postgres",
      quote,
      placeholder,
    });
    expect(postgres.predicate).toContain("CURRENT_TIMESTAMP");
    expect(postgres.predicate).toContain("\"student_admissions\"");
    expect(params).toEqual(["tenant-acme", "student-1", "admitted"]);
    expect(postgres.compiled.gate_sql).toContain("__synapsor_prerequisite_satisfied");
    expect(postgres.compiled.gate_sql).not.toContain("student-1");

    const mysql = compileReadPrerequisiteGate({
      prerequisite: reviewed,
      context: { tenant: "tenant-acme", principal: "student-1" },
      engine: "mysql",
      quote,
      placeholder,
    });
    expect(mysql.gate_sql).toContain("@synapsor_read_prerequisite_now");
    expect(mysql.gate_params).toEqual(["tenant-acme", "student-1", "admitted"]);
  });

  it("retains a reviewed prerequisite across unrelated rescan metadata and blocks prerequisite drift", () => {
    const inspection = admissionInspection();
    const configuredTrustedContext: ConfiguredTrustedContextAuthority = {
      schema_version: CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION,
      provider: "environment" as const,
      tenant_binding: "institution_id",
      principal_binding: "student_id",
      tenant_env: "SYNAPSOR_TENANT_ID",
      principal_env: "SYNAPSOR_PRINCIPAL",
    };
    const overrides = seedConfiguredPrincipalBindingReview({
      inspection,
      principalBinding: "student_id",
      actor: "synthetic-reviewer",
      decidedAt: "2026-09-10T00:00:00.000Z",
    });
    const build = (current: SchemaInspection) => buildAutoBoundary({
      inspection: current,
      project: { root: "/tmp/synapsor-read-prerequisite-rescan", package_manager: "pnpm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] },
      sourceEnv: "DATABASE_URL",
      configuredTrustedContext,
      overrides,
    });
    const original = build(inspection);
    const previous = structuredClone(original.exploration_boundary);
    previous.read_prerequisite = prepareReviewedReadCurrentStatePrerequisite(validSelection(), inspection, previous);

    const unrelated = structuredClone(inspection);
    const audit = structuredClone(unrelated.tables[0]!);
    audit.name = "admission_audit";
    audit.primary_key = ["admission_id"];
    audit.unique_constraints = [{ name: "admission_audit_pkey", columns: ["admission_id"] }];
    unrelated.tables.push(audit);
    const retained = rebaseSavedBoundaryForRescan({
      generatedDraft: build(unrelated).exploration_boundary,
      previousCandidate: previous,
      boundaryName: previous.pack.name,
      inspection: unrelated,
    });
    expect(retained.read_prerequisite).toEqual(previous.read_prerequisite);
    expect(retained.pack.resources.some((resource) => resource.id === "public.admission_audit")).toBe(false);

    const writerPolicies = structuredClone(inspection);
    writerPolicies.tables[0]!.role_posture!.row_security_applicable_policies = ["admissions_scope"];
    writerPolicies.tables[0]!.row_level_security_policies!.push({
      name: "dedicated_writer_select", command: "SELECT", permissive: true,
      roles: ["dedicated_writer"], using_expression: "institution_id = current_setting('app.tenant')",
    });
    const before = structuredClone(previous);
    const refresh = (current: SchemaInspection, policies: string[] | undefined = ["admissions_scope"]) => rebaseSavedBoundaryForRescan({
      generatedDraft: build(current).exploration_boundary, previousCandidate: previous,
      boundaryName: previous.pack.name, inspection: current, previousPrerequisitePolicyNames: policies,
    });
    const refreshed = refresh(writerPolicies);
    expect(refreshed.read_prerequisite!.dependency.fingerprint).not.toBe(previous.read_prerequisite.dependency.fingerprint);
    expect({ ...refreshed.read_prerequisite, dependency: previous.read_prerequisite.dependency }).toEqual(previous.read_prerequisite);
    expect(refreshed.activation).toBe("disabled_unreviewed");
    assertReviewedReadCurrentStatePrerequisite(refreshed.read_prerequisite!, writerPolicies);
    expect(() => assertReviewedReadCurrentStatePrerequisite(previous.read_prerequisite!, writerPolicies)).toThrow(/changed/i);
    expect(previous).toEqual(before);
    expect(() => refresh(writerPolicies, [])).toThrow(/private current-state access condition/i);
    for (const mutate of [
      (table: SchemaInspection["tables"][number]) => { delete table.role_posture!.row_security_applicable_policies; },
      (table: SchemaInspection["tables"][number]) => { table.role_posture!.row_security_applicable_policies!.push("dedicated_writer_select"); },
      (table: SchemaInspection["tables"][number]) => { table.row_level_security_policies![1]!.roles = ["public"]; },
      (table: SchemaInspection["tables"][number]) => { table.row_level_security_policies![0]!.using_expression = "true"; },
      (table: SchemaInspection["tables"][number]) => { table.row_level_security_policies!.shift(); },
      (table: SchemaInspection["tables"][number]) => { table.role_posture!.row_security_forced = false; },
      (table: SchemaInspection["tables"][number]) => { table.columns.find(column => column.name === "status")!.enum_values = ["admitted", "withdrawn"]; },
    ]) {
      const changed = structuredClone(writerPolicies);
      mutate(changed.tables[0]!);
      expect(() => refresh(changed)).toThrow(/private current-state access condition/i);
    }

    const drifted = structuredClone(inspection);
    drifted.tables[0]!.columns.find((column) => column.name === "status")!.enum_values = ["admitted", "withdrawn"];
    expect(() => rebaseSavedBoundaryForRescan({
      generatedDraft: build(drifted).exploration_boundary,
      previousCandidate: previous,
      boundaryName: previous.pack.name,
      inspection: drifted,
    })).toThrow(/private current-state access condition.*no longer matches/i);
  });
});

function validSelection() {
  return {
    source: { schema: "public", table: "student_admissions" },
    subject: { tenant_column: "institution_id", principal_column: "student_id", unique_constraint: "student_admissions_subject_key" },
    current_state: {
      state_column: "status",
      positive_state: "admitted",
      effective_from_column: "effective_from",
      effective_until_column: "effective_until",
      interval: "[effective_from,effective_until)" as const,
      clock: "database_utc" as const,
    },
    semantic_consent: {
      source_description: "Registrar-maintained current admission record for one student at one institution.",
      positive_state_description: "Only admitted establishes current admission.",
      confirmed: true as const,
    },
  };
}

function admissionInspection(): SchemaInspection {
  return {
    engine: "postgres",
    server_version: "PostgreSQL 16",
    current_user: "reader",
    role_posture: { verified: true, superuser: false, bypass_rls: false, read_only: true, writable_relations: [], owned_relations: [], reasons: [] },
    inspected_at: "2026-09-10T00:00:00.000Z",
    schemas: ["public"],
    warnings: [],
    tables: [{
      schema: "public",
      name: "student_admissions",
      type: "table",
      writable: true,
      primary_key: ["admission_id"],
      unique_constraints: [{ name: "student_admissions_subject_key", columns: ["institution_id", "student_id"] }],
      foreign_keys: [],
      indexes: [],
      row_level_security: true,
      row_level_security_policies: [{ name: "admissions_scope", command: "SELECT", permissive: true, roles: ["reader"], using_expression: "institution_id = current_setting('app.tenant')" }],
      role_posture: {
        owner: "owner", current_role_is_owner: false, current_role_can_assume_owner: false,
        privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false },
        row_security_forced: true, row_security_effective_for_current_role: true,
      },
      columns: [
        column("admission_id", "uuid"),
        column("institution_id", "uuid"),
        column("student_id", "uuid"),
        column("status", "admission_status", ["admitted", "not_admitted", "withdrawn"]),
        column("effective_from", "timestamp with time zone"),
        column("effective_until", "timestamp with time zone"),
      ],
      suggestions: { tenant_columns: ["institution_id"], conflict_columns: [], sensitive_columns: [], default_visible_columns: [] },
    }],
  };
}

function column(name: string, data_type: string, enum_values?: string[]) {
  return {
    name,
    data_type,
    ...(enum_values ? { enum_values } : {}),
    nullable: false,
    generated: false,
    ordinal_position: 1,
    suggestions: { tenant: name === "institution_id", conflict: false, sensitive: false, immutable: false, large_or_binary: false },
  };
}
