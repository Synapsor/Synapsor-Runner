import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  explorationBoundaryCandidateDigest,
  type ExplorationBoundaryDraft,
} from "./auto-boundary.js";
import {
  READ_WORKLOAD_ANALYSIS_VERSION,
  type ReadWorkloadAnalysis,
  type ReadWorkloadSource,
} from "./read-workload-assist.js";

export const READ_WORKLOAD_RECORD_VERSION = "synapsor.read-workload-record.v1" as const;
export const READ_WORKLOAD_REVIEW_VERSION = "synapsor.read-workload-review.v1" as const;

export type StoredReadWorkloadAnalysis = {
  schema_version: typeof READ_WORKLOAD_RECORD_VERSION;
  analysis_id: string;
  analysis_digest: `sha256:${string}`;
  generated_boundary_digest: `sha256:${string}`;
  imported_at: string;
  source: ReadWorkloadSource;
  analysis: ReadWorkloadAnalysis;
  authority_granted: false;
  source_query_executed: false;
  explore_budget_consumed: false;
  source_database_changed: false;
};

export type ReadWorkloadReview = {
  schema_version: typeof READ_WORKLOAD_REVIEW_VERSION;
  analysis_id: string;
  analysis_digest: `sha256:${string}`;
  analyzed_candidate_digest: `sha256:${string}`;
  candidate_digest: `sha256:${string}`;
  review_revision: number;
  reviewed_at: string;
  authority_activated: false;
  source_database_changed: false;
};

export type ReadWorkloadView = StoredReadWorkloadAnalysis & {
  state: "ready" | "blocked" | "stale" | "reviewed";
  stale_reason?: string;
  review?: ReadWorkloadReview;
};

export async function storeReadWorkloadAnalysis(input: {
  projectRoot: string;
  generatedBoundary: ExplorationBoundaryDraft;
  source: ReadWorkloadSource;
  analysis: ReadWorkloadAnalysis;
  now?: string;
}): Promise<ReadWorkloadView> {
  assertAnalysisShape(input.analysis);
  const generatedBoundaryDigest = explorationBoundaryCandidateDigest(input.generatedBoundary);
  const analysisDigest = canonicalJsonDigest({
    schema_version: READ_WORKLOAD_RECORD_VERSION,
    generated_boundary_digest: generatedBoundaryDigest,
    source: input.source,
    analysis: input.analysis,
  });
  const analysisId = `rw_${analysisDigest.slice("sha256:".length, "sha256:".length + 32)}`;
  const record: StoredReadWorkloadAnalysis = {
    schema_version: READ_WORKLOAD_RECORD_VERSION,
    analysis_id: analysisId,
    analysis_digest: analysisDigest,
    generated_boundary_digest: generatedBoundaryDigest,
    imported_at: input.now ?? new Date().toISOString(),
    source: structuredClone(input.source),
    analysis: structuredClone(input.analysis),
    authority_granted: false,
    source_query_executed: false,
    explore_budget_consumed: false,
    source_database_changed: false,
  };
  const projectRoot = path.resolve(input.projectRoot);
  const root = workloadRoot(projectRoot);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stored = await storeIdempotently(recordPath(root, analysisId), record);
  return workloadView(
    stored,
    generatedBoundaryDigest,
    await readOptionalReview(root, analysisId, analysisDigest),
  );
}

export async function listReadWorkloadAnalyses(input: {
  projectRoot: string;
  generatedBoundary: ExplorationBoundaryDraft;
}): Promise<ReadWorkloadView[]> {
  const projectRoot = path.resolve(input.projectRoot);
  const root = workloadRoot(projectRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const generatedDigest = explorationBoundaryCandidateDigest(input.generatedBoundary);
  const views: ReadWorkloadView[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json") || entry.endsWith(".review.json")) continue;
    const record = parseStoredRecord(JSON.parse(await fs.readFile(path.join(root, entry), "utf8")));
    if (entry !== `${record.analysis_id}.json`) {
      throw new Error("READ_WORKLOAD_RECORD_TAMPERED: filename does not match immutable workload content.");
    }
    views.push(workloadView(
      record,
      generatedDigest,
      await readOptionalReview(root, record.analysis_id, record.analysis_digest),
    ));
  }
  return views.sort((left, right) => right.imported_at.localeCompare(left.imported_at));
}

export async function readReadWorkloadAnalysis(input: {
  projectRoot: string;
  analysisId: string;
  generatedBoundary: ExplorationBoundaryDraft;
}): Promise<ReadWorkloadView> {
  const record = await readStoredReadWorkloadAnalysis(input);
  return workloadView(record, explorationBoundaryCandidateDigest(input.generatedBoundary),
    await readOptionalReview(workloadRoot(path.resolve(input.projectRoot)), record.analysis_id, record.analysis_digest));
}

/** Resolve the immutable record before comparing its payload with authoring
 * meaning. The envelope digest also binds Source and generated Boundary. */
export async function readStoredReadWorkloadAnalysis(input: {
  projectRoot: string; analysisId: string;
}): Promise<StoredReadWorkloadAnalysis> {
  const analysisId = safeAnalysisId(input.analysisId);
  const root = workloadRoot(path.resolve(input.projectRoot));
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(recordPath(root, analysisId), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`READ_WORKLOAD_NOT_FOUND: ${analysisId} is not an imported workload analysis.`);
    }
    throw error;
  }
  const record = parseStoredRecord(value);
  if (record.analysis_id !== analysisId) {
    throw new Error("READ_WORKLOAD_RECORD_TAMPERED: filename does not match immutable workload content.");
  }
  return record;
}

export async function recordReadWorkloadReview(input: {
  projectRoot: string;
  workload: ReadWorkloadView;
  candidateDigest: `sha256:${string}`;
  reviewRevision: number;
  now?: string;
}): Promise<ReadWorkloadReview> {
  if (input.workload.state !== "ready") {
    throw new Error(`READ_WORKLOAD_NOT_REVIEWABLE: ${input.workload.analysis_id} is ${input.workload.state}.`);
  }
  if (!input.workload.analysis.candidate_digest) {
    throw new Error("READ_WORKLOAD_REVIEW_INVALID: analyzed workload has no candidate digest.");
  }
  if (!Number.isSafeInteger(input.reviewRevision) || input.reviewRevision < 1) {
    throw new Error("READ_WORKLOAD_REVIEW_INVALID: review revision must be a positive integer.");
  }
  const review: ReadWorkloadReview = {
    schema_version: READ_WORKLOAD_REVIEW_VERSION,
    analysis_id: input.workload.analysis_id,
    analysis_digest: input.workload.analysis_digest,
    analyzed_candidate_digest: input.workload.analysis.candidate_digest,
    candidate_digest: input.candidateDigest,
    review_revision: input.reviewRevision,
    reviewed_at: input.now ?? new Date().toISOString(),
    authority_activated: false,
    source_database_changed: false,
  };
  const root = workloadRoot(path.resolve(input.projectRoot));
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  return storeReviewIdempotently(reviewPath(root, input.workload.analysis_id), review);
}

function workloadView(
  record: StoredReadWorkloadAnalysis,
  generatedBoundaryDigest: string,
  review?: ReadWorkloadReview,
): ReadWorkloadView {
  if (review) {
    return {
      ...record,
      state: "reviewed",
      review,
      ...(record.generated_boundary_digest !== generatedBoundaryDigest
        ? { stale_reason: "The generated boundary was rebound or changed after this disabled review was recorded." }
        : {}),
    };
  }
  if (record.generated_boundary_digest !== generatedBoundaryDigest) {
    return {
      ...record,
      state: "stale",
      stale_reason: "The generated boundary changed after this workload analysis was created.",
      ...(review ? { review } : {}),
    };
  }
  return {
    ...record,
    state: record.analysis.status === "ready" ? "ready" : "blocked",
  };
}

function parseStoredRecord(value: unknown): StoredReadWorkloadAnalysis {
  if (!isRecord(value)
    || value.schema_version !== READ_WORKLOAD_RECORD_VERSION
    || typeof value.analysis_id !== "string"
    || typeof value.analysis_digest !== "string"
    || typeof value.generated_boundary_digest !== "string"
    || typeof value.imported_at !== "string"
    || value.authority_granted !== false
    || value.source_query_executed !== false
    || value.explore_budget_consumed !== false
    || value.source_database_changed !== false) {
    throw new Error("READ_WORKLOAD_RECORD_INVALID: stored workload metadata is malformed.");
  }
  const record = value as StoredReadWorkloadAnalysis;
  safeAnalysisId(record.analysis_id);
  assertAnalysisShape(record.analysis);
  const expected = canonicalJsonDigest({
    schema_version: READ_WORKLOAD_RECORD_VERSION,
    generated_boundary_digest: record.generated_boundary_digest,
    source: record.source,
    analysis: record.analysis,
  });
  if (record.analysis_digest !== expected
    || record.analysis_id !== `rw_${expected.slice("sha256:".length, "sha256:".length + 32)}`) {
    throw new Error("READ_WORKLOAD_RECORD_TAMPERED: workload digest does not match immutable content.");
  }
  return record;
}

function assertAnalysisShape(value: unknown): asserts value is ReadWorkloadAnalysis {
  if (!isRecord(value)
    || value.schema_version !== READ_WORKLOAD_ANALYSIS_VERSION
    || (value.status !== "ready" && value.status !== "blocked")
    || value.authority_granted !== false
    || value.source_query_executed !== false
    || value.explore_budget_consumed !== false
    || value.source_database_changed !== false) {
    throw new Error("READ_WORKLOAD_ANALYSIS_INVALID: workload analysis safety posture is malformed.");
  }
}

async function readOptionalReview(
  root: string,
  analysisId: string,
  analysisDigest: string,
): Promise<ReadWorkloadReview | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(reviewPath(root, analysisId), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!isRecord(value)
    || value.schema_version !== READ_WORKLOAD_REVIEW_VERSION
    || value.analysis_id !== analysisId
    || value.analysis_digest !== analysisDigest
    || typeof value.analyzed_candidate_digest !== "string"
    || typeof value.candidate_digest !== "string"
    || !Number.isSafeInteger(value.review_revision)
    || typeof value.reviewed_at !== "string"
    || value.authority_activated !== false
    || value.source_database_changed !== false) {
    throw new Error("READ_WORKLOAD_REVIEW_TAMPERED: workload review metadata is malformed or stale.");
  }
  return value as ReadWorkloadReview;
}

async function storeIdempotently(
  file: string,
  value: StoredReadWorkloadAnalysis,
): Promise<StoredReadWorkloadAnalysis> {
  try {
    const existing = parseStoredRecord(JSON.parse(await fs.readFile(file, "utf8")));
    if (existing.analysis_digest !== value.analysis_digest) {
      throw new Error("READ_WORKLOAD_RECORD_COLLISION: immutable workload id already has different content.");
    }
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeExclusiveJson(file, value);
  return value;
}

async function storeReviewIdempotently(file: string, value: ReadWorkloadReview): Promise<ReadWorkloadReview> {
  try {
    const existing = JSON.parse(await fs.readFile(file, "utf8")) as ReadWorkloadReview;
    if (canonicalJsonDigest(existing) !== canonicalJsonDigest(value)) {
      throw new Error("READ_WORKLOAD_REVIEW_EXISTS: this workload already records a different disabled review result.");
    }
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeExclusiveJson(file, value);
  return value;
}

async function writeExclusiveJson(file: string, value: unknown): Promise<void> {
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function workloadRoot(projectRoot: string): string {
  return path.join(projectRoot, ".synapsor", "read-workloads");
}

function recordPath(root: string, analysisId: string): string {
  return path.join(root, `${safeAnalysisId(analysisId)}.json`);
}

function reviewPath(root: string, analysisId: string): string {
  return path.join(root, `${safeAnalysisId(analysisId)}.review.json`);
}

function safeAnalysisId(value: string): string {
  if (!/^rw_[a-f0-9]{32}$/.test(value)) {
    throw new Error("READ_WORKLOAD_ID_INVALID: analysis id must be one exact rw_ identifier.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
