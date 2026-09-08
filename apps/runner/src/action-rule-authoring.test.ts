import type { SchemaInspection, TableInfo } from "@synapsor-runner/schema-inspector";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import { buildAutoBoundary, persistGenerationLockSnapshot } from "./auto-boundary.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { rebindActionCatalogForReadPolicyRevision, buildActionCatalogForSavedReadRevision } from "./action-rule-read-revision.js";
import {
  actionRuleTypeForColumn,
  buildActionRuleAuthoringCatalog,
} from "./action-rule-authoring.js";

const lock = `sha256:${"a".repeat(64)}` as const;

describe("Action Rule authoring catalog", () => {
  it.each(["evidence", "schema", "role", "context", "missing_snapshot"])("binds final Read minimization through exact saved evidence without a wizard restart (%s)", async (change) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-action-evidence-rebind-"));
    try {
      const source = inspection();
      const build = buildAutoBoundary({ inspection: source, sourceEnv: "DATABASE_URL", inspectedSchema: "support",
        project: { root, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
      const catalog = buildActionRuleAuthoringCatalog({ boundary: build.exploration_boundary, inspection: source }).catalog;
      const nextLock = { ...structuredClone(build.lock), evidence_fingerprint: canonicalJsonDigest("new authoring evidence only") };
      if (change === "schema") nextLock.schema_fingerprint = canonicalJsonDigest("other schema");
      if (change === "role") nextLock.role_posture_fingerprint = canonicalJsonDigest("other role");
      if (change === "context") nextLock.trusted_context_fingerprint = canonicalJsonDigest("other identity source");
      const nextBoundary = { ...structuredClone(build.exploration_boundary), generation_lock_fingerprint: canonicalJsonDigest(nextLock) };
      if (change !== "missing_snapshot") await persistGenerationLockSnapshot(root, catalog.generation_lock_fingerprint, build.lock);
      await persistGenerationLockSnapshot(root, nextBoundary.generation_lock_fingerprint, nextLock);
      const original = structuredClone(catalog);
      const result = buildActionCatalogForSavedReadRevision({ projectRoot: root, catalog, nextBoundary, inspection: source });
      if (change === "evidence") {
        expect((await result).catalog).toEqual({ ...original, generation_lock_fingerprint: nextBoundary.generation_lock_fingerprint });
      } else await expect(result).rejects.toThrow();
      expect(catalog).toEqual(original);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json"))).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it.each(["labels", "schema", "role", "context", "missing_snapshot"])("rebinds only a proven Read-policy generation change (%s)", (change) => {
    const source = inspection();
    const build = buildAutoBoundary({ inspection: source, sourceEnv: "DATABASE_URL", inspectedSchema: "support",
      project: { root: "/tmp/read-revision-catalog-test", package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
    const previousLock = structuredClone(build.lock);
    const nextLock = { ...structuredClone(previousLock), reviewed_overrides_digest: canonicalJsonDigest("reviewed label") };
    if (change === "schema") nextLock.schema_fingerprint = canonicalJsonDigest("changed schema");
    if (change === "role") nextLock.role_posture_fingerprint = canonicalJsonDigest("changed role");
    if (change === "context") nextLock.trusted_context_fingerprint = canonicalJsonDigest("changed identity binding");
    const nextBoundary = { ...structuredClone(build.exploration_boundary), generation_lock_fingerprint: canonicalJsonDigest(nextLock) };
    const catalog = buildActionRuleAuthoringCatalog({ boundary: build.exploration_boundary, inspection: source }).catalog;
    const original = structuredClone(catalog);
    if (change === "missing_snapshot") previousLock.reviewed_overrides_digest = canonicalJsonDigest("not this prior revision");
    const rebind = () => rebindActionCatalogForReadPolicyRevision({ catalog, previousLock, nextLock, nextBoundary });
    if (change === "labels") expect(rebind()).toEqual({ ...original, generation_lock_fingerprint: nextBoundary.generation_lock_fingerprint });
    else expect(rebind).toThrow("ACTION_RULE_REVISION_STALE");
    expect(catalog).toEqual(original);
  });
  it("retains every component of an inspected composite key without changing Read exposure", () => {
    const source = inspection();
    const fk = source.tables[1]!.foreign_keys[0]!;
    fk.columns = ["tenant_id", "account_id"];
    fk.referenced_columns = ["tenant_id", "account_id"];
    const read = boundary();
    const original = structuredClone(read);
    const result = buildActionRuleAuthoringCatalog({ boundary: read, inspection: source });
    expect(result.catalog.relationships[0]).toEqual({ name: "refund_account_fk",
      from_resource: "support.refund_requests", to_resource: "support.accounts",
      field_pairs: [{ local_field: "tenant_id", target_field: "tenant_id" }, { local_field: "account_id", target_field: "account_id" }],
      cardinality: "many_to_one", nullable: false, target_unique: true });
    expect(read).toEqual(original);
    fk.referenced_columns.reverse();
    const reordered = buildActionRuleAuthoringCatalog({ boundary: read, inspection: source });
    expect(reordered.authoring.digest).not.toBe(result.authoring.digest);
  });

  it.each(["nonunique", "partial", "expression", "unusable", "unverified"])("refuses %s target proof with an actionable capability diagnostic", (kind) => {
    const source = inspection();
    const target = source.tables[0]!;
    target.primary_key = [];
    target.unique_constraints = [];
    target.indexes = [{ name: "not_a_proof", unique: kind !== "nonunique", columns: ["account_id"],
      catalog_key_columns: kind === "expression" ? ["account_id", ""] : ["account_id"],
      catalog_usable: kind !== "unusable", catalog_partial: kind === "partial" }];
    if (kind === "unverified") delete target.indexes[0]!.catalog_usable;
    const result = buildActionRuleAuthoringCatalog({ boundary: boundary(), inspection: source });
    expect(result.catalog.relationships).toEqual([]);
    expect(result.authoring.diagnostics).toContainEqual(expect.objectContaining({
      relationship: "refund_account_fk", target_resource: "support.accounts", code: "ACTION_RULE_RELATIONSHIP_UNBOUNDED" }));
  });

  it("rejects incomplete or duplicated composite metadata instead of dropping a key", () => {
    const source = inspection();
    source.tables[1]!.foreign_keys[0]!.columns.push("tenant_id");
    const result = buildActionRuleAuthoringCatalog({ boundary: boundary(), inspection: source });
    expect(result.catalog.relationships).toHaveLength(0);
    expect(result.authoring.diagnostics).toContainEqual(expect.objectContaining({ code: "ACTION_RULE_RELATIONSHIP_KEY_UNSUPPORTED" }));
  });

  it.each(["unvalidated_foreign_key", "non_exact_collation"] as const)("reports %s as a capability limit, not a missing permission", (issue) => {
    const source = inspection();
    source.tables[1]!.foreign_keys[0]!.action_rule_issue = issue;
    const result = buildActionRuleAuthoringCatalog({ boundary: boundary(), inspection: source });
    expect(result.catalog.relationships).toHaveLength(0);
    expect(result.authoring.diagnostics).toContainEqual(expect.objectContaining({ code: "ACTION_RULE_RELATIONSHIP_PROOF_UNSUPPORTED" }));
  });

  it("separates model-visible, Runner-only, and guard fields without reading values", () => {
    const result = buildActionRuleAuthoringCatalog({
      boundary: boundary(),
      inspection: inspection(),
    });

    expect(result.catalog.resources.map((resource) => resource.name))
      .toEqual(["support.accounts", "support.refund_requests"]);
    expect(result.catalog.relationships).toEqual([expect.objectContaining({
      name: "refund_account_fk",
      from_resource: "support.refund_requests",
      to_resource: "support.accounts",
      cardinality: "many_to_one",
      target_unique: true,
    })]);
    const refunds = result.authoring.resources.find((resource) =>
      resource.name === "support.refund_requests")!;
    expect(refunds).toMatchObject({
      tenant_scope: "direct",
      principal_scope: "direct",
      selected_version_field: "version",
      operations: { update: true, insert: true },
    });
    expect(refunds.fields.find((field) => field.name === "amount_cents")).toMatchObject({
      role: "model_visible",
      writable: true,
      type: { kind: "integer", unit: "minor_currency_units" },
    });
    expect(refunds.fields.find((field) => field.name === "risk_score")).toMatchObject({
      role: "runner_verification_only",
      writable: true,
    });
    expect(refunds.fields.find((field) => field.name === "tenant_id")).toMatchObject({
      role: "guard",
      writable: false,
    });
    expect(result.catalog.resources[1]!.fields.map((field) => field.name))
      .not.toContain("raw_payload");
    expect(result.authoring.diagnostics).toContainEqual(expect.objectContaining({
      code: "ACTION_RULE_FIELD_TYPE_UNSUPPORTED",
      resource: "support.refund_requests",
      field: "raw_payload",
    }));
    expect(result.authoring.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("does not guess a version field or unsafe insert identity", () => {
    const source = inspection();
    const refunds = source.tables.find((table) => table.name === "refund_requests")!;
    refunds.suggestions.conflict_columns = ["version", "updated_version"];
    refunds.columns.push(column("updated_version", "integer"));
    refunds.columns.find((item) => item.name === "refund_id")!.identity = true;
    const result = buildActionRuleAuthoringCatalog({ boundary: boundary(), inspection: source });
    const authoring = result.authoring.resources.find((resource) =>
      resource.name === "support.refund_requests")!;
    expect(authoring.selected_version_field).toBeUndefined();
    expect(authoring.operations).toEqual({ update: false, insert: false });
    expect(authoring.version_candidates).toEqual(["updated_version", "version"]);
  });

  it("uses a conventional integer version when the only alternative is a timestamp freshness hint", () => {
    const source = inspection();
    const refunds = source.tables.find((table) => table.name === "refund_requests")!;
    refunds.suggestions.conflict_columns = ["updated_at", "version"];
    refunds.columns.push(column("updated_at", "timestamp with time zone"));

    const result = buildActionRuleAuthoringCatalog({ boundary: boundary(), inspection: source });
    const authoring = result.authoring.resources.find((resource) =>
      resource.name === "support.refund_requests")!;

    expect(authoring.selected_version_field).toBe("version");
    expect(authoring.operations.update).toBe(true);
  });

  it("retains an Action-only resource when the Read Boundary was minimized later", () => {
    const fullBoundary = boundary();
    const source = inspection();
    const original = buildActionRuleAuthoringCatalog({
      boundary: fullBoundary,
      inspection: source,
    });
    const minimized = structuredClone(fullBoundary);
    minimized.pack.resources = minimized.pack.resources.filter((resource) =>
      resource.id === "support.accounts");

    const revision = buildActionRuleAuthoringCatalog({
      boundary: minimized,
      inspection: source,
      retainedCatalog: original.catalog,
    });

    expect(revision.catalog.resources.map((resource) => resource.name)).toEqual([
      "support.accounts",
      "support.refund_requests",
    ]);
    expect(revision.catalog.relationships).toContainEqual(expect.objectContaining({
      name: "refund_account_fk",
      from_resource: "support.refund_requests",
      to_resource: "support.accounts",
    }));
    expect(revision.authoring.resources.find((resource) =>
      resource.name === "support.refund_requests")).toMatchObject({
      operations: { update: true, insert: true },
      fields: expect.arrayContaining([
        expect.objectContaining({
          name: "amount_cents",
          role: "runner_verification_only",
          writable: true,
        }),
      ]),
    });
  });

  it("refuses a retained Action catalog from a different inspected schema revision", () => {
    const fullBoundary = boundary();
    const original = buildActionRuleAuthoringCatalog({
      boundary: fullBoundary,
      inspection: inspection(),
    });
    const changed = structuredClone(fullBoundary);
    changed.generation_lock_fingerprint = `sha256:${"b".repeat(64)}`;

    expect(() => buildActionRuleAuthoringCatalog({
      boundary: changed,
      inspection: inspection(),
      retainedCatalog: original.catalog,
    })).toThrow(/ACTION_RULE_REVISION_STALE/);
  });

  it("maps only portable bounded scalar types", () => {
    expect(actionRuleTypeForColumn(column("enabled", "boolean"))).toEqual({ kind: "boolean" });
    expect(actionRuleTypeForColumn(column("wait_minutes", "integer")))
      .toEqual({ kind: "integer", unit: "minutes" });
    expect(actionRuleTypeForColumn(column("status", "USER-DEFINED", ["open", "closed"])))
      .toEqual({ kind: "string", max_length: 6, enum: ["closed", "open"], comparison: "exact" });
    expect(actionRuleTypeForColumn(column("note", "text")))
      .toEqual({ kind: "string", max_length: 4096, comparison: "exact" });
    expect(actionRuleTypeForColumn(column("ratio", "numeric"))).toBeUndefined();
    expect(actionRuleTypeForColumn(column("payload", "jsonb"))).toBeUndefined();
  });
});

function boundary(): ExplorationBoundaryDraft {
  const resource = (
    id: string,
    fields: string[],
    keptOut: string[],
    relationships: ExplorationBoundaryDraft["pack"]["resources"][number]["relationships"] = [],
  ): ExplorationBoundaryDraft["pack"]["resources"][number] => {
    const [schema, table] = id.split(".") as [string, string];
    return {
      id,
      schema,
      table,
      primary_key: table === "accounts" ? "account_id" : "refund_id",
      tenant_key: "tenant_id",
      principal_key: "principal_id",
      field_types: Object.fromEntries(fields.map((field) => [field, "text"])),
      field_enums: {},
      selectable_fields: fields.filter((field) => !keptOut.includes(field)),
      filterable_fields: {},
      sortable_fields: [],
      groupable_fields: [],
      aggregate_measures: [],
      count_distinct_fields: [],
      time_bucket_fields: {},
      kept_out_fields: keptOut,
      relationships,
      minimum_cohort_size: 5,
      suppression_aware_totals: true,
    };
  };
  return {
    schema_version: "synapsor.exploration-boundary.v1",
    activation: "disabled_unreviewed",
    deployment_profile: "production",
    source: "local_postgres",
    compiler_version: "test",
    spec_version: "test",
    trusted_context: {
      provider: "environment",
      tenant_env: "SYNAPSOR_TENANT_ID",
      principal_env: "SYNAPSOR_PRINCIPAL",
    },
    generation_lock_fingerprint: lock,
    role_posture_fingerprint: `sha256:${"b".repeat(64)}`,
    pack: {
      name: "support_read",
      resources: [
        resource("support.accounts", ["account_id", "tenant_id", "principal_id", "status", "version"], []),
        resource(
          "support.refund_requests",
          ["refund_id", "tenant_id", "principal_id", "account_id", "amount_cents", "reason", "risk_score", "version", "raw_payload"],
          ["risk_score", "raw_payload"],
          [{
            id: "refund_account_fk",
            target_resource: "support.accounts",
            local_columns: ["account_id"],
            target_columns: ["account_id"],
            counted_entity: "account_id",
            cardinality: "many_to_one",
            max_fan_out: 1,
          }],
        ),
      ],
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

function inspection(): SchemaInspection {
  return {
    engine: "postgres",
    server_version: "PostgreSQL 16",
    current_user: "support_reader",
    inspected_at: "2026-09-03T00:00:00.000Z",
    schemas: ["support"],
    warnings: [],
    tables: [
      table("accounts", [
        column("account_id", "character varying(64)"),
        column("tenant_id", "character varying(64)"),
        column("principal_id", "character varying(64)"),
        column("status", "USER-DEFINED", ["active", "closed"]),
        column("version", "integer"),
      ], []),
      table("refund_requests", [
        column("refund_id", "character varying(64)"),
        column("tenant_id", "character varying(64)"),
        column("principal_id", "character varying(64)"),
        column("account_id", "character varying(64)"),
        column("amount_cents", "integer"),
        column("reason", "USER-DEFINED", ["billing_error", "duplicate_charge"]),
        column("risk_score", "integer"),
        column("version", "integer"),
        column("raw_payload", "jsonb"),
      ], [{
        name: "refund_account_fk",
        columns: ["account_id"],
        referenced_schema: "support",
        referenced_table: "accounts",
        referenced_columns: ["account_id"],
        delete_rule: "RESTRICT",
      }]),
    ],
  };
}

function table(
  name: string,
  columns: TableInfo["columns"],
  foreignKeys: TableInfo["foreign_keys"],
): TableInfo {
  return {
    schema: "support",
    name,
    type: "table",
    writable: true,
    columns,
    primary_key: [name === "accounts" ? "account_id" : "refund_id", "tenant_id"],
    unique_constraints: name === "accounts"
      ? [{ name: "accounts_account_id_key", columns: ["account_id"] }]
      : [],
    foreign_keys: foreignKeys,
    indexes: [],
    suggestions: {
      tenant_columns: ["tenant_id"],
      conflict_columns: ["version"],
      sensitive_columns: [],
      default_visible_columns: columns.map((item) => item.name),
    },
  };
}

function column(name: string, dataType: string, enumValues: string[] = []): TableInfo["columns"][number] {
  return {
    name,
    data_type: dataType,
    ...(enumValues.length ? { enum_values: enumValues } : {}),
    nullable: false,
    generated: false,
    identity: false,
    ordinal_position: 1,
    suggestions: {
      tenant: name === "tenant_id",
      conflict: name === "version",
      sensitive: false,
      immutable: ["account_id", "refund_id", "tenant_id", "principal_id"].includes(name),
      large_or_binary: dataType === "jsonb",
    },
  };
}
