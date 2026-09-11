import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { AskHistoryTurn } from "./model-ask.js";
import { isAuthoringClientPlan, type AuthoringClientPlan } from "./authoring-client-plan.js";
import { parseActionRuleAuthoringCheckpoint, type ActionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import {
  createModelAuthoringConversation,
  modelAuthoringHistory,
} from "./model-authoring-conversation.js";
import {
  MAX_BOUNDARY_ACTION_INTENT_CHARACTERS,
  MAX_BOUNDARY_JOB_DESCRIPTION_CHARACTERS,
  MAX_BOUNDARY_READ_QUESTION_CHARACTERS,
} from "./boundary-authoring-limits.js";

export const BOUNDARY_AUTHORING_RESUME_VERSION = "synapsor.boundary-authoring-resume.v1" as const;

export type BoundaryAuthoringResumeStage =
  | "planning"
  | "read_mapping"
  | "action_drafting"
  | "authority_review"
  | "client_setup";

export type BoundaryAuthoringClientHandoff = {
  read_digest: `sha256:${string}`;
  action_digest?: `sha256:${string}`;
};

export type BoundaryAuthoringResumeBinding = {
  boundary_name: string;
  generation_lock_fingerprint: `sha256:${string}`;
  schema_fingerprint: `sha256:${string}`;
  role_posture_fingerprint: `sha256:${string}`;
};

export type BoundaryAuthoringResumeRead = {
  analysis_id: string;
  analysis_digest: `sha256:${string}`;
};

export type BoundaryAuthoringActionRemoval = { outcome: string; authority_name: string; draft_digest: `sha256:${string}` };
export type BoundaryAuthoringActionRevision = {
  outcome: string;
  instruction: string;
  baseline_digest: `sha256:${string}`;
  checkpoint?: ActionRuleAuthoringCheckpoint;
};

/** A cited policy requirement that needs one new disabled Action draft. */
export type BoundaryAuthoringActionAddition = {
  policy_source_digest: `sha256:${string}`;
  source_ranges: Array<{ start: number; end: number }>;
  /** Existing job identities retained while one new Action is drafted. */
  retained_action: BoundaryAuthoringResumeAction;
};

/** Replay components only for the exact saved instruction and baseline. */
export function prepareBoundaryActionRevision(
  next: Omit<BoundaryAuthoringActionRevision, "checkpoint">,
  pending?: BoundaryAuthoringActionRevision,
): BoundaryAuthoringActionRevision {
  const checked = normalizeActionRevision({ outcome: next.outcome, instruction: next.instruction, baseline_digest: next.baseline_digest });
  if (!pending) return checked;
  if (pending.outcome !== checked.outcome || pending.baseline_digest !== checked.baseline_digest) {
    throw new Error("ACTION_REVISION_BASELINE_CHANGED: The saved edit belongs to another draft revision. Keep it pending and review the current draft before retrying; no saved or active authority was overwritten.");
  }
  return pending.instruction === checked.instruction ? pending : checked;
}

export type BoundaryAuthoringResumeAction = {
  intent: string;
  outcome?: string;
  strategy?: "discretionary" | "rule_derived";
  checkpoint?: ActionRuleAuthoringCheckpoint;
  intents?: string[];
  completed_outcomes?: string[];
};

export type BoundaryAuthoringResumeState = {
  schema_version: typeof BOUNDARY_AUTHORING_RESUME_VERSION;
  state: "in_progress";
  binding: BoundaryAuthoringResumeBinding;
  stage: BoundaryAuthoringResumeStage;
  job_intent: string;
  model: {
    provider: "openai" | "anthropic" | "openrouter" | "openai_compatible";
    name: string;
    structural_metadata_egress_acknowledged: true;
  };
  conversation: AskHistoryTurn[];
  policy_source_session?: string;
  /** Concise model-planned Read behavior retained before an analysis exists. */
  read_intent?: string;
  /** Unclassified edit of the saved job; never replaces its canonical intent. */
  pending_job_revision?: string;
  /** Requested edit of the exact saved candidate, not a new workload or consent. */
  pending_read_revision?: string;
  /** Exact private Read mapping covered by this saved model's metadata permission. */
  private_read_metadata_digest?: `sha256:${string}`;
  /** Custom provider metadata consent is bound to its endpoint without saving a URL. */
  metadata_destination_digest?: `sha256:${string}`;
  /** Exact outcome awaiting a separately reviewed removal, never a new action intent. */
  pending_action_removal?: BoundaryAuthoringActionRemoval;
  pending_action_revision?: BoundaryAuthoringActionRevision;
  /** A cited policy behavior awaiting bounded planning as one new Action. */
  pending_action_addition?: BoundaryAuthoringActionAddition;
  read?: BoundaryAuthoringResumeRead;
  action?: BoundaryAuthoringResumeAction;
  client_handoff?: BoundaryAuthoringClientHandoff;
  intended_client?: AuthoringClientPlan;
  created_at: string;
  updated_at: string;
  authority_granted: false;
  source_query_executed: false;
  source_database_changed: false;
  revision_digest: `sha256:${string}`;
};

export type BoundaryAuthoringResumeLoad =
  | { status: "none" }
  | { status: "ready"; value: BoundaryAuthoringResumeState }
  | { status: "stale"; reason: string; value: BoundaryAuthoringResumeState }
  | { status: "invalid"; reason: string };

export function buildBoundaryAuthoringResumeState(input: {
  binding: BoundaryAuthoringResumeBinding;
  stage: BoundaryAuthoringResumeStage;
  jobIntent: string;
  provider: BoundaryAuthoringResumeState["model"]["provider"];
  model: string;
  conversation?: readonly AskHistoryTurn[];
  policySourceSession?: string;
  readIntent?: string;
  pendingJobRevision?: string;
  pendingReadRevision?: string;
  privateReadMetadataDigest?: `sha256:${string}`;
  metadataDestinationDigest?: `sha256:${string}`;
  pendingActionRemoval?: BoundaryAuthoringActionRemoval;
  pendingActionRevision?: BoundaryAuthoringActionRevision;
  pendingActionAddition?: BoundaryAuthoringActionAddition;
  read?: BoundaryAuthoringResumeRead;
  action?: BoundaryAuthoringResumeAction;
  clientHandoff?: BoundaryAuthoringClientHandoff;
  intendedClient?: AuthoringClientPlan;
  previous?: BoundaryAuthoringResumeState;
  now?: string;
}): BoundaryAuthoringResumeState {
  const now = input.now ?? new Date().toISOString();
  const conversation = modelAuthoringHistory(createModelAuthoringConversation(input.conversation));
  const core = {
    schema_version: BOUNDARY_AUTHORING_RESUME_VERSION,
    state: "in_progress" as const,
    binding: normalizeBinding(input.binding),
    stage: input.stage,
    job_intent: reviewedText(
      input.jobIntent,
      "job intent",
      MAX_BOUNDARY_JOB_DESCRIPTION_CHARACTERS,
    ),
    model: {
      provider: reviewedProvider(input.provider),
      name: reviewedText(input.model, "model name", 128),
      structural_metadata_egress_acknowledged: true as const,
    },
    conversation,
    ...(input.policySourceSession ? { policy_source_session: normalizeSourceSession(input.policySourceSession) } : {}),
    ...(input.readIntent
      ? {
          read_intent: reviewedText(
            input.readIntent,
            "Read intent",
            MAX_BOUNDARY_READ_QUESTION_CHARACTERS,
          ),
        }
      : {}),
    ...(input.read ? { read: normalizeRead(input.read) } : {}),
    ...(input.pendingJobRevision ? { pending_job_revision: reviewedText(input.pendingJobRevision,
      "Job revision request", MAX_BOUNDARY_JOB_DESCRIPTION_CHARACTERS) } : {}),
    ...(input.pendingReadRevision ? { pending_read_revision: reviewedText(input.pendingReadRevision,
      "Read revision request", MAX_BOUNDARY_JOB_DESCRIPTION_CHARACTERS) } : {}),
    ...(input.privateReadMetadataDigest ? { private_read_metadata_digest: normalizePrivateReadMetadataDigest(input.privateReadMetadataDigest) } : {}),
    ...(input.metadataDestinationDigest ? { metadata_destination_digest: normalizePrivateReadMetadataDigest(input.metadataDestinationDigest) } : {}),
    ...(input.pendingActionRemoval ? { pending_action_removal: normalizeActionRemoval(input.pendingActionRemoval) } : {}),
    ...(input.pendingActionRevision ? { pending_action_revision: normalizeActionRevision(input.pendingActionRevision) } : {}),
    ...(input.pendingActionAddition ? { pending_action_addition: normalizeActionAddition(input.pendingActionAddition) } : {}),
    ...(input.action ? { action: normalizeAction(input.action) } : {}),
    ...(input.clientHandoff ? { client_handoff: normalizeClientHandoff(input.clientHandoff) } : {}),
    ...(input.intendedClient ? { intended_client: normalizeIntendedClient(input.intendedClient) } : {}),
    created_at: input.previous?.created_at ?? now,
    updated_at: now,
    authority_granted: false as const,
    source_query_executed: false as const,
    source_database_changed: false as const,
  };
  assertNoPrivateRuntimeMaterial(core);
  return {
    ...core,
    revision_digest: canonicalJsonDigest(core),
  };
}

export async function writeBoundaryAuthoringResumeState(
  projectRootInput: string,
  state: BoundaryAuthoringResumeState,
): Promise<string> {
  assertBoundaryAuthoringResumeState(state);
  const projectRoot = path.resolve(projectRootInput);
  const filePath = resumePath(projectRoot);
  await writeAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
  return relativeProjectPath(projectRoot, filePath);
}

export async function readBoundaryAuthoringResumeState(
  projectRootInput: string,
  binding: BoundaryAuthoringResumeBinding,
): Promise<BoundaryAuthoringResumeLoad> {
  const projectRoot = path.resolve(projectRootInput);
  let source: string;
  try {
    source = await fs.readFile(resumePath(projectRoot), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "none" };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
    assertBoundaryAuthoringResumeState(parsed);
  } catch (error) {
    return {
      status: "invalid",
      reason: boundaryAuthoringResumeInvalidReason(error),
    };
  }
  const expected = normalizeBinding(binding);
  const differences = [
    ...(parsed.binding.boundary_name !== expected.boundary_name ? ["selected Boundary changed"] : []),
    ...(parsed.binding.generation_lock_fingerprint !== expected.generation_lock_fingerprint
      ? ["generation lock changed"] : []),
    ...(parsed.binding.schema_fingerprint !== expected.schema_fingerprint ? ["database schema changed"] : []),
    ...(parsed.binding.role_posture_fingerprint !== expected.role_posture_fingerprint
      ? ["database role, grants, ownership, or RLS posture changed"] : []),
  ];
  return differences.length
    ? { status: "stale", reason: differences.join("; "), value: parsed }
    : { status: "ready", value: parsed };
}

export async function clearBoundaryAuthoringResumeState(projectRootInput: string): Promise<void> {
  await fs.rm(resumePath(path.resolve(projectRootInput)), { force: true });
}

/** Retain business context and untrusted draft components after a rescan.
 * Their old context digest requires fresh validation; analysis, consent and
 * authority are never carried into the new review. */
export function revalidateBoundaryAuthoringResume(
  state: BoundaryAuthoringResumeState,
  binding: BoundaryAuthoringResumeBinding,
): BoundaryAuthoringResumeState {
  assertBoundaryAuthoringResumeState(state);
  if (state.binding.boundary_name !== binding.boundary_name) {
    throw new Error("The saved job belongs to a different Read Boundary.");
  }
  return buildBoundaryAuthoringResumeState({
    binding, stage: "planning", jobIntent: state.job_intent,
    provider: state.model.provider, model: state.model.name,
    conversation: state.conversation, policySourceSession: state.policy_source_session,
    readIntent: state.read_intent,
    pendingJobRevision: state.pending_job_revision,
    pendingReadRevision: state.pending_read_revision,
    pendingActionRemoval: state.pending_action_removal,
    ...(state.pending_action_revision ? { pendingActionRevision: { ...state.pending_action_revision, checkpoint: undefined } } : {}),
    pendingActionAddition: state.pending_action_addition,
    intendedClient: state.intended_client,
    ...(state.action ? {
      action: {
        intent: state.action.intent,
        ...(state.action.outcome ? { outcome: state.action.outcome } : {}),
        ...(state.action.strategy ? { strategy: state.action.strategy } : {}),
        ...(state.action.intents ? { intents: state.action.intents } : {}),
        ...(state.action.completed_outcomes ? { completed_outcomes: state.action.completed_outcomes } : {}),
        ...(state.action.checkpoint ? { checkpoint: state.action.checkpoint } : {}),
      },
    } : {}),
    previous: state,
  });
}

export function assertBoundaryAuthoringResumeState(
  value: unknown,
): asserts value is BoundaryAuthoringResumeState {
  if (!isRecord(value)
    || value.schema_version !== BOUNDARY_AUTHORING_RESUME_VERSION
    || value.state !== "in_progress"
    || !isRecord(value.binding)
    || !isRecord(value.model)
    || typeof value.model.name !== "string"
    || !Array.isArray(value.conversation)
    || typeof value.job_intent !== "string"
    || typeof value.stage !== "string"
    || typeof value.created_at !== "string"
    || typeof value.updated_at !== "string"
    || typeof value.revision_digest !== "string"
    || value.authority_granted !== false
    || value.source_query_executed !== false
    || value.source_database_changed !== false) {
    throw new Error("BOUNDARY_AUTHORING_RESUME_INVALID: the saved authoring state is invalid.");
  }
  if (!["planning", "read_mapping", "action_drafting", "authority_review", "client_setup"].includes(value.stage)) {
    throw new Error("BOUNDARY_AUTHORING_RESUME_INVALID: the saved authoring stage is invalid.");
  }
  normalizeBinding(value.binding as BoundaryAuthoringResumeBinding);
  reviewedText(value.job_intent, "job intent", MAX_BOUNDARY_JOB_DESCRIPTION_CHARACTERS);
  reviewedProvider(value.model.provider);
  reviewedText(value.model.name, "model name", 128);
  if (value.model.structural_metadata_egress_acknowledged !== true) {
    throw new Error("BOUNDARY_AUTHORING_RESUME_INVALID: model metadata permission is invalid.");
  }
  const normalizedConversation = modelAuthoringHistory(
    createModelAuthoringConversation(value.conversation as AskHistoryTurn[]),
  );
  if (canonicalJsonDigest(normalizedConversation) !== canonicalJsonDigest(value.conversation)) {
    throw new Error("BOUNDARY_AUTHORING_RESUME_INVALID: saved conversation history exceeds its reviewed bounds.");
  }
  if (value.read !== undefined) normalizeRead(value.read as BoundaryAuthoringResumeRead);
  if (value.policy_source_session !== undefined) normalizeSourceSession(value.policy_source_session);
  if (value.intended_client !== undefined) normalizeIntendedClient(value.intended_client);
  if (value.read_intent !== undefined) {
    if (typeof value.read_intent !== "string") {
      throw new Error("BOUNDARY_AUTHORING_RESUME_INVALID: Read intent is invalid.");
    }
    reviewedText(value.read_intent, "Read intent", MAX_BOUNDARY_READ_QUESTION_CHARACTERS);
  }
  if (value.action !== undefined) normalizeAction(value.action as BoundaryAuthoringResumeAction);
  if (value.pending_job_revision !== undefined) {
    if (typeof value.pending_job_revision !== "string") throw new Error("BOUNDARY_AUTHORING_RESUME_INVALID: Job revision request is invalid.");
    reviewedText(value.pending_job_revision, "Job revision request", MAX_BOUNDARY_JOB_DESCRIPTION_CHARACTERS);
  }
  if (value.pending_read_revision !== undefined) {
    if (typeof value.pending_read_revision !== "string") throw new Error("BOUNDARY_AUTHORING_RESUME_INVALID: Read revision request is invalid.");
    reviewedText(value.pending_read_revision, "Read revision request", MAX_BOUNDARY_JOB_DESCRIPTION_CHARACTERS);
  }
  if (value.pending_action_removal !== undefined) {
    normalizeActionRemoval(value.pending_action_removal);
  }
  if (value.private_read_metadata_digest !== undefined) normalizePrivateReadMetadataDigest(value.private_read_metadata_digest);
  if (value.metadata_destination_digest !== undefined) normalizePrivateReadMetadataDigest(value.metadata_destination_digest);
  if (value.pending_action_revision !== undefined) normalizeActionRevision(value.pending_action_revision);
  if (value.pending_action_addition !== undefined) normalizeActionAddition(value.pending_action_addition);
  if (value.stage === "client_setup" && value.client_handoff === undefined) throw new Error("Client continuation requires its exact reviewed authority.");
  if (value.client_handoff !== undefined) normalizeClientHandoff(value.client_handoff as BoundaryAuthoringClientHandoff);
  assertNoPrivateRuntimeMaterial(value);
  const unsigned = { ...value } as Record<string, unknown>;
  delete unsigned.revision_digest;
  if (canonicalJsonDigest(unsigned) !== value.revision_digest) {
    throw new Error("BOUNDARY_AUTHORING_RESUME_CHANGED: the saved authoring state does not match its digest.");
  }
}

function normalizePrivateReadMetadataDigest(value: unknown): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error("BOUNDARY_AUTHORING_RESUME_INVALID: private Read metadata permission is invalid.");
  }
  return value as `sha256:${string}`;
}

function normalizeActionRevision(value: unknown): BoundaryAuthoringActionRevision {
  if (!isRecord(value) || typeof value.outcome !== "string" || typeof value.instruction !== "string"
    || typeof value.baseline_digest !== "string"
    || Object.keys(value).some(key => !["outcome", "instruction", "baseline_digest", "checkpoint"].includes(key))) {
    throw new Error("BOUNDARY_AUTHORING_RESUME_INVALID: Action revision checkpoint is invalid.");
  }
  return { outcome: reviewedName(value.outcome, "Action revision outcome", 200),
    instruction: reviewedText(value.instruction, "Action revision request", MAX_BOUNDARY_ACTION_INTENT_CHARACTERS),
    baseline_digest: reviewedDigest(value.baseline_digest, "Action revision baseline"),
    ...(value.checkpoint ? { checkpoint: parseActionRuleAuthoringCheckpoint(value.checkpoint) } : {}),
  };
}

function normalizeActionRemoval(value: unknown): BoundaryAuthoringActionRemoval {
  if (!isRecord(value) || typeof value.outcome !== "string" || typeof value.authority_name !== "string" || typeof value.draft_digest !== "string"
    || Object.keys(value).some(key => !["outcome", "authority_name", "draft_digest"].includes(key))) {
    throw new Error("BOUNDARY_AUTHORING_RESUME_INVALID: Action removal review is invalid.");
  }
  return { outcome: reviewedText(value.outcome, "Action removal outcome", 256),
    authority_name: reviewedText(value.authority_name, "Action removal authority", 256),
    draft_digest: reviewedDigest(value.draft_digest, "Action removal revision") };
}

function normalizeActionAddition(value: unknown): BoundaryAuthoringActionAddition {
  if (!isRecord(value) || typeof value.policy_source_digest !== "string" || !Array.isArray(value.source_ranges)
    || !isRecord(value.retained_action)
    || value.source_ranges.length < 1 || value.source_ranges.length > 16
    || Object.keys(value).some((key) => !["policy_source_digest", "source_ranges", "retained_action"].includes(key))) {
    throw new Error("BOUNDARY_AUTHORING_RESUME_INVALID: Action addition request is invalid.");
  }
  const sourceRanges: Array<{ start: number; end: number }> = [];
  for (const entry of value.source_ranges) {
    if (!isRecord(entry) || Object.keys(entry).some((key) => key !== "start" && key !== "end")
      || typeof entry.start !== "number" || typeof entry.end !== "number"
      || !Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.end)
      || entry.start < 1 || entry.end < entry.start || entry.end > 100_000) {
      throw new Error("BOUNDARY_AUTHORING_RESUME_INVALID: Action addition source range is invalid.");
    }
    sourceRanges.push({ start: entry.start, end: entry.end });
  }
  if (new Set(sourceRanges.map((entry) => `${entry.start}:${entry.end}`)).size !== sourceRanges.length) {
    throw new Error("BOUNDARY_AUTHORING_RESUME_INVALID: Action addition source ranges must be unique.");
  }
  return {
    policy_source_digest: reviewedDigest(value.policy_source_digest, "Action addition policy source"),
    source_ranges: sourceRanges.sort((left, right) => left.start - right.start || left.end - right.end),
    retained_action: normalizeAction(value.retained_action as BoundaryAuthoringResumeAction),
  };
}

function normalizeIntendedClient(value: unknown): AuthoringClientPlan {
  if (!isAuthoringClientPlan(value)) throw new Error("Invalid saved client preference; choose a supported client during setup.");
  return value;
}

function normalizeClientHandoff(value: BoundaryAuthoringClientHandoff): BoundaryAuthoringClientHandoff {
  return { read_digest: reviewedDigest(value.read_digest, "client Read digest"),
    ...(value.action_digest ? { action_digest: reviewedDigest(value.action_digest, "client Action digest") } : {}),
  };
}

function normalizeSourceSession(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/u.test(value)) throw new Error("Saved policy source session is invalid.");
  return value;
}

function normalizeBinding(value: BoundaryAuthoringResumeBinding): BoundaryAuthoringResumeBinding {
  return {
    boundary_name: reviewedName(value.boundary_name, "Boundary name", 128),
    generation_lock_fingerprint: reviewedDigest(value.generation_lock_fingerprint, "generation lock fingerprint"),
    schema_fingerprint: reviewedDigest(value.schema_fingerprint, "schema fingerprint"),
    role_posture_fingerprint: reviewedDigest(value.role_posture_fingerprint, "role posture fingerprint"),
  };
}

function normalizeRead(value: BoundaryAuthoringResumeRead): BoundaryAuthoringResumeRead {
  return {
    analysis_id: reviewedName(value.analysis_id, "Read analysis id", 128),
    analysis_digest: reviewedDigest(value.analysis_digest, "Read analysis digest"),
  };
}

function normalizeAction(value: BoundaryAuthoringResumeAction): BoundaryAuthoringResumeAction {
  if (value.strategy !== undefined
    && value.strategy !== "discretionary"
    && value.strategy !== "rule_derived") {
    throw new Error("BOUNDARY_AUTHORING_RESUME_INVALID: Action strategy is invalid.");
  }
  if (value.intents && (!Array.isArray(value.intents) || value.intents.length < 1 || value.intents.length > 8)) {
    throw new Error("BOUNDARY_AUTHORING_RESUME_INVALID: Action intents must contain 1-8 jobs.");
  }
  if (value.completed_outcomes && (!Array.isArray(value.completed_outcomes) || value.completed_outcomes.length > (value.intents?.length ?? 1))) {
    throw new Error("BOUNDARY_AUTHORING_RESUME_INVALID: completed outcomes exceed the saved job.");
  }
  return {
    intent: reviewedText(value.intent, "Action intent", MAX_BOUNDARY_ACTION_INTENT_CHARACTERS),
    ...(value.outcome ? { outcome: reviewedName(value.outcome, "Action outcome", 200) } : {}),
    ...(value.strategy ? { strategy: value.strategy } : {}),
    ...(value.checkpoint ? { checkpoint: parseActionRuleAuthoringCheckpoint(value.checkpoint) } : {}),
    ...(value.intents ? { intents: value.intents.map((intent) => reviewedText(intent, "Action intent", MAX_BOUNDARY_ACTION_INTENT_CHARACTERS)) } : {}),
    ...(value.completed_outcomes ? { completed_outcomes: value.completed_outcomes.map((outcome) => reviewedName(outcome, "Action outcome", 200)) } : {}),
  };
}

function reviewedProvider(
  value: unknown,
): BoundaryAuthoringResumeState["model"]["provider"] {
  if (value !== "openai" && value !== "anthropic" && value !== "openrouter" && value !== "openai_compatible") {
    throw new Error("BOUNDARY_AUTHORING_RESUME_INVALID: the saved model provider is invalid.");
  }
  return value;
}

function reviewedName(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized
    || normalized.length > maximum
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(normalized)) {
    throw new Error(`BOUNDARY_AUTHORING_RESUME_INVALID: ${label} is invalid.`);
  }
  return normalized;
}

function reviewedDigest(value: string, label: string): `sha256:${string}` {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`BOUNDARY_AUTHORING_RESUME_INVALID: ${label} is invalid.`);
  }
  return value as `sha256:${string}`;
}

function reviewedText(value: string, label: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`BOUNDARY_AUTHORING_RESUME_INVALID: ${label} must be 1 through ${maximum} safe characters.`);
  }
  return normalized;
}

function assertNoPrivateRuntimeMaterial(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (/(?:postgres|mysql):\/\/|https?:\/\/(?!127\.0\.0\.1(?::\d+)?(?:\/|"))|BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key\s*[:=]|bearer\s+[A-Za-z0-9._-]+/iu.test(serialized)) {
    throw new Error(
      "BOUNDARY_AUTHORING_RESUME_PRIVATE_MATERIAL_BLOCKED: credentials, endpoint URLs, and private keys cannot be saved in Boundary-authoring state.",
    );
  }
  const concreteIdentity = [...serialized.matchAll(
    /\b(?:tenant|principal)(?:[_ -]?id)?\s*(?:=|:|is)\s*["']?([A-Za-z0-9_-]{3,})/giu,
  )].some((match) => !/^(?:runner(?:-injected)?|trusted|runtime|environment|injected|symbolic|reviewed|unknown|unset|required|outside)$/iu.test(match[1]!));
  if (concreteIdentity) {
    throw new Error(
      "BOUNDARY_AUTHORING_RESUME_TRUSTED_IDENTITY_BLOCKED: concrete tenant or principal values cannot be saved in Boundary-authoring state.",
    );
  }
}

function boundaryAuthoringResumeInvalidReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return "The saved authoring state failed its integrity check.";
  }
  if (error.message.startsWith("BOUNDARY_AUTHORING_RESUME_CHANGED:")) {
    return "The saved authoring state changed after Runner wrote its integrity digest.";
  }
  if (error.message.startsWith("BOUNDARY_AUTHORING_RESUME_PRIVATE_MATERIAL_BLOCKED:")) {
    return "The saved authoring state contains prohibited credential or endpoint material.";
  }
  if (error.message.startsWith("BOUNDARY_AUTHORING_RESUME_TRUSTED_IDENTITY_BLOCKED:")) {
    return "The saved authoring state contains a concrete trusted tenant or principal value.";
  }
  return "The saved authoring state failed its schema or integrity check.";
}

function resumePath(projectRoot: string): string {
  return path.join(projectRoot, ".synapsor", "boundary-authoring", "resume.json");
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, filePath);
}

function relativeProjectPath(projectRoot: string, target: string): string {
  const relative = path.relative(projectRoot, target).replace(/\\/gu, "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error("BOUNDARY_AUTHORING_RESUME_PATH_ESCAPE: saved state leaves the selected project.");
  }
  return relative.startsWith("./") ? relative : `./${relative}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
