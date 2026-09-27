import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CATALOG_LIMITS, catalogResponseBytes, createInactiveSemanticActionRuntime } from "@synapsor-runner/mcp-server";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ActivatedExplorationBoundary, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { describeBoundary, validateExplorePlan, type ScopedExploreRuntime } from "./scoped-explore.js";
import { createScopedExploreMcpServer, projectDescribeDataForModel } from "./authoring-mcp.js";
import { readDiscoveryCompatibility } from "./auto-boundary.js";
import { readDiscoveryConcernLines } from "./read-discovery-compatibility.js";
import { askToolSurfaceDigest, resolveAskProviderConfiguration, runAskProviderTurn, type AskToolGateway } from "./model-ask.js";
import { askToolResultViews } from "./ask-mcp-gateway.js";
const telecomOffer = JSON.parse(fs.readFileSync(new URL("./test-fixtures/telecom-offer-discovery.json", import.meta.url), "utf8")) as {
  context: Record<string, unknown>; resource: Record<string, unknown> & { id: string };
};
const telecomInvoice = JSON.parse(fs.readFileSync(new URL("./test-fixtures/telecom-invoice-discovery.json", import.meta.url), "utf8")) as typeof telecomOffer;
const universityRegistration = JSON.parse(fs.readFileSync(new URL("./test-fixtures/university-registration-discovery-resource.json", import.meta.url), "utf8")) as ExplorationBoundaryDraft["pack"]["resources"][number];
const universityWaitlist = JSON.parse(fs.readFileSync(new URL("./test-fixtures/university-waitlist-discovery-resource.json", import.meta.url), "utf8")) as ExplorationBoundaryDraft["pack"]["resources"];

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
  const localConsumer = process.env.SYNAPSOR_TEST_DISCOVERY_CONSUMER_OLLAMA === "1";
  it.skipIf(process.env.SYNAPSOR_TEST_DISCOVERY_CONSUMER_LIVE !== "1" && !localConsumer)(`live ${localConsumer ? "Ollama" : "Terra"} consumes grouped permissions into an exact composite plan (metadata/validation only)`, async () => {
    if (!localConsumer && !process.env.OPENAI_API_KEY) throw new Error("Explicit live qualification requires OPENAI_API_KEY");
    const boundary = fixture();
    boundary.pack.name = "reviewed_staging";
    boundary.pack.resources = structuredClone(universityWaitlist);
    const id = "university.waitlist_offers";
    // In-memory validation fixture only: no authority is persisted or activated.
    const validationBoundary: ActivatedExplorationBoundary = { ...boundary, activation: {
      state: "active", digest, actor: "contract-test", activated_at: "2026-09-10T00:00:00Z",
      generation_lock_fingerprint: digest, reviewed_decisions: [],
    } };
    const raw = describeBoundary(boundary, { resource: id });
    const runtime = { boundary: { ...boundary, activation: { digest } }, session_fingerprint: digest,
      model_authority_metadata: "semantic", describe: async () => structuredClone(raw) } as unknown as ScopedExploreRuntime;
    const server = createScopedExploreMcpServer(runtime, { semanticActions: createInactiveSemanticActionRuntime() });
    const client = new Client({ name: "live-grouped-contract-consumer", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const plans: Record<string, unknown>[] = [];
    const attempts: unknown[] = [];
    let described = false;
    try {
      await server.connect(st); await client.connect(ct);
      const tools = (await client.listTools()).tools.map(tool => ({ name: tool.name, description: tool.description ?? "", input_schema: tool.inputSchema }));
      expect(tools.map(tool => tool.name).sort()).toEqual(["app.describe_actions", "app.describe_data", "app.explore_data", "app.request_change"]);
      const gateway: AskToolGateway = { mode: "authoring", listTools: () => tools, close: async () => {}, callTool: async (name, args) => {
        if (name === "app.describe_data") {
          const response = await client.callTool({ name, arguments: { resource: id } });
          expect(response.isError).not.toBe(true);
          expect(resource(response.structuredContent as Record<string, unknown>)).toHaveProperty("contract_encoding", "grouped_operations.v1");
          described = true;
          return { ok: true, value: response.structuredContent as Record<string, unknown> };
        }
        if (name !== "app.explore_data") throw new Error("Only Read discovery and plan validation are part of this test");
        expect(described).toBe(true);
        const plan = args.plan as Record<string, unknown>;
        try {
          validateExplorePlan(plan, validationBoundary);
          attempts.push({ plan, validated: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Runtime plan validation failed";
          attempts.push({ arguments: args, error: message });
          // Use the real MCP schema refusal, including its exact key/path diagnostics.
          const refused = await client.callTool({ name, arguments: args });
          expect(refused.isError).toBe(true);
          const value = askToolResultViews(refused).provider;
          return { ok: false, error_code: typeof value.error_code === "string" ? value.error_code : "MCP_TOOL_ARGUMENTS_INVALID", value };
        }
        plans.push(plan);
        return { ok: true, value: { plan_validated: true, source_query_executed: false, source_database_changed: false,
          message: "This contract-consumer test validates the plan only; it does not read source rows." } };
      } };
      const authorityDigest = askToolSurfaceDigest(tools);
      const configuration = resolveAskProviderConfiguration({ ...(localConsumer
        ? { provider: "openai_compatible" as const, model: "qwen2.5:7b", base_url: "http://127.0.0.1:11434/v1", request_timeout_seconds: 120 }
        : { provider: "openai" as const, model: "gpt-5.6-terra", api_key_env: "OPENAI_API_KEY" }),
        egress_acknowledged: true, authority_digest: authorityDigest }, process.env, new Date());
      const turn = await runAskProviderTurn({ configuration, question: `Inspect the exact contract for ${id}, then submit a rows plan for offered seats showing offer state, related registration state, section label, and course code/title. Filter offer_state to active. Do not select internal IDs or any unrelated information. This is a metadata and plan-validation test, not a source-data query.`,
        history: [], gateway, tools, authorityDigest, signal: new AbortController().signal, requiredInitialToolName: "app.describe_data" });
      expect(plans, JSON.stringify({ attempts, answer: turn.answer })).toHaveLength(1);
      expect(plans[0]).toMatchObject({ resource: id, kind: "rows", select: ["offer_state"], where: [{ field: "offer_state", op: "eq", value: "active" }] });
      const related = plans[0]!.related as Array<{ relationship: string; select: string[] }>;
      expect(related).toHaveLength(3);
      expect(related.flatMap(entry => entry.select).sort()).toEqual(["course_code", "course_title", "registration_state", "section_label"]);
    } finally { await client.close(); await server.close(); }
  }, 240_000);

  it.each(["semantic", "exact"] as const)("returns the captured three-link waitlist contract completely (%s)", async (mode) => {
    const boundary = fixture();
    boundary.pack.name = "reviewed_staging";
    boundary.pack.resources = structuredClone(universityWaitlist);
    const id = "university.waitlist_offers";
    const before = structuredClone(boundary);
    const raw = describeBoundary(boundary, { resource: id });
    const baseline = resource(projectDescribeDataForModel(raw, true, mode));
    const runtime = { boundary: { ...boundary, activation: { digest } }, session_fingerprint: digest,
      model_authority_metadata: mode, describe: async () => structuredClone(raw) } as unknown as ScopedExploreRuntime;
    const server = createScopedExploreMcpServer(runtime, { semanticActions: createInactiveSemanticActionRuntime() });
    const client = new Client({ name: "waitlist-complete-contract", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const response = await client.callTool({ name: "app.describe_data", arguments: { resource: id } });
      expect(response.isError).not.toBe(true);
      const contract = resource(response.structuredContent as Record<string, unknown>);
      const expand = (entry: any, relationship = false) => {
        const resolved = { ...contract.empty_operation_defaults, ...(relationship ? contract.relationship_defaults : {}), ...entry };
        for (const key of ["filter_operators", "time_bucket_fields"]) if (Array.isArray(resolved[key])) {
          resolved[key] = Object.fromEntries(resolved[key].flatMap((group: any) => group.fields.map((field: string) => [field, contract.operation_sets[group.use]])));
        }
        return resolved;
      };
      const entries = [expand(contract), ...contract.relationships.map((entry: any) => expand(entry, true))];
      expect(entries).toHaveLength(4);
      for (const [index, original] of [baseline, ...baseline.relationships].entries()) {
        const actual = entries[index];
        for (const key of ["id", "selectable_fields", "filter_operators", "sortable_fields", "groupable_fields", "aggregate_measure_functions",
          "presence_measure_fields", "presence_measure_functions", "derived_measures", "count_distinct_fields", "time_bucket_fields", "relative_time_window_fields",
          "field_enums", "model_withheld_fields", "minimum_cohort_size", "maximum_rows", "maximum_groups", "primary_key",
          "activation", "operator_review_required", "target_resource", "cardinality", "counted_entity", "path_depth", "path", "nullable", "unmatched_rows"]) {
          if (Object.hasOwn(original, key)) expect(actual[key], `${index}.${key}`).toEqual(original[key]);
        }
        expect(actual.fields.map((field: any) => ({ ...contract.field_defaults, ...field })).map(({ operations, allowed_values, plan_reference, ...field }: any) => field))
          .toEqual(original.fields.map(({ operations, allowed_values, plan_reference, ...field }: any) => field));
      }
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(CATALOG_LIMITS.responseBytes);
      expect(readDiscoveryCompatibility(boundary, digest)).toEqual([]);
      expect(boundary).toEqual(before);
    } finally { await client.close(); await server.close(); }
  });

  it("returns the university registration contract without the reported field-narrowing workaround", async () => {
    const boundary = fixture();
    // Metadata captured from the lab's generated revision, before the operator
    // reduced its fourteen returnable fields to nine to fit the older build.
    boundary.pack.resources = [structuredClone(universityRegistration)];
    const raw = describeBoundary(boundary, { resource: universityRegistration.id });
    const original = projectDescribeDataForModel(raw, true), baseline = resource(original);
    expect(universityRegistration.selectable_fields).toHaveLength(14);
    expect(catalogResponseBytes(original)).toBeGreaterThan(CATALOG_LIMITS.responseBytes);
    const runtime = { boundary: { ...boundary, activation: { digest } }, session_fingerprint: digest,
      model_authority_metadata: "semantic", describe: async () => structuredClone(raw) } as unknown as ScopedExploreRuntime;
    const server = createScopedExploreMcpServer(runtime, { semanticActions: createInactiveSemanticActionRuntime() });
    const client = new Client({ name: "university-complete-contract", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const result = await client.callTool({ name: "app.describe_data", arguments: { resource: universityRegistration.id } });
      expect(result.isError).not.toBe(true);
      const entry = resource(result.structuredContent as Record<string, unknown>);
      for (const key of ["selectable_fields", "filter_operators", "sortable_fields", "groupable_fields", "field_enums",
        "aggregate_measure_functions", "presence_measure_fields", "time_bucket_fields", "count_distinct_fields",
        "model_withheld_fields", "kept_out_field_count", "maximum_rows", "maximum_groups", "minimum_cohort_size",
        "relative_time_window_fields", "valid_plan_examples"]) expect(entry[key]).toEqual(baseline[key]);
      expect(entry.fields.map((field: { id: string }) => field.id)).toEqual(baseline.fields.map((field: { id: string }) => field.id));
      expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThanOrEqual(CATALOG_LIMITS.detailBytes);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(CATALOG_LIMITS.responseBytes);
      expect(readDiscoveryCompatibility(boundary, digest)).toEqual([]);
    } finally { await client.close(); await server.close(); }
  });

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
      const resolvedFields = (contract: any) => contract.fields.map((field: any) => ({
        ...entry.field_defaults, ...contract.field_defaults,
        ...(contract.field_enums[field.id] ? { allowed_values: contract.field_enums[field.id] } : {}),
        ...field,
      }));
      expect(entry.relationships[0]).toMatchObject({ id: original.relationships[0].id, activation: "review_required",
        operator_review_required: true });
      for (const [before, after] of [[original, entry], [original.relationships[0], entry.relationships[0]]]) {
        const metadata = ({ operations: _copy, plan_reference: _ref, ...field }: any) => field;
        expect(resolvedFields(after).map(metadata)).toEqual(before.fields.map(metadata));
      }
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
          details: { kind: "indivisible_item", measured_bytes: expect.any(Number), limit_bytes: 12288, retryable: false, recovery: "operator_boundary_review" } });
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
