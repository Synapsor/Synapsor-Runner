import {
  createActionRuleAuthority,
  type ActionRuleCatalogV1,
} from "@synapsor-runner/action-rules";
import {
  REQUEST_CHANGE_TOOL,
  subjectReferenceScopeFingerprints,
  type RuntimeConfig,
} from "@synapsor-runner/mcp-server";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import type {
  ActionRuleSpecV1,
  ActionRuleScalarTypeSpecV1,
  DerivedEffectEnvelopeSpecV1,
  RuleVerificationBoundarySpecV1,
} from "@synapsor/spec";
import { describe, expect, it, vi } from "vitest";
import type { LoadedActiveActionRuleAuthorityV1 } from "./action-rule-authority.js";
import {
  createOptionalActionRuleRuntimeServices,
  createOptionalReadActionRuleRuntimeServices,
} from "./semantic-action-runtime.js";

const lock = `sha256:${"a".repeat(64)}` as const;
const readBoundary = `sha256:${"b".repeat(64)}` as const;
const key = Buffer.alloc(32, 17);
const projectRoot = "/tmp/synapsor-semantic-action-runtime-test";

const config: RuntimeConfig = {
  version: 1,
  mode: "review",
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

describe("composed semantic Action runtime", () => {
  it("discovers the first activated outcome without reconnecting the read-only client", async () => {
    const store = new ProposalStore();
    let authority: LoadedActiveActionRuleAuthorityV1 | undefined;
    const factSessionFactory = vi.fn();
    try {
      const services = await createOptionalReadActionRuleRuntimeServices({ projectRoot, config, store, key, factSessionFactory,
        authorityLoader: async () => {
          if (!authority) throw Object.assign(new Error("No active authority"), { code: "ENOENT" });
          return authority;
        },
      });
      expect(services).toBeDefined();
      const tools = services!.semanticActions.listTools();
      expect(await services!.semanticActions.callTool("app.describe_actions", {})).toMatchObject({ actions: [] });
      expect(await services!.subjectReferences.observationRequirement("billing.preferences")).toBeUndefined();
      await expect(services!.semanticActions.callTool(REQUEST_CHANGE_TOOL, { outcome: "billing.pause_notifications",
        subject_refs: { preference: `obj_${"a".repeat(40)}` } })).rejects.toMatchObject({ code: "SEMANTIC_ACTION_UNAVAILABLE" });
      authority = authorityFixture("active");
      expect(await services!.semanticActions.callTool("app.describe_actions", {})).toMatchObject({ actions: [{ outcome: "billing.pause_notifications" }] });
      expect(await services!.subjectReferences.observationRequirement("billing.preferences")).toBeDefined();
      expect(services!.semanticActions.listTools()).toEqual(tools);
      authority = undefined;
      expect(await services!.semanticActions.callTool("app.describe_actions", {})).toMatchObject({ actions: [] });
      expect(factSessionFactory).not.toHaveBeenCalled();
    } finally { store.close(); }
  });
  it("redeems one shared Explore subject under the same identity and workflow", async () => {
    const store = new ProposalStore();
    const authority = authorityFixture("active");
    const factLoader = vi.fn(async () => [{
      preference_id: "preference-42",
      account_id: "acct_northstar",
      principal_id: "customer_maya",
      status: "active",
      version: 4,
    }]);
    const services = await createOptionalActionRuleRuntimeServices({
      projectRoot,
      config,
      store,
      key,
      deployment_scope: "acme.billing.staging",
      workflow_session_id: "workflow_exact_session",
      authorityLoader: async () => authority,
      factSessionFactory: async () => ({
        fact_loader: { engine: "postgres", load: factLoader },
        close: async () => undefined,
      }),
    });
    try {
      expect(services).toBeDefined();
      const activated = authority.registry.rules[0]!;
      const scope = subjectReferenceScopeFingerprints({
        key,
        deployment_scope: "acme.billing.staging",
        source_id: activated.compiled.source,
        tenant: "acct_northstar",
        principal: "customer_maya",
      });
      const [subject] = await services!.subjectReferences.issue({
        source_id: activated.compiled.source,
        read_boundary_digest: activated.read_boundary_digest,
        generation_lock_fingerprint: activated.compiled.generation_lock_fingerprint,
        ...scope,
        workflow_session_id: services!.workflow_session_id,
        resource: "billing.preferences",
        evidence_bundle_id: "ev_preference_42",
        observations: [{
          row_index: 0,
          primary_key_value: "preference-42",
          observed_version_value: 4,
        }],
      });

      await expect(services!.semanticActions.callTool(REQUEST_CHANGE_TOOL, {
        outcome: "billing.pause_notifications",
        subject_refs: { preference: subject!.ref },
      })).resolves.toMatchObject({
        status: "pending_human_review",
        source_database_changed: false,
      });
      expect(factLoader).toHaveBeenCalledOnce();
      expect(await store.listProposals()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("refuses a subject minted for another authenticated workflow", async () => {
    const store = new ProposalStore();
    const authority = authorityFixture("active");
    const services = await createOptionalActionRuleRuntimeServices({
      projectRoot,
      config,
      store,
      key,
      deployment_scope: "acme.billing.staging",
      workflow_session_id: "workflow_current_session",
      authorityLoader: async () => authority,
      factSessionFactory: async () => ({
        fact_loader: { engine: "postgres", load: async () => [] },
        close: async () => undefined,
      }),
    });
    try {
      const activated = authority.registry.rules[0]!;
      const scope = subjectReferenceScopeFingerprints({
        key,
        deployment_scope: "acme.billing.staging",
        source_id: activated.compiled.source,
        tenant: "acct_northstar",
        principal: "customer_maya",
      });
      const [subject] = await services!.subjectReferences.issue({
        source_id: activated.compiled.source,
        read_boundary_digest: activated.read_boundary_digest,
        generation_lock_fingerprint: activated.compiled.generation_lock_fingerprint,
        ...scope,
        workflow_session_id: "workflow_other_session",
        resource: "billing.preferences",
        evidence_bundle_id: "ev_other_session",
        observations: [{ row_index: 0, primary_key_value: "preference-42", observed_version_value: 4 }],
      });
      await expect(services!.semanticActions.callTool(REQUEST_CHANGE_TOOL, {
        outcome: "billing.pause_notifications",
        subject_refs: { preference: subject!.ref },
      })).rejects.toMatchObject({ code: "SUBJECT_REFERENCE_UNAVAILABLE" });
      expect(await store.listProposals()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("reloads authority and refuses a subject tied to the superseded rule", async () => {
    const store = new ProposalStore();
    let authority = authorityFixture("active");
    const services = await createOptionalActionRuleRuntimeServices({
      projectRoot,
      config,
      store,
      key,
      deployment_scope: "acme.billing.staging",
      workflow_session_id: "workflow_reload",
      authorityLoader: async () => authority,
      factSessionFactory: async () => ({
        fact_loader: { engine: "postgres", load: async () => [] },
        close: async () => undefined,
      }),
    });
    try {
      const activated = authority.registry.rules[0]!;
      const scope = subjectReferenceScopeFingerprints({
        key,
        deployment_scope: "acme.billing.staging",
        source_id: activated.compiled.source,
        tenant: "acct_northstar",
        principal: "customer_maya",
      });
      const [subject] = await services!.subjectReferences.issue({
        source_id: activated.compiled.source,
        read_boundary_digest: activated.read_boundary_digest,
        generation_lock_fingerprint: activated.compiled.generation_lock_fingerprint,
        ...scope,
        workflow_session_id: services!.workflow_session_id,
        resource: "billing.preferences",
        evidence_bundle_id: "ev_before_rule_change",
        observations: [{ row_index: 0, primary_key_value: "preference-42", observed_version_value: 4 }],
      });
      authority = authorityFixture("paused");

      await expect(services!.semanticActions.callTool(REQUEST_CHANGE_TOOL, {
        outcome: "billing.pause_notifications",
        subject_refs: { preference: subject!.ref },
      })).rejects.toMatchObject({ code: "SUBJECT_REFERENCE_UNAVAILABLE" });
      expect(await store.listProposals()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("uses the configured production key and deployment namespace", async () => {
    const store = new ProposalStore();
    const authority = authorityFixture("active");
    const configuredKey = "production-subject-reference-key-material-123456789";
    const services = await createOptionalActionRuleRuntimeServices({
      projectRoot,
      config: {
        ...config,
        action_rules: {
          project_root: projectRoot,
          subject_reference_hmac_key_env: "SYNAPSOR_SHARED_ACTION_KEY",
          subject_reference_namespace: "acme.billing.production",
        },
      },
      env: { SYNAPSOR_SHARED_ACTION_KEY: configuredKey },
      store,
      authorityLoader: async () => authority,
      factSessionFactory: async () => ({
        fact_loader: { engine: "postgres", load: async () => [] },
        close: async () => undefined,
      }),
    });
    try {
      expect(services?.key.equals(Buffer.from(configuredKey, "utf8"))).toBe(true);
      expect(services?.deployment_scope).toBe("acme.billing.production");
    } finally {
      store.close();
    }
  });

  it("uses reviewed single-organization authority without a tenant environment value", async () => {
    const store = new ProposalStore();
    const authority = authorityFixture("active", { singleOrganization: "northgate-billing" });
    const organizationConfig: RuntimeConfig = {
      ...config,
      trusted_context: {
        provider: "reviewed_organization",
        values: {
          tenant_id: "northgate-billing",
          organization_id: "northgate-billing",
        },
      },
    };
    const services = await createOptionalActionRuleRuntimeServices({
      projectRoot,
      config: organizationConfig,
      env: { USER: "local_billing_operator" },
      store,
      key,
      deployment_scope: "northgate.billing.development",
      workflow_session_id: "workflow_single_organization",
      authorityLoader: async () => authority,
      factSessionFactory: async ({ trustedContext }) => {
        expect(trustedContext).toEqual({
          tenant_id: "northgate-billing",
          principal: "local_billing_operator",
          provenance: "reviewed_organization",
        });
        return {
          fact_loader: {
            engine: "postgres",
            load: async () => [{
              preference_id: "preference-42",
              account_id: "northgate-billing",
              principal_id: "customer_maya",
              status: "active",
              version: 4,
            }],
          },
          close: async () => undefined,
        };
      },
    });
    try {
      const activated = authority.registry.rules[0]!;
      const scope = subjectReferenceScopeFingerprints({
        key,
        deployment_scope: "northgate.billing.development",
        source_id: activated.compiled.source,
        tenant: "northgate-billing",
        principal: "local_billing_operator",
      });
      const [subject] = await services!.subjectReferences.issue({
        source_id: activated.compiled.source,
        read_boundary_digest: activated.read_boundary_digest,
        generation_lock_fingerprint: activated.compiled.generation_lock_fingerprint,
        ...scope,
        workflow_session_id: services!.workflow_session_id,
        resource: "billing.preferences",
        evidence_bundle_id: "ev_single_organization",
        observations: [{ row_index: 0, primary_key_value: "preference-42", observed_version_value: 4 }],
      });

      await expect(services!.semanticActions.callTool(REQUEST_CHANGE_TOOL, {
        outcome: "billing.pause_notifications",
        subject_refs: { preference: subject!.ref },
      })).resolves.toMatchObject({ status: "pending_human_review", source_database_changed: false });
      const proposals = await store.listProposals();
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({ principal: "local_billing_operator" });
      expect(proposals[0]!.change_set).toMatchObject({
        scope: {
          organization_scope: {
            mode: "single_organization",
            organization_id: "northgate-billing",
          },
        },
      });
    } finally {
      store.close();
    }
  });

  it("keeps Read serving available when semantic Action authority is invalid", async () => {
    const store = new ProposalStore();
    const failure = Object.assign(new Error("stale semantic Action authority"), {
      code: "ACTION_RULE_AUTHORITY_STALE",
    });
    const unavailable = vi.fn();
    try {
      await expect(createOptionalReadActionRuleRuntimeServices({
        projectRoot,
        config,
        store,
        key,
        authorityLoader: async () => { throw failure; },
      }, unavailable)).resolves.toBeUndefined();
      expect(unavailable).toHaveBeenCalledWith(failure);

      await expect(createOptionalActionRuleRuntimeServices({
        projectRoot,
        config,
        store,
        key,
        authorityLoader: async () => { throw failure; },
      })).rejects.toBe(failure);
    } finally {
      store.close();
    }
  });

  it.each([
    { enabled: true, queue: true, expected: "queued" },
    { enabled: false, queue: true, expected: "not_enabled" },
    { enabled: false, queue: false, expected: "not_enabled" },
    { enabled: true, queue: false, expected: "held" },
    { enabled: undefined, queue: false, expected: "not_enabled" },
  ])("uses legacy execution settings without a migration: $enabled/$queue -> $expected", async ({ enabled, queue, expected }) => {
    const store = new ProposalStore();
    const authority = authorityFixture("active", { automaticApproval: true, requiredApprovals: 2 });
    const activated = authority.registry.rules[0]!;
    const supervisedConfig: RuntimeConfig = {
      ...structuredClone(config),
      action_rules: { project_root: projectRoot },
      sources: {
        local_postgres: {
          engine: "postgres",
          read_url_env: "DATABASE_URL",
          write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
          receipts: { authority: "runner_ledger" },
        },
      },
      supervised_worker: {
        enabled: true,
        profile: "staging",
        capabilities: [],
        outcomes: [{
          outcome: activated.compiled.outcome,
          action_boundary_digest: activated.action_boundary_digest,
          mode: "supervised_worker",
          concurrency: 1,
          queue_limit: 10,
          lease_seconds: 60,
          max_attempts: 3,
          proposal_ttl_seconds: 3_600,
          rate_limit: { executions: 10, window_seconds: 60 },
          write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
          worker_identity: "semantic_worker",
        }],
      },
    };
    if (enabled === undefined) delete supervisedConfig.supervised_worker;
    else supervisedConfig.supervised_worker!.enabled = enabled;
    if (!queue) Object.defineProperty(store, "enqueueWorkerProposal", { value: undefined, configurable: true });
    const services = await createOptionalActionRuleRuntimeServices({
      projectRoot,
      config: supervisedConfig,
      store,
      key,
      deployment_scope: "acme.billing.staging",
      workflow_session_id: "workflow_supervised",
      authorityLoader: async () => authority,
      factSessionFactory: async () => ({
        fact_loader: {
          engine: "postgres",
          load: async () => [{
            preference_id: "preference-42",
            account_id: "acct_northstar",
            principal_id: "customer_maya",
            status: "active",
            version: 4,
          }],
        },
        close: async () => undefined,
      }),
    });
    try {
      const scope = subjectReferenceScopeFingerprints({
        key,
        deployment_scope: "acme.billing.staging",
        source_id: activated.compiled.source,
        tenant: "acct_northstar",
        principal: "customer_maya",
      });
      const [subject] = await services!.subjectReferences.issue({
        source_id: activated.compiled.source,
        read_boundary_digest: activated.read_boundary_digest,
        generation_lock_fingerprint: activated.compiled.generation_lock_fingerprint,
        ...scope,
        workflow_session_id: services!.workflow_session_id,
        resource: "billing.preferences",
        evidence_bundle_id: "ev_supervised",
        observations: [{ row_index: 0, primary_key_value: "preference-42", observed_version_value: 4 }],
      });
      await expect(services!.semanticActions.callTool(REQUEST_CHANGE_TOOL, {
        outcome: activated.compiled.outcome,
        subject_refs: { preference: subject!.ref },
      })).resolves.toMatchObject({
        proposal: { status: "approved" },
        execution: expected,
        source_database_changed: false,
      });
      expect(store.listWorkerQueue()).toEqual(expected === "queued" ? [
        expect.objectContaining({
          execution_mode: "supervised_worker",
          contract_digest: activated.action_boundary_digest,
          status: "queued",
        }),
      ] : []);
    } finally {
      store.close();
    }
  });
});

function authorityFixture(
  requiredStatus: "active" | "paused",
  options: { singleOrganization?: string; automaticApproval?: boolean; requiredApprovals?: number } = {},
): LoadedActiveActionRuleAuthorityV1 {
  const stringId = { kind: "string", max_length: 64, comparison: "exact" } as const;
  const statusType: ActionRuleScalarTypeSpecV1 = {
    kind: "string",
    max_length: 16,
    comparison: "exact",
    enum: ["active", "paused"],
  };
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
      ...(options.singleOrganization === undefined ? { tenant_key: "account_id" } : {}),
      ...(options.singleOrganization === undefined ? { principal_scope_key: "principal_id" } : {}),
      version_field: "version",
      fields: [
        { name: "preference_id", type: stringId, nullable: false },
        { name: "account_id", type: stringId, nullable: false },
        { name: "principal_id", type: stringId, nullable: false },
        { name: "status", type: statusType, nullable: false },
        { name: "version", type: { kind: "integer" }, nullable: false },
      ],
    }],
    relationships: [],
  };
  const verification: RuleVerificationBoundarySpecV1 = {
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
      fields: catalog.resources[0]!.fields,
      scope: options.singleOrganization === undefined
        ? { mode: "columns", tenant_field: "account_id", principal_field: "principal_id" }
        : {
          mode: "single_organization",
          organization_id: options.singleOrganization,
        },
      cardinality: "one",
      max_rows: 1,
      overflow: "unsupported",
      lock: "for_update",
    }],
    lock_order: ["preference"],
    transaction: { isolation: "repeatable_read", timezone: "UTC" },
  };
  const envelope: DerivedEffectEnvelopeSpecV1 = {
    schema_version: "synapsor.derived-effect-envelope.v1",
    name: "billing.pause_effect",
    source: "local_postgres",
    operation: "update",
    target_resource: "billing.preferences",
    target_binding: "preference",
    primary_key: "preference_id",
    ...(options.singleOrganization === undefined
      ? { tenant_key: "account_id", principal_scope_key: "principal_id" }
      : {
        organization_scope: {
          mode: "single_organization",
          organization_id: options.singleOrganization,
          acknowledgement: "all_rows_belong_to_one_organization",
        },
      }),
    conflict_key: "version",
    max_rows: 1,
    allowed_fields: [{ name: "status", type: statusType, values: ["paused"] }],
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
    verification_boundary_ref: verification.name,
    effect_envelope_ref: envelope.name,
    subjects: [{ binding: "preference", resource: "billing.preferences", input: "opaque_subject_ref" }],
    require: {
      kind: "compare",
      operator: "eq",
      left: { kind: "field", binding: "preference", field: "status" },
      right: { kind: "literal", value: requiredStatus, value_type: statusType },
    },
    derive: {},
    effect: {
      operation: "update",
      target_resource: "billing.preferences",
      target_binding: "preference",
      set: { status: { kind: "literal", value: "paused", value_type: statusType } },
    },
    approval_class: "billing.standard_change",
    ttl_seconds: 300,
  };
  const loaded = createActionRuleAuthority({
    name: "billing_active_rules",
    action_boundary_name: "billing.actions",
    catalog,
    ...(options.automaticApproval
      ? {
          approval_classes: [{
            name: "billing.standard_change",
            mode: "policy" as const,
            rules: [{ outcome: rule.outcome, auto_approve_when: structuredClone(rule.require) }],
            required_role: "billing_reviewer",
            required_approvals: options.requiredApprovals ?? 1,
            shared_limits: [{
              id: "billing_pause_action_24h",
              kind: "count" as const,
              scope: "capability" as const,
              maximum: 10,
              window_seconds: 86_400,
              capability: rule.outcome,
            }, {
              id: "billing_pause_customer_24h",
              kind: "count" as const,
              scope: "tenant_principal" as const,
              maximum: 3,
              window_seconds: 86_400,
              capability: rule.outcome,
            }],
          }],
        }
      : {}),
    rules: [{
      read_boundary_name: "reviewed_billing",
      read_boundary_digest: readBoundary,
      verification_boundary: verification,
      effect_envelope: envelope,
      rule,
      activated_at: "2026-09-03T06:00:00.000Z",
    }],
  });
  return {
    ...loaded,
    activation: {
      schema_version: "synapsor.action-rule-authority-activation.v1",
      state: "active",
      authority: loaded.authority,
      digest: loaded.authority.digest,
      reviews: [{
        outcome: "billing.pause_notifications",
        when: "The preference is active.",
        then: "Propose pausing notifications.",
        refused: ["The preference is already paused."],
        human_review: "One reviewer must approve.",
        examples: [{ kind: "eligible", scenario: "Active preference", result: "Create a proposal" }],
      }],
      actor: "test",
      activated_at: "2026-09-03T06:00:00.000Z",
    },
  };
}
