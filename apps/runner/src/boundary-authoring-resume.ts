import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { AskHistoryTurn } from "./model-ask.js";
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
    provider: "openai" | "anthropic" | "openai_compatible";
    name: string;
    structural_metadata_egress_acknowledged: true;
  };
  conversation: AskHistoryTurn[];
  policy_source_session?: string;
  /** Concise model-planned Read behavior retained before an analysis exists. */
  read_intent?: string;
  read?: BoundaryAuthoringResumeRead;
  action?: BoundaryAuthoringResumeAction;
  client_handoff?: BoundaryAuthoringClientHandoff;
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
  read?: BoundaryAuthoringResumeRead;
  action?: BoundaryAuthoringResumeAction;
  clientHandoff?: BoundaryAuthoringClientHandoff;
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
    ...(input.action ? { action: normalizeAction(input.action) } : {}),
    ...(input.clientHandoff ? { client_handoff: normalizeClientHandoff(input.clientHandoff) } : {}),
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

/** Retain business context, never old validation or authority, after a rescan. */
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
    readIntent: state.read_intent, previous: state,
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
  if (value.read_intent !== undefined) {
    if (typeof value.read_intent !== "string") {
      throw new Error("BOUNDARY_AUTHORING_RESUME_INVALID: Read intent is invalid.");
    }
    reviewedText(value.read_intent, "Read intent", MAX_BOUNDARY_READ_QUESTION_CHARACTERS);
  }
  if (value.action !== undefined) normalizeAction(value.action as BoundaryAuthoringResumeAction);
  if (value.stage === "client_setup" && value.client_handoff === undefined) throw new Error("Client continuation requires its exact reviewed authority.");
  if (value.client_handoff !== undefined) normalizeClientHandoff(value.client_handoff as BoundaryAuthoringClientHandoff);
  assertNoPrivateRuntimeMaterial(value);
  const unsigned = { ...value } as Record<string, unknown>;
  delete unsigned.revision_digest;
  if (canonicalJsonDigest(unsigned) !== value.revision_digest) {
    throw new Error("BOUNDARY_AUTHORING_RESUME_CHANGED: the saved authoring state does not match its digest.");
  }
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
  if (value !== "openai" && value !== "anthropic" && value !== "openai_compatible") {
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
