import {
  canonicalJsonDigest,
  canonicalJsonStringify,
} from "@synapsor-runner/protocol";
import type {
  ActionRuleSpecV1,
  DerivedEffectEnvelopeSpecV1,
  RuleVerificationBoundarySpecV1,
} from "@synapsor/spec";
import { compileActionRule } from "./compile.js";
import { ActionRuleError } from "./errors.js";
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
  schema_version: typeof SEMANTIC_ACTION_BOUNDARY_VERSION;
  name: string;
  rules: SemanticActionBoundaryRuleV1[];
  digest: `sha256:${string}`;
};

export type ActionRuleAuthoritySourceV1 = {
  read_boundary_name: string;
  read_boundary_digest: `sha256:${string}`;
  verification_boundary: RuleVerificationBoundarySpecV1;
  effect_envelope: DerivedEffectEnvelopeSpecV1;
  rule: ActionRuleSpecV1;
  activated_at: string;
};

export type ActionRuleAuthorityV1 = {
  schema_version: typeof ACTION_RULE_AUTHORITY_VERSION;
  name: string;
  catalog: ActionRuleCatalogV1;
  action_boundary: SemanticActionBoundaryV1;
  rules: ActionRuleAuthoritySourceV1[];
  approval_classes: ActionRuleApprovalClassSourceV1[];
  digest: `sha256:${string}`;
};

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
}): LoadedActionRuleAuthorityV1 {
  const name = safeName(input.name, "Action Rule authority");
  const actionBoundaryName = safeName(input.action_boundary_name, "semantic Action Boundary");
  if (input.rules.length < 1 || input.rules.length > 128) {
    throw new ActionRuleError("ACTION_RULE_INVALID", "Action Rule authority must contain from 1 through 128 reviewed rules.");
  }
  const catalog = normalizeActionRuleCatalog(input.catalog);
  const sources = input.rules.map((entry) => ({
    read_boundary_name: safeName(entry.read_boundary_name, "Read Boundary"),
    read_boundary_digest: digest(entry.read_boundary_digest, "Read Boundary digest"),
    verification_boundary: normalizeVerificationBoundary(entry.verification_boundary),
    effect_envelope: normalizeDerivedEffectEnvelope(entry.effect_envelope),
    rule: normalizeActionRule(entry.rule),
    activated_at: timestamp(entry.activated_at),
  })).sort((left, right) => left.rule.outcome.localeCompare(right.rule.outcome));
  const compiled = sources.map((entry) => compileActionRule({
    catalog,
    verification_boundary: entry.verification_boundary,
    effect_envelope: entry.effect_envelope,
    rule: entry.rule,
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
  const actionRules: SemanticActionBoundaryRuleV1[] = compiled.map((rule) => ({
    ...(() => {
      const approvalClass = approvalClasses.find((candidate) =>
        candidate.name === rule.approval_class
        && candidate.rules.some((binding) => binding.outcome === rule.outcome));
      if (approvalClass === undefined) {
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
    schema_version: SEMANTIC_ACTION_BOUNDARY_VERSION,
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
    schema_version: ACTION_RULE_AUTHORITY_VERSION,
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
  const record = exactRecord(value, [
    "schema_version",
    "name",
    "catalog",
    "action_boundary",
    "rules",
    "approval_classes",
    "digest",
  ]);
  if (record.schema_version !== ACTION_RULE_AUTHORITY_VERSION
    || typeof record.name !== "string"
    || !Array.isArray(record.rules)
    || !isRecord(record.action_boundary)
    || typeof record.action_boundary.name !== "string") {
    throw invalidAuthority();
  }
  const loaded = createActionRuleAuthority({
    name: record.name,
    action_boundary_name: record.action_boundary.name,
    catalog: record.catalog as ActionRuleCatalogV1,
    rules: record.rules as ActionRuleAuthoritySourceV1[],
    approval_classes: record.approval_classes as ActionRuleApprovalClassSourceV1[],
  });
  if (record.digest !== loaded.authority.digest
    || expectedDigest !== undefined && expectedDigest !== loaded.authority.digest
    || canonicalJsonStringify(record.action_boundary) !== canonicalJsonStringify(loaded.authority.action_boundary)) {
    throw invalidAuthority();
  }
  return loaded;
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
