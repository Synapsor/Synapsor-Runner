import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { activePolicySource, PolicySourceChangedError, savePolicySources, type PolicySourceSession } from './authoring-policy-source.js';
import { makeReceiptRequirementReview, receiptRequirementDependencies, receiptRequirementSourceBinding } from './authoring-receipt-requirement.js';
import type { OperatorQuestion } from './authoring-operator-question.js';
import type { ProjectAuthorityMutationPermit } from './project-authority-mutation.js';

/** An adapter around the existing business-statement host, not another question
 * producer. The actual native question is saved before its Source projection;
 * a partial cross-file save remains inspectable and cannot originate consent. */
export function receiptRequirementCheckpoint(input: {
  projectRoot: string; sources: PolicySourceSession; store: string; start: number; end: number;
  currentDraft(): unknown; questions(): readonly OperatorQuestion[];
  assertCurrent(permit?: ProjectAuthorityMutationPermit): Promise<void>;
  acknowledge(permit: ProjectAuthorityMutationPermit): Promise<void>;
}) {
  const source = activePolicySource(input.sources);
  if (!source) throw new PolicySourceChangedError();
  const sourceBinding = receiptRequirementSourceBinding(source, input.sources.id, input.store, input.start, input.end);
  const dependencies = receiptRequirementDependencies(input.currentDraft());
  const current = () => input.questions().filter(q => q.kind === 'receipt_requirement'
    && q.evidence.find(e => e.id === 'receipt-source-range')?.digest === sourceBinding
    && q.receipt_selection?.dependencies_digest === dependencies).at(-1);
  return {
    current,
    async saved(permit: ProjectAuthorityMutationPermit) {
      await input.assertCurrent(permit);
      if (receiptRequirementDependencies(input.currentDraft()) !== dependencies) throw new PolicySourceChangedError();
      const q = current();
      if (!q) return; // The existing host saves its handoff before the question.
      const previous = input.sources.receipt_requirement_reviews?.filter(r => r.question.id === q.id).at(-1);
      // Reserve a durable pending target once. Later budget/raw checkpoints stay
      // in Resume; only a real disposition or confirmation adds a decision.
      if (previous?.question.digest === q.digest || previous && !q.disposition && !q.confirmation && !q.terminal_failure) return;
      const review = makeReceiptRequirementReview({ source, session: input.sources, store: input.store,
        start: input.start, end: input.end, draft: input.currentDraft(), question: q });
      const staged = { ...input.sources, receipt_requirement_reviews: [...(input.sources.receipt_requirement_reviews ?? []), review] };
      await savePolicySources(input.projectRoot, staged, { permit, expectedDigest: canonicalJsonDigest(input.sources) });
      Object.assign(input.sources, staged);
      await input.acknowledge(permit);
    },
  };
}
