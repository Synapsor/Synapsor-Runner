import { describe, expect, it, vi } from "vitest";
import {
  compileActionRule,
  createActionRuleApprovalClasses,
  createActionRuleRegistry,
  type ActionRuleCatalogV1,
} from "@synapsor-runner/action-rules";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import type { ActionRuleSpecV1, ActionRuleScalarTypeSpecV1, DerivedEffectEnvelopeSpecV1, RuleVerificationBoundarySpecV1 } from "@synapsor/spec";
import { createSemanticActionRuntime, type CatalogAuthorization } from "./semantic-actions.js";
import type { SemanticActionCatalogOptions } from "./runtime-types.js";
import { semanticActionCatalogSchema } from "./semantic-action-schema.js";
import { catalogResponseBytes, CATALOG_LIMITS } from "./scoped-catalog.js";

const resource = "studio.parcels", outcome = "studio.pack_parcel";
const lock = `sha256:${"1".repeat(64)}` as const;
const publicStage: ActionRuleScalarTypeSpecV1 = { kind: "string", max_length: 16, comparison: "exact", enum: ["open", "packed"] };
const identifier = { kind: "string", max_length: 64, comparison: "exact" } as const;

/** Owned renamed metadata fixture. No source adapter or business handler exists. */
function parcelDiscoveryFixture() {
  const catalog: ActionRuleCatalogV1 = { schema_version: "synapsor.action-rule-catalog.v1", generation_lock_fingerprint: lock,
    resources: [{ name: resource, source: "studio_fixture", engine: "postgres", schema: "studio", table: "parcels",
      primary_key: "private_parcel_id", tenant_key: "workspace_id", principal_scope_key: "operator_id", version_field: "version",
      fields: [...["private_parcel_id", "workspace_id", "operator_id"].map(name => ({ name, type: identifier, nullable: false })),
        { name: "stage", type: publicStage, nullable: false }, { name: "version", type: { kind: "integer" }, nullable: false }] }], relationships: [] };
  const verification: RuleVerificationBoundarySpecV1 = { schema_version: "synapsor.verification-boundary.v1", name: "studio.verify_parcel",
    source: "studio_fixture", context: "trusted_context", generation_lock_fingerprint: lock,
    resources: [{ binding: "parcel", resource, source: { kind: "subject_ref" }, primary_key: "private_parcel_id", version_field: "version",
      fields: catalog.resources[0]!.fields, scope: { mode: "columns", tenant_field: "workspace_id", principal_field: "operator_id" },
      cardinality: "one", max_rows: 1, overflow: "unsupported", lock: "for_update" }], lock_order: ["parcel"],
    transaction: { isolation: "repeatable_read", timezone: "UTC" } };
  const envelope: DerivedEffectEnvelopeSpecV1 = { schema_version: "synapsor.derived-effect-envelope.v1", name: "studio.parcel_effect",
    source: "studio_fixture", operation: "update", target_resource: resource, target_binding: "parcel", primary_key: "private_parcel_id",
    tenant_key: "workspace_id", principal_scope_key: "operator_id", conflict_key: "version", max_rows: 1,
    allowed_fields: [{ name: "stage", type: publicStage }], version_advance: { column: "version", strategy: "integer_increment" },
    approval_classes: ["studio.human_review"], writeback: { mode: "direct_sql", supervised_worker: "allowed" } };
  const entries = [
    { id: outcome, title: "Pack parcel", summary: "Pack one reviewed parcel" },
    { id: "studio.pack_backup_parcel", title: "Pack backup parcel", summary: "Pack a backup parcel" },
    { id: "studio.pack_express_parcel", title: "Pack express parcel", summary: "Pack an express parcel" },
    // An exact-name tie must not participate when its authority is denied.
    { id: "studio.restricted_parcel", title: "Pack parcel", summary: "RESTRICTED_METADATA_MARKER" },
  ];
  const compiled = entries.map(entry => {
    const rule: ActionRuleSpecV1 = { schema_version: "synapsor.action-rule.v1", name: entry.id, outcome: entry.id,
      source: "studio_fixture", context: "trusted_context", verification_boundary_ref: verification.name, effect_envelope_ref: envelope.name,
      subjects: [{ binding: "parcel", resource, input: "opaque_subject_ref" }],
      inputs: [{ name: "requested_stage", description: "Parcel stage supplied by the caller", type: publicStage }],
      require: { kind: "compare", operator: "eq", left: { kind: "field", binding: "parcel", field: "stage" },
        right: { kind: "literal", value: "open", value_type: publicStage } }, derive: {},
      effect: { operation: "update", target_resource: resource, target_binding: "parcel", set: { stage: { kind: "input", name: "requested_stage" } } },
      approval_class: "studio.human_review", ttl_seconds: 300,
      "x-runner-discovery": { title: entry.title, summary: entry.summary, aliases: [] } };
    return compileActionRule({ catalog, verification_boundary: verification, effect_envelope: envelope, rule });
  });
  const registry = createActionRuleRegistry({ name: "studio.parcel_actions", approval_classes: createActionRuleApprovalClasses({ rules: compiled }),
    rules: compiled.map(rule => ({ compiled: rule, read_boundary_name: "studio_read", read_boundary_digest: `sha256:${"2".repeat(64)}` as const,
      action_boundary_name: "studio_actions", action_boundary_digest: `sha256:${"3".repeat(64)}` as const, activated_at: "2026-09-26T00:00:00.000Z" })) });
  const store = new ProposalStore();
  let authorization: CatalogAuthorization = { scope_key: "studio:caller-one", revision: "first", allowed_outcomes: entries.slice(0, 3).map(entry => entry.id) };
  let readRevision = "read-first";
  const claim = vi.fn(async () => { throw new Error("Discovery must not claim a subject"); });
  const resolveContext = vi.fn(async () => { throw new Error("Discovery must not load business context"); });
  const runtime = createSemanticActionRuntime({ store, registry, resolveCatalogAuthorization: () => authorization, resolveContext,
    subjectReferences: { claim } as unknown as Parameters<typeof createSemanticActionRuntime>[0]["subjectReferences"] });
  const navigate = vi.fn(async (resources: readonly string[]): Promise<{ binding: string; resources: Record<string, Record<string, unknown>> }> => ({ binding: readRevision,
    resources: Object.fromEntries(resources.map(id => [id, { status: "rows_reference_available",
      describe_data: { boundary: "studio_read", resource: id }, selectable_fields: ["public_label"], filter_operators: { public_label: ["eq"] },
      explore_data: { boundary: "studio_read", plan: { kind: "rows", resource: id, select: ["public_label"] } } }])) }));
  return { store, claim, resolveContext, navigate,
    describe: (args: Record<string, unknown>, options: SemanticActionCatalogOptions = { describeSubjectNavigation: navigate }) =>
      runtime.callTool("app.describe_actions", args, options),
    authorization: (patch: Partial<CatalogAuthorization>) => { authorization = { ...authorization, ...patch }; },
    readRevision: () => { readRevision = "read-second"; },
    close: () => { expect(claim).not.toHaveBeenCalled(); expect(resolveContext).not.toHaveBeenCalled(); expect(store.listProposals()).toEqual([]); store.close(); } };
}

describe("owned parcel discovery coverage v002", () => {
  it("uses exact-detail authorization before inline ranking and denies revoked cached detail", async () => {
    const f = parcelDiscoveryFixture();
    try {
      const result = await f.describe({ query: "Pack parcel", limit: 1 });
      const exact = await f.describe({ outcome });
      expect(result.inline_contract).toEqual((exact.actions as unknown[])[0]);
      expect(result.pagination).toMatchObject({ total: { kind: "exact", value: 3 } });
      expect(JSON.stringify(result)).not.toMatch(/restricted_parcel|RESTRICTED_METADATA_MARKER|private_parcel_id/);
      f.navigate.mockClear();
      const denied = await f.describe({ query: "studio.restricted_parcel" });
      expect(denied.actions).toHaveLength(3);
      for (const action of denied.actions as Array<Record<string, unknown>>) {
        expect([outcome, "studio.pack_backup_parcel", "studio.pack_express_parcel"]).toContain(action.outcome);
        expect(action.search_match).toMatchObject({ kind: "partial", missing_terms: ["restricted"] });
      }
      expect(denied.discovery).toMatchObject({ match_status: "partial_alternatives", search_status: "partial_matches" });
      expect(JSON.stringify(denied)).not.toMatch(/restricted_parcel|RESTRICTED_METADATA_MARKER/);
      expect(denied).not.toHaveProperty("inline_contract");
      for (const id of ["studio.restricted_parcel", "studio.unknown_parcel"]) {
        await expect(f.describe({ outcome: id })).rejects.toMatchObject({ code: "CATALOG_ENTRY_UNAVAILABLE" });
      }
      expect(f.navigate).not.toHaveBeenCalled();
      f.authorization({ revision: "withdrawn", allowed_outcomes: [] });
      await expect(f.describe({ outcome })).rejects.toMatchObject({ code: "CATALOG_ENTRY_UNAVAILABLE" });
      expect((await f.describe({ query: "Pack parcel" })).actions).toEqual([]);
      expect(f.navigate).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it.each(["unavailable", "relationship_only", "reference_not_established"])("retains truthful %s navigation in exact and inline contracts", async status => {
    const f = parcelDiscoveryFixture();
    const options: SemanticActionCatalogOptions = { describeSubjectNavigation: async () => ({ binding: "limited-read",
      resources: { [resource]: { status, guidance: "No independent reference route is established" } } }) };
    try {
      const result = await f.describe({ query: outcome }, options);
      const exact = await f.describe({ outcome }, options);
      expect(result.inline_contract).toEqual((exact.actions as unknown[])[0]);
      expect(result.inline_contract).toMatchObject({ subjects: [{ navigation: { status } }], inputs: [{ name: "requested_stage", required: true,
        acquisition: { source: "authorized_caller", public_lookup: "not_established_by_action_contract" } }] });
      expect((result.discovery as { next_steps: unknown[] }).next_steps).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "acquire_permitted_subject_reference" }),
      ]));
      expect(JSON.stringify(result)).not.toMatch(/"app.explore_data"|"resolved_inputs"|"value":"packed"/);
    } finally { f.close(); }
  });

  it.each([
    { query: outcome },
    { outcome: null, query: outcome, limit: null, cursor: null },
    { outcome: undefined, query: outcome, limit: undefined, cursor: undefined },
  ])("normalizes optional/null listing shapes without mixing exact grammar (%j)", async args => {
    const f = parcelDiscoveryFixture();
    try {
      semanticActionCatalogSchema.parse(args);
      const result = await f.describe(args);
      const exactArgs = { outcome, query: null, limit: null, cursor: null };
      semanticActionCatalogSchema.parse(exactArgs);
      const exact = await f.describe(exactArgs);
      // This rich navigation fixture was only 110 bytes below the transport
      // bound before result-evidence framing. The full contract remains exact;
      // the existing conditional inline path must now disclose its fallback.
      expect(result).not.toHaveProperty("inline_contract");
      expect(result.discovery).toMatchObject({ contract_status: "exact_detail_required",
        inline_status: "complete_contract_exceeds_inline_bound", next_steps: expect.arrayContaining([
          { kind: "inspect_exact_details", tool: "app.describe_actions", arguments: { outcome } },
        ]) });
      expect(catalogResponseBytes(result)).toBeLessThanOrEqual(CATALOG_LIMITS.responseBytes);
      expect(catalogResponseBytes(exact)).toBeLessThanOrEqual(CATALOG_LIMITS.responseBytes);
      const candidate = { ...result, inline_contract: (exact.actions as unknown[])[0],
        discovery: { ...(result.discovery as Record<string, unknown>), contract_status: "inline_complete",
          next_steps: (exact.discovery as Record<string, unknown>).next_steps } };
      expect(catalogResponseBytes(candidate)).toBeGreaterThan(CATALOG_LIMITS.responseBytes);
      const options: SemanticActionCatalogOptions = { describeSubjectNavigation: async () => ({ binding: "compact-current-read",
        resources: { [resource]: { status: "reference_not_established", guidance: "No independent reference route is established" } } }) };
      const small = await f.describe(args, options);
      expect(small.inline_contract).toEqual(((await f.describe(exactArgs, options)).actions as unknown[])[0]);
    } finally { f.close(); }
  });

  it("preserves empty compatibility contracts and keeps null-only listing explicitly compact", async () => {
    const f = parcelDiscoveryFixture();
    try {
      const compatibility = await f.describe({});
      expect(compatibility.discovery).toHaveProperty("mode", "bounded_compatibility");
      expect((compatibility.actions as Array<Record<string, unknown>>)[0]).toHaveProperty("inputs");
      const listing = await f.describe({ outcome: null, query: null, limit: null, cursor: null });
      expect(listing.discovery).toMatchObject({ mode: "summary", contract_status: "exact_detail_required" });
      expect((listing.actions as Array<Record<string, unknown>>)[0]).not.toHaveProperty("inputs");
      expect(listing).not.toHaveProperty("inline_contract");
    } finally { f.close(); }
  });

  it.each([{ outcome, query: "" }, { outcome, limit: 0 }, { outcome, cursor: "" }, { query: outcome, trusted_scope: "studio:caller-two" }])(
    "refuses meaningful/invalid mixed arguments before navigation (%j)", async args => {
      const f = parcelDiscoveryFixture();
      try {
        await expect(f.describe(args)).rejects.toMatchObject({ code: "ARGUMENT_INVALID" });
        expect(f.navigate).not.toHaveBeenCalled();
      } finally { f.close(); }
    });

  it.each(["caller", "action_revision", "read_revision", "query", "limit", "unknown_cursor"])(
    "refuses an inline-query continuation after %s isolation changes", async variant => {
      const f = parcelDiscoveryFixture();
      try {
        const first = await f.describe({ query: "Pack parcel", limit: 1 });
        expect(first.next_cursor).toMatch(/^cur_/);
        expect(first.inline_contract).toBeDefined();
        const args: Record<string, unknown> = { query: "Pack parcel", limit: 1, cursor: first.next_cursor };
        if (variant === "caller") f.authorization({ scope_key: "studio:caller-two" });
        if (variant === "action_revision") f.authorization({ revision: "second" });
        if (variant === "read_revision") f.readRevision();
        if (variant === "query") args.query = "Pack express parcel";
        if (variant === "limit") args.limit = 2;
        if (variant === "unknown_cursor") args.cursor = `cur_${"x".repeat(43)}`;
        await expect(f.describe(args)).rejects.toMatchObject({ code: "CATALOG_CURSOR_INVALID" });
      } finally { f.close(); }
    });

  it.each(["caller", "action_revision"])("refuses %s drift during asynchronous inline preparation", async variant => {
    const f = parcelDiscoveryFixture(); let calls = 0;
    try {
      await expect(f.describe({ query: outcome }, { describeSubjectNavigation: async resources => {
        const navigation = await f.navigate(resources);
        if (++calls === 2) f.authorization(variant === "caller" ? { scope_key: "studio:caller-two" } : { revision: "second" });
        return navigation;
      } })).rejects.toMatchObject({ code: "CATALOG_CURSOR_INVALID" });
    } finally { f.close(); }
  });

  it("keeps a complete exact contract usable when repeated listing metadata prevents inline disclosure", async () => {
    const f = parcelDiscoveryFixture();
    try {
      const baselineBytes = catalogResponseBytes(await f.describe({ outcome }));
      // The public field appears in both MCP text and structured content. Leave
      // the complete exact response inside its bound while the listing adds cost.
      const guidanceLength = Math.floor((CATALOG_LIMITS.responseBytes - baselineBytes - 300) / 2);
      expect(guidanceLength).toBeGreaterThan(0);
      const guidance = "Reviewed route guidance. ".repeat(Math.ceil(guidanceLength / 25)).slice(0, guidanceLength);
      const options: SemanticActionCatalogOptions = { describeSubjectNavigation: async resources => {
        const navigation = await f.navigate(resources);
        navigation.resources[resource]!.guidance = guidance;
        return navigation;
      } };
      const result = await f.describe({ query: "Pack parcel", limit: 3 }, options);
      expect(result).not.toHaveProperty("inline_contract");
      expect(result.discovery).toMatchObject({ inline_status: "complete_contract_exceeds_inline_bound", next_steps: [
        { kind: "inspect_exact_details", tool: "app.describe_actions", arguments: { outcome } },
      ] });
      const exact = await f.describe({ outcome }, options);
      expect(exact.actions).toEqual([expect.objectContaining({ inputs: [{ name: "requested_stage", description: "Parcel stage supplied by the caller", type: publicStage,
        required: true, origin: "caller_business_input", acquisition: expect.any(Object) }], subjects: [{ binding: "parcel", resource,
        reference: "opaque Explore subject reference", navigation: expect.objectContaining({ guidance }) }] })]);
      expect(catalogResponseBytes(result)).toBeLessThanOrEqual(CATALOG_LIMITS.responseBytes);
      expect(catalogResponseBytes(exact)).toBeLessThanOrEqual(CATALOG_LIMITS.responseBytes);
    } finally { f.close(); }
  });
});
