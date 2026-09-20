import { assessWorkerLaunch } from "./worker-launch.js";
import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { createTerminalActionPrompter, boundarySessionForActionPrompter } from "./action-tui.js";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { ControlPolicyRepository } from "@synapsor-runner/proposal-store";
import { postgresAdapter } from "@synapsor-runner/postgres";
import { writerProvisioningSql } from "./writer-provisioning.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { type RuntimeConfig } from "@synapsor-runner/mcp-server";
import type { ActionRuleCatalogV1 } from "@synapsor-runner/action-rules";
import type { ActionRuleScalarTypeSpecV1, ActionRuleSpecV1, DerivedEffectEnvelopeSpecV1, RuleVerificationBoundarySpecV1 } from "@synapsor/spec";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { buildAutoBoundary, activateExplorationBoundary, writeAutoBoundaryArtifacts, explorationBoundaryCandidateDigest,
  AUTO_BOUNDARY_OVERRIDES_VERSION, type ActivatedExplorationBoundary } from "./auto-boundary.js";
import { recommendedBoundaryReviewCandidate } from "./boundary-candidate.js";
import { buildActionRuleAuthorityDraft, writeActionRuleAuthorityDraft, activateActionRuleAuthority, readActionRuleAuthorityDraft } from "./action-rule-authority.js";
import { encodeOperatorAuthority, validateOperatorPolicySnapshot } from "./control-policy-authority-codec.js";
import { migrateProjectControlPolicies, openBoundProjectControlPolicies } from "./control-policy-store.js";
import { activateSemanticActionRuntime, previewSemanticSupervisedExecution, prepareSemanticWriterHandoff, enableSemanticSupervisedExecution, semanticExecutionConfirmation } from "./semantic-action-deployment.js";
import { inspectSemanticReceiptSetup, previewSemanticReceiptSelection, saveSemanticReceiptSelection, selectedSemanticReceipts, reviewSemanticReceiptSetup } from "./semantic-receipt-setup.js";
import * as savedRequirements from "./saved-action-job-review.js";
import { writebackSetup } from "./writeback-setup.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
const roots: string[] = [];
const postgresSchemas: string[] = [];
afterEach(async () => { vi.restoreAllMocks();
  if (postgresSchemas.length) { const pool = new Pool({ connectionString: process.env.SYNAPSOR_TEST_POSTGRES_URL });
    try { for (const schema of postgresSchemas.splice(0)) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await pool.end(); } }
 for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
let generationLock = `sha256:${"a".repeat(64)}` as const;
const stateType: ActionRuleScalarTypeSpecV1 = { kind: "string", max_length: 16, comparison: "exact", enum: ["active", "paused"] };
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
  return {read, build, inspection};
}

async function writeAndActivateAuthority(input: {
  root: string;
  source: ReturnType<typeof authoritySource>;
  read: ActivatedExplorationBoundary;
  activatedAt: string;
  maximum: number;
  draftOnly?: boolean;
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
  if(input.draftOnly) return {digest: draft.digest};
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


async function fixture(backend: "sqlite" | "postgres" = "sqlite") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-semantic-receipts-")); roots.push(root);
  const { read, build, inspection } = await reviewedRead(root);
  const config: RuntimeConfig = { version: 1, mode: "review", storage: { sqlite_path: path.join(root, ".synapsor/local.db") },
    capabilities: [], sources: { local_postgres: { engine: "postgres", read_url_env: "DATABASE_URL" } },
    trusted_context: { provider: "environment" }, action_rules: { project_root: root } };
  if (backend === "postgres") {
    const schema = `receipt_${randomUUID().replaceAll("-", "")}`; postgresSchemas.push(schema);
    config.storage!.shared_postgres = { mode: "runtime_store", url_env: "SYNAPSOR_TEST_POSTGRES_URL", schema };
  }
  const records = [encodeOperatorAuthority({ type: "read", boundary: read, generation_lock: build.lock }),
    encodeOperatorAuthority({ type: "read_selection", selected_name: read.pack.name })];
  const { binding } = await migrateProjectControlPolicies({ projectRoot: root, config, storePath: config.storage!.sqlite_path!, actor: "fixture_operator",
    readLegacySnapshot: async () => ({ revisions: records, active: records.map(r => ({ scope: r.scope, kind: r.kind, name: r.name, revision_id: r.revision_id })), drafts: [], provenance: [] }),
    validateSnapshot: async snapshot => validateOperatorPolicySnapshot(snapshot, { runtimeConfig: config }) });
  await binding.close();
  await fs.writeFile(path.join(root, "synapsor.runner.json"), JSON.stringify(config));
  const source = authoritySource();
  await writeAndActivateAuthority({ root, source, read, activatedAt: new Date().toISOString(), maximum: 3, draftOnly: true });
  const draft = await readActionRuleAuthorityDraft(root, "billing_active_rules");
  await activateSemanticActionRuntime({ projectRoot: root, draft: draft!, actor: "fixture_operator" });
  const configPath = path.join(root, "synapsor.actions.runner.json");
  const input = { projectRoot: root, configPath, outcome: source.rule.outcome, env: backend === "postgres" ? { SYNAPSOR_TEST_POSTGRES_URL: process.env.SYNAPSOR_TEST_POSTGRES_URL } : {} };
  const proposal = { ...input, receipts: { authority: "source_db" as const, provisioning: "precreated" as const, schema: "receipt_audit", table: "receipts" }, writeUrlEnv: "WRITER_URL" };
  return { ...input, root, source, read, config, proposal, inspection };
}

function receiptTerminal() {
  const input = new PassThrough() as PassThrough & ReadStream;
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value: boolean) { this.isRaw = value; return this; } });
  const output = new PassThrough() as PassThrough & WriteStream;
  Object.assign(output, { isTTY: true, columns: 100, rows: 30 });
  let text = ""; output.on("data", chunk => { text += chunk.toString().replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, ""); });
  const session = boundarySessionForActionPrompter(createTerminalActionPrompter(input, output));
  return { session, input, output,
    async see(value: string) { await vi.waitFor(() => expect(text).toContain(value), { timeout: 1000, interval: 5 }); text = ""; },
    key(name: string, sequence: string) { input.emit("keypress", sequence, { name, sequence }); },
    submit(value = "") { input.write(value + "\n"); },
  };
}

describe("reviewed semantic receipt setup", () => {
  it.each([0, 1, 2])("native receipt default at field %s reaches the next exact review step", async blankAt => {
    const f = await fixture(), original = await previewSemanticReceiptSelection(f.proposal);
    await saveSemanticReceiptSelection({ ...f.proposal, confirmation: original.confirmation });
    const source = structuredClone(f.source); source.verification.resources[0]!.fields[0]!.model_visible = true;
    await writeAndActivateAuthority({ root: f.root, source, read: f.read, maximum: 1, activatedAt: new Date().toISOString() });
    const before = (await inspectSemanticReceiptSetup(f))!; expect(before.selection_current).toBe(false);
    const t = receiptTerminal(); const pending = reviewSemanticReceiptSetup({ ...f, writeUrlEnv: "OTHER", session: t.session });
    try {
      await t.see("Select receipt storage"); t.key("return", "\r");
      const prompts = ["Dedicated write connection variable", "Source receipt schema", "Source receipt table", "Save this exact receipt setup selection?"];
      const values = ["WRITER_URL", "receipt_audit", "receipts"];
      for (let i = 0; i <= blankAt; i++) { await t.see(prompts[i]!); t.submit(i === blankAt ? "" : values[i]!); }
      await t.see(prompts[blankAt + 1]!);
    } finally { t.key("escape", "\u001b"); t.input.emit("end"); await pending; }
    expect((await inspectSemanticReceiptSetup(f))!.selection).toEqual(before.selection);
    expect((await inspectSemanticReceiptSetup(f))!.selection_current).toBe(false);
  });

  it.each(["defaults", "explicit", "escape-writer", "escape-schema", "escape-table", "escape-review", "decline", "invalid", "changed-before-review", "changed-after-review"])("native receipt orchestration preserves consent and state: %s", async mode => {
    const f = await fixture(), original = await previewSemanticReceiptSelection(f.proposal);
    await saveSemanticReceiptSelection({ ...f.proposal, confirmation: original.confirmation });
    const source = structuredClone(f.source); source.verification.resources[0]!.fields[0]!.model_visible = true;
    await writeAndActivateAuthority({ root: f.root, source, read: f.read, maximum: 1, activatedAt: new Date().toISOString() });
    const before = (await inspectSemanticReceiptSetup(f))!, config = await fs.readFile(f.configPath, "utf8");
    const t = receiptTerminal();
    const pending = reviewSemanticReceiptSetup({ ...f, writeUrlEnv: "OTHER", session: t.session }).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await t.see("Select receipt storage"); t.key("return", "\r");
    const labels = ["writer", "schema", "table"], prompts = ["Dedicated write connection variable", "Source receipt schema", "Source receipt table"];
    const explicit = ["SECOND_WRITER", "audit_new", "receipts_new"];
    let cancelled = false;
    for (let i = 0; i < 3; i++) {
      await t.see(prompts[i]!);
      if (mode === `escape-${labels[i]}`) { t.key("escape", "\u001b"); cancelled = true; break; }
      if (i === 2 && mode === "changed-before-review") {
        await writeAndActivateAuthority({ root: f.root, source, read: f.read, maximum: 2, activatedAt: new Date().toISOString() });
      }
      t.submit(mode === "explicit" ? explicit[i] : mode === "invalid" && i === 0 ? "https://not-an-env" : "");
    }
    if (!cancelled && !["invalid", "changed-before-review"].includes(mode)) {
      await t.see("Save this exact receipt setup selection?");
      if (mode === "changed-after-review") {
        const other = { ...f.proposal, receipts: { ...f.proposal.receipts, table: "competing_receipts" } };
        const preview = await previewSemanticReceiptSelection(other); await saveSemanticReceiptSelection({ ...other, confirmation: preview.confirmation });
      }
      if (mode === "escape-review") t.key("escape", "\u001b");
      else {
        if (mode !== "decline") { t.key("up", "\u001b[A"); await t.see("> Yes"); }
        t.key("return", "\r");
      }
    }
    const result = await pending, after = (await inspectSemanticReceiptSetup(f))!;
    expect(await fs.readFile(f.configPath, "utf8")).toBe(config); // Receipt review never writes execution configuration.
    if (["defaults", "explicit"].includes(mode)) {
      expect(result.error).toBeUndefined(); expect(result.value?.reviewed).toBe(true); expect(after.selection_current).toBe(true);
      expect(after.selection!.write_url_env).toBe(mode === "explicit" ? explicit[0] : "WRITER_URL");
      expect(after.selection!.receipts).toEqual(mode === "explicit" ? { authority: "source_db", provisioning: "precreated", schema: explicit[1], table: explicit[2] } : f.proposal.receipts);
    } else if (mode === "changed-after-review") {
      expect(result.error?.message).toContain("SEMANTIC_RECEIPT_CONFIRMATION_REQUIRED");
      expect(after.selection!.receipts).toMatchObject({ table: "competing_receipts" });
    } else {
      if (mode === "invalid") expect(result.error).toBeDefined();
      else if (mode === "changed-before-review") expect(result.error?.message).toContain("SEMANTIC_RECEIPT_CONFIRMATION_REQUIRED");
      else { expect(result.error).toBeUndefined(); expect(result.value).toBeUndefined(); }
      expect(after.selection).toEqual(before.selection); expect(after.selection_current).toBe(false);
      expect(after.revision_id).toBe(before.revision_id);
    }
  });

  it.skipIf(!process.env.SYNAPSOR_TEST_POSTGRES_URL)("postgres control store retains exact intent, renews stale binding and refuses competing confirmations", async () => {
    const f = await fixture("postgres"), original = await previewSemanticReceiptSelection(f.proposal);
    await saveSemanticReceiptSelection({ ...f.proposal, confirmation: original.confirmation });
    const source = structuredClone(f.source); source.verification.resources[0]!.fields[0]!.model_visible = true;
    await writeAndActivateAuthority({ root: f.root, source, read: f.read, maximum: 1, activatedAt: new Date().toISOString() });
    expect((await inspectSemanticReceiptSetup(f))!.selection_current).toBe(false);
    const same = await previewSemanticReceiptSelection(f.proposal);
    const different = { ...f.proposal, receipts: { ...f.proposal.receipts, table: "other_receipts" } };
    const other = await previewSemanticReceiptSelection(different);
    const results = await Promise.allSettled([saveSemanticReceiptSelection({ ...f.proposal, confirmation: same.confirmation }),
      saveSemanticReceiptSelection({ ...different, confirmation: other.confirmation })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    const reopened = (await inspectSemanticReceiptSetup(f))!;
    expect(reopened.selection_current).toBe(true);
    expect(reopened.selection!.receipts.authority).toBe("source_db");
    expect(reopened.selection!.write_url_env).toBe("WRITER_URL");
  });

  it("requires a selection instead of reporting semantic source writes not applicable", async () => {
    const f = await fixture();
    const before = await fs.readFile(f.configPath, "utf8");
    await expect(writebackSetup(["--config", f.configPath, "--profile", "development", "--json"]))
      .rejects.toThrow("SEMANTIC_RECEIPT_REVIEW_REQUIRED");
    expect(await fs.readFile(f.configPath, "utf8")).toBe(before);
  });

  it("previews, confirms and reloads a selection without changing active execution or source bindings", async () => {
    const f = await fixture();
    const before = await fs.readFile(f.configPath, "utf8");
    const preview = await previewSemanticReceiptSelection(f.proposal);
    expect((await inspectSemanticReceiptSetup(f))!.selection).toBeUndefined();
    await expect(saveSemanticReceiptSelection({ ...f.proposal, confirmation: "yes" })).rejects.toThrow("CONFIRMATION_REQUIRED");
    await saveSemanticReceiptSelection({ ...f.proposal, confirmation: preview.confirmation });
    const restarted = await inspectSemanticReceiptSetup(f);
    expect(selectedSemanticReceipts(restarted!, "WRITER_URL")).toEqual(f.proposal.receipts);
    expect(() => selectedSemanticReceipts(restarted!, "OTHER_WRITER")).toThrow("REVIEW_REQUIRED");
    expect(await fs.readFile(f.configPath, "utf8")).toBe(before);
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((value: any) => { chunks.push(String(value)); return true; });
    await writebackSetup(["--config", f.configPath, "--profile", "development", "--writer-role", "app_writer", "--setup-url-env", "ADMIN_URL", "--json"]);
    const result = JSON.parse(chunks.join(""));
    expect(result).toMatchObject({ ok: true, applied: false, plan: { receipt_mode: "source_precreated", source: "local_postgres",
      source_objects: ["receipt_audit.receipts"], source_database_changed: false } });
    expect(result.plan.sql_preview).toContain('CREATE TABLE IF NOT EXISTS "receipt_audit"."receipts"');
    expect(result.plan.writer_grants.join("\n")).toContain("SELECT, INSERT, UPDATE");
    expect(await fs.readFile(f.configPath, "utf8")).toBe(before);
    await expect(writebackSetup(["--config", f.configPath, "--schema", "other", "--json"])).rejects.toThrow("SELECTION_CHANGED");
  });

  it("keeps exactly one selection under competing confirmations and refuses stale bindings", async () => {
    const f = await fixture();
    const first = await previewSemanticReceiptSelection(f.proposal);
    const secondInput = { ...f.proposal, receipts: { authority: "runner_ledger" as const } };
    const second = await previewSemanticReceiptSelection(secondInput);
    const results = await Promise.allSettled([
      saveSemanticReceiptSelection({ ...f.proposal, confirmation: first.confirmation }),
      saveSemanticReceiptSelection({ ...secondInput, confirmation: second.confirmation }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const existing = await inspectSemanticReceiptSetup(f);
    const config = JSON.parse(await fs.readFile(f.configPath, "utf8"));
    config.sources.local_postgres.read_url_env = "OTHER_READER";
    await fs.writeFile(f.configPath, JSON.stringify(config));
    const changed = await inspectSemanticReceiptSetup(f);
    expect(changed!.selection).toEqual(existing!.selection);
    expect(changed!.selection_current).toBe(false);
    expect(() => selectedSemanticReceipts(changed!)).toThrow("REVIEW_REQUIRED");
  });

  it("preserves an explicitly reviewed Runner-ledger mode and does not provision source objects", async () => {
    const f = await fixture();
    const proposal = { ...f.proposal, receipts: { authority: "runner_ledger" as const } };
    const preview = await previewSemanticReceiptSelection(proposal);
    await saveSemanticReceiptSelection({ ...proposal, confirmation: preview.confirmation });
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((value: any) => { chunks.push(String(value)); return true; });
    await writebackSetup(["--config", f.configPath, "--profile", "development", "--json"]);
    expect(JSON.parse(chunks.join(""))).toMatchObject({ applied: false, plan: { receipt_mode: "runner_ledger", source_objects: [], writer_grants: [] } });
  });

  it("retains the selected mode over an approval-limit replacement and unchanged metadata reload", async () => {
    const f = await fixture();
    const preview = await previewSemanticReceiptSelection(f.proposal);
    await saveSemanticReceiptSelection({ ...f.proposal, confirmation: preview.confirmation });
    await writeAndActivateAuthority({ root: f.root, source: f.source, read: f.read, maximum: 1, activatedAt: new Date().toISOString() });
    expect(selectedSemanticReceipts((await inspectSemanticReceiptSetup(f))!)).toEqual(f.proposal.receipts);
  });

  it("failed persistence does not replace the selection or permit stale confirmation after a later save", async () => {
    const f = await fixture();
    const preview = await previewSemanticReceiptSelection(f.proposal);
    const commit = vi.spyOn(ControlPolicyRepository.prototype, "commit").mockRejectedValueOnce(new Error("injected selection store failure"));
    await expect(saveSemanticReceiptSelection({ ...f.proposal, confirmation: preview.confirmation })).rejects.toThrow("selection store failure");
    commit.mockRestore();
    expect((await inspectSemanticReceiptSetup(f))!.selection).toBeUndefined();
    await saveSemanticReceiptSelection({ ...f.proposal, confirmation: preview.confirmation });
    await expect(saveSemanticReceiptSelection({ ...f.proposal, confirmation: preview.confirmation })).rejects.toThrow("CONFIRMATION_REQUIRED");
  });

  it("includes the exact missing receipt infrastructure in the narrow administrator handoff", async () => {
    const f = await fixture();
    const preview = await previewSemanticReceiptSelection(f.proposal);
    await saveSemanticReceiptSelection({ ...f.proposal, confirmation: preview.confirmation });
    const checked = await prepareSemanticWriterHandoff({ projectRoot: f.root, outcome: f.outcome,
      reads: [{ pack: f.read.pack, digest: f.read.activation.digest }], writeUrlEnv: "WRITER_URL",
      env: { DATABASE_URL: "postgresql://synthetic-reader" }, inspect: async () => f.inspection });
    expect(checked).toMatchObject({ writer_status: "not_checked", receipt_status: "selected_not_verified", assessment: { ok: false },
      plan: { receipt_setup: { schema: "receipt_audit", table: "receipts" } } });
    const sql = writerProvisioningSql(checked.plan);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "receipt_audit"."receipts"');
    expect(sql).toContain('GRANT INSERT ON TABLE "receipt_audit"."receipts"');
    expect(sql).not.toContain('TO "reader"');
    expect((await fs.readFile(f.configPath, "utf8"))).not.toContain('"authority":"source_db"');
  });

  it("requires actual receipt objects and writer verification before the separate execution review", async () => {
    const f = await fixture();
    const preview = await previewSemanticReceiptSelection(f.proposal);
    await saveSemanticReceiptSelection({ ...f.proposal, confirmation: preview.confirmation });
    const inspection = structuredClone(f.inspection);
    inspection.current_user = "dedicated_writer";
    inspection.role_posture = { verified: true, superuser: false, bypass_rls: false, read_only: false,
      writable_relations: ["billing.preferences", "receipt_audit.receipts"], owned_relations: [], reasons: [] };
    inspection.tables[0]!.role_posture!.column_privileges = { update: ["preference_id", "status", "version"] };
    const input = { projectRoot: f.root, outcome: f.outcome, profile: "staging" as const, writeUrlEnv: "WRITER_URL",
      env: { WRITER_URL: "postgresql://synthetic-writer" }, inspect: async () => inspection };
    const doctor = vi.spyOn(postgresAdapter, "doctor").mockResolvedValue({ ok: true, details: { receipt_permissions: "select_insert_update_rollback_verified" } });
    await expect(previewSemanticSupervisedExecution(input)).rejects.toThrow("WRITER_POSTURE");
    expect(doctor).not.toHaveBeenCalled();
    inspection.tables.push({ schema: "receipt_audit", name: "receipts", type: "table", columns: [], primary_key: ["idempotency_key"],
      role_posture: { privileges: { select: true, insert: true, update: true, delete: false, truncate: false, references: false, trigger: false },
        current_role_is_owner: false, current_role_can_assume_owner: false } } as unknown as SchemaInspection["tables"][number]);
    await expect(previewSemanticSupervisedExecution(input)).rejects.toThrow("RECEIPT_OBJECT_INVALID");
    inspection.tables[1]!.columns = ["idempotency_key", "job_id", "proposal_id", "status", "result_hash", "completed_at", "semantic_verification_json"]
      .map(name => ({ name, data_type: name === "semantic_verification_json" ? "jsonb" : "text" })) as SchemaInspection["tables"][number]["columns"];
    doctor.mockResolvedValueOnce({ ok: false, details: { error: "injected receipt probe failure" } });
    await expect(previewSemanticSupervisedExecution(input)).rejects.toThrow("RECEIPT_NOT_VERIFIED");
    const ready = await previewSemanticSupervisedExecution(input);
    expect(ready.receipts).toEqual(f.proposal.receipts);
    const probeCalls = doctor.mock.calls.length;
    const launch = await assessWorkerLaunch({ config: ready.config as RuntimeConfig, configPath: f.configPath, capability: f.outcome, env: input.env });
    expect(launch.receipt).toMatchObject({ mode: "source_db", selected_mode: "source_db", selection: "current", matches_execution_configuration: true });
    for (const changed of ["mode", "destination", "writer"] as const) {
      const config = structuredClone(ready.config) as RuntimeConfig;
      if (changed === "mode") config.sources!.local_postgres!.receipts = { authority: "runner_ledger" };
      else if (changed === "destination") config.sources!.local_postgres!.receipts = { ...f.proposal.receipts, table: "other_receipts" };
      else { config.sources!.local_postgres!.write_url_env = "OTHER_WRITER"; config.supervised_worker!.outcomes![0]!.write_url_env = "OTHER_WRITER"; }
      const different = await assessWorkerLaunch({ config, configPath: f.configPath, capability: f.outcome, env: input.env });
      expect(different.receipt, changed).toMatchObject({ selected_mode: "source_db", selection: "current", matches_execution_configuration: false });
    }
    expect(doctor).toHaveBeenCalledTimes(probeCalls); // Reporting never probes receipts.

    expect(doctor).toHaveBeenLastCalledWith(expect.objectContaining({ receipts: f.proposal.receipts, databaseUrl: input.env.WRITER_URL, dryRun: true }));
    const before = await fs.readFile(f.configPath, "utf8");
    const enable = { ...input, expectedActionBoundaryDigest: ready.action_boundary_digest, expectedConfigDigest: ready.current_config_digest,
      expectedWriterPostureFingerprint: ready.writer_posture_fingerprint, confirmation: semanticExecutionConfirmation(ready) };
    await expect(enableSemanticSupervisedExecution({ ...enable, confirmation: "yes" })).rejects.toThrow("CONFIRMATION_REQUIRED");
    expect(await fs.readFile(f.configPath, "utf8")).toBe(before);
    await enableSemanticSupervisedExecution(enable);
    const configured = JSON.parse(await fs.readFile(f.configPath, "utf8"));
    expect(configured.sources.local_postgres.receipts).toEqual(f.proposal.receipts);
    expect(configured.supervised_worker.enabled).toBe(true);
    const binding = await openBoundProjectControlPolicies(f.root);
    try {
      const records = await binding!.repository.scopeSnapshot({ deployment_id: binding!.deployment_id, scope: { level: "operator" }, kinds: ["execution"] });
      expect(records.active).toHaveLength(1);
    } finally { await binding?.close(); }
  });

  it.each(["runner_ledger", "source_db"] as const)("saves the confirmed interactive %s selection and keeps it after reopening", async authority => {
    const f = await fixture();
    const before = await fs.readFile(f.configPath, "utf8");
    const session = { chooseOption: vi.fn().mockResolvedValue(authority), promptText: vi.fn().mockResolvedValue(""),
      confirm: vi.fn().mockResolvedValue(true) } as unknown as BoundaryReviewInteractiveSession;
    expect(await reviewSemanticReceiptSetup({ projectRoot: f.root, configPath: f.configPath, outcome: f.outcome,
      env: {}, writeUrlEnv: "WRITER_URL", session })).toEqual({ writeUrlEnv: "WRITER_URL", reviewed: true });
    const expected = authority === "runner_ledger" ? { authority } : { authority, provisioning: "precreated", schema: "public", table: "synapsor_writeback_receipts" };
    expect(selectedSemanticReceipts((await inspectSemanticReceiptSetup(f))!, "WRITER_URL")).toEqual(expected);
    const binding = await openBoundProjectControlPolicies(f.root);
    const epoch = await binding!.repository.deployment(binding!.deployment_id);
    try {
      vi.mocked(session.chooseOption!).mockResolvedValue("keep");
      vi.mocked(session.confirm).mockClear();
      await reviewSemanticReceiptSetup({ projectRoot: f.root, configPath: f.configPath, outcome: f.outcome,
        env: {}, writeUrlEnv: "OTHER_DEFAULT", session });
      expect(session.confirm).not.toHaveBeenCalled();
      expect(await binding!.repository.deployment(binding!.deployment_id)).toEqual(epoch);
    } finally { await binding?.close(); }
    expect(await fs.readFile(f.configPath, "utf8")).toBe(before);
  });

  it("retains stale reviewed receipt intent as the initial post-publication choice", async () => {
    const f = await fixture();
    const preview = await previewSemanticReceiptSelection(f.proposal);
    await saveSemanticReceiptSelection({ ...f.proposal, confirmation: preview.confirmation });
    const replacement = structuredClone(f.source);
    // Same separately reviewed metadata reconciliation that accompanies the saved numeric edit.
    replacement.verification.resources[0]!.fields.find(f => f.name === "status")!.model_visible = true;
    await writeAndActivateAuthority({ root: f.root, source: replacement, read: f.read, maximum: 1, activatedAt: new Date().toISOString() });
    const before = await inspectSemanticReceiptSetup(f);
    expect(before!.selection_current).toBe(false);
    const session = { chooseOption: vi.fn().mockResolvedValue("source_db"), promptText: vi.fn().mockResolvedValue(""),
      confirm: vi.fn().mockResolvedValue(false) } as unknown as BoundaryReviewInteractiveSession;
    expect(await reviewSemanticReceiptSetup({ ...f, writeUrlEnv: "NEW_DEFAULT", session })).toBeUndefined();
    expect(session.chooseOption).toHaveBeenCalledWith("Select receipt storage for this outcome", expect.anything(),
      expect.objectContaining({ initialValue: "source_db" }));
    expect(session.confirm).toHaveBeenCalledWith("Save this exact receipt setup selection?", expect.objectContaining({
      context: expect.arrayContaining([expect.stringContaining('"schema":"receipt_audit"'), "Writer reference: WRITER_URL"]),
    }));
    expect((await inspectSemanticReceiptSetup(f))!.selection).toEqual(before!.selection);
  });

  it("renews the exact stale selection, preserving old records and execution, then reuses it after restart", async () => {
    const f = await fixture(), original = await previewSemanticReceiptSelection(f.proposal);
    await saveSemanticReceiptSelection({ ...f.proposal, confirmation: original.confirmation });
    const replacement = structuredClone(f.source);
    replacement.verification.resources[0]!.fields.find(f => f.name === "status")!.model_visible = true;
    await writeAndActivateAuthority({ root: f.root, source: replacement, read: f.read, maximum: 1, activatedAt: new Date().toISOString() });
    const config = await fs.readFile(f.configPath, "utf8"), old = (await inspectSemanticReceiptSetup(f))!.revision_id;
    const session = { chooseOption: vi.fn().mockResolvedValue("source_db"), promptText: vi.fn().mockResolvedValue(""), confirm: vi.fn().mockResolvedValue(true) } as unknown as BoundaryReviewInteractiveSession;
    await reviewSemanticReceiptSetup({ ...f, writeUrlEnv: "NEW_DEFAULT", session });
    const after = (await inspectSemanticReceiptSetup(f))!;
    expect(after.selection_current).toBe(true); expect(after.revision_id).not.toBe(old);
    expect(after.selection!.receipts).toEqual(f.proposal.receipts);
    expect(after.selection!.write_url_env).toBe("WRITER_URL");
    expect(await fs.readFile(f.configPath, "utf8")).toBe(config);
    vi.mocked(session.chooseOption!).mockResolvedValue("keep"); vi.mocked(session.confirm).mockClear();
    await reviewSemanticReceiptSetup({ ...f, writeUrlEnv: "NEW_DEFAULT", session });
    expect(session.confirm).not.toHaveBeenCalled();
    const binding = await openBoundProjectControlPolicies(f.root);
    try { expect(await binding!.repository.revision(binding!.deployment_id, { scope: { level: "operator" }, kind: "management", name: `semantic_receipts_${canonicalJsonDigest({ outcome: f.outcome }).slice(7)}` }, old!)).toBeDefined(); } finally { await binding?.close(); }
  });

  it("refuses incompatible source-atomic downgrades and permits a separately reviewed compatible destination", async () => {
    const f = await fixture(), original = await previewSemanticReceiptSelection(f.proposal);
    await saveSemanticReceiptSelection({ ...f.proposal, confirmation: original.confirmation });
    await expect(previewSemanticReceiptSelection({ ...f.proposal, receipts: { authority: "runner_ledger" } })).rejects.toThrow("GUARANTEE_REVIEW_REQUIRED");
    vi.spyOn(savedRequirements, "readSavedExecutionRequirements").mockResolvedValue({ source_digest: `sha256:${"a".repeat(64)}`,
      passages: ["Require a source-atomic receipt."], receipt_requirements: ["source_db"] });
    await expect(previewSemanticReceiptSelection({ ...f.proposal, receipts: { authority: "runner_ledger" } })).rejects.toThrow("REQUIREMENT_MISMATCH");
    const proposal = { ...f.proposal, receipts: { ...f.proposal.receipts, table: "new_receipts" } };
    const preview = await previewSemanticReceiptSelection(proposal);
    await saveSemanticReceiptSelection({ ...proposal, confirmation: preview.confirmation });
    expect(selectedSemanticReceipts((await inspectSemanticReceiptSetup(f))!)).toEqual(proposal.receipts);
  });

  it("cancellation and interruption of stale re-review never replace its intent", async () => {
    const f = await fixture(), original = await previewSemanticReceiptSelection(f.proposal);
    await saveSemanticReceiptSelection({ ...f.proposal, confirmation: original.confirmation });
    const replacement = structuredClone(f.source); replacement.verification.resources[0]!.fields[0]!.model_visible = true;
    await writeAndActivateAuthority({ root: f.root, source: replacement, read: f.read, maximum: 1, activatedAt: new Date().toISOString() });
    const before = await inspectSemanticReceiptSetup(f);
    for (const chosen of [undefined, "pause", "source_db"]) {
      const session = { chooseOption: async () => chosen, promptText: async () => undefined, confirm: vi.fn() } as unknown as BoundaryReviewInteractiveSession;
      expect(await reviewSemanticReceiptSetup({ ...f, writeUrlEnv: "OTHER", session })).toBeUndefined();
      expect((await inspectSemanticReceiptSetup(f))!.selection).toEqual(before!.selection);
      expect(session.confirm).not.toHaveBeenCalled();
    }
  });

  it("declining the actual setup review leaves no saved selection", async () => {
    const f = await fixture();
    const session = { chooseOption: vi.fn().mockResolvedValue("source_db"), promptText: vi.fn().mockResolvedValue(""), confirm: vi.fn().mockResolvedValue(false) } as unknown as BoundaryReviewInteractiveSession;
    expect(await reviewSemanticReceiptSetup({ ...f, writeUrlEnv: "WRITER_URL", session })).toBeUndefined();
    expect((await inspectSemanticReceiptSetup(f))!.selection).toBeUndefined();
    expect(session.confirm).toHaveBeenCalledWith("Save this exact receipt setup selection?", expect.anything());
  });
});
