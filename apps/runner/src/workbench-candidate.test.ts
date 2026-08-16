import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  EXPLORATION_BOUNDARY_VERSION,
  type ExplorationBoundaryDraft,
} from "./auto-boundary.js";
import { recommendedBoundaryReviewCandidate } from "./boundary-candidate.js";
import { buildInstantFirstValue } from "./instant-first-value.js";
import { instantWorkbenchCandidate, recommendedWorkbenchCandidate } from "./local-ui.js";

describe("recommended Workbench starter pack", () => {
  it("keeps a strong analytical anchor with its reviewed dimensions", () => {
    const draft = boundary([
      resource("solar_incidents", {
        principal: true,
        measures: ["downtime_minutes", "energy_loss_wh"],
        relationships: [
          relationship("incidents_region", "regions"),
          relationship("incidents_model", "inverter_models"),
        ],
      }),
      resource("regions", { groups: ["name"] }),
      resource("inverter_models", { groups: ["model_name"] }),
      resource("unrelated_assignments", {
        principal: true,
        measures: ["amount_cents"],
      }),
    ]);

    const candidate = recommendedWorkbenchCandidate(draft);

    expect(candidate.pack.resources.map((item) => item.id)).toEqual(expect.arrayContaining([
      "public.inverter_models",
      "public.regions",
      "public.solar_incidents",
    ]));
    expect(candidate.pack.resources).toHaveLength(3);
    expect(candidate.pack.resources.find((item) => item.id === "public.solar_incidents")?.relationships)
      .toHaveLength(2);
    expect(candidate.unresolved_decisions).toEqual(expect.arrayContaining([
      expect.stringContaining("incidents_region"),
      expect.stringContaining("incidents_model"),
    ]));
    expect(candidate).toEqual(recommendedBoundaryReviewCandidate(draft));
  });

  it("keeps a blocked-only draft inspectable without inventing activatable authority", () => {
    const draft = boundary([]);

    expect(recommendedBoundaryReviewCandidate(draft)).toEqual(draft);
    expect(recommendedWorkbenchCandidate(draft)).toEqual(draft);
  });

  it("never widens the requested starter-pack bound", () => {
    const draft = boundary([
      resource("events", {
        relationships: [
          relationship("events_region", "regions"),
          relationship("events_category", "categories"),
        ],
      }),
      resource("regions"),
      resource("categories"),
    ]);

    const candidate = recommendedWorkbenchCandidate(draft, 2);

    expect(candidate.pack.resources).toHaveLength(2);
    expect(candidate.pack.resources.find((item) => item.id === "public.events")?.relationships)
      .toHaveLength(1);
  });

  it("keeps every proposed relationship inside the selected starter pack", () => {
    const draft = boundary([
      resource("facts", {
        principal: true,
        measures: ["amount_cents"],
        relationships: [
          relationship("facts_region", "regions"),
          relationship("facts_category", "categories"),
          relationship("facts_owner", "owners"),
          relationship("facts_account", "accounts"),
        ],
      }),
      resource("regions", {
        relationships: [relationship("regions_account", "accounts")],
      }),
      resource("categories"),
      resource("owners"),
      resource("accounts"),
    ]);

    const candidate = recommendedWorkbenchCandidate(draft, 3);
    const selected = new Set(candidate.pack.resources.map((item) => item.id));

    expect(candidate.pack.resources).toHaveLength(3);
    for (const item of candidate.pack.resources) {
      expect(item.relationships.every((link) => selected.has(link.target_resource))).toBe(true);
    }
  });

  it("drops a depth-two path when its bridge is outside the selected starter pack", () => {
    const draft = boundary([
      resource("refunds", {
        principal: true,
        measures: ["amount_cents"],
        relationships: [depthTwoRelationship(
          "refunds_order__orders_customer",
          "refunds",
          "orders",
          "customers",
        )],
      }),
      resource("customers", { groups: ["region"] }),
      resource("orders", { groups: [] }),
      resource("unrelated", { groups: [] }),
    ]);
    draft.budgets.max_relationship_hops = 2;

    const recommended = recommendedWorkbenchCandidate(draft, 2);
    const instant = instantWorkbenchCandidate(draft);

    expect(recommended.pack.resources.map((item) => item.id)).not.toContain("public.orders");
    expect(recommended.pack.resources.find((item) => item.id === "public.refunds")?.relationships)
      .toEqual([]);
    expect(instant.pack.resources.map((item) => item.id)).not.toContain("public.orders");
    const instantResources = new Set(instant.pack.resources.map((item) => item.id));
    for (const item of instant.pack.resources) {
      for (const relationship of item.relationships) {
        expect(relationship.proof?.links.every((link) =>
          instantResources.has(link.source_resource)
          && instantResources.has(link.target_resource))).not.toBe(false);
      }
    }
  });

  it("makes the instant-development candidate a bounded connected pack without widening fields", () => {
    const draft = boundary([
      resource("events", {
        relationships: [
          relationship("events_region", "regions"),
          relationship("events_category", "categories"),
        ],
      }),
      resource("regions"),
      resource("categories"),
    ]);

    const candidate = instantWorkbenchCandidate(draft);

    expect(candidate.deployment_profile).toBe("development");
    expect(candidate.pack.resources).toHaveLength(3);
    expect(candidate.pack.resources[0]).toMatchObject({
      id: "public.events",
      relationships: expect.arrayContaining([
        expect.objectContaining({ id: "events_region" }),
        expect.objectContaining({ id: "events_category" }),
      ]),
    });
    for (const selected of candidate.pack.resources) {
      const original = draft.pack.resources.find((item) => item.id === selected.id)!;
      expect(selected.selectable_fields.every(
        (field) => original.selectable_fields.includes(field),
      )).toBe(true);
    }
    const firstValue = buildInstantFirstValue(candidate);
    expect(firstValue).toMatchObject({
      question: "Which statuses have the most events?",
      operation: "Count events and group them by reviewed status",
      plan: {
        kind: "aggregate",
        resource: "public.events",
        measures: [{ function: "count" }],
        dimensions: [{ field: "status" }],
        top_n: 10,
      },
      maximum_groups: 10,
      minimum_cohort_size: 3,
    });
    expect(firstValue.plan).not.toHaveProperty("time_bucket");
    expect(firstValue.plan).not.toHaveProperty("where");
    expect(firstValue.plan).not.toHaveProperty("comparison");
  });

  it("selects a useful fact, bridge, and reviewed dimensions without pulling an unrelated table", () => {
    const draft = boundary([
      resource("customers", { groups: ["region"] }),
      resource("order_items", {
        measures: ["quantity"],
        groups: [],
        relationships: [
          relationship("items_order", "orders"),
          relationship("items_product", "products"),
        ],
      }),
      resource("orders", {
        measures: ["total_cents"],
        groups: ["channel"],
        relationships: [
          relationship("orders_customer", "customers"),
          relationship("orders_organization", "organizations"),
        ],
      }),
      resource("products", { groups: ["category"] }),
      resource("refunds", {
        measures: ["amount_cents"],
        groups: ["reason"],
        relationships: [
          relationship("refunds_order", "orders"),
          relationship("refunds_organization", "organizations"),
        ],
      }),
      resource("organizations", { groups: [] }),
      resource("unrelated_admin_log", { groups: ["action"] }),
    ]);

    const candidate = instantWorkbenchCandidate(draft);
    expect(candidate.pack.resources.map((item) => item.id)).toEqual([
      "public.orders",
      "public.refunds",
      "public.order_items",
      "public.customers",
      "public.products",
    ]);
    expect(candidate.pack.resources.map((item) => item.id))
      .not.toContain("public.unrelated_admin_log");
    expect(candidate.pack.resources.map((item) => item.id))
      .not.toContain("public.organizations");
    expect(candidate.pack.resources.flatMap((item) => item.relationships).every((relationship) =>
      candidate.pack.resources.some((item) => item.id === relationship.target_resource)))
      .toBe(true);
    expect(buildInstantFirstValue(candidate)).toMatchObject({
      resource: "public.orders",
      question: "How did order totals change by week?",
      plan: {
        measures: [{ function: "sum", field: "total_cents" }],
        time_bucket: { field: "occurred_at", bucket: "week" },
      },
    });
  });

  it("prefers an executable tenant-only first value over a principal-scoped resource", () => {
    const draft = boundary([
      resource("trainer_members", {
        principal: true,
        measures: ["lifetime_value_cents"],
        relationships: [relationship("members_region", "regions")],
      }),
      resource("check_ins", {
        groups: ["status"],
      }),
      resource("regions", {
        groups: ["name"],
      }),
    ]);

    const candidate = instantWorkbenchCandidate(draft);

    expect(candidate.pack.resources).toHaveLength(1);
    expect(candidate.pack.resources[0]).toMatchObject({
      id: "public.check_ins",
      tenant_key: "tenant_id",
      relationships: [],
    });
    expect(candidate.pack.resources[0]).not.toHaveProperty("principal_key");
    expect(buildInstantFirstValue(candidate).principal_scope)
      .toBe("not required for this reviewed table");
  });

  it("keeps direct ancestors with a derived tenant and principal starter resource", () => {
    const events = resource("events", { principal: true, groups: [] });
    const items = resource("event_items", {
      measures: ["units"],
      groups: [],
      relationships: [relationship("event_items_event_id_fkey", "events")],
    });
    items.field_types.event_id = "integer";
    if (!items.selectable_fields.includes("event_id")) items.selectable_fields.push("event_id");
    items.filterable_fields.event_id = ["eq"];
    if (!items.sortable_fields.includes("event_id")) items.sortable_fields.push("event_id");
    delete items.tenant_key;
    items.tenant_scope = derivedScope("tenant_id");
    items.principal_scope = derivedScope("assigned_staff_id");

    const candidate = instantWorkbenchCandidate(boundary([items, events]));

    expect(candidate.pack.resources.map((item) => item.id)).toEqual([
      "public.events",
      "public.event_items",
    ]);
    expect(candidate.pack.resources.find((item) => item.id === "public.event_items"))
      .toMatchObject({
        tenant_scope: { ancestor_resource: "public.events" },
        principal_scope: { ancestor_resource: "public.events" },
      });
  });

  it("does not duplicate monetary words in a generated starter question", () => {
    const candidate = instantWorkbenchCandidate(boundary([
      resource("payments", { measures: ["amount_cents"] }),
    ]));

    expect(buildInstantFirstValue(candidate).question)
      .toBe("How did payment amount change by week?");
  });
});

function boundary(resources: ExplorationBoundaryDraft["pack"]["resources"]): ExplorationBoundaryDraft {
  return {
    schema_version: EXPLORATION_BOUNDARY_VERSION,
    activation: "disabled_unreviewed",
    deployment_profile: "staging",
    source: "DATABASE_URL",
    compiler_version: "test",
    spec_version: "test",
    trusted_context: {
      provider: "environment",
      tenant_env: "SYNAPSOR_TENANT_ID",
      principal_env: "SYNAPSOR_PRINCIPAL",
    },
    generation_lock_fingerprint: `sha256:${"a".repeat(64)}`,
    role_posture_fingerprint: `sha256:${"b".repeat(64)}`,
    pack: {
      name: "starter",
      resources,
    },
    budgets: {
      max_rows: 25,
      max_groups: 20,
      max_response_cells: 100,
      max_response_bytes: 16_384,
      statement_timeout_ms: 2_000,
      max_measures: 2,
      max_dimensions: 2,
      max_time_ranges: 2,
      max_relationship_hops: 1,
      max_top_n: 20,
      max_complexity: 20,
      max_queries_per_session: 20,
      max_extracted_cells_per_session: 1_000,
      max_differencing_queries: 5,
      rate_limit_per_minute: 20,
    },
    unresolved_decisions: [
      "deployment profile: confirm local authoring is development or staging",
      "trusted context: confirm tenant and principal are supplied outside model arguments",
      "database role: confirm read-only posture and row-security behavior",
      ...resources.flatMap((item) => [
        `${item.id}: confirm tenant key tenant_id`,
        `${item.id}: confirm visible and kept-out fields`,
        ...item.relationships.map((link) =>
          `${item.id}: review relationship ${link.id} cardinality and scope on ${link.target_resource}`),
      ]),
    ],
  };
}

function resource(
  table: string,
  options: {
    principal?: boolean;
    measures?: string[];
    groups?: string[];
    relationships?: ExplorationBoundaryDraft["pack"]["resources"][number]["relationships"];
  } = {},
): ExplorationBoundaryDraft["pack"]["resources"][number] {
  const measures = options.measures ?? [];
  const groups = options.groups ?? ["status"];
  const fields = [
    "id",
    "tenant_id",
    ...(options.principal ? ["assigned_staff_id"] : []),
    "occurred_at",
    ...measures,
    ...groups,
  ];
  return {
    id: `public.${table}`,
    schema: "public",
    table,
    primary_key: "id",
    tenant_key: "tenant_id",
    ...(options.principal ? { principal_key: "assigned_staff_id" } : {}),
    field_types: Object.fromEntries(fields.map((field) => [
      field,
      field.endsWith("_at") ? "timestamp with time zone" : field.endsWith("_minutes") || field.endsWith("_wh") || field.endsWith("_cents") ? "integer" : "text",
    ])),
    field_enums: {},
    selectable_fields: fields,
    filterable_fields: Object.fromEntries(fields.map((field) => [field, ["eq"]])),
    sortable_fields: fields,
    groupable_fields: groups,
    aggregate_measures: measures,
    count_distinct_fields: ["id"],
    time_bucket_fields: { occurred_at: ["day", "week", "month"] },
    kept_out_fields: [],
    relationships: options.relationships ?? [],
    rls_session: {
      tenant_setting: "app.tenant_id",
      ...(options.principal ? { principal_setting: "app.principal_id" } : {}),
    },
    minimum_cohort_size: 3,
    suppression_aware_totals: true,
  };
}

function relationship(
  id: string,
  targetTable: string,
): ExplorationBoundaryDraft["pack"]["resources"][number]["relationships"][number] {
  return {
    id,
    target_resource: `public.${targetTable}`,
    local_columns: [`${targetTable.replace(/s$/, "")}_id`],
    target_columns: ["id"],
    counted_entity: "event",
    cardinality: "many_to_one",
    max_fan_out: 1,
  };
}

function depthTwoRelationship(
  id: string,
  sourceTable: string,
  bridgeTable: string,
  targetTable: string,
): ExplorationBoundaryDraft["pack"]["resources"][number]["relationships"][number] {
  const link = (source: string, target: string, constraint: string) => ({
    constraint_name: constraint,
    source_resource: `public.${source}`,
    target_resource: `public.${target}`,
    source_columns: [`${target.replace(/s$/, "")}_id`],
    target_columns: ["id"],
    target_uniqueness: {
      kind: "primary_key" as const,
      name: `${target}_pkey`,
      columns: ["id"],
    },
    nullable: false,
    cardinality: "many_to_one" as const,
    max_fan_out: 1 as const,
  });
  return {
    id,
    target_resource: `public.${targetTable}`,
    local_columns: [`${bridgeTable.replace(/s$/, "")}_id`],
    target_columns: ["id"],
    counted_entity: sourceTable.replace(/s$/, ""),
    cardinality: "many_to_one",
    max_fan_out: 1,
    path_depth: 2,
    proof: {
      source: "database_catalog",
      digest: `sha256:${"d".repeat(64)}`,
      links: [
        link(sourceTable, bridgeTable, `${sourceTable}_${bridgeTable}_fkey`),
        link(bridgeTable, targetTable, `${bridgeTable}_${targetTable}_fkey`),
      ],
    },
  };
}

function derivedScope(ancestorColumn: string) {
  const links = [{
    constraint_name: "event_items_event_id_fkey",
    source_resource: "public.event_items",
    target_resource: "public.events",
    source_columns: ["event_id"],
    target_columns: ["id"],
    target_uniqueness: {
      kind: "primary_key" as const,
      name: "events_pkey",
      columns: ["id"],
    },
    nullable: false,
    cardinality: "many_to_one" as const,
    max_fan_out: 1 as const,
  }];
  return {
    mode: "derived" as const,
    path_id: "event_items_event_id_fkey",
    ancestor_resource: "public.events",
    ancestor_column: ancestorColumn,
    proof: {
      source: "database_catalog" as const,
      links,
      digest: canonicalJsonDigest(links),
    },
  };
}
