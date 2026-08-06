import type { SchemaInspection, TableInfo } from "@synapsor-runner/schema-inspector";
import { describe, expect, it } from "vitest";
import type { ActivatedExplorationBoundary, DerivedScopePath } from "./auto-boundary.js";
import { derivedScopeIndexDoctorChecks } from "./derived-scope-index-doctor.js";


describe("derived-scope index doctor", () => {
  it("confirms a proven path whose correlation, referenced key, and scope filter are indexed", () => {
    const boundary = boundaryWithTenantScope(oneHopScope());
    const inspection = inspectionWithTables("postgres", [
      table("order_items", [index("order_id"), index("id")]),
      table("orders", [index("id"), index("tenant_id")]),
    ]);

    const checks = evaluate(boundary, inspection);

    expect(checks).toEqual([expect.objectContaining({
      name: "derived-scope-indexes:complete",
      level: "pass",
      message: expect.stringContaining("All 1 reviewed derived-scope path is index-backed"),
    })]);
  });

  it("warns once with copyable PostgreSQL SQL when the child FK index is absent", () => {
    const boundary = boundaryWithTenantScope(oneHopScope());
    const inspection = inspectionWithTables("postgres", [
      table("order_items", [index("id")]),
      table("orders", [index("id"), index("tenant_id")]),
    ]);

    const checks = evaluate(boundary, inspection);

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ level: "warn", advisory: "warning", ok: true });
    expect(checks[0]!.message).toContain("public.order_items.order_id");
    expect(checks[0]!.message).toContain("public.order_items -> public.orders (tenant)");
    expect(checks[0]!.message).toContain('CREATE INDEX ON "public"."order_items" ("order_id");');
    expect(checks.some((check) => check.level === "fail")).toBe(false);
  });

  it("reports only the uncovered link in a two-hop path", () => {
    const scope = twoHopScope();
    const boundary = boundaryWithTenantScope(scope, "public.order_item_events");
    const inspection = inspectionWithTables("postgres", [
      table("order_item_events", [index("id"), index("order_item_id")]),
      table("order_items", [index("id")]),
      table("orders", [index("id"), index("tenant_id")]),
    ]);

    const checks = evaluate(boundary, inspection);

    expect(checks).toHaveLength(1);
    expect(checks[0]!.message).toContain("public.order_items.order_id");
    expect(checks[0]!.message).not.toContain("has no usable full index with order_item_id");
  });

  it("requires the FK to be the leading indexed column", () => {
    const boundary = boundaryWithTenantScope(oneHopScope());
    const parent = table("orders", [index("id"), index("tenant_id")]);
    const covered = table("order_items", [compositeIndex(["order_id", "created_at"]), index("id")]);
    const reversed = table("order_items", [compositeIndex(["created_at", "order_id"]), index("id")]);

    expect(evaluate(boundary, inspectionWithTables("postgres", [covered, parent])))
      .toContainEqual(expect.objectContaining({ name: "derived-scope-indexes:complete" }));
    expect(evaluate(boundary, inspectionWithTables("postgres", [reversed, parent])))
      .toContainEqual(expect.objectContaining({
        advisory: "warning",
        message: expect.stringContaining("public.order_items.order_id"),
      }));
  });

  it("renders missing terminal-filter coverage as a lower-severity note", () => {
    const boundary = boundaryWithTenantScope(oneHopScope());
    const inspection = inspectionWithTables("postgres", [
      table("order_items", [index("order_id"), index("id")]),
      table("orders", [index("id")]),
    ]);

    const checks = evaluate(boundary, inspection);

    expect(checks).toEqual([expect.objectContaining({
      advisory: "note",
      level: "warn",
      message: expect.stringContaining("public.orders.tenant_id"),
    })]);
  });

  it("uses MySQL catalog leading-column metadata and engine-correct SQL", () => {
    const boundary = boundaryWithTenantScope(oneHopScope(), "public.order_items", "mysql_source");
    const inspection = inspectionWithTables("mysql", [
      table("order_items", [index("id")]),
      table("orders", [index("id"), index("tenant_id")]),
    ]);

    const checks = evaluate(boundary, inspection, "mysql_source");

    expect(checks[0]!.message).toContain(
      "CREATE INDEX `idx_synapsor_order_items_order_id` ON `public`.`order_items` (`order_id`);",
    );
  });

  it("emits no derived-scope output for direct or unscoped resources", () => {
    const boundary = boundaryWithTenantScope(undefined);
    const inspection = inspectionWithTables("postgres", [
      table("orders", [index("id"), index("tenant_id")]),
    ]);

    expect(evaluate(boundary, inspection)).toEqual([]);
  });

  it("notes once when a derived-scope source has no live inspection", () => {
    const boundary = boundaryWithTenantScope(oneHopScope());

    const checks = derivedScopeIndexDoctorChecks({
      boundaries: [boundary],
      inspectionsBySource: new Map(),
    });

    expect(checks).toEqual([expect.objectContaining({
      name: "derived-scope-index:reviewed_orders:source-metadata",
      ok: true,
      level: "warn",
      advisory: "note",
      message: expect.stringContaining(
        "live catalog metadata for source analytics was unavailable, so 1 reviewed derived-scope path could not be attested",
      ),
    })]);
  });
});


function evaluate(
  boundary: ActivatedExplorationBoundary,
  inspection: SchemaInspection,
  source = "analytics",
) {
  return derivedScopeIndexDoctorChecks({
    boundaries: [boundary],
    inspectionsBySource: new Map([[source, [inspection]]]),
  });
}


function boundaryWithTenantScope(
  scope: DerivedScopePath | undefined,
  rootId = "public.order_items",
  source = "analytics",
): ActivatedExplorationBoundary {
  const resourceIds = new Set([
    "public.orders",
    rootId,
    ...scope?.proof.links.flatMap((link) => [link.source_resource, link.target_resource]) ?? [],
  ]);
  const resources = [...resourceIds].map((id) => {
    const [schema, tableName] = id.split(".");
    return {
      id,
      schema,
      table: tableName,
      primary_key: "id",
      ...(id === rootId && scope ? { tenant_scope: scope } : {}),
      ...(id === "public.orders" ? { tenant_key: "tenant_id" } : {}),
      field_types: {},
      field_enums: {},
      selectable_fields: [],
      filterable_fields: {},
      sortable_fields: [],
      groupable_fields: [],
      aggregate_measures: [],
      count_distinct_fields: [],
      time_bucket_fields: {},
      kept_out_fields: [],
      relationships: [],
      minimum_cohort_size: 5,
      suppression_aware_totals: true,
    };
  });
  return {
    source,
    pack: { name: "reviewed_orders", resources },
    activation: {
      state: "active",
      digest: `sha256:${"1".repeat(64)}`,
      actor: "operator",
      activated_at: "2026-08-05T00:00:00.000Z",
      generation_lock_fingerprint: `sha256:${"2".repeat(64)}`,
      reviewed_decisions: [],
    },
  } as unknown as ActivatedExplorationBoundary;
}


function oneHopScope(): DerivedScopePath {
  return {
    mode: "derived",
    path_id: "order_items_order_id_fkey",
    ancestor_resource: "public.orders",
    ancestor_column: "tenant_id",
    proof: {
      source: "database_catalog",
      digest: `sha256:${"3".repeat(64)}`,
      links: [{
        constraint_name: "order_items_order_id_fkey",
        source_resource: "public.order_items",
        target_resource: "public.orders",
        source_columns: ["order_id"],
        target_columns: ["id"],
        target_uniqueness: { kind: "primary_key", name: "orders_pkey", columns: ["id"] },
        nullable: false,
        cardinality: "many_to_one",
        max_fan_out: 1,
      }],
    },
  };
}


function twoHopScope(): DerivedScopePath {
  return {
    mode: "derived",
    path_id: "events_item_fkey__items_order_fkey",
    ancestor_resource: "public.orders",
    ancestor_column: "tenant_id",
    proof: {
      source: "database_catalog",
      digest: `sha256:${"4".repeat(64)}`,
      links: [
        {
          constraint_name: "events_item_fkey",
          source_resource: "public.order_item_events",
          target_resource: "public.order_items",
          source_columns: ["order_item_id"],
          target_columns: ["id"],
          target_uniqueness: { kind: "primary_key", name: "order_items_pkey", columns: ["id"] },
          nullable: false,
          cardinality: "many_to_one",
          max_fan_out: 1,
        },
        {
          constraint_name: "items_order_fkey",
          source_resource: "public.order_items",
          target_resource: "public.orders",
          source_columns: ["order_id"],
          target_columns: ["id"],
          target_uniqueness: { kind: "primary_key", name: "orders_pkey", columns: ["id"] },
          nullable: false,
          cardinality: "many_to_one",
          max_fan_out: 1,
        },
      ],
    },
  };
}


function inspectionWithTables(
  engine: "postgres" | "mysql",
  tables: TableInfo[],
): SchemaInspection {
  return {
    engine,
    server_version: "test",
    current_user: "reader",
    inspected_at: "2026-08-05T00:00:00.000Z",
    schemas: ["public"],
    tables,
    warnings: [],
  };
}


function table(name: string, indexes: TableInfo["indexes"]): TableInfo {
  return {
    schema: "public",
    name,
    type: "table",
    writable: false,
    columns: [],
    primary_key: ["id"],
    unique_constraints: [],
    foreign_keys: [],
    indexes,
    suggestions: {
      tenant_columns: name === "orders" ? ["tenant_id"] : [],
      conflict_columns: [],
      sensitive_columns: [],
      default_visible_columns: [],
    },
  };
}


function index(column: string): TableInfo["indexes"][number] {
  return {
    name: `${column}_idx`,
    columns: [column],
    catalog_key_columns: [column],
    catalog_leading_column: column,
    catalog_usable: true,
    catalog_partial: false,
  };
}


function compositeIndex(columns: string[]): TableInfo["indexes"][number] {
  return {
    name: `${columns.join("_")}_idx`,
    columns,
    catalog_key_columns: columns,
    catalog_leading_column: columns[0],
    catalog_usable: true,
    catalog_partial: false,
  };
}
