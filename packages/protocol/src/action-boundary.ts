import { canonicalJsonDigest } from "./canonical-json.js";

export const actionBoundaryVersion = "synapsor.action-boundary.v1" as const;

export type ActionBoundaryReadDependencyV1 = {
  name: string;
  source: string;
  digest: `sha256:${string}`;
  generation_lock_fingerprint: `sha256:${string}`;
  trusted_context_fingerprint: `sha256:${string}`;
};

export type ActionBoundaryCapabilityReferenceV1 = {
  capability: string;
  resource: string;
  operation: "update" | "insert" | "delete";
  contract_digest: `sha256:${string}`;
  contract_path: string;
  read_dependency_digest: `sha256:${string}`;
};

export type ActionBoundaryApprovalPolicyReferenceV1 = {
  capability: string;
  mode: "human" | "policy";
  digest: `sha256:${string}`;
};

export type ActionBoundaryExecutionProfileReferenceV1 = {
  capability: string;
  authority_posture: "proposal_only" | "executable" | "supervised_execution";
  writeback_mode: "none" | "direct_sql" | "app_handler" | "cloud_worker";
  writeback_executor?: string;
  digest: `sha256:${string}`;
};

export type ActionBoundarySharedLimitV1 = {
  id: string;
  kind: "count" | "total";
  scope: "boundary" | "capability" | "tenant" | "tenant_principal" | "tenant_object";
  maximum: number;
  window_seconds: number;
  capability?: string;
  field?: string;
};

export type ActionBoundaryAuthorityV1 = {
  read_dependencies: ActionBoundaryReadDependencyV1[];
  capabilities: ActionBoundaryCapabilityReferenceV1[];
  approval_policies: ActionBoundaryApprovalPolicyReferenceV1[];
  execution_profiles: ActionBoundaryExecutionProfileReferenceV1[];
  shared_limits: ActionBoundarySharedLimitV1[];
};

export type RuntimeActionBoundaryV1 = {
  schema_version: typeof actionBoundaryVersion;
  name: string;
  digest: `sha256:${string}`;
  authority: ActionBoundaryAuthorityV1;
};

/**
 * Normalizes and validates the complete reviewed Action Boundary authority.
 * The runtime carries this exact object so limits cannot drift independently
 * from the capability-set digest that the operator activated.
 */
export function normalizeActionBoundaryAuthorityV1(input: unknown): ActionBoundaryAuthorityV1 {
  const value = requireRecord(input, "ACTION_BOUNDARY_AUTHORITY_INVALID");
  assertExactKeys(value, [
    "read_dependencies",
    "capabilities",
    "approval_policies",
    "execution_profiles",
    "shared_limits",
  ], "ACTION_BOUNDARY_AUTHORITY_INVALID");
  const readDependencies = requireArray(value.read_dependencies, "read_dependencies")
    .map(normalizeReadDependency)
    .sort((left, right) => `${left.name}\0${left.digest}`.localeCompare(`${right.name}\0${right.digest}`));
  const readDependencyDigests = new Set<string>();
  for (const dependency of readDependencies) {
    const digest = actionBoundaryReadDependencyDigestV1(dependency);
    if (readDependencyDigests.has(digest)) {
      throw new Error(`ACTION_BOUNDARY_READ_DEPENDENCY_DUPLICATE: ${dependency.name}.`);
    }
    readDependencyDigests.add(digest);
  }

  const capabilities = requireArray(value.capabilities, "capabilities")
    .map(normalizeCapabilityReference)
    .sort((left, right) => left.capability.localeCompare(right.capability));
  if (capabilities.length < 1 || capabilities.length > 256) {
    throw new Error("ACTION_BOUNDARY_CAPABILITY_COUNT: use 1 through 256 exact capability revisions.");
  }
  const capabilityNames = uniqueNames(capabilities.map((item) => item.capability), "ACTION_BOUNDARY_CAPABILITY_DUPLICATE");
  for (const capability of capabilities) {
    if (!readDependencyDigests.has(capability.read_dependency_digest)) {
      throw new Error(`ACTION_BOUNDARY_READ_DEPENDENCY_MISSING: ${capability.capability}.`);
    }
  }

  const approvalPolicies = requireArray(value.approval_policies, "approval_policies")
    .map(normalizeApprovalPolicyReference)
    .sort((left, right) => left.capability.localeCompare(right.capability));
  const executionProfiles = requireArray(value.execution_profiles, "execution_profiles")
    .map(normalizeExecutionProfileReference)
    .sort((left, right) => left.capability.localeCompare(right.capability));
  assertExactCapabilitySet(approvalPolicies.map((item) => item.capability), capabilityNames, "approval policy");
  assertExactCapabilitySet(executionProfiles.map((item) => item.capability), capabilityNames, "execution profile");

  const sharedLimits = requireArray(value.shared_limits, "shared_limits")
    .map((limit) => normalizeSharedLimit(limit, capabilityNames))
    .sort((left, right) => left.id.localeCompare(right.id));
  uniqueNames(sharedLimits.map((limit) => limit.id), "ACTION_BOUNDARY_LIMIT_DUPLICATE");

  return {
    read_dependencies: readDependencies,
    capabilities,
    approval_policies: approvalPolicies,
    execution_profiles: executionProfiles,
    shared_limits: sharedLimits,
  };
}

export function actionBoundaryAuthorityDigestV1(authority: unknown): `sha256:${string}` {
  return canonicalJsonDigest({
    schema_version: actionBoundaryVersion,
    authority: normalizeActionBoundaryAuthorityV1(authority),
  });
}

export function actionBoundaryReadDependencyDigestV1(
  dependency: ActionBoundaryReadDependencyV1,
): `sha256:${string}` {
  return canonicalJsonDigest(normalizeReadDependency(dependency));
}

function normalizeReadDependency(input: unknown): ActionBoundaryReadDependencyV1 {
  const value = requireRecord(input, "ACTION_BOUNDARY_READ_DEPENDENCY_INVALID");
  assertExactKeys(value, ["name", "source", "digest", "generation_lock_fingerprint", "trusted_context_fingerprint"], "ACTION_BOUNDARY_READ_DEPENDENCY_INVALID");
  return {
    name: safeBoundaryName(value.name),
    source: boundedText(value.source, "read boundary source", 160),
    digest: sha256(value.digest, "read boundary digest"),
    generation_lock_fingerprint: sha256(value.generation_lock_fingerprint, "generation lock fingerprint"),
    trusted_context_fingerprint: sha256(value.trusted_context_fingerprint, "trusted-context fingerprint"),
  };
}

function normalizeCapabilityReference(input: unknown): ActionBoundaryCapabilityReferenceV1 {
  const value = requireRecord(input, "ACTION_BOUNDARY_CAPABILITY_INVALID");
  assertExactKeys(value, ["capability", "resource", "operation", "contract_digest", "contract_path", "read_dependency_digest"], "ACTION_BOUNDARY_CAPABILITY_INVALID");
  if (value.operation !== "update" && value.operation !== "insert" && value.operation !== "delete") {
    throw new Error("ACTION_BOUNDARY_OPERATION_INVALID: operation must be update, insert, or delete.");
  }
  return {
    capability: qualifiedName(value.capability, "capability"),
    resource: qualifiedResource(value.resource),
    operation: value.operation,
    contract_digest: sha256(value.contract_digest, "contract digest"),
    contract_path: projectRelativePath(value.contract_path),
    read_dependency_digest: sha256(value.read_dependency_digest, "read dependency digest"),
  };
}

function normalizeApprovalPolicyReference(input: unknown): ActionBoundaryApprovalPolicyReferenceV1 {
  const value = requireRecord(input, "ACTION_BOUNDARY_APPROVAL_POLICY_INVALID");
  assertExactKeys(value, ["capability", "mode", "digest"], "ACTION_BOUNDARY_APPROVAL_POLICY_INVALID");
  if (value.mode !== "human" && value.mode !== "policy") {
    throw new Error("ACTION_BOUNDARY_APPROVAL_POLICY_INVALID: mode must be human or policy.");
  }
  return {
    capability: qualifiedName(value.capability, "approval policy capability"),
    mode: value.mode,
    digest: sha256(value.digest, "approval policy digest"),
  };
}

function normalizeExecutionProfileReference(input: unknown): ActionBoundaryExecutionProfileReferenceV1 {
  const value = requireRecord(input, "ACTION_BOUNDARY_EXECUTION_PROFILE_INVALID");
  assertKeys(value, {
    required: ["capability", "authority_posture", "writeback_mode", "digest"],
    optional: ["writeback_executor"],
  }, "ACTION_BOUNDARY_EXECUTION_PROFILE_INVALID");
  if (value.authority_posture !== "proposal_only" && value.authority_posture !== "executable" && value.authority_posture !== "supervised_execution") {
    throw new Error("ACTION_BOUNDARY_EXECUTION_PROFILE_INVALID: unknown authority posture.");
  }
  if (value.writeback_mode !== "none" && value.writeback_mode !== "direct_sql" && value.writeback_mode !== "app_handler" && value.writeback_mode !== "cloud_worker") {
    throw new Error("ACTION_BOUNDARY_EXECUTION_PROFILE_INVALID: unknown writeback mode.");
  }
  if (value.writeback_mode === "app_handler" && typeof value.writeback_executor !== "string") {
    throw new Error("ACTION_BOUNDARY_EXECUTION_PROFILE_INVALID: app_handler requires one fixed executor.");
  }
  if (value.writeback_mode !== "app_handler" && value.writeback_executor !== undefined) {
    throw new Error("ACTION_BOUNDARY_EXECUTION_PROFILE_INVALID: only app_handler may name an executor.");
  }
  return {
    capability: qualifiedName(value.capability, "execution profile capability"),
    authority_posture: value.authority_posture,
    writeback_mode: value.writeback_mode,
    ...(value.writeback_executor === undefined
      ? {}
      : { writeback_executor: boundedText(value.writeback_executor, "writeback executor", 160) }),
    digest: sha256(value.digest, "execution profile digest"),
  };
}

function normalizeSharedLimit(input: unknown, capabilityNames: Set<string>): ActionBoundarySharedLimitV1 {
  const value = requireRecord(input, "ACTION_BOUNDARY_LIMIT_INVALID");
  assertKeys(value, {
    required: ["id", "kind", "scope", "maximum", "window_seconds"],
    optional: ["capability", "field"],
  }, "ACTION_BOUNDARY_LIMIT_INVALID");
  const id = safeBoundaryName(value.id);
  if (value.kind !== "count" && value.kind !== "total") {
    throw new Error(`ACTION_BOUNDARY_LIMIT_INVALID: ${id} kind must be count or total.`);
  }
  if (!["boundary", "capability", "tenant", "tenant_principal", "tenant_object"].includes(String(value.scope))) {
    throw new Error(`ACTION_BOUNDARY_LIMIT_INVALID: ${id} has an unsupported scope.`);
  }
  if (!Number.isSafeInteger(value.maximum) || Number(value.maximum) <= 0) {
    throw new Error(`ACTION_BOUNDARY_LIMIT_INVALID: ${id} maximum must be a positive integer.`);
  }
  if (!Number.isSafeInteger(value.window_seconds) || Number(value.window_seconds) < 60 || Number(value.window_seconds) > 31_536_000) {
    throw new Error(`ACTION_BOUNDARY_LIMIT_INVALID: ${id} window_seconds must be between 60 and 31536000.`);
  }
  const capability = value.capability === undefined ? undefined : qualifiedName(value.capability, "limit capability");
  if (capability && !capabilityNames.has(capability)) {
    throw new Error(`ACTION_BOUNDARY_LIMIT_CAPABILITY_MISSING: ${id} references ${capability}.`);
  }
  if (value.kind === "total" && value.field === undefined) {
    throw new Error(`ACTION_BOUNDARY_LIMIT_INVALID: ${id} total limits require a reviewed field.`);
  }
  if (value.kind === "count" && value.field !== undefined) {
    throw new Error(`ACTION_BOUNDARY_LIMIT_INVALID: ${id} count limits cannot name a field.`);
  }
  return {
    id,
    kind: value.kind,
    scope: value.scope as ActionBoundarySharedLimitV1["scope"],
    maximum: Number(value.maximum),
    window_seconds: Number(value.window_seconds),
    ...(capability ? { capability } : {}),
    ...(value.field === undefined ? {} : { field: safeIdentifier(value.field, "limit field") }),
  };
}

function assertExactCapabilitySet(values: string[], expected: Set<string>, label: string): void {
  const actual = uniqueNames(values, `ACTION_BOUNDARY_${label.toUpperCase().replace(/\s+/g, "_")}_DUPLICATE`);
  for (const name of expected) {
    if (!actual.has(name)) throw new Error(`ACTION_BOUNDARY_${label.toUpperCase().replace(/\s+/g, "_")}_MISSING: ${name}.`);
  }
  for (const name of actual) {
    if (!expected.has(name)) throw new Error(`ACTION_BOUNDARY_${label.toUpperCase().replace(/\s+/g, "_")}_EXTRA: ${name}.`);
  }
}

function uniqueNames(values: string[], code: string): Set<string> {
  const names = new Set<string>();
  for (const value of values) {
    if (names.has(value)) throw new Error(`${code}: ${value}.`);
    names.add(value);
  }
  return names;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`ACTION_BOUNDARY_AUTHORITY_INVALID: ${label} must be an array.`);
  return value;
}

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${code}: expected one object.`);
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: string[],
  code: string,
): void {
  assertKeys(value, { required: keys, optional: [] }, code);
}

function assertKeys(
  value: Record<string, unknown>,
  keys: { required: string[]; optional: string[] },
  code: string,
): void {
  const allowed = new Set([...keys.required, ...keys.optional]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${code}: unknown field ${unknown}.`);
  const missing = keys.required.find((key) => value[key] === undefined);
  if (missing) throw new Error(`${code}: missing field ${missing}.`);
}

function safeBoundaryName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value.trim())) {
    throw new Error("ACTION_BOUNDARY_NAME_INVALID: expected a fixed boundary name.");
  }
  return value.trim();
}

function qualifiedName(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_.]*$/.test(value.trim())) {
    throw new Error(`ACTION_BOUNDARY_CAPABILITY_INVALID: ${label} must be a fixed qualified name.`);
  }
  return value.trim();
}

function qualifiedResource(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_$]*\.[A-Za-z_][A-Za-z0-9_$]*$/.test(value.trim())) {
    throw new Error("ACTION_BOUNDARY_RESOURCE_INVALID: resource must be schema.table.");
  }
  return value.trim();
}

function projectRelativePath(value: unknown): string {
  if (typeof value !== "string") throw new Error("ACTION_BOUNDARY_PATH_INVALID: contract path is required.");
  const normalized = value.replace(/\\/g, "/");
  if (!normalized.startsWith("./") || normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error("ACTION_BOUNDARY_PATH_INVALID: contract paths must stay inside the project.");
  }
  return normalized;
}

function safeIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim())) {
    throw new Error(`ACTION_BOUNDARY_IDENTIFIER_INVALID: ${label}.`);
  }
  return value.trim();
}

function sha256(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`ACTION_BOUNDARY_DIGEST_INVALID: ${label}.`);
  }
  return value as `sha256:${string}`;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`ACTION_BOUNDARY_TEXT_INVALID: ${label}.`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`ACTION_BOUNDARY_TEXT_INVALID: ${label}.`);
  }
  return normalized;
}
