import process from 'node:process';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { resolveSemanticSupervisedWriterSource } from '@synapsor-runner/mcp-server';
import type { ActionRuleAuthorityDraftV1 } from './action-rule-authority.js';
import { inspectHardLimitWriterSetup, HardLimitWriterSetupError,
  type HardLimitWriterSetupInput, type HardLimitWriterSetupReadback,
  type HardLimitWriterNativeAssessment } from './hard-limit-writer-setup.js';

declare const writerReviewBrand: unique symbol;
/** An ephemeral host-issued readback identity, never persisted authority. */
export type HardLimitWriterReviewBinding = Readonly<{ [writerReviewBrand]: true }>;
export type HardLimitWriterReviewContext = {
  projectRoot: string;
  sourceConfigPath: string;
  outputConfigPath: string;
  sourceConfigText: string;
  previousConfigText?: string;
  draft: Pick<ActionRuleAuthorityDraftV1, 'digest'>;
  executionReview: { digest: string; epoch?: number };
  nativePolicy?: { project_id: string; deployment_id: string; epoch: number };
};
type ReviewInput = HardLimitWriterSetupInput & { reviewContext: HardLimitWriterReviewContext };
type SealedReview = { candidate: string; assessment: string };
const reviews = new WeakMap<HardLimitWriterReviewBinding, SealedReview>();

export class HardLimitWriterReviewChangedError extends Error {
  readonly code = 'SEMANTIC_ACTION_WRITER_REVIEW_CHANGED';
  constructor() {
    super('SEMANTIC_ACTION_WRITER_REVIEW_CHANGED: The reviewed writer, receipt or activation context changed. Reopen Action review and inspect the current writer before confirming. No Action was published.');
    this.name = 'HardLimitWriterReviewChangedError';
  }
}

function candidateDigest(input: ReviewInput): string {
  const env = input.env ?? process.env;
  const references = new Set<string>();
  for (const { compiled } of input.registry.rules) {
    if (!compiled.hard_limit) continue;
    const policy = input.config.supervised_worker?.outcomes?.find(item => item.outcome === compiled.outcome);
    const source = policy ? resolveSemanticSupervisedWriterSource(input.config, compiled.source, policy) : input.config.sources?.[compiled.source];
    if (source?.read_url_env) references.add(source.read_url_env);
    if (source?.write_url_env) references.add(source.write_url_env);
  }
  // Digests and credentials stay inside this module. Include libpq-style
  // connection defaults as well as the selected URL references; print neither.
  const defaults = Object.keys(process.env).filter(key => key.startsWith('PG')).sort()
    .map(key => [key, process.env[key] ?? null]);
  return canonicalJsonDigest(JSON.parse(JSON.stringify({ context: input.reviewContext, config: input.config,
    compiled: input.registry.rules.map(({ compiled }) => ({ plan: compiled.compiled_plan_digest, hard_limit: compiled.hard_limit?.digest ?? null })),
    credentials: [...references].sort().map(name => [name, env[name]?.trim() ?? null]), defaults })));
}

async function inspect(input: ReviewInput) {
  const assessments: HardLimitWriterNativeAssessment[] = [];
  const readback = await inspectHardLimitWriterSetup({ ...input,
    observeNativeAssessment: assessment => { assessments.push(assessment); } });
  if (readback.status === 'ready' && assessments.length !== readback.checks.length) throw new HardLimitWriterReviewChangedError();
  return { readback, assessment: canonicalJsonDigest({ readback, assessments }) };
}

export async function inspectReviewedHardLimitWriterSetup(input: ReviewInput): Promise<HardLimitWriterSetupReadback & {
  writerReviewBinding?: HardLimitWriterReviewBinding;
}> {
  const frozen = { ...input, env: { ...(input.env ?? process.env) } };
  const candidate = candidateDigest(frozen);
  const result = await inspect(frozen);
  if (candidate !== candidateDigest(frozen)) throw new HardLimitWriterReviewChangedError();
  if (result.readback.status !== 'ready') return result.readback;
  const writerReviewBinding = Object.freeze({}) as HardLimitWriterReviewBinding;
  reviews.set(writerReviewBinding, { candidate, assessment: result.assessment });
  return { ...result.readback, writerReviewBinding };
}

/** Compare the shown projection before fresh native inspection and publication.
 * A ready snapshot never replaces the actual current writer check. */
export async function assertReviewedHardLimitWriterSetup(input: ReviewInput,
  writerReviewBinding: HardLimitWriterReviewBinding): Promise<void> {
  const reviewed = reviews.get(writerReviewBinding);
  const frozen = { ...input, env: { ...(input.env ?? process.env) } };
  if (!reviewed || reviewed.candidate !== candidateDigest(frozen)) throw new HardLimitWriterReviewChangedError();
  const result = await inspect(frozen);
  if (result.readback.status === 'refused') throw new HardLimitWriterSetupError(result.readback);
  if (result.readback.status !== 'ready' || reviewed.assessment !== result.assessment
    || reviewed.candidate !== candidateDigest(frozen)) throw new HardLimitWriterReviewChangedError();
}
