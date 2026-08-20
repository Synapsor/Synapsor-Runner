import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  assessActionSuggestion,
  normalizeActionSuggestion,
  type ActionSuggestionAssessment,
} from "./action-design.js";
import type { GuidedActionOptions } from "./guided-action.js";

export const ACTION_SUGGESTION_RECORD_VERSION = "synapsor.action-suggestion-record.v1" as const;
export const ACTION_SUGGESTION_REVIEW_VERSION = "synapsor.action-suggestion-review.v1" as const;

export type StoredActionSuggestion = {
  schema_version: typeof ACTION_SUGGESTION_RECORD_VERSION;
  suggestion_id: string;
  suggestion_digest: `sha256:${string}`;
  boundary_digest: `sha256:${string}`;
  imported_at: string;
  assessment: ActionSuggestionAssessment;
  authority_granted: false;
  source_database_changed: false;
};

export type ActionSuggestionReview = {
  schema_version: typeof ACTION_SUGGESTION_REVIEW_VERSION;
  suggestion_id: string;
  suggestion_digest: `sha256:${string}`;
  capability: string;
  contract_digest: `sha256:${string}`;
  reviewed_at: string;
  authority_activated: false;
  source_database_changed: false;
};

export type ActionSuggestionView = StoredActionSuggestion & {
  state: "suggested" | "blocked" | "stale" | "reviewed";
  current_assessment: ActionSuggestionAssessment;
  stale_reason?: string;
  review?: ActionSuggestionReview;
};

export async function importActionSuggestion(input: {
  projectRoot: string;
  value: unknown;
  options: GuidedActionOptions;
  now?: string;
}): Promise<ActionSuggestionView> {
  const projectRoot = path.resolve(input.projectRoot);
  const assessment = assessActionSuggestion(input.value, input.options.resources);
  const suggestionDigest = canonicalJsonDigest({
    schema_version: "synapsor.action-suggestion-identity.v1",
    suggestion: assessment.suggestion,
    boundary_digest: input.options.boundary_digest,
  });
  const suggestionId = `as_${suggestionDigest.slice("sha256:".length, "sha256:".length + 32)}`;
  const record: StoredActionSuggestion = {
    schema_version: ACTION_SUGGESTION_RECORD_VERSION,
    suggestion_id: suggestionId,
    suggestion_digest: suggestionDigest,
    boundary_digest: input.options.boundary_digest,
    imported_at: input.now ?? new Date().toISOString(),
    assessment,
    authority_granted: false,
    source_database_changed: false,
  };
  const file = suggestionPath(projectRoot, suggestionId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const stored = await storeSuggestionIdempotently(file, record);
  return suggestionView(
    stored,
    input.options,
    await readOptionalReview(projectRoot, suggestionId, stored.suggestion_digest),
  );
}

export async function listActionSuggestions(input: {
  projectRoot: string;
  options: GuidedActionOptions;
}): Promise<ActionSuggestionView[]> {
  const projectRoot = path.resolve(input.projectRoot);
  const root = suggestionRoot(projectRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const views: ActionSuggestionView[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json") || entry.endsWith(".review.json")) continue;
    const record = parseStoredSuggestion(JSON.parse(await fs.readFile(path.join(root, entry), "utf8")));
    if (entry !== `${record.suggestion_id}.json`) {
      throw new Error("ACTION_SUGGESTION_RECORD_TAMPERED: suggestion filename does not match its immutable content.");
    }
    views.push(suggestionView(
      record,
      input.options,
      await readOptionalReview(projectRoot, record.suggestion_id, record.suggestion_digest),
    ));
  }
  return views.sort((left, right) => right.imported_at.localeCompare(left.imported_at));
}

export async function readActionSuggestion(input: {
  projectRoot: string;
  suggestionId: string;
  options: GuidedActionOptions;
}): Promise<ActionSuggestionView> {
  const projectRoot = path.resolve(input.projectRoot);
  const suggestionId = safeSuggestionId(input.suggestionId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(suggestionPath(projectRoot, suggestionId), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`ACTION_SUGGESTION_NOT_FOUND: ${suggestionId} is not an imported suggestion.`);
    }
    throw error;
  }
  const record = parseStoredSuggestion(parsed);
  if (record.suggestion_id !== suggestionId) {
    throw new Error("ACTION_SUGGESTION_RECORD_TAMPERED: suggestion filename does not match its immutable content.");
  }
  return suggestionView(
    record,
    input.options,
    await readOptionalReview(projectRoot, suggestionId, record.suggestion_digest),
  );
}

export async function recordActionSuggestionReview(input: {
  projectRoot: string;
  suggestion: ActionSuggestionView;
  capability: string;
  contractDigest: `sha256:${string}`;
  now?: string;
}): Promise<ActionSuggestionReview> {
  if (input.suggestion.state !== "suggested") {
    throw new Error(`ACTION_SUGGESTION_NOT_REVIEWABLE: ${input.suggestion.suggestion_id} is ${input.suggestion.state}.`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(input.contractDigest)) {
    throw new Error("ACTION_SUGGESTION_REVIEW_INVALID: contract digest must be one exact lowercase sha256 digest.");
  }
  if (!isSafeReviewedCapability(input.capability)) {
    throw new Error("ACTION_SUGGESTION_REVIEW_INVALID: capability must be one bounded safe identifier.");
  }
  const review: ActionSuggestionReview = {
    schema_version: ACTION_SUGGESTION_REVIEW_VERSION,
    suggestion_id: input.suggestion.suggestion_id,
    suggestion_digest: input.suggestion.suggestion_digest,
    capability: input.capability,
    contract_digest: input.contractDigest,
    reviewed_at: input.now ?? new Date().toISOString(),
    authority_activated: false,
    source_database_changed: false,
  };
  const projectRoot = path.resolve(input.projectRoot);
  await fs.mkdir(suggestionRoot(projectRoot), { recursive: true, mode: 0o700 });
  return storeReviewIdempotently(reviewPath(projectRoot, input.suggestion.suggestion_id), review);
}

function suggestionView(
  record: StoredActionSuggestion,
  options: GuidedActionOptions,
  review?: ActionSuggestionReview,
): ActionSuggestionView {
  const currentAssessment = assessActionSuggestion(record.assessment.suggestion, options.resources);
  const currentRecord = { ...record, assessment: currentAssessment };
  if (record.boundary_digest !== options.boundary_digest) {
    return {
      ...currentRecord,
      state: "stale",
      current_assessment: currentAssessment,
      stale_reason: "The active reviewed Read Boundary digest changed after this suggestion was imported.",
      ...(review ? { review } : {}),
    };
  }
  if (currentAssessment.status === "blocked") {
    return { ...currentRecord, state: "blocked", current_assessment: currentAssessment, ...(review ? { review } : {}) };
  }
  return { ...currentRecord, state: review ? "reviewed" : "suggested", current_assessment: currentAssessment, ...(review ? { review } : {}) };
}

function parseStoredSuggestion(value: unknown): StoredActionSuggestion {
  if (!isRecord(value)
    || value.schema_version !== ACTION_SUGGESTION_RECORD_VERSION
    || typeof value.suggestion_id !== "string"
    || typeof value.suggestion_digest !== "string"
    || typeof value.boundary_digest !== "string"
    || typeof value.imported_at !== "string"
    || value.authority_granted !== false
    || value.source_database_changed !== false) {
    throw new Error("ACTION_SUGGESTION_RECORD_INVALID: imported suggestion metadata is malformed.");
  }
  const suggestionId = safeSuggestionId(value.suggestion_id);
  const assessment = value.assessment as ActionSuggestionAssessment;
  if (!isRecord(assessment)
    || assessment.authority_granted !== false
    || assessment.source_database_changed !== false) {
    throw new Error("ACTION_SUGGESTION_RECORD_INVALID: assessment authority posture is malformed.");
  }
  const suggestion = normalizeActionSuggestion(assessment.suggestion);
  const expectedDigest = canonicalJsonDigest({
    schema_version: "synapsor.action-suggestion-identity.v1",
    suggestion,
    boundary_digest: value.boundary_digest,
  });
  if (value.suggestion_digest !== expectedDigest
    || suggestionId !== `as_${expectedDigest.slice("sha256:".length, "sha256:".length + 32)}`) {
    throw new Error("ACTION_SUGGESTION_RECORD_TAMPERED: suggestion digest does not match its immutable content.");
  }
  return value as StoredActionSuggestion;
}

async function readOptionalReview(
  projectRoot: string,
  suggestionId: string,
  expectedSuggestionDigest: string,
): Promise<ActionSuggestionReview | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(reviewPath(projectRoot, suggestionId), "utf8"));
    return parseActionSuggestionReview(parsed, suggestionId, expectedSuggestionDigest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function storeSuggestionIdempotently(
  file: string,
  record: StoredActionSuggestion,
): Promise<StoredActionSuggestion> {
  try {
    return parseStoredSuggestion(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return parseStoredSuggestion(JSON.parse(await fs.readFile(file, "utf8")));
  }
}

async function storeReviewIdempotently(
  file: string,
  review: ActionSuggestionReview,
): Promise<ActionSuggestionReview> {
  try {
    const existing = parseActionSuggestionReview(
      JSON.parse(await fs.readFile(file, "utf8")),
      review.suggestion_id,
      review.suggestion_digest,
    );
    return assertSameSuggestionReview(existing, review);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await fs.writeFile(file, `${JSON.stringify(review, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return review;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = parseActionSuggestionReview(
      JSON.parse(await fs.readFile(file, "utf8")),
      review.suggestion_id,
      review.suggestion_digest,
    );
    return assertSameSuggestionReview(existing, review);
  }
}

function parseActionSuggestionReview(
  value: unknown,
  expectedSuggestionId: string,
  expectedSuggestionDigest: string,
): ActionSuggestionReview {
  if (!isRecord(value)
    || value.schema_version !== ACTION_SUGGESTION_REVIEW_VERSION
    || value.suggestion_id !== expectedSuggestionId
    || value.suggestion_digest !== expectedSuggestionDigest
    || typeof value.capability !== "string"
    || !isSafeReviewedCapability(value.capability)
    || !/^sha256:[a-f0-9]{64}$/.test(String(value.contract_digest))
    || typeof value.reviewed_at !== "string"
    || value.authority_activated !== false
    || value.source_database_changed !== false) {
    throw new Error("ACTION_SUGGESTION_REVIEW_INVALID: suggestion review metadata is malformed or does not match the exact suggestion.");
  }
  return value as ActionSuggestionReview;
}

function isSafeReviewedCapability(value: string): boolean {
  return Boolean(value.trim()) && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function assertSameSuggestionReview(
  existing: ActionSuggestionReview,
  requested: ActionSuggestionReview,
): ActionSuggestionReview {
  if (existing.capability !== requested.capability || existing.contract_digest !== requested.contract_digest) {
    throw new Error("ACTION_SUGGESTION_REVIEW_IMMUTABLE: this suggestion was already reviewed into another disabled revision.");
  }
  return existing;
}

function suggestionRoot(projectRoot: string): string {
  return path.join(projectRoot, ".synapsor", "action-suggestions");
}

function suggestionPath(projectRoot: string, suggestionId: string): string {
  return path.join(suggestionRoot(projectRoot), `${safeSuggestionId(suggestionId)}.json`);
}

function reviewPath(projectRoot: string, suggestionId: string): string {
  return path.join(suggestionRoot(projectRoot), `${safeSuggestionId(suggestionId)}.review.json`);
}

function safeSuggestionId(value: string): string {
  if (!/^as_[a-f0-9]{32}$/.test(value)) throw new Error("ACTION_SUGGESTION_ID_INVALID: expected an exact as_<digest> id.");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
