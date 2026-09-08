import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CATALOG_LIMITS, catalogResponseBytes, createInactiveSemanticActionRuntime } from "@synapsor-runner/mcp-server";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { describeBoundary, type ScopedExploreRuntime } from "./scoped-explore.js";
import { createScopedExploreMcpServer, projectDescribeDataForModel } from "./authoring-mcp.js";
import { readDiscoveryCompatibility } from "./auto-boundary.js";
import { readDiscoveryConcernLines } from "./read-discovery-compatibility.js";
const telecomOffer = JSON.parse(fs.readFileSync(new URL("./test-fixtures/telecom-offer-discovery.json", import.meta.url), "utf8")) as {
  context: Record<string, unknown>; resource: Record<string, unknown> & { id: string };
};
const telecomInvoice = JSON.parse(fs.readFileSync(new URL("./test-fixtures/telecom-invoice-discovery.json", import.meta.url), "utf8")) as typeof telecomOffer;

const digest = `sha256:${"a".repeat(64)}` as const;
function fixture(count = 32): ExplorationBoundaryDraft {
  const fields = ["status", ...Array.from({ length: count }, (_, i) => `business_value_${i}`)];
  return { schema_version: "synapsor.exploration-boundary.v1", activation: "disabled_unreviewed", deployment_profile: "staging",
    source: "local_postgres", compiler_version: "1.8.0", spec_version: "1.11.0", reporting_timezone: "UTC",
    trusted_context: { provider: "environment", tenant_env: "ACCOUNT", principal_env: "USER" },
    generation_lock_fingerprint: digest, role_posture_fingerprint: digest,
    budgets: structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS), unresolved_decisions: [],
    pack: { name: "reviewed", resources: [{ id: "service.offers", label: "Available offers", schema: "service", table: "offers",
      primary_key: "offer_id", tenant_key: "account_id", model_withheld_fields: ["offer_id"], kept_out_fields: ["account_id"],
      field_types: Object.fromEntries(["offer_id", "account_id", ...fields].map((id) => [id, "text"])),
      field_enums: { status: ["active", "expired"] }, field_metadata: { offer_id: { label: "Internal offer reference" } },
      selectable_fields: fields, filterable_fields: { status: ["eq", "in"] }, sortable_fields: ["status"],
      groupable_fields: ["status"], aggregate_measures: [], presence_measure_fields: ["status"], count_distinct_fields: ["status"],
      time_bucket_fields: {}, relationships: [], minimum_cohort_size: 5, suppression_aware_totals: true,
    }] } };
}
function rawContract(boundary: ExplorationBoundaryDraft) {
  return { ...describeBoundary(boundary, { resource: "service.offers" }), boundary_digest: digest,
    catalog_version: "synapsor.scoped-catalog.v2" };
}
function resource(value: Record<string, unknown>): any { return (value.resources as unknown[])[0]; }

describe("complete bounded Read contracts", () => {
  it.each([telecomOffer, telecomInvoice].flatMap((capture) => [undefined, "reviewed_staging"].map((selectedBoundary) =>
    ({ capture, selectedBoundary, resourceId: capture.resource.id }))))("fits captured $resourceId with its complete review-required relationship (boundary=$selectedBoundary)", async ({ capture, selectedBoundary }) => {
    // Pinned packed responses were 17,825 (offers) and 17,367 (invoices) bytes.
    // Inactive relationship guidance is part of runtime describe too, not just the active JSON file.
    const raw = { ...capture.context, resources: [capture.resource] };
    const baseline = projectDescribeDataForModel(raw, true);
    const runtime = { boundary: { pack: { name: "reviewed_staging", resources: [{ id: capture.resource.id }] }, activation: { digest } },
      session_fingerprint: digest, model_authority_metadata: "semantic", describe: async () => structuredClone(raw) } as unknown as ScopedExploreRuntime;
    const server = createScopedExploreMcpServer(runtime, { semanticActions: createInactiveSemanticActionRuntime() });
    const client = new Client({ name: "captured-telecom-contract", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const result = await client.callTool({ name: "app.describe_data", arguments: { resource: capture.resource.id,
        ...(selectedBoundary ? { boundary: selectedBoundary } : {}) } });
      expect(result.isError).not.toBe(true);
      const entry = resource(result.structuredContent as Record<string, unknown>), original = resource(baseline);
      expect(entry.fields).toHaveLength(11);
      expect(entry.relationships).toHaveLength(1);
      expect(entry.relationships[0]).toMatchObject({ id: original.relationships[0].id, activation: "review_required",
        operator_review_required: true, fields: expect.arrayContaining(original.relationships[0].fields.map(({ operations: _copy, plan_reference: _ref, ...field }: any) => field)) });
      for (const key of ["selectable_fields", "filter_operators", "groupable_fields", "field_enums", "model_withheld_fields",
        "maximum_rows", "maximum_groups", "minimum_cohort_size", "relative_time_window_fields", "valid_plan_examples"]) {
        expect(entry[key]).toEqual(original[key]);
      }
      for (const key of ["path", "cardinality", "counted_entity", "nullable", "unmatched_rows", "model_withheld_fields",
        "filter_operators", "groupable_fields", "field_enums", "aggregate_measure_functions", "presence_measure_fields", "time_bucket_fields"]) {
        expect(entry.relationships[0][key]).toEqual(original.relationships[0][key]);
      }
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(CATALOG_LIMITS.responseBytes);
    } finally { await client.close(); await server.close(); }
  });

  it("retains every operation, denial, enum and privacy fact in the resource maps without duplicating field copies", () => {
    const boundary = fixture(), raw = rawContract(boundary);
    const compact = projectDescribeDataForModel(raw, true), value = resource(compact);
    expect(Buffer.byteLength(JSON.stringify(resource(raw)))).toBeGreaterThan(CATALOG_LIMITS.detailBytes);
    expect(catalogResponseBytes(compact, "compact")).toBeLessThan(CATALOG_LIMITS.responseBytes);
    expect(value.fields).toHaveLength(34);
    expect(value.fields.every((f: any) => f.operations === undefined && f.allowed_values === undefined)).toBe(true);
    expect(value).toMatchObject({ selectable_fields: boundary.pack.resources[0]!.selectable_fields,
      filter_operators: { status: ["eq", "in"] }, sortable_fields: ["status"], groupable_fields: ["status"],
      presence_measure_fields: ["status"], presence_measure_functions: ["null_count", "non_null_count", "completion_rate"],
      count_distinct_fields: ["status"], model_withheld_fields: ["offer_id"], kept_out_field_count: 1,
      field_enums: { status: ["active", "expired"] }, minimum_cohort_size: 5 });
    expect(JSON.stringify(value)).not.toContain("account_id");
    expect(value.valid_plan_examples.rows.select).not.toContain("offer_id");
    expect(resource(raw).fields[0]).toHaveProperty("operations");
    expect(readDiscoveryCompatibility(boundary, digest)).toEqual([]);
  });

  it("does not drop a novel or inconsistent field constraint or allowlist", () => {
    const raw = rawContract(fixture(2));
    const status = resource(raw).fields.find((f: any) => f.id === "status");
    status.operations.future_operation = { maximum: 7 };
    status.allowed_values = ["active"];
    const projected = resource(projectDescribeDataForModel(raw, true));
    expect(projected.fields.find((f: any) => f.id === "status")).toMatchObject({
      operations: status.operations, allowed_values: ["active"],
    });
    expect(projected.field_enums).toEqual({ status: ["active", "expired"] });
  });

  it("keeps vocabulary warnings and unknown facts even when the summary says ready", () => {
    const raw = rawContract(fixture(2));
    resource(raw).vocabulary = { status: "ready", opaque_resource_without_vocabulary: false,
      opaque_fields_without_vocabulary: [], coded_fields_without_vocabulary: ["status"], additional_review: true };
    expect(resource(projectDescribeDataForModel(raw, true)).vocabulary).toEqual(resource(raw).vocabulary);
    resource(raw).vocabulary.coded_fields_without_vocabulary = [];
    expect(resource(projectDescribeDataForModel(raw, true)).vocabulary).toEqual({ status: "ready", additional_review: true });
  });

  it("surfaces an actionable preparation concern without mutating an over-budget draft", () => {
    const boundary = fixture(2);
    boundary.pack.resources[0]!.description = "Reviewed long description ".repeat(600);
    const before = structuredClone(boundary), concerns = readDiscoveryCompatibility(boundary, digest);
    expect(concerns).toEqual([{ resource: "service.offers", entry_bytes: expect.any(Number), response_bytes: expect.any(Number) }]);
    expect(concerns[0]!.entry_bytes).toBeGreaterThan(CATALOG_LIMITS.detailBytes);
    expect(readDiscoveryConcernLines(concerns).join("\n")).toMatch(/Discovery compatibility.*\nservice.offers: entry/u);
    expect(boundary).toEqual(before);
  });

  it.each([false, true])("returns a complete actual MCP contract or actionable refusal (oversized=%s)", async (oversized) => {
    const boundary = fixture();
    if (oversized) boundary.pack.resources[0]!.description = "x".repeat(15000);
    const runtime = { boundary: { ...boundary, activation: { digest } }, session_fingerprint: digest,
      model_authority_metadata: "semantic", describe: async () => describeBoundary(boundary, { resource: "service.offers" }) } as unknown as ScopedExploreRuntime;
    const server = createScopedExploreMcpServer(runtime, { semanticActions: createInactiveSemanticActionRuntime() });
    const client = new Client({ name: "bounded-read-regression", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const result = await client.callTool({ name: "app.describe_data", arguments: { resource: "service.offers" } });
      const payload = result.structuredContent as Record<string, unknown>;
      if (oversized) {
        expect(payload).toMatchObject({ ok: false, error_code: "CATALOG_CONTRACT_TOO_LARGE",
          details: { kind: "entry", measured_bytes: expect.any(Number), limit_bytes: 12288, retryable: false, recovery: "operator_boundary_review" } });
        expect(payload.message).toContain("Do not guess permissions");
        expect(payload).not.toHaveProperty("resources");
      } else {
        expect(result.isError).not.toBe(true);
        expect(resource(payload).fields).toHaveLength(34);
        expect(resource(payload).field_enums.status).toEqual(["active", "expired"]);
      }
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(CATALOG_LIMITS.responseBytes);
    } finally { await client.close(); await server.close(); }
  });
});
