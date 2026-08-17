import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readReviewedAskAccessSummary,
  resolveAskAccessGuidance,
} from "./ask-access-summary.js";
import { explorationBoundaryCandidateDigest } from "./auto-boundary.js";
import type { AskToolGateway } from "./model-ask.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Ask access summaries", () => {
  it("uses the operator-only metadata catalog for the startup summary", async () => {
    let publicToolCalls = 0;
    let operatorCalls = 0;
    const gateway: AskToolGateway = {
      mode: "authoring",
      listTools: () => [],
      callTool: async () => {
        publicToolCalls += 1;
        throw new Error("startup must not call the model-facing catalog");
      },
      describeOperatorMetadata: async () => {
        operatorCalls += 1;
        return {
          ok: true,
          value: {
            ok: true,
            resources: [],
            next_cursor: null,
            source_database_changed: false,
          },
        };
      },
      close: async () => undefined,
    };

    await expect(readReviewedAskAccessSummary(gateway)).resolves.toEqual({
      table_count: 0,
      resources: [],
      suggestions: [],
    });
    expect(operatorCalls).toBe(1);
    expect(publicToolCalls).toBe(0);
  });

  it("projects only executable active suggestions into the CLI summary", async () => {
    const gateway: AskToolGateway = {
      mode: "authoring",
      listTools: () => [],
      callTool: async () => ({
        ok: true,
        value: {
          ok: true,
          resources: [{
            id: "public.orders",
            label: "Orders",
            boundary_name: "reviewed_sales",
            field_labels: {
              total_cents: "Total cents",
              status: "Status",
              created_at: "Created at",
            },
            groupable_fields: ["status"],
            aggregate_measures: ["total_cents"],
            count_distinct_fields: ["id"],
            time_bucket_fields: { created_at: ["day", "week", "month"] },
            relationships: [],
            suggested_questions: [{
              text: "How did total cents change by week across status?",
              measure: { function: "sum", field: "total_cents" },
              dimension: "status",
              time_field: "created_at",
              time_bucket: "week",
            }, {
              text: "Which product categories grew fastest?",
              measure: { function: "sum", field: "total_cents" },
              dimension: { field: "category", relationship: "orders_products" },
              relationship_review_required: true,
            }, {
              text: "Invalid unreviewed measure",
              measure: { function: "sum", field: "profit_cents" },
            }],
          }],
          next_cursor: null,
          source_database_changed: false,
        },
      }),
      close: async () => undefined,
    };

    const summary = await readReviewedAskAccessSummary(gateway);
    expect(summary).toEqual({
      table_count: 1,
      resources: [{
        id: "public.orders",
        label: "Orders",
        boundary_name: "reviewed_sales",
        capabilities: [
          "record counts",
          "totals and averages of Total cents",
          "unique counts of Id",
          "grouping by Status",
          "day, week, or month using Created at",
        ],
        suggestions: ["How did total cents change by week across status?"],
      }],
      suggestions: ["How did total cents change by week across status?"],
    });
  });

  it("finds the source-proven TrailPeak category path without activating or exposing kept-out fields", async () => {
    const root = await fixtureProject();
    const guidance = await resolveAskAccessGuidance({
      projectRoot: root,
      question: "Which product category is growing fastest?",
    });
    expect(guidance).toMatchObject({
      kind: "review_candidate",
      title: "Category is not in the active boundary",
      candidate_path: "Order items -> Products -> Orders",
      review_resource: "public.order_items",
      review_field: "category",
    });
    expect(guidance?.message).toContain("remains disabled until a human reviews");
    await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
      .rejects.toMatchObject({ code: "ENOENT" });

    await activateFixtureBoundary(root);
    await expect(resolveAskAccessGuidance({
      projectRoot: root,
      question: "Which product category is growing fastest?",
    })).resolves.toBeUndefined();

    await expect(resolveAskAccessGuidance({
      projectRoot: root,
      question: "List customer emails",
    })).resolves.toBeUndefined();
  });

  it("does not pretend a refund-rate formula is an ad hoc reviewed join", async () => {
    const root = await fixtureProject();
    await expect(resolveAskAccessGuidance({
      projectRoot: root,
      question: "What is our refund rate by product category?",
    })).resolves.toMatchObject({
      kind: "reviewed_view_required",
      title: "A reviewed metric is needed",
      next_action: expect.stringContaining("reviewed view or named metric"),
    });
  });

  it("does not match a one-character draft field inside an unrelated word", async () => {
    const root = await fixtureProject();
    const draftPath = path.join(root, "synapsor/generated/exploration-boundary.draft.json");
    const draft = JSON.parse(await fs.readFile(draftPath, "utf8")) as any;
    draft.pack.resources.push(resource("public.nums", "nums", { fields: ["n"] }));
    await fs.writeFile(draftPath, JSON.stringify(draft), "utf8");

    await expect(resolveAskAccessGuidance({
      projectRoot: root,
      question: "Are emergencies going up?",
    })).resolves.toBeUndefined();
  });

  it("explains complementary privacy refusals with the exact human review path", async () => {
    const root = await fixtureProject();
    await activateFixtureBoundary(root);
    const guidance = await resolveAskAccessGuidance({
      projectRoot: root,
      question: "What is the total?",
      toolCalls: [{
        call_id: "call-1",
        tool: "app.explore_data",
        provider_tool: "app__explore_data",
        status: "refused",
        error_code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
        arguments: {
          boundary: "reviewed_staging",
          plan: {
            kind: "aggregate",
            resource: "public.orders",
            measures: [{ function: "count" }],
            top_n: 1,
          },
        },
        result: {
          ok: false,
          details: {
            reason: "complementary_aggregate_release",
            resource: "public.orders",
            minimum_cohort_size: 5,
            attempted_release_kind: "scalar_total",
            conflicting_release_kind: "suppressed_grouping",
            source_query_executed: true,
          },
        },
      }],
    });
    expect(guidance).toMatchObject({
      kind: "review_candidate",
      review_boundary: "reviewed_staging",
      review_resource: "public.orders",
      review_focus: "privacy",
      source_query_executed: true,
    });
    expect(guidance?.message).toMatch(/withheld.*reconstruct.*discarded/i);
    expect(guidance?.next_action).toContain("select reviewed_staging and press Enter");
    expect(guidance?.next_action).toContain("Highlight public.orders; do not open its columns");
    expect(guidance?.next_action).toContain("Press P (Privacy) for the highlighted table");
    expect(guidance?.next_action).toContain("Enter 1 to turn small-group suppression off");
    expect(guidance?.next_action).toContain("Save this privacy change? [Y/n]");
    expect(guidance?.next_action).toContain("groups of one can identify individuals");
  });

  it("routes a forbidden foreign-key grouping through its reviewed relationship", async () => {
    const root = await fixtureProject();
    await activateFixtureBoundary(root);
    const guidance = await resolveAskAccessGuidance({
      projectRoot: root,
      question: "Which product has the most order items?",
      toolCalls: [{
        call_id: "call-2",
        tool: "app.explore_data",
        provider_tool: "app__explore_data",
        status: "refused",
        error_code: "EXPLORE_FIELD_FORBIDDEN",
        arguments: {
          boundary: "reviewed_staging",
          plan: {
            kind: "aggregate",
            resource: "public.order_items",
            measures: [{ function: "count" }],
            dimensions: [{ field: "product_id" }],
            top_n: 10,
          },
        },
        result: {
          ok: false,
          details: {
            reason: "field_operation_not_reviewed",
            resource: "public.order_items",
            field: "product_id",
            operation: "group",
          },
        },
      }],
    });
    expect(guidance).toMatchObject({
      kind: "reviewed_view_required",
      review_boundary: "reviewed_staging",
      review_resource: "public.order_items",
      review_field: "product_id",
    });
    expect(guidance?.message).toContain("order_items_product_id_fkey");
    expect(guidance?.next_action).toContain("group Order items by Category");
  });

  it("routes a target grouping field through its one exact reviewed relationship", async () => {
    const root = await fixtureProject();
    await activateFixtureBoundary(root);
    const guidance = await resolveAskAccessGuidance({
      projectRoot: root,
      question: "How many order items are there by category?",
      toolCalls: [{
        call_id: "call-target-field",
        tool: "app.explore_data",
        provider_tool: "app__explore_data",
        status: "refused",
        error_code: "EXPLORE_FIELD_FORBIDDEN",
        arguments: {
          boundary: "reviewed_staging",
          plan: {
            kind: "aggregate",
            resource: "public.order_items",
            measures: [{ function: "count" }],
            dimensions: [{ field: "category" }],
            top_n: 10,
          },
        },
        result: {
          ok: false,
          details: {
            reason: "field_operation_not_reviewed",
            resource: "public.order_items",
            field: "category",
            operation: "group",
          },
        },
      }],
    });
    expect(guidance).toMatchObject({
      kind: "reviewed_view_required",
      review_boundary: "reviewed_staging",
      review_resource: "public.order_items",
      review_field: "category",
    });
    expect(guidance?.message).toContain("order_items_product_id_fkey");
    expect(guidance?.next_action).toContain("group Order items by Category");
  });
});

async function fixtureProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ask-access-"));
  roots.push(root);
  const generated = path.join(root, "synapsor/generated");
  await fs.mkdir(generated, { recursive: true });
  await fs.writeFile(path.join(generated, "exploration-boundary.draft.json"), JSON.stringify({
    schema_version: "synapsor.exploration-boundary.v1",
    activation: "disabled_unreviewed",
    deployment_profile: "staging",
    source: "database",
    compiler_version: "test",
    spec_version: "test",
    trusted_context: {
      provider: "environment",
      tenant_env: "SYNAPSOR_TENANT_ID",
      principal_env: "SYNAPSOR_PRINCIPAL",
    },
    generation_lock_fingerprint: `sha256:${"1".repeat(64)}`,
    role_posture_fingerprint: `sha256:${"2".repeat(64)}`,
    pack: {
      name: "reviewed_staging",
      resources: [
        resource("public.orders", "orders", {
          fields: ["id", "total_cents", "created_at"],
          aggregates: ["total_cents"],
          times: ["created_at"],
        }),
        resource("public.products", "products", {
          fields: ["id", "category"],
          groups: ["category"],
        }),
        resource("public.order_items", "order_items", {
          fields: ["id", "order_id", "product_id", "quantity"],
          aggregates: ["quantity"],
          relationships: [
            relationship("order_items_product_id_fkey", "public.order_items", "public.products", "product_id"),
            relationship("order_items_order_id_fkey", "public.order_items", "public.orders", "order_id"),
          ],
        }),
        resource("public.customers", "customers", {
          fields: ["id", "region"],
          groups: ["region"],
          keptOut: ["email"],
        }),
        resource("public.refunds", "refunds", {
          fields: ["id", "amount_cents", "created_at"],
          aggregates: ["amount_cents"],
          times: ["created_at"],
        }),
      ],
    },
    budgets: {
      max_relationship_hops: 2,
    },
    unresolved_decisions: [],
  }), "utf8");
  return root;
}

async function activateFixtureBoundary(root: string): Promise<void> {
  const candidate = JSON.parse(await fs.readFile(
    path.join(root, "synapsor/generated/exploration-boundary.draft.json"),
    "utf8",
  )) as Record<string, unknown>;
  const digest = explorationBoundaryCandidateDigest(
    candidate as Parameters<typeof explorationBoundaryCandidateDigest>[0],
  );
  await fs.mkdir(path.join(root, ".synapsor"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".synapsor/exploration-boundary.active.json"),
    JSON.stringify({
      ...candidate,
      activation: {
        state: "active",
        digest,
      },
    }),
    "utf8",
  );
}

function resource(
  id: string,
  table: string,
  input: {
    fields: string[];
    groups?: string[];
    aggregates?: string[];
    times?: string[];
    keptOut?: string[];
    relationships?: ReturnType<typeof relationship>[];
  },
): Record<string, unknown> {
  return {
    id,
    schema: "public",
    table,
    primary_key: "id",
    tenant_key: "organization_id",
    field_types: Object.fromEntries(input.fields.map((field) => [field, "text"])),
    field_enums: {},
    selectable_fields: input.fields,
    filterable_fields: Object.fromEntries(input.fields.map((field) => [field, ["eq"]])),
    sortable_fields: input.fields,
    groupable_fields: input.groups ?? [],
    aggregate_measures: input.aggregates ?? [],
    count_distinct_fields: ["id"],
    time_bucket_fields: Object.fromEntries((input.times ?? []).map((field) => [field, ["day", "week", "month"]])),
    kept_out_fields: input.keptOut ?? ["organization_id"],
    relationships: input.relationships ?? [],
    minimum_cohort_size: 5,
    suppression_aware_totals: true,
  };
}

function relationship(
  id: string,
  source: string,
  target: string,
  sourceColumn: string,
): Record<string, unknown> {
  return {
    id,
    target_resource: target,
    cardinality: "many_to_one",
    counted_entity: source,
    path_depth: 1,
    nullable: false,
    unmatched_rows: "exclude",
    proof: {
      source: "database_catalog",
      links: [{
        constraint_name: id,
        source_resource: source,
        target_resource: target,
        source_columns: [sourceColumn],
        target_columns: ["id"],
        target_uniqueness: {
          kind: "primary_key",
          name: `${target}.primary_key`,
          columns: ["id"],
        },
        nullable: false,
        cardinality: "many_to_one",
        max_fan_out: 1,
      }],
      digest: `sha256:${"3".repeat(64)}`,
    },
  };
}
