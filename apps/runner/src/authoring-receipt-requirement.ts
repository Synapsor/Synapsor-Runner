import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { parseOperatorQuestion, type OperatorQuestion, type OperatorQuestionValue } from './authoring-operator-question.js';

type Source = { digest: string; text: string; lines: number };
type Session = { id: string; receipt_requirement_reviews?: ReceiptRequirementReview[] };
type Meaning = Extract<OperatorQuestionValue, { kind: 'receipt_requirement' }>;
export type ReceiptRequirementReview = {
  origin: 'OPERATOR-RECEIPT-REQUIREMENT'; source_session: string; source_digest: string; store_digest: string;
  start: number; end: number; source_excerpt: string; dependencies_digest: string;
  question: OperatorQuestion; requirement: Meaning;
  selection: NonNullable<OperatorQuestion['receipt_selection']> & { origin: 'current_host_configuration'; applicability: 'operator_confirmed' };
  verified: false; previous: string | null; digest: string;
};
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const sha = (v: unknown): v is string => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/u.test(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9-]{36}$/u.test(v);
const invalid = (): never => { throw new Error('RECEIPT_REQUIREMENT_REVIEW_INVALID: Preserve the exact attributed receipt decision; no requirement was inferred.'); };

/** Relevant meaning dependencies only. Approval counts, publication timestamps
 * and whole-review PASS flags cannot supply or invalidate receipt meaning.
 * The enclosing complete policy review retains its full independent key. */
export function receiptRequirementDependencies(draft: unknown): string {
  const d = object(draft), evidence = object(d.runner_evidence), runtime = object(evidence.runtime_contract);
  const configuration = object(runtime.receipt_configuration);
  return canonicalJsonDigest({ source: object(d.read).source ?? null,
    actions: (Array.isArray(d.actions) ? d.actions : []).filter((a: any) => a?.effect?.writeback === 'supervised')
      .map((a: any) => ({ name: a.name, outcome: a.outcome, effect: a.effect,
        scoped_bindings: object(object(evidence.actions)[a.outcome]).scoped_bindings ?? null,
        execution: object(object(evidence.actions)[a.outcome]).execution ?? null })),
    configuration: { status: configuration.status ?? 'absent', modes: configuration.modes ?? [],
      source_receipt_destinations: configuration.source_receipt_destinations ?? [] },
    receipt_contract: runtime.receipts ?? null, reader: runtime.onboarding_reader ?? null });
}
export function receiptRequirementSourceBinding(source: Source, session: string, store: string, start: number, end: number): string {
  return canonicalJsonDigest({ source_session: session, source_digest: source.digest, store_digest: store, start, end,
    source_excerpt: source.text.split(/\r\n|\r|\n/u).slice(start - 1, end).join('\n') });
}
export function assertReceiptRequirementReviews(value: unknown): asserts value is ReceiptRequirementReview[] {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 64) return invalid();
  let previous: string | null = null;
  const questions = new Set<string>();
  for (const r of value) {
    const { digest, ...body } = r ?? {};
    if (Object.keys(r ?? {}).some(k => !['origin', 'source_session', 'source_digest', 'store_digest', 'start', 'end',
      'source_excerpt', 'dependencies_digest', 'question', 'requirement', 'selection', 'verified', 'previous', 'digest'].includes(k))
      || r?.origin !== 'OPERATOR-RECEIPT-REQUIREMENT' || !uuid(r.source_session) || !sha(r.source_digest)
      || !sha(r.store_digest) || !sha(r.dependencies_digest) || !Number.isSafeInteger(r.start) || r.start < 1
      || !Number.isSafeInteger(r.end) || r.end < r.start || typeof r.source_excerpt !== 'string'
      || !r.source_excerpt.trim() || r.source_excerpt.length > 16_000 || r.verified !== false
      || r.previous !== previous || digest !== canonicalJsonDigest(body)) invalid();
    const q = parseOperatorQuestion(r.question);
    if (q.kind !== 'receipt_requirement' || !q.confirmation || q.disposition || q.proposal?.disposition !== 'proposed'
      || !q.raw_answer?.text.trim() || q.proposal.value?.kind !== 'receipt_requirement'
      || canonicalJsonDigest(q.proposal.value) !== canonicalJsonDigest(r.requirement) || questions.has(q.id)
      || canonicalJsonDigest(r.selection) !== canonicalJsonDigest({ ...q.receipt_selection,
        origin: 'current_host_configuration', applicability: 'operator_confirmed' })
      || q.evidence.find(e => e.id === 'receipt-meaning-dependencies')?.digest !== r.dependencies_digest
      || q.evidence.find(e => e.id === 'receipt-source-range')?.digest !== canonicalJsonDigest({
        source_session: r.source_session, source_digest: r.source_digest, store_digest: r.store_digest,
        start: r.start, end: r.end, source_excerpt: r.source_excerpt })) invalid();
    questions.add(q.id); previous = digest;
  }
}
/** Creation is available only after the native question has captured words,
 * mapped this value and recorded the exact default-No decision. */
export function makeReceiptRequirementReview(input: { source: Source; session: Session; store: string;
  start: number; end: number; draft: unknown; question: OperatorQuestion }): ReceiptRequirementReview {
  const d = object(input.draft), configuration = object(object(object(d.runner_evidence).runtime_contract).receipt_configuration);
  const selection = input.question.receipt_selection;
  const outcomes = (Array.isArray(d.actions) ? d.actions : []).filter((a: any) => a?.effect?.writeback === 'supervised').map((a: any) => a.outcome).sort();
  if (input.end > input.source.lines || !selection || selection.source !== object(d.read).source
    || configuration.status !== 'current' || !Array.isArray(configuration.modes) || !configuration.modes.length
    || !configuration.modes.every((m: any) => m.source === selection.source && m.authority === selection.mode)
    || canonicalJsonDigest([...input.question.target.outcomes].sort()) !== canonicalJsonDigest(outcomes)) invalid();
  const body = { origin: 'OPERATOR-RECEIPT-REQUIREMENT' as const, source_session: input.session.id,
    source_digest: input.source.digest, store_digest: input.store, start: input.start, end: input.end,
    source_excerpt: input.source.text.split(/\r\n|\r|\n/u).slice(input.start - 1, input.end).join('\n'),
    dependencies_digest: receiptRequirementDependencies(input.draft), question: structuredClone(input.question),
    requirement: input.question.proposal?.value as Meaning,
    selection: { ...input.question.receipt_selection!, origin: 'current_host_configuration' as const, applicability: 'operator_confirmed' as const },
    verified: false as const,
    previous: input.session.receipt_requirement_reviews?.at(-1)?.digest ?? null };
  const record = { ...body, digest: canonicalJsonDigest(body) };
  assertReceiptRequirementReviews([...(input.session.receipt_requirement_reviews ?? []), record]);
  return record;
}
/** Host projection excludes local actor and raw decision history. The consumer
 * recomputes this projection from the actual saved Source session before use. */
export function receiptRequirementPreparedContext(session: Session, store: string | null) {
  const reviews = session.receipt_requirement_reviews ?? [];
  assertReceiptRequirementReviews(reviews);
  return { source_session: session.id, store_digest: store, review_digests: reviews.map(r => r.digest),
    items: reviews.map(r => ({ digest: r.digest, source_digest: r.source_digest, start: r.start, end: r.end,
      source_excerpt: r.source_excerpt, dependencies_digest: r.dependencies_digest, requirement: r.requirement, selection: r.selection,
      assurance: 'operator_interpretation_only' as const, verified: false as const })) };
}
export function currentReceiptRequirement(source: Source, span: { start: number; end: number }, draft: unknown,
  session?: Session): (Meaning & { mode: 'runner_ledger' | 'source_db' }) | undefined {
  const prepared = object(object(draft).runner_evidence).receipt_requirement;
  if (!session || !prepared || !sha(prepared.store_digest)
    || canonicalJsonDigest(prepared) !== canonicalJsonDigest(receiptRequirementPreparedContext(session, prepared.store_digest))) return undefined;
  const latest = (session.receipt_requirement_reviews ?? []).filter(r => r.source_session === session.id
    && r.source_digest === source.digest && r.store_digest === prepared.store_digest && r.start === span.start && r.end === span.end
    && r.end <= source.lines && r.source_excerpt === source.text.split(/\r\n|\r|\n/u).slice(r.start - 1, r.end).join('\n')).at(-1);
  return latest?.dependencies_digest === receiptRequirementDependencies(draft)
    ? { ...latest.requirement, mode: latest.selection.mode } : undefined;
}
