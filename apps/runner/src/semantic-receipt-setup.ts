import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { resolveRuntimeConfig, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import type { ControlPolicyKey } from "@synapsor-runner/proposal-store";
import { createActiveActionRuleAuthorityLoader, listActionRuleAuthorityDrafts } from "./action-rule-authority.js";
import { openBoundProjectControlPolicies, commitImmutableControlPolicies } from "./control-policy-store.js";
import { assertOperatorPolicyRecord, storedOperatorPolicyRecord } from "./control-policy-record.js";
import { withProjectAuthorityMutation, withHeldProjectAuthorityAccess, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import { actionRuleModelDraftFromAuthority } from "./action-rule-draft.js";
import { explorationBoundaryCandidateDigest } from "./auto-boundary.js";
import { readProjectReadAuthoringHeld } from "./control-policy-read-authoring-project.js";
import { readSavedExecutionRequirementsHeld } from "./saved-execution-requirements.js";
import { semanticReceiptSetupReadback } from "./semantic-receipt-presentation.js";

const identifier = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/u);
export const semanticReceiptModeSchema = z.discriminatedUnion("authority", [
  z.object({ authority: z.literal("runner_ledger") }).strict(),
  z.object({ authority: z.literal("source_db"), provisioning: z.literal("precreated"), schema: identifier, table: identifier }).strict(),
]);
export type SemanticReceiptMode = z.infer<typeof semanticReceiptModeSchema>;
const selectionSchema = z.object({
  schema_version: z.literal("synapsor.semantic-receipt-selection.v1"),
  project_id: z.string().uuid(), deployment_id: z.string().uuid(),
  outcome: z.string(), binding_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  write_url_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u), receipts: semanticReceiptModeSchema,
}).strict();
export type SemanticReceiptSelection = z.infer<typeof selectionSchema>;
const keyFor = (outcome: string): ControlPolicyKey => ({ scope: { level: "operator" }, kind: "management",
  name: `semantic_receipts_${canonicalJsonDigest({ outcome }).slice(7)}` });
function fail(code: string, message: string): never { throw Object.assign(new Error(`${code}: ${message} No execution was enabled.`), { code }); }

/** Operator setup only. This record is never consulted for business admission,
 * runtime identity, or execution permission. Live mode remains in the separately
 * reviewed execution configuration and its exact governed binding. */
export type SemanticReceiptSetupInput = {
  projectRoot: string; configPath: string; outcome?: string; disabled?: boolean; env?: NodeJS.ProcessEnv;
};
export async function inspectSemanticReceiptSetup(input: SemanticReceiptSetupInput) {
  const captured = structuredClone(input);
  return withProjectAuthorityMutation(input.projectRoot, held => inspectReceiptSetupHeld(captured, held));
}
export async function inspectSemanticReceiptSetupHeld(input: SemanticReceiptSetupInput, permit: ProjectAuthorityMutationPermit) {
  const captured = structuredClone(input);
  return withHeldProjectAuthorityAccess(input.projectRoot, permit, held => inspectReceiptSetupHeld(captured, held));
}
async function inspectReceiptSetupHeld(input: SemanticReceiptSetupInput, permit: ProjectAuthorityMutationPermit) {
  if (input.disabled) return inspectDisabledSemanticReceiptSetup(input, permit);
  const root = await fs.realpath(input.projectRoot);
  const configPath = await fs.realpath(input.configPath);
  if (path.dirname(configPath) !== root) fail("SEMANTIC_RECEIPT_CONFIG_UNRELATED", "Select this project's Action runtime configuration.");
  const raw = JSON.parse(await fs.readFile(configPath, "utf8")) as RuntimeConfig;
  if (!raw.action_rules) return undefined;
  const config = resolveRuntimeConfig(raw, root);
  const binding = await openBoundProjectControlPolicies(root, input.env);
  const active = await createActiveActionRuleAuthorityLoader(root, binding)({ dependency_check: "report" })
    .catch(async error => { await binding?.close(); throw error; });
  try {
    const rules = active.registry.rules.filter(({ compiled }) => compiled.effect_envelope.writeback.mode === "direct_sql"
      && compiled.effect_envelope.writeback.supervised_worker === "allowed");
    if (!rules.length) return undefined;
    const rule = input.outcome ? rules.find(({ compiled }) => compiled.outcome === input.outcome)
      : rules.length === 1 ? rules[0] : undefined;
    if (!rule) fail("SEMANTIC_RECEIPT_OUTCOME_REQUIRED", "Select one current source-writing outcome with --outcome <name>.");
    const source = config.sources?.[rule.compiled.source];
    if (!source) fail("SEMANTIC_RECEIPT_SOURCE_MISSING", "Restore the current Action source binding.");
    const requirements = await readSavedExecutionRequirementsHeld({ projectRoot: root, boundaryName: rule.read_boundary_name, env: input.env }, permit);
    // Read-only -> writable and receipt configuration are the later reviewed
    // deployment, not a new business/Read contract. A rule-limit edit also leaves
    // this contract unchanged. Source/scope/effect changes invalidate selection.
    const { read_only: _readOnly, write_url_env: _writer, receipts: _receipts, ...readSource } = source;
    const bindingDigest = canonicalJsonDigest(JSON.parse(JSON.stringify({
      source: rule.compiled.source, source_binding: readSource,
      effect: rule.compiled.effect_envelope, verification: rule.compiled.verification_boundary,
      read_boundary: rule.read_boundary_name, policy_source_digest: requirements.source_digest,
      requirements: requirements.passages,
    })));
    const key = keyFor(rule.compiled.outcome);
    const snapshot = binding ? await binding.repository.scopeSnapshot({ deployment_id: binding.deployment_id,
      scope: { level: "operator" }, kinds: ["management"] }) : undefined;
    const revision = snapshot?.active.find(record => record.name === key.name);
    let selection: SemanticReceiptSelection | undefined;
    let selectionCurrent = false;
    if (revision) {
      selection = selectionSchema.parse(revision.content);
      assertOperatorPolicyRecord(revision, key, canonicalJsonDigest(selection));
      selectionCurrent = selection.project_id === binding!.project_id && selection.deployment_id === binding!.deployment_id
        && selection.outcome === rule.compiled.outcome && selection.binding_digest === bindingDigest;
    }
    return { phase: "active" as const, business_resources: active.authority.catalog.resources.map(r => `${r.schema}.${r.table}`),
      project_root: root, config_path: configPath, config, source_name: rule.compiled.source, source,
      outcome: rule.compiled.outcome, action_digest: active.authority.action_boundary.digest,
      binding_digest: bindingDigest, requirements, selection, selection_current: selectionCurrent,
      revision_id: revision?.revision_id ?? null, epoch: snapshot?.epoch,
      project_id: binding?.project_id, deployment_id: binding?.deployment_id,
      receipt_readback: semanticReceiptSetupReadback({ source_name: rule.compiled.source, source, storage: config.storage,
        selection, selection_state: selectionCurrent ? "current" : "stale",
        ...(rule.compiled.hard_limit && source.engine === "mysql" ? { support_reason: "hard_limit_engine_unsupported" as const } : {}) }) };
  } finally { await binding?.close(); }
}

export type SemanticReceiptSelectionInput = SemanticReceiptSetupInput & { receipts: SemanticReceiptMode; writeUrlEnv: string };
export async function previewSemanticReceiptSelection(input: SemanticReceiptSelectionInput) {
  const captured = structuredClone(input);
  return withProjectAuthorityMutation(input.projectRoot, held => previewReceiptSelectionHeld(captured, held));
}
export async function previewSemanticReceiptSelectionHeld(input: SemanticReceiptSelectionInput, permit: ProjectAuthorityMutationPermit) {
  const captured = structuredClone(input);
  return withHeldProjectAuthorityAccess(input.projectRoot, permit, held => previewReceiptSelectionHeld(captured, held));
}
async function previewReceiptSelectionHeld(input: SemanticReceiptSelectionInput, permit: ProjectAuthorityMutationPermit) {
  const setup = await inspectReceiptSetupHeld(input, permit);
  if (!setup || setup.epoch === undefined) fail("SEMANTIC_RECEIPT_REVIEW_UNAVAILABLE", "Use the current governed Action project to review receipt setup.");
  const selection = selectionSchema.parse({ schema_version: "synapsor.semantic-receipt-selection.v1",
    project_id: setup.project_id, deployment_id: setup.deployment_id, outcome: setup.outcome,
    binding_digest: setup.binding_digest, write_url_env: input.writeUrlEnv, receipts: input.receipts });
  if (setup.requirements.receipt_requirements?.includes("source_db") && selection.receipts.authority !== "source_db") {
    fail("SEMANTIC_RECEIPT_REQUIREMENT_MISMATCH", "The current saved source requires a source-atomic receipt. Runner-ledger mode cannot satisfy it. Keep the source requirement and review Source database setup.");
  }
  if (setup.selection?.receipts.authority === "source_db" && selection.receipts.authority === "runner_ledger"
    && !setup.requirements.receipt_requirements?.includes("runner_ledger")) {
    fail("SEMANTIC_RECEIPT_GUARANTEE_REVIEW_REQUIRED", "The prior reviewed source-atomic receipt guarantee is retained. A weaker mode has no established compatible saved requirement; review that requirement separately instead of downgrading during a rule edit.");
  }
  if (selection.receipts.authority === "source_db") {
    const relation = `${selection.receipts.schema}.${selection.receipts.table}`;
    if (setup.business_resources.includes(relation)) {
      fail("SEMANTIC_RECEIPT_RELATION_CONFLICT", "Use a dedicated receipt relation, not a reviewed business resource.");
    }
  }
  if (selection.write_url_env === setup.source.read_url_env) fail("SEMANTIC_RECEIPT_WRITER_REQUIRED", "Select a dedicated write environment reference, keeping the reader unchanged.");
  const digest = canonicalJsonDigest({ selection, config_path: setup.config_path, epoch: setup.epoch,
    previous_revision: setup.revision_id, action_digest: setup.action_digest });
  return { ...setup, selection, digest, confirmation: `SAVE RECEIPT SETUP ${digest}`,
    receipt_readback: semanticReceiptSetupReadback({ source_name: setup.source_name, source: setup.source, storage: setup.config.storage,
      selection, selection_state: "proposed", support_reason: setup.receipt_readback.support.reason ?? undefined }) };
}

export async function saveSemanticReceiptSelection(input: Parameters<typeof previewSemanticReceiptSelection>[0] & { confirmation: string; permit?: ProjectAuthorityMutationPermit }) {
  // Freeze the exact reviewed data before waiting for the authority gate. UI
  // sessions and inspection callbacks are not selection data or persisted state.
  const frozen = structuredClone({ projectRoot: input.projectRoot, configPath: input.configPath,
    outcome: input.outcome, disabled: input.disabled, env: input.env, receipts: input.receipts,
    writeUrlEnv: input.writeUrlEnv, confirmation: input.confirmation });
  return withProjectAuthorityMutation(input.projectRoot, async held => {
    const preview = await previewSemanticReceiptSelectionHeld({ ...frozen, projectRoot: held.projectRoot }, held);
    if (frozen.confirmation !== preview.confirmation) fail("SEMANTIC_RECEIPT_CONFIRMATION_REQUIRED", `Review the exact selection and enter ${preview.confirmation}.`);
    const binding = await openBoundProjectControlPolicies(held.projectRoot, frozen.env);
    if (!binding) fail("SEMANTIC_RECEIPT_REVIEW_UNAVAILABLE", "The reviewed policy repository is unavailable.");
    try {
      const key = keyFor(preview.outcome);
      const revision = storedOperatorPolicyRecord(key, canonicalJsonDigest(preview.selection), preview.selection);
      await commitImmutableControlPolicies(binding, { expected_epoch: preview.epoch!, revisions: [revision],
        active: [{ ...key, revision_id: revision.revision_id }], event: { event_id: randomUUID(), actor: "local_operator",
          occurred_at: new Date().toISOString(), receipt: { operation: "review_semantic_receipt_setup", outcome: preview.outcome,
            revision_id: revision.revision_id, source_database_changed: false, execution_enabled: false } } });
      return preview;
    } finally { await binding.close(); }
  }, { permit: input.permit });
}

export function selectedSemanticReceipts(setup: NonNullable<Awaited<ReturnType<typeof inspectSemanticReceiptSetup>>>, writeUrlEnv?: string): SemanticReceiptMode {
  if (!setup.selection_current || !setup.selection || (writeUrlEnv && writeUrlEnv !== setup.selection.write_url_env)) {
    fail("SEMANTIC_RECEIPT_REVIEW_REQUIRED", "Review receipt mode and the exact writer reference in action review (execution setup), or writeback setup --outcome <name> --receipt-mode <runner_ledger|source_db> --write-url-env <NAME>. A preview alone does not save the selection, provision receipts or verify execution.");
  }
  return setup.selection.receipts;
}

export async function reviewSemanticReceiptSetup(input: {
  projectRoot: string; configPath: string; outcome: string; writeUrlEnv: string;
  session: import("./boundary-cli-picker.js").BoundaryReviewInteractiveSession; env?: NodeJS.ProcessEnv;
}): Promise<{ writeUrlEnv: string; reviewed: boolean } | undefined> {
  const setup = await inspectSemanticReceiptSetup(input);
  // Legacy file-managed execution already has an explicit configuration review.
  if (!setup || setup.epoch === undefined) return { writeUrlEnv: input.writeUrlEnv, reviewed: false };
  const prior = setup.selection;
  // Intent survives loss of verification freshness. Never substitute a weaker
  // default merely because a reviewed replacement changed its binding.
  const writerDefault = prior?.write_url_env ?? input.writeUrlEnv;
  const sourceDefault = prior?.receipts.authority === "source_db" ? prior.receipts : undefined;
  const context = [
    ...(prior ? [`Prior reviewed intent: ${JSON.stringify(prior.receipts)}; writer reference: ${prior.write_url_env}.`,
      setup.selection_current ? "Selection binding is current; this is not writer verification or execution permission."
        : "Selection binding is stale. Review it explicitly for the current source/effect; fresh writer and receipt verification is required."] : ["No prior reviewed receipt selection exists."]),
    "Receipt storage is a deployment requirement, not a public Read resource.",
    ...setup.requirements.passages,
    setup.receipt_readback.recommendation,
    ...(setup.receipt_readback.selection.origin === "existing_configuration"
      ? [`Existing configured receipt intent (unverified): ${JSON.stringify(setup.source.receipts)}. This is not a new setup or a reviewed native selection.`] : []),
    setup.receipt_readback.runner_ledger_meaning, setup.receipt_readback.source_db_recovery_meaning,
    setup.receipt_readback.source_db_storage_requirements,
    setup.receipt_readback.storage.requirements,
    "Selecting a mode changes no source objects, active execution configuration or business authority. Administrator setup and execution review remain separate."];
  if (setup.selection_current) {
    const choice = await input.session.chooseOption?.("Review saved receipt setup", [
      { value: "keep", label: "Keep the exact reviewed selection" },
      { value: "change", label: "Review a different selection" },
      { value: "pause", label: "Set up later" },
    ], { initialValue: "keep", context: [...context, `Selected: ${JSON.stringify(setup.selection!.receipts)}; writer reference: ${setup.selection!.write_url_env}`], displayContext: true });
    if (choice === "keep") return { writeUrlEnv: setup.selection!.write_url_env, reviewed: true };
    if (choice !== "change") return undefined;
  }
  const mode = await input.session.chooseOption?.("Select receipt storage for this outcome", [
    { value: "runner_ledger", label: "Runner ledger", detail: setup.receipt_readback.runner_ledger_meaning },
    { value: "source_db", label: "Source database", detail: setup.receipt_readback.source_db_choice_detail },
    { value: "pause", label: "Set up later" },
  ], { initialValue: prior?.receipts.authority ?? "runner_ledger", context, displayContext: true });
  if (mode !== "runner_ledger" && mode !== "source_db") return undefined;
  const writer = await input.session.promptText("Dedicated write connection variable", {
    defaultValue: writerDefault,
    context: [`Enter keeps ${writerDefault}. Enter a variable name, never a URL. This reference is part of this exact review.`] });
  if (writer === undefined) return undefined;
  let receipts: SemanticReceiptMode = { authority: "runner_ledger" };
  if (mode === "source_db") {
    const schema = await input.session.promptText("Source receipt schema", { defaultValue: sourceDefault?.schema ?? "public", context: [`Enter keeps ${sourceDefault?.schema ?? "public"}. This must be in the same source database.`] });
    if (schema === undefined) return undefined;
    const table = await input.session.promptText("Source receipt table", { defaultValue: sourceDefault?.table ?? "synapsor_writeback_receipts", context: [`Enter keeps ${sourceDefault?.table ?? "synapsor_writeback_receipts"}. Do not select a business table.`] });
    if (table === undefined) return undefined;
    receipts = { authority: "source_db", provisioning: "precreated", schema: schema.trim() || sourceDefault?.schema || "public", table: table.trim() || sourceDefault?.table || "synapsor_writeback_receipts" };
  }
  const proposal = { ...input, receipts, writeUrlEnv: writer.trim() || writerDefault };
  const preview = await previewSemanticReceiptSelection(proposal);
  if (preview.action_digest !== setup.action_digest || preview.binding_digest !== setup.binding_digest
    || preview.epoch !== setup.epoch || preview.revision_id !== setup.revision_id) {
    fail("SEMANTIC_RECEIPT_CONFIRMATION_REQUIRED", "The setup context changed while entering receipt values. Reopen setup and review the current exact selection.");
  }
  const confirmed = await input.session.confirm("Save this exact receipt setup selection?", { defaultValue: false, context: [
    ...context, `Outcome: ${preview.outcome}`, `Source: ${preview.source_name}`, `Selected mode: ${JSON.stringify(preview.selection.receipts)}`,
    `Writer reference: ${preview.selection.write_url_env}`, `Review: ${preview.digest}`,
    preview.receipt_readback.storage.requirements,
    "Confirm that this mode satisfies the reviewed receipt requirement. Source-atomic requirements need Source database mode.",
    "This does not satisfy other privacy, identity, source permissions or worker prerequisites. Execution remains unchanged.",
  ] });
  if (!confirmed) return undefined;
  await saveSemanticReceiptSelection({ ...proposal, confirmation: preview.confirmation });
  return { writeUrlEnv: preview.selection.write_url_env, reviewed: true };
}

/** The same metadata selection, explicitly bound to disabled authoring. It is
 * deliberately not promoted to active deployment currency after publication. */
async function inspectDisabledSemanticReceiptSetup(input: SemanticReceiptSetupInput, permit: ProjectAuthorityMutationPermit) {
  const root = await fs.realpath(input.projectRoot), configPath = await fs.realpath(input.configPath);
  if (configPath !== path.join(root, "synapsor.runner.json")) fail("SEMANTIC_RECEIPT_CONFIG_UNRELATED", "Disabled receipt review uses this project's saved Read source configuration.");
  const configText = await fs.readFile(configPath, "utf8");
  const config = resolveRuntimeConfig(JSON.parse(configText) as RuntimeConfig, root);
  const read = await readProjectReadAuthoringHeld(root, permit, input.env);
  if (!read?.selected) fail("SEMANTIC_RECEIPT_REVIEW_UNAVAILABLE", "Select the governed disabled Read and Action before reviewing receipt intent.");
  const candidate = read.selected.progress.candidate, readDigest = explorationBoundaryCandidateDigest(candidate);
  const drafts = await listActionRuleAuthorityDrafts(root);
  const matches = drafts.flatMap(authority => authority.authority.rules.filter(entry =>
    entry.effect_envelope.writeback.mode === "direct_sql" && entry.effect_envelope.writeback.supervised_worker === "allowed"
    && (!input.outcome || entry.rule.outcome === input.outcome)).map(entry => ({ authority, entry })));
  if (matches.length !== 1) fail("SEMANTIC_RECEIPT_OUTCOME_REQUIRED", "Select one exact disabled source-writing outcome with --outcome <name>.");
  const { authority, entry } = matches[0]!;
  if (entry.read_boundary_name !== candidate.pack.name || entry.read_boundary_digest !== readDigest
    || authority.authority.catalog.generation_lock_fingerprint !== candidate.generation_lock_fingerprint
    || entry.verification_boundary.generation_lock_fingerprint !== candidate.generation_lock_fingerprint
    || entry.rule.source !== candidate.source || entry.effect_envelope.source !== candidate.source) {
    fail("SEMANTIC_RECEIPT_DRAFT_STALE", "Revalidate this disabled Action against the exact selected Read before reviewing receipt intent.");
  }
  const source = config.sources?.[candidate.source];
  if (!source || source.engine !== read.selected.draft_lock.engine || source.read_url_env !== read.selected.draft_lock.source_env) {
    fail("SEMANTIC_RECEIPT_SOURCE_MISSING", "Restore the selected Read's exact source binding before receipt review.");
  }
  const requirements = await readSavedExecutionRequirementsHeld({ projectRoot: root, boundaryName: candidate.pack.name, env: input.env }, permit);
  if (!requirements.source_digest) fail("SEMANTIC_RECEIPT_REVIEW_UNAVAILABLE", "Attach and review the current source requirement before selecting disabled receipt intent.");
  const { read_only: _readOnly, write_url_env: _writer, receipts: _receipts, ...readSource } = source;
  const bindingDigest = canonicalJsonDigest({ phase: "disabled_authoring", source: candidate.source, source_binding: readSource,
    action_digest: authority.digest, read_digest: readDigest, policy_source_digest: requirements.source_digest });
  const binding = await openBoundProjectControlPolicies(root, input.env);
  if (!binding) fail("SEMANTIC_RECEIPT_REVIEW_UNAVAILABLE", "The governed policy store is unavailable.");
  try {
    const snapshot = await binding.repository.scopeSnapshot({ deployment_id: binding.deployment_id, scope: { level: "operator" }, kinds: ["management"] });
    if (snapshot.epoch !== read.bindings.epoch || await fs.readFile(configPath, "utf8") !== configText) {
      fail("SEMANTIC_RECEIPT_DRAFT_STALE", "The selected authoring context changed during receipt inspection. Reopen its exact review.");
    }
    const key = keyFor(entry.rule.outcome), revision = snapshot.active.find(record => record.name === key.name);
    const selection = revision ? selectionSchema.parse(revision.content) : undefined;
    if (revision) assertOperatorPolicyRecord(revision, key, canonicalJsonDigest(selection));
    const selectionCurrent = selection?.project_id === binding.project_id && selection.deployment_id === binding.deployment_id
      && selection.outcome === entry.rule.outcome && selection.binding_digest === bindingDigest;
    return { phase: "disabled_authoring" as const, business_resources: authority.authority.catalog.resources.map(r => `${r.schema}.${r.table}`),
      project_root: root, config_path: configPath, config, source_name: candidate.source, source,
      read_draft_digest: canonicalJsonDigest(candidate), action_draft_digest: canonicalJsonDigest(actionRuleModelDraftFromAuthority({
        authority: authority.authority, outcome: entry.rule.outcome, review: authority.reviews.find(r => r.outcome === entry.rule.outcome)!, preserveVerificationFields: true })),
      outcome: entry.rule.outcome, action_digest: authority.digest, binding_digest: bindingDigest,
      requirements, selection, selection_current: selectionCurrent, revision_id: revision?.revision_id ?? null,
      epoch: snapshot.epoch, project_id: binding.project_id, deployment_id: binding.deployment_id,
      receipt_readback: semanticReceiptSetupReadback({ source_name: candidate.source, source, storage: config.storage,
        selection, selection_state: selectionCurrent ? "current" : "stale",
        ...(entry.hard_limit && source.engine === "mysql" ? { support_reason: "hard_limit_engine_unsupported" as const } : {}) }) };
  } finally { await binding.close(); }
}

/** Host-only reader; no selection is inferred from a drafted mode or prose.
 * Missing/stale selections cannot satisfy source-atomic setup prerequisites. */
export async function authoringSemanticReceiptIntent(projectRoot: string, sources: readonly string[], env?: NodeJS.ProcessEnv) {
  const captured = [...sources];
  return withProjectAuthorityMutation(projectRoot, held => receiptIntentHeld(held.projectRoot, captured, held, env));
}
export async function authoringSemanticReceiptIntentHeld(projectRoot: string, sources: readonly string[],
  permit: ProjectAuthorityMutationPermit, env?: NodeJS.ProcessEnv) {
  const captured = [...sources];
  return withHeldProjectAuthorityAccess(projectRoot, permit, held => receiptIntentHeld(held.projectRoot, captured, held, env));
}
async function receiptIntentHeld(projectRoot: string, sources: readonly string[], permit: ProjectAuthorityMutationPermit, env?: NodeJS.ProcessEnv) {
  const binding = await openBoundProjectControlPolicies(projectRoot, env);
  if (!binding) return undefined;
  let names: string[];
  try {
    const snapshot = await binding.repository.scopeSnapshot({ deployment_id: binding.deployment_id, scope: { level: "operator" }, kinds: ["management"] });
    names = snapshot.active.map(r => r.name);
  } finally { await binding.close(); }
  if (!names.some(name => name.startsWith("semantic_receipts_"))) return undefined;
  const drafts = await listActionRuleAuthorityDrafts(projectRoot);
  const outcomes = drafts.flatMap(draft => draft.authority.rules.filter(r => sources.includes(r.rule.source)
    && r.effect_envelope.writeback.mode === "direct_sql" && r.effect_envelope.writeback.supervised_worker === "allowed").map(r => r.rule.outcome));
  if (!outcomes.length || new Set(outcomes).size !== outcomes.length) return undefined;
  if (!outcomes.some(outcome => names.includes(keyFor(outcome).name))) return undefined;
  const setups: Array<Awaited<ReturnType<typeof inspectReceiptSetupHeld>>> = [];
  for (const outcome of outcomes.sort()) setups.push(await inspectReceiptSetupHeld({ projectRoot,
    configPath: path.join(projectRoot, "synapsor.runner.json"), outcome, disabled: true, env }, permit));
  if (!setups.some(s => s?.selection)) return undefined;
  return { phase: "disabled_authoring" as const, verified: false as const,
    status: setups.every(s => s?.selection_current) ? "current" as const : "stale" as const,
    outcomes: setups.map(s => ({ outcome: s!.outcome, source: s!.source_name,
      mode: s!.selection?.receipts.authority ?? null, read_digest: "read_draft_digest" in s! ? s!.read_draft_digest : null,
      action_digest: "action_draft_digest" in s! ? s!.action_draft_digest : null, binding_digest: s!.binding_digest,
      revision_id: s!.revision_id, source_digest: s!.requirements.source_digest,
      selection_current: s!.selection_current })),
    meaning: "Operator-reviewed disabled source/effect-bound intent only. No current execution configuration, provisioning, writer verification, receipt or independent readback. Renew normal deployment selection after publication." };
}
