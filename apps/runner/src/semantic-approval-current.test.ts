import {
  buildActionRuleAuthorityDraft,
  activateActionRuleAuthority,
  loadActiveActionRuleAuthority,
  writeActionRuleAuthorityDraft,
} from "./action-rule-authority.js";
import { proposalsApprove } from "./proposal-ledger.js";
import { activeProjectResolutionState } from "./cli-project.js";
import {
  buildDerivedChangeSet,
  type RuntimeConfig,
} from "@synapsor-runner/mcp-server";
import {
  evaluateSemanticActionEligibility,
  type ActionRuleCatalogV1,
} from "@synapsor-runner/action-rules";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type {
  ActionRuleScalarTypeSpecV1,
  ActionRuleSpecV1,
  DerivedEffectEnvelopeSpecV1,
  RuleVerificationBoundarySpecV1,
} from "@synapsor/spec";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivatedExplorationBoundary } from "./auto-boundary.js";

const roots: string[] = [];
const generationLock = `sha256:${"a".repeat(64)}` as const;
const stateType: ActionRuleScalarTypeSpecV1 = {
  kind: "string",
  max_length: 16,
  comparison: "exact",
  enum: ["active", "paused"],
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  activeProjectResolutionState.current = undefined;
  vi.unstubAllEnvs();
});

describe("semantic proposal approval uses current authority", () => {
  it("approves a generated v4 proposal through a verified reviewer when its exact authority remains current", async () => {
    const fixture = await semanticApprovalFixture();
    try {
      await expect(proposalsApprove(fixture.approveArgs, { quiet: true })).resolves.toBe(0);
      const store = new ProposalStore(fixture.storePath);
      try {
        expect(store.getProposal(fixture.proposalId)).toMatchObject({ state: "approved" });
        expect(store.getWorkerQueueItem(fixture.proposalId)).toMatchObject({ status: "queued" });
        expect(store.receipts(fixture.proposalId)).toEqual([]);
      } finally {
        store.close();
      }
    } finally {
      await fixture.close();
    }
  });

  it.each(["retired", "changed"] as const)("refuses %s semantic authority before recording approval or queueing", async (mode) => {
    const fixture = await semanticApprovalFixture();
    try {
      if (mode === "retired") await fs.rm(path.join(fixture.root, ".synapsor", "action-rules", "active.json"));
      else await fixture.replaceAuthority();

      const before = fixture.snapshot();
      await expect(proposalsApprove(fixture.approveArgs, { quiet: true })).rejects.toMatchObject({
        code: mode === "retired" ? "ENOENT" : "ACTION_RULE_AUTHORITY_STALE",
      });
      expect(fixture.snapshot()).toEqual(before);
      expect(fixture.snapshot()).toMatchObject({ proposal: { state: "pending_review" }, worker: undefined, receipts: [] });
    } finally {
      await fixture.close();
    }
  });

  it("selects the generated same-project same-store Action companion for discovered default semantic approval", async () => {
    const fixture = await semanticApprovalFixture();
    try {
      await fixture.selectDiscoveredReadConfig();
      await expect(proposalsApprove(fixture.defaultApproveArgs, { quiet: true })).resolves.toBe(0);
      expect(fixture.snapshot()).toMatchObject({ proposal: { state: "approved" }, worker: { status: "queued" }, receipts: [] });
    } finally {
      await fixture.close();
    }
  });

  it("preserves an already-valid discovered semantic config instead of replacing it with the canonical companion", async () => {
    const fixture = await semanticApprovalFixture();
    try {
      await fixture.writeActionConfig("{");
      fixture.selectDiscoveredSemanticConfig();
      await expect(proposalsApprove(fixture.defaultApproveArgs, { quiet: true })).resolves.toBe(0);
      expect(fixture.snapshot()).toMatchObject({ proposal: { state: "approved" }, worker: { status: "queued" }, receipts: [] });
    } finally {
      await fixture.close();
    }
  });

  it("never substitutes the generated companion for explicit config selection", async () => {
    const explicit = await semanticApprovalFixture();
    try {
      await explicit.writeActionConfig("{");
      await expect(proposalsApprove(explicit.approveArgs, { quiet: true })).resolves.toBe(0);
    } finally {
      await explicit.close();
    }
  });

  it("never substitutes the generated companion for environment config selection", async () => {
    const environment = await semanticApprovalFixture();
    try {
      await environment.selectDiscoveredReadConfig();
      await environment.writeActionConfig("{");
      vi.stubEnv("SYNAPSOR_RUNNER_CONFIG", environment.environmentConfigPath);
      await expect(proposalsApprove(environment.defaultApproveArgs, { quiet: true })).resolves.toBe(0);
    } finally {
      await environment.close();
    }
  });

  it.each(["malformed", "foreign", "store_mismatch"] as const)("refuses unsafe discovered Action companion (%s) before approval", async (mode) => {
    const fixture = await semanticApprovalFixture();
    try {
      await fixture.selectDiscoveredReadConfig();
      if (mode === "malformed") await fixture.writeActionConfig("{");
      if (mode === "foreign") {
        const foreignRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-semantic-approval-foreign-"));
        roots.push(foreignRoot);
        await fixture.writeActionConfig({ ...fixture.actionConfig, action_rules: { project_root: foreignRoot } });
      }
      if (mode === "store_mismatch") {
        await fixture.writeActionConfig({ ...fixture.actionConfig, storage: { sqlite_path: "./.synapsor/other.db" } });
      }

      const before = fixture.snapshot();
      await expect(proposalsApprove(fixture.defaultApproveArgs, { quiet: true })).rejects.toThrow(
        mode === "malformed" ? "SEMANTIC_ACTION_CONFIG_COMPANION_INVALID"
          : mode === "foreign" ? "SEMANTIC_ACTION_CONFIG_COMPANION_FOREIGN"
            : "SEMANTIC_ACTION_CONFIG_COMPANION_STORE_MISMATCH",
      );
      expect(fixture.snapshot()).toEqual(before);
      expect(fixture.snapshot()).toMatchObject({ proposal: { state: "pending_review" }, worker: undefined, receipts: [] });
    } finally {
      await fixture.close();
    }
  });
});

async function semanticApprovalFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-semantic-approval-current-"));
  roots.push(root);
  const read = activeReadBoundary();
  await writeActiveReadSet(root, read);
  const source = authoritySource();
  const activatedAt = "2026-09-10T00:00:00.000Z";
  await writeAndActivateAuthority({ root, source, read, activatedAt });
  const loaded = await loadActiveActionRuleAuthority(root);
  const verifiedAt = "2026-09-10T00:01:00.000Z";
  const decision = await evaluateSemanticActionEligibility({
    registry: loaded.registry,
    outcome: source.rule.outcome,
    subjects: [{
      binding: "preference",
      resource: source.catalog.resources[0]!.name,
      primary_key: { column: "preference_id", value: "pref_1" },
      subject_ref_digest: canonicalJsonDigest({ subject_ref: "pref_1" }),
    }],
    trusted: { tenant: "acct_1", principal: "customer_1", transaction_time: verifiedAt },
    adapter: { engine: "postgres", load: async () => [{
      preference_id: "pref_1", account_id: "acct_1", principal_id: "customer_1", status: "active", version: 4,
    }] },
    proposal_id: "wrp_pause_pref_1",
    trusted_context_digest: canonicalJsonDigest({ tenant: "acct_1", principal: "customer_1" }),
    evidence_provenance_digest: canonicalJsonDigest({ evidence: "pref_1" }),
    verified_at: verifiedAt,
  });
  if (decision.result !== "eligible") throw new Error("semantic approval fixture must generate an eligible proposal");
  const changeSet = buildDerivedChangeSet({
    decision,
    context: { tenant_id: "acct_1", principal: "customer_1", provenance: "static_dev" },
    proposalId: "wrp_pause_pref_1",
    createdAt: verifiedAt,
    evidenceBundleId: "ev_pause_pref_1",
    queryFingerprint: canonicalJsonDigest({ query: "pref_1" }),
  });
  expect(changeSet.schema_version).toBe("synapsor.change-set.v4");
  const storePath = path.join(root, ".synapsor", "local.db");
  const store = new ProposalStore(storePath);
  let proposalId: string;
  try { proposalId = store.createProposal(changeSet).proposal_id; }
  finally { store.close(); }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeyPath = path.join(root, "reviewer.pub.pem");
  const privateKeyPath = path.join(root, "reviewer.private.pem");
  await fs.writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }).toString(), "utf8");
  await fs.writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { encoding: "utf8", mode: 0o600 });
  const actionBoundaryDigest = loaded.registry.rules[0]!.action_boundary_digest;
  const config: RuntimeConfig = {
    version: 1,
    mode: "review",
    storage: { sqlite_path: storePath },
    sources: { local_postgres: { engine: "postgres", read_url_env: "DATABASE_URL", write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
      receipts: { authority: "runner_ledger" } } },
    trusted_context: { provider: "static_dev", values: { tenant_id: "acct_1", principal: "customer_1" } },
    operator_identity: { provider: "signed_key", operators: { billing_reviewer: { public_key_path: "./reviewer.pub.pem", roles: ["billing_reviewer"] } } },
    supervised_worker: { enabled: true, profile: "staging", capabilities: [], outcomes: [{
      outcome: source.rule.outcome, action_boundary_digest: actionBoundaryDigest, mode: "supervised_worker", write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
      concurrency: 1, queue_limit: 10, lease_seconds: 60, max_attempts: 3, proposal_ttl_seconds: 3_600,
      rate_limit: { executions: 10, window_seconds: 60 }, worker_identity: "semantic_worker",
    }] },
    capabilities: [],
    action_rules: { project_root: "." },
  };
  const configPath = path.join(root, "synapsor.runner.json");
  const actionConfigPath = path.join(root, "synapsor.actions.runner.json");
  const environmentConfigPath = path.join(root, "explicit-action.runner.json");
  const semanticConfigPath = path.join(root, "custom-generated-actions.runner.json");
  const readConfig: RuntimeConfig = {
    version: 1,
    mode: "read_only",
    storage: { sqlite_path: storePath },
    sources: { local_postgres: { engine: "postgres", read_url_env: "DATABASE_URL", read_only: true } },
    trusted_context: { provider: "static_dev", values: { tenant_id: "acct_1", principal: "customer_1" } },
    capabilities: [],
  };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await fs.writeFile(actionConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await fs.writeFile(environmentConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await fs.writeFile(semanticConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const snapshot = () => {
    const current = new ProposalStore(storePath);
    try { return { proposal: current.getProposal(proposalId!), worker: current.getWorkerQueueItem(proposalId!), receipts: current.receipts(proposalId!) }; }
    finally { current.close(); }
  };
  return {
    root,
    storePath,
    proposalId: proposalId!,
    configPath,
    actionConfigPath,
    environmentConfigPath,
    semanticConfigPath,
    actionConfig: config,
    approveArgs: [proposalId!, "--yes", "--config", configPath, "--store", storePath, "--identity", "billing_reviewer", "--identity-key", privateKeyPath],
    defaultApproveArgs: [proposalId!, "--yes", "--store", storePath, "--identity", "billing_reviewer", "--identity-key", privateKeyPath],
    selectDiscoveredReadConfig: async () => {
      await fs.writeFile(configPath, `${JSON.stringify(readConfig, null, 2)}\n`, "utf8");
      activeProjectResolutionState.current = { source: "discovered", project_root: root, config_path: configPath, store_path: storePath };
    },
    selectDiscoveredSemanticConfig: () => {
      activeProjectResolutionState.current = { source: "discovered", project_root: root, config_path: semanticConfigPath, store_path: storePath };
    },
    writeActionConfig: async (value: RuntimeConfig | string) => {
      await fs.writeFile(actionConfigPath, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
    },
    snapshot,
    replaceAuthority: async () => {
      const changed = structuredClone(source);
      changed.rule.ttl_seconds += 1;
      await writeAndActivateAuthority({ root, source: changed, read, activatedAt: "2026-09-10T00:02:00.000Z" });
    },
    close: async () => undefined,
  };
}

async function writeAndActivateAuthority(input: {
  root: string;
  source: ReturnType<typeof authoritySource>;
  read: ActivatedExplorationBoundary;
  activatedAt: string;
}) {
  const draft = buildActionRuleAuthorityDraft({
    name: "billing_active_rules",
    action_boundary_name: "billing_actions",
    catalog: input.source.catalog,
    rules: [{
      read_boundary_name: input.read.pack.name,
      read_boundary_digest: input.read.activation.digest,
      verification_boundary: input.source.verification,
      effect_envelope: input.source.envelope,
      rule: input.source.rule,
    }],
    approval_classes: [{
      name: "billing.standard_change",
      mode: "policy",
      rules: [{ outcome: input.source.rule.outcome, auto_approve_when: structuredClone(input.source.rule.require) }],
      required_role: "billing_reviewer",
      required_approvals: 1,
      shared_limits: [{ id: "billing_pause_action_24h", kind: "count", scope: "capability", maximum: 10, window_seconds: 86_400,
        capability: input.source.rule.outcome }, { id: "billing_pause_customer_24h", kind: "count", scope: "tenant_principal", maximum: 3,
        window_seconds: 86_400, capability: input.source.rule.outcome }],
    }],
    reviews: [{ outcome: input.source.rule.outcome, when: "The preference is active.", then: "Propose pausing notifications.",
      refused: ["The preference is already paused."], human_review: "One action reviewer must approve.",
      examples: [{ kind: "eligible", scenario: "Active preference", result: "Create one proposal" }] }],
    now: input.activatedAt,
  });
  await writeActionRuleAuthorityDraft(input.root, draft);
  return activateActionRuleAuthority({ projectRoot: input.root, name: draft.authority.name, expected_digest: draft.digest,
    confirmation: `ACTIVATE ${draft.digest}`,
    actor: "fixture reviewer", now: input.activatedAt });
}

function authoritySource(): {
  catalog: ActionRuleCatalogV1;
  verification: RuleVerificationBoundarySpecV1;
  envelope: DerivedEffectEnvelopeSpecV1;
  rule: ActionRuleSpecV1;
} {
  const exactString = { kind: "string", max_length: 64, comparison: "exact" } as const;
  const fields = [
    { name: "preference_id", type: exactString, nullable: false },
    { name: "account_id", type: exactString, nullable: false },
    { name: "principal_id", type: exactString, nullable: false },
    { name: "status", type: stateType, nullable: false },
    { name: "version", type: { kind: "integer" as const }, nullable: false },
  ];
  const catalog: ActionRuleCatalogV1 = { schema_version: "synapsor.action-rule-catalog.v1", generation_lock_fingerprint: generationLock,
    resources: [{ name: "billing.preferences", source: "local_postgres", engine: "postgres", schema: "billing", table: "preferences",
      primary_key: "preference_id", tenant_key: "account_id", principal_scope_key: "principal_id", version_field: "version", fields }], relationships: [] };
  const verification: RuleVerificationBoundarySpecV1 = { schema_version: "synapsor.verification-boundary.v1", name: "billing.pause_verification",
    source: "local_postgres", context: "trusted_context", generation_lock_fingerprint: generationLock, resources: [{ binding: "preference",
      resource: "billing.preferences", source: { kind: "subject_ref" }, primary_key: "preference_id", version_field: "version", fields,
      scope: { mode: "columns", tenant_field: "account_id", principal_field: "principal_id" }, cardinality: "one", max_rows: 1,
      overflow: "unsupported", lock: "for_update" }], lock_order: ["preference"], transaction: { isolation: "repeatable_read", timezone: "UTC" } };
  const envelope: DerivedEffectEnvelopeSpecV1 = { schema_version: "synapsor.derived-effect-envelope.v1", name: "billing.pause_effect",
    source: "local_postgres", operation: "update", target_resource: "billing.preferences", target_binding: "preference", primary_key: "preference_id",
    tenant_key: "account_id", principal_scope_key: "principal_id", conflict_key: "version", max_rows: 1,
    allowed_fields: [{ name: "status", type: stateType, values: ["paused"] }], version_advance: { column: "version", strategy: "integer_increment" },
    approval_classes: ["billing.standard_change"], writeback: { mode: "direct_sql", supervised_worker: "allowed" } };
  const rule: ActionRuleSpecV1 = { schema_version: "synapsor.action-rule.v1", name: "billing.pause_notifications", outcome: "billing.pause_notifications",
    context: "trusted_context", source: "local_postgres", verification_boundary_ref: verification.name, effect_envelope_ref: envelope.name,
    subjects: [{ binding: "preference", resource: "billing.preferences", input: "opaque_subject_ref" }], require: { kind: "compare", operator: "eq",
      left: { kind: "field", binding: "preference", field: "status" }, right: { kind: "literal", value: "active", value_type: stateType } }, derive: {},
    effect: { operation: "update", target_resource: "billing.preferences", target_binding: "preference",
      set: { status: { kind: "literal", value: "paused", value_type: stateType } } }, approval_class: "billing.standard_change", ttl_seconds: 300 };
  return { catalog, verification, envelope, rule };
}

function activeReadBoundary(): ActivatedExplorationBoundary {
  const authority = { schema_version: "synapsor.exploration-boundary.v1", activation: "reviewed" as const, deployment_profile: "staging" as const,
    source: "local_postgres", compiler_version: "test", spec_version: "test", trusted_context: { provider: "static_dev" as const,
      tenant_id: "acct_1", principal: "customer_1" }, generation_lock_fingerprint: generationLock,
    role_posture_fingerprint: `sha256:${"b".repeat(64)}` as const, pack: { name: "reviewed_billing", resources: [] }, budgets: {} };
  return { ...authority, activation: { state: "active", digest: canonicalJsonDigest(authority), actor: "test",
    activated_at: "2026-09-10T00:00:00.000Z", generation_lock_fingerprint: generationLock, reviewed_decisions: [] } } as unknown as ActivatedExplorationBoundary;
}

async function writeActiveReadSet(root: string, boundary: ActivatedExplorationBoundary): Promise<void> {
  const state = path.join(root, ".synapsor");
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(state, "exploration-boundaries.active.json"), `${JSON.stringify({
    schema_version: "synapsor.active-exploration-boundaries.v1", selected_name: boundary.pack.name, boundaries: [boundary], updated_at: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
}
