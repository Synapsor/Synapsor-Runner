import { canonicalJsonDigest } from '@synapsor-runner/protocol';

// Structural inputs keep this independent of the source-session persistence
// module, which imports the validator below when reading saved records.
type SourceSnapshot = { digest: string; lines: number; text: string };
type SourceSession = { id: string; source_transaction_reviews?: SourceTransactionReview[] };

/** An attributed interpretation of one complete saved source, never a compiled
 * capability, an observed receipt, or a provider-supplied policy decision. */
export type SourceTransactionReview = {
  origin: 'OPERATOR-SOURCE-TRANSACTION-REVIEW';
  id: string; source_session: string; source_digest: string; store_digest: string;
  start: number; end: number; source_excerpt: string;
  action: { name: string; outcome: string; source: string };
  required_effects: Array<{ role: 'primary' | 'companion'; resource: string; binding: string;
    operation: 'update'; fields: string[]; assignment_digest: string }>;
  required_receipt: { source: string; mode: 'source_db'; purpose: 'writeback_receipt_for_outcome' };
  relation: 'same_source_transaction';
  decision: 'pending' | 'confirmed' | 'deferred' | 'conflicting';
  actor: string; actor_source: 'local_interactive_operator'; reviewed_at: string; verified: false;
  previous: string | null; digest: string;
};

type Mapping = Pick<SourceTransactionReview, 'action' | 'required_effects' | 'required_receipt' | 'relation'>;
type Prepared = { source_session: string; store_digest: string | null; review_digests: string[];
  items: Array<{id:string;digest:string;source_digest:string;source_range:{start:number;end:number};
    action:SourceTransactionReview['action'];required_effects:SourceTransactionReview['required_effects'];
    required_receipt:SourceTransactionReview['required_receipt'];relation:'same_source_transaction';
    decision:SourceTransactionReview['decision'];assurance:'operator_interpretation_only';verified:false}> };
const sha = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

export function sourceTransactionContext(draft: unknown): Prepared | undefined {
  const value = object(object(draft).runner_evidence).source_transaction_requirement;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Prepared;
}

/** The model sees the scoped interpretation and digest, never the attributed
 * local actor or saved decision history. The full record stays in the store. */
export function sourceTransactionPreparedContext(session: SourceSession,
  storeDigest:string|null,currentSourceDigest?:string): Prepared {
  const reviews=session.source_transaction_reviews??[];
  assertSourceTransactionReviews(reviews);
  const latest=[...new Map(reviews.map(record=>[record.id,record])).values()]
    .filter(record=>record.source_digest===currentSourceDigest&&record.store_digest===storeDigest);
  return {source_session:session.id,store_digest:storeDigest,review_digests:reviews.map(record=>record.digest),
    items:latest.map(record=>({id:record.id,digest:record.digest,source_digest:record.source_digest,
      source_range:{start:record.start,end:record.end},action:record.action,required_effects:record.required_effects,
      required_receipt:record.required_receipt,relation:record.relation,decision:record.decision,
      assurance:'operator_interpretation_only' as const,verified:false as const}))};
}

/** A candidate for an operator to interpret, not a source requirement. In
 * particular, source_db mode and effect count never return `confirmed`. */
export function sourceTransactionMappings(draft: unknown): Mapping[] {
  const value = object(draft), read = object(value.read), configuration = object(object(object(value.runner_evidence).runtime_contract).receipt_configuration);
  const modes = Array.isArray(configuration.modes) ? configuration.modes : [];
  const intent = object(configuration.reviewed_intent);
  const sourceDb = modes.some((mode: any) => mode?.authority === 'source_db' && mode.source === read.source)
    || Array.isArray(intent.outcomes) && intent.outcomes.some((entry: any) => entry?.mode === 'source_db' && entry.source === read.source);
  if (!sourceDb || !Array.isArray(value.actions)) return [];
  return value.actions.flatMap((action: any) => {
    const effect = object(action?.effect);
    if (effect.writeback !== 'supervised' || typeof action?.outcome !== 'string' || typeof action?.name !== 'string'
      || !Array.isArray(effect.atomic_updates) || !effect.atomic_updates.length || effect.atomic_updates.length > 3) return [];
    const effects = [effect, ...effect.atomic_updates].map((entry: any, index: number) => ({
      role: index === 0 ? 'primary' as const : 'companion' as const,
      resource: entry?.target_resource, binding: entry?.target_binding, operation: entry?.operation,
      fields: entry?.allowed_fields?.map((field: any) => field?.name),
      assignment_digest: entry?.set && typeof entry.set === 'object' && !Array.isArray(entry.set)
        && Object.keys(entry.set).length ? canonicalJsonDigest(entry.set) : undefined,
    }));
    if (effects.some(entry => typeof entry.resource !== 'string' || !entry.resource
      || typeof entry.binding !== 'string' || !entry.binding || entry.operation !== 'update'
      || typeof entry.assignment_digest !== 'string'
      || !Array.isArray(entry.fields) || !entry.fields.length || entry.fields.some(field => typeof field !== 'string' || !field)
      || new Set(entry.fields).size !== entry.fields.length)) return [];
    return [{ action: { name: action.name, outcome: action.outcome, source: read.source },
      required_effects: effects as Mapping['required_effects'],
      required_receipt: { source: read.source, mode: 'source_db' as const, purpose: 'writeback_receipt_for_outcome' as const },
      relation: 'same_source_transaction' as const }];
  });
}

/** Candidate gate for the supported multi-effect source_db family. An existing
 * reviewed record is checked separately even if a later candidate loses its
 * companion; a new single-effect policy is not assigned this requirement. */
export function sourceTransactionReviewNeeded(draft: unknown): boolean {
  const value=object(draft), read=object(value.read);
  const configuration=object(object(object(value.runner_evidence).runtime_contract).receipt_configuration);
  const modes=Array.isArray(configuration.modes)?configuration.modes:[];
  const intent=object(configuration.reviewed_intent);
  return Array.isArray(value.actions) && value.actions.some((action:any)=>action?.effect?.writeback==='supervised'
      && Array.isArray(action.effect.atomic_updates)&&action.effect.atomic_updates.length>0)
    && (modes.some((mode:any)=>mode?.authority==='source_db'&&mode.source===read.source)
      || Array.isArray(intent.outcomes)&&intent.outcomes.some((entry:any)=>entry?.mode==='source_db'&&entry.source===read.source));
}

export function sourceTransactionReviewIdentity(record: Pick<SourceTransactionReview,
  'source_session' | 'source_digest' | 'store_digest' | 'action'>): string {
  return canonicalJsonDigest({ source_session: record.source_session, source_digest: record.source_digest,
    store_digest: record.store_digest, action: record.action });
}

export function validSourceTransactionReview(record: SourceTransactionReview): boolean {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const { digest, ...body } = record;
  return record.origin === 'OPERATOR-SOURCE-TRANSACTION-REVIEW' && sha(record.id) && sha(record.source_digest)
    && sha(record.store_digest) && /^[a-f0-9-]{36}$/u.test(record.source_session)
    && Number.isInteger(record.start) && record.start >= 1 && Number.isInteger(record.end) && record.end >= record.start
    && typeof record.source_excerpt === 'string' && record.source_excerpt.length > 0 && record.source_excerpt.length <= 16_000
    && typeof record.action?.name === 'string' && record.action.name.length > 0 && record.action.name.length <= 256
    && typeof record.action?.outcome === 'string' && record.action.outcome.length > 0 && record.action.outcome.length <= 256
    && typeof record.action?.source === 'string' && record.action.source.length > 0 && record.action.source.length <= 256
    && Array.isArray(record.required_effects) && record.required_effects.length >= 2 && record.required_effects.length <= 4
    && record.required_effects.every((effect, index) => effect?.role === (index ? 'companion' : 'primary')
      && typeof effect.resource === 'string' && effect.resource.length > 0 && effect.resource.length <= 256
      && typeof effect.binding === 'string' && effect.binding.length > 0 && effect.binding.length <= 256
      && effect.operation === 'update' && Array.isArray(effect.fields) && effect.fields.length > 0 && effect.fields.length <= 32
      && sha(effect.assignment_digest)
      && effect.fields.every(field => typeof field === 'string' && field.length > 0 && field.length <= 256)
      && new Set(effect.fields).size === effect.fields.length)
    && record.required_receipt?.mode === 'source_db'
    && record.required_receipt.source === record.action.source
    && record.required_receipt.purpose === 'writeback_receipt_for_outcome'
    && record.relation === 'same_source_transaction'
    && ['pending', 'confirmed', 'deferred', 'conflicting'].includes(record.decision)
    && typeof record.actor === 'string' && record.actor.length > 0 && record.actor.length <= 128
    && record.actor_source === 'local_interactive_operator'
    && typeof record.reviewed_at === 'string' && Number.isFinite(Date.parse(record.reviewed_at))
    && record.verified === false && (record.previous === null || sha(record.previous))
    && record.id === sourceTransactionReviewIdentity(record) && digest === canonicalJsonDigest(body);
}

export function assertSourceTransactionReviews(value: unknown): asserts value is SourceTransactionReview[] {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 64) throw new Error('SOURCE_TRANSACTION_REVIEW_INVALID: Saved source interpretation remains pending.');
  const latest = new Map<string, string>();
  for (const entry of value) {
    if (!validSourceTransactionReview(entry) || entry.previous !== (latest.get(entry.id) ?? null))
      throw new Error('SOURCE_TRANSACTION_REVIEW_INVALID: Saved source interpretation lineage is invalid; no affirmative meaning was recovered.');
    latest.set(entry.id, entry.digest);
  }
}

export function currentSourceTransactionReview(source: SourceSnapshot, draft: unknown,
  session?: SourceSession): SourceTransactionReview | undefined {
  const prepared = sourceTransactionContext(draft), reviews = session?.source_transaction_reviews;
  assertSourceTransactionReviews(reviews);
  if (!prepared || !session || prepared.source_session !== session.id || !sha(prepared.store_digest)
    || canonicalJsonDigest(prepared) !== canonicalJsonDigest(sourceTransactionPreparedContext(session,prepared.store_digest,source.digest))) return undefined;
  const value=object(draft),read=object(value.read);
  const actions=Array.isArray(value.actions)?value.actions:[];
  const sameAction=(record:SourceTransactionReview)=>read.source===record.action.source
    && actions.some((action:any)=>action?.name===record.action.name&&action?.outcome===record.action.outcome);
  if ((reviews??[]).some(record=>record.source_digest===source.digest&&record.source_session===session.id
    && record.store_digest===prepared.store_digest&&sameAction(record)&&record.decision==='conflicting')) return undefined;
  const latest = new Map((reviews ?? []).map(record => [record.id, record]));
  if ([...latest.values()].some(record=>record.source_digest===source.digest&&record.source_session===session.id
    && record.store_digest===prepared.store_digest&&sameAction(record)
    && record.decision!=='confirmed')) return undefined;
  const matches = [...latest.values()].filter(record => record.decision === 'confirmed'
    && record.source_digest === source.digest && record.source_session === session.id
    && record.store_digest === prepared.store_digest && record.end <= source.lines
    && record.source_excerpt === source.text.split(/\r\n|\r|\n/u).slice(record.start - 1, record.end).join('\n')
    && sameAction(record));
  if (matches.length > 1) throw new Error('SOURCE_TRANSACTION_REVIEW_AMBIGUOUS: Multiple current source interpretations overlap this Action. Review them locally.');
  return matches[0];
}

export function makeSourceTransactionReview(input: { source: SourceSnapshot; session: string; store: string;
  start: number; end: number; mapping: Mapping; actor: string; decision: SourceTransactionReview['decision'];
  previous?: SourceTransactionReview }): SourceTransactionReview {
  const excerpt = input.source.text.split(/\r\n|\r|\n/u).slice(input.start - 1, input.end).join('\n');
  const base = { origin: 'OPERATOR-SOURCE-TRANSACTION-REVIEW' as const, source_session: input.session,
    source_digest: input.source.digest, store_digest: input.store, start: input.start, end: input.end,
    source_excerpt: excerpt, ...input.mapping, decision: input.decision, actor: input.actor,
    actor_source: 'local_interactive_operator' as const, reviewed_at: new Date().toISOString(), verified: false as const };
  const id = sourceTransactionReviewIdentity(base);
  const body = { ...base, id, previous: input.previous?.digest ?? null };
  const record = { ...body, digest: canonicalJsonDigest(body) };
  if (!validSourceTransactionReview(record)) throw new Error('SOURCE_TRANSACTION_REVIEW_INVALID: No interpretation was saved.');
  return record;
}
