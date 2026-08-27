import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  DEFAULT_REVIEWED_EXPLORATION_BUDGETS,
  type ExplorationBoundaryDraft,
} from "./auto-boundary.js";
import {
  READ_WORKLOAD_SET_VERSION,
  analyzeReadWorkloadSet,
  extractReadAuthorityAtoms,
  normalizeReadWorkloadSet,
  sanitizeReadWorkloadPlan,
  type ReadWorkloadSet,
} from "./read-workload-assist.js";
import { validateExplorePlan } from "./scoped-explore.js";

describe("Read workload boundary compiler", () => {
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
