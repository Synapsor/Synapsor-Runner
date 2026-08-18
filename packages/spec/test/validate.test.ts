import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertValidContract, normalizeContract, validateContract } from "../src/index.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, relativePath), "utf8"));
}

describe("@synapsor/spec validation", () => {
  it("accepts checked-in examples", () => {
    for (const file of fs.readdirSync(path.join(packageRoot, "examples")).filter((name) => name.endsWith(".json"))) {
      const result = validateContract(readJson(`examples/${file}`));
      expect(result.errors, file).toEqual([]);
      expect(result.ok, file).toBe(true);
    }
  });

  it("loads checked-in JSON Schema files", () => {
    for (const file of fs.readdirSync(path.join(packageRoot, "schemas")).filter((name) => name.endsWith(".json"))) {
      const schema = readJson(`schemas/${file}`);
      expect(schema, file).toMatchObject({ $schema: expect.any(String) });
    }
  });

  it("accepts valid fixtures", () => {
    const result = validateContract(readJson("fixtures/valid/basic-read.contract.json"));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("accepts an explicit empty capability array as a zero-authority review contract", () => {
    const contract = {
      spec_version: "0.1",
      kind: "SynapsorContract",
      contexts: [{
        name: "local_operator",
        bindings: [{
          name: "tenant_id",
          source: "environment",
          key: "SYNAPSOR_TENANT_ID",
          required: true,
        }],
        tenant_binding: "tenant_id",
      }],
      capabilities: [],
    };

    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });
    expect(normalizeContract(contract).capabilities).toEqual([]);
  });

  it("accepts explicit supervised-worker permission only for an exact guarded direct write", () => {
    const contract = writeContract();
    const capability = contract.capabilities[1]!;
    const proposal = capability.proposal as Record<string, unknown>;
    proposal.execution = { supervised_worker: "allowed" };

    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });
    expect(normalizeContract(contract).capabilities[1]?.proposal?.execution).toEqual({
      supervised_worker: "allowed",
    });
  });

  it("keeps legacy proposal normalization byte-equivalent when execution permission is absent", () => {
    const contract = writeContract();
    const before = JSON.stringify(normalizeContract(contract));
    expect(before).not.toContain("supervised_worker");
    expect(JSON.stringify(normalizeContract(structuredClone(contract)))).toBe(before);
  });

  it("rejects supervised-worker permission on delete, set, reversible, handler, or weak-guard writes", () => {
    const base = writeContract();
    const codesFor = (mutate: (proposal: Record<string, unknown>) => void) => {
      const contract = structuredClone(base);
      const proposal = contract.capabilities[1]!.proposal as Record<string, unknown>;
      proposal.execution = { supervised_worker: "allowed" };
      mutate(proposal);
      return validateContract(contract).errors.map((error) => error.code);
    };

    expect(codesFor((proposal) => {
      proposal.operation = { kind: "delete" };
      proposal.patch = {};
      proposal.allowed_fields = [];
      proposal.conflict_guard = { column: "updated_at" };
    })).toContain("SUPERVISED_WORKER_DELETE_FORBIDDEN");
    expect(codesFor((proposal) => {
      proposal.operation = {
        kind: "update",
        cardinality: "set",
        selection: { all: [{ column: "status", operator: "eq", value: "open" }] },
        max_rows: 10,
        aggregate_bounds: [{ column: "amount_cents", measure: "absolute_delta", maximum: 1000 }],
        version_advance: { column: "updated_at", strategy: "integer_increment" },
      };
    })).toContain("SUPERVISED_WORKER_SINGLE_ROW_REQUIRED");
    expect(codesFor((proposal) => {
      proposal.reversibility = { mode: "reviewed_inverse" };
    })).toContain("SUPERVISED_WORKER_REVERSIBILITY_FORBIDDEN");
    expect(codesFor((proposal) => {
      proposal.writeback = { mode: "app_handler", executor: "billing_handler" };
    })).toContain("SUPERVISED_WORKER_DIRECT_SQL_REQUIRED");
    expect(codesFor((proposal) => {
      proposal.conflict_guard = { weak_guard_ack: true };
    })).toContain("SUPERVISED_WORKER_EXACT_CONFLICT_GUARD_REQUIRED");
  });

  it("accepts reviewed aggregate reads with suppression and no model predicate surface", () => {
    const contract = aggregateReadContract();
    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });
    expect(normalizeContract(contract).capabilities[0]).toMatchObject({
      kind: "aggregate_read",
      args: {},
      visible_fields: [],
      aggregate: {
        function: "sum",
        column: "balance_cents",
        minimum_group_size: 5,
        selection: { all: [{ column: "status", operator: "eq", value: "overdue" }] },
      },
    });
  });

  it("accepts an explicit minimum group size of one", () => {
    const aggregate = aggregateReadContract();
    aggregate.capabilities[0].aggregate.minimum_group_size = 1;
    expect(validateContract(aggregate)).toMatchObject({ ok: true, errors: [] });

    const protectedAggregate = protectedAggregateContract();
    protectedAggregate.capabilities[0].protected_read.aggregate.minimum_group_size = 1;
    expect(validateContract(protectedAggregate)).toMatchObject({ ok: true, errors: [] });
  });

  it("rejects aggregate reads that expose member rows, model predicates, or invalid suppression", () => {
    const contract = aggregateReadContract();
    const capability = contract.capabilities[0];
    capability.args.minimum_balance = { type: "number", required: true };
    capability.visible_fields = ["id"];
    capability.aggregate.minimum_group_size = 0;

    const codes = validateContract(contract).errors.map((error) => error.code);
    expect(codes).toContain("AGGREGATE_MODEL_ARGS_FORBIDDEN");
    expect(codes).toContain("AGGREGATE_VISIBLE_ROWS_FORBIDDEN");
    expect(codes).toContain("AGGREGATE_MINIMUM_GROUP_SIZE_REQUIRED");
  });

  it("rejects a protected aggregate minimum group size below one", () => {
    const contract = protectedAggregateContract();
    contract.capabilities[0].protected_read.aggregate.minimum_group_size = 0;
    expect(validateContract(contract).errors.map((error) => error.code))
      .toContain("INVALID_PROTECTED_MINIMUM_GROUP_SIZE");
  });

  it("accepts reviewed dispersion and missing-data measures with a fixed dispersion floor", () => {
    for (const fn of ["stddev_samp", "stddev_pop", "var_samp", "var_pop"] as const) {
      const contract = protectedAggregateContract();
      contract.capabilities[0].protected_read.aggregate.measures = [{
        name: "spread",
        function: fn,
        field: "balance_cents",
      }];
      delete contract.capabilities[0].protected_read.aggregate.order_by;
      expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });
      contract.capabilities[0].protected_read.aggregate.minimum_group_size = 4;
      expect(validateContract(contract).errors.map((error) => error.code))
        .toContain("PROTECTED_DISPERSION_COHORT_TOO_SMALL");
    }

    for (const fn of ["null_count", "non_null_count", "completion_rate"] as const) {
      const contract = protectedAggregateContract();
      contract.capabilities[0].protected_read.aggregate.measures = [{
        name: "completeness",
        function: fn,
        field: "balance_cents",
      }];
      delete contract.capabilities[0].protected_read.aggregate.order_by;
      expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });
    }
  });

  it("accepts a digest-bound protected PM aggregate with reviewed dimensions and bounded arguments", () => {
    const contract = protectedAggregateContract();

    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });
    expect(normalizeContract(contract).capabilities[0]).toMatchObject({
      kind: "aggregate_read",
      args: {
        period_start: { type: "string", required: true, max_length: 32 },
        period_end: { type: "string", required: true, max_length: 32 },
      },
      visible_fields: [],
      protected_read: {
        version: "1",
        mode: "aggregate",
        aggregate: {
          counted_entity: "subject",
          measures: [
            { name: "churned_accounts", function: "count" },
            { name: "affected_customers", function: "count_distinct", field: "customer_id" },
          ],
          dimensions: [
            { name: "region", field: "region" },
            { name: "reason", field: "churn_reason" },
          ],
          time_bucket: { name: "churn_week", field: "churned_at", bucket: "week" },
          minimum_group_size: 5,
          top_n: 20,
        },
      },
    });
  });

  it("accepts one immutable single-organization scope and rejects contradictory tenant authority", () => {
    const contract = protectedAggregateContract();
    const capability = contract.capabilities[0];
    delete capability.subject.tenant_key;
    capability.protected_read.organization_scope = {
      mode: "single_organization",
      organization_id: "northgate-construction",
      acknowledgement: "all_rows_belong_to_one_organization",
    };
    contract.contexts[0].bindings = contract.contexts[0].bindings.map((binding: Record<string, unknown>) =>
      binding.name === contract.contexts[0].tenant_binding
        ? { ...binding, source: "reviewed_organization", key: "northgate-construction", required: true }
        : binding.name === contract.contexts[0].principal_binding
          ? { ...binding, required: true }
          : binding);
    capability.protected_read.relationships = [{
      name: "account",
      links: [{
        schema: "public",
        table: "accounts",
        primary_key: "id",
        principal_scope_key: "owner_id",
        local_key: "account_id",
        target_key: "id",
        cardinality: "many_to_one",
        max_fan_out: 1,
        unmatched_rows: "exclude",
      }],
    }];

    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });

    const conflictingRoot = structuredClone(contract);
    conflictingRoot.capabilities[0].subject.tenant_key = "tenant_id";
    expect(validateContract(conflictingRoot).errors.map((error) => error.code))
      .toContain("PROTECTED_SCOPE_MODES_CONFLICT");

    const conflictingRelationship = structuredClone(contract);
    conflictingRelationship.capabilities[0].protected_read.relationships[0].links[0].tenant_key = "tenant_id";
    expect(validateContract(conflictingRelationship).errors.map((error) => error.code))
      .toContain("PROTECTED_SCOPE_MODES_CONFLICT");

    const mismatchedContext = structuredClone(contract);
    mismatchedContext.contexts[0].bindings.find((binding: Record<string, unknown>) =>
      binding.name === mismatchedContext.contexts[0].tenant_binding).key = "another-organization";
    expect(validateContract(mismatchedContext).errors.map((error) => error.code))
      .toContain("PROTECTED_ORGANIZATION_BINDING_REQUIRED");
  });

  it("accepts only digest-bound ranked period movers with a reviewed underlying-group limit", () => {
    const contract = protectedAggregateContract();
    const protectedRead = contract.capabilities[0].protected_read;
    protectedRead.aggregate.comparison = {
      field: "churned_at",
      ranges: [
        { start: { fixed: "2026-06-01T00:00:00.000Z" }, end: { fixed: "2026-07-01T00:00:00.000Z" } },
        { start: { fixed: "2026-07-01T00:00:00.000Z" }, end: { fixed: "2026-08-01T00:00:00.000Z" } },
      ],
    };
    protectedRead.aggregate.order_by = {
      kind: "comparison_change",
      measure: "churned_accounts",
      change: "absolute",
      direction: "desc",
    };
    protectedRead.limits.max_ranked_groups = 500;
    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });
    expect(normalizeContract(contract).capabilities[0]?.protected_read).toMatchObject({
      aggregate: {
        order_by: { kind: "comparison_change", change: "absolute" },
      },
      limits: { max_groups: 50, max_ranked_groups: 500 },
    });

    const missingComparison = structuredClone(contract);
    delete missingComparison.capabilities[0].protected_read.aggregate.comparison;
    expect(validateContract(missingComparison).errors.map((error) => error.code))
      .toContain("PROTECTED_CHANGE_ORDER_REQUIRES_COMPARISON");

    const invalidLimit = structuredClone(contract);
    invalidLimit.capabilities[0].protected_read.limits.max_ranked_groups = 49;
    expect(validateContract(invalidLimit).errors.map((error) => error.code))
      .toContain("INVALID_PROTECTED_RANKED_GROUP_LIMIT");
  });

  it("accepts only canonical fixed protected time windows", () => {
    const contract = protectedAggregateContract();
    contract.capabilities[0].protected_read.time_window = {
      field: "churned_at",
      start: "2026-06-01T00:00:00.000Z",
      end: "2026-07-01T00:00:00.000Z",
    };
    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });
    expect(normalizeContract(contract).capabilities[0]?.protected_read?.time_window).toEqual({
      field: "churned_at",
      start: "2026-06-01T00:00:00.000Z",
      end: "2026-07-01T00:00:00.000Z",
    });

    const dynamic = structuredClone(contract);
    dynamic.capabilities[0].protected_read.time_window.start = { from_arg: "period_start" };
    expect(validateContract(dynamic).errors.map((error) => error.code))
      .toContain("INVALID_PROTECTED_TIME_WINDOW");

    const nonCanonical = structuredClone(contract);
    nonCanonical.capabilities[0].protected_read.time_window.start = "2026-06-01T00:00:00Z";
    expect(validateContract(nonCanonical).errors.map((error) => error.code))
      .toContain("INVALID_PROTECTED_TIME_WINDOW");

    const reversed = structuredClone(contract);
    reversed.capabilities[0].protected_read.time_window.end = "2026-05-01T00:00:00.000Z";
    expect(validateContract(reversed).errors.map((error) => error.code))
      .toContain("INVALID_PROTECTED_TIME_WINDOW");

    const unknown = structuredClone(contract);
    unknown.capabilities[0].protected_read.time_window.offset = "P1M";
    expect(validateContract(unknown).errors.map((error) => error.code))
      .toContain("UNKNOWN_CORE_FIELD");

    const conflicting = structuredClone(contract);
    conflicting.capabilities[0].protected_read.aggregate.comparison = {
      field: "churned_at",
      ranges: [
        { start: { fixed: "2026-05-01T00:00:00.000Z" }, end: { fixed: "2026-06-01T00:00:00.000Z" } },
        { start: { fixed: "2026-06-01T00:00:00.000Z" }, end: { fixed: "2026-07-01T00:00:00.000Z" } },
      ],
    };
    expect(validateContract(conflicting).errors.map((error) => error.code))
      .toContain("PROTECTED_TIME_SELECTION_CONFLICT");
  });

  it("accepts only fixed contributor-safe reviewed derived measures", () => {
    const contract = protectedAggregateContract();
    contract.capabilities[0].protected_read.aggregate.measures = [{
      name: "revenue_per_customer",
      function: "reviewed_derived",
      derived: {
        shape: "per_unit_average",
        numerator: { function: "sum", field: "balance_cents" },
        denominator: { function: "count_distinct", field: "customer_id" },
        null_policy: "null_on_zero_or_null_denominator",
      },
    }];
    delete contract.capabilities[0].protected_read.aggregate.order_by;
    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });

    const formula = structuredClone(contract);
    formula.capabilities[0].protected_read.aggregate.measures[0].derived.formula = "SUM(balance_cents) / COUNT(DISTINCT customer_id)";
    expect(validateContract(formula).errors.map((error) => error.code)).toContain("UNKNOWN_CORE_FIELD");

    const lowCohort = structuredClone(contract);
    lowCohort.capabilities[0].protected_read.aggregate.minimum_group_size = 1;
    expect(validateContract(lowCohort).errors.map((error) => error.code)).toContain("PROTECTED_DISPERSION_COHORT_TOO_SMALL");
  });

  it("accepts only fixed post-suppression calculations with a compatible reviewed grain", () => {
    const running = protectedAggregateContract();
    running.capabilities[0].protected_read.aggregate.measures = [{
      name: "running_churn",
      function: "reviewed_derived",
      derived: {
        shape: "running_total",
        base_measure: { function: "count" },
      },
    }];
    running.capabilities[0].protected_read.aggregate.order_by = {
      kind: "time_bucket",
      direction: "asc",
    };
    running.capabilities[0].protected_read.limits.max_ranked_groups = 500;
    expect(validateContract(running)).toMatchObject({ ok: true, errors: [] });

    const missingTime = structuredClone(running);
    delete missingTime.capabilities[0].protected_read.aggregate.time_bucket;
    expect(validateContract(missingTime).errors.map((error) => error.code))
      .toContain("PROTECTED_TRANSFORM_TIME_BUCKET_REQUIRED");

    const rank = structuredClone(running);
    rank.capabilities[0].protected_read.aggregate.measures[0].derived = {
      shape: "rank",
      base_measure: { function: "count" },
      direction: "desc",
    };
    delete rank.capabilities[0].protected_read.aggregate.time_bucket;
    rank.capabilities[0].protected_read.aggregate.order_by = {
      kind: "measure",
      measure: "running_churn",
      direction: "asc",
    };
    expect(validateContract(rank)).toMatchObject({ ok: true, errors: [] });

    const noDimension = structuredClone(rank);
    delete noDimension.capabilities[0].protected_read.aggregate.dimensions;
    expect(validateContract(noDimension).errors.map((error) => error.code))
      .toContain("PROTECTED_TRANSFORM_DIMENSION_REQUIRED");

    const modelFormula = structuredClone(running);
    modelFormula.capabilities[0].protected_read.aggregate.measures[0].derived.formula = "running_sum(balance_cents)";
    expect(validateContract(modelFormula).errors.map((error) => error.code))
      .toContain("UNKNOWN_CORE_FIELD");
  });

  it("accepts only complete bounded numeric-band dimensions", () => {
    const contract = protectedAggregateContract();
    contract.capabilities[0].protected_read.aggregate.dimensions = [{
      name: "balance_band",
      field: "balance_cents",
      numeric_band: {
        edges: [1_000, 5_000],
        bucket_labels: ["under 10", "10 to 49", "50 or more"],
      },
    }];
    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });

    const unordered = structuredClone(contract);
    unordered.capabilities[0].protected_read.aggregate.dimensions[0].numeric_band.edges = [5_000, 1_000];
    expect(validateContract(unordered).errors.map((error) => error.code))
      .toContain("INVALID_PROTECTED_NUMERIC_BAND_EDGES");

    const partial = structuredClone(contract);
    partial.capabilities[0].protected_read.aggregate.dimensions[0].numeric_band.bucket_labels = ["under 10"];
    expect(validateContract(partial).errors.map((error) => error.code))
      .toContain("INVALID_PROTECTED_NUMERIC_BAND_LABELS");
  });

  it("accepts additive reviewed star paths without rewriting the legacy relationship form", () => {
    const contract = protectedAggregateContract();
    const protectedRead = contract.capabilities[0].protected_read;
    protectedRead.relationships = [
      protectedPath("store", "store_id", "stores"),
      protectedPath("category", "category_id", "product_categories"),
    ];
    protectedRead.aggregate.dimensions = [
      { name: "store_name", field: "name", relationship: "store" },
      { name: "category_name", field: "name", relationship: "category" },
    ];

    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });
    expect(normalizeContract(contract).capabilities[0]?.protected_read).toMatchObject({
      relationships: [
        { name: "store", links: [{ cardinality: "many_to_one", max_fan_out: 1 }] },
        { name: "category", links: [{ cardinality: "many_to_one", max_fan_out: 1 }] },
      ],
    });

    const legacy = protectedAggregateContract();
    legacy.capabilities[0].protected_read.relationship = {
      name: "store",
      schema: "public",
      table: "stores",
      primary_key: "id",
      tenant_key: "tenant_id",
      local_key: "store_id",
      target_key: "id",
      cardinality: "many_to_one",
      max_fan_out: 1,
    };
    const normalizedLegacy = JSON.stringify(normalizeContract(legacy));
    expect(normalizedLegacy).toContain('"relationship"');
    expect(normalizedLegacy).not.toContain('"relationships"');
    expect(JSON.stringify(normalizeContract(structuredClone(legacy)))).toBe(normalizedLegacy);
  });

  it("rejects widening, unsafe scope fields, unbound arguments, and fan-out in protected reads", () => {
    const contract = protectedAggregateContract();
    const capability = contract.capabilities[0];
    capability.args.unused = { type: "string", required: true };
    capability.protected_read.predicates.push({
      field: "tenant_id",
      operator: "eq",
      value: { from_arg: "period_start" },
    });
    capability.protected_read.relationship = {
      name: "customer",
      schema: "public",
      table: "customers",
      primary_key: "id",
      tenant_key: "tenant_id",
      local_key: "customer_id",
      target_key: "id",
      cardinality: "many_to_many",
      max_fan_out: 20,
    };
    capability.kept_out_fields.push("customer_id");
    capability.evidence.query_audit = false;

    const codes = validateContract(contract).errors.map((error) => error.code);
    expect(codes).toContain("PROTECTED_READ_UNUSED_ARG");
    expect(codes).toContain("PROTECTED_FIELD_FORBIDDEN");
    expect(codes).toContain("PROTECTED_RELATIONSHIP_CARDINALITY_FORBIDDEN");
    expect(codes).toContain("PROTECTED_RELATIONSHIP_LOCAL_KEY_FORBIDDEN");
    expect(codes).toContain("PROTECTED_READ_EVIDENCE_REQUIRED");
  });

  it("does not synthesize protected-read fields into legacy canonical contracts", () => {
    const legacy = readJson("fixtures/valid/basic-read.contract.json");
    const normalized = normalizeContract(legacy);

    expect(normalized).toEqual(JSON.parse(JSON.stringify(normalized)));
    expect(normalized.capabilities.every((capability) => capability.protected_read === undefined)).toBe(true);
    expect(normalized.capabilities.every((capability) =>
      capability.model_withheld_fields === undefined)).toBe(true);

    const withEgressTier = structuredClone(normalized);
    withEgressTier.capabilities[0]!.model_withheld_fields = ["status"];
    expect(validateContract(withEgressTier)).toMatchObject({ ok: true, errors: [] });
    expect(JSON.stringify(normalizeContract(withEgressTier))).toContain(
      '"model_withheld_fields":["status"]',
    );
  });

  it("accepts typed argument enums and rejects non-canonical enum values", () => {
    const contract = readJson("fixtures/valid/basic-read.contract.json") as Record<string, any>;
    contract.capabilities[0].args.risk_level = { type: "string", required: true, enum: ["low", "medium", "high"] };
    contract.capabilities[0].args.retry_count = { type: "number", required: true, enum: [0, 1, 2] };
    contract.capabilities[0].args.notify = { type: "boolean", required: false, enum: [true, false] };
    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });

    contract.capabilities[0].args.risk_level.enum = ["low", "low", 2, null];
    const codes = validateContract(contract).errors.map((error) => error.code);
    expect(codes).toContain("ARG_ENUM_DUPLICATE_VALUE");
    expect(codes).toContain("ARG_ENUM_TYPE_MISMATCH");
  });

  it("rejects model-controlled tenant args", () => {
    const result = validateContract(readJson("fixtures/invalid/model-controlled-tenant.contract.json"));
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("MODEL_CONTROLLED_TRUST_ARG");
  });

  it("rejects kept-out fields that are also visible", () => {
    const result = validateContract(readJson("fixtures/invalid/kept-out-visible.contract.json"));
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("KEPT_OUT_FIELD_VISIBLE");
  });

  it("rejects fields that are both model-withheld and kept out", () => {
    const contract = readJson("fixtures/valid/basic-read.contract.json") as Record<string, any>;
    contract.capabilities[0].model_withheld_fields = ["card_token"];

    const result = validateContract(contract);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("MODEL_WITHHELD_FIELD_KEPT_OUT");
  });

  it("accepts a tenant-additive principal scope backed by a required trusted binding", () => {
    const contract = readJson("fixtures/valid/basic-read.contract.json") as Record<string, any>;
    contract.contexts[0].bindings.find((binding: Record<string, unknown>) => binding.name === "principal").required = true;
    contract.capabilities[0].subject.principal_scope_key = "assigned_to";

    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });
    expect(normalizeContract(contract).capabilities[0]?.subject.principal_scope_key).toBe("assigned_to");
  });

  it("accepts principal scope when tenant authority comes from a referenced resource", () => {
    const contract = readJson("examples/guarded-writeback.contract.json") as Record<string, any>;
    contract.capabilities[0].subject = {
      resource: contract.resources[0].name,
      principal_scope_key: "assigned_to",
    };

    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });
    expect(normalizeContract(contract).capabilities[0]?.subject).toMatchObject({
      resource: contract.resources[0].name,
      principal_scope_key: "assigned_to",
    });
  });

  it("rejects principal scope without tenant scope or a required trusted principal binding", () => {
    const contract = readJson("fixtures/valid/basic-read.contract.json") as Record<string, any>;
    contract.capabilities[0].subject.principal_scope_key = "assigned_to";
    delete contract.capabilities[0].subject.tenant_key;
    expect(validateContract(contract).errors.map((error) => error.code)).toContain("PRINCIPAL_SCOPE_TENANT_REQUIRED");

    contract.capabilities[0].subject.tenant_key = "tenant_id";
    expect(validateContract(contract).errors.map((error) => error.code)).toContain("PRINCIPAL_SCOPE_BINDING_REQUIRED");
    contract.contexts[0].bindings.find((binding: Record<string, unknown>) => binding.name === "principal").required = false;
    expect(validateContract(contract).errors.map((error) => error.code)).toContain("PRINCIPAL_SCOPE_BINDING_REQUIRED");
  });

  it("rejects model-writeable principal scope columns", () => {
    const contract = writeContract();
    contract.contexts[0].bindings.find((binding: Record<string, unknown>) => binding.name === "principal").required = true;
    contract.capabilities[1].subject.principal_scope_key = "assigned_to";
    contract.capabilities[1].proposal.allowed_fields.push("assigned_to");
    contract.capabilities[1].proposal.patch.assigned_to = { from_arg: "waiver_reason" };

    const codes = validateContract(contract).errors.map((error) => error.code);
    expect(codes).toContain("PRINCIPAL_SCOPE_WRITE_FORBIDDEN");
  });

  it("normalizes deterministically", () => {
    const input = readJson("examples/guarded-writeback.contract.json");
    const first = normalizeContract(input);
    const second = normalizeContract(JSON.parse(JSON.stringify(first)));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("throws useful assertion errors", () => {
    expect(() => assertValidContract({})).toThrow(/UNSUPPORTED_SPEC_VERSION/);
  });

  it("validates conformance contracts", () => {
    const conformanceRoot = path.join(packageRoot, "fixtures/conformance");
    for (const fixture of fs.readdirSync(conformanceRoot)) {
      const contractPath = path.join(conformanceRoot, fixture, "contract.json");
      if (!fs.existsSync(contractPath)) continue;
      const result = validateContract(JSON.parse(fs.readFileSync(contractPath, "utf8")));
      expect(result.errors, fixture).toEqual([]);
      expect(result.ok, fixture).toBe(true);
    }
  });

  it("accepts and normalizes portable proposal safety fields", () => {
    const normalized = normalizeContract(readJson("fixtures/conformance/numeric-bounds/contract.json"));
    const capability = normalized.capabilities.find((item) => item.name === "support.propose_plan_credit");

    expect(capability?.returns_hint).toContain("DB unchanged");
    expect(capability?.args.amount_cents).toMatchObject({
      description: "Credit amount in cents.",
      minimum: 1,
      maximum: 1000000,
    });
    expect(capability?.args.reason).toMatchObject({
      description: "Business reason for the credit.",
      max_length: 500,
    });
    expect(capability?.proposal?.numeric_bounds).toEqual({
      credit_requested_cents: { minimum: 1, maximum: 2500 },
    });
  });

  it("still rejects unknown core fields", () => {
    const contract = readJson("fixtures/conformance/numeric-bounds/contract.json") as Record<string, unknown>;
    const capabilities = contract.capabilities as Array<Record<string, unknown>>;
    capabilities[0].unexpected_core_field = true;

    const result = validateContract(contract);

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("UNKNOWN_CORE_FIELD");
  });

  it("keeps omitted operation semantics backward-compatible with UPDATE", () => {
    const contract = readJson("examples/guarded-writeback.contract.json") as Record<string, any>;
    expect(contract.capabilities[1].proposal.operation).toBeUndefined();
    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });
  });

  it("accepts guarded INSERT with source-enforced proposal deduplication", () => {
    const contract = writeContract();
    const proposal = contract.capabilities[1].proposal;
    proposal.action = "billing.create_credit";
    proposal.operation = {
      kind: "insert",
      deduplication: {
        components: [
          { column: "tenant_id", source: "trusted_tenant" },
          { column: "request_id", source: "proposal_id" },
        ],
      },
    };
    proposal.allowed_fields = ["amount_cents", "reason"];
    proposal.patch = { amount_cents: { fixed: 500 }, reason: { from_arg: "waiver_reason" } };
    delete proposal.conflict_guard;

    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });
  });

  it("rejects INSERT without proposal-specific source deduplication", () => {
    const contract = writeContract();
    const proposal = contract.capabilities[1].proposal;
    proposal.operation = {
      kind: "insert",
      deduplication: { components: [{ column: "tenant_id", source: "trusted_tenant" }] },
    };

    const codes = validateContract(contract).errors.map((error) => error.code);
    expect(codes).toContain("PROPOSAL_DEDUPLICATION_REQUIRED");
  });

  it("accepts guarded DELETE without a patch and rejects weak DELETE guards", () => {
    const contract = writeContract();
    const proposal = contract.capabilities[1].proposal;
    proposal.action = "billing.delete_credit";
    proposal.operation = { kind: "delete" };
    proposal.allowed_fields = [];
    proposal.patch = {};

    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });

    proposal.conflict_guard = { weak_guard_ack: true };
    expect(validateContract(contract).errors.map((error) => error.code)).toContain("DELETE_CONFLICT_GUARD_REQUIRED");
  });

  it("rejects policy auto-approval for direct hard DELETE", () => {
    const contract = writeContract();
    const proposal = contract.capabilities[1].proposal;
    proposal.action = "billing.delete_credit";
    proposal.operation = { kind: "delete" };
    proposal.allowed_fields = [];
    proposal.patch = {};
    proposal.approval = { mode: "policy", role: "support_lead", policy: "low_risk_waiver" };

    expect(validateContract(contract).errors.map((error) => error.code)).toContain("HARD_DELETE_HUMAN_APPROVAL_REQUIRED");
  });

  it("validates UPDATE version advancement against its conflict guard", () => {
    const contract = writeContract();
    const proposal = contract.capabilities[1].proposal;
    proposal.operation = {
      kind: "update",
      version_advance: { column: "updated_at", strategy: "database_generated" },
    };
    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });

    proposal.operation.version_advance.column = "other_version";
    expect(validateContract(contract).errors.map((error) => error.code)).toContain("VERSION_ADVANCE_GUARD_MISMATCH");
  });

  it("accepts reviewed reversible UPDATE and rejects weakened compensation authority", () => {
    const contract = writeContract();
    const capability = contract.capabilities[1];
    capability.subject.conflict_key = "version";
    capability.visible_fields = [...capability.visible_fields.filter((field: string) => field !== "updated_at"), "version"];
    capability.proposal.conflict_guard = { column: "version" };
    capability.proposal.operation = { kind: "update", version_advance: { column: "version", strategy: "integer_increment" } };
    capability.proposal.reversibility = { mode: "reviewed_inverse" };

    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });

    capability.proposal.approval = { mode: "policy", policy: "small_credit" };
    expect(validateContract(contract).errors.map((error) => error.code)).toContain("REVERSIBILITY_HUMAN_APPROVAL_REQUIRED");
    capability.proposal.approval = { mode: "human", required_role: "reviewer" };
    capability.proposal.writeback = { mode: "app_handler", executor: "billing_handler" };
    expect(validateContract(contract).errors.map((error) => error.code)).toContain("REVERSIBILITY_DIRECT_SQL_REQUIRED");
  });

  it("requires deterministic primary-key authority for reversible INSERT", () => {
    const contract = writeContract();
    const capability = contract.capabilities[1];
    capability.proposal.action = "billing.create_credit";
    capability.proposal.allowed_fields = ["late_fee_cents", "waiver_reason"];
    capability.proposal.conflict_guard = undefined;
    capability.proposal.operation = {
      kind: "insert",
      deduplication: { components: [
        { column: "tenant_id", source: "trusted_tenant" },
        { column: "request_id", source: "proposal_id" },
      ] },
    };
    capability.proposal.reversibility = { mode: "reviewed_inverse" };

    expect(validateContract(contract).errors.map((error) => error.code)).toContain("REVERSIBILITY_PRIMARY_KEY_DEDUP_REQUIRED");
    capability.proposal.operation.deduplication.components.push({ column: "id", source: "proposal_id" });
    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });
  });

  it("accepts policy-based auto-approval contracts", () => {
    const result = validateContract(readJson("fixtures/conformance/auto-approval/contract.json"));

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("accepts bounded approval quorum and rejects unsafe quorum values", () => {
    const contract = readJson("fixtures/conformance/manual-approval/contract.json") as Record<string, any>;
    contract.capabilities[0].proposal.approval.required_approvals = 2;
    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });

    contract.capabilities[0].proposal.approval.required_approvals = 0;
    expect(validateContract(contract).errors.map((error) => error.code)).toContain("INVALID_REQUIRED_APPROVALS");
    contract.capabilities[0].proposal.approval.required_approvals = 11;
    expect(validateContract(contract).errors.map((error) => error.code)).toContain("INVALID_REQUIRED_APPROVALS");
  });

  it("accepts reviewed aggregate auto-approval limits", () => {
    const contract = cloneAutoApprovalContract();
    (contract.policies as Array<Record<string, unknown>>)[0]!.limits = [
      { kind: "count", max: 20, period: "day", scope: "tenant_policy" },
      { kind: "total", field: "plan_credit_cents", max: 100000, period: "day", scope: "tenant_policy" },
    ];

    const result = validateContract(contract);

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects malformed aggregate auto-approval limits", () => {
    const contract = cloneAutoApprovalContract();
    (contract.policies as Array<Record<string, unknown>>)[0]!.limits = [
      { kind: "total", max: 100000, period: "week" },
      { kind: "count", field: "credit_requested_cents", max: -1, period: "day" },
    ];

    const result = validateContract(contract);
    const codes = result.errors.map((error) => error.code);

    expect(result.ok).toBe(false);
    expect(codes).toContain("APPROVAL_POLICY_TOTAL_FIELD_REQUIRED");
    expect(codes).toContain("INVALID_APPROVAL_POLICY_LIMIT_PERIOD");
    expect(codes).toContain("APPROVAL_POLICY_COUNT_FIELD_FORBIDDEN");
    expect(codes).toContain("INVALID_APPROVAL_POLICY_LIMIT_MAX");
  });

  it("rejects policy approval without a matching approval policy", () => {
    const contract = cloneAutoApprovalContract();
    delete ((contract.capabilities as Array<any>)[0].proposal.approval as Record<string, unknown>).policy;

    const missing = validateContract(contract);
    expect(missing.ok).toBe(false);
    expect(missing.errors.map((error) => error.code)).toContain("APPROVAL_POLICY_REQUIRED");

    ((contract.capabilities as Array<any>)[0].proposal.approval as Record<string, unknown>).policy = "missing_policy";
    const unknown = validateContract(contract);
    expect(unknown.ok).toBe(false);
    expect(unknown.errors.map((error) => error.code)).toContain("UNKNOWN_APPROVAL_POLICY");
  });

  it("rejects policy approval references to non-approval policies", () => {
    const contract = cloneAutoApprovalContract();
    ((contract.policies as Array<any>)[0] as Record<string, unknown>).kind = "settlement";

    const result = validateContract(contract);

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("APPROVAL_POLICY_KIND_REQUIRED");
  });

  it("rejects approval.policy unless approval.mode is policy", () => {
    const contract = cloneAutoApprovalContract();
    ((contract.capabilities as Array<any>)[0].proposal.approval as Record<string, unknown>).mode = "human";

    const result = validateContract(contract);

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("APPROVAL_POLICY_MODE_REQUIRED");
  });

  it("rejects approval policy rule fields that are not numeric proposal fields", () => {
    const contract = cloneAutoApprovalContract();
    ((contract.policies as Array<any>)[0].rules as Array<Record<string, unknown>>)[0].field = "credit_reason";

    const result = validateContract(contract);

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("APPROVAL_POLICY_FIELD_NOT_NUMERIC");
  });

  it("rejects approval policy max above numeric bounds", () => {
    const contract = cloneAutoApprovalContract();
    ((contract.policies as Array<any>)[0].rules as Array<Record<string, unknown>>)[0].max = 50001;

    const result = validateContract(contract);

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("APPROVAL_POLICY_MAX_EXCEEDS_BOUND");
  });
});

function cloneAutoApprovalContract(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(readJson("fixtures/conformance/auto-approval/contract.json"))) as Record<string, unknown>;
}

function writeContract(): Record<string, any> {
  const contract = readJson("examples/guarded-writeback.contract.json") as Record<string, any>;
  contract.capabilities[1].subject = {
    schema: "public",
    table: "credits",
    primary_key: "id",
    tenant_key: "tenant_id",
    conflict_key: "updated_at",
  };
  return contract;
}

function aggregateReadContract(): Record<string, any> {
  const contract = readJson("fixtures/valid/basic-read.contract.json") as Record<string, any>;
  contract.capabilities[0] = {
    ...contract.capabilities[0],
    name: "billing.sum_overdue_balance",
    kind: "aggregate_read",
    args: {},
    lookup: undefined,
    visible_fields: [],
    kept_out_fields: ["customer_email", "private_notes"],
    aggregate: {
      function: "sum",
      column: "balance_cents",
      selection: { all: [{ column: "status", operator: "eq", value: "overdue" }] },
      minimum_group_size: 5,
    },
  };
  delete contract.capabilities[0].lookup;
  return contract;
}

function protectedAggregateContract(): Record<string, any> {
  const contract = readJson("fixtures/valid/basic-read.contract.json") as Record<string, any>;
  contract.capabilities[0] = {
    ...contract.capabilities[0],
    name: "analytics.churn_contributors_by_week",
    description: "Describe reviewed weekly churn contributors without exposing member rows.",
    returns_hint: "Returns privacy-suppressed weekly groups and reviewed aggregate measures.",
    kind: "aggregate_read",
    args: {
      period_start: { type: "string", required: true, max_length: 32 },
      period_end: { type: "string", required: true, max_length: 32 },
    },
    visible_fields: [],
    kept_out_fields: ["email", "notes"],
    evidence: { required: true, query_audit: true },
    protected_read: {
      version: "1",
      mode: "aggregate",
      boundary_digest: `sha256:${"a".repeat(64)}`,
      generation_lock_fingerprint: `sha256:${"b".repeat(64)}`,
      predicates: [
        { field: "status", operator: "eq", value: { fixed: "churned" } },
        { field: "churned_at", operator: "gte", value: { from_arg: "period_start" } },
        { field: "churned_at", operator: "lt", value: { from_arg: "period_end" } },
      ],
      aggregate: {
        counted_entity: "subject",
        measures: [
          { name: "churned_accounts", function: "count" },
          { name: "affected_customers", function: "count_distinct", field: "customer_id" },
        ],
        dimensions: [
          { name: "region", field: "region" },
          { name: "reason", field: "churn_reason" },
        ],
        time_bucket: { name: "churn_week", field: "churned_at", bucket: "week" },
        order_by: { kind: "measure", measure: "churned_accounts", direction: "desc" },
        top_n: 20,
        minimum_group_size: 5,
      },
      limits: {
        max_rows: 50,
        max_groups: 50,
        max_response_cells: 500,
        max_response_bytes: 65536,
        statement_timeout_ms: 3000,
        max_queries_per_session: 40,
        max_extracted_cells_per_session: 4000,
        max_differencing_queries: 6,
        rate_limit_per_minute: 20,
      },
    },
  };
  delete contract.capabilities[0].lookup;
  return contract;
}

function protectedPath(name: string, localKey: string, table: string): Record<string, unknown> {
  return {
    name,
    links: [{
      schema: "public",
      table,
      primary_key: "id",
      tenant_key: "tenant_id",
      local_key: localKey,
      target_key: "id",
      cardinality: "many_to_one",
      max_fan_out: 1,
      unmatched_rows: "exclude",
    }],
  };
}
