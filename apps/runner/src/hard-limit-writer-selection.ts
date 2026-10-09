import path from 'node:path';
import { withProjectAuthorityMutation, withHeldProjectAuthorityAccess, type ProjectAuthorityMutationPermit } from './project-authority-mutation.js';
import { deriveReviewedSharedSumProtection, resolveReviewedSharedSumProtection, type RuntimeActionRuleRegistryV1 } from '@synapsor-runner/action-rules';
import type { RuntimeConfig } from '@synapsor-runner/mcp-server';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { inspectSemanticReceiptSetupHeld, selectedSemanticReceipts } from './semantic-receipt-setup.js';
import { HardLimitWriterSetupError } from './hard-limit-writer-setup.js';

/** Existing separately reviewed disabled setup selects a credential reference,
 * never readiness or execution authority. Its native binding must still match
 * the exact authority being published. No default writer is inferred. */
export type HardLimitActivationWriterSelectionInput = {
  projectRoot: string; config: RuntimeConfig; registry: RuntimeActionRuleRegistryV1;
  authorityDigest: string; env?: NodeJS.ProcessEnv;
};
export async function projectHardLimitActivationWriterSelections(input: HardLimitActivationWriterSelectionInput): Promise<RuntimeConfig> {
  const captured = structuredClone(input);
  return withProjectAuthorityMutation(input.projectRoot, held => writerSelectionsHeld(captured, held));
}
export async function projectHardLimitActivationWriterSelectionsHeld(input: HardLimitActivationWriterSelectionInput,
  permit: ProjectAuthorityMutationPermit): Promise<RuntimeConfig> {
  const captured = structuredClone(input);
  return withHeldProjectAuthorityAccess(input.projectRoot, permit, held => writerSelectionsHeld(captured, held));
}
async function writerSelectionsHeld(input: HardLimitActivationWriterSelectionInput, permit: ProjectAuthorityMutationPermit): Promise<RuntimeConfig> {
  const shared = deriveReviewedSharedSumProtection(input.registry);
  const config = structuredClone(input.config);
  const required = new Map<string, number>();
  const selectedCounts = new Map<string, number>();
  const selected = new Map<string, { writer: string; receipts: NonNullable<RuntimeConfig['sources']>[string]['receipts'] }>();
  for (const { compiled } of input.registry.rules) {
    if (!compiled.hard_limit && !(shared && resolveReviewedSharedSumProtection(shared, input.registry, compiled))) continue;
    const source = input.config.sources?.[compiled.source];
    // Current genuine execution/source bindings retain precedence. A disabled
    // setup record cannot silently rebind an already selected writer.
    if (!source || source.engine !== 'postgres' || (source.read_only !== true && source.write_url_env)) continue;
    required.set(compiled.source, (required.get(compiled.source) ?? 0) + 1);
    let setup;
    try {
      setup = await inspectSemanticReceiptSetupHeld({ projectRoot: input.projectRoot,
        configPath: path.join(path.resolve(input.projectRoot), 'synapsor.runner.json'), outcome: compiled.outcome, disabled: true, env: input.env }, permit);
    } catch (error) {
      if (['SEMANTIC_RECEIPT_REVIEW_UNAVAILABLE', 'SEMANTIC_RECEIPT_DRAFT_STALE', 'SEMANTIC_RECEIPT_SOURCE_MISSING', 'SEMANTIC_RECEIPT_OUTCOME_REQUIRED'].includes(String((error as { code?: unknown }).code))) continue;
      throw error;
    }
    if (!setup || setup.phase !== 'disabled_authoring' || !setup.selection_current || !setup.selection
      || setup.action_digest !== input.authorityDigest || setup.outcome !== compiled.outcome || setup.source_name !== compiled.source) continue;
    // The disabled record was inspected against the saved Read source, which
    // must also be the source of this candidate. Scope binding may add the
    // reviewed principal setting later; this projection precedes that step.
    const { read_only: _candidateReadOnly, write_url_env: _candidateWriter, receipts: _candidateReceipts, ...candidateSource } = source;
    const { read_only: _savedReadOnly, write_url_env: _savedWriter, receipts: _savedReceipts, ...savedSource } = setup.source;
    if (canonicalJsonDigest(candidateSource) !== canonicalJsonDigest(savedSource)) continue;
    const value = { writer: setup.selection.write_url_env, receipts: selectedSemanticReceipts(setup, setup.selection.write_url_env) };
    const prior = selected.get(compiled.source);
    if (prior && canonicalJsonDigest(prior) !== canonicalJsonDigest(value)) throw new HardLimitWriterSetupError({ status: 'refused', requirements: [], checks: [{ source: compiled.source, outcome: compiled.outcome, status: 'refused', reason_code: 'writer_selection_ambiguous' }] });
    selected.set(compiled.source, value);
    selectedCounts.set(compiled.source, (selectedCounts.get(compiled.source) ?? 0) + 1);
  }
  for (const [name, value] of selected) {
    if (selectedCounts.get(name) !== required.get(name)) continue;
    config.sources![name] = { ...config.sources![name]!, read_only: false, write_url_env: value.writer, receipts: value.receipts };
  }
  return config;
}
