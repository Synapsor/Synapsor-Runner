import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CATALOG_LIMITS, createInactiveSemanticActionRuntime } from "@synapsor-runner/mcp-server";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ExplorationBoundaryDraft, readDiscoveryCompatibility } from "./auto-boundary.js";
import { describeBoundary, type ScopedExploreRuntime } from "./scoped-explore.js";
import { createScopedExploreMcpServer, projectDescribeDataForModel } from "./authoring-mcp.js";

// Owned deterministic metadata composition. It calls the real descriptor,
// publisher, projection and dispatch; it does not install or activate authority.
const digest = `sha256:${"d".repeat(64)}` as const;
function boundaryFixture(): ExplorationBoundaryDraft {
  const fields = Array.from({ length: 32 }, (_, index) => `business_field_${index}`);
  return { schema_version: "synapsor.exploration-boundary.v1", activation: "disabled_unreviewed", deployment_profile: "staging",
    source: "local_postgres", compiler_version: "1.8.0", spec_version: "1.11.0", reporting_timezone: "UTC",
    trusted_context: { provider: "environment", tenant_env: "ACCOUNT", principal_env: "USER" },
    generation_lock_fingerprint: digest, role_posture_fingerprint: digest,
    budgets: structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS), unresolved_decisions: [],
    pack: { name: "wide_reviewed", resources: [{ id: "operations.items", label: "Reviewed business items", schema: "operations", table: "items",
      primary_key: "private_record_key", tenant_key: "private_tenant_key", model_withheld_fields: ["private_record_key"], kept_out_fields: ["private_tenant_key"],
      field_types: Object.fromEntries(["private_record_key", "private_tenant_key", ...fields].map(id => [id, "text"])),
      field_enums: {}, field_metadata: Object.fromEntries(fields.map(id => [id, { label: id, description: "Reviewed caller-visible field description é漢字 ".repeat(12) }])),
      selectable_fields: fields, filterable_fields: { business_field_0: ["eq", "in"] }, sortable_fields: ["business_field_0"],
      groupable_fields: ["business_field_0"], aggregate_measures: [], presence_measure_fields: [], count_distinct_fields: [],
      time_bucket_fields: {}, relationships: [], minimum_cohort_size: 5, suppression_aware_totals: true,
    }] } };
}
function modelContract(boundary: ExplorationBoundaryDraft) {
  const raw = describeBoundary(boundary, { resource: "operations.items" });
  return (projectDescribeDataForModel({ ...raw, catalog_version: "synapsor.scoped-catalog.v2" }, true, "exact").resources as Record<string, unknown>[])[0]!;
}

describe("public exact Read sections", () => {
  it("accepts a decomposable contract under unchanged unit/envelope/session bounds, while refusing an indivisible twin", () => {
    const boundary = boundaryFixture();
    expect(Buffer.byteLength(JSON.stringify(modelContract(boundary)))).toBeGreaterThan(CATALOG_LIMITS.detailBytes);
    expect(readDiscoveryCompatibility(boundary, digest)).toEqual([]);
  });

  it("preserves the indivisible negative and small complete positive", () => {
    const boundary = boundaryFixture();
    const indivisible = structuredClone(boundary);
    indivisible.pack.resources[0]!.description = "x".repeat(16_384);
    expect(readDiscoveryCompatibility(indivisible, digest)).toHaveLength(1);
    expect(boundary.pack.resources[0]!.selectable_fields).toHaveLength(32);
    for (const field of Object.values(boundary.pack.resources[0]!.field_metadata!)) delete field.description;
    expect(readDiscoveryCompatibility(boundary, digest)).toEqual([]);
  });

  it("reconstructs the projected contract through actual four-tool schema and MCP with privacy/currentness checks", async () => {
    const boundary = boundaryFixture();
    const raw = describeBoundary(boundary, { resource: "operations.items" });
    (raw.resources as Record<string, unknown>[])[0]!.private_operator_note = "private-operand-must-not-leak";
    let current = true;
    let materializations = 0;
    const runtime = { boundary: { ...boundary, activation: { digest } }, session_fingerprint: digest, model_authority_metadata: "exact",
      requireCurrentAuthority: async () => { if (!current) throw new Error("Current authority revoked"); },
      describe: async () => { materializations++; return structuredClone(raw); } } as unknown as ScopedExploreRuntime;
    const server = createScopedExploreMcpServer(runtime, { semanticActions: createInactiveSemanticActionRuntime() });
    const client = new Client({ name: "owned-wide-read-sections", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(b); await client.connect(a);
      const tools = (await client.listTools()).tools;
      expect(tools).toHaveLength(4);
      const schema = tools.find(tool => tool.name === "app.describe_data")!.inputSchema;
      expect(schema.type).toBe("object");
      expect(schema.properties).toHaveProperty("section");
      expect(schema.properties).toHaveProperty("contract_revision");
      const call = async (args: Record<string, unknown>) => {
        const result = await client.callTool({ name: "app.describe_data", arguments: args });
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(CATALOG_LIMITS.responseBytes);
        expect(JSON.stringify(result)).not.toContain("private-operand-must-not-leak");
        return result;
      };
      const first = await call({ boundary: "wide_reviewed", resource: "operations.items" });
      expect(first.isError, JSON.stringify(first)).not.toBe(true);
      const nav = (first.structuredContent as any).contract_navigation;
      expect(nav).toHaveProperty("complete_contract", false);
      const sections = [...nav.sections];
      let indexPage = first.structuredContent as any;
      while (indexPage.next_cursor) {
        const continuation = indexPage.discovery.next_steps.find((step: any) => step.kind === "continue_contract_index");
        const result = await call(continuation.arguments);
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        indexPage = result.structuredContent as any;
        expect(indexPage.contract_navigation.revision).toBe(nav.revision);
        sections.push(...indexPage.contract_navigation.sections);
      }
      const assembled: Record<string, unknown> = {};
      for (const section of sections) {
        let args: Record<string, unknown> | undefined = section.next_call.arguments;
        const units: Array<{ key: string; value: unknown }> = [];
        do {
          const result = await call(args!);
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          const page = result.structuredContent as any;
          expect(page.contract_section).toMatchObject({ section: section.section, revision: nav.revision });
          units.push(...page.contract_section.items);
          args = page.next_cursor ? { ...args!, cursor: page.next_cursor } : undefined;
        } while (args);
        assembled[section.section] = section.representation === "array" ? units.map(unit => unit.value)
          : section.representation === "object" ? Object.fromEntries(units.map(unit => [unit.key, unit.value])) : units[0]!.value;
      }
      expect(assembled).toEqual(modelContract(boundary));
      const focused = await call({ boundary: "wide_reviewed", resource: "operations.items", section: "fields", item: "business_field_19", contract_revision: nav.revision });
      expect(focused.isError).not.toBe(true);
      expect((focused.structuredContent as any).contract_section).toMatchObject({ items: [{ value: { id: "business_field_19" } }], complete_section: false });
      expect((await call({ boundary: "wide_reviewed", resource: "operations.items", section: "fields", item: "private_operator_note", contract_revision: nav.revision })).isError).toBe(true);
      expect((await call({ resource: "operations.items", section: "fields", query: "business" })).isError).toBe(true);
      expect(materializations).toBe(1); // prepared public units reused after live currentness checks
      current = false;
      expect((await call({ boundary: "wide_reviewed", resource: "operations.items", section: "fields", contract_revision: nav.revision })).isError).toBe(true);
    } finally { await client.close(); await server.close(); }
  });
});
