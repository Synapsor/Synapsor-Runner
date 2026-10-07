import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { assertOperatorQuestionsAdvance, parseOperatorQuestion, type OperatorQuestion, type OperatorQuestionValue } from './authoring-operator-question.js';

type Source = { digest: string; text: string; lines: number };
type Session = { id: string; receipt_requirement_reviews?: ReceiptRequirementReview[] };
type Episode = { context: string; submissions: Array<{ completed_at?: string; validated?: boolean; diagnostic?: string;
  tentative?: { status: string; context: string; raw_response: unknown; assembled?: unknown } }> };
type Meaning = Extract<OperatorQuestionValue, { kind: 'receipt_requirement' }>;
export type ReceiptRequirementReview = {
  origin: 'OPERATOR-RECEIPT-REQUIREMENT'; source_session: string; source_digest: string; store_digest: string;
  start: number; end: number; source_excerpt: string; dependencies_digest: string;
  question: OperatorQuestion; decision: 'confirmed' | 'pending'; requirement?: Meaning;
  selection: NonNullable<OperatorQuestion['receipt_selection']> & { origin: 'current_host_configuration'; applicability: 'operator_confirmed' | 'pending' };
  verified: false; previous: string | null; digest: string;
};
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const sha = (v: unknown): v is string => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/u.test(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9-]{36}$/u.test(v);
const invalid = (): never => { throw new Error('RECEIPT_REQUIREMENT_REVIEW_INVALID: Preserve the exact attributed receipt decision; no requirement was inferred.'); };

/** Relevant meaning dependencies only. Approval counts, publication timestamps
 * and whole-review PASS flags cannot supply or invalidate receipt meaning.
 * The enclosing complete policy review retains its full independent key. */
export function receiptRequirementDependencies(draft: unknown): `sha256:${string}` {
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
export function receiptRequirementSourceBinding(source: Source, session: string, store: string, start: number, end: number): `sha256:${string}` {
  return canonicalJsonDigest({ source_session: session, source_digest: source.digest, store_digest: store, start, end,
    source_excerpt: source.text.split(/\r\n|\r|\n/u).slice(start - 1, end).join('\n') });
}
export function receiptRequirementQuestionTarget(q: OperatorQuestion, source: Source, session: string, store: string):
  { start: number; end: number; source_excerpt: string } | undefined {
  const range = /^lines:(\d+)-(\d+)$/u.exec(q.target.field ?? '');
  if (q.kind !== 'receipt_requirement' || q.target.resource !== source.digest || !range) return undefined;
  const start = Number(range[1]), end = Number(range[2]);
  if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start || end > source.lines
    || q.evidence.find(e => e.id === 'receipt-source-range')?.digest !== receiptRequirementSourceBinding(source, session, store, start, end)) return undefined;
  return { start, end, source_excerpt: source.text.split(/\r\n|\r|\n/u).slice(start - 1, end).join('\n') };
}
/** Nominate only a saved host refusal on an exact unaccepted receipt component.
 * Its range is a question target, never an accepted model policy interpretation. */
export function receiptRequirementReviewTarget(source: Source, episodes: readonly Episode[], context: string | undefined):
  { start: number; end: number; source_excerpt: string } | undefined {
  const episode = episodes.filter(e => e.context === context).at(-1), submission = episode?.submissions.at(-1);
  if (!submission?.completed_at || submission.validated !== false || submission.tentative?.status !== 'unaccepted_generation'
    || submission.tentative.context !== context || !submission.diagnostic) return undefined;
  let feedback: any;
  try { const saved = JSON.parse(submission.diagnostic); feedback = saved.final_refusal ?? saved; } catch { return undefined; }
  const body = object(submission.tentative.assembled ?? submission.tentative.raw_response);
  if (!Array.isArray(feedback.findings) || !Array.isArray(body.passages)) return undefined;
  const targets = feedback.findings.filter((f: any) => f.typed_reason === 'receipt_configuration.source_requirement_unestablished')
    .flatMap((f: any) => {
      const match = /^\/passages\/(\d+)(?:\/|$)/u.exec(f.component ?? '');
      const p = match ? body.passages[Number(match[1])] : undefined;
      if (!p || !Number.isSafeInteger(p.start) || p.start < 1 || !Number.isSafeInteger(p.end) || p.end < p.start || p.end > source.lines
        || p.disposition !== 'implemented' || p.responsibility !== 'runner' || !Array.isArray(p.draft_paths)
        || !p.draft_paths.includes('/runner_evidence/runtime_contract/receipt_configuration')) return [];
      const source_excerpt = source.text.split(/\r\n|\r|\n/u).slice(p.start - 1, p.end).join('\n');
      return source_excerpt.trim() && source_excerpt.length <= 16_000 ? [{ start: p.start, end: p.end, source_excerpt }] : [];
    });
  const unique = [...new Map(targets.map((t: any) => [canonicalJsonDigest(t), t])).values()];
  return unique.length === 1 ? unique[0] as { start: number; end: number; source_excerpt: string } : undefined;
}
export function receiptRequirementQuestionContext<T extends Session>(session: T) {
  const { receipt_requirement_reviews: _history, ...source } = session;
  return source;
}
export function assertReceiptRequirementReviews(value: unknown): asserts value is ReceiptRequirementReview[] {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 64) return invalid();
  let previous: string | null = null;
  const questions = new Map<string, OperatorQuestion>();
  for (const r of value) {
    const { digest, ...body } = r ?? {};
    if (Object.keys(r ?? {}).some(k => !['origin', 'source_session', 'source_digest', 'store_digest', 'start', 'end',
      'source_excerpt', 'dependencies_digest', 'question', 'decision', 'requirement', 'selection', 'verified', 'previous', 'digest'].includes(k))
      || r?.origin !== 'OPERATOR-RECEIPT-REQUIREMENT' || !uuid(r.source_session) || !sha(r.source_digest)
      || !sha(r.store_digest) || !sha(r.dependencies_digest) || !Number.isSafeInteger(r.start) || r.start < 1
      || !Number.isSafeInteger(r.end) || r.end < r.start || typeof r.source_excerpt !== 'string'
      || !r.source_excerpt.trim() || r.source_excerpt.length > 16_000 || r.verified !== false
      || r.previous !== previous || digest !== canonicalJsonDigest(body)) invalid();
    const q = parseOperatorQuestion(r.question);
    const evidence = q.evidence.filter(e => ['receipt-source-range', 'receipt-meaning-dependencies'].includes(e.id));
    if (q.kind !== 'receipt_requirement' || !['confirmed', 'pending'].includes(r.decision)
      || r.decision === 'confirmed' && (!q.confirmation || q.disposition || q.proposal?.disposition !== 'proposed'
        || !q.raw_answer?.text.trim() || q.proposal.value?.kind !== 'receipt_requirement'
        || canonicalJsonDigest(q.proposal.value) !== canonicalJsonDigest(r.requirement))
      || r.decision === 'pending' && (q.confirmation || r.requirement !== undefined || !q.presentation)
      || canonicalJsonDigest(r.selection) !== canonicalJsonDigest({ ...q.receipt_selection,
        origin: 'current_host_configuration', applicability: r.decision === 'confirmed' ? 'operator_confirmed' : 'pending' })
      || evidence.length !== 2 || new Set(evidence.map(e => e.id)).size !== 2
      || q.receipt_selection?.dependencies_digest !== r.dependencies_digest
      || q.target.resource !== r.source_digest || q.target.field !== `lines:${r.start}-${r.end}`
      || q.evidence.find(e => e.id === 'receipt-meaning-dependencies')?.digest !== r.dependencies_digest
      || q.evidence.find(e => e.id === 'receipt-source-range')?.digest !== canonicalJsonDigest({
        source_session: r.source_session, source_digest: r.source_digest, store_digest: r.store_digest,
        start: r.start, end: r.end, source_excerpt: r.source_excerpt })) invalid();
    const prior = questions.get(q.id);
    if (prior) assertOperatorQuestionsAdvance([prior], [q]);
    questions.set(q.id, q); previous = digest;
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
    decision: input.question.confirmation ? 'confirmed' as const : 'pending' as const,
    ...(input.question.confirmation ? { requirement: input.question.proposal!.value as Meaning } : {}),
    selection: { ...input.question.receipt_selection!, origin: 'current_host_configuration' as const,
      applicability: input.question.confirmation ? 'operator_confirmed' as const : 'pending' as const },
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
      source_excerpt: r.source_excerpt, dependencies_digest: r.dependencies_digest, decision: r.decision,
      requirement: r.requirement ?? null, selection: r.selection,
      assurance: 'operator_interpretation_only' as const, verified: false as const })) };
}
function currentSourceReceiptReviews(source: Source, draft: unknown, session?: Session): ReceiptRequirementReview[] {
  const prepared = object(object(draft).runner_evidence).receipt_requirement;
  if (!session || !prepared || !sha(prepared.store_digest)
    || canonicalJsonDigest(prepared) !== canonicalJsonDigest(receiptRequirementPreparedContext(session, prepared.store_digest))) return [];
  return (session.receipt_requirement_reviews ?? []).filter(r => r.source_session === session.id
    && r.source_digest === source.digest && r.store_digest === prepared.store_digest && r.end <= source.lines
    && r.source_excerpt === source.text.split(/\r\n|\r|\n/u).slice(r.start - 1, r.end).join('\n'));
}
/** A saved pending decision is its own durable barrier. Its projection changes
 * the full review key; the old failed coverage episode need not share that key. */
export function pendingReceiptRequirement(source: Source, draft: unknown, session?: Session): ReceiptRequirementReview | undefined {
  const latest = new Map<string, ReceiptRequirementReview>();
  for (const review of currentSourceReceiptReviews(source,draft,session)) latest.set(`${review.start}:${review.end}`,review);
  return [...latest.values()].find(review => review.decision === 'pending'
    && review.dependencies_digest === receiptRequirementDependencies(draft));
}
export function currentReceiptRequirement(source: Source, span: { start: number; end: number }, draft: unknown,
  session?: Session): (Meaning & { mode: 'runner_ledger' | 'source_db'; decision_digest: string }) | undefined {
  const latest = currentSourceReceiptReviews(source,draft,session).filter(r => r.start === span.start && r.end === span.end).at(-1);
  return latest?.decision === 'confirmed' && latest.requirement && latest.dependencies_digest === receiptRequirementDependencies(draft)
    ? { ...latest.requirement, mode: latest.selection.mode, decision_digest: latest.digest } : undefined;
}
