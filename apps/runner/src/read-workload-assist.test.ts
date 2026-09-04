import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  DEFAULT_REVIEWED_EXPLORATION_BUDGETS,
  type ExplorationBoundaryDraft,
} from "./auto-boundary.js";
import {
  READ_WORKLOAD_SET_VERSION,
  analyzeReadWorkloadSet,
  buildReadWorkloadPlanCards,
  extractReadAuthorityAtoms,
  normalizeReadWorkloadSet,
  rankReadWorkloadPlanCardsForJob,
  recommendReadWorkloadPlanCardsForJob,
  readWorkloadFromPlanCards,
  rehydrateSanitizedReadWorkloadPlan,
  sanitizeReadWorkloadPlan,
  type ReadWorkloadPlanCard,
  type ReadWorkloadSet,
} from "./read-workload-assist.js";
import { validateExplorePlan } from "./scoped-explore.js";

describe("Read workload boundary compiler", () => {
  it("ranks no-model cards from the job without selecting or changing them", () => {
    const cards: ReadWorkloadPlanCard[] = [
      {
        id: "sites",
        title: "Count sites by region",
        detail: "Group site count by region",
        plan: { kind: "aggregate", resource: "renewable_ops.sites", measures: [{ function: "count" }] },
      },
      {
        id: "maintenance",
        title: "List maintenance requests",
        detail: "Return request type, priority, requested hours",
        plan: { kind: "rows", resource: "renewable_ops.maintenance_requests", select: ["priority", "requested_hours"] },
      },
      {
        id: "inspections",
        title: "Count inspections by inspection kind",
        detail: "Group the reviewed count by inspection kind",
        plan: { kind: "aggregate", resource: "renewable_ops.inspections", measures: [{ function: "count" }] },
      },
    ];

    const ranked = rankReadWorkloadPlanCardsForJob(
      cards,
      "Summarize urgent inspections and propose maintenance requests with four labor hours.",
    );

    expect(ranked.map((card) => card.id)).toEqual(["maintenance", "inspections", "sites"]);
    expect(cards.map((card) => card.id)).toEqual(["sites", "maintenance", "inspections"]);
  });

  it("recommends a small resource-diverse no-model draft only from positive reviewed matches", () => {
    const cards: ReadWorkloadPlanCard[] = [
      {
        id: "maintenance_rows",
        title: "List maintenance requests",
        detail: "Return priority and requested hours",
        plan: { kind: "rows", resource: "renewable_ops.maintenance_requests", select: ["priority"] },
      },
      {
        id: "maintenance_count",
        title: "Count maintenance requests by priority",
        detail: "Group maintenance requests by priority",
        plan: { kind: "aggregate", resource: "renewable_ops.maintenance_requests", measures: [{ function: "count" }] },
      },
      {
        id: "inspections",
        title: "Count inspections by inspection kind",
        detail: "Group inspections by inspection kind",
        plan: { kind: "aggregate", resource: "renewable_ops.inspections", measures: [{ function: "count" }] },
      },
      {
        id: "sites",
        title: "Count sites by region",
        detail: "Group sites by region",
        plan: { kind: "aggregate", resource: "renewable_ops.sites", measures: [{ function: "count" }] },
      },
    ];

    const recommendation = recommendReadWorkloadPlanCardsForJob(
      cards,
      "Explain inspection workload and open maintenance requests.",
      3,
    );

    expect(recommendation).toMatchObject({
      source: "reviewed_metadata",
      matched_resource_count: 2,
    });
    expect(recommendation.cards).toHaveLength(3);
    expect(recommendation.cards.map((card) => card.id)).toEqual(expect.arrayContaining([
      "maintenance_rows",
      "inspections",
    ]));
    expect(recommendation.cards.map((card) => card.id)).not.toContain("sites");
    expect(cards.map((card) => card.id)).toEqual([
      "maintenance_rows",
      "maintenance_count",
      "inspections",
      "sites",
    ]);
  });

  it("does not invent a no-model recommendation when reviewed metadata does not match", () => {
    const recommendation = recommendReadWorkloadPlanCardsForJob([
      {
        id: "sites",
        title: "Count sites by region",
        detail: "Group sites by region",
        plan: { kind: "aggregate", resource: "renewable_ops.sites", measures: [{ function: "count" }] },
      },
    ], "Explain quarterly invoices and customer refunds.");

    expect(recommendation).toEqual({
      cards: [],
      matched_resource_count: 0,
      source: "reviewed_metadata",
    });
  });

  it("does not treat a shared schema name as evidence for an opaque resource", () => {
    const recommendation = recommendReadWorkloadPlanCardsForJob([
      {
        id: "orders",
        title: "List work orders",
        detail: "Return priority and estimated duration",
        plan: {
          kind: "rows",
          resource: "fleet_ops.work_orders",
          select: ["priority", "estimated_minutes"],
        },
      },
      {
        id: "opaque",
        title: "List x7",
        detail: "Return k1, c1, and c2",
        plan: {
          kind: "rows",
          resource: "fleet_ops.x7",
          select: ["k1", "c1", "c2"],
        },
      },
    ], "Help a fleet dispatcher understand their work orders and priorities.");

    expect(recommendation.cards.map((card) => card.id)).toEqual(["orders"]);
    expect(recommendation.matched_resource_count).toBe(1);
  });

  it("offers deterministic reviewed question cards without model or source access", () => {
    const draft = generatedBoundary();
    const cards = buildReadWorkloadPlanCards(draft);

    expect(cards.map((card) => card.title)).toEqual(expect.arrayContaining([
      "List orders",
      "Count orders by status",
      "Average amount by status",
      "Count orders by related segment",
      "Count orders over months",
    ]));
    const selected = cards.filter((card) => [
      "List orders",
      "Average amount by status",
      "Count orders by related segment",
    ].includes(card.title));
    const workload = readWorkloadFromPlanCards({
      cards,
      selectedIds: selected.map((card) => card.id),
    });
    const analysis = analyzeReadWorkloadSet({ workload, generatedBoundary: draft });

    expect(workload.source).toEqual({ kind: "operator_exact_plan" });
    expect(analysis).toMatchObject({
      status: "ready",
      authority_granted: false,
      source_query_executed: false,
      explore_budget_consumed: false,
      coverage: { allowed_supported: 3, allowed_total: 3 },
    });
    expect(() => readWorkloadFromPlanCards({ cards, selectedIds: ["not_offered"] }))
      .toThrow("READ_WORKLOAD_CARD_UNKNOWN");
  });

  it("keeps one reviewed relationship question per rich resource inside the 40-card picker", () => {
    const base = generatedBoundary();
    const customers = structuredClone(base.pack.resources[0]!);
    const orderTemplate = base.pack.resources[1]!;
    const orders = Array.from({ length: 9 }, (_, index) => {
      const order = structuredClone(orderTemplate);
      order.id = `public.orders_${index + 1}`;
      order.table = `orders_${index + 1}`;
      const relationship = order.relationships[0]!;
      relationship.id = `orders_${index + 1}_customer_id_fkey`;
      relationship.proof!.links[0]!.constraint_name = relationship.id;
      relationship.proof!.links[0]!.source_resource = order.id;
      relationship.proof!.digest = canonicalJsonDigest(relationship.proof!.links);
      return order;
    });
    const deepestRoot = orders[0]!;
    const deepestRelationship = structuredClone(deepestRoot.relationships[0]!);
    deepestRelationship.id = "orders_1_to_customers_depth_3";
    deepestRelationship.path_depth = 3;
    deepestRelationship.proof!.links = [
      relationshipLink("orders_1_to_orders_2", orders[0]!.id, orders[1]!.id),
      relationshipLink("orders_2_to_orders_3", orders[1]!.id, orders[2]!.id),
      relationshipLink("orders_3_to_customers", orders[2]!.id, customers.id),
    ];
    deepestRelationship.proof!.digest = canonicalJsonDigest(deepestRelationship.proof!.links);
    deepestRoot.relationships.push(deepestRelationship);
    const boundary = structuredClone(base);
    boundary.pack.resources = [customers, ...orders];
    boundary.budgets.max_analysis_relationship_hops = 3;

    const cards = buildReadWorkloadPlanCards(boundary);

    expect(cards).toHaveLength(40);
    for (const order of orders) {
      const expectedRelationship = [...order.relationships]
        .sort((left, right) => (right.path_depth ?? 1) - (left.path_depth ?? 1))[0]!.id;
      const selectedRelationships = cards.flatMap((card) => {
        const dimensions = card.plan.dimensions;
        return card.plan.resource === order.id
          && Array.isArray(dimensions)
          && typeof dimensions[0]?.relationship === "string"
          ? [dimensions[0].relationship]
          : [];
      });
      expect(selectedRelationships, order.id).toContain(expectedRelationship);
    }
  });

  it("extracts exact relationship, field-operation, and aggregate authority", () => {
    const draft = generatedBoundary();
    const plan = validateExplorePlan(allowedPlan(), activated(draft));
    const atoms = extractReadAuthorityAtoms(plan, draft);

    expect(atoms).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "resource", resource: "public.orders" }),
      expect.objectContaining({ operation: "filter", resource: "public.orders", field: "status", qualifier: "eq" }),
      expect.objectContaining({ operation: "aggregate", resource: "public.orders", field: "amount", qualifier: "avg" }),
      expect.objectContaining({ operation: "relationship", root_resource: "public.orders", relationship: "orders_customer_id_fkey" }),
      expect.objectContaining({ operation: "group", resource: "public.customers", field: "segment" }),
    ]));
  });

  it("compiles allowed plans into a narrower disabled candidate and proves forbidden plans stay denied", () => {
    const analysis = analyzeReadWorkloadSet({
      workload: workload(),
      generatedBoundary: generatedBoundary(),
    });

    expect(analysis.status).toBe("ready");
    expect(analysis.coverage).toEqual({
      allowed_supported: 1,
      allowed_total: 1,
      forbidden_denied: 1,
      forbidden_total: 1,
    });
    expect(analysis.authority_granted).toBe(false);
    expect(analysis.source_query_executed).toBe(false);
    expect(analysis.explore_budget_consumed).toBe(false);
    expect(analysis.candidate?.activation).toBe("disabled_unreviewed");
    expect(analysis.candidate?.pack.resources.map((resource) => resource.id)).toEqual([
      "public.customers",
      "public.orders",
    ]);
    const orders = analysis.candidate?.pack.resources.find((resource) => resource.id === "public.orders");
    const customers = analysis.candidate?.pack.resources.find((resource) => resource.id === "public.customers");
    expect(orders?.selectable_fields).toEqual([]);
    expect(orders?.filterable_fields).toEqual({ status: ["eq"] });
    expect(orders?.aggregate_measures).toEqual(["amount"]);
    expect(orders?.aggregate_measure_functions).toEqual({ amount: ["avg"] });
    expect(orders?.relationships.map((relationship) => relationship.id)).toEqual(["orders_customer_id_fkey"]);
    expect(customers?.groupable_fields).toEqual(["segment"]);
    expect(analysis.exposure.candidate_operation_fields).toBe(3);
    expect(JSON.stringify(analysis.allowed[0]?.plan_shape)).not.toContain("open-value-from-user");
  });

  it("blocks contradictory requirements instead of widening the candidate", () => {
    const spec = workload();
    spec.forbidden = [{
      id: "forbid_same_answer",
      description: "Do not allow the same aggregate",
      plan: allowedPlan(),
    }];
    const analysis = analyzeReadWorkloadSet({ workload: spec, generatedBoundary: generatedBoundary() });
    expect(analysis.status).toBe("blocked");
    expect(analysis.blockers.join("\n")).toContain("forbidden plan is still expressible");
    expect(analysis.candidate).toBeUndefined();
  });

  it("refuses unknown ids even when the plan is declared forbidden", () => {
    const spec = workload();
    spec.forbidden = [{
      id: "typo_is_not_a_test",
      description: "A typo must not be accepted as a deny test",
      plan: { kind: "rows", resource: "public.ordres", select: ["id"] },
    }];
    const analysis = analyzeReadWorkloadSet({ workload: spec, generatedBoundary: generatedBoundary() });
    expect(analysis.status).toBe("blocked");
    expect(analysis.forbidden[0]).toMatchObject({
      status: "blocked",
      reason: expect.stringContaining("READ_WORKLOAD_RESOURCE_UNKNOWN"),
    });
  });

  it("does not count a malformed forbidden plan as a proven deny test", () => {
    const spec = workload();
    spec.forbidden = [{
      id: "malformed_is_not_a_test",
      description: "A malformed request cannot prove denied authority",
      plan: {
        kind: "aggregate",
        resource: "public.orders",
        measures: "count",
      },
    }];

    const analysis = analyzeReadWorkloadSet({ workload: spec, generatedBoundary: generatedBoundary() });
    expect(analysis.status).toBe("blocked");
    expect(analysis.coverage.forbidden_denied).toBe(0);
    expect(analysis.forbidden[0]).toMatchObject({
      status: "blocked",
      reason: expect.stringContaining("READ_WORKLOAD_FORBIDDEN_PLAN_INVALID"),
    });
    expect(analysis.candidate).toBeUndefined();
  });

  it("stores a redacted plan shape rather than filter literals", () => {
    const plan = validateExplorePlan(allowedPlan(), activated(generatedBoundary()));
    const shape = sanitizeReadWorkloadPlan(plan);
    expect(shape.where).toEqual([{
      field: "status",
      op: "eq",
      value: { redacted: true, kind: "scalar", type: "string" },
    }]);
    expect(JSON.stringify(shape)).not.toContain("open-value-from-user");
  });

  it("rehydrates redacted saved filters from reviewed types without recovering source literals", () => {
    const boundary = generatedBoundary();
    const original = validateExplorePlan({
      ...allowedPlan(),
      where: [
        { field: "status", op: "in", value: ["open-value-from-user", "closed"] },
        { field: "amount", op: "gte", value: 250 },
      ],
    }, activated(boundary));
    const shape = sanitizeReadWorkloadPlan(original);

    const rehydrated = rehydrateSanitizedReadWorkloadPlan(shape, boundary);

    expect(rehydrated.where).toEqual([
      { field: "status", op: "in", value: ["open-value-from-user", "closed"] },
      { field: "amount", op: "gte", value: 0 },
    ]);
    expect(JSON.stringify(rehydrated)).not.toContain("250");
    expect(() => validateExplorePlan(rehydrated, activated(boundary))).not.toThrow();
    expect(shape.where).toEqual([
      {
        field: "status",
        op: "in",
        value: { redacted: true, kind: "list", count: 2, element_types: ["string"] },
      },
      {
        field: "amount",
        op: "gte",
        value: { redacted: true, kind: "scalar", type: "number" },
      },
    ]);
  });

  it("refuses a malformed saved filter shape instead of treating it as a value", () => {
    expect(() => rehydrateSanitizedReadWorkloadPlan({
      kind: "aggregate",
      resource: "public.orders",
      measures: [{ function: "count" }],
      where: [{ field: "status", op: "eq", value: { kind: "scalar", type: "string" } }],
      top_n: 1,
    }, generatedBoundary())).toThrow("does not contain a redacted literal shape");
  });

  it("normalizes a bounded exact-plan workload and rejects model identity on operator input", () => {
    expect(normalizeReadWorkloadSet(workload()).source).toEqual({ kind: "operator_exact_plan" });
    expect(() => normalizeReadWorkloadSet({
      ...workload(),
      source: { kind: "operator_exact_plan", provider: "openai", model: "x" },
    })).toThrow("only model workloads");
  });

  it("compiles the same minimum authority through the MySQL SQL path", () => {
    const mysqlBoundary = generatedBoundary();
    mysqlBoundary.source = "local_mysql";
    const analysis = analyzeReadWorkloadSet({
      workload: {
        ...workload(),
        source: { kind: "plan_playground" },
      },
      generatedBoundary: mysqlBoundary,
    });

    expect(analysis.status).toBe("ready");
    expect(analysis.candidate).toMatchObject({
      source: "local_mysql",
      activation: "disabled_unreviewed",
    });
    expect(analysis.coverage).toEqual({
      allowed_supported: 1,
      allowed_total: 1,
      forbidden_denied: 1,
      forbidden_total: 1,
    });
    expect(analysis.authority_granted).toBe(false);
    expect(analysis.source_query_executed).toBe(false);
    expect(analysis.explore_budget_consumed).toBe(false);
  });
});

function workload(): ReadWorkloadSet {
  return {
    schema_version: READ_WORKLOAD_SET_VERSION,
    name: "support_resolution",
    allowed: [{
      id: "orders_by_customer_segment",
      description: "Average order amount by customer segment for open orders",
      plan: allowedPlan(),
    }],
    forbidden: [{
      id: "raw_order_amounts",
      description: "Do not return individual order amounts",
      plan: {
        kind: "rows",
        resource: "public.orders",
        select: ["id", "amount"],
        limit: 10,
      },
    }],
    source: { kind: "operator_exact_plan" as const },
  };
}

function allowedPlan() {
  return {
    kind: "aggregate",
    resource: "public.orders",
    measures: [{ function: "avg", field: "amount" }],
    dimensions: [{ field: "segment", relationship: "orders_customer_id_fkey" }],
    where: [{ field: "status", op: "eq", value: "open-value-from-user" }],
    order_by: { kind: "measure", index: 0, direction: "desc" },
    top_n: 10,
  };
}

function activated(draft: ExplorationBoundaryDraft) {
  const { unresolved_decisions: _unresolved, ...rest } = draft;
  return {
    ...rest,
    activation: {
      state: "active" as const,
      digest: `sha256:${"a".repeat(64)}` as const,
      actor: "test",
      activated_at: "2026-08-27T00:00:00.000Z",
      generation_lock_fingerprint: draft.generation_lock_fingerprint,
      reviewed_decisions: [],
    },
  };
}

function generatedBoundary(): ExplorationBoundaryDraft {
  const hash = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}` as `sha256:${string}`;
  const relationshipLink = {
    constraint_name: "orders_customer_id_fkey",
    source_resource: "public.orders",
    target_resource: "public.customers",
    source_columns: ["customer_id"],
    target_columns: ["id"],
    target_uniqueness: { kind: "primary_key" as const, name: "customers_pkey", columns: ["id"] },
    nullable: false,
    cardinality: "many_to_one" as const,
    max_fan_out: 1 as const,
  };
  return {
    schema_version: "synapsor.exploration-boundary.v1",
    activation: "disabled_unreviewed",
    deployment_profile: "staging",
    source: "local_postgres",
    compiler_version: "1.7.0",
    spec_version: "1.9.0",
    reporting_timezone: "UTC",
    trusted_context: {
      provider: "environment",
      tenant_env: "SYNAPSOR_TENANT_ID",
      principal_env: "SYNAPSOR_PRINCIPAL_ID",
    },
    generation_lock_fingerprint: hash("1"),
    role_posture_fingerprint: hash("2"),
    pack: {
      name: "reviewed_staging",
      resources: [
        {
          id: "public.customers",
          schema: "public",
          table: "customers",
          primary_key: "id",
          tenant_key: "tenant_id",
          field_types: { id: "uuid", tenant_id: "text", segment: "text", email: "text" },
          field_enums: { segment: ["enterprise", "small_business"] },
          selectable_fields: ["id", "segment"],
          filterable_fields: { segment: ["eq", "neq", "in"] },
          sortable_fields: ["segment"],
          groupable_fields: ["segment"],
          aggregate_measures: [],
          count_distinct_fields: ["segment"],
          time_bucket_fields: {},
          kept_out_fields: ["email"],
          relationships: [],
          minimum_cohort_size: 5,
          suppression_aware_totals: true,
        },
        {
          id: "public.orders",
          schema: "public",
          table: "orders",
          primary_key: "id",
          tenant_key: "tenant_id",
          field_types: {
            id: "uuid",
            tenant_id: "text",
            customer_id: "uuid",
            status: "text",
            amount: "numeric",
            created_at: "timestamp",
            secret_note: "text",
          },
          field_enums: { status: ["open-value-from-user", "closed"] },
          selectable_fields: ["id", "status", "amount", "created_at"],
          filterable_fields: {
            status: ["eq", "neq", "in"],
            amount: ["eq", "lt", "lte", "gt", "gte"],
            created_at: ["lt", "lte", "gt", "gte"],
          },
          sortable_fields: ["amount", "created_at"],
          groupable_fields: ["status"],
          aggregate_measures: ["amount"],
          aggregate_measure_functions: { amount: ["sum", "avg", "stddev_pop"] },
          presence_measure_fields: ["status"],
          count_distinct_fields: ["status"],
          time_bucket_fields: { created_at: ["day", "week", "month"] },
          kept_out_fields: ["secret_note"],
          relationships: [{
            id: "orders_customer_id_fkey",
            target_resource: "public.customers",
            local_columns: ["customer_id"],
            target_columns: ["id"],
            counted_entity: "public.orders",
            cardinality: "many_to_one",
            max_fan_out: 1,
            path_depth: 1,
            proof: {
              source: "database_catalog",
              links: [relationshipLink],
              digest: canonicalJsonDigest([relationshipLink]),
            },
          }],
          minimum_cohort_size: 5,
          suppression_aware_totals: true,
        },
      ],
    },
    budgets: structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS),
    unresolved_decisions: [],
  };
}

function relationshipLink(constraintName: string, source: string, target: string) {
  return {
    constraint_name: constraintName,
    source_resource: source,
    target_resource: target,
    source_columns: ["customer_id"],
    target_columns: ["id"],
    target_uniqueness: { kind: "primary_key" as const, name: `${target}_pkey`, columns: ["id"] },
    nullable: false,
    cardinality: "many_to_one" as const,
    max_fan_out: 1 as const,
  };
}
