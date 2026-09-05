import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  compileActionRule,
  createActionRuleApprovalClasses,
  createActionRuleRegistry,
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

function semanticFixture(options: { automaticApproval?: boolean; requiredApprovals?: number; businessInput?: boolean } = {}) {
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
      shared_limits: [
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
  unavailableOutcomes?: () => string[];
  businessInput?: boolean;
  status?: "active" | "paused";
  automaticApproval?: boolean;
  requiredApprovals?: number;
  preferences?: Array<{ preference_id: string; status: "active" | "paused"; version: number }>;
  onProposalReady?: NonNullable<Parameters<typeof createSemanticActionRuntime>[0]["onProposalReady"]>;
} = {}) {
  const store = new ProposalStore();
  const { registry, activated } = semanticFixture({
    businessInput: options.businessInput,
    automaticApproval: options.automaticApproval,
    requiredApprovals: options.requiredApprovals,
  });
  const subjectReferences = createSubjectReferenceService({
    store,
    registry,
    key: Buffer.alloc(32, 7),
    clock: () => "2026-09-02T20:02:00.000Z",
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
    ...(options.unavailableOutcomes ? { unavailableOutcomes: options.unavailableOutcomes } : {}),
    ...(options.onProposalReady ? { onProposalReady: options.onProposalReady } : {}),
    async resolveContext() {
      return {
        trusted_context: {
          tenant_id: "acct_northstar",
          principal: "customer_maya",
          provenance: "http_claims",
        },
        subject_authority: authorityContext(),
        fact_loader: {
          engine: "postgres",
          async load(query) {
            queries.push(query);
            const identityPredicate = query.predicates.find((predicate) =>
              predicate.operation === "eq" && predicate.column === "preference_id");
            const requestedId = identityPredicate?.operation === "eq" ? identityPredicate.value : undefined;
            return preferences.filter((preference) => preference.preference_id === requestedId).map((preference) => ({
              preference_id: preference.preference_id,
              account_id: "acct_northstar",
              principal_id: "customer_maya",
              status: preference.status,
              version: preference.version,
            }));
          },
        },
      };
    },
  });
  return { store, registry, activated, subjectReferences, semanticActions, queries };
}

async function issueSubject(
  fixture: ReturnType<typeof createFixtureRuntime>,
  preferenceId = "raw-preference-42",
  version = 4,
) {
  const [subject] = await fixture.subjectReferences.issue({
    ...authorityContext(),
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
  it.each([
    [false, false, "approved_pending_execution"],
    [false, true, "approved_pending_execution"],
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
    vi.spyOn(fixture.store, "receipts").mockImplementation(() => receipt ? [{
      receipt_id: 1, writeback_job_id: "job_test", proposal_id: proposalId, runner_id: "test_worker",
      status: "applied", idempotency_key: "test", source_database_mutated: true, created_at: new Date().toISOString(),
      receipt: { schema_version: "synapsor.execution-receipt.v1", writeback_job_id: "job_test", proposal_id: proposalId,
        runner_id: "test_worker", status: "applied", rows_affected: 1, idempotency_key: "test",
        source_database_mutated: true, executed_at: new Date().toISOString(), receipt_hash: `sha256:${"a".repeat(64)}` },
    }] : []);
    try {
      const ref = await issueSubject(fixture);
      const result = await fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, {
        outcome: "billing.pause_notifications", subject_refs: { preference: ref },
      });
      expect(result).toMatchObject({ status: expectedStatus, execution: applied && receipt ? "completed" : "held",
        source_database_changed: applied });
      if (!applied) expect(await fixture.store.approvals(proposalId)).toHaveLength(1);
    } finally { fixture.store.close(); }
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
      await expect(fixture.semanticActions.callTool(REQUEST_CHANGE_TOOL, {
        outcome: "billing.pause_notifications",
        subject_refs: { preference: ref },
        patch: { status: "paused" },
      })).rejects.toMatchObject({ code: "ARGUMENT_INVALID" });
      expect(await fixture.store.listProposals()).toHaveLength(0);
    } finally {
      fixture.store.close();
    }
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
      onProposalReady: async ({ proposal }) => {
        continuations.push(proposal.state);
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
          approval: "pending human review because an automatic-approval limit did not pass",
        },
        execution: "human_review",
        source_database_changed: false,
      });
      expect(continuations).toEqual(["approved", "pending_review"]);
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
