import fs from "node:fs/promises";
import path from "node:path";
import {
  actionBoundaryAuthorityDigestV1,
  actionBoundaryReadDependencyDigestV1,
  actionBoundaryVersion,
  canonicalJsonDigest,
  normalizeActionBoundaryAuthorityV1,
  type ActionBoundaryApprovalPolicyReferenceV1,
  type ActionBoundaryAuthorityV1,
  type ActionBoundaryCapabilityReferenceV1,
  type ActionBoundaryExecutionProfileReferenceV1,
  type ActionBoundaryReadDependencyV1,
  type ActionBoundarySharedLimitV1,
} from "@synapsor-runner/protocol";

export const ACTION_BOUNDARY_VERSION = actionBoundaryVersion;
export const DEFAULT_ACTION_BOUNDARY_NAME = "default_action_boundary" as const;

export type ActionBoundaryReadDependency = ActionBoundaryReadDependencyV1;
export type ActionBoundaryCapabilityReference = ActionBoundaryCapabilityReferenceV1;
export type ActionBoundaryApprovalPolicyReference = ActionBoundaryApprovalPolicyReferenceV1;
export type ActionBoundaryExecutionProfileReference = ActionBoundaryExecutionProfileReferenceV1;
export type ActionBoundarySharedLimit = ActionBoundarySharedLimitV1;
export type ActionBoundaryAuthority = ActionBoundaryAuthorityV1;

export type ActionBoundaryDraft = {
  schema_version: typeof ACTION_BOUNDARY_VERSION;
  state: "disabled";
  name: string;
  label: string;
  job_intent: string;
  authority: ActionBoundaryAuthority;
  digest: `sha256:${string}`;
  created_at: string;
};

export type ActionBoundaryActivation = Omit<ActionBoundaryDraft, "state" | "created_at"> & {
  state: "active";
  actor: string;
  activated_at: string;
};

export type ActionBoundaryStatus = {
  draft?: ActionBoundaryDraft;
  active?: ActionBoundaryActivation;
  synthesized_from_legacy_actions: boolean;
};

export type ActionBoundaryCandidate = {
  read_dependency: ActionBoundaryReadDependency;
  capability: Omit<ActionBoundaryCapabilityReference, "read_dependency_digest">;
  approval_policy: Omit<ActionBoundaryApprovalPolicyReference, "digest"> & {
    authority: unknown;
  };
  execution_profile: Omit<ActionBoundaryExecutionProfileReference, "digest"> & {
    authority: unknown;
  };
};

export type ActionBoundaryPublication = {
  activation: ActionBoundaryActivation;
  revision_path: string;
  active_path: string;
  rollback: () => Promise<void>;
};

export function actionBoundaryReadDependencyDigest(
  dependency: ActionBoundaryReadDependency,
): `sha256:${string}` {
  return actionBoundaryReadDependencyDigestV1(dependency);
}

export function actionBoundaryAuthorityDigest(
  authority: ActionBoundaryAuthority,
): `sha256:${string}` {
  return actionBoundaryAuthorityDigestV1(authority);
}

export function buildActionBoundaryDraft(input: {
  name?: string;
  label?: string;
  jobIntent?: string;
  candidates: ActionBoundaryCandidate[];
  sharedLimits?: ActionBoundarySharedLimit[];
  now?: string;
}): ActionBoundaryDraft {
  const name = safeBoundaryName(input.name ?? DEFAULT_ACTION_BOUNDARY_NAME);
  const label = reviewedText(input.label ?? "Default action boundary", "action boundary label", 120);
  const jobIntent = reviewedText(
    input.jobIntent ?? "Allow the reviewed agent actions collected for this project.",
    "action boundary job intent",
    500,
  );
  const capabilityNames = new Set<string>();
  for (const candidate of input.candidates) {
    if (capabilityNames.has(candidate.capability.capability)) {
      throw new Error(`ACTION_BOUNDARY_CAPABILITY_DUPLICATE: ${candidate.capability.capability}.`);
    }
    capabilityNames.add(candidate.capability.capability);
  }
  const readDependencies = uniqueByDigest(
    input.candidates.map((candidate) => normalizeReadDependency(candidate.read_dependency)),
  );
  const authority = normalizeAuthority({
    read_dependencies: readDependencies,
    capabilities: input.candidates.map((candidate) => ({
      ...candidate.capability,
      capability: safeCapabilityName(candidate.capability.capability),
      resource: safeResourceName(candidate.capability.resource),
      contract_path: safeProjectRelativePath(candidate.capability.contract_path),
      read_dependency_digest: actionBoundaryReadDependencyDigest(candidate.read_dependency),
    })),
    approval_policies: input.candidates.map((candidate) => ({
      capability: safeCapabilityName(candidate.approval_policy.capability),
      mode: candidate.approval_policy.mode,
      digest: canonicalJsonDigest(candidate.approval_policy.authority),
    })),
    execution_profiles: input.candidates.map((candidate) => ({
      capability: safeCapabilityName(candidate.execution_profile.capability),
      authority_posture: candidate.execution_profile.authority_posture,
      writeback_mode: candidate.execution_profile.writeback_mode,
      ...(candidate.execution_profile.writeback_executor
        ? { writeback_executor: reviewedText(candidate.execution_profile.writeback_executor, "writeback executor", 160) }
        : {}),
      digest: canonicalJsonDigest(candidate.execution_profile.authority),
    })),
    shared_limits: normalizeSharedLimits(input.sharedLimits ?? []),
  });
  return {
    schema_version: ACTION_BOUNDARY_VERSION,
    state: "disabled",
    name,
    label,
    job_intent: jobIntent,
    authority,
    digest: actionBoundaryAuthorityDigest(authority),
    created_at: input.now ?? new Date().toISOString(),
  };
}

export function reviseActionBoundaryDraft(input: {
  current: ActionBoundaryDraft | ActionBoundaryActivation;
  label?: string;
  jobIntent?: string;
  sharedLimits: ActionBoundarySharedLimit[];
  now?: string;
}): ActionBoundaryDraft {
  const authority = normalizeAuthority({
    ...input.current.authority,
    shared_limits: normalizeSharedLimits(input.sharedLimits),
  });
  return {
    schema_version: ACTION_BOUNDARY_VERSION,
    state: "disabled",
    name: safeBoundaryName(input.current.name),
    label: reviewedText(input.label ?? input.current.label, "action boundary label", 120),
    job_intent: reviewedText(
      input.jobIntent ?? input.current.job_intent,
      "action boundary job intent",
      500,
    ),
    authority,
    digest: actionBoundaryAuthorityDigest(authority),
    created_at: input.now ?? new Date().toISOString(),
  };
}

export async function writeActionBoundaryDraft(
  projectRootInput: string,
  draft: ActionBoundaryDraft,
): Promise<string> {
  const projectRoot = path.resolve(projectRootInput);
  assertActionBoundaryDraft(draft);
  const draftPath = actionBoundaryDraftPath(projectRoot, draft.name);
  await writeAtomic(draftPath, json(draft));
  return relativeProjectPath(projectRoot, draftPath);
}

export async function readActionBoundaryDraft(
  projectRootInput: string,
  name: string = DEFAULT_ACTION_BOUNDARY_NAME,
): Promise<ActionBoundaryDraft | undefined> {
  const projectRoot = path.resolve(projectRootInput);
  const parsed = await readOptionalJson(actionBoundaryDraftPath(projectRoot, safeBoundaryName(name)));
  if (!parsed) return undefined;
  assertActionBoundaryDraft(parsed);
  return parsed;
}

export async function readActionBoundaryActivation(
  projectRootInput: string,
  name: string = DEFAULT_ACTION_BOUNDARY_NAME,
): Promise<ActionBoundaryActivation | undefined> {
  const projectRoot = path.resolve(projectRootInput);
  const parsed = await readOptionalJson(actionBoundaryActivePath(projectRoot, safeBoundaryName(name)));
  if (!parsed) return undefined;
  assertActionBoundaryActivation(parsed);
  return parsed;
}

/**
 * Publishes the immutable boundary revision and active pointer. The caller must
 * still publish the runtime config last. If that later write fails, call the
 * returned rollback function to restore the previous active pointer.
 */
export async function publishActionBoundaryActivation(input: {
  projectRoot: string;
  draft: ActionBoundaryDraft;
  actor: string;
  now?: string;
}): Promise<ActionBoundaryPublication> {
  const projectRoot = path.resolve(input.projectRoot);
  assertActionBoundaryDraft(input.draft);
  const actor = reviewedText(input.actor, "operator identity", 128);
  const activePath = actionBoundaryActivePath(projectRoot, input.draft.name);
  const revisionPath = actionBoundaryRevisionPath(projectRoot, input.draft.name, input.draft.digest);
  const previousPointer = await readOptionalText(activePath);
  const revisionExisted = await fileExists(revisionPath);
  const activation: ActionBoundaryActivation = {
    schema_version: ACTION_BOUNDARY_VERSION,
    state: "active",
    name: input.draft.name,
    label: input.draft.label,
    job_intent: input.draft.job_intent,
    authority: input.draft.authority,
    digest: input.draft.digest,
    actor,
    activated_at: input.now ?? new Date().toISOString(),
  };
  await writeAtomic(revisionPath, json(activation));
  await writeAtomic(activePath, json(activation));
  let rolledBack = false;
  return {
    activation,
    revision_path: relativeProjectPath(projectRoot, revisionPath),
    active_path: relativeProjectPath(projectRoot, activePath),
    rollback: async () => {
      if (rolledBack) return;
      rolledBack = true;
      if (previousPointer === undefined) await fs.rm(activePath, { force: true });
      else await writeAtomic(activePath, previousPointer);
      if (!revisionExisted) await fs.rm(revisionPath, { force: true });
    },
  };
}

export async function completeActionBoundaryPublication(
  projectRootInput: string,
  name: string = DEFAULT_ACTION_BOUNDARY_NAME,
): Promise<void> {
  const projectRoot = path.resolve(projectRootInput);
  await fs.rm(actionBoundaryDraftPath(projectRoot, safeBoundaryName(name)), { force: true });
}

export async function actionBoundaryStatus(
  projectRootInput: string,
  name: string = DEFAULT_ACTION_BOUNDARY_NAME,
): Promise<ActionBoundaryStatus> {
  const [draft, active] = await Promise.all([
    readActionBoundaryDraft(projectRootInput, name),
    readActionBoundaryActivation(projectRootInput, name),
  ]);
  return {
    ...(draft ? { draft } : {}),
    ...(active ? { active } : {}),
    synthesized_from_legacy_actions: false,
  };
}

function normalizeAuthority(authority: ActionBoundaryAuthority): ActionBoundaryAuthority {
  return normalizeActionBoundaryAuthorityV1(authority);
}

function normalizeReadDependency(dependency: ActionBoundaryReadDependency): ActionBoundaryReadDependency {
  return {
    name: safeBoundaryName(dependency.name),
    source: reviewedText(dependency.source, "read boundary source", 160),
    digest: sha256Digest(dependency.digest, "read boundary digest"),
    generation_lock_fingerprint: sha256Digest(
      dependency.generation_lock_fingerprint,
      "generation lock fingerprint",
    ),
    trusted_context_fingerprint: sha256Digest(
      dependency.trusted_context_fingerprint,
      "trusted-context fingerprint",
    ),
  };
}

function normalizeSharedLimits(limits: ActionBoundarySharedLimit[]): ActionBoundarySharedLimit[] {
  const ids = new Set<string>();
  return limits.map((limit) => {
    const id = safeBoundaryName(limit.id);
    if (ids.has(id)) throw new Error(`ACTION_BOUNDARY_LIMIT_DUPLICATE: ${id}.`);
    ids.add(id);
    if (!Number.isSafeInteger(limit.maximum) || limit.maximum <= 0) {
      throw new Error(`ACTION_BOUNDARY_LIMIT_INVALID: ${id} maximum must be a positive integer.`);
    }
    if (!Number.isSafeInteger(limit.window_seconds) || limit.window_seconds < 60 || limit.window_seconds > 31_536_000) {
      throw new Error(`ACTION_BOUNDARY_LIMIT_INVALID: ${id} window_seconds must be between 60 and 31536000.`);
    }
    if (limit.kind === "total" && !limit.field) {
      throw new Error(`ACTION_BOUNDARY_LIMIT_INVALID: ${id} total limits require a reviewed field.`);
    }
    return {
      ...limit,
      id,
      ...(limit.capability ? { capability: safeCapabilityName(limit.capability) } : {}),
      ...(limit.field ? { field: safeIdentifier(limit.field, "limit field") } : {}),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function uniqueByDigest(values: ActionBoundaryReadDependency[]): ActionBoundaryReadDependency[] {
  const byDigest = new Map<string, ActionBoundaryReadDependency>();
  for (const value of values) byDigest.set(actionBoundaryReadDependencyDigest(value), value);
  return [...byDigest.values()];
}

function assertActionBoundaryDraft(value: unknown): asserts value is ActionBoundaryDraft {
  if (!isRecord(value)
    || value.schema_version !== ACTION_BOUNDARY_VERSION
    || value.state !== "disabled"
    || typeof value.name !== "string"
    || typeof value.label !== "string"
    || typeof value.job_intent !== "string"
    || typeof value.digest !== "string"
    || typeof value.created_at !== "string"
    || !isActionBoundaryAuthority(value.authority)) {
    throw new Error("ACTION_BOUNDARY_DRAFT_INVALID: managed Action Boundary metadata is invalid.");
  }
  safeBoundaryName(value.name);
  if (actionBoundaryAuthorityDigest(value.authority) !== value.digest) {
    throw new Error("ACTION_BOUNDARY_DRAFT_CHANGED: the stored Action Boundary authority does not match its digest.");
  }
}

function assertActionBoundaryActivation(value: unknown): asserts value is ActionBoundaryActivation {
  if (!isRecord(value)
    || value.schema_version !== ACTION_BOUNDARY_VERSION
    || value.state !== "active"
    || typeof value.name !== "string"
    || typeof value.label !== "string"
    || typeof value.job_intent !== "string"
    || typeof value.digest !== "string"
    || typeof value.actor !== "string"
    || typeof value.activated_at !== "string"
    || !isActionBoundaryAuthority(value.authority)) {
    throw new Error("ACTION_BOUNDARY_ACTIVATION_INVALID: managed Action Boundary activation is invalid.");
  }
  safeBoundaryName(value.name);
  if (actionBoundaryAuthorityDigest(value.authority) !== value.digest) {
    throw new Error("ACTION_BOUNDARY_ACTIVATION_CHANGED: the active Action Boundary authority does not match its digest.");
  }
}

function isActionBoundaryAuthority(value: unknown): value is ActionBoundaryAuthority {
  return isRecord(value)
    && Array.isArray(value.read_dependencies)
    && Array.isArray(value.capabilities)
    && Array.isArray(value.approval_policies)
    && Array.isArray(value.execution_profiles)
    && Array.isArray(value.shared_limits);
}

function actionBoundaryDraftPath(projectRoot: string, name: string): string {
  return path.join(projectRoot, "synapsor/actions/boundaries/drafts", safeBoundaryName(name), "boundary.json");
}

function actionBoundaryActivePath(projectRoot: string, name: string): string {
  return path.join(projectRoot, "synapsor/actions/boundaries/active", `${safeBoundaryName(name)}.active.json`);
}

function actionBoundaryRevisionPath(projectRoot: string, name: string, digest: `sha256:${string}`): string {
  return path.join(
    projectRoot,
    "synapsor/actions/boundaries/revisions",
    safeBoundaryName(name),
    digest.replace(/^sha256:/, ""),
    "boundary.json",
  );
}

function safeBoundaryName(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(normalized)) {
    throw new Error("ACTION_BOUNDARY_NAME_INVALID: use 1 through 80 letters, numbers, dots, underscores, or hyphens, starting with a letter.");
  }
  return normalized;
}

function safeCapabilityName(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_.]*$/.test(normalized)) {
    throw new Error(`ACTION_BOUNDARY_CAPABILITY_INVALID: ${value}.`);
  }
  return normalized;
}

function safeResourceName(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_$]*\.[A-Za-z_][A-Za-z0-9_$]*$/.test(normalized)) {
    throw new Error(`ACTION_BOUNDARY_RESOURCE_INVALID: ${value}.`);
  }
  return normalized;
}

function safeProjectRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized.startsWith("./") || normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error("ACTION_BOUNDARY_PATH_INVALID: contract paths must stay inside the project.");
  }
  return normalized;
}

function safeIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    throw new Error(`ACTION_BOUNDARY_IDENTIFIER_INVALID: ${label} ${value}.`);
  }
  return normalized;
}

function sha256Digest(value: string, label: string): `sha256:${string}` {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`ACTION_BOUNDARY_DIGEST_INVALID: ${label} must be a full lowercase sha256 digest.`);
  }
  return value as `sha256:${string}`;
}

function reviewedText(value: string, label: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maximum) {
    throw new Error(`ACTION_BOUNDARY_TEXT_INVALID: ${label} must be 1 through ${maximum} characters.`);
  }
  if (/(?:postgres|mysql):\/\/|BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key\s*[:=]|bearer\s+[A-Za-z0-9._-]+/i.test(normalized)) {
    throw new Error(`ACTION_BOUNDARY_SECRET_BLOCKED: ${label} appears to contain secret material.`);
  }
  return normalized;
}

function relativeProjectPath(projectRoot: string, target: string): string {
  const relative = path.relative(projectRoot, target).replace(/\\/g, "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error("ACTION_BOUNDARY_PATH_ESCAPE: artifact leaves the project.");
  }
  return relative.startsWith("./") ? relative : `./${relative}`;
}

async function readOptionalJson(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, filePath);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
