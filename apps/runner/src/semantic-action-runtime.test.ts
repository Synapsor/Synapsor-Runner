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
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withProjectRuntimeCutover } from "./project-runtime-admission.js";
import type { LoadedActiveActionRuleAuthorityV1 } from "./action-rule-authority.js";
import {
  createOptionalActionRuleRuntimeServices,
  createOptionalReadActionRuleRuntimeServices,
} from "./semantic-action-runtime.js";

const lock = `sha256:${"a".repeat(64)}` as const;
const readBoundary = `sha256:${"b".repeat(64)}` as const;
const key = Buffer.alloc(32, 17);
let projectRoot: string;
beforeEach(async () => { projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-semantic-action-runtime-")); });
afterEach(async () => { await fs.rm(projectRoot, { recursive: true, force: true }); });

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
  it.each(["active", "initially_inactive"])("holds %s discovery through its final authority checks", async (mode) => {
    const store = new ProposalStore();
    let authority = mode === "active" ? authorityFixture("active") : undefined;
    let paused = false, entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    try {
      const services = (await createOptionalReadActionRuleRuntimeServices({ projectRoot, config, store, key,
        authorityLoader: async () => {
          if (paused) { entered(); await hold; }
          if (!authority) throw Object.assign(new Error("No active authority"), { code: "ENOENT" });
          return authority;
        } }))!;
      authority = authorityFixture("active"); paused = true;
      const request = services.semanticActions.callTool("app.describe_actions", {});
      await ready;
      const cutover = vi.fn(async () => undefined);
      const waiting = withProjectRuntimeCutover(projectRoot, cutover);
      await delay(50); expect(cutover).not.toHaveBeenCalled();
      release(); await expect(request).resolves.toMatchObject({ actions: [{ outcome: "billing.pause_notifications" }] });
      await waiting; expect(cutover).toHaveBeenCalledOnce();
    } finally { release(); store.close(); }
  });

  it("waits before constructor authority loading during a cutover", async () => {
    const store = new ProposalStore(), authorityLoader = vi.fn(async () => authorityFixture("active"));
    let pending!: ReturnType<typeof createOptionalActionRuleRuntimeServices>;
    try {
      await withProjectRuntimeCutover(projectRoot, async () => {
        pending = createOptionalActionRuleRuntimeServices({ projectRoot, config, store, key, authorityLoader });
        await delay(50); expect(authorityLoader).not.toHaveBeenCalled();
      });
      expect(await pending).toBeDefined(); expect(authorityLoader).toHaveBeenCalled();
    } finally { await pending; store.close(); }
  });

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

  it("shares Action Boundary automatic-approval limits across outcomes and tenants", async () => {
    const store = new ProposalStore();
    const authority = authorityFixture("active", { automaticApproval: true, sharedApprovalLimits: true });
    const [firstOutcome, secondOutcome] = authority.registry.rules.map((rule) => rule.compiled.outcome);
    const servicesByTenant = new Map<string, Awaited<ReturnType<typeof createOptionalActionRuleRuntimeServices>>>();

    const servicesFor = async (tenant: string) => {
      const existing = servicesByTenant.get(tenant);
      if (existing) return existing;
      const services = (await createOptionalActionRuleRuntimeServices({
        projectRoot,
        config: {
          ...config,
          trusted_context: { provider: "static_dev", values: { tenant_id: tenant, principal: "customer_maya" } },
        },
        store,
        key,
        deployment_scope: "acme.billing.staging",
        workflow_session_id: `workflow_${tenant}`,
        authorityLoader: async () => authority,
        factSessionFactory: async () => ({
          fact_loader: {
            engine: "postgres",
            load: async (query) => {
              const identity = query.predicates.find((predicate) =>
                predicate.operation === "eq" && predicate.column === "preference_id");
              const id = identity?.operation === "eq" ? String(identity.value) : "";
              return [{
                preference_id: id,
                account_id: tenant,
                principal_id: "customer_maya",
                status: id.startsWith("ineligible-") ? "paused" : "active",
                version: 1,
              }];
            },
          },
          close: async () => undefined,
        }),
      }))!;
      servicesByTenant.set(tenant, services);
      return services;
    };

    const request = async (tenant: string, outcome: string, id: string) => {
      const services = await servicesFor(tenant);
      const activated = authority.registry.rules.find((rule) => rule.compiled.outcome === outcome)!;
      const scope = subjectReferenceScopeFingerprints({
        key,
        deployment_scope: "acme.billing.staging",
        source_id: activated.compiled.source,
        tenant,
        principal: "customer_maya",
      });
      const [subject] = await services.subjectReferences.issue({
        source_id: activated.compiled.source,
        read_boundary_digest: activated.read_boundary_digest,
        generation_lock_fingerprint: activated.compiled.generation_lock_fingerprint,
        ...scope,
        workflow_session_id: services.workflow_session_id,
        resource: "billing.preferences",
        evidence_bundle_id: `ev_${tenant}_${id}`,
        observations: [{ row_index: 0, primary_key_value: id, observed_version_value: 1 }],
      });
      const args = { outcome, subject_refs: { preference: subject!.ref } };
      return { args, services, result: services.semanticActions.callTool(REQUEST_CHANGE_TOOL, args) };
    };

    try {
      expect(authority.registry.approval_classes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "billing.notification_change",
          shared_limits: [
            { id: "billing_notification_boundary_24h", kind: "count", scope: "boundary", maximum: 10, window_seconds: 86_400 },
            { id: "billing_notification_tenant_24h", kind: "count", scope: "tenant", maximum: 3, window_seconds: 86_400 },
          ],
        }),
        expect.objectContaining({
          name: "billing.stock_change",
          shared_limits: [
            { id: "billing_stock_boundary_24h", kind: "count", scope: "boundary", maximum: 10, window_seconds: 86_400 },
            { id: "billing_stock_tenant_24h", kind: "count", scope: "tenant", maximum: 3, window_seconds: 86_400 },
          ],
        }),
      ]));

      const first = await request("acct_northstar", firstOutcome!, "northstar-1");
      await expect(first.result).resolves.toMatchObject({ proposal: { status: "approved" } });
      await expect(first.services.semanticActions.callTool(REQUEST_CHANGE_TOOL, first.args))
        .resolves.toMatchObject({ request_disposition: "already_recorded", proposal: { status: "approved" } });
      expect((await store.listProposals()).filter((proposal) => proposal.state === "approved")).toHaveLength(1);

      for (const [outcome, id] of [[secondOutcome!, "northstar-2"], [firstOutcome!, "northstar-3"]] as const) {
        await expect((await request("acct_northstar", outcome, id)).result)
          .resolves.toMatchObject({ proposal: { status: "approved" } });
      }
      await expect((await request("acct_northstar", secondOutcome!, "northstar-4")).result)
        .resolves.toMatchObject({ proposal: { status: "pending_review" } });

      await expect((await request("acct_other", firstOutcome!, "other-1")).result)
        .resolves.toMatchObject({ proposal: { status: "approved" } });

      for (const [tenant, count] of [["acct_other", 2], ["acct_third", 3], ["acct_fourth", 1]] as const) {
        for (let index = 0; index < count; index += 1) {
          const outcome = index % 2 === 0 ? secondOutcome! : firstOutcome!;
          await expect((await request(tenant, outcome, `${tenant}-${index + 2}`)).result)
            .resolves.toMatchObject({ proposal: { status: "approved" } });
        }
      }
      await expect((await request("acct_fourth", secondOutcome!, "fourth-2")).result)
        .resolves.toMatchObject({ proposal: { status: "pending_review" } });

      await expect((await request("acct_fifth", firstOutcome!, "ineligible-fifth-1")).result)
        .rejects.toMatchObject({ code: "SEMANTIC_ACTION_NOT_ELIGIBLE" });
      const proposals = await store.listProposals();
      expect(proposals.filter((proposal) => proposal.state === "approved")).toHaveLength(10);
      expect(proposals.filter((proposal) => proposal.state === "pending_review")).toHaveLength(2);
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

  it("rejects invalid semantic authority without downgrading it to optional Read service", async () => {
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
      }, unavailable)).rejects.toBe(failure);
      expect(unavailable).not.toHaveBeenCalled();

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

  it.each(["corrupt_json", "invalid_state", "invalid_digest", "missing_immutable", "missing_read"] as const)(
    "refuses persisted active authority with %s without source access or authority replacement", async (mode) => {
      const store = new ProposalStore(":memory:");
      const activation = structuredClone(authorityFixture("active").activation);
      const activePath = path.join(projectRoot, ".synapsor/action-rules/active.json");
      const revisionPath = path.join(projectRoot, ".synapsor/action-rules/revisions", activation.digest.slice("sha256:".length), "authority.json");
      const original = JSON.stringify(activation);
      await fs.mkdir(path.dirname(revisionPath), { recursive: true });
      if (mode !== "missing_immutable") await fs.writeFile(revisionPath, original);
      const corrupted = mode === "corrupt_json" ? "{"
        : mode === "invalid_state" ? JSON.stringify({ ...activation, state: "disabled" })
          : mode === "invalid_digest" ? JSON.stringify({ ...activation, digest: `sha256:${"f".repeat(64)}` })
            : original;
      await fs.writeFile(activePath, corrupted);
      const factSessionFactory = vi.fn(async () => { throw new Error("Source access is forbidden in this test"); });
      const unavailable = vi.fn();
      try {
        const input = { projectRoot, config, store, key, factSessionFactory };
        await expect(createOptionalReadActionRuleRuntimeServices(input, unavailable)).rejects.toThrow();
        await expect(createOptionalActionRuleRuntimeServices(input)).rejects.toThrow();
        expect(unavailable).not.toHaveBeenCalled();
        expect(factSessionFactory).not.toHaveBeenCalled();
        expect(await store.listProposals()).toEqual([]);
        expect(await fs.readFile(activePath, "utf8")).toBe(corrupted);
        if (mode === "missing_immutable") await expect(fs.stat(revisionPath)).rejects.toHaveProperty("code", "ENOENT");
        else expect(await fs.readFile(revisionPath, "utf8")).toBe(original);
        await expect(fs.stat(path.join(projectRoot, ".synapsor/exploration-boundaries.active.json")))
          .rejects.toHaveProperty("code", "ENOENT");
      } finally { store.close(); }
    },
  );

  it("keeps genuine missing activation as inactive services with empty discovery and no proposal", async () => {
    const store = new ProposalStore(":memory:");
    const factSessionFactory = vi.fn(async () => { throw new Error("Source access is forbidden in this test"); });
    const unavailable = vi.fn();
    try {
      const input = { projectRoot, config, store, key, factSessionFactory };
      expect(await createOptionalActionRuleRuntimeServices(input)).toBeUndefined();
      const services = await createOptionalReadActionRuleRuntimeServices(input, unavailable);
      expect(services).toBeDefined();
      expect(services!.semanticActions.listTools().map((tool) => tool.name).sort())
        .toEqual(["app.describe_actions", "app.request_change"]);
      await expect(services!.semanticActions.callTool("app.describe_actions", {})).resolves.toMatchObject({
        ok: true, actions: [], availability: "operator_review_required", source_database_changed: false,
      });
      await expect(services!.semanticActions.callTool(REQUEST_CHANGE_TOOL, {
        outcome: "billing.pause_notifications", subject_refs: { preference: `obj_${"a".repeat(40)}` },
      })).rejects.toMatchObject({ code: "SEMANTIC_ACTION_UNAVAILABLE" });
      expect(factSessionFactory).not.toHaveBeenCalled();
      expect(unavailable).not.toHaveBeenCalled();
      expect(await store.listProposals()).toEqual([]);
      await expect(fs.stat(path.join(projectRoot, ".synapsor/action-rules/active.json")))
        .rejects.toHaveProperty("code", "ENOENT");
    } finally { store.close(); }
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
  options: { singleOrganization?: string; automaticApproval?: boolean; requiredApprovals?: number; sharedApprovalLimits?: boolean } = {},
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
    approval_classes: options.sharedApprovalLimits
      ? ["billing.stock_change", "billing.notification_change"]
      : ["billing.standard_change"],
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
    approval_class: options.sharedApprovalLimits ? "billing.stock_change" : "billing.standard_change",
    ttl_seconds: 300,
  };
  const rules = options.sharedApprovalLimits
    ? [rule, {
      ...structuredClone(rule),
      name: "billing.pause_digest_notifications",
      outcome: "billing.pause_digest_notifications",
      approval_class: "billing.notification_change",
    }]
    : [rule];
  const sharedLimits = (prefix: string) => options.sharedApprovalLimits
    ? [{ id: `${prefix}_boundary_24h`, kind: "count" as const, scope: "boundary" as const, maximum: 10, window_seconds: 86_400 }, {
      id: `${prefix}_tenant_24h`, kind: "count" as const, scope: "tenant" as const, maximum: 3, window_seconds: 86_400,
    }]
    : [{
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
    }];
  const approvalClasses = options.sharedApprovalLimits
    ? rules.map((entry) => ({
      name: entry.approval_class,
      mode: "policy" as const,
      rules: [{ outcome: entry.outcome, auto_approve_when: structuredClone(entry.require) }],
      required_role: "billing_reviewer",
      required_approvals: options.requiredApprovals ?? 1,
      shared_limits: sharedLimits(`billing_${entry.approval_class === "billing.stock_change" ? "stock" : "notification"}`),
    }))
    : [{
      name: "billing.standard_change",
      mode: "policy" as const,
      rules: rules.map((entry) => ({ outcome: entry.outcome, auto_approve_when: structuredClone(entry.require) })),
      required_role: "billing_reviewer",
      required_approvals: options.requiredApprovals ?? 1,
      shared_limits: sharedLimits("billing_pause"),
    }];
  const loaded = createActionRuleAuthority({
    name: "billing_active_rules",
    action_boundary_name: "billing.actions",
    catalog,
    ...(options.automaticApproval
      ? {
          approval_classes: approvalClasses,
        }
      : {}),
    rules: rules.map((entry) => ({
      read_boundary_name: "reviewed_billing",
      read_boundary_digest: readBoundary,
      verification_boundary: verification,
      effect_envelope: envelope,
      rule: entry,
      activated_at: "2026-09-03T06:00:00.000Z",
    })),
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
