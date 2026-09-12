// Verification fixture reuses the existing billing preference rule. No business source is connected.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {Pool, type PoolClient} from "pg";
import {describe, it, expect, vi} from "vitest";
import {canonicalJsonDigest} from "@synapsor-runner/protocol";
import {ProposalStore, type ProposalRuntimeStore} from "@synapsor-runner/proposal-store";
import {subjectReferenceScopeFingerprints, type RuntimeConfig} from "@synapsor-runner/mcp-server";
import type {ActionRuleCatalogV1} from "@synapsor-runner/action-rules";
import type {ActionRuleScalarTypeSpecV1, ActionRuleSpecV1, DerivedEffectEnvelopeSpecV1, RuleVerificationBoundarySpecV1} from "@synapsor/spec";
import type {SchemaInspection} from "@synapsor-runner/schema-inspector";
import {buildAutoBoundary, activateExplorationBoundary, writeAutoBoundaryArtifacts, explorationBoundaryCandidateDigest,
  AUTO_BOUNDARY_OVERRIDES_VERSION, type ActivatedExplorationBoundary} from "./auto-boundary.js";
import {recommendedBoundaryReviewCandidate} from "./boundary-candidate.js";
import {buildActionRuleAuthorityDraft, writeActionRuleAuthorityDraft, activateActionRuleAuthority, loadActiveActionRuleAuthority} from "./action-rule-authority.js";
import {encodeOperatorAuthority, validateOperatorPolicySnapshot} from "./control-policy-authority-codec.js";
import {migrateProjectControlPolicies, createProjectRuntimeStore} from "./control-policy-store.js";
import {createOptionalActionRuleRuntimeServices} from "./semantic-action-runtime.js";
let generationLock = `sha256:${"a".repeat(64)}` as const;
const stateType: ActionRuleScalarTypeSpecV1 = {kind: "string", max_length: 16, comparison: "exact", enum: ["active", "paused"]};
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return {promise, resolve}; }
async function bounded<T>(promise: Promise<T>): Promise<T> { let timer: ReturnType<typeof setTimeout>; return Promise.race([promise,
  new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error("publication schedule acknowledgement timeout")), 8000);})]).finally(() => clearTimeout(timer)); }
async function save(name: string, value: unknown) { if(process.env.SYNAPSOR_TEST_EVIDENCE_DIR) await fs.writeFile(
  path.join(process.env.SYNAPSOR_TEST_EVIDENCE_DIR, name + ".json"), JSON.stringify(value, null, 2) + "\n"); }

async function reviewedRead(root: string) {
  const columns = ["preference_id", "account_id", "principal_id", "status", "version"];
  const inspection: SchemaInspection = {
    engine: "postgres", server_version: "PostgreSQL 17", current_user: "reader", inspected_at: new Date().toISOString(),
    schemas: ["billing"], warnings: [], role_posture: {verified: true, superuser: false, bypass_rls: false, read_only: true,
      writable_relations: [], owned_relations: [], reasons: []},
    tables: [{schema: "billing", name: "preferences", type: "table", writable: false,
      columns: columns.map((name, ordinal_position) => ({name, ordinal_position, data_type: name === "version" ? "integer" : "text",
        nullable: false, generated: false, suggestions: {tenant: name === "account_id", conflict: name === "version", sensitive: false,
          immutable: name.endsWith("id"), large_or_binary: false}})),
      primary_key: ["preference_id"], unique_constraints: [{name: "preferences_pkey", columns: ["preference_id"]}],
      check_constraints: [], foreign_keys: [], row_level_security: false, indexes: [],
      role_posture: {owner: "owner", current_role_is_owner: false, current_role_can_assume_owner: false,
        privileges: {select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false},
        row_security_forced: false, row_security_effective_for_current_role: false},
      suggestions: {tenant_columns: ["account_id"], conflict_columns: ["version"], sensitive_columns: [], default_visible_columns: ["status"]}}],
  };
  const reviewed = (value: string) => ({value, actor: "fixture_operator", reason: "Reviewed existing preference scope", decided_at: new Date().toISOString()});
  const build = buildAutoBoundary({inspection, inspectedSchema: "billing", sourceEnv: "DATABASE_URL", deploymentProfile: "staging",
    overrides: {schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION, resources: {"billing.preferences": {
      tenant_key: reviewed("account_id"), principal_key: reviewed("principal_id")}}},
    project: {root, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"]}});
  const candidate = recommendedBoundaryReviewCandidate(build.exploration_boundary);
  await writeAutoBoundaryArtifacts({projectRoot: root, build});
  const read = await activateExplorationBoundary({projectRoot: root, candidate,
    expectedDigest: explorationBoundaryCandidateDigest(candidate), actor: "fixture_operator",
    confirmation: `ACTIVATE ${explorationBoundaryCandidateDigest(candidate)}`, confirmedDecisions: candidate.unresolved_decisions,
    currentInspection: inspection});
  generationLock = read.generation_lock_fingerprint;
  return {read, build};
}

for (const backend of ["sqlite", "postgres"] as const) describe.skipIf(backend === "postgres" && !process.env.SYNAPSOR_TEST_POSTGRES_URL)(
  `publication versus admission (${backend})`, () => {
  it.each(["replacement_first", "admission_first"] as const)("preserves exact current authority: %s", async ordering => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-publication-admission-"));
    const schema = `publication_${randomUUID().replaceAll("-", "")}`;
    const sequence: unknown[] = []; const record = (event: string, detail: unknown = {}) => sequence.push({event, at: new Date().toISOString(), detail});
    const ready = deferred(), release = deferred();
    let store: ProposalRuntimeStore | undefined, binding: Awaited<ReturnType<typeof migrateProjectControlPolicies>>["binding"] | undefined;
    let work: Promise<unknown> | undefined;
    const admin = backend === "postgres" ? new Pool({connectionString: process.env.SYNAPSOR_TEST_POSTGRES_URL, connectionTimeoutMillis: 3000}) : undefined;
    let blockedClient: PoolClient | undefined;
    try {
      const {read, build} = await reviewedRead(root);
      const source = authoritySource();
      const storePath = path.join(root, ".synapsor/control.db");
      const config: RuntimeConfig = {version: 1, mode: "review", storage: backend === "sqlite" ? {sqlite_path: storePath} : {
        shared_postgres: {mode: "runtime_store", url_env: "SYNAPSOR_TEST_POSTGRES_URL", schema}},
        capabilities: [], sources: {local_postgres: {engine: "postgres", read_url_env: "DATABASE_URL"}},
        trusted_context: {provider: "static_dev", values: {tenant_id: "acct_1", principal: "customer_1"}}, action_rules: {project_root: root}};
      const records = [encodeOperatorAuthority({type: "read", boundary: read, generation_lock: build.lock}),
        encodeOperatorAuthority({type: "read_selection", selected_name: read.pack.name})];
      binding = (await migrateProjectControlPolicies({projectRoot: root, config, storePath, actor: "fixture_operator",
        readLegacySnapshot: async () => ({revisions: records, active: records.map(r => ({scope: r.scope, kind: r.kind, name: r.name, revision_id: r.revision_id})), drafts: [], provenance: []}),
        validateSnapshot: async snapshot => validateOperatorPolicySnapshot(snapshot, {runtimeConfig: config})})).binding;
      // Action publication reads this trusted local config to reopen the same governed repository.
      await fs.writeFile(path.join(root, "synapsor.runner.json"), JSON.stringify(config));
      const publish = async (maximum: number) => {
        const result = await writeAndActivateAuthority({root, source, read, activatedAt: new Date().toISOString(), maximum});
        record("publication_committed", {maximum, digest: result.digest}); return result;
      };
      const original = await publish(3);
      store = await createProjectRuntimeStore({projectRoot: root, config, storePath});
      const key = Buffer.alloc(32, 23);
      const services = (await createOptionalActionRuleRuntimeServices({projectRoot: root, config, store, key,
        deployment_scope: "publication_fixture", workflow_session_id: "publication_fixture",
        factSessionFactory: async () => ({fact_loader: {engine: "postgres", load: async query => [{
          preference_id: query.predicates.flatMap(p => p.operation === "eq" && p.column === "preference_id" ? [p.value] : [])[0],
          account_id: "acct_1", principal_id: "customer_1", status: "active", version: 4}]}, close: async () => undefined})}))!;
      const request = async (id: string) => {
        const active = (await loadActiveActionRuleAuthority(root)).registry.rules[0]!;
        const [subject] = await services.subjectReferences.issue({source_id: "local_postgres", read_boundary_digest: active.read_boundary_digest,
          generation_lock_fingerprint: generationLock, workflow_session_id: services.workflow_session_id, resource: "billing.preferences",
          ...subjectReferenceScopeFingerprints({key, deployment_scope: "publication_fixture", source_id: "local_postgres", tenant: "acct_1", principal: "customer_1"}),
          evidence_bundle_id: `ev_${id}`, observations: [{row_index: 0, primary_key_value: id, observed_version_value: 4}]});
        return {outcome: source.rule.outcome, subject_refs: {preference: subject!.ref}};
      };
      const baselineRequest = await request("baseline");
      const baseline = await services.semanticActions.callTool("app.request_change", baselineRequest);
      expect(baseline).toMatchObject({proposal: {status: "approved"}});
      const oldRequest = await request("waiting");
      const approve = store.approveProposalByPolicy.bind(store);
      let armed = true;
      vi.spyOn(store, "approveProposalByPolicy").mockImplementation(async (id, options) => {
        if(armed) {armed = false; record("admission_entered", {id, now_override: options.now ?? null}); ready.resolve(); await bounded(release.promise);}
        const result = await approve(id, options); record("admission_returned", {id, result}); return result;
      });
      work = services.semanticActions.callTool("app.request_change", oldRequest).then(result => ({result}), error => ({error: {code: error.code, message: error.message}}));
      await bounded(ready.promise);
      if(ordering === "replacement_first") {
        // The waiting request has loaded the original rule and created its proposal.
        // For PG additionally force and observe its actual outer ledger writer wait.
        if(admin) {blockedClient = await admin.connect(); await blockedClient.query("BEGIN");
          await blockedClient.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`synapsor-runner:${schema}:runtime-store`]);
          release.resolve();
          const deadline = Date.now() + 5000; let observed = false;
          while(Date.now() < deadline) {
            const rows = await admin.query("SELECT pid, query FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query LIKE '%pg_try_advisory_xact_lock%' AND state = 'idle in transaction'");
            if(rows.rows.length) {record("postgres_writer_wait_observed", rows.rows); observed = true; break;}
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          expect(observed).toBe(true);
        }
        await publish(1);
        expect((await loadActiveActionRuleAuthority(root)).authority.digest).not.toBe(original.digest);
        if(blockedClient) {await blockedClient.query("COMMIT"); blockedClient.release(); blockedClient = undefined;}
        release.resolve();
      } else {
        release.resolve(); const earlier = await bounded(work); record("earlier_request_result", earlier);
        expect(earlier).toMatchObject({result: {proposal: {status: "approved"}}});
        await publish(1);
      }
      const result = await bounded(work);
      const proposals = await store.listProposals!(), approvals = [];
      for(const p of proposals) approvals.push(...await store.approvals!(p.proposal_id));
      const beforeFresh = {proposals, approvals, queue: await store.listWorkerQueue!()};
      const oldReplay = await services.semanticActions.callTool("app.request_change", oldRequest).then(result => ({result}), error => ({error: {code: error.code}}));
      const fresh = await services.semanticActions.callTool("app.request_change", await request("fresh"));
      record("final", {result, beforeFresh, oldReplay, fresh});
      await save(`publication-${backend}-${ordering}`, {backend, ordering, policy_store: "governed", sequence});
      expect(fresh).toMatchObject({proposal: {status: "pending_review"}});
      expect(oldReplay).toHaveProperty("error");
      if(ordering === "replacement_first") {
        expect(result).toHaveProperty("error");
        expect(approvals).toHaveLength(1);
      } else expect(approvals).toHaveLength(2);
    } finally {
      release.resolve();
      if(blockedClient) {await blockedClient.query("ROLLBACK").catch(() => undefined); blockedClient.release();}
      if(work) await bounded(work).catch(() => undefined);
      await save(`publication-${backend}-${ordering}-timeline`, {backend, ordering, sequence});
      vi.restoreAllMocks(); await store?.close(); await binding?.close();
      if(admin) {try {await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);} finally {await admin.end();}}
      await fs.rm(root, {recursive: true, force: true});
    }
  }, 30000);
});

async function writeAndActivateAuthority(input: {
  root: string;
  source: ReturnType<typeof authoritySource>;
  read: ActivatedExplorationBoundary;
  activatedAt: string;
  maximum: number;
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
      shared_limits: [{ id: "billing_pause_action_24h", kind: "count", scope: "capability", maximum: input.maximum, window_seconds: 86_400,
        capability: input.source.rule.outcome }, { id: "billing_pause_customer_24h", kind: "count", scope: "tenant_principal", maximum: input.maximum,
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

