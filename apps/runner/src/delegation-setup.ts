import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { GuidedActionDraft } from "./guided-action.js";
import type { ReadWorkloadReview, ReadWorkloadView } from "./read-workloads.js";
import {
  MAX_BOUNDARY_ACTION_INTENT_CHARACTERS,
  MAX_BOUNDARY_JOB_DESCRIPTION_CHARACTERS,
  MAX_BOUNDARY_READ_QUESTION_CHARACTERS,
} from "./boundary-authoring-limits.js";

export const DELEGATION_DRAFT_VERSION = "synapsor.delegation-draft.v1" as const;

export type DelegationModelAssist = {
  provider: "openai" | "anthropic" | "openrouter" | "openai_compatible";
  model: string;
  structural_metadata_egress_acknowledged: true;
};

export type DelegationReadDraft = {
  boundary_name: string;
  analysis_id: string;
  analysis_digest: `sha256:${string}`;
  candidate_digest: `sha256:${string}`;
  review_revision: number;
  representative_questions: string[];
  state: "disabled_review";
};

export type DelegationActionDraft = {
  intent: string;
  kind?: "discretionary" | "rule_derived";
  capability?: string;
  outcome?: string;
  action_boundary_name?: string;
  authority_digest?: `sha256:${string}`;
  contract_digest?: `sha256:${string}`;
  rehearsal: "not_started" | "required" | "passed";
  state: "disabled";
};

export type DelegationDraft = {
  schema_version: typeof DELEGATION_DRAFT_VERSION;
  state: "disabled";
  job_name: string;
  job_intent: string;
  read: DelegationReadDraft;
  actions: DelegationActionDraft[];
  model_assist?: DelegationModelAssist;
  revision_digest: `sha256:${string}`;
  created_at: string;
  authority_granted: false;
  source_query_executed: false;
  explore_budget_consumed: false;
  source_database_changed: false;
};

export type DelegationAuthorityStatus = {
  read_active: boolean;
  proposal_active: boolean;
  delegated_approval_active: boolean;
  execution_active: boolean;
};

export type DelegationSummary = {
  job_name: string;
  job_intent: string;
  learn: {
    state: "disabled" | "active";
    boundary_name: string;
    representative_questions: string[];
  };
  propose: {
    state: "off" | "disabled" | "active";
    actions: DelegationActionDraft[];
  };
  human_required: string[];
  stages: {
    explore: "off" | "active";
    propose: "off" | "active";
    delegate: "off" | "active";
    apply: "off" | "active";
  };
};

export function buildDelegationDraft(input: {
  jobName?: string;
  jobIntent: string;
  boundaryName: string;
  workload: ReadWorkloadView;
  review: ReadWorkloadReview;
  actionIntents?: string[];
  actionDrafts?: Array<{ intent: string; draft: GuidedActionDraft }>;
  semanticActions?: Array<{
    intent: string;
    outcome: string;
    action_boundary_name: string;
    authority_digest: `sha256:${string}`;
  }>;
  modelAssist?: DelegationModelAssist;
  now?: string;
}): DelegationDraft {
  const jobIntent = reviewedText(
    input.jobIntent,
    "job intent",
    MAX_BOUNDARY_JOB_DESCRIPTION_CHARACTERS,
  );
  const jobName = safeJobName(input.jobName ?? jobNameFromIntent(jobIntent));
  const boundaryName = reviewedName(input.boundaryName, "read boundary name", 80);
  if (input.workload.analysis_id !== input.review.analysis_id
    || input.workload.analysis_digest !== input.review.analysis_digest) {
    throw new Error(
      "DELEGATION_READ_REVIEW_MISMATCH: the immutable read analysis does not match its reviewed disabled candidate.",
    );
  }
  const requestedActions = (input.actionIntents ?? []).map((intent) =>
    reviewedText(intent, "action intent", MAX_BOUNDARY_ACTION_INTENT_CHARACTERS));
  const requestedCounts = new Map<string, number>();
  for (const intent of requestedActions) {
    const key = normalizeComparableText(intent);
    requestedCounts.set(key, (requestedCounts.get(key) ?? 0) + 1);
  }
  const semanticByOutcome = new Map<string, DelegationActionDraft>();
  const semanticIntentCounts = new Map<string, number>();
  for (const semantic of input.semanticActions ?? []) {
    const outcome = reviewedName(semantic.outcome, "verified Action outcome", 200);
    if (semanticByOutcome.has(outcome)) {
      throw new Error(`DELEGATION_ACTION_OUTCOME_COLLISION: multiple entries bind verified Action outcome ${outcome}. Review the exact outcome before recording the job.`);
    }
    const intent = reviewedText(semantic.intent, "action intent", MAX_BOUNDARY_ACTION_INTENT_CHARACTERS);
    semanticByOutcome.set(outcome, {
      intent,
      kind: "rule_derived",
      outcome,
      action_boundary_name: reviewedName(semantic.action_boundary_name, "Action Boundary name", 128),
      authority_digest: reviewedDigest(semantic.authority_digest, "verified Action authority digest"),
      rehearsal: "passed",
      state: "disabled",
    });
    const key = normalizeComparableText(intent);
    semanticIntentCounts.set(key, (semanticIntentCounts.get(key) ?? 0) + 1);
  }
  const draftByIntent = new Map<string, GuidedActionDraft>();
  for (const { intent, draft } of input.actionDrafts ?? []) {
    const key = normalizeComparableText(reviewedText(intent, "action intent", MAX_BOUNDARY_ACTION_INTENT_CHARACTERS));
    if (draftByIntent.has(key) || semanticIntentCounts.has(key) || requestedCounts.get(key) !== 1) {
      throw new Error("DELEGATION_ACTION_BINDING_AMBIGUOUS: a legacy Action draft does not have one distinct requested intent. Review its exact binding; Runner will not choose, duplicate or drop a draft.");
    }
    draftByIntent.set(key, draft);
  }
  if (input.actionIntents !== undefined) {
    for (const [key, count] of semanticIntentCounts) {
      if (requestedCounts.get(key) !== count) {
        throw new Error("DELEGATION_ACTION_BINDING_AMBIGUOUS: the unbound intent list does not account for each outcome-bound Action exactly once. Review the requested Actions; Runner will not infer a missing pairing.");
      }
    }
  }
  // Outcome-bound entries carry their own descriptions. Intent text only
  // reconciles legacy placeholders; it must never select a semantic outcome.
  const actions = [
    ...semanticByOutcome.values(),
    ...requestedActions.filter((intent) => !semanticIntentCounts.has(normalizeComparableText(intent)))
      .map((intent): DelegationActionDraft => {
        const draft = draftByIntent.get(normalizeComparableText(intent));
        return {
          intent,
          ...(draft ? {
            kind: "discretionary" as const,
            capability: draft.capability,
            contract_digest: draft.contract_digest,
            rehearsal: draft.effect_preview ? "passed" as const : "required" as const,
          } : { rehearsal: "not_started" as const }),
          state: "disabled",
        };
      }),
  ];
  const read: DelegationReadDraft = {
    boundary_name: boundaryName,
    analysis_id: input.workload.analysis_id,
    analysis_digest: input.workload.analysis_digest,
    candidate_digest: input.review.candidate_digest,
    review_revision: input.review.review_revision,
    representative_questions: input.workload.analysis.allowed.map((entry) =>
      reviewedText(
        entry.description,
        "representative question",
        MAX_BOUNDARY_READ_QUESTION_CHARACTERS,
      )),
    state: "disabled_review",
  };
  const core = {
    schema_version: DELEGATION_DRAFT_VERSION,
    state: "disabled" as const,
    job_name: jobName,
    job_intent: jobIntent,
    read,
    actions,
    ...(input.modelAssist ? { model_assist: normalizeModelAssist(input.modelAssist) } : {}),
    created_at: input.now ?? new Date().toISOString(),
    authority_granted: false as const,
    source_query_executed: false as const,
    explore_budget_consumed: false as const,
    source_database_changed: false as const,
  };
  return {
    ...core,
    revision_digest: canonicalJsonDigest(core),
  };
}

export async function writeDelegationDraft(
  projectRootInput: string,
  draft: DelegationDraft,
): Promise<{ latest_path: string; revision_path: string }> {
  assertDelegationDraft(draft);
  const projectRoot = path.resolve(projectRootInput);
  const root = delegationRoot(projectRoot, draft.job_name);
  const revisionPath = path.join(
    root,
    "revisions",
    draft.revision_digest.slice("sha256:".length),
    "delegation.json",
  );
  const latestPath = path.join(root, "draft.json");
  const contents = json(draft);
  await writeImmutable(revisionPath, contents);
  await writeAtomic(latestPath, contents);
  return {
    latest_path: relativeProjectPath(projectRoot, latestPath),
    revision_path: relativeProjectPath(projectRoot, revisionPath),
  };
}

export async function readDelegationDraft(
  projectRootInput: string,
  jobName: string,
): Promise<DelegationDraft | undefined> {
  const projectRoot = path.resolve(projectRootInput);
  const filePath = path.join(delegationRoot(projectRoot, safeJobName(jobName)), "draft.json");
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    assertDelegationDraft(parsed);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function listDelegationDrafts(projectRootInput: string): Promise<DelegationDraft[]> {
  const projectRoot = path.resolve(projectRootInput);
  const root = path.join(projectRoot, ".synapsor", "delegations");
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const drafts: DelegationDraft[] = [];
  for (const entry of entries.sort()) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(entry)) continue;
    const draft = await readDelegationDraft(projectRoot, entry);
    if (draft) drafts.push(draft);
  }
  return drafts.sort((left, right) => right.created_at.localeCompare(left.created_at));
}

export function summarizeDelegation(
  draft: DelegationDraft,
  authority: DelegationAuthorityStatus,
): DelegationSummary {
  assertDelegationDraft(draft);
  const humanRequired = [
    ...(authority.read_active ? [] : ["Activate the exact Read Boundary revision."]),
    ...(draft.actions.length && !authority.proposal_active
      ? ["Rehearse and activate each exact proposal action revision."]
      : []),
    ...(authority.delegated_approval_active
      ? []
      : draft.actions.length
        ? ["Approve proposals manually unless a narrower deterministic policy is reviewed and activated."]
        : []),
    ...(authority.execution_active
      ? []
      : draft.actions.length
        ? ["Apply approved changes through a separately trusted executor; writeback remains off by default."]
        : []),
  ];
  return {
    job_name: draft.job_name,
    job_intent: draft.job_intent,
    learn: {
      state: authority.read_active ? "active" : "disabled",
      boundary_name: draft.read.boundary_name,
      representative_questions: [...draft.read.representative_questions],
    },
    propose: {
      state: draft.actions.length === 0
        ? "off"
        : authority.proposal_active
          ? "active"
          : "disabled",
      actions: structuredClone(draft.actions),
    },
    human_required: humanRequired,
    stages: {
      explore: authority.read_active ? "active" : "off",
      propose: authority.proposal_active ? "active" : "off",
      delegate: authority.delegated_approval_active ? "active" : "off",
      apply: authority.execution_active ? "active" : "off",
    },
  };
}

function assertDelegationDraft(value: unknown): asserts value is DelegationDraft {
  if (!isRecord(value)
    || value.schema_version !== DELEGATION_DRAFT_VERSION
    || value.state !== "disabled"
    || typeof value.job_name !== "string"
    || typeof value.job_intent !== "string"
    || !isRecord(value.read)
    || !Array.isArray(value.actions)
    || typeof value.revision_digest !== "string"
    || typeof value.created_at !== "string"
    || value.authority_granted !== false
    || value.source_query_executed !== false
    || value.explore_budget_consumed !== false
    || value.source_database_changed !== false) {
    throw new Error("DELEGATION_DRAFT_INVALID: managed delegation metadata is invalid.");
  }
  safeJobName(value.job_name);
  const unsigned = { ...value } as Record<string, unknown>;
  delete unsigned.revision_digest;
  if (canonicalJsonDigest(unsigned) !== value.revision_digest) {
    throw new Error("DELEGATION_DRAFT_CHANGED: the stored delegation metadata does not match its digest.");
  }
}

function normalizeModelAssist(value: DelegationModelAssist): DelegationModelAssist {
  if (value.provider !== "openai"
    && value.provider !== "anthropic"
    && value.provider !== "openrouter"
    && value.provider !== "openai_compatible") {
    throw new Error("DELEGATION_MODEL_PROVIDER_INVALID: model assistance provider is not supported.");
  }
  return {
    provider: value.provider,
    model: reviewedText(value.model, "model name", 128),
    structural_metadata_egress_acknowledged: true,
  };
}

function jobNameFromIntent(intent: string): string {
  const stem = intent.toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64)
    .replace(/_+$/g, "");
  return stem || "agent_job";
}

function safeJobName(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error(
      "DELEGATION_JOB_NAME_INVALID: use 1 through 64 lower-case letters, numbers, underscores, or hyphens, starting with a letter.",
    );
  }
  return normalized;
}

function reviewedName(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(normalized) || normalized.length > maximum) {
    throw new Error(`DELEGATION_NAME_INVALID: ${label} is invalid.`);
  }
  return normalized;
}

function reviewedDigest(value: string, label: string): `sha256:${string}` {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`DELEGATION_DIGEST_INVALID: ${label} must be one canonical sha256 digest.`);
  }
  return value as `sha256:${string}`;
}

function reviewedText(value: string, label: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`DELEGATION_TEXT_INVALID: ${label} must be 1 through ${maximum} safe characters.`);
  }
  if (/(?:postgres|mysql):\/\/|BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key\s*[:=]|bearer\s+[A-Za-z0-9._-]+/i.test(normalized)) {
    throw new Error(`DELEGATION_SECRET_BLOCKED: ${label} appears to contain secret material.`);
  }
  return normalized;
}

function normalizeComparableText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function delegationRoot(projectRoot: string, jobName: string): string {
  return path.join(projectRoot, ".synapsor/delegations", safeJobName(jobName));
}

async function writeImmutable(filePath: string, contents: string): Promise<void> {
  try {
    const existing = await fs.readFile(filePath, "utf8");
    if (existing !== contents) {
      throw new Error("DELEGATION_REVISION_COLLISION: an immutable revision path contains different content.");
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeAtomic(filePath, contents);
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, filePath);
}

function relativeProjectPath(projectRoot: string, target: string): string {
  const relative = path.relative(projectRoot, target).replace(/\\/g, "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error("DELEGATION_PATH_ESCAPE: artifact leaves the project.");
  }
  return relative.startsWith("./") ? relative : `./${relative}`;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
