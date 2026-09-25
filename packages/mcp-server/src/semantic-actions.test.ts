import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  compileActionRule,
  createActionRuleApprovalClasses,
  createActionRuleRegistry,
  snapshotActionRuleRegistry,
  resolveActivatedActionRule,
  actionRuleDiscoveryContract,
  actionRuleDiscoveryMetadata,
  assertActionDiscoveryContractFits,
  type ActionRuleApprovalClassSourceV1,
  type ActionRuleCatalogV1,
  type ActionRuleFactQueryV1,
} from "@synapsor-runner/action-rules";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import type {
  ActionRuleSpecV1,
  ActionRuleScalarTypeSpecV1,
  DerivedEffectEnvelopeSpecV1,
  RuleVerificationBoundarySpecV1,
} from "@synapsor/spec";
import { describe, expect, it, vi } from "vitest";
import {
  createMcpRuntime,
  createSemanticActionRuntime,
  createSubjectReferenceService,
  createSynapsorMcpServer,
  DESCRIBE_ACTIONS_TOOL,
  REQUEST_CHANGE_TOOL,
  type RuntimeConfig,
  type SubjectReferenceAuthorityContext,
} from "./index.js";
import { projectLocalResourceForModel } from "./local-resources.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { OwnerRuntimeError } from "./owner-runtime-identity.js";
import { PostgresRlsPrerequisiteError } from "@synapsor-runner/postgres";
import type { SemanticActionRequestContext } from "./runtime-types.js";
import { semanticRequestLifecycle } from "./semantic-request-lifecycle.js";

const lock = `sha256:${"a".repeat(64)}` as const;
const readBoundary = `sha256:${"b".repeat(64)}` as const;
const actionBoundary = `sha256:${"c".repeat(64)}` as const;
const tenantScope = `sha256:${"d".repeat(64)}` as const;
const principalScope = `sha256:${"e".repeat(64)}` as const;
const stringId = { kind: "string", max_length: 64, comparison: "exact" } as const;
const stateType: ActionRuleScalarTypeSpecV1 = {
  kind: "string",
  max_length: 16,
  comparison: "exact",
  enum: ["active", "paused"],
};
const integer = { kind: "integer" } as const;

function semanticFixture(options: { automaticApproval?: boolean; requiredApprovals?: number; businessInput?: boolean;
  outcome?: string; aliases?: string[]; sharedLimits?: ActionRuleApprovalClassSourceV1["shared_limits"] } = {}) {
  const catalog: ActionRuleCatalogV1 = {
    schema_version: "synapsor.action-rule-catalog.v1",
    generation_lock_fingerprint: lock,
    resources: [{
      name: "billing.preferences",
      source: "local_postgres",
      engine: "postgres",
      schema: "billing",
      table: "preferences",
      primary_key: "preference_id",
      tenant_key: "account_id",
      principal_scope_key: "principal_id",
      version_field: "version",
      fields: [
        { name: "preference_id", type: stringId, nullable: false },
        { name: "account_id", type: stringId, nullable: false },
        { name: "principal_id", type: stringId, nullable: false },
        { name: "status", type: stateType, nullable: false },
        { name: "version", type: integer, nullable: false },
      ],
    }],
    relationships: [],
  };
  const verificationBoundary: RuleVerificationBoundarySpecV1 = {
    schema_version: "synapsor.verification-boundary.v1",
    name: "billing.pause_verification",
    source: "local_postgres",
    context: "trusted_context",
    generation_lock_fingerprint: lock,
    resources: [{
      binding: "preference",
      resource: "billing.preferences",
      source: { kind: "subject_ref" },
      primary_key: "preference_id",
      version_field: "version",
      fields: catalog.resources[0]!.fields.map(({ name, type, nullable }) => ({ name, type, nullable })),
      scope: { mode: "columns", tenant_field: "account_id", principal_field: "principal_id" },
      cardinality: "one",
      max_rows: 1,
      overflow: "unsupported",
      lock: "for_update",
    }],
    lock_order: ["preference"],
    transaction: { isolation: "repeatable_read", timezone: "UTC" },
  };
  const effectEnvelope: DerivedEffectEnvelopeSpecV1 = {
    schema_version: "synapsor.derived-effect-envelope.v1",
    name: "billing.pause_effect",
    source: "local_postgres",
    operation: "update",
    target_resource: "billing.preferences",
    target_binding: "preference",
    primary_key: "preference_id",
    tenant_key: "account_id",
    principal_scope_key: "principal_id",
    conflict_key: "version",
    max_rows: 1,
    allowed_fields: [{ name: "status", type: stateType, values: ["paused"] }],
    version_advance: { column: "version", strategy: "integer_increment" },
    approval_classes: ["billing.standard_change"],
    writeback: { mode: "direct_sql", supervised_worker: "allowed" },
  };
  const rule: ActionRuleSpecV1 = {
    schema_version: "synapsor.action-rule.v1",
    name: "billing.pause_notifications",
    outcome: "billing.pause_notifications",
    context: "trusted_context",
    source: "local_postgres",
    verification_boundary_ref: verificationBoundary.name,
    effect_envelope_ref: effectEnvelope.name,
    subjects: [{ binding: "preference", resource: "billing.preferences", input: "opaque_subject_ref" }],
    require: {
      kind: "compare",
      operator: "eq",
      left: { kind: "field", binding: "preference", field: "status" },
      right: { kind: "literal", value: "active", value_type: stateType },
    },
    derive: {},
    effect: {
      operation: "update",
      target_resource: "billing.preferences",
      target_binding: "preference",
      set: { status: { kind: "literal", value: "paused", value_type: stateType } },
    },
    approval_class: "billing.standard_change",
    ttl_seconds: 300,
  };
  if (options.businessInput) {
    rule.inputs = [{ name: "notification_state", description: "Requested notification preference", type: stateType }];
    rule.effect.set.status = { kind: "input", name: "notification_state" };
  }
  if (options.outcome) { rule.name = options.outcome; rule.outcome = options.outcome; }
  if (options.aliases) rule["x-runner-discovery"] = { title: "Pause notifications", summary: "Stop account notifications", aliases: options.aliases };
  const compiled = compileActionRule({
    catalog,
    verification_boundary: verificationBoundary,
    effect_envelope: effectEnvelope,
    rule,
  });
  const approvalSources: ActionRuleApprovalClassSourceV1[] | undefined = options.automaticApproval
    ? [{
      name: "billing.standard_change",
      mode: "policy",
      rules: [{ outcome: rule.outcome, auto_approve_when: structuredClone(rule.require) }],
      required_role: "billing_reviewer",
      required_approvals: options.requiredApprovals ?? 1,
      shared_limits: options.sharedLimits ?? [
        {
          id: "billing_pause_action_24h",
          kind: "count",
          scope: "capability",
          maximum: 1,
          window_seconds: 86_400,
          capability: rule.outcome,
        },
        {
          id: "billing_pause_customer_24h",
          kind: "count",
          scope: "tenant_principal",
          maximum: 5,
          window_seconds: 86_400,
          capability: rule.outcome,
        },
      ],
    }]
    : undefined;
  const approvalClasses = createActionRuleApprovalClasses({
    rules: [compiled],
    ...(approvalSources === undefined ? {} : { sources: approvalSources }),
  });
  const registry = createActionRuleRegistry({
    name: "billing.active_actions",
    approval_classes: approvalClasses,
    rules: [{
      read_boundary_name: "reviewed_billing",
      read_boundary_digest: readBoundary,
      action_boundary_name: "billing.actions",
      action_boundary_digest: actionBoundary,
      compiled,
      activated_at: "2026-09-02T20:00:00.000Z",
    }],
  });
  return { registry, activated: registry.rules[0]! };
}

function authorityContext(): SubjectReferenceAuthorityContext {
  return {
    source_id: "local_postgres",
    read_boundary_digest: readBoundary,
    generation_lock_fingerprint: lock,
    tenant_scope_fingerprint: tenantScope,
    principal_scope_fingerprint: principalScope,
    workflow_session_id: "workflow_semantic_action_test",
  };
}

function createFixtureRuntime(options: {
  store?: ProposalStore;
  beforeLoad?: (query: ActionRuleFactQueryV1) => Promise<void>;
  subjectAuthority?: () => SubjectReferenceAuthorityContext;
  unavailableOutcomes?: () => string[];
  businessInput?: boolean;
  status?: "active" | "paused";
  automaticApproval?: boolean;
  requiredApprovals?: number;
  preferences?: Array<{ preference_id: string; status: "active" | "paused"; version: number }>;
  onProposalReady?: NonNullable<Parameters<typeof createSemanticActionRuntime>[0]["onProposalReady"]>;
  delegation?: SemanticActionRequestContext["delegation"];
  delegationRequired?: boolean;
  resourceFailure?: Error;
  sharedLimits?: ActionRuleApprovalClassSourceV1["shared_limits"];
  tenant?: string;
  principal?: string;
  clock?: () => string;
} = {}) {
  const store = options.store ?? new ProposalStore();
  const { registry, activated } = semanticFixture({
    businessInput: options.businessInput,
    automaticApproval: options.automaticApproval,
    requiredApprovals: options.requiredApprovals,
    sharedLimits: options.sharedLimits,
  });
  const subjectAuthority = {
    ...authorityContext(),
    ...(options.tenant ? { tenant_scope_fingerprint: canonicalJsonDigest(options.tenant) } : {}),
    ...(options.principal ? { principal_scope_fingerprint: canonicalJsonDigest(options.principal) } : {}),
  };
  const subjectReferences = createSubjectReferenceService({
    store,
    registry,
    key: Buffer.alloc(32, 7),
    clock: options.clock ?? (() => "2026-09-02T20:02:00.000Z"),
  });
  const queries: ActionRuleFactQueryV1[] = [];
  const preferences = options.preferences ?? [{
    preference_id: "raw-preference-42",
    status: options.status ?? "active",
    version: 4,
  }];
  const semanticActions = createSemanticActionRuntime({
    store,
    registry,
    subjectReferences,
    delegationRequired: options.delegationRequired,
    resolveCatalogAuthorization: () => ({ scope_key: "test:northstar:maya", revision: "deployment-only" }),
    ...(options.unavailableOutcomes ? { unavailableOutcomes: options.unavailableOutcomes } : {}),
    ...(options.onProposalReady ? { onProposalReady: options.onProposalReady } : {}),
    async resolveContext() {
      return {
        delegation: options.delegation,
        trusted_context: {
          tenant_id: options.tenant ?? "acct_northstar",
          principal: options.principal ?? "customer_maya",
          provenance: "http_claims",
        },
        subject_authority: options.subjectAuthority?.() ?? subjectAuthority,
        fact_loader: {
          engine: "postgres",
          async assertResourceCompatible() { if (options.resourceFailure) throw options.resourceFailure; },
          async load(query) {
            await options.beforeLoad?.(query);
            queries.push(query);
            const identityPredicate = query.predicates.find((predicate) =>
              predicate.operation === "eq" && predicate.column === "preference_id");
            const requestedId = identityPredicate?.operation === "eq" ? identityPredicate.value : undefined;
            return preferences.filter((preference) => preference.preference_id === requestedId).map((preference) => ({
              preference_id: preference.preference_id,
              account_id: options.tenant ?? "acct_northstar",
              principal_id: options.principal ?? "customer_maya",
              status: preference.status,
              version: preference.version,
            }));
          },
        },
      };
    },
  });
  return { store, registry, activated, subjectReferences, semanticActions, queries, subjectAuthority };
}

async function issueSubject(
  fixture: ReturnType<typeof createFixtureRuntime>,
  preferenceId = "raw-preference-42",
  version = 4,
) {
  const [subject] = await fixture.subjectReferences.issue({
    ...fixture.subjectAuthority,
    resource: "billing.preferences",
    evidence_bundle_id: `ev_explore_${preferenceId}`,
    observations: [{
      row_index: 0,
      primary_key_value: preferenceId,
      observed_version_value: version,
    }],
    now: "2026-09-02T20:01:00.000Z",
  });
  if (!subject) throw new Error("Expected one opaque subject reference.");
  return subject.ref;
}

const serverConfig: RuntimeConfig = {
  version: 1,
  mode: "read_only",
  storage: { sqlite_path: ":memory:" },
  sources: {
    local_postgres: {
      engine: "postgres",
      read_url_env: "DATABASE_URL",
    },
  },
  trusted_context: {
    provider: "static_dev",
    values: { tenant_id: "acct_northstar", principal: "customer_maya" },
  },
  capabilities: [],
};

const configuredReadCapability: NonNullable<RuntimeConfig["capabilities"]>[number] = {
  name: "billing.inspect_preference",
  kind: "read",
  source: "local_postgres",
  target: {
    schema: "billing",
    table: "preferences",
    primary_key: "preference_id",
    tenant_key: "account_id",
    principal_scope_key: "principal_id",
  },
  args: { preference_id: { type: "string", required: true } },
  lookup: { id_from_arg: "preference_id" },
  visible_columns: ["preference_id", "status"],
};

describe("fixed semantic Action MCP", () => {
  it.each([false, true])("reports listing approval limits and exact disclosable mode through real MCP serialization (automatic=%s)", async automaticApproval => {
    const fixture = createFixtureRuntime({automaticApproval});
    const runtime = createMcpRuntime(serverConfig, {store: fixture.store, semanticActions: fixture.semanticActions});
    const server = createSynapsorMcpServer(runtime), client = new Client({name: "approval-disclosure-test", version: "1"});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.find(tool => tool.name === DESCRIBE_ACTIONS_TOOL)?.description).toContain("do not mean automatic approval is absent");
      const listing = await client.callTool({name: DESCRIBE_ACTIONS_TOOL, arguments: {outcome: null, query: null, limit: null, cursor: null}});
      expect(listing.structuredContent).toMatchObject({approval_information: {disclosure: "partial"},
        actions: [{approval: {disclosure: "not_reported"}}]});
      expect(JSON.parse((listing.content as Array<{text: string}>)[0]!.text)).toEqual(listing.structuredContent);
      expect(JSON.stringify(listing)).toContain("Proposal-only separates requesting from execution; it does not mean manual-only");
      const detail = await client.callTool({name: DESCRIBE_ACTIONS_TOOL, arguments: {outcome: fixture.activated.compiled.outcome}});
      expect(detail.structuredContent).toMatchObject({actions: [{approval: {disclosure: automaticApproval ? "mode_only" : "manual_only"}}],
        execution_status: {enablement: "not_reported_by_discovery", worker_liveness: "unknown"}});
      expect(JSON.parse((detail.content as Array<{text: string}>)[0]!.text)).toEqual(detail.structuredContent);
      if(automaticApproval) {
        expect(JSON.stringify(detail)).toContain("no automatic threshold is established");
        // The fallback concerns an approval decision, never a promise that an
        // ineligible request can proceed merely by obtaining human approval.
        expect((detail.structuredContent as {actions: Array<{approval: {decision: string}}>}).actions[0]!.approval.decision)
          .toContain("otherwise eligible requests require human review");
      }
      expect(JSON.stringify([listing, detail])).not.toMatch(/auto_approve_when|account_id|principal_id|raw-preference-42/);
      expect(fixture.store.listProposals()).toHaveLength(0); expect(fixture.queries).toHaveLength(0);
    } finally { await client.close(); await server.close(); fixture.store.close(); }
  });
  it("keeps undisclosed policy operands private and never describes paused authority as manual-only", async () => {
    const responses: unknown[] = [];
    for(const maximum of [17, 29]) {
      const f = createFixtureRuntime({automaticApproval: true, sharedLimits: [
        {id: "private_cap", kind: "count", scope: "tenant", maximum, window_seconds: 86400},
        {id: "private_boundary_cap", kind: "count", scope: "boundary", maximum: 32, window_seconds: 86400}]});
      try { responses.push(await f.semanticActions.callTool(DESCRIBE_ACTIONS_TOOL, {outcome: f.activated.compiled.outcome})); }
      finally { f.store.close(); }
    }
    expect(responses[0]).toEqual(responses[1]);
    expect(JSON.stringify(responses)).not.toMatch(/private_cap|86400|auto_approve_when/);
    const f = createFixtureRuntime({unavailableOutcomes: () => ["billing.pause_notifications"]});
    try {
      expect(await f.semanticActions.callTool(DESCRIBE_ACTIONS_TOOL, {query: "pause"})).toMatchObject({actions: [{approval: {disclosure: "unavailable"}}]});
      const detail = await f.semanticActions.callTool(DESCRIBE_ACTIONS_TOOL, {outcome: "billing.pause_notifications"});
      expect(detail).toMatchObject({actions: [{availability: "operator_review_required", approval: {disclosure: "unavailable"}}]});
      expect((detail.actions as any[])[0].approval.decision).not.toBe("human review required");
    } finally { f.store.close(); }
  });
  it("requires configured delegation before claiming references or reading source facts", async () => {
    const f = createFixtureRuntime({ delegationRequired: true });
    try {
      const ref = await issueSubject(f), claim = vi.spyOn(f.subjectReferences, "claim");
      await expect(f.semanticActions.callTool(REQUEST_CHANGE_TOOL, { outcome: f.activated.compiled.outcome, subject_refs: { preference: ref } }))
        .rejects.toThrow("Current delegated authority could not be verified");
      expect(claim).not.toHaveBeenCalled(); expect(f.queries).toHaveLength(0);
    } finally { f.store.close(); }
  });
  it("preserves delegated human review and rechecks current owner permission on idempotent proposal requests", async () => {
    const checkExisting = vi.fn(async () => {}), onProposalReady = vi.fn(async () => ({ execution: "human_review" as const, source_database_changed: false }));
    const checkProposal = vi.fn(async () => ({ approval: "human" as const, proof: { schema_version: "synapsor.delegation-proof.v1" as const,
      binding_digest: canonicalJsonDigest("binding"), actor_digest: canonicalJsonDigest("actor"), policy_chain_digest: canonicalJsonDigest("chain"),
      valid_until: "2026-09-02T20:06:00.000Z" } }));
    const f = createFixtureRuntime({ delegationRequired: true, automaticApproval: true, delegation: { checkProposal, checkExisting }, onProposalReady });
    try {
      const ref = await issueSubject(f), args = { outcome: f.activated.compiled.outcome, subject_refs: { preference: ref } };
      const result = await f.semanticActions.callTool(REQUEST_CHANGE_TOOL, args);
      expect(result).toMatchObject({ authorization: { approval: "pending_human_review", execution: "human_review" } });
      expect(checkProposal).toHaveBeenCalledTimes(1); expect(checkExisting).toHaveBeenCalledTimes(1);
      checkExisting.mockRejectedValueOnce(new OwnerRuntimeError("DELEGATION_REVOKED"));
      await expect(f.semanticActions.callTool(REQUEST_CHANGE_TOOL, args)).rejects.toThrow("Current delegated authority could not be verified");
      expect(checkExisting).toHaveBeenCalledTimes(2); expect(checkProposal).toHaveBeenCalledTimes(1);
      expect(onProposalReady).toHaveBeenCalledTimes(1); expect(f.queries).toHaveLength(1);
    } finally { f.store.close(); }
  });
  it("reports a retired or unknown outcome as unavailable without loading customer facts", async () => {
    const fixture = semanticFixture(), store = new ProposalStore(":memory:");
    const claim = vi.fn(), resolveContext = vi.fn();
    const runtime = createSemanticActionRuntime({ store, registry: fixture.registry,
      subjectReferences: { claim } as unknown as Parameters<typeof createSemanticActionRuntime>[0]["subjectReferences"],
      resolveContext, resolveCatalogAuthorization: () => ({ scope_key: "tenant-a", revision: "current" }) });
    try {
      await expect(runtime.callTool(REQUEST_CHANGE_TOOL, { outcome: "billing.retired", subject_refs: { preference: `obj_${"x".repeat(40)}` } }))
        .rejects.toMatchObject({ code: "SEMANTIC_ACTION_UNAVAILABLE", message: expect.stringContaining("Refresh the action list") });
      expect(claim).not.toHaveBeenCalled();
      expect(resolveContext).not.toHaveBeenCalled();
      expect(await store.listProposals()).toHaveLength(0);
    } finally { store.close(); }
  });

  it.each(["authority", "scope", "availability"] as const)("does not disclose a catalog withdrawn during asynchronous %s loading", async (change) => {
    const fixture = semanticFixture();
    let revision = "before";
    let registry = fixture.registry;
    let unavailable: string[] = [];
    let calls = 0;
    const store = new ProposalStore(":memory:");
    const runtime = createSemanticActionRuntime({
      store, registry: () => registry,
      subjectReferences: { claim: vi.fn() } as unknown as Parameters<typeof createSemanticActionRuntime>[0]["subjectReferences"],
      resolveContext: vi.fn(),
      resolveCatalogAuthorization: () => ({ scope_key: "tenant-a", revision }),
      unavailableOutcomes: async () => {
        const result = unavailable;
        if (++calls === 1) {
          if (change === "scope") revision = "revoked";
          else if (change === "authority") registry = createActionRuleRegistry({ name: "replacement", rules: [fixture.activated] });
          else unavailable = [fixture.activated.compiled.outcome];
        }
        return result;
      },
    });
    try {
      await expect(runtime.callTool(DESCRIBE_ACTIONS_TOOL, {})).rejects.toMatchObject({ code: "CATALOG_CURSOR_INVALID" });
      await expect(runtime.callTool(DESCRIBE_ACTIONS_TOOL, {})).resolves.toMatchObject({ ok: true });
    } finally { store.close(); }
  });

  it("filters before searching and rechecks current scope, revision and registry integrity before cached results", async () => {
    const entries = Array.from({ length: 7 }, (_, index) => semanticFixture({ outcome: `billing.pause_${index}`, aliases: ["quiet"], businessInput: true }).activated);
    const registry = createActionRuleRegistry({ name: "billing.actions", rules: entries.map(({ approval_policy_digest: _, ...entry }) => entry) });
    let loaded = registry;
    let authorization = { scope_key: "north/maya", revision: "v1", allowed_outcomes: entries.slice(0, 6).map((entry) => entry.compiled.outcome) };
    const store = new ProposalStore();
    const claim = vi.fn();
    const resolveContext = vi.fn();
    const runtime = createSemanticActionRuntime({ store, registry: () => loaded,
      subjectReferences: { claim } as unknown as Parameters<typeof createSemanticActionRuntime>[0]["subjectReferences"],
      resolveContext, resolveCatalogAuthorization: () => authorization });
    try {
      const first = await runtime.callTool(DESCRIBE_ACTIONS_TOOL, { query: "quiet", limit: 2 });
      expect(first.actions).toHaveLength(2);
      expect(first.next_cursor).toMatch(/^cur_/u);
      expect(JSON.stringify(first)).not.toMatch(/billing.pause_6|north\/maya|sha256:|auto_approve_when/u);
      expect(first.actions).toEqual(expect.arrayContaining([expect.objectContaining({ eligibility: "not_checked" })]));
      expect((first.actions as Array<Record<string, unknown>>)[0]).not.toHaveProperty("inputs");
      const exact = await runtime.callTool(DESCRIBE_ACTIONS_TOOL, { outcome: "billing.pause_0" });
      expect(exact).not.toHaveProperty("request_shape");
      expect(exact).toMatchObject({ execution_status: { enablement: "not_reported_by_discovery", worker_liveness: "unknown" }, actions: [{
        inputs: [{ name: "notification_state", required: true, type: { enum: ["active", "paused"] } }],
        request_shape: { outcome: "billing.pause_0", subject_refs: { preference: "obj_<opaque reference>" } },
      }] });
      for (const outcome of ["billing.pause_6", "billing.never_existed"]) {
        await expect(runtime.callTool(DESCRIBE_ACTIONS_TOOL, { outcome })).rejects.toMatchObject({ code: "CATALOG_ENTRY_UNAVAILABLE" });
      }
      authorization = { ...authorization, scope_key: "south/maya" };
      await expect(runtime.callTool(DESCRIBE_ACTIONS_TOOL, { query: "quiet", limit: 2, cursor: first.next_cursor })).rejects.toMatchObject({ code: "CATALOG_CURSOR_INVALID" });
      authorization = { scope_key: "north/maya", revision: "v2", allowed_outcomes: [] };
      await expect(runtime.callTool(DESCRIBE_ACTIONS_TOOL, { query: "quiet", limit: 2, cursor: first.next_cursor })).rejects.toMatchObject({ code: "CATALOG_CURSOR_INVALID" });
      expect(await runtime.callTool(DESCRIBE_ACTIONS_TOOL, {})).toMatchObject({ actions: [] });
      await expect(runtime.callTool(REQUEST_CHANGE_TOOL, { outcome: "billing.pause_0", subject_refs: { preference: `obj_${"a".repeat(43)}` } })).rejects.toMatchObject({ code: "SEMANTIC_ACTION_UNAVAILABLE" });
      expect(claim).not.toHaveBeenCalled();
      expect(resolveContext).not.toHaveBeenCalled();
      loaded = structuredClone(registry);
      loaded.rules[0]!.compiled.rule.name = "tampered.cached.metadata";
      await expect(runtime.callTool(DESCRIBE_ACTIONS_TOOL, {})).rejects.toMatchObject({ code: "ACTION_RULE_AUTHORITY_STALE" });
    } finally { store.close(); }
  });

  it("owns immutable registry snapshots and rejects oversized complete contracts without dropping constraints", () => {
    const { registry, activated } = semanticFixture({ businessInput: true, aliases: ["quiet"] });
    const caller = structuredClone(registry);
    const owned = snapshotActionRuleRegistry(caller);
    caller.rules[0]!.compiled.rule.name = "caller.mutated";
    expect(resolveActivatedActionRule(owned, activated.compiled.outcome).compiled.rule.name).toBe(activated.compiled.rule.name);
    expect(snapshotActionRuleRegistry(owned)).toBe(owned);
    expect(Object.isFrozen(owned.rules[0]!.compiled.rule.inputs![0]!.type)).toBe(true);
    expect(() => snapshotActionRuleRegistry(caller)).toThrow(/integrity/u);
    const compiled = structuredClone(activated.compiled);
    compiled.rule.inputs![0]!.description = "x".repeat(13_000);
    expect(() => assertActionDiscoveryContractFits(compiled, "human")).toThrow(/12288/u);
    expect(actionRuleDiscoveryContract(compiled, "human")).toHaveProperty("inputs.0.description", "x".repeat(13_000));
    compiled.rule.inputs![0]!.description = "x".repeat(6_000);
    expect(Buffer.byteLength(JSON.stringify(actionRuleDiscoveryContract(compiled, "human")))).toBeLessThan(12_288);
    expect(() => assertActionDiscoveryContractFits(compiled, "human")).toThrow(/MCP response budget/u);
    compiled.rule["x-runner-discovery"] = { title: "Pause", summary: "Pause", aliases: ["x".repeat(81)] };
    expect(() => actionRuleDiscoveryMetadata(compiled.rule)).toThrow(/aliases/u);
  });

  it.each([
    [false, false, "approved_pending_execution"],
    [false, true, "attention_required"],
    [true, false, "attention_required"],
    [true, true, "completed"],
  ] as const)("requires durable execution AND a receipt before reporting completion (%s, %s)", async (applied, receipt, expectedStatus) => {
    let continued = false;
    let proposalId = "";
    const fixture = createFixtureRuntime({ automaticApproval: true, onProposalReady: async ({ proposal }) => {
      continued = true; proposalId = proposal.proposal_id;
      return { execution: "completed", source_database_changed: true };
    } });
    const read = fixture.store.getProposal.bind(fixture.store);
    vi.spyOn(fixture.store, "getProposal").mockImplementation((id) => {
      const saved = read(id);
      return saved && continued && applied ? { ...saved, state: "applied", source_database_mutated: true } : saved;
    });
    const receiptTime = new Date().toISOString();
    vi.spyOn(fixture.store, "receipts").mockImplementation(() => receipt ? [{
      receipt_id: 1, writeback_job_id: "job_test", proposal_id: proposalId, runner_id: "test_worker",
      status: "applied", idempotency_key: "test", source_database_mutated: true, created_at: receiptTime,
      receipt: { schema_version: "synapsor.execution-receipt.v1", writeback_job_id: "job_test", proposal_id: proposalId,
        runner_id: "test_worker", status: "applied", rows_affected: 1, idempotency_key: "test",
        source_database_mutated: true, executed_at: receiptTime, receipt_hash: `sha256:${"a".repeat(64)}` },
    }] : []);
    try {
      const ref = await issueSubject(fixture);
      const result = await fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, {
        outcome: "billing.pause_notifications", subject_refs: { preference: ref },
      });
      expect(result).toMatchObject({ status: expectedStatus, execution: applied && receipt ? "completed" : "held",
        source_database_changed: applied && receipt ? true : applied || receipt ? null : false });
      if (applied && receipt) {
        expect(result.execution_receipt).toEqual({ verified: true, status: "applied", source_database_changed: true });
      } else {
        expect(result).not.toHaveProperty("execution_receipt");
      }
      expect(JSON.stringify(result)).not.toMatch(/wrp_rule_|job_test|test_worker|sha256:|raw-preference-42/u);
      if (!applied) expect(await fixture.store.approvals(proposalId)).toHaveLength(1);
    } finally { fixture.store.close(); }
  });

  it.each([
    ["queued", "approved", "queued", "queued", "open", false],
    ["held", "approved", "held", "not_started", "blocked", false],
    ["leased", "pending_worker", "held", "in_progress", "open", null],
    ["retry_wait", "approved", "held", "retry_wait", "open", null],
    ["blocked", "failed", "held", "failed", "blocked", null],
    ["discarded", "failed", "held", "failed", "closed", null],
    ["completed", "applied", "completed", "applied", "open", true],
    ["reconciliation_required", "reconciliation_required", "held", "unknown", "reconciliation_required", null],
  ] as const)("projects synthetic %s execution through real MCP replay without rewriting automatic history", async (queueStatus, state, execution, outcome, disposition, sourceChanged) => {
    const f = createFixtureRuntime({ automaticApproval: true,
      onProposalReady: async () => ({ execution: "human_review", source_database_changed: false }) });
    const args = { outcome: "billing.pause_notifications", subject_refs: { preference: await issueSubject(f) } };
    await f.semanticActions.callTool(REQUEST_CHANGE_TOOL, args);
    const original = f.store.listProposals()[0]!;
    const proposal = { ...original, state, source_database_mutated: state === "applied" };
    // Synthetic outcome controls only: normal admission/approval and real opaque
    // reference, with read responses representing worker states (no source run).
    vi.spyOn(f.store, "getProposal").mockReturnValue(proposal);
    vi.spyOn(f.store, "getWorkerQueueItem").mockReturnValue({ proposal_id: original.proposal_id,
      status: queueStatus, execution_mode: "supervised_worker", attempts: queueStatus === "queued" || queueStatus === "held" ? 0 : 1,
      max_attempts: 5, next_attempt_at: "2099-01-01T00:00:00.000Z", created_at: original.created_at,
      updated_at: original.updated_at, last_error_code: "PRIVATE_CAUSE_DO_NOT_DISCLOSE" });
    if (state === "failed" || state === "applied") {
      const status = state;
      vi.spyOn(f.store, "receipts").mockReturnValue([{ receipt_id: 1, writeback_job_id: "private_job",
        proposal_id: original.proposal_id, runner_id: "private_worker", status, idempotency_key: "private_idempotency",
        source_database_mutated: state === "applied", created_at: original.created_at,
        receipt: { schema_version: "synapsor.execution-receipt.v1", writeback_job_id: "private_job", proposal_id: original.proposal_id,
          runner_id: "private_worker", status, rows_affected: state === "applied" ? 1 : 0, idempotency_key: "private_idempotency",
          source_database_mutated: state === "applied", executed_at: original.created_at,
          receipt_hash: `sha256:${"f".repeat(64)}`, safe_error_code: "PRIVATE_CAUSE_DO_NOT_DISCLOSE" } }]);
    }
    const tables = () => f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map(row => [row.name, f.store.db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}"`).all()]);
    const runtime = createMcpRuntime(serverConfig, { store: f.store, semanticActions: f.semanticActions });
    const server = createSynapsorMcpServer(runtime), client = new Client({ name: "replay-lifecycle", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st); await client.connect(ct);
      const before = tables();
      const response = await client.callTool({ name: REQUEST_CHANGE_TOOL, arguments: args });
      expect(response.isError).not.toBe(true);
      const data = response.structuredContent as Record<string, any>;
      expect(data).toMatchObject({ request_disposition: "already_recorded", authorization: { approval: "automatic", execution },
        execution, lifecycle: { execution: outcome, disposition, automatic_retry_scheduled: queueStatus === "reconciliation_required" ? null : queueStatus === "retry_wait" },
        invocation: { operation: "returned_existing_request", source_database_changed: false }, source_database_changed: sourceChanged });
      expect(data.proposal.approval).toBe("automatically approved; apply remains a separate authority");
      if (queueStatus === "held") {
        expect(data.result_summary.next).toMatch(/cancellation requires separate current operator authority/i);
        expect(data.result_summary.next).not.toMatch(/can inspect and cancel/i);
      }
      expect(JSON.parse((response.content as Array<{text:string}>)[0]!.text)).toEqual(data);
      expect(JSON.stringify(response)).not.toMatch(/pending human review|limit did not pass|current authoritative facts|PRIVATE_CAUSE|private_job|private_worker|private_idempotency|raw-preference-42|acct_northstar|customer_maya/u);
      expect(tables()).toEqual(before);
      expect(f.queries).toHaveLength(1); // replay does not load source facts again
      expect(data.lifecycle.next_retry_at).toBe(queueStatus === "retry_wait" ? "2099-01-01T00:00:00.000Z" : null);
    } finally { await client.close(); await server.close(); await runtime.close(); }
  });

  it("does not tell a human to keep waiting after a delayed proposal's approval window ended", async () => {
    const f = createFixtureRuntime({ automaticApproval: false,
      onProposalReady: async () => ({ execution: "human_review", source_database_changed: false }) });
    try {
      await f.semanticActions.callTool(REQUEST_CHANGE_TOOL, { outcome: "billing.pause_notifications",
        subject_refs: { preference: await issueSubject(f) } });
      const original = f.store.listProposals()[0]!;
      const expired = { ...original, change_set: { ...original.change_set,
        delayed_work: { schema_version: "synapsor.delayed-semantic-work.v1", requested_at: new Date(Date.now() - 120_000).toISOString(),
          approval_wait_seconds: 60, approval_validity_seconds: 600, absolute_request_age_seconds: 3_600,
          max_validation_attempts: 4, execution_policy_digest: actionBoundary } } } as typeof original;
      vi.spyOn(f.store, "getProposal").mockReturnValue(expired);
      const view = await semanticRequestLifecycle(f.store, expired);
      expect(view).toMatchObject({ approval: "pending_human_review", execution: "held",
        status: "attention_required", lifecycle: { execution: "not_started", disposition: "blocked" } });
      expect(view.approvalText).toMatch(/waiting deadline/);
      expect(view.next).toMatch(/authorized local owner may terminally cancel only an unattempted new delayed request/);
      expect(view.next).not.toMatch(/wait for the separate authorized human review/i);
    } finally { f.store.close(); }
  });

  it("offers only conditional local cancellation guidance for a proven new delayed held item", async () => {
    const f = createFixtureRuntime({ automaticApproval: true,
      onProposalReady: async () => ({ execution: "human_review", source_database_changed: false }) });
    try {
      await f.semanticActions.callTool(REQUEST_CHANGE_TOOL, { outcome: "billing.pause_notifications",
        subject_refs: { preference: await issueSubject(f) } });
      const original = f.store.listProposals()[0]!;
      const delayed = { ...original, change_set: { ...original.change_set,
        delayed_work: { schema_version: "synapsor.delayed-semantic-work.v1",
          requested_at: original.created_at, approval_wait_seconds: 600,
          approval_validity_seconds: 600, absolute_request_age_seconds: 3_600,
          max_validation_attempts: 4, execution_policy_digest: actionBoundary } } } as typeof original;
      vi.spyOn(f.store, "getProposal").mockReturnValue(delayed);
      vi.spyOn(f.store, "getWorkerQueueItem").mockReturnValue({
        proposal_id: original.proposal_id, status: "held", execution_mode: "supervised_worker",
        cancellation_control_role: null, attempts: 0, max_attempts: 1,
        next_attempt_at: original.created_at, created_at: original.created_at,
        updated_at: original.updated_at,
      });
      const view = await semanticRequestLifecycle(f.store, delayed);
      expect(view.next).toMatch(/owning local installation operator may request terminal cancellation/);
      expect(view.next).toMatch(/current store and authority must still pass final checks/);
      expect(view.next).not.toMatch(/automatically cancel|automatically retry/);
    } finally { f.store.close(); }
  });

  it.each(["missing_approval", "wrong_approval", "conflicting_approval", "missing_receipt", "wrong_receipt", "duplicate_receipt", "changed_approval", "changed_receipt", "changed_event", "changed_queue", "changed_proposal"] as const)(
    "keeps synthetic %s evidence unknown instead of inventing a historical decision or effect", async mode => {
      const f = createFixtureRuntime({ automaticApproval: true });
      try {
        const args = { outcome: "billing.pause_notifications", subject_refs: { preference: await issueSubject(f) } };
        await f.semanticActions.callTool(REQUEST_CHANGE_TOOL, args);
        const original = f.store.listProposals()[0]!, approval = f.store.approvals(original.proposal_id)[0]!;
        const proposal = { ...original, state: "failed" as const };
        const queue = { proposal_id: original.proposal_id, status: "blocked" as const, execution_mode: "supervised_worker" as const,
          attempts: 1, max_attempts: 9, next_attempt_at: original.created_at, created_at: original.created_at, updated_at: original.updated_at };
        vi.spyOn(f.store, "getProposal").mockReturnValue(proposal);
        vi.spyOn(f.store, "getWorkerQueueItem").mockReturnValue(queue);
        if (mode === "missing_approval") vi.spyOn(f.store, "approvals").mockReturnValue([]);
        if (mode === "wrong_approval") vi.spyOn(f.store, "approvals").mockReturnValue([{ ...approval, proposal_hash: `sha256:${"f".repeat(64)}` }]);
        if (mode === "conflicting_approval") vi.spyOn(f.store, "approvals").mockReturnValue([approval, { ...approval, approval_id: approval.approval_id + 1, status: "rejected" }]);
        if (mode === "changed_approval") vi.spyOn(f.store, "approvals").mockReturnValueOnce([approval]).mockReturnValue([]);
        if (mode === "changed_event") { const savedEvents = f.store.events(original.proposal_id); vi.spyOn(f.store, "events").mockReturnValueOnce([]).mockReturnValue(savedEvents); }
        if (mode === "changed_queue") vi.spyOn(f.store, "getWorkerQueueItem").mockReturnValueOnce(queue).mockReturnValue({ ...queue, status: "discarded" });
        if (mode === "changed_proposal") vi.spyOn(f.store, "getProposal").mockReturnValueOnce(proposal).mockReturnValueOnce(proposal).mockReturnValue({ ...proposal, state: "applied" });
        const receipt = { receipt_id: 1, writeback_job_id: "synthetic", proposal_id: original.proposal_id, runner_id: "worker", status: "failed",
          idempotency_key: "synthetic", source_database_mutated: false, created_at: original.created_at,
          receipt: { schema_version: "synapsor.execution-receipt.v1" as const, writeback_job_id: "synthetic", proposal_id: original.proposal_id, runner_id: "worker",
            status: "failed" as const, rows_affected: 0, idempotency_key: "synthetic", source_database_mutated: false, executed_at: original.created_at,
            receipt_hash: `sha256:${"f".repeat(64)}` as const } };
        if (mode === "wrong_receipt") vi.spyOn(f.store, "receipts").mockReturnValue([{...receipt, proposal_id:"another"}]);
        if (mode === "duplicate_receipt") vi.spyOn(f.store, "receipts").mockReturnValue([receipt, {...receipt, receipt_id:2}]);
        if (mode === "changed_receipt") vi.spyOn(f.store, "receipts").mockReturnValueOnce([receipt]).mockReturnValue([]);
        const before = f.store.sharedLedgerEntries();
        const response = await f.semanticActions.callTool(REQUEST_CHANGE_TOOL, args);
        expect(response).toMatchObject({ request_disposition: "already_recorded", execution: "held", source_database_changed: null });
        expect(JSON.stringify(response)).not.toMatch(/pending human review|limit did not pass|current authoritative facts/);
        if (mode.includes("approval") || mode.startsWith("changed_")) expect(response.authorization).toMatchObject({approval:"unknown"});
        expect(f.store.sharedLedgerEntries()).toEqual(before);
      } finally { f.store.close(); }
    });

  it("keeps fixed tools discoverable while a stale outcome is blocked before facts or proposals", async () => {
    let unavailable = ["billing.pause_notifications"];
    const fixture = createFixtureRuntime({ unavailableOutcomes: () => unavailable });
    try {
      const tools = fixture.semanticActions.listTools();
      expect(await fixture.semanticActions.callTool(DESCRIBE_ACTIONS_TOOL, {})).toMatchObject({
        actions: [{ outcome: unavailable[0], availability: "operator_review_required" }],
      });
      const ref = await issueSubject(fixture);
      const request = { outcome: "billing.pause_notifications", subject_refs: { preference: ref } };
      await expect(fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, request)).rejects.toMatchObject({ code: "SEMANTIC_ACTION_UNAVAILABLE" });
      expect(fixture.queries).toHaveLength(0);
      expect(await fixture.store.listProposals()).toHaveLength(0);
      unavailable = [];
      expect(fixture.semanticActions.listTools()).toEqual(tools);
      expect(await fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, request)).toMatchObject({ request_disposition: "created" });
    } finally { fixture.store.close(); }
  });

  it("discovers and validates business inputs before consuming subjects and binds replay to exact values", async () => {
    const fixture = createFixtureRuntime({ businessInput: true });
    try {
      const catalog = await fixture.semanticActions.callTool(DESCRIBE_ACTIONS_TOOL, {});
      expect(catalog).toMatchObject({ actions: [{ inputs: [{ name: "notification_state", required: true, type: { kind: "string", enum: ["active", "paused"] } }] }] });
      expect(catalog).toMatchObject({ actions: [{ request_shape: { outcome: "billing.pause_notifications",
        subject_refs: { preference: "obj_<opaque reference>" }, inputs: { notification_state: expect.any(String) } },
        eligibility: expect.stringContaining("not_checked") }] });
      expect(fixture.queries).toHaveLength(0);
      const ref = await issueSubject(fixture);
      const request = { outcome: "billing.pause_notifications", subject_refs: { preference: ref } };
      for (const inputs of [undefined, {}, { notification_state: "anything" }, { notification_state: "paused", tenant_id: "attacker" }]) {
        await expect(fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, { ...request, ...(inputs ? { inputs } : {}) })).rejects.toMatchObject({ code: "ARGUMENT_INVALID" });
      }
      expect(fixture.queries).toHaveLength(0);
      const accepted = await fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, { ...request, inputs: { notification_state: "paused" } });
      expect(accepted).toMatchObject({ request_disposition: "created", source_database_changed: false });
      expect(await fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, { ...request, inputs: { notification_state: "paused" } })).toMatchObject({ request_disposition: "already_recorded" });
      await expect(fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, { ...request, inputs: { notification_state: "active" } })).rejects.toMatchObject({ code: "SUBJECT_REFERENCE_UNAVAILABLE" });
      expect(fixture.semanticActions.listTools().map((tool) => tool.name)).toEqual([DESCRIBE_ACTIONS_TOOL, REQUEST_CHANGE_TOOL]);
    } finally {
      fixture.store.close();
    }
  });

  it("describes only activated outcomes and accepts no model patch or trusted scope", async () => {
    const fixture = createFixtureRuntime();
    try {
      expect(fixture.semanticActions.listTools().map((tool) => tool.name)).toEqual([
        DESCRIBE_ACTIONS_TOOL,
        REQUEST_CHANGE_TOOL,
      ]);
      const described = await fixture.semanticActions.callTool(DESCRIBE_ACTIONS_TOOL, {});
      expect(described).toMatchObject({
        actions: [{
          outcome: "billing.pause_notifications",
          subjects: [{ binding: "preference", reference: "opaque Explore subject reference" }],
          proposal_effect: { operation: "update", fields: ["status"], max_rows: 1 },
        }],
        authority: {
          model_can_supply_patch: false,
          model_can_supply_trusted_scope: false,
          approval_and_apply_are_separate: true,
        },
        source_database_changed: false,
      });
      expect(JSON.stringify(described)).not.toMatch(/sha256:|account_id|principal_id|SELECT\s/iu);

      const ref = await issueSubject(fixture);
      for (const untrustedField of [
        { patch: { status: "paused" } },
        { cancellation_control_role: "attacker_operator" },
      ]) {
        await expect(fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, {
          outcome: "billing.pause_notifications",
          subject_refs: { preference: ref },
          ...untrustedField,
        })).rejects.toMatchObject({ code: "ARGUMENT_INVALID" });
      }
      expect(await fixture.store.listProposals()).toHaveLength(0);
    } finally {
      fixture.store.close();
    }
  });

  it.each([false, true])("replays concurrent identical requests without duplicate creation or approval (automatic=%s)", async automaticApproval => {
    const fixture = createFixtureRuntime({ automaticApproval });
    try {
      const ref = await issueSubject(fixture);
      const request = { outcome: "billing.pause_notifications", subject_refs: { preference: ref } };
      const results = await Promise.allSettled([
        fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, request),
        fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, request),
      ]);
      expect(results.map(result => result.status === "fulfilled" ? "fulfilled"
        : (result.reason as { code?: string }).code ?? String(result.reason))).toEqual(["fulfilled", "fulfilled"]);
      const values = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      expect(values.map(value => value.request_disposition).sort()).toEqual(["already_recorded", "created"]);
      expect(values.every(value => value.source_database_changed === false)).toBe(true);
      const proposals = await fixture.store.listProposals();
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.state).toBe(automaticApproval ? "approved" : "pending_review");
      expect(await fixture.store.approvals(proposals[0]!.proposal_id)).toHaveLength(automaticApproval ? 1 : 0);
    } finally { fixture.store.close(); }
  });

  it("coordinates distinct runtime instances borrowing the same store without sharing results", async () => {
    const first = createFixtureRuntime({ automaticApproval: true });
    const second = createFixtureRuntime({ store: first.store, automaticApproval: true });
    try {
      const request = { outcome: "billing.pause_notifications", subject_refs: { preference: await issueSubject(first) } };
      const results = await Promise.all([first.semanticActions.callTool(REQUEST_CHANGE_TOOL, request),
        second.semanticActions.callTool(REQUEST_CHANGE_TOOL, request)]);
      expect(results.map(result => result.request_disposition).sort()).toEqual(["already_recorded", "created"]);
      expect(first.queries.length + second.queries.length).toBe(1);
      const proposals = first.store.listProposals();
      expect(proposals).toHaveLength(1);
      expect(first.store.approvals(proposals[0]!.proposal_id)).toHaveLength(1);
    } finally { first.store.close(); }
  });

  it.each(["authority", "scope"])("rechecks queued %s instead of reusing an earlier caller's authorized result", async change => {
    let unavailable: string[] = [], scope = authorityContext();
    const fixture = createFixtureRuntime({ automaticApproval: true, unavailableOutcomes: () => unavailable,
      subjectAuthority: () => scope, onProposalReady: async () => {
        if (change === "authority") unavailable = ["billing.pause_notifications"];
        else scope = { ...scope, principal_scope_fingerprint: canonicalJsonDigest("different caller") };
        return { execution: "queued", source_database_changed: false };
      } });
    try {
      const request = { outcome: "billing.pause_notifications", subject_refs: { preference: await issueSubject(fixture) } };
      const results = await Promise.allSettled([fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, request),
        fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, request)]);
      expect(results[0]!.status).toBe("fulfilled");
      expect(results[1]).toMatchObject({ status: "rejected", reason: {
        code: change === "authority" ? "SEMANTIC_ACTION_UNAVAILABLE" : "SUBJECT_REFERENCE_UNAVAILABLE" } });
      expect(fixture.queries).toHaveLength(1);
      expect(fixture.store.listProposals()).toHaveLength(1);
    } finally { fixture.store.close(); }
  });

  it("releases failed admission and reruns current verification for the waiting request", async () => {
    let first = true;
    const fixture = createFixtureRuntime({ automaticApproval: true, beforeLoad: async () => {
      if (first) { first = false; throw Object.assign(new Error("test source unavailable"), { code: "ECONNRESET" }); }
    } });
    try {
      const request = { outcome: "billing.pause_notifications", subject_refs: { preference: await issueSubject(fixture) } };
      const results = await Promise.allSettled([fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, request),
        fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, request)]);
      expect(results[0]!.status).toBe("rejected");
      expect(results[1]).toMatchObject({ status: "fulfilled", value: { request_disposition: "created" } });
      expect(await fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, request)).toMatchObject({ request_disposition: "already_recorded" });
      expect(fixture.store.listProposals()).toHaveLength(1);
    } finally { fixture.store.close(); }
  });

  it("does not turn changed business inputs into an identical request replay", async () => {
    const fixture = createFixtureRuntime({ businessInput: true });
    try {
      const subject_refs = { preference: await issueSubject(fixture) };
      const results = await Promise.allSettled(["paused", "active"].map(notification_state => fixture.semanticActions.callTool(
        REQUEST_CHANGE_TOOL, { outcome: "billing.pause_notifications", subject_refs, inputs: { notification_state } })));
      expect(results[0]).toMatchObject({ status: "fulfilled", value: { request_disposition: "created" } });
      expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "SUBJECT_REFERENCE_UNAVAILABLE" } });
      expect(fixture.store.listProposals()).toHaveLength(1);
    } finally { fixture.store.close(); }
  });

  it("keeps unrelated requests concurrent while the exact atomic approval limit decides the winner", async () => {
    let release!: () => void, waiting = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fixture = createFixtureRuntime({ automaticApproval: true, preferences: [
      { preference_id: "raw-preference-42", status: "active", version: 4 },
      { preference_id: "raw-preference-43", status: "active", version: 2 },
    ], beforeLoad: async query => {
      if (query.predicates.some(predicate => predicate.operation === "eq" && predicate.value === "raw-preference-42")) {
        waiting = true; await gate;
      }
    } });
    const work: Array<Promise<Record<string, unknown>>> = [];
    try {
      const first = await issueSubject(fixture), second = await issueSubject(fixture, "raw-preference-43", 2);
      work.push(fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, { outcome: "billing.pause_notifications", subject_refs: { preference: first } }));
      await vi.waitFor(() => expect(waiting).toBe(true));
      let completed = false;
      work.push(fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, { outcome: "billing.pause_notifications", subject_refs: { preference: second } })
        .then(result => { completed = true; return result; }));
      await vi.waitFor(() => expect(completed).toBe(true));
      release();
      await Promise.all(work);
      const proposals = fixture.store.listProposals();
      expect(proposals.map(proposal => proposal.state).sort()).toEqual(["approved", "pending_review"]);
      expect(proposals.flatMap(proposal => fixture.store.approvals(proposal.proposal_id))).toHaveLength(1);
    } finally { release(); await Promise.allSettled(work); fixture.store.close(); }
  });

  it.each([false, true])("preserves competing different-request conflict and approval checks (separate stores=%s)", async separateStores => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "semantic-request-race-"));
    const firstStore = new ProposalStore(path.join(directory, "requests.sqlite"));
    const secondStore = separateStores ? new ProposalStore(firstStore.path) : firstStore;
    const first = createFixtureRuntime({ store: firstStore, automaticApproval: true });
    const second = createFixtureRuntime({ store: secondStore, automaticApproval: true });
    try {
      const refs = [await issueSubject(first), await issueSubject(second)];
      const results = await Promise.allSettled([first, second].map((fixture, index) => fixture.semanticActions.callTool(
        REQUEST_CHANGE_TOOL, { outcome: "billing.pause_notifications", subject_refs: { preference: refs[index]! } })));
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "PROPOSAL_ALREADY_EXISTS" } });
      const proposals = firstStore.listProposals();
      expect(proposals).toHaveLength(1);
      expect(firstStore.approvals(proposals[0]!.proposal_id)).toHaveLength(1);
    } finally { if (separateStores) secondStore.close(); firstStore.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps the final automatic approval atomic for different subjects across separate store instances", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "semantic-approval-race-"));
    const firstStore = new ProposalStore(path.join(directory, "requests.sqlite"));
    const secondStore = new ProposalStore(firstStore.path);
    let release!: () => void, arrivals = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const beforeLoad = async () => { if (++arrivals === 2) release(); await gate; };
    const preferences = [
      { preference_id: "raw-preference-42", status: "active" as const, version: 4 },
      { preference_id: "raw-preference-43", status: "active" as const, version: 2 },
    ];
    const first = createFixtureRuntime({ store: firstStore, automaticApproval: true, beforeLoad, preferences });
    const second = createFixtureRuntime({ store: secondStore, automaticApproval: true, beforeLoad, preferences });
    const work: Array<Promise<Record<string, unknown>>> = [];
    try {
      const refs = [await issueSubject(first), await issueSubject(second, "raw-preference-43", 2)];
      for (const [index, fixture] of [first, second].entries()) {
        work.push(fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, {
          outcome: "billing.pause_notifications", subject_refs: { preference: refs[index]! },
        }));
      }
      await vi.waitFor(() => expect(arrivals).toBe(2));
      const results = await Promise.all(work);
      expect(results.every(result => result.request_disposition === "created" && result.source_database_changed === false)).toBe(true);
      const proposals = firstStore.listProposals();
      expect(proposals.map(proposal => proposal.state).sort()).toEqual(["approved", "pending_review"]);
      expect(proposals.flatMap(proposal => secondStore.approvals(proposal.proposal_id))).toHaveLength(1);
    } finally { release(); await Promise.allSettled(work); secondStore.close(); firstStore.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["insurer", "overall"] as const)("counts a later committed approval when an earlier claimed request resumes at the last %s slot", async scope => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "semantic-approval-time-"));
    const firstStore = new ProposalStore(path.join(directory, "requests.sqlite"));
    const secondStore = new ProposalStore(firstStore.path);
    const baseTime = Date.parse("2026-09-02T20:02:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(baseTime);
    let release!: () => void, arrived!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { arrived = resolve; });
    const sharedLimits: ActionRuleApprovalClassSourceV1["shared_limits"] = [
      { id: "overall_24h", kind: "count", scope: "capability", maximum: 8, window_seconds: 86400, capability: "billing.pause_notifications" },
      { id: "insurer_24h", kind: "count", scope: "tenant", maximum: 3, window_seconds: 86400, capability: "billing.pause_notifications" },
    ];
    const preferences = Array.from({ length: 12 }, (_, i) => ({ preference_id: `claim-${i}`, status: "active" as const, version: 4 }));
    const fixtures = new Map<string, ReturnType<typeof createFixtureRuntime>>();
    const fixture = (tenant: string, principal: string, slow = false) => {
      const key = `${tenant}:${principal}`;
      if (!fixtures.has(key)) fixtures.set(key, createFixtureRuntime({ store: slow ? firstStore : secondStore,
        automaticApproval: true, tenant, principal, preferences, sharedLimits, clock: () => new Date().toISOString(),
        beforeLoad: async query => {
          if (slow && query.predicates.some(p => p.operation === "eq" && p.value === "claim-10")) { arrived(); await gate; }
        } }));
      return fixtures.get(key)!;
    };
    const request = async (f: ReturnType<typeof createFixtureRuntime>, id: number) => ({
      outcome: "billing.pause_notifications", subject_refs: { preference: await issueSubject(f, `claim-${id}`) },
    });
    let pending: Promise<Record<string, unknown>> | undefined;
    try {
      // All history enters through the real semantic request/approval path.
      const history = scope === "insurer" ? ["insurer-a", "insurer-a"]
        : ["insurer-a", "insurer-a", "insurer-a", "insurer-b", "insurer-b", "insurer-c", "insurer-c"];
      for (const [id, tenant] of history.entries()) {
        const f = fixture(tenant, "adjuster-history");
        expect(await f.semanticActions.callTool(REQUEST_CHANGE_TOOL, await request(f, id))).toMatchObject({
          authorization: { approval: "automatic" }, source_database_changed: false,
        });
      }
      const first = fixture(scope === "insurer" ? "insurer-a" : "insurer-b", "adjuster-first", true);
      const second = fixture(scope === "insurer" ? "insurer-a" : "insurer-c", "adjuster-second");
      const firstRequest = await request(first, 10), secondRequest = await request(second, 11);
      vi.setSystemTime(baseTime + 1000);
      pending = first.semanticActions.callTool(REQUEST_CHANGE_TOOL, firstRequest);
      await entered; // The first request has claimed its reference and is loading facts.
      vi.setSystemTime(baseTime + 2000);
      expect(await second.semanticActions.callTool(REQUEST_CHANGE_TOOL, secondRequest)).toMatchObject({
        authorization: { approval: "automatic" }, source_database_changed: false,
      });
      const committed = secondStore.listProposals().flatMap(p => secondStore.approvals(p.proposal_id));
      expect(committed).toHaveLength(history.length + 1);
      vi.setSystemTime(baseTime + 3000);
      release();
      expect(await pending).toMatchObject({ proposal: { status: "pending_review" }, source_database_changed: false });
      const proposals = firstStore.listProposals();
      expect(proposals.filter(p => p.state === "approved")).toHaveLength(history.length + 1);
      expect(proposals.filter(p => p.state === "pending_review")).toHaveLength(1);
      expect(proposals.flatMap(p => firstStore.approvals(p.proposal_id))).toEqual(committed);
      expect(preferences.every(p => p.status === "active" && p.version === 4)).toBe(true);
    } finally {
      release(); await pending?.catch(() => undefined); vi.useRealTimers(); secondStore.close(); firstStore.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([2, 8])("grants exactly the available allowance under concurrent load (overall allowance=%s)", async maximum => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "semantic-approval-capacity-"));
    const store = new ProposalStore(path.join(directory, "requests.sqlite"));
    let entered!: () => void, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const arrived = new Promise<void>(resolve => { entered = resolve; });
    const fixture = createFixtureRuntime({ store, automaticApproval: true,
      sharedLimits: [
        { id: "overall", scope: "capability", kind: "count", maximum, window_seconds: 86400 },
        { id: "insurer", scope: "tenant", kind: "count", maximum: 8, window_seconds: 86400 },
      ],
      preferences: [0, 1, 2].map(i => ({ preference_id: `capacity-${i}`, status: "active", version: 4 })),
      beforeLoad: async query => {
        if (query.predicates.some(p => p.operation === "eq" && p.value === "capacity-0")) { entered(); await gate; }
      },
    });
    const work: Array<Promise<Record<string, unknown>>> = [];
    try {
      const requests = await Promise.all([0, 1, 2].map(async i => ({ outcome: "billing.pause_notifications",
        subject_refs: { preference: await issueSubject(fixture, `capacity-${i}`) } })));
      work.push(fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, requests[0]!));
      await arrived;
      // A real duplicate waits at the product mutex while distinct requests progress.
      work.push(fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, requests[0]!));
      const other = await Promise.all(requests.slice(1).map(r => fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, r)));
      release();
      const results = [...await Promise.all(work), ...other];
      expect(results.every(r => r.ok === true && r.source_database_changed === false)).toBe(true);
      const proposals = store.listProposals();
      expect(proposals).toHaveLength(3);
      expect(proposals.filter(p => p.state === "approved")).toHaveLength(Math.min(maximum, 3));
      expect(proposals.filter(p => p.state === "pending_review")).toHaveLength(Math.max(3 - maximum, 0));
      expect(proposals.flatMap(p => store.approvals(p.proposal_id))).toHaveLength(Math.min(maximum, 3));
      for (const request of requests) expect(await fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, request))
        .toMatchObject({ request_disposition: "already_recorded" });
      expect(store.listProposals().flatMap(p => store.approvals(p.proposal_id))).toHaveLength(Math.min(maximum, 3));
    } finally { release(); await Promise.allSettled(work); store.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("retains a committed automatic decision across lost acknowledgement and restart before queue publication", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "semantic-approval-restart-"));
    const storePath = path.join(directory, "requests.sqlite");
    let store = new ProposalStore(storePath);
    const create = (loseAcknowledgement: boolean) => createFixtureRuntime({ store, automaticApproval: true,
      onProposalReady: async ({ proposal, activated }) => {
        if (loseAcknowledgement) throw new Error("simulated lost acknowledgement before queue publication");
        if (proposal.state === "approved") {
          store.enqueueWorkerProposal({ proposal_id: proposal.proposal_id, execution_mode: "supervised_worker",
            contract_digest: activated.action_boundary_digest });
          return { execution: "queued", source_database_changed: false };
        }
        return { execution: "human_review", source_database_changed: false };
      } });
    try {
      const first = create(true);
      const request = { outcome: "billing.pause_notifications", subject_refs: { preference: await issueSubject(first) } };
      await expect(first.semanticActions.callTool(REQUEST_CHANGE_TOOL, request)).rejects.toThrow("simulated lost acknowledgement");
      const [approved] = store.listProposals();
      expect(approved!.state).toBe("approved");
      const decisions = store.approvals(approved!.proposal_id);
      expect(decisions).toHaveLength(1);
      expect(store.getWorkerQueueItem(approved!.proposal_id)).toBeUndefined();
      store.close(); store = new ProposalStore(storePath);
      const restarted = create(false);
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await restarted.semanticActions.callTool(REQUEST_CHANGE_TOOL, request)).toMatchObject({
          request_disposition: "already_recorded", authorization: { approval: "automatic", execution: "queued" },
        });
      }
      expect(store.approvals(approved!.proposal_id)).toEqual(decisions);
      expect(store.db.prepare("SELECT COUNT(*) AS n FROM worker_queue").get()).toEqual({ n: 1 });
      // A permanently blocked worker still leaves the committed event counted.
      const lease = store.claimWorkerItem({ workerId: "test-worker", executionMode: "supervised_worker",
        contractDigest: restarted.activated.action_boundary_digest });
      expect(lease?.proposal_id).toBe(approved!.proposal_id);
      store.blockWorkerItem({ proposalId: approved!.proposal_id, workerId: "test-worker", leaseId: lease!.lease_id!,
        errorCode: "TRUSTED_BINDING_MISSING" });
      expect(store.approvals(approved!.proposal_id)).toEqual(decisions);
      const next = createFixtureRuntime({ store, automaticApproval: true, preferences: [{ preference_id: "next", status: "active", version: 4 }] });
      expect(await next.semanticActions.callTool(REQUEST_CHANGE_TOOL, { outcome: "billing.pause_notifications",
        subject_refs: { preference: await issueSubject(next, "next") } })).toMatchObject({ proposal: { status: "pending_review" } });
      expect(store.listProposals().flatMap(p => store.approvals(p.proposal_id))).toHaveLength(1);
    } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("rolls back an aborted automatic decision without spending either allowance or reporting human-review success", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "semantic-approval-abort-"));
    const store = new ProposalStore(path.join(directory, "requests.sqlite"));
    const fixture = createFixtureRuntime({ store, automaticApproval: true,
      preferences: [0, 1].map(i => ({ preference_id: `abort-${i}`, status: "active", version: 4 })) });
    try {
      store.db.exec(`CREATE TRIGGER fail_automatic_approval AFTER INSERT ON approvals
        BEGIN SELECT RAISE(ABORT, 'simulated durable approval failure'); END`);
      const request = { outcome: "billing.pause_notifications", subject_refs: { preference: await issueSubject(fixture, "abort-0") } };
      await expect(fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, request)).rejects.toThrow("simulated durable approval failure");
      const [pending] = store.listProposals();
      expect(pending!.state).toBe("pending_review");
      expect(store.approvals(pending!.proposal_id)).toEqual([]);
      expect(store.getWorkerQueueItem(pending!.proposal_id)).toBeUndefined();
      expect(store.events(pending!.proposal_id).some(e => e.kind === "proposal_approved")).toBe(false);
      store.db.exec("DROP TRIGGER fail_automatic_approval");
      expect(await fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, { outcome: "billing.pause_notifications",
        subject_refs: { preference: await issueSubject(fixture, "abort-1") } })).toMatchObject({ authorization: { approval: "automatic" } });
      expect(store.listProposals().flatMap(p => store.approvals(p.proposal_id))).toHaveLength(1);
    } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("loads scoped authoritative facts and creates one idempotent Runner-derived proposal", async () => {
    const fixture = createFixtureRuntime();
    try {
      const ref = await issueSubject(fixture);
      const request = {
        outcome: "billing.pause_notifications",
        subject_refs: { preference: ref },
      };
      const created = await fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, request);
      const retried = await fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, request);
      expect(created).toMatchObject({
        status: "pending_human_review",
        request_disposition: "created",
        result_summary: {
          description: "Pause notifications",
          fields: ["status"],
          values_disclosed: false,
        },
        authorization: {
          eligibility: "verified",
          approval: "pending_human_review",
          execution: "human_review",
        },
        eligibility: "verified from current authoritative facts",
        source_database_changed: false,
        model_authority: {
          supplied_outcome_and_opaque_subjects_only: true,
          supplied_patch: false,
          approval: false,
          apply: false,
        },
      });
      expect(retried).toMatchObject({
        status: "pending_human_review",
        request_disposition: "already_recorded",
      });
      expect(created.status_check).toMatchObject({ tool: REQUEST_CHANGE_TOOL,
        guidance: expect.stringContaining("original subject_refs"),
        completion_evidence: expect.stringContaining("verified execution_receipt"),
      });
      expect(retried.status_check).toEqual(created.status_check);
      expect(fixture.semanticActions.listTools().find((tool) => tool.name === REQUEST_CHANGE_TOOL)?.description)
        .toContain("Do not obtain new references to check status");
      expect(created).not.toHaveProperty("proposal_id");
      expect(retried).not.toHaveProperty("proposal_id");
      expect(fixture.queries).toHaveLength(1);
      expect(fixture.queries[0]).toMatchObject({
        binding: "preference",
        projection: ["account_id", "preference_id", "principal_id", "status", "version"],
        predicates: [
          { operation: "eq", column: "preference_id", value: "raw-preference-42" },
          { operation: "eq", column: "account_id", value: "acct_northstar" },
          { operation: "eq", column: "principal_id", value: "customer_maya" },
        ],
        limit: 2,
        lock: "none",
      });

      const proposals = await fixture.store.listProposals();
      expect(proposals).toHaveLength(1);
      expect(proposals[0]?.change_set).toMatchObject({
        schema_version: "synapsor.change-set.v4",
        patch: { status: "paused" },
        before: { preference_id: "raw-preference-42", version: 4 },
        after: { preference_id: "raw-preference-42", status: "paused", version: 5 },
        guards: {
          tenant: { column: "account_id", value: "acct_northstar" },
          principal_scope: { column: "principal_id", value: "customer_maya" },
        },
        source_database_mutated: false,
      });
      expect(proposals[0]?.change_set.before).not.toHaveProperty("status");
      const modelResult = JSON.stringify({ created, retried });
      expect(modelResult).not.toMatch(/raw-preference-42|acct_northstar|customer_maya|"status":"paused"|sha256:/u);

      const modelResource = projectLocalResourceForModel({
        proposal: proposals[0],
        events: await fixture.store.events(proposals[0]!.proposal_id),
        receipts: await fixture.store.receipts(proposals[0]!.proposal_id),
      });
      const serializedResource = JSON.stringify(modelResource);
      expect(serializedResource).not.toMatch(/raw-preference-42|acct_northstar|customer_maya|"paused"|sha256:/u);
      expect(serializedResource).toContain("Runner-derived");

      expect(await fixture.store.listEvidenceBundles?.()).toHaveLength(1);
      expect(await fixture.store.listQueryAudit?.()).toHaveLength(1);
    } finally {
      fixture.store.close();
    }
  });

  it("auto-approves only under the exact policy and falls back to human review when an atomic limit trips", async () => {
    const continuations: string[] = [];
    const fixture = createFixtureRuntime({
      automaticApproval: true,
      onProposalReady: async ({ proposal, activated }) => {
        continuations.push(proposal.state);
        if (proposal.state === "approved") fixture.store.enqueueWorkerProposal({ proposal_id: proposal.proposal_id,
          execution_mode: "supervised_worker", contract_digest: activated.action_boundary_digest });
        return {
          execution: proposal.state === "approved" ? "queued" : "human_review",
          source_database_changed: false,
        };
      },
      preferences: [
        { preference_id: "raw-preference-42", status: "active", version: 4 },
        { preference_id: "raw-preference-43", status: "active", version: 2 },
      ],
    });
    try {
      const firstRef = await issueSubject(fixture, "raw-preference-42", 4);
      const first = await fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, {
        outcome: "billing.pause_notifications",
        subject_refs: { preference: firstRef },
      });
      expect(first).toMatchObject({
        status: "approved_pending_execution",
        authorization: {
          eligibility: "verified",
          approval: "automatic",
          execution: "queued",
        },
        proposal: {
          status: "approved",
          approval: "automatically approved; apply remains a separate authority",
        },
        execution: "queued",
        source_database_changed: false,
      });

      const secondRef = await issueSubject(fixture, "raw-preference-43", 2);
      const second = await fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, {
        outcome: "billing.pause_notifications",
        subject_refs: { preference: secondRef },
      });
      expect(second).toMatchObject({
        status: "pending_human_review",
        authorization: {
          eligibility: "verified",
          approval: "pending_human_review",
          execution: "human_review",
        },
        proposal: {
          status: "pending_review",
          approval: "pending human review because a recorded automatic-approval limit did not pass",
        },
        execution: "human_review",
        source_database_changed: false,
      });
      expect(continuations).toEqual(["approved", "pending_review"]);
      // Exhaustion caused a new recorded review result; it cannot rewrite the
      // original automatic decision on replay.
      const oldHistory = fixture.store.approvals(fixture.store.listProposals().find(p => p.state === "approved")!.proposal_id);
      expect(await fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, { outcome: "billing.pause_notifications", subject_refs: { preference: firstRef } }))
        .toMatchObject({ request_disposition: "already_recorded", authorization: { approval: "automatic" }, lifecycle: { execution: "queued" } });
      expect(fixture.store.approvals(fixture.store.listProposals().find(p => p.state === "approved")!.proposal_id)).toEqual(oldHistory);
      const proposals = await fixture.store.listProposals();
      expect(proposals.map((proposal) => proposal.state).sort()).toEqual(["approved", "pending_review"]);
      expect(await fixture.store.approvals?.(proposals.find((proposal) => proposal.state === "approved")!.proposal_id)).toHaveLength(1);
      expect(await fixture.store.approvals?.(proposals.find((proposal) => proposal.state === "pending_review")!.proposal_id)).toHaveLength(0);
      expect(await fixture.store.events(proposals.find((proposal) => proposal.state === "pending_review")!.proposal_id))
        .toEqual(expect.arrayContaining([expect.objectContaining({ kind: "policy_auto_approval_deferred" })]));
    } finally {
      fixture.store.close();
    }
  });

  it("keeps a distinct human fallback quorum without blocking an exact automatic policy match", async () => {
    const fixture = createFixtureRuntime({
      automaticApproval: true,
      requiredApprovals: 2,
      preferences: [
        { preference_id: "raw-preference-42", status: "active", version: 4 },
        { preference_id: "raw-preference-43", status: "active", version: 2 },
      ],
    });
    try {
      const firstRef = await issueSubject(fixture, "raw-preference-42", 4);
      await fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, {
        outcome: "billing.pause_notifications",
        subject_refs: { preference: firstRef },
      });
      const first = (await fixture.store.listProposals()).find((proposal) => proposal.state === "approved");
      expect(first?.change_set.approval).toMatchObject({ mode: "policy", required_approvals: 2 });
      expect(await fixture.store.approvals?.(first!.proposal_id)).toEqual([
        expect.objectContaining({ approver: "policy:billing.standard_change", status: "approved" }),
      ]);

      const secondRef = await issueSubject(fixture, "raw-preference-43", 2);
      await fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, {
        outcome: "billing.pause_notifications",
        subject_refs: { preference: secondRef },
      });
      const pending = (await fixture.store.listProposals()).find((proposal) => proposal.state === "pending_review");
      expect(pending?.change_set.approval.required_approvals).toBe(2);
      const afterOne = fixture.store.approveProposal(pending!.proposal_id, {
        approver: "reviewer_a",
        proposal_hash: pending!.proposal_hash,
        proposal_version: pending!.proposal_version,
      });
      expect(afterOne.state).toBe("pending_review");
      const afterTwo = fixture.store.approveProposal(pending!.proposal_id, {
        approver: "reviewer_b",
        proposal_hash: pending!.proposal_hash,
        proposal_version: pending!.proposal_version,
      });
      expect(afterTwo.state).toBe("approved");
    } finally {
      fixture.store.close();
    }
  });

  it("reports durable human approval as human instead of inventing policy approval", async () => {
    const fixture = createFixtureRuntime();
    try {
      const ref = await issueSubject(fixture);
      const request = {
        outcome: "billing.pause_notifications",
        subject_refs: { preference: ref },
      };
      await fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, request);
      const [proposal] = await fixture.store.listProposals();
      if (!proposal) throw new Error("Expected one semantic proposal.");
      fixture.store.approveProposal(proposal.proposal_id, {
        approver: "billing_reviewer",
        proposal_hash: proposal.proposal_hash,
        proposal_version: proposal.proposal_version,
      });

      const retried = await fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, request);
      expect(retried).toMatchObject({
        status: "approved_pending_execution",
        request_disposition: "already_recorded",
        authorization: {
          eligibility: "verified",
          approval: "human",
          execution: "not_enabled",
        },
        proposal: {
          status: "approved",
          approval: "approved by a human reviewer; apply remains a separate authority",
        },
        source_database_changed: false,
      });
      fixture.store.enqueueWorkerProposal({ proposal_id: proposal.proposal_id, execution_mode: "supervised_worker", contract_digest: fixture.activated.action_boundary_digest });
      expect(await fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, request)).toMatchObject({ authorization: { approval: "human", execution: "queued" },
        lifecycle: { execution: "queued", disposition: "open", automatic_retry_scheduled: false } });
    } finally {
      fixture.store.close();
    }
  });

  it("collapses forged subjects and refuses ineligible or unknown facts without creating a proposal", async () => {
    const forged = createFixtureRuntime();
    try {
      await expect(forged.semanticActions.callTool(REQUEST_CHANGE_TOOL, {
        outcome: "billing.pause_notifications",
        subject_refs: { preference: `obj_${"z".repeat(43)}` },
      })).rejects.toMatchObject({
        code: "SUBJECT_REFERENCE_UNAVAILABLE",
        message: "One or more observed subjects are unavailable for this request. Re-read the reviewed row and try again.",
      });
      expect(await forged.store.listProposals()).toHaveLength(0);
    } finally {
      forged.store.close();
    }

    const ineligible = createFixtureRuntime({ status: "paused" });
    try {
      const ref = await issueSubject(ineligible);
      await expect(ineligible.semanticActions.callTool(REQUEST_CHANGE_TOOL, {
        outcome: "billing.pause_notifications",
        subject_refs: { preference: ref },
      })).rejects.toMatchObject({
        code: "SEMANTIC_ACTION_NOT_ELIGIBLE",
        message: expect.stringContaining("No proposal or source change was created"),
      });
      expect(await ineligible.store.listProposals()).toHaveLength(0);
      expect(await ineligible.store.listQueryAudit?.()).toHaveLength(1);
    } finally {
      ineligible.store.close();
    }

    const unknown = createFixtureRuntime({ preferences: [] });
    try {
      const ref = await issueSubject(unknown);
      await expect(unknown.semanticActions.callTool(REQUEST_CHANGE_TOOL, {
        outcome: "billing.pause_notifications",
        subject_refs: { preference: ref },
      })).rejects.toMatchObject({
        code: "SEMANTIC_ACTION_UNAVAILABLE",
        message: expect.stringContaining("No proposal or source change was created"),
      });
      expect(await unknown.store.listProposals()).toHaveLength(0);
      expect(await unknown.store.listQueryAudit?.()).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ result: "unknown", proposal_created: false }),
        }),
      ]);
    } finally {
      unknown.store.close();
    }
  });

  it("reports an actionable database setup failure without exposing private RLS diagnostics or making a proposal", async () => {
    const fixture = createFixtureRuntime({ resourceFailure: new PostgresRlsPrerequisiteError([
      "POSTGRES_RLS_FORCE_DISABLED", "POSTGRES_RLS_SELECT_SETTING_MISSING:private.setting",
    ]) });
    try {
      const ref = await issueSubject(fixture);
      await expect(fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, {
        outcome: "billing.pause_notifications", subject_refs: { preference: ref },
      })).rejects.toMatchObject({ code: "SEMANTIC_ACTION_DATABASE_REVIEW_REQUIRED",
        message: "Database row-filtering prerequisites are not satisfied. An operator must recheck database access in the saved setup before retrying. No proposal or source change was created." });
      expect(fixture.queries).toEqual([]);
      expect(await fixture.store.listProposals()).toHaveLength(0);
    } finally { fixture.store.close(); }
  });

  it.each([false, true])("exposes the exact two-tool contract through the official MCP client (business inputs: %s)", async (businessInput) => {
    const fixture = createFixtureRuntime({ businessInput });
    const ref = await issueSubject(fixture);
    const runtime = createMcpRuntime(serverConfig, {
      store: fixture.store,
      semanticActions: fixture.semanticActions,
    });
    const server = createSynapsorMcpServer(runtime);
    const client = new Client({ name: "semantic-action-conformance", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        DESCRIBE_ACTIONS_TOOL,
        REQUEST_CHANGE_TOOL,
      ]);
      expect(listed.tools.some((tool) => /approve|apply|commit|execute|sql/iu.test(tool.name))).toBe(false);
      expect(listed.tools.find((tool) => tool.name === REQUEST_CHANGE_TOOL)?.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["outcome", "subject_refs"],
      });

      const result = await client.callTool({
        name: REQUEST_CHANGE_TOOL,
        arguments: {
          outcome: "billing.pause_notifications",
          subject_refs: { preference: ref },
          ...(businessInput ? { inputs: { notification_state: "paused" } } : {}),
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: "pending_human_review",
        request_disposition: "created",
        source_database_changed: false,
      });
      expect(JSON.stringify(result)).not.toMatch(/raw-preference-42|acct_northstar|customer_maya|"paused"|sha256:/u);

      const invalid = await client.callTool({
        name: REQUEST_CHANGE_TOOL,
        arguments: {
          outcome: "billing.pause_notifications",
          subject_refs: { preference: ref },
          tenant_id: "acct_attacker",
        },
      });
      expect(invalid.isError).toBe(true);
      expect(JSON.stringify(invalid)).toContain("Unrecognized key");
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });

  it("does not expose or dispatch configured per-action tools from a fixed runtime", async () => {
    const fixture = createFixtureRuntime();
    const runtime = createMcpRuntime({ ...serverConfig, capabilities: [configuredReadCapability] }, {
      store: fixture.store, semanticActions: fixture.semanticActions,
      readRow: async () => { throw new Error("Legacy reader must not execute"); },
      logToolRejections: false,
    });
    try {
      expect(runtime.listTools().map((tool) => tool.name)).toEqual([DESCRIBE_ACTIONS_TOOL, REQUEST_CHANGE_TOOL]);
      await expect(runtime.callTool("billing.inspect_preference", { preference_id: "private" }))
        .rejects.toMatchObject({ code: "MCP_TOOL_NOT_FOUND" });
    } finally {
      await runtime.close();
      fixture.store.close();
    }
  });

  it("keeps explicit reviewed capabilities beside the fixed semantic tools during migration", async () => {
    const fixture = createFixtureRuntime();
    const runtime = createMcpRuntime({
      ...serverConfig,
      action_rules: { project_root: ".", legacy_tools: "enabled" },
      capabilities: [configuredReadCapability],
    }, {
      store: fixture.store,
      semanticActions: fixture.semanticActions,
      readRow: async () => ({ row: {}, rowCount: 0 }),
    });
    try {
      expect(runtime.listTools().map((tool) => tool.name)).toEqual([
        DESCRIBE_ACTIONS_TOOL,
        REQUEST_CHANGE_TOOL,
        "billing.inspect_preference",
      ]);
    } finally {
      await runtime.close();
      fixture.store.close();
    }
  });
});
