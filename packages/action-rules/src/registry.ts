import { canonicalJsonDigest, canonicalJsonStringify } from "@synapsor-runner/protocol";
import { compileActionRuleBooleanPredicate } from "./compile.js";
import { ActionRuleError } from "./errors.js";
import {
  ACTION_RULE_APPROVAL_CLASS_VERSION,
  ACTION_RULE_REGISTRY_VERSION,
  type ActionRuleApprovalClassSourceV1,
  type ActivatedActionRuleApprovalClassV1,
  type ActivatedActionRuleV1,
  type CompiledActionRuleV1,
  type RuntimeActionRuleRegistryV1,
} from "./types.js";

const QUALIFIED_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/u;
const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,159}$/u;
const LIMIT_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u;

type ActivatedActionRuleInputV1 = Omit<ActivatedActionRuleV1, "approval_policy_digest"> & {
  approval_policy_digest?: `sha256:${string}`;
};

function canonicalRules(rules: ActivatedActionRuleV1[]): ActivatedActionRuleV1[] {
  return [...rules].sort((left, right) => {
    const outcome = left.compiled.outcome.localeCompare(right.compiled.outcome);
    if (outcome !== 0) return outcome;
    const boundary = left.action_boundary_name.localeCompare(right.action_boundary_name);
    if (boundary !== 0) return boundary;
    return left.compiled.rule_digest.localeCompare(right.compiled.rule_digest);
  });
}

function canonicalApprovalClasses(classes: ActivatedActionRuleApprovalClassV1[]): ActivatedActionRuleApprovalClassV1[] {
  return [...classes].sort((left, right) => left.name.localeCompare(right.name));
}

function defaultHumanApprovalSources(rules: CompiledActionRuleV1[]): ActionRuleApprovalClassSourceV1[] {
  const outcomes = new Map<string, string[]>();
  for (const rule of rules) {
    const entries = outcomes.get(rule.approval_class) ?? [];
    entries.push(rule.outcome);
    outcomes.set(rule.approval_class, entries);
  }
  return [...outcomes.entries()].map(([name, classOutcomes]) => ({
    name,
    mode: "human",
    rules: classOutcomes.sort().map((outcome) => ({ outcome })),
    required_role: "action_reviewer",
    required_approvals: 1,
    shared_limits: [],
  }));
}

function normalizeSharedLimits(
  limits: ActionRuleApprovalClassSourceV1["shared_limits"],
  rules: CompiledActionRuleV1[],
): ActionRuleApprovalClassSourceV1["shared_limits"] {
  const outcomes = new Set(rules.map((rule) => rule.outcome));
  const seen = new Set<string>();
  const normalized = limits.map((limit) => {
    if (!LIMIT_ID.test(limit.id) || seen.has(limit.id)) {
      throw new ActionRuleError("ACTION_RULE_INVALID", `Approval limit ${limit.id} must have one unique fixed identifier.`);
    }
    seen.add(limit.id);
    if ((limit.kind !== "count" && limit.kind !== "total")
      || !["boundary", "capability", "tenant", "tenant_principal", "tenant_object"].includes(limit.scope)
      || !Number.isSafeInteger(limit.maximum) || limit.maximum <= 0
      || !Number.isSafeInteger(limit.window_seconds) || limit.window_seconds < 60 || limit.window_seconds > 31_536_000) {
      throw new ActionRuleError("ACTION_RULE_INVALID", `Approval limit ${limit.id} has an invalid kind, scope, maximum, or rolling window.`);
    }
    if (limit.capability !== undefined && !outcomes.has(limit.capability)) {
      throw new ActionRuleError("ACTION_RULE_INVALID", `Approval limit ${limit.id} references outcome ${limit.capability} outside this class.`);
    }
    if (limit.kind === "count" && limit.field !== undefined) {
      throw new ActionRuleError("ACTION_RULE_INVALID", `Count limit ${limit.id} cannot name an impact field.`);
    }
    if (limit.kind === "total") {
      if (typeof limit.field !== "string") {
        throw new ActionRuleError("ACTION_RULE_INVALID", `Total limit ${limit.id} must name one exact derived effect field.`);
      }
      const applicable = rules.filter((rule) => limit.capability === undefined || rule.outcome === limit.capability);
      const types = applicable.map((rule) => rule.effect_field_types[limit.field!]);
      if (types.length === 0 || types.some((type) => type === undefined || (type.kind !== "integer" && type.kind !== "money_minor"))) {
        throw new ActionRuleError("ACTION_RULE_TYPE_MISMATCH", `Total limit ${limit.id} must reference a numeric field derived by every applicable rule.`);
      }
      if (new Set(types.map((type) => canonicalJsonStringify(type))).size !== 1) {
        throw new ActionRuleError("ACTION_RULE_TYPE_MISMATCH", `Total limit ${limit.id} mixes incompatible impact types or units.`);
      }
    }
    return {
      id: limit.id,
      kind: limit.kind,
      scope: limit.scope,
      maximum: limit.maximum,
      window_seconds: limit.window_seconds,
      ...(limit.capability === undefined ? {} : { capability: limit.capability }),
      ...(limit.field === undefined ? {} : { field: limit.field }),
    };
  });
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

export function createActionRuleApprovalClasses(input: {
  rules: CompiledActionRuleV1[];
  sources?: ActionRuleApprovalClassSourceV1[];
}): ActivatedActionRuleApprovalClassV1[] {
  const rulesByOutcome = new Map(input.rules.map((rule) => [rule.outcome, rule]));
  const sources = input.sources ?? defaultHumanApprovalSources(input.rules);
  if (sources.length < 1 || sources.length > 128) {
    throw new ActionRuleError("ACTION_RULE_INVALID", "Action Rule authority must contain from 1 through 128 approval classes.");
  }
  const seenClasses = new Set<string>();
  const boundOutcomes = new Set<string>();
  const classes = sources.map((source) => {
    if (!QUALIFIED_NAME.test(source.name) || seenClasses.has(source.name)) {
      throw new ActionRuleError("ACTION_RULE_INVALID", `Approval class ${source.name} must have one unique qualified name.`);
    }
    seenClasses.add(source.name);
    if ((source.mode !== "human" && source.mode !== "policy")
      || !ROLE_NAME.test(source.required_role)
      || !Number.isSafeInteger(source.required_approvals)
      || source.required_approvals < 1 || source.required_approvals > 10
      || !Array.isArray(source.rules) || source.rules.length < 1) {
      throw new ActionRuleError("ACTION_RULE_INVALID", `Approval class ${source.name} has invalid review authority.`);
    }
    const classRules = source.rules.map((binding, index) => {
      const rule = rulesByOutcome.get(binding.outcome);
      if (rule === undefined || rule.approval_class !== source.name || boundOutcomes.has(binding.outcome)) {
        throw new ActionRuleError("ACTION_RULE_INVALID", `Approval class ${source.name} does not bind one unique matching rule for ${binding.outcome}.`);
      }
      boundOutcomes.add(binding.outcome);
      if (source.mode === "policy" && binding.auto_approve_when === undefined) {
        throw new ActionRuleError("ACTION_RULE_INVALID", `Automatic approval class ${source.name} requires a separate reviewed predicate for ${binding.outcome}.`);
      }
      if (source.mode === "human" && binding.auto_approve_when !== undefined) {
        throw new ActionRuleError("ACTION_RULE_INVALID", `Human approval class ${source.name} cannot contain an automatic-approval predicate.`);
      }
      return {
        outcome: rule.outcome,
        action_rule_digest: rule.rule_digest,
        compiled_plan_digest: rule.compiled_plan_digest,
        effect_envelope_digest: rule.effect_envelope_digest,
        ...(binding.auto_approve_when === undefined ? {} : {
          auto_approve_when: compileActionRuleBooleanPredicate({
            compiled: rule,
            expression: binding.auto_approve_when,
            path: `approval_classes.${source.name}.rules[${index}].auto_approve_when`,
          }),
        }),
      };
    }).sort((left, right) => left.outcome.localeCompare(right.outcome));
    const relevantRules = classRules.map((binding) => rulesByOutcome.get(binding.outcome)!);
    const sharedLimits = normalizeSharedLimits(source.shared_limits ?? [], relevantRules);
    if (source.mode === "human" && sharedLimits.length > 0) {
      throw new ActionRuleError("ACTION_RULE_INVALID", `Human approval class ${source.name} cannot imply unused automatic-approval limits.`);
    }
    if (source.mode === "policy") {
      for (const rule of relevantRules) {
        const applicable = sharedLimits.filter((limit) => limit.capability === undefined || limit.capability === rule.outcome);
        const hasCircuitBreaker = applicable.some((limit) => limit.kind === "count" && (limit.scope === "boundary" || limit.scope === "capability"));
        const hasTrustedScopeLimit = applicable.some((limit) => limit.kind === "count" && ["tenant", "tenant_principal", "tenant_object"].includes(limit.scope));
        if (!hasCircuitBreaker || !hasTrustedScopeLimit) {
          throw new ActionRuleError(
            "ACTION_RULE_INVALID",
            `Automatic approval class ${source.name} requires one action/boundary count and one trusted-scope count (tenant, tenant_principal, or tenant_object) for ${rule.outcome}. A tenant_principal count already satisfies trusted scope.`,
          );
        }
      }
    }
    const material = {
      schema_version: ACTION_RULE_APPROVAL_CLASS_VERSION,
      name: source.name,
      mode: source.mode,
      rules: classRules,
      required_role: source.required_role,
      required_approvals: source.required_approvals,
      shared_limits: sharedLimits,
    } as const;
    return { ...material, digest: canonicalJsonDigest(material) };
  });
  for (const rule of input.rules) {
    if (!boundOutcomes.has(rule.outcome)) {
      throw new ActionRuleError("ACTION_RULE_INVALID", `Action Rule ${rule.outcome} has no independently reviewed approval-class binding.`);
    }
  }
  return canonicalApprovalClasses(classes);
}

function assertApprovalClassIntegrity(approvalClass: ActivatedActionRuleApprovalClassV1): void {
  const { digest, ...material } = approvalClass;
  if (approvalClass.schema_version !== ACTION_RULE_APPROVAL_CLASS_VERSION || canonicalJsonDigest(material) !== digest) {
    throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", `Approval class ${approvalClass.name} failed its integrity check.`);
  }
}

export function actionRuleRegistryDigest(input: {
  name: string;
  rules: ActivatedActionRuleV1[];
  approval_classes: ActivatedActionRuleApprovalClassV1[];
}): `sha256:${string}` {
  return canonicalJsonDigest({
    schema_version: ACTION_RULE_REGISTRY_VERSION,
    name: input.name,
    rules: canonicalRules(input.rules),
    approval_classes: canonicalApprovalClasses(input.approval_classes),
  });
}

export function createActionRuleRegistry(input: {
  name: string;
  rules: ActivatedActionRuleInputV1[];
  approval_classes?: ActivatedActionRuleApprovalClassV1[];
}): RuntimeActionRuleRegistryV1 {
  const inputOutcomes = new Set<string>();
  for (const source of input.rules) {
    if (inputOutcomes.has(source.compiled.outcome)) {
      throw new ActionRuleError(
        "ACTION_RULE_AMBIGUOUS",
        `More than one activated Action Rule resolves outcome ${source.compiled.outcome}.`,
        "rules",
      );
    }
    inputOutcomes.add(source.compiled.outcome);
  }
  const approvalClasses = input.approval_classes
    ?? createActionRuleApprovalClasses({ rules: input.rules.map((rule) => rule.compiled) });
  approvalClasses.forEach(assertApprovalClassIntegrity);
  const approvalByOutcome = new Map<string, ActivatedActionRuleApprovalClassV1>();
  for (const approvalClass of approvalClasses) {
    for (const binding of approvalClass.rules) {
      if (approvalByOutcome.has(binding.outcome)) {
        throw new ActionRuleError("ACTION_RULE_AMBIGUOUS", `Outcome ${binding.outcome} has more than one activated approval policy.`);
      }
      approvalByOutcome.set(binding.outcome, approvalClass);
    }
  }
  const rules = input.rules.map((source) => {
    const outcome = source.compiled.outcome;
    const approvalClass = approvalByOutcome.get(outcome);
    const binding = approvalClass?.rules.find((candidate) => candidate.outcome === outcome);
    if (approvalClass === undefined || approvalClass.name !== source.compiled.approval_class
      || binding?.action_rule_digest !== source.compiled.rule_digest
      || binding.compiled_plan_digest !== source.compiled.compiled_plan_digest
      || binding.effect_envelope_digest !== source.compiled.effect_envelope_digest
      || source.approval_policy_digest !== undefined && source.approval_policy_digest !== approvalClass.digest) {
      throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", `Approval authority for outcome ${outcome} does not match its activated Action Rule.`);
    }
    return { ...source, approval_policy_digest: approvalClass.digest };
  });
  if (approvalByOutcome.size !== rules.length) {
    throw new ActionRuleError("ACTION_RULE_INVALID", "Activated approval authority contains a rule that is not in the Action Rule registry.");
  }
  const canonicalRuleList = canonicalRules(rules);
  const canonicalClassList = canonicalApprovalClasses(approvalClasses);
  return {
    schema_version: ACTION_RULE_REGISTRY_VERSION,
    name: input.name,
    digest: actionRuleRegistryDigest({ name: input.name, rules: canonicalRuleList, approval_classes: canonicalClassList }),
    rules: canonicalRuleList,
    approval_classes: canonicalClassList,
  };
}

function assertRegistryIntegrity(registry: RuntimeActionRuleRegistryV1): void {
  const expected = actionRuleRegistryDigest({
    name: registry.name,
    rules: registry.rules,
    approval_classes: registry.approval_classes,
  });
  if (registry.schema_version !== ACTION_RULE_REGISTRY_VERSION || registry.digest !== expected) {
    throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "The activated Action Rule registry failed its integrity check.");
  }
  registry.approval_classes.forEach(assertApprovalClassIntegrity);
}

export function resolveActivatedActionRule(
  registry: RuntimeActionRuleRegistryV1,
  outcome: string,
): ActivatedActionRuleV1 {
  assertRegistryIntegrity(registry);
  const matches = registry.rules.filter((entry) => entry.compiled.outcome === outcome);
  if (matches.length !== 1) {
    throw new ActionRuleError(
      matches.length === 0 ? "ACTION_RULE_NOT_ELIGIBLE" : "ACTION_RULE_AMBIGUOUS",
      matches.length === 0
        ? `No activated Action Rule resolves outcome ${outcome}.`
        : `Outcome ${outcome} resolves to more than one activated Action Rule.`,
      "outcome",
    );
  }
  return matches[0]!;
}

export function resolveActivatedApprovalClass(
  registry: RuntimeActionRuleRegistryV1,
  outcome: string,
): ActivatedActionRuleApprovalClassV1 {
  const activated = resolveActivatedActionRule(registry, outcome);
  const matches = registry.approval_classes.filter((approvalClass) =>
    approvalClass.digest === activated.approval_policy_digest
    && approvalClass.rules.some((binding) => binding.outcome === outcome));
  if (matches.length !== 1) {
    throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", `Approval authority for outcome ${outcome} is unavailable or ambiguous.`);
  }
  return matches[0]!;
}
