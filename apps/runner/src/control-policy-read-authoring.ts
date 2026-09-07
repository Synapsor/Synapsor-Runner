import { z } from "zod";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { AUTO_BOUNDARY_VERSION, assertStoredExplorationPolicy, explorationBoundaryCandidateDigest, generationLockSharedFactsDigest, generationReviewEvidenceDigest, parseAutoBoundaryPolicyBaseline,
  type AutoBoundaryBuild, type ExplorationBoundaryDraft, type GenerationLock } from "./auto-boundary.js";
import { normalizeStoredBoundaryReviewProgress, type BoundaryReviewProgress } from "./boundary-review-domain.js";
import { BOUNDARY_REVIEW_PROGRESS_VERSION } from "./boundary-review-progress-types.js";
import { OPERATOR_POLICY_RECORD_VERSION } from "./control-policy-record.js";

const identity = z.string().regex(/^bnd_[a-f0-9]{32}$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
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
  confirmations: z.array(z.unknown()).max(10_000),
  invalidated_decisions: z.array(z.unknown()).max(200),
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
  draft: z.record(z.unknown()), draft_lock: z.record(z.unknown()),
  candidate_lock: z.record(z.unknown()), progress: progressSchema,
  catalog: catalogSchema.optional(),
}).strict();
export const readAuthoringDocument = z.object({
  schema_version: z.literal(OPERATOR_POLICY_RECORD_VERSION), type: z.literal("read_authoring"),
  selected_boundary_id: identity.nullable(), entries: z.array(entrySchema).max(128),
  rescan_report: z.record(z.unknown()).optional(),
}).strict();

export type PreparedReadEntry = {
  draft: ExplorationBoundaryDraft; draft_lock: GenerationLock;
  candidate_lock: GenerationLock; progress: BoundaryReviewProgress;
  catalog?: Pick<AutoBoundaryBuild, "lock" | "review" | "policy_baseline"> & { evidence_project: AutoBoundaryBuild["graph"]["project"] };
};
export type StoredReadAuthoring = {
  type: "read_authoring"; selected_boundary_id: string | null; entries: PreparedReadEntry[];
  rescan_report?: Record<string, unknown>;
};

export function readAuthoringCatalog(build: AutoBoundaryBuild): NonNullable<PreparedReadEntry["catalog"]> {
  return structuredClone({ lock: build.lock, review: build.review, policy_baseline: build.policy_baseline,
    evidence_project: build.graph.project });
}

/** Exact disabled state, not a legacy repair or a fresh schema review. Both
 * locks are embedded so a changed/missing export cannot rebase saved work. */
export function parseReadAuthoringDocument(input: unknown): StoredReadAuthoring {
  const parsed = readAuthoringDocument.parse(input);
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const entry of parsed.entries) {
    const draft = entry.draft as unknown as ExplorationBoundaryDraft;
    const candidate = entry.progress.candidate as unknown as ExplorationBoundaryDraft;
    if (draft.activation !== "disabled_unreviewed" || candidate.activation !== "disabled_unreviewed") {
      fail("POLICY_AUTHORING_MUST_BE_DISABLED");
    }
    const draftLock = entry.draft_lock as unknown as GenerationLock;
    const candidateLock = entry.candidate_lock as unknown as GenerationLock;
    assertStoredExplorationPolicy(draft, draftLock);
    assertStoredExplorationPolicy(candidate, candidateLock);
    if (generationLockSharedFactsDigest(draftLock) !== generationLockSharedFactsDigest(candidateLock)) {
      fail("POLICY_AUTHORING_SCHEMA_MISMATCH");
    }
    if (entry.catalog) {
      const catalog = entry.catalog as unknown as NonNullable<PreparedReadEntry["catalog"]>;
      parseAutoBoundaryPolicyBaseline(catalog.policy_baseline);
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
    const normalized = normalizeStoredBoundaryReviewProgress(entry.progress, candidate);
    if (canonicalJsonDigest(normalized) !== canonicalJsonDigest(entry.progress)
      || new Set(normalized.confirmations.map((confirmation) => confirmation.id)).size !== normalized.confirmations.length
      || new Set(normalized.confirmed_decisions).size !== normalized.confirmed_decisions.length) {
      fail("POLICY_AUTHORING_NORMALIZATION_REQUIRED");
    }
    if (ids.has(normalized.boundary_id) || names.has(candidate.pack.name)) fail("POLICY_AUTHORING_DUPLICATE_BOUNDARY");
    ids.add(normalized.boundary_id); names.add(candidate.pack.name);
  }
  if (parsed.entries.length === 0 ? parsed.selected_boundary_id !== null
    : parsed.selected_boundary_id === null || !ids.has(parsed.selected_boundary_id)) {
    fail("POLICY_AUTHORING_SELECTION_INVALID");
  }
  return { type: parsed.type, selected_boundary_id: parsed.selected_boundary_id,
    entries: structuredClone(parsed.entries) as unknown as PreparedReadEntry[],
    ...(parsed.rescan_report ? { rescan_report: structuredClone(parsed.rescan_report) } : {}) };
}

function fail(code: string): never {
  throw Object.assign(new Error(`${code}: saved Read authoring state requires exact review; no authority changed.`), { code });
}
