import {
  ActionRuleError,
  createActionRuleAuthority,
  type ActionRuleApprovalClassSourceV1,
  type ActionRuleAuthorityV1,
  type ActionRuleCatalogRelationshipV1,
  type ActionRuleCatalogResourceV1,
  type ActionRuleCatalogV1,
  type LoadedActionRuleAuthorityV1,
} from "@synapsor-runner/action-rules";
import type { ActionBoundarySharedLimitV1 } from "@synapsor-runner/protocol";
import type {
  ActionRuleBooleanExpressionV1,
  ActionRuleScalarExpressionV1,
  ActionRuleScalarTypeSpecV1,
  ActionRuleSpecV1,
  DerivedEffectEnvelopeSpecV1,
  JsonScalar,
  RuleVerificationBoundarySpecV1,
} from "@synapsor/spec";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import type {
  ActionRuleAuthoringCatalogV1,
  BuiltActionRuleAuthoringCatalogV1,
} from "./action-rule-authoring.js";

export const ACTION_RULE_MODEL_DRAFT_VERSION = "synapsor.action-rule-model-draft.v1" as const;

export type ActionRuleVerificationDraftResourceV1 = {
  binding: string;
  resource: string;
  source:
    | { kind: "subject_ref" }
    | { kind: "relationship"; from_binding: string; relationship: string; direction: "forward" | "inverse" };
  fields: string[];
  max_rows?: number;
  overflow?: "ineligible" | "unsupported";
  deterministic_order?: Array<{ field: string; direction: "asc" | "desc" }>;
};

export type ActionRuleModelDraftV1 = {
  schema_version: typeof ACTION_RULE_MODEL_DRAFT_VERSION;
  name: string;
  outcome: string;
  verification: {
    name: string;
    resources: ActionRuleVerificationDraftResourceV1[];
  };
  effect: {
    name: string;
    operation: "update" | "insert";
    target_resource: string;
    target_binding?: string;
    allowed_fields: Array<{
      name: string;
      minimum?: number;
      maximum?: number;
      values?: JsonScalar[];
    }>;
    set: Record<string, ActionRuleScalarExpressionV1>;
    writeback: "proposal_only" | "supervised";
  };
  require: ActionRuleBooleanExpressionV1;
  derive: Record<string, ActionRuleScalarExpressionV1>;
  approval: {
    class_name: string;
    mode: "human" | "policy";
    auto_approve_when?: ActionRuleBooleanExpressionV1;
    required_role: string;
    required_approvals: number;
    shared_limits: ActionBoundarySharedLimitV1[];
  };
  ttl_seconds: number;
  review: {
    when: string;
    then: string;
    refused: string[];
    human_review: string;
    examples: Array<{ kind: "eligible" | "ineligible" | "human_review"; scenario: string; result: string }>;
  };
};

export type CompiledActionRuleModelDraftV1 = {
  draft: ActionRuleModelDraftV1;
  verification_boundary: RuleVerificationBoundarySpecV1;
  effect_envelope: DerivedEffectEnvelopeSpecV1;
  rule: ActionRuleSpecV1;
  approval_class: ActionRuleApprovalClassSourceV1;
  loaded: LoadedActionRuleAuthorityV1;
  review: ActionRuleModelDraftV1["review"];
};

/**
 * Reconstructs the model-safe authoring shape for one already reviewed
 * outcome. Runtime identity, source rows, trusted scope values, SQL, locks,
 * and authority digests are deliberately absent from this shape.
 */
export function actionRuleModelDraftFromAuthority(input: {
  authority: ActionRuleAuthorityV1;
  outcome: string;
  review: ActionRuleModelDraftV1["review"];
}): ActionRuleModelDraftV1 {
  const source = input.authority.rules.find((candidate) =>
    candidate.rule.outcome === input.outcome);
  if (!source) invalid(`Outcome ${input.outcome} is not present in the reviewed Action Rule authority.`);
  const approval = input.authority.approval_classes.find((candidate) =>
    candidate.name === source.rule.approval_class
    && candidate.rules.some((rule) => rule.outcome === input.outcome));
  if (!approval) invalid(`Outcome ${input.outcome} has no reviewed approval class.`);
  const approvalRule = approval.rules.find((rule) => rule.outcome === input.outcome)!;
  const referencedFields = new Map<string, Set<string>>();
  for (const expression of [
    source.rule.require,
    ...Object.values(source.rule.derive),
    ...Object.values(source.rule.effect.set),
    ...(approvalRule.auto_approve_when ? [approvalRule.auto_approve_when] : []),
  ]) {
    collectActionRuleFieldReferences(expression, referencedFields);
  }
  return normalizeDraft({
    schema_version: ACTION_RULE_MODEL_DRAFT_VERSION,
    name: source.rule.name,
    outcome: source.rule.outcome,
    verification: {
      name: source.verification_boundary.name,
      resources: source.verification_boundary.resources.map((resource) => ({
        binding: resource.binding,
        resource: resource.resource,
        source: resource.source.kind === "subject_ref"
          ? { kind: "subject_ref" as const }
          : {
              kind: "relationship" as const,
              from_binding: resource.source.from_binding,
              relationship: resource.source.relationship,
              direction: resource.source.direction,
            },
        fields: resource.fields
          .filter((field) => referencedFields.get(resource.binding)?.has(field.name))
          .map((field) => field.name),
        ...(resource.cardinality === "many"
          ? {
              max_rows: resource.max_rows,
              overflow: resource.overflow,
              ...(resource.deterministic_order
                ? { deterministic_order: structuredClone(resource.deterministic_order) }
                : {}),
            }
          : {}),
      })),
    },
    effect: {
      name: source.effect_envelope.name,
      operation: source.effect_envelope.operation,
      target_resource: source.effect_envelope.target_resource,
      ...(source.effect_envelope.target_binding
        ? { target_binding: source.effect_envelope.target_binding }
        : {}),
      allowed_fields: source.effect_envelope.allowed_fields.map((field) => ({
        name: field.name,
        ...(field.minimum === undefined ? {} : { minimum: field.minimum }),
        ...(field.maximum === undefined ? {} : { maximum: field.maximum }),
        ...(field.values === undefined ? {} : { values: structuredClone(field.values) }),
      })),
      set: structuredClone(source.rule.effect.set),
      writeback: source.effect_envelope.writeback.mode === "none"
        ? "proposal_only"
        : "supervised",
    },
    require: structuredClone(source.rule.require),
    derive: structuredClone(source.rule.derive),
    approval: {
      class_name: approval.name,
      mode: approval.mode,
      ...(approvalRule.auto_approve_when === undefined
        ? {}
        : { auto_approve_when: structuredClone(approvalRule.auto_approve_when) }),
      required_role: approval.required_role,
      required_approvals: approval.required_approvals,
      shared_limits: structuredClone(approval.shared_limits),
    },
    ttl_seconds: source.rule.ttl_seconds,
    review: structuredClone(input.review),
  });
}

function collectActionRuleFieldReferences(
  value: unknown,
  references: Map<string, Set<string>>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectActionRuleFieldReferences(item, references);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.kind === "field"
    && typeof record.binding === "string"
    && typeof record.field === "string") {
    const fields = references.get(record.binding) ?? new Set<string>();
    fields.add(record.field);
    references.set(record.binding, fields);
  }
  for (const item of Object.values(record)) collectActionRuleFieldReferences(item, references);
}

/**
 * Treats every model field as untrusted. Database identity, scope, types,
 * relationship columns, lock order, transaction mode, deduplication, and
 * version guards are resolved only from the reviewed authoring catalog.
 */
export function compileActionRuleModelDraft(input: {
  draft: ActionRuleModelDraftV1;
  builtCatalog: BuiltActionRuleAuthoringCatalogV1;
  readBoundary: ExplorationBoundaryDraft;
  readBoundaryDigest: `sha256:${string}`;
  authorityName?: string;
  actionBoundaryName?: string;
  activatedAt?: string;
}): CompiledActionRuleModelDraftV1 {
  const draft = normalizeDraft(input.draft);
  const catalog = input.builtCatalog.catalog;
  const authoringByName = new Map(input.builtCatalog.authoring.resources.map((resource) => [resource.name, resource]));
  const catalogByName = new Map(catalog.resources.map((resource) => [resource.name, resource]));
  const relationshipByName = new Map(catalog.relationships.map((relationship) => [relationship.name, relationship]));
  const bindings = new Map<string, {
    draft: ActionRuleVerificationDraftResourceV1;
    catalog: ActionRuleCatalogResourceV1;
    authoring: ActionRuleAuthoringCatalogV1["resources"][number];
    verification: RuleVerificationBoundarySpecV1["resources"][number];
  }>();
  const verificationResources: RuleVerificationBoundarySpecV1["resources"] = [];

  for (const resourceDraft of draft.verification.resources) {
    if (bindings.has(resourceDraft.binding)) invalid(`Verification binding ${resourceDraft.binding} is duplicated.`);
    const resource = catalogByName.get(resourceDraft.resource);
    const authoring = authoringByName.get(resourceDraft.resource);
    if (!resource || !authoring) invalid(`Verification resource ${resourceDraft.resource} is outside the reviewed Action Rule catalog.`);
    const relationship = resourceDraft.source.kind === "relationship"
      ? relationshipByName.get(resourceDraft.source.relationship)
      : undefined;
    const parent = resourceDraft.source.kind === "relationship"
      ? bindings.get(resourceDraft.source.from_binding)
      : undefined;
    if (resourceDraft.source.kind === "relationship" && (!relationship || !parent)) {
      invalid(`Verification relationship source for ${resourceDraft.binding} is unavailable or ordered before its parent.`);
    }
    const source = resourceDraft.source.kind === "subject_ref"
      ? { kind: "subject_ref" as const }
      : relationshipSource(resourceDraft, parent!.catalog, resource, relationship!);
    const cardinality = relationship === undefined
      ? "one" as const
      : relationshipCardinality(
          relationship,
          resourceDraft.source.kind === "relationship" ? resourceDraft.source.direction : "forward",
        );
    const maxRows = cardinality === "one"
      ? 1
      : boundedInteger(resourceDraft.max_rows, 1, 100, `${resourceDraft.binding} max_rows`);
    const fieldNames = requiredVerificationFields({
      submitted: resourceDraft.fields,
      resource,
      source: resourceDraft.source,
      relationship,
      parent: parent?.catalog,
    });
    const fields = fieldNames.map((name) => verificationField(resource, authoring, name));
    const scope = verificationScope(input.readBoundary, resource, resourceDraft, parent?.catalog);
    const deterministicOrder = cardinality === "many"
      ? normalizeOrder(resourceDraft.deterministic_order, resource, resource.primary_key)
      : undefined;
    const verification: RuleVerificationBoundarySpecV1["resources"][number] = {
      binding: resourceDraft.binding,
      resource: resource.name,
      source,
      primary_key: resource.primary_key,
      ...(resource.version_field ? { version_field: resource.version_field } : {}),
      fields,
      scope,
      cardinality,
      max_rows: maxRows,
      overflow: resourceDraft.overflow ?? (cardinality === "one" ? "unsupported" : "ineligible"),
      ...(deterministicOrder ? { deterministic_order: deterministicOrder } : {}),
      lock: "for_update",
    };
    if (resourceDraft.source.kind === "relationship" && relationship && parent) {
      const parentRelationshipField = resourceDraft.source.direction === "forward"
        ? relationship.local_field
        : relationship.target_field;
      addVerificationField(
        parent.verification,
        parent.catalog,
        parent.authoring,
        parentRelationshipField,
      );
    }
    verificationResources.push(verification);
    bindings.set(resourceDraft.binding, {
      draft: resourceDraft,
      catalog: resource,
      authoring,
      verification,
    });
  }
  if (!verificationResources.length) invalid("An Action Rule requires at least one private verification binding.");

  const target = catalogByName.get(draft.effect.target_resource);
  const targetAuthoring = authoringByName.get(draft.effect.target_resource);
  if (!target || !targetAuthoring) invalid(`Effect target ${draft.effect.target_resource} is outside the reviewed catalog.`);
  if (!targetAuthoring.operations[draft.effect.operation]) {
    invalid(`${draft.effect.operation.toUpperCase()} ${target.name} is not source-proven for a derived Action Rule.`);
  }
  const targetFields = new Map(target.fields.map((field) => [field.name, field]));
  const allowedFields = draft.effect.allowed_fields.map((field) => {
    const catalogField = targetFields.get(field.name);
    const authoringField = targetAuthoring.fields.find((candidate) => candidate.name === field.name);
    if (!catalogField || !authoringField?.writable) {
      invalid(`Effect field ${target.name}.${field.name} is not a reviewed writable Action Rule field.`);
    }
    validateEffectBounds(field, catalogField.type);
    return {
      name: field.name,
      type: catalogField.type,
      ...(field.minimum === undefined ? {} : { minimum: field.minimum }),
      ...(field.maximum === undefined ? {} : { maximum: field.maximum }),
      ...(field.values === undefined ? {} : { values: field.values }),
    };
  });
  const approvalClassName = safeRuleName(draft.approval.class_name, "approval class");
  const envelope: DerivedEffectEnvelopeSpecV1 = {
    schema_version: "synapsor.derived-effect-envelope.v1",
    name: safeQualifiedName(draft.effect.name, "effect envelope"),
    source: catalog.resources[0]?.source ?? input.readBoundary.source,
    operation: draft.effect.operation,
    target_resource: target.name,
    ...(draft.effect.operation === "update"
      ? {
          target_binding: requiredTargetBinding(draft.effect.target_binding, bindings, target),
          conflict_key: requiredVersionField(target),
          ...(integerVersionAdvance(target) ? { version_advance: integerVersionAdvance(target) } : {}),
        }
      : {
          deduplication: inferredInsertDeduplication(target),
        }),
    primary_key: target.primary_key,
    ...(target.tenant_key ? { tenant_key: target.tenant_key } : {}),
    ...(input.readBoundary.organization_scope
      ? { organization_scope: input.readBoundary.organization_scope }
      : {}),
    ...(target.principal_scope_key ? { principal_scope_key: target.principal_scope_key } : {}),
    max_rows: 1,
    allowed_fields: allowedFields,
    approval_classes: [approvalClassName],
    writeback: draft.effect.writeback === "supervised"
      ? { mode: "direct_sql", supervised_worker: "allowed" }
      : { mode: "none", supervised_worker: "disabled" },
  };
  const verificationBoundary: RuleVerificationBoundarySpecV1 = {
    schema_version: "synapsor.verification-boundary.v1",
    name: safeQualifiedName(draft.verification.name, "Verification Boundary"),
    source: envelope.source,
    context: "trusted_context",
    generation_lock_fingerprint: catalog.generation_lock_fingerprint,
    resources: verificationResources,
    lock_order: verificationResources.map((resource) => resource.binding),
    transaction: { isolation: "repeatable_read", timezone: "UTC" },
  };
  const subjects = verificationResources
    .filter((resource) => resource.source.kind === "subject_ref")
    .map((resource) => ({
      binding: resource.binding,
      resource: resource.resource,
      input: "opaque_subject_ref" as const,
    }));
  const rule: ActionRuleSpecV1 = {
    schema_version: "synapsor.action-rule.v1",
    name: safeRuleName(draft.name, "Action Rule"),
    outcome: safeRuleName(draft.outcome, "Action outcome"),
    context: "trusted_context",
    source: envelope.source,
    verification_boundary_ref: verificationBoundary.name,
    effect_envelope_ref: envelope.name,
    subjects,
    require: draft.require,
    derive: draft.derive,
    effect: {
      operation: draft.effect.operation,
      target_resource: target.name,
      ...(draft.effect.operation === "update"
        ? { target_binding: envelope.target_binding }
        : {}),
      set: draft.effect.set,
    },
    approval_class: approvalClassName,
    ttl_seconds: boundedInteger(draft.ttl_seconds, 30, 3_600, "Action Rule ttl_seconds"),
  };
  const approvalClass: ActionRuleApprovalClassSourceV1 = {
    name: approvalClassName,
    mode: draft.approval.mode,
    rules: [{
      outcome: rule.outcome,
      ...(draft.approval.mode === "policy" && draft.approval.auto_approve_when
        ? { auto_approve_when: draft.approval.auto_approve_when }
        : {}),
    }],
    required_role: safeQualifiedName(draft.approval.required_role, "approval role"),
    required_approvals: boundedInteger(draft.approval.required_approvals, 1, 16, "required approvals"),
    shared_limits: draft.approval.shared_limits,
  };
  if (approvalClass.mode === "policy" && !draft.approval.auto_approve_when) {
    invalid("Policy auto-approval requires one independently reviewed auto_approve_when predicate.");
  }
  if (approvalClass.mode === "human" && draft.approval.auto_approve_when) {
    invalid("Human approval must not carry an automatic-approval predicate.");
  }
  assertNoUndefined(verificationBoundary, "verification_boundary");
  assertNoUndefined(envelope, "effect_envelope");
  assertNoUndefined(rule, "rule");
  assertNoUndefined(approvalClass, "approval_class");
  const loaded = createActionRuleAuthority({
    name: safeQualifiedName(input.authorityName ?? `${input.readBoundary.pack.name}_rules`, "Action Rule authority"),
    action_boundary_name: safeQualifiedName(input.actionBoundaryName ?? `${input.readBoundary.pack.name}_actions`, "semantic Action Boundary"),
    catalog,
    rules: [{
      read_boundary_name: input.readBoundary.pack.name,
      read_boundary_digest: input.readBoundaryDigest,
      verification_boundary: verificationBoundary,
      effect_envelope: envelope,
      rule,
      activated_at: canonicalTimestamp(input.activatedAt),
    }],
    approval_classes: [approvalClass],
  });
  return {
    draft,
    verification_boundary: verificationBoundary,
    effect_envelope: envelope,
    rule,
    approval_class: approvalClass,
    loaded,
    review: draft.review,
  };
}

function assertNoUndefined(value: unknown, path: string): void {
  if (value === undefined) invalid(`${path} must not contain an undefined value.`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUndefined(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [name, item] of Object.entries(value)) {
    assertNoUndefined(item, `${path}.${name}`);
  }
}

export function actionRuleDraftDiagnostics(error: unknown): Array<{
  code: string;
  path?: string;
  message: string;
  repair: "model" | "operator";
}> {
  if (error instanceof ActionRuleError) {
    return [{
      code: error.code,
      ...(error.path ? { path: error.path } : {}),
      message: error.message,
      repair: actionRuleDiagnosticNeedsOperator(error.code, error.message) ? "operator" : "model",
    }];
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = /^([A-Z][A-Z0-9_]+):/u.exec(message)?.[1] ?? "ACTION_RULE_DRAFT_INVALID";
  return [{
    code,
    message: message.replace(/^[A-Z][A-Z0-9_]+:\s*/u, ""),
    repair: actionRuleDiagnosticNeedsOperator(code, message) ? "operator" : "model",
  }];
}

function actionRuleDiagnosticNeedsOperator(code: string, _message: string): boolean {
  if (/SCOPE|AMBIGUOUS|UNSUPPORTED|POLICY|CURRENCY|UNIT/u.test(code)) return true;
  // Missing automatic-policy structure is first repairable from the original
  // operator intent. The focused model turn must ask only when that intent does
  // not contain the business threshold; pre-classifying every omission as
  // operator-owned caused Runner to repeat limits the operator already gave.
  return false;
}

function relationshipSource(
  resource: ActionRuleVerificationDraftResourceV1,
  parent: ActionRuleCatalogResourceV1,
  child: ActionRuleCatalogResourceV1,
  relationship: ActionRuleCatalogRelationshipV1,
): Extract<RuleVerificationBoundarySpecV1["resources"][number]["source"], { kind: "relationship" }> {
  const direction = resource.source.kind === "relationship" ? resource.source.direction : "forward";
  const expectedParent = direction === "forward" ? relationship.from_resource : relationship.to_resource;
  const expectedChild = direction === "forward" ? relationship.to_resource : relationship.from_resource;
  if (parent.name !== expectedParent || child.name !== expectedChild) {
    invalid(`Relationship ${relationship.name} does not connect ${parent.name} to ${child.name} in direction ${direction}.`);
  }
  return {
    kind: "relationship",
    from_binding: resource.source.kind === "relationship" ? resource.source.from_binding : "",
    relationship: relationship.name,
    local_field: relationship.local_field,
    target_field: relationship.target_field,
    direction,
  };
}

function relationshipCardinality(
  relationship: ActionRuleCatalogRelationshipV1,
  direction: "forward" | "inverse",
): "one" | "many" {
  const yieldsMany = direction === "forward"
    ? relationship.cardinality === "one_to_many"
    : relationship.cardinality === "many_to_one";
  return yieldsMany ? "many" : "one";
}

function requiredVerificationFields(input: {
  submitted: string[];
  resource: ActionRuleCatalogResourceV1;
  source: ActionRuleVerificationDraftResourceV1["source"];
  relationship?: ActionRuleCatalogRelationshipV1;
  parent?: ActionRuleCatalogResourceV1;
}): string[] {
  const fields = new Set(input.submitted.map((field) => safeIdentifier(field, "verification field")));
  fields.add(input.resource.primary_key);
  if (input.resource.version_field) fields.add(input.resource.version_field);
  if (input.resource.tenant_key) fields.add(input.resource.tenant_key);
  if (input.resource.principal_scope_key) fields.add(input.resource.principal_scope_key);
  if (input.source.kind === "relationship" && input.relationship) {
    fields.add(input.source.direction === "forward"
      ? input.relationship.target_field
      : input.relationship.local_field);
  }
  return [...fields].sort();
}

function verificationField(
  resource: ActionRuleCatalogResourceV1,
  authoring: ActionRuleAuthoringCatalogV1["resources"][number],
  name: string,
): RuleVerificationBoundarySpecV1["resources"][number]["fields"][number] {
  const field = resource.fields.find((candidate) => candidate.name === name);
  if (!field) invalid(`Verification field ${resource.name}.${name} is outside the portable catalog.`);
  return {
    name,
    type: field.type,
    nullable: field.nullable,
    model_visible: authoring.fields.find((candidate) => candidate.name === name)?.role === "model_visible",
  };
}

function addVerificationField(
  verification: RuleVerificationBoundarySpecV1["resources"][number],
  resource: ActionRuleCatalogResourceV1,
  authoring: ActionRuleAuthoringCatalogV1["resources"][number],
  name: string,
): void {
  if (verification.fields.some((field) => field.name === name)) return;
  verification.fields.push(verificationField(resource, authoring, name));
  verification.fields.sort((left, right) => left.name.localeCompare(right.name));
}

function verificationScope(
  boundary: ExplorationBoundaryDraft,
  resource: ActionRuleCatalogResourceV1,
  draft: ActionRuleVerificationDraftResourceV1,
  parent?: ActionRuleCatalogResourceV1,
): RuleVerificationBoundarySpecV1["resources"][number]["scope"] {
  if (resource.tenant_key) {
    return {
      mode: "columns",
      tenant_field: resource.tenant_key,
      ...(resource.principal_scope_key ? { principal_field: resource.principal_scope_key } : {}),
    };
  }
  if (boundary.organization_scope) {
    return {
      mode: "single_organization",
      organization_id: boundary.organization_scope.organization_id,
      ...(resource.principal_scope_key ? { principal_field: resource.principal_scope_key } : {}),
    };
  }
  if (draft.source.kind === "relationship" && parent) {
    return { mode: "inherited", from_binding: draft.source.from_binding };
  }
  invalid(`Resource ${resource.name} has no portable reviewed scope for Action Rule verification.`);
}

function normalizeOrder(
  submitted: ActionRuleVerificationDraftResourceV1["deterministic_order"],
  resource: ActionRuleCatalogResourceV1,
  fallback: string,
): Array<{ field: string; direction: "asc" | "desc" }> {
  const available = new Set(resource.fields.map((field) => field.name));
  const order = submitted?.length ? submitted : [{ field: fallback, direction: "asc" as const }];
  return order.map((item) => {
    if (!available.has(item.field)) invalid(`Deterministic order field ${resource.name}.${item.field} is unavailable.`);
    return { field: item.field, direction: item.direction };
  });
}

function validateEffectBounds(
  field: ActionRuleModelDraftV1["effect"]["allowed_fields"][number],
  type: ActionRuleScalarTypeSpecV1,
): void {
  if ((field.minimum !== undefined || field.maximum !== undefined)
    && type.kind !== "integer" && type.kind !== "money_minor") {
    invalid(`Numeric bounds are not valid for ${field.name} (${type.kind}).`);
  }
  if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) {
    invalid(`Effect bounds for ${field.name} are reversed.`);
  }
  if (field.values !== undefined) {
    if (type.kind !== "string" && type.kind !== "boolean") invalid(`Allowed values are not valid for ${field.name} (${type.kind}).`);
    if (type.kind === "string" && type.enum
      && field.values.some((value) => typeof value !== "string" || !type.enum!.includes(value))) {
      invalid(`Effect values for ${field.name} exceed the schema-declared allowlist.`);
    }
  }
}

function requiredTargetBinding(
  value: string | undefined,
  bindings: Map<string, { catalog: ActionRuleCatalogResourceV1 }>,
  target: ActionRuleCatalogResourceV1,
): string {
  if (!value) invalid("Derived UPDATE requires one exact subject target binding.");
  const binding = bindings.get(value);
  if (!binding || binding.catalog.name !== target.name) invalid(`UPDATE target binding ${value} does not identify ${target.name}.`);
  return value;
}

function requiredVersionField(resource: ActionRuleCatalogResourceV1): string {
  if (!resource.version_field) invalid(`Derived UPDATE ${resource.name} requires one unambiguous reviewed version field.`);
  return resource.version_field;
}

function integerVersionAdvance(resource: ActionRuleCatalogResourceV1): DerivedEffectEnvelopeSpecV1["version_advance"] | undefined {
  const version = resource.fields.find((field) => field.name === resource.version_field);
  return version?.type.kind === "integer"
    ? { column: version.name, strategy: "integer_increment" }
    : undefined;
}

function inferredInsertDeduplication(resource: ActionRuleCatalogResourceV1): NonNullable<DerivedEffectEnvelopeSpecV1["deduplication"]> {
  const primary = resource.fields.find((field) => field.name === resource.primary_key);
  if (primary?.type.kind !== "string") invalid(`Derived INSERT ${resource.name} requires a string proposal identity key.`);
  return {
    components: [
      { column: resource.primary_key, source: "proposal_id" },
      ...(resource.tenant_key ? [{ column: resource.tenant_key, source: "trusted_tenant" as const }] : []),
    ],
  };
}

function normalizeDraft(value: ActionRuleModelDraftV1): ActionRuleModelDraftV1 {
  if (!value || value.schema_version !== ACTION_RULE_MODEL_DRAFT_VERSION) {
    invalid(`schema_version must be ${ACTION_RULE_MODEL_DRAFT_VERSION}.`);
  }
  const resourceBindings = value.verification?.resources;
  if (!Array.isArray(resourceBindings) || resourceBindings.length < 1 || resourceBindings.length > 12) {
    invalid("Verification draft must contain from 1 through 12 bounded resources.");
  }
  if (!Array.isArray(value.effect?.allowed_fields) || value.effect.allowed_fields.length < 1 || value.effect.allowed_fields.length > 32) {
    invalid("Effect draft must contain from 1 through 32 reviewed fields.");
  }
  if (!value.review || !Array.isArray(value.review.refused) || !Array.isArray(value.review.examples)) {
    invalid("Action Rule review summaries and examples are required.");
  }
  return structuredClone(value);
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    invalid(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

function safeIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value)) invalid(`${label} must be a fixed identifier.`);
  return value;
}

function safeQualifiedName(value: string, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/u.test(value)) invalid(`${label} must be a fixed reviewed name.`);
  return value;
}

function safeRuleName(value: string, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/u.test(value)) {
    invalid(`${label} must be a dot-qualified fixed name, for example support.request_refund.`);
  }
  return value;
}

function canonicalTimestamp(value?: string): string {
  const result = value ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(result)) || new Date(Date.parse(result)).toISOString() !== result) {
    invalid("Action Rule activation timestamp must use canonical UTC form.");
  }
  return result;
}

function invalid(message: string): never {
  throw Object.assign(new Error(`ACTION_RULE_DRAFT_INVALID: ${message}`), {
    code: "ACTION_RULE_DRAFT_INVALID",
  });
}

export function compactActionRuleAuthoringCatalog(
  catalog: ActionRuleAuthoringCatalogV1,
): Omit<ActionRuleAuthoringCatalogV1, "digest"> {
  const { digest: _digest, ...material } = catalog;
  return material;
}
