import { z } from "zod";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { AUTO_BOUNDARY_VERSION, EXPLORATION_BOUNDARY_VERSION, GENERATION_LOCK_VERSION, AUTO_BOUNDARY_COMPILER_VERSION, parseBoundaryReviewDecisionRef, assertStoredExplorationMetadata, assertStoredExplorationPolicy, explorationBoundaryCandidateDigest, generationLockSharedFactsDigest, generationReviewEvidenceDigest, parseAutoBoundaryPolicyBaseline, reviewExplorationBoundaryCandidate,
  type AutoBoundaryBuild, type ExplorationBoundaryDraft, type GenerationLock } from "./auto-boundary.js";
import { normalizeStoredBoundaryReviewProgress, type BoundaryReviewProgress } from "./boundary-review-domain.js";
import { BOUNDARY_REVIEW_PROGRESS_VERSION, readReviewOriginSchema } from "./boundary-review-progress-types.js";
import { OPERATOR_READ_POLICY_RECORD_VERSION } from "./control-policy-record.js";
import { parseOperatorQuestions, assertOperatorQuestionsAdvance, type OperatorQuestion } from "./authoring-operator-question.js";
import type { OperatorSubmissionOrigin } from "./authoring-operator-submission-origin.js";


export const READ_REVIEW_PROTOCOL = "synapsor.read-review.v2" as const;
export const OPERATOR_READ_REVIEW_PROTOCOL = "synapsor.read-review.v3" as const;

const identity = z.string().regex(/^bnd_[a-f0-9]{32}$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const confirmationSchema = z.record(z.unknown()).superRefine((value, ctx) => {
  try {
    const { decision, status, actor, reason, confirmed_at, origin, ...reference } = value;
    parseBoundaryReviewDecisionRef(reference);
    if (typeof decision !== "string" || status !== "confirmed" || typeof actor !== "string"
      || !actor.trim() || typeof reason !== "string" || !reason.trim()
      || !z.string().datetime({ offset: true }).safeParse(confirmed_at).success) throw new Error("Invalid confirmation metadata");
    if (origin !== undefined) readReviewOriginSchema.parse(origin);
  } catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid exact typed review confirmation" }); }
});
const progressSchema = z.object({
  schema_version: z.literal(BOUNDARY_REVIEW_PROGRESS_VERSION),
  boundary_id: identity,
  review_overrides: z.record(z.unknown()),
  policy_migration: z.record(z.unknown()),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  draft_digest: digest,
  candidate: z.record(z.unknown()),
  candidate_digest: digest,
  confirmed_decisions: z.array(z.string()).max(10_000),
  confirmations: z.array(confirmationSchema).max(10_000),
  invalidated_decisions: z.array(z.object({ id: z.string().min(1), decision: z.string(),
    previous_input_digest: digest, current_input_digest: digest.optional(),
    reason: z.enum(["reviewed_input_changed", "decision_removed"]),
    invalidated_at: z.string().datetime({ offset: true }),
  }).strict()).max(200),
  updated_at: z.string().datetime({ offset: true }),
}).strict();
// Catalog metadata supports operator inspection only. Candidate compilation and
// fresh schema/role validation still determine every allowed operation.
const catalogSchema = z.object({
  lock: z.record(z.unknown()),
  evidence_project: z.object({ frameworks: z.array(z.string()), schema_inputs: z.array(z.record(z.unknown())) }).strict(),
  review: z.object({ schema_version: z.literal(AUTO_BOUNDARY_VERSION), activation: z.literal("blocked_unreviewed"),
    structured_actions: z.array(z.record(z.unknown())),
    engine: z.enum(["postgres", "mysql"]), resources: z.array(z.object({
      id: z.string().min(1), status: z.string(), blockers: z.array(z.string()),
      primary_key: z.record(z.unknown()), tenant_key: z.record(z.unknown()), principal_key: z.record(z.unknown()),
      fields: z.array(z.object({ name: z.string().min(1) }).passthrough()), relationships: z.array(z.record(z.unknown())),
    }).passthrough()),
  }).passthrough(),
  policy_baseline: z.object({ schema_version: z.string(), boundary: z.record(z.unknown()), lock: z.record(z.unknown()) }).strict(),
}).strict();
const entrySchema = z.object({
  stage: z.literal("metadata_only").optional(),
  draft: z.record(z.unknown()), draft_lock: z.record(z.unknown()),
  candidate_lock: z.record(z.unknown()), progress: progressSchema,
  catalog: catalogSchema.optional(),
  operator_questions:z.array(z.unknown()).max(64).optional(),
}).strict();
export const readAuthoringDocument = z.object({
  schema_version: z.literal(OPERATOR_READ_POLICY_RECORD_VERSION), type: z.literal("read_authoring"),
  review_protocol: z.enum([READ_REVIEW_PROTOCOL,OPERATOR_READ_REVIEW_PROTOCOL]),
  selected_boundary_id: identity.nullable(), entries: z.array(entrySchema).max(128),
  rescan_report: z.record(z.unknown()).optional(),
}).strict();

export type PreparedReadEntry = {
  stage?: "metadata_only";
  draft: ExplorationBoundaryDraft; draft_lock: GenerationLock;
  candidate_lock: GenerationLock; progress: BoundaryReviewProgress;
  catalog?: Pick<AutoBoundaryBuild, "lock" | "review" | "policy_baseline"> & { evidence_project: AutoBoundaryBuild["graph"]["project"] };
  operator_questions?:OperatorQuestion[];
};
export type StoredReadAuthoring = {
  type: "read_authoring"; review_protocol: typeof READ_REVIEW_PROTOCOL|typeof OPERATOR_READ_REVIEW_PROTOCOL; selected_boundary_id: string | null; entries: PreparedReadEntry[];
  rescan_report?: Record<string, unknown>;
};

export function readAuthoringCatalog(build: AutoBoundaryBuild): NonNullable<PreparedReadEntry["catalog"]> {
  return structuredClone({ lock: build.lock, review: build.review, policy_baseline: build.policy_baseline,
    evidence_project: build.graph.project });
}

/** Prepare freshly generated metadata for disabled policy storage. The generated
 * catalog includes reviewable paths beyond the current query budget; retain that
 * catalog separately, while storing the same canonical policy the review uses.
 * Never apply this to an existing stored revision or during transfer validation. */
export function preparedReadAuthoringDraft(build: AutoBoundaryBuild): ExplorationBoundaryDraft {
  const draft = build.exploration_boundary;
  return draft.pack.resources.length
    ? reviewExplorationBoundaryCandidate(draft, structuredClone(draft)).candidate
    : structuredClone(draft);
}

/** Exact disabled state, not a legacy repair or a fresh schema review. Both
 * locks are embedded so a changed/missing export cannot rebase saved work. */
export function parseReadAuthoringDocument(input: unknown): StoredReadAuthoring {
  const parsed = readAuthoringDocument.parse(input);
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const entry of parsed.entries) {
    if(parsed.review_protocol===READ_REVIEW_PROTOCOL&&entry.operator_questions!==undefined)
      fail("POLICY_AUTHORING_OPERATOR_REVIEW_VERSION_UNSUPPORTED");
    if(entry.operator_questions!==undefined)parseOperatorReadEntryQuestions(entry.operator_questions,entry.progress.boundary_id);
    const draft = entry.draft as unknown as ExplorationBoundaryDraft;
    const candidate = entry.progress.candidate as unknown as ExplorationBoundaryDraft;
    if (draft.schema_version !== EXPLORATION_BOUNDARY_VERSION || candidate.schema_version !== EXPLORATION_BOUNDARY_VERSION) {
      fail("POLICY_AUTHORING_BOUNDARY_VERSION_UNSUPPORTED");
    }
    if (draft.activation !== "disabled_unreviewed" || candidate.activation !== "disabled_unreviewed") {
      fail("POLICY_AUTHORING_MUST_BE_DISABLED");
    }
    const draftLock = entry.draft_lock as unknown as GenerationLock;
    const candidateLock = entry.candidate_lock as unknown as GenerationLock;
    if ([draftLock, candidateLock].some(lock => lock.schema_version !== GENERATION_LOCK_VERSION
      || lock.compiler_version !== AUTO_BOUNDARY_COMPILER_VERSION)) fail("POLICY_AUTHORING_LOCK_VERSION_UNSUPPORTED");
    const metadataOnly = entry.stage === "metadata_only";
    if (metadataOnly !== (candidate.pack.resources.length === 0)) fail("POLICY_AUTHORING_STAGE_MISMATCH");
    if ((metadataOnly || draft.pack.resources.length === 0) && !entry.catalog) fail("POLICY_AUTHORING_CATALOG_REQUIRED");
    if (draft.pack.resources.length === 0) assertStoredExplorationMetadata(draft, draftLock);
    else assertStoredExplorationPolicy(draft, draftLock);
    if (metadataOnly) assertStoredExplorationMetadata(candidate, candidateLock);
    else assertStoredExplorationPolicy(candidate, candidateLock);
    if (generationLockSharedFactsDigest(draftLock) !== generationLockSharedFactsDigest(candidateLock)) {
      fail("POLICY_AUTHORING_SCHEMA_MISMATCH");
    }
    if (entry.catalog) {
      const catalog = entry.catalog as unknown as NonNullable<PreparedReadEntry["catalog"]>;
      parseAutoBoundaryPolicyBaseline(catalog.policy_baseline);
      if (metadataOnly && ![draftLock, candidateLock].some((lock) =>
        canonicalJsonDigest(lock) === canonicalJsonDigest(catalog.lock))) {
        fail("POLICY_AUTHORING_CATALOG_MISMATCH");
      }
      if (catalog.review.engine !== draftLock.engine
        || generationReviewEvidenceDigest(catalog.review, catalog.evidence_project) !== catalog.lock.evidence_fingerprint
        || generationLockSharedFactsDigest(catalog.lock) !== generationLockSharedFactsDigest(draftLock)
        || generationLockSharedFactsDigest(catalog.policy_baseline.lock) !== generationLockSharedFactsDigest(draftLock)
        || new Set(catalog.review.resources.map((resource) => resource.id)).size !== catalog.review.resources.length
        || catalog.review.resources.some((resource) => new Set(resource.fields.map((field) => field.name)).size !== resource.fields.length)) {
        fail("POLICY_AUTHORING_CATALOG_MISMATCH");
      }
    }
    if (entry.progress.draft_digest !== explorationBoundaryCandidateDigest(draft)
      || entry.progress.candidate_digest !== explorationBoundaryCandidateDigest(candidate)) {
      fail("POLICY_AUTHORING_REVISION_MISMATCH");
    }
    const normalized = parseStoredReadReviewProgress(entry.progress);
    if (ids.has(normalized.boundary_id) || names.has(candidate.pack.name)) fail("POLICY_AUTHORING_DUPLICATE_BOUNDARY");
    ids.add(normalized.boundary_id); names.add(candidate.pack.name);
  }
  if (parsed.entries.length === 0 ? parsed.selected_boundary_id !== null
    : parsed.selected_boundary_id === null || !ids.has(parsed.selected_boundary_id)) {
    fail("POLICY_AUTHORING_SELECTION_INVALID");
  }
  return { type: parsed.type, review_protocol: parsed.review_protocol, selected_boundary_id: parsed.selected_boundary_id,
    entries: structuredClone(parsed.entries) as unknown as PreparedReadEntry[],
    ...(parsed.rescan_report ? { rescan_report: structuredClone(parsed.rescan_report) } : {}) };
}

/** Closed syntax and own-entry association only. Native writer/reader still
 * authenticate the immutable original baseline and exact acknowledged lineage. */
export function operatorQuestionSubmissionOrigin(q:OperatorQuestion):OperatorSubmissionOrigin {
  if(q.version===5&&q.shared_sum?.version===2)return q.shared_sum.origin;
  if(q.version===5&&q.read_scope&&"version" in q.read_scope)return q.read_scope.origin;
  return fail("POLICY_AUTHORING_OPERATOR_QUESTION_REQUIRED");
}
export function parseOperatorReadEntryQuestions(value:unknown,boundaryId:string):OperatorQuestion[] {
  const questions=parseOperatorQuestions(value,[]);
  for(const q of questions){
    const origin=operatorQuestionSubmissionOrigin(q);
    if(origin.entry_id!==boundaryId||q.handoff_id!==undefined||q.raw_answer!==undefined)
      fail("POLICY_AUTHORING_OPERATOR_QUESTION_FOREIGN");
  }
  return questions;
}
/** Historical preservation is necessary, not sufficient for a native decision.
 * The domain owner must validate each new/proposed/confirmed Question under
 * the same actual CAS; a caller-supplied confirmation is never its proof. */
export function assertOperatorReadQuestionInventoryAdvance(previous:StoredReadAuthoring,next:StoredReadAuthoring):void {
  for(const old of previous.entries){
    if(!old.operator_questions?.length)continue;
    const current=next.entries.find(e=>e.progress.boundary_id===old.progress.boundary_id);
    if(next.review_protocol!==OPERATOR_READ_REVIEW_PROTOCOL||!current?.operator_questions)
      fail("POLICY_AUTHORING_OPERATOR_HISTORY_REMOVED");
    assertOperatorQuestionsAdvance(parseOperatorReadEntryQuestions(old.operator_questions,old.progress.boundary_id),
      parseOperatorReadEntryQuestions(current.operator_questions,current.progress.boundary_id));
  }
}

/** Wire validation only. The persisted display cache does not prove applicability.
 * The native loader resolves immutable origins before deriving current decisions. */
export function parseStoredReadReviewProgress(input: unknown): BoundaryReviewProgress {
  const parsed = progressSchema.parse(input);
  const candidate = parsed.candidate as unknown as ExplorationBoundaryDraft;
  if (parsed.candidate_digest !== explorationBoundaryCandidateDigest(candidate)) fail("POLICY_AUTHORING_REVISION_MISMATCH");
  const normalized = normalizeStoredBoundaryReviewProgress(parsed, candidate);
  const { confirmed_decisions: _derived, ...canonical } = normalized;
  const { confirmed_decisions: _auditCache, ...wire } = parsed;
  if (canonicalJsonDigest(canonical) !== canonicalJsonDigest(wire)
    || new Set(normalized.confirmations.map(item => item.id)).size !== normalized.confirmations.length
    || new Set(parsed.confirmed_decisions).size !== parsed.confirmed_decisions.length) fail("POLICY_AUTHORING_NORMALIZATION_REQUIRED");
  return structuredClone(parsed) as unknown as BoundaryReviewProgress;
}

function fail(code: string): never {
  throw Object.assign(new Error(`${code}: saved Read authoring state requires exact review; no authority changed.`), { code });
}
