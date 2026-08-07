import { describe, expect, it } from "vitest";
import type {
  ActivatedExplorationBoundary,
  RelationshipLinkProof,
} from "./auto-boundary.js";
import {
  buildBoundaryCatalogDiagramExports,
  buildBoundaryCatalogModel,
  renderBoundaryCatalogAscii,
  renderBoundaryCatalogMermaid,
  renderBoundaryCatalogTopologyAscii,
} from "./boundary-catalog.js";

describe("active boundary catalog", () => {
  it("renders redacted connected paths and directional physical Mermaid joins", async () => {
    const model = buildBoundaryCatalogModel([activeBoundary()]);

    expect(model.table_count).toBe(3);
    expect(model.relationship_count).toBe(3);
    expect(model.physical_relationship_count).toBe(2);
    expect(model.boundaries[0]?.physical_relationship_count).toBe(2);
    expect(model.boundaries[0]?.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source_table: "public.orders",
        target_table: "public.customers",
        source_key: "[reviewed hidden join key]",
        target_key: "[reviewed hidden join key]",
        cardinality: "many_to_one",
        proven: true,
        path_depth: 1,
      }),
      expect.objectContaining({
        source_table: "public.invoices",
        target_table: "public.customers",
        cardinality: "many_to_one",
        proven: true,
        path_depth: 2,
        links: [
          expect.objectContaining({
            source_table: "public.invoices",
            target_table: "public.orders",
            source_key: "order_id",
            target_key: "id",
          }),
          expect.objectContaining({
            source_table: "public.orders",
            target_table: "public.customers",
            hidden_join_key: true,
          }),
        ],
        suggested_questions: expect.arrayContaining([
          "What is the total invoice amount by customer region?",
        ]),
      }),
    ]));
    expect(model.boundaries[0]?.tables.find((table) => table.id === "public.orders"))
      .toEqual(expect.objectContaining({
        runner_only_field_count: 1,
        kept_out_field_count: 1,
        outside_boundary_relationship_count: 1,
        reachable_tables: ["public.customers"],
        groupable_fields: ["status"],
        aggregate_measures: ["total_cents"],
      }));

    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain("customer_email");
    expect(serialized).not.toContain("secret_join");
    expect(serialized).not.toContain("public.outside");

    const ascii = renderBoundaryCatalogAscii(model, { width: 88 });
    expect(ascii).toContain("3 tables | 2 physical joins | 3 reviewed paths");
    expect(ascii).toContain("TABLES AND REVIEWED ANALYSIS");
    expect(ascii).toContain("REVIEWED RELATIONSHIP MAP");
    expect(ascii).toContain("order_id -> [public.orders].id");
    expect(ascii).toContain("[public.orders]");
    expect(ascii).toContain("[public.customers]");
    expect(ascii).toContain("[many-to-one, proven, 2 joins]");
    expect(ascii).toContain("TRY CROSS-TABLE QUESTIONS");
    expect(ascii).toContain('"What is the total invoice amount by customer region?"');
    expect(ascii).not.toContain("secret_join");
    expect(ascii.split("\n").every((line) => line.length <= 88)).toBe(true);

    const topology = renderBoundaryCatalogTopologyAscii(model, { width: 88 });
    expect(topology).toContain("REVIEWED JOIN TOPOLOGY");
    expect(topology).toContain("public.invoices");
    expect(topology).toContain("order_id -> id");
    expect(topology).toContain("public.orders");
    expect(topology).toContain("[reviewed hidden join key] -> [reviewed hidden join key]");
    expect(topology).toContain("public.customers");
    expect(topology).toContain("1 reviewed multi-join path is composed from the arrows above");
    expect(topology).not.toContain("secret_join");
    expect(topology.split("\n").every((line) => line.length <= 88)).toBe(true);

    const diagram = renderBoundaryCatalogMermaid(model);
    expect(diagram).toContain("flowchart LR");
    expect(diagram).toContain("PUBLIC_INVOICES -->");
    expect(diagram).toContain("PUBLIC_ORDERS -->");
    expect(diagram).not.toMatch(/PUBLIC_INVOICES\s+-->[^\n]+PUBLIC_CUSTOMERS/);
    expect(diagram).toContain("1 Runner-only field");
    expect(diagram).toContain("1 kept-out field");
    expect(diagram).not.toContain("customer_email");
    expect(diagram).not.toContain("secret_join");
    expect(diagram).not.toContain("public.outside");

    const exports = buildBoundaryCatalogDiagramExports(model, { width: 88 });
    expect(exports).toEqual([
      expect.objectContaining({
        boundary_name: "reviewed_staging",
        digest: `sha256:${"a".repeat(64)}`,
        file_name: "reviewed_staging-aaaaaaaaaaaa.boundary-diagram.md",
        large: false,
        mermaid: diagram,
      }),
    ]);
    expect(exports[0]!.markdown).toContain("# Reviewed Boundary: reviewed_staging");
    expect(exports[0]!.markdown).toContain("## Readable Map");
    expect(exports[0]!.markdown).toContain("## Mermaid Relationship Diagram");
    expect(exports[0]!.markdown).not.toContain("customer_email");

    const terminalExport = buildBoundaryCatalogDiagramExports(model, {
      width: 88,
      includeMermaid: false,
    })[0]!;
    expect(terminalExport.markdown).toContain("## Readable Map");
    expect(terminalExport.markdown).toContain("The reviewed joins are shown in the readable map above.");
    expect(terminalExport.markdown).not.toMatch(/mermaid/i);
  });

  it("separates Runner-only analytical fields from ordinary model-visible capabilities", () => {
    const boundary = activeBoundary();
    const orders = boundary.pack.resources.find((resource) => resource.id === "public.orders")!;
    orders.field_types.risk_band = "text";
    orders.selectable_fields.push("risk_band");
    orders.groupable_fields.push("risk_band");
    orders.count_distinct_fields.push("risk_band");
    orders.model_withheld_fields = [...(orders.model_withheld_fields ?? []), "risk_band"];

    const model = buildBoundaryCatalogModel([boundary]);
    const table = model.boundaries[0]!.tables.find((candidate) =>
      candidate.id === "public.orders")!;
    expect(table.groupable_fields).toEqual(["status"]);
    expect(table.count_distinct_fields).toEqual(["id"]);
    expect(table.runner_only_analysis).toMatchObject({
      groupable_fields: ["risk_band"],
      count_distinct_fields: ["risk_band"],
    });

    const ascii = renderBoundaryCatalogAscii(model);
    expect(ascii).toContain("Can analyze: record counts; totals/averages of total_cents; unique counts of id; group by");
    expect(ascii).toContain("status; day/week/month using created_at");
    expect(ascii).toContain("Runner-only analysis: unique counts of risk_band (raw values withheld); group by");
    expect(ascii).toContain("group by risk_band");
    expect(ascii).toContain("(labels tokenized)");
    expect(renderBoundaryCatalogMermaid(model)).not.toContain("risk_band");
  });

  it("turns a one-table boundary into a useful analysis map instead of an empty join diagram", async () => {
    const boundary = activeBoundary();
    const orders = boundary.pack.resources.find((resource) => resource.id === "public.orders")!;
    orders.relationships = [];
    boundary.pack.resources = [orders];
    const model = buildBoundaryCatalogModel([boundary]);
    const ascii = renderBoundaryCatalogAscii(model);

    expect(ascii).toContain("1 table | 0 physical joins | 0 reviewed paths");
    expect(ascii).toContain("No join arrows are shown because this reviewed boundary contains one table");
    expect(ascii).toContain("TRY SINGLE-TABLE QUESTIONS");
    expect(ascii).toContain('"What is the total order value by order status?"');
    expect(ascii).toContain("/access -> highlight reviewed_staging -> Enter -> A Add related tables -> C Review + activate");
    expect(ascii).not.toContain("no outgoing reviewed path");
    expect(ascii).not.toContain('"undefined"');
    expect(ascii).not.toContain("total id");

    const mermaidDiagram = renderBoundaryCatalogMermaid(model);
    expect(mermaidDiagram).not.toContain("--");
    const exported = buildBoundaryCatalogDiagramExports(model)[0]!;
    expect(exported.markdown).toContain("## Relationships");
    expect(exported.markdown).toContain("no reviewed join to draw");
    expect(exported.markdown).not.toContain("```mermaid");
  });

  it("emits safe directional Mermaid for collisions, special identifiers, disconnected nodes, and nullable links", () => {
    const first = activeBoundary();
    const second = structuredClone(first);
    first.pack.name = "north-prod";
    second.pack.name = "north_prod";
    const model = buildBoundaryCatalogModel([first, second]);
    const firstBoundary = model.boundaries[0]!;
    const firstTable = firstBoundary.tables[0]!;
    firstTable.id = "billing.order-items";
    firstTable.model_visible_fields = [
      { name: "status-code", data_type: "character varying(255)" },
      { name: "status code", data_type: "text" },
      { name: "2fa", data_type: "boolean" },
    ];
    firstBoundary.relationships = [{
      ...firstBoundary.relationships[0]!,
      source_table: firstBoundary.tables[1]!.id,
      target_table: firstTable.id,
      source_key: "customer \"key\"",
      target_key: "order:id",
      nullable: true,
      links: [{
        source_table: firstBoundary.tables[1]!.id,
        target_table: firstTable.id,
        source_key: "customer \"key\"",
        target_key: "order:id",
        hidden_join_key: false,
        proven: false,
        nullable: true,
      }],
    }];
    firstBoundary.physical_relationship_count = 1;
    model.relationship_count = model.boundaries.reduce((total, boundary) => total + boundary.relationships.length, 0);
    model.physical_relationship_count = model.boundaries.reduce((total, boundary) => total + boundary.physical_relationship_count, 0);

    const combined = renderBoundaryCatalogMermaid(model);
    expect(combined).toContain("flowchart LR");
    expect(combined).toContain("billing.order-items");
    expect(combined).toContain("status-code");
    expect(combined).toContain("status code");
    expect(combined).toContain("-.->");
    expect(combined).toContain("nullable");
    expect(new Set([...combined.matchAll(/^\s{2}([A-Z0-9_]+)\["/gm)].map((match) => match[1])).size)
      .toBe(model.table_count);
    for (const item of buildBoundaryCatalogDiagramExports(model)) {
      expect(item.mermaid).toContain("flowchart LR");
      expect(item.mermaid).not.toMatch(/[\r\n].*(?:<script|javascript:)/i);
    }
  });

  it("lays out arbitrary schemas with chains, fan-in, disconnected tables, and narrow terminals", () => {
    const model = buildBoundaryCatalogModel([activeBoundary()]);
    const boundary = model.boundaries[0]!;
    const tableTemplate = boundary.tables[0]!;
    boundary.tables = [
      "audit.activity_log",
      "crm.accounts",
      "ops.unrelated_snapshots",
      "warehouse.line_items_with_a_deliberately_long_name",
      "warehouse.orders",
    ].map((id) => ({ ...structuredClone(tableTemplate), id, label: id }));
    const relationshipTemplate = boundary.relationships[0]!;
    const makeRelationship = (
      id: string,
      source: string,
      target: string,
      sourceKey: string,
      targetKey: string,
    ) => ({
      ...structuredClone(relationshipTemplate),
      id,
      source_table: source,
      target_table: target,
      source_key: sourceKey,
      target_key: targetKey,
      path_depth: 1 as const,
      links: [{
        source_table: source,
        target_table: target,
        source_key: sourceKey,
        target_key: targetKey,
        hidden_join_key: false,
        proven: true,
        nullable: false,
      }],
      suggested_questions: [],
    });
    boundary.relationships = [
      makeRelationship("activity_account", "audit.activity_log", "crm.accounts", "account_ref", "account_key"),
      makeRelationship("line_order", "warehouse.line_items_with_a_deliberately_long_name", "warehouse.orders", "order_ref", "order_key"),
      makeRelationship("order_account", "warehouse.orders", "crm.accounts", "account_ref", "account_key"),
    ];
    boundary.physical_relationship_count = 3;
    model.table_count = boundary.tables.length;
    model.relationship_count = boundary.relationships.length;
    model.physical_relationship_count = 3;

    const topology = renderBoundaryCatalogTopologyAscii(model, { width: 48 });
    expect(topology).toContain("Route 1 of 2");
    expect(topology).toContain("Route 2 of 2");
    expect(topology.replace(/[\s|+\-]/g, ""))
      .toContain("warehouse.line_items_with_a_deliberately_long_name");
    expect(topology).toContain("warehouse.orders");
    expect(topology).toContain("crm.accounts");
    expect(topology).toContain("audit.activity_log");
    expect(topology).toContain("REVIEWED TABLES WITHOUT A JOIN PATH");
    expect(topology).toContain("ops.unrelated_snapshots");
    expect(topology.split("\n").every((line) => line.length <= 48)).toBe(true);
  });
});

function activeBoundary(): ActivatedExplorationBoundary {
  const ordersCustomers = relationshipLink({
    constraint: "orders_customer_fkey",
    source: "public.orders",
    target: "public.customers",
    sourceColumn: "secret_join",
    targetColumn: "id",
  });
  const invoicesOrders = relationshipLink({
    constraint: "invoices_order_fkey",
    source: "public.invoices",
    target: "public.orders",
    sourceColumn: "order_id",
    targetColumn: "id",
  });
  return {
    pack: {
      name: "reviewed_staging",
      resources: [
        {
          id: "public.invoices",
          schema: "public",
          table: "invoices",
          primary_key: "id",
          tenant_key: "organization_id",
          field_types: {
            id: "text",
            order_id: "text",
            amount_cents: "integer",
            issued_at: "timestamp with time zone",
          },
          field_enums: {},
          selectable_fields: ["id", "order_id", "amount_cents", "issued_at"],
          filterable_fields: {},
          sortable_fields: [],
          groupable_fields: [],
          aggregate_measures: ["amount_cents"],
          count_distinct_fields: ["id"],
          time_bucket_fields: { issued_at: ["day", "week", "month"] },
          kept_out_fields: [],
          relationships: [
            {
              id: "invoices_order_fkey",
              target_resource: "public.orders",
              local_columns: ["order_id"],
              target_columns: ["id"],
              counted_entity: "public.invoices",
              cardinality: "many_to_one",
              max_fan_out: 1,
              path_depth: 1,
              proof: {
                source: "database_catalog",
                links: [invoicesOrders],
                digest: `sha256:${"c".repeat(64)}`,
              },
            },
            {
              id: "invoices_order_customer_path",
              target_resource: "public.customers",
              local_columns: ["order_id"],
              target_columns: ["id"],
              counted_entity: "public.invoices",
              cardinality: "many_to_one",
              max_fan_out: 1,
              path_depth: 2,
              proof: {
                source: "database_catalog",
                links: [invoicesOrders, ordersCustomers],
                digest: `sha256:${"d".repeat(64)}`,
              },
            },
          ],
          minimum_cohort_size: 5,
          suppression_aware_totals: true,
        },
        {
          id: "public.orders",
          schema: "public",
          table: "orders",
          primary_key: "id",
          tenant_key: "organization_id",
          field_types: {
            id: "text",
            status: "text",
            total_cents: "integer",
            created_at: "timestamp with time zone",
            customer_email: "text",
            secret_join: "text",
          },
          field_enums: {},
          selectable_fields: ["id", "status", "total_cents", "created_at", "secret_join"],
          filterable_fields: {},
          sortable_fields: [],
          groupable_fields: ["status"],
          aggregate_measures: ["total_cents"],
          count_distinct_fields: ["id"],
          time_bucket_fields: { created_at: ["day", "week", "month"] },
          kept_out_fields: ["customer_email"],
          model_withheld_fields: ["secret_join"],
          relationships: [
            {
              id: "orders_customer_fkey",
              target_resource: "public.customers",
              local_columns: ["secret_join"],
              target_columns: ["id"],
              counted_entity: "public.orders",
              cardinality: "many_to_one",
              max_fan_out: 1,
              path_depth: 1,
              proof: {
                source: "database_catalog",
                links: [ordersCustomers],
                digest: `sha256:${"b".repeat(64)}`,
              },
            },
            {
              id: "orders_outside_fkey",
              target_resource: "public.outside",
              local_columns: ["status"],
              target_columns: ["id"],
              counted_entity: "public.orders",
              cardinality: "many_to_one",
              max_fan_out: 1,
            },
          ],
          minimum_cohort_size: 5,
          suppression_aware_totals: true,
        },
        {
          id: "public.customers",
          schema: "public",
          table: "customers",
          primary_key: "id",
          tenant_key: "organization_id",
          field_types: { id: "text", region: "text" },
          field_enums: {},
          selectable_fields: ["id", "region"],
          filterable_fields: {},
          sortable_fields: [],
          groupable_fields: ["region"],
          aggregate_measures: [],
          count_distinct_fields: ["id"],
          time_bucket_fields: {},
          kept_out_fields: [],
          relationships: [],
          minimum_cohort_size: 5,
          suppression_aware_totals: true,
        },
      ],
    },
    activation: { digest: `sha256:${"a".repeat(64)}` },
  } as unknown as ActivatedExplorationBoundary;
}

function relationshipLink(input: {
  constraint: string;
  source: string;
  target: string;
  sourceColumn: string;
  targetColumn: string;
}): RelationshipLinkProof {
  return {
    constraint_name: input.constraint,
    source_resource: input.source,
    target_resource: input.target,
    source_columns: [input.sourceColumn],
    target_columns: [input.targetColumn],
    target_uniqueness: {
      kind: "primary_key",
      name: `${input.target}_pkey`,
      columns: [input.targetColumn],
    },
    nullable: false,
    cardinality: "many_to_one",
    max_fan_out: 1,
  };
}
