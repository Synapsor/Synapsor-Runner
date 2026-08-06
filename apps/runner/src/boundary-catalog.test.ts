import mermaid from "mermaid";
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
} from "./boundary-catalog.js";

describe("active boundary catalog", () => {
  it("renders redacted connected paths and parser-valid physical Mermaid joins", async () => {
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
          "What is total invoice amount cents by customer region?",
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
    expect(ascii).toContain('"What is total invoice amount cents by customer region?"');
    expect(ascii).not.toContain("secret_join");
    expect(ascii.split("\n").every((line) => line.length <= 88)).toBe(true);

    const diagram = renderBoundaryCatalogMermaid(model);
    expect(diagram).toContain("erDiagram");
    expect(diagram).toContain("PUBLIC_INVOICES }o--|| PUBLIC_ORDERS");
    expect(diagram).toContain("PUBLIC_ORDERS }o--|| PUBLIC_CUSTOMERS");
    expect(diagram).not.toMatch(/PUBLIC_INVOICES\s+}o--\|\|\s+PUBLIC_CUSTOMERS/);
    expect(diagram).toContain('int runner_only_fields "1 hidden from model"');
    expect(diagram).toContain('int kept_out_fields "1 unavailable"');
    expect(diagram).not.toContain("customer_email");
    expect(diagram).not.toContain("secret_join");
    expect(diagram).not.toContain("public.outside");

    mermaid.initialize({ startOnLoad: false });
    await expect(mermaid.parse(diagram)).resolves.toBeTruthy();

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
    expect(exports[0]!.markdown).toContain("## Mermaid ER Diagram");
    expect(exports[0]!.markdown).not.toContain("customer_email");
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
