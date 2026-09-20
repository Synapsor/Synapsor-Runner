import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { resolveRuntimeConfig, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import type { ControlPolicyKey } from "@synapsor-runner/proposal-store";
import { createActiveActionRuleAuthorityLoader } from "./action-rule-authority.js";
import { openBoundProjectControlPolicies, commitImmutableControlPolicies } from "./control-policy-store.js";
import { assertOperatorPolicyRecord, storedOperatorPolicyRecord } from "./control-policy-record.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";
import { readSavedExecutionRequirements } from "./saved-action-job-review.js";

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
export async function inspectSemanticReceiptSetup(input: {
  projectRoot: string; configPath: string; outcome?: string; env?: NodeJS.ProcessEnv;
}) {
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
    const requirements = await readSavedExecutionRequirements({ projectRoot: root, boundaryName: rule.read_boundary_name, env: input.env });
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
    return { project_root: root, config_path: configPath, config, source_name: rule.compiled.source, source,
      outcome: rule.compiled.outcome, action_digest: active.authority.action_boundary.digest,
      binding_digest: bindingDigest, requirements, selection, selection_current: selectionCurrent,
      revision_id: revision?.revision_id ?? null, epoch: snapshot?.epoch,
      project_id: binding?.project_id, deployment_id: binding?.deployment_id };
  } finally { await binding?.close(); }
}

export async function previewSemanticReceiptSelection(input: Parameters<typeof inspectSemanticReceiptSetup>[0] & {
  receipts: SemanticReceiptMode; writeUrlEnv: string;
}) {
  const setup = await inspectSemanticReceiptSetup(input);
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
    const activeBinding = await openBoundProjectControlPolicies(setup.project_root, input.env);
    try {
      const active = await createActiveActionRuleAuthorityLoader(setup.project_root, activeBinding)({ dependency_check: "report" });
      if (active.authority.catalog.resources.some(resource => `${resource.schema}.${resource.table}` === relation)) {
        fail("SEMANTIC_RECEIPT_RELATION_CONFLICT", "Use a dedicated receipt relation, not a reviewed business resource.");
      }
    } finally { await activeBinding?.close(); }
  }
  if (selection.write_url_env === setup.source.read_url_env) fail("SEMANTIC_RECEIPT_WRITER_REQUIRED", "Select a dedicated write environment reference, keeping the reader unchanged.");
  const digest = canonicalJsonDigest({ selection, config_path: setup.config_path, epoch: setup.epoch,
    previous_revision: setup.revision_id, action_digest: setup.action_digest });
  return { ...setup, selection, digest, confirmation: `SAVE RECEIPT SETUP ${digest}` };
}

export async function saveSemanticReceiptSelection(input: Parameters<typeof previewSemanticReceiptSelection>[0] & { confirmation: string }) {
  // Freeze the exact reviewed data before waiting for the authority gate. UI
  // sessions and inspection callbacks are not selection data or persisted state.
  const frozen = structuredClone({ projectRoot: input.projectRoot, configPath: input.configPath,
    outcome: input.outcome, env: input.env, receipts: input.receipts,
    writeUrlEnv: input.writeUrlEnv, confirmation: input.confirmation });
  return withProjectAuthorityMutation(input.projectRoot, async held => {
    const preview = await previewSemanticReceiptSelection({ ...frozen, projectRoot: held.projectRoot });
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
  });
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
    "Runner ledger records evidence outside the source transaction. Source database mode requires a precreated receipt relation in the same database transaction as the guarded effects.",
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
    { value: "runner_ledger", label: "Runner ledger", detail: "Receipt evidence in Runner; not atomic with the source transaction." },
    { value: "source_db", label: "Source database", detail: "Precreated receipt in the same source transaction; separate administrator provisioning required." },
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
    "Confirm that this mode satisfies the reviewed receipt requirement. Source-atomic requirements need Source database mode.",
    "This does not satisfy other privacy, identity, source permissions or worker prerequisites. Execution remains unchanged.",
  ] });
  if (!confirmed) return undefined;
  await saveSemanticReceiptSelection({ ...proposal, confirmation: preview.confirmation });
  return { writeUrlEnv: preview.selection.write_url_env, reviewed: true };
}
