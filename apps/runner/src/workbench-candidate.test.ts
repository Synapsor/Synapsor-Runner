import { describe, expect, it } from "vitest";
import {
  EXPLORATION_BOUNDARY_VERSION,
  type ExplorationBoundaryDraft,
} from "./auto-boundary.js";
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

  it("makes the instant-development candidate one-resource and relationship-free without widening fields", () => {
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
    expect(candidate.pack.resources).toHaveLength(1);
    expect(candidate.pack.resources[0]?.relationships).toEqual([]);
    const original = draft.pack.resources.find((item) => item.id === candidate.pack.resources[0]?.id)!;
    expect(candidate.pack.resources[0]?.selectable_fields.every(
      (field) => original.selectable_fields.includes(field),
    )).toBe(true);
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
