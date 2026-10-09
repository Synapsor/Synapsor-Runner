import {
  canonicalJsonDigest,
  canonicalJsonStringify,
} from "@synapsor-runner/protocol";
import type {
  ActionRuleSpecV1,
  DerivedEffectEnvelopeSpecV1,
  RuleVerificationBoundarySpecV1,
} from "@synapsor/spec";
import { createActionRuleCompiler } from "./compile.js";
import { ActionRuleError } from "./errors.js";
import { ACTION_AUTHORITY_LIMITS } from "./limits.js";
import { parseReviewedSharedSum, type ReviewedSharedSumV1 } from "./shared-sum-designation.js";
import { parseReviewedWeightedSharedSum, REVIEWED_WEIGHTED_SHARED_SUM_VERSION, type ReviewedWeightedSharedSumV2 } from "./weighted-shared-sum-designation.js";
import {
  normalizeActionRule,
  normalizeActionRuleCatalog,
  normalizeDerivedEffectEnvelope,
  normalizeVerificationBoundary,
} from "./normalize.js";
import {
  createActionRuleApprovalClasses,
  createActionRuleRegistry,
} from "./registry.js";
import type {
  ActionRuleApprovalClassSourceV1,
  ActionRuleCatalogV1,
  RuntimeActionRuleRegistryV1,
} from "./types.js";

export const SEMANTIC_ACTION_BOUNDARY_VERSION = "synapsor.semantic-action-boundary.v1" as const;
export const ACTION_RULE_AUTHORITY_VERSION = "synapsor.action-rule-authority.v1" as const;
export const REVIEWED_ACTION_RULE_AUTHORITY_VERSION = "synapsor.action-rule-authority.v2" as const;
export const REVIEWED_SEMANTIC_ACTION_BOUNDARY_VERSION = "synapsor.semantic-action-boundary.v2" as const;
export const WEIGHTED_ACTION_RULE_AUTHORITY_VERSION = "synapsor.action-rule-authority.v3" as const;
export const WEIGHTED_SEMANTIC_ACTION_BOUNDARY_VERSION = "synapsor.semantic-action-boundary.v3" as const;

export type SemanticActionBoundaryRuleV1 = {
  outcome: string;
  effect_envelope_digest: `sha256:${string}`;
  action_rule_digest: `sha256:${string}`;
  compiled_plan_digest: `sha256:${string}`;
  approval_class: string;
  approval_policy_digest: `sha256:${string}`;
  approval_mode: "human" | "policy";
  operation: "update" | "insert";
  target_resource: string;
  allowed_fields: string[];
  max_rows: 1;
  writeback: DerivedEffectEnvelopeSpecV1["writeback"];
};

export type SemanticActionBoundaryV1 = {
  name: string;
  rules: SemanticActionBoundaryRuleV1[];
  digest: `sha256:${string}`;
} & ({ schema_version: typeof SEMANTIC_ACTION_BOUNDARY_VERSION; shared_sum_digest?: never }
  | { schema_version: typeof REVIEWED_SEMANTIC_ACTION_BOUNDARY_VERSION; shared_sum_digest: `sha256:${string}` }
  | { schema_version: typeof WEIGHTED_SEMANTIC_ACTION_BOUNDARY_VERSION; shared_sum_digest: `sha256:${string}` });

export type ActionRuleAuthoritySourceV1 = {
  read_boundary_name: string;
  read_boundary_digest: `sha256:${string}`;
  verification_boundary: RuleVerificationBoundarySpecV1;
  effect_envelope: DerivedEffectEnvelopeSpecV1;
  rule: ActionRuleSpecV1;
  activated_at: string;
  hard_limit?: import("./types.js").HardLimitDesignationV1;
};

export type ActionRuleAuthorityV1 = {
  name: string;
  catalog: ActionRuleCatalogV1;
  action_boundary: SemanticActionBoundaryV1;
  rules: ActionRuleAuthoritySourceV1[];
  approval_classes: ActionRuleApprovalClassSourceV1[];
  digest: `sha256:${string}`;
} & ({ schema_version: typeof ACTION_RULE_AUTHORITY_VERSION; shared_sum?: never }
  | { schema_version: typeof REVIEWED_ACTION_RULE_AUTHORITY_VERSION; shared_sum: ReviewedSharedSumV1 }
  | { schema_version: typeof WEIGHTED_ACTION_RULE_AUTHORITY_VERSION; shared_sum: ReviewedWeightedSharedSumV2 });

export type LoadedActionRuleAuthorityV1 = {
  authority: ActionRuleAuthorityV1;
  registry: RuntimeActionRuleRegistryV1;
};

export function createActionRuleAuthority(input: {
  name: string;
  action_boundary_name: string;
  catalog: ActionRuleCatalogV1;
  rules: ActionRuleAuthoritySourceV1[];
  approval_classes?: ActionRuleApprovalClassSourceV1[];
  shared_sum?: ReviewedSharedSumV1 | ReviewedWeightedSharedSumV2;
}): LoadedActionRuleAuthorityV1 {
  const name = safeName(input.name, "Action Rule authority");
  const actionBoundaryName = safeName(input.action_boundary_name, "semantic Action Boundary");
  if (input.rules.length < 1 || input.rules.length > ACTION_AUTHORITY_LIMITS.rules) {
    throw new ActionRuleError("ACTION_RULE_INVALID", `Action Rule authority must contain from 1 through ${ACTION_AUTHORITY_LIMITS.rules} reviewed rules.`);
  }
  if (Buffer.byteLength(canonicalJsonStringify({ ...input,
    approval_classes: input.approval_classes ?? null })) > ACTION_AUTHORITY_LIMITS.sourceBytes) {
    throw new ActionRuleError("ACTION_RULE_INVALID", "Action Rule authority exceeds the supported 64 MiB source budget.");
  }
  const catalog = normalizeActionRuleCatalog(input.catalog);
  const sharedSum = input.shared_sum === undefined ? undefined
    : input.shared_sum.schema_version === REVIEWED_WEIGHTED_SHARED_SUM_VERSION
      ? parseReviewedWeightedSharedSum(input.shared_sum) : parseReviewedSharedSum(input.shared_sum);
  const weighted = sharedSum?.schema_version === REVIEWED_WEIGHTED_SHARED_SUM_VERSION;
  const sources = input.rules.map((entry) => ({
    read_boundary_name: safeName(entry.read_boundary_name, "Read Boundary"),
    read_boundary_digest: digest(entry.read_boundary_digest, "Read Boundary digest"),
    verification_boundary: normalizeVerificationBoundary(entry.verification_boundary),
    effect_envelope: normalizeDerivedEffectEnvelope(entry.effect_envelope),
    rule: normalizeActionRule(entry.rule),
    activated_at: timestamp(entry.activated_at),
    ...(entry.hard_limit === undefined ? {} : { hard_limit: structuredClone(entry.hard_limit) }),
  })).sort((left, right) => left.rule.outcome.localeCompare(right.rule.outcome));
  if (sharedSum) assertSharedSumDependencies(sharedSum, catalog, sources);
  const compile = createActionRuleCompiler(catalog);
  const compiled = sources.map((entry) => compile({
    verification_boundary: entry.verification_boundary,
    effect_envelope: entry.effect_envelope,
    rule: entry.rule,
    ...(entry.hard_limit === undefined ? {} : { hard_limit: entry.hard_limit }),
  }));
  const approvalClasses = createActionRuleApprovalClasses({
    rules: compiled,
    ...(input.approval_classes === undefined ? {} : { sources: input.approval_classes }),
  });
  const approvalSources: ActionRuleApprovalClassSourceV1[] = approvalClasses.map((approvalClass) => ({
    name: approvalClass.name,
    mode: approvalClass.mode,
    rules: approvalClass.rules.map((binding) => ({
      outcome: binding.outcome,
      ...(binding.auto_approve_when === undefined ? {} : { auto_approve_when: binding.auto_approve_when }),
    })),
    required_role: approvalClass.required_role,
    required_approvals: approvalClass.required_approvals,
    shared_limits: structuredClone(approvalClass.shared_limits),
  }));
  const approvalsByOutcome = new Map(approvalClasses.flatMap((approval) =>
    approval.rules.map((binding) => [binding.outcome, approval] as const)));
  const actionRules: SemanticActionBoundaryRuleV1[] = compiled.map((rule) => ({
    ...(() => {
      const approvalClass = approvalsByOutcome.get(rule.outcome);
      if (approvalClass === undefined || approvalClass.name !== rule.approval_class) {
        throw new ActionRuleError("ACTION_RULE_INVALID", `Action Rule ${rule.outcome} has no exact approval authority.`);
      }
      return {
        approval_policy_digest: approvalClass.digest,
        approval_mode: approvalClass.mode,
      };
    })(),
    outcome: rule.outcome,
    effect_envelope_digest: rule.effect_envelope_digest,
    action_rule_digest: rule.rule_digest,
    compiled_plan_digest: rule.compiled_plan_digest,
    approval_class: rule.approval_class,
    operation: rule.effect_envelope.operation,
    target_resource: rule.effect_envelope.target_resource,
    allowed_fields: rule.effect_envelope.allowed_fields.map((field) => field.name).sort(),
    max_rows: 1 as const,
    writeback: structuredClone(rule.effect_envelope.writeback),
  })).sort((left, right) => left.outcome.localeCompare(right.outcome));
  const actionBoundaryMaterial = {
    ...(sharedSum === undefined ? { schema_version: SEMANTIC_ACTION_BOUNDARY_VERSION }
      : { schema_version: weighted ? WEIGHTED_SEMANTIC_ACTION_BOUNDARY_VERSION : REVIEWED_SEMANTIC_ACTION_BOUNDARY_VERSION,
          shared_sum_digest: canonicalJsonDigest(sharedSum) }),
    name: actionBoundaryName,
    rules: actionRules,
  } as const;
  const actionBoundary: SemanticActionBoundaryV1 = {
    ...actionBoundaryMaterial,
    digest: canonicalJsonDigest(actionBoundaryMaterial),
  };
  const registry = createActionRuleRegistry({
    name,
    approval_classes: approvalClasses,
    ...(sharedSum === undefined ? {} : { shared_sum: sharedSum }),
    rules: compiled.map((rule, index) => ({
      read_boundary_name: sources[index]!.read_boundary_name,
      read_boundary_digest: sources[index]!.read_boundary_digest,
      action_boundary_name: actionBoundary.name,
      action_boundary_digest: actionBoundary.digest,
      compiled: rule,
      activated_at: sources[index]!.activated_at,
    })),
  });
  const material = {
    ...(sharedSum === undefined ? { schema_version: ACTION_RULE_AUTHORITY_VERSION }
      : sharedSum.schema_version === REVIEWED_WEIGHTED_SHARED_SUM_VERSION
        ? { schema_version: WEIGHTED_ACTION_RULE_AUTHORITY_VERSION, shared_sum: sharedSum }
        : { schema_version: REVIEWED_ACTION_RULE_AUTHORITY_VERSION, shared_sum: sharedSum }),
    name,
    catalog,
    action_boundary: actionBoundary,
    rules: sources,
    approval_classes: approvalSources,
  } as const;
  return {
    authority: {
      ...material,
      digest: canonicalJsonDigest(material),
    },
    registry,
  };
}

export function parseActionRuleAuthority(
  value: unknown,
  expectedDigest?: string,
): LoadedActionRuleAuthorityV1 {
  if (!isRecord(value)) throw invalidAuthority();
  const weighted = value.schema_version === WEIGHTED_ACTION_RULE_AUTHORITY_VERSION;
  const reviewed = weighted || value.schema_version === REVIEWED_ACTION_RULE_AUTHORITY_VERSION;
  const record = exactRecord(value, [
    "schema_version",
    "name",
    "catalog",
    "action_boundary",
    "rules",
    "approval_classes",
    "digest",
    ...(reviewed ? ["shared_sum"] : []),
  ]);
  if ((!reviewed && record.schema_version !== ACTION_RULE_AUTHORITY_VERSION)
    || typeof record.name !== "string"
    || !Array.isArray(record.rules)
    || !isRecord(record.action_boundary)
    || typeof record.action_boundary.name !== "string") {
    throw invalidAuthority();
  }
  // Shared protection belongs to the complete authority, never an ignored
  // per-rule extension of a legacy source record.
  if (record.rules.some(source => isRecord(source) && ("shared_sum" in source || "shared_sum_digest" in source))) {
    throw invalidAuthority();
  }
  const loaded = createActionRuleAuthority({
    name: record.name,
    action_boundary_name: record.action_boundary.name,
    catalog: record.catalog as ActionRuleCatalogV1,
    rules: record.rules as ActionRuleAuthoritySourceV1[],
    approval_classes: record.approval_classes as ActionRuleApprovalClassSourceV1[],
    ...(reviewed ? { shared_sum: weighted ? parseReviewedWeightedSharedSum(record.shared_sum)
      : parseReviewedSharedSum(record.shared_sum) } : {}),
  });
  if (record.digest !== loaded.authority.digest
    || expectedDigest !== undefined && expectedDigest !== loaded.authority.digest
    || reviewed && canonicalJsonStringify(record) !== canonicalJsonStringify(loaded.authority)
    || canonicalJsonStringify(record.action_boundary) !== canonicalJsonStringify(loaded.authority.action_boundary)) {
    throw invalidAuthority();
  }
  return loaded;
}

function assertSharedSumDependencies(sharedSum: ReviewedSharedSumV1 | ReviewedWeightedSharedSumV2, catalog: ActionRuleCatalogV1,
  sources: ActionRuleAuthoritySourceV1[]): void {
  const confirmation = sharedSum.confirmation;
  if (confirmation.catalog_digest !== canonicalJsonDigest(catalog)
    || confirmation.generation_lock_fingerprint !== catalog.generation_lock_fingerprint) throw invalidAuthority();
  const reads = new Map<string, `sha256:${string}`>();
  for (const source of sources) {
    const prior = reads.get(source.read_boundary_name);
    if (prior !== undefined && prior !== source.read_boundary_digest) throw invalidAuthority();
    reads.set(source.read_boundary_name, source.read_boundary_digest);
  }
  const expected = [...reads].map(([name, digest]) => ({ name, digest })).sort((a, b) => a.name.localeCompare(b.name));
  const actual = [...confirmation.read_dependencies].sort((a, b) => a.name.localeCompare(b.name));
  if (canonicalJsonStringify(expected) !== canonicalJsonStringify(actual)) throw invalidAuthority();
}

function safeName(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u.test(normalized)) {
    throw new ActionRuleError("ACTION_RULE_INVALID", `${label} must be one fixed reviewed name.`);
  }
  return normalized;
}

function digest(value: string, label: string): `sha256:${string}` {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new ActionRuleError("ACTION_RULE_INVALID", `${label} must be one complete canonical digest.`);
  }
  return value as `sha256:${string}`;
}

function timestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new ActionRuleError("ACTION_RULE_INVALID", "Action Rule activation time must be a canonical UTC timestamp.");
  }
  return value;
}

function exactRecord(value: unknown, keys: string[]): Record<string, unknown> {
  if (!isRecord(value)) throw invalidAuthority();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalJsonStringify(actual) !== canonicalJsonStringify(expected)) throw invalidAuthority();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidAuthority(): ActionRuleError {
  return new ActionRuleError(
    "ACTION_RULE_AUTHORITY_STALE",
    "The activated Action Rule authority failed its integrity check.",
  );
}
