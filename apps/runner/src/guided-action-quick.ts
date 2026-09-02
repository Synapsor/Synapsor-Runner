import type { ActionBoundarySharedLimitV1 } from "@synapsor-runner/protocol";
import type { ActionSuggestionAssessment } from "./action-design.js";
import type {
  GuidedActionAutoApprovalInput,
  GuidedActionInput,
  GuidedActionOperation,
  GuidedActionOptions,
  GuidedActionResourceOption,
} from "./guided-action.js";

export type QuickProposalDecisions = {
  resource?: string;
  operation?: GuidedActionOperation;
  guard_column?: string;
  fields?: string[];
  numeric_bounds?: Record<string, { minimum: number; maximum: number }>;
  text_max_lengths?: Record<string, number>;
  delete_confirmation?: string;
};

export type QuickProposalChoice = {
  value: string;
  label: string;
  detail?: string;
};

export type QuickProposalDecision =
  | {
      kind: "resource" | "operation" | "guard_column";
      title: string;
      help: string;
      choices: QuickProposalChoice[];
    }
  | {
      kind: "fields";
      title: string;
      help: string;
      choices: QuickProposalChoice[];
      multiple: true;
    }
  | {
      kind: "numeric_bounds";
      title: string;
      help: string;
      field: string;
      integer?: boolean;
      suggested_minimum?: number;
      suggested_maximum?: number;
    }
  | {
      kind: "delete_confirmation";
      title: string;
      help: string;
      expected: string;
    };

export type QuickProposalSummary = {
  capability: string;
  intent: string;
  resource: string;
  resource_label?: string;
  operation: GuidedActionOperation;
  arguments: Array<{
    field: string;
    label?: string;
    data_type: string;
    constraint: string;
  }>;
  trusted_context: string[];
  retry_or_conflict_guard: string;
  approval: string;
  authority: "proposal_only";
  writeback: "none";
};

export type QuickDeterministicApprovalTemplate = {
  source: "reviewed_structure" | "model_suggestion" | "model_interview";
  auto_approval: GuidedActionAutoApprovalInput;
  shared_limits: ActionBoundarySharedLimitV1[];
  rationale: string;
  normalizations?: string[];
};

export type QuickDeterministicApprovalPolicyInput = {
  source: "model_suggestion" | "model_interview";
  auto_approval: GuidedActionAutoApprovalInput;
  shared_limits?: Array<Omit<ActionBoundarySharedLimitV1, "id" | "capability">>;
  rationale?: string;
};

export type QuickProposalPreparation =
  | {
      state: "needs_input";
      intent: string;
      recommendations: ActionIntentHints;
      selected: Pick<QuickProposalDecisions, "resource" | "operation" | "guard_column" | "fields">;
      decision: QuickProposalDecision;
      source_database_changed: false;
      authority_granted: false;
    }
  | {
      state: "ready";
      intent: string;
      recommendations: ActionIntentHints;
      action: GuidedActionInput;
      summary: QuickProposalSummary;
      deterministic_approval_template?: QuickDeterministicApprovalTemplate;
      source_database_changed: false;
      authority_granted: false;
    };

export type ActionIntentHints = {
  resource?: string;
  operation?: GuidedActionOperation;
  excluded_operations?: GuidedActionOperation[];
  fields: string[];
  notes: string[];
};

const ACTION_CUE_WEIGHTS = new Map<string, { operation: GuidedActionOperation; weight: number }>([
  ["insert", { operation: "insert", weight: 3 }],
  ...["add", "create", "new", "open", "register"].map(
    (cue) => [cue, { operation: "insert" as const, weight: 1 }] as const,
  ),
  ["update", { operation: "update", weight: 3 }],
  ...["adjust", "assign", "cancel", "change", "close", "credit", "mark", "refund", "set"].map(
    (cue) => [cue, { operation: "update" as const, weight: 1 }] as const,
  ),
  ["delete", { operation: "delete", weight: 3 }],
  ...["purge", "remove"].map(
    (cue) => [cue, { operation: "delete" as const, weight: 1 }] as const,
  ),
]);

export function prepareQuickProposalAction(input: {
  options: GuidedActionOptions;
  intent: string;
  decisions?: QuickProposalDecisions;
}): QuickProposalPreparation {
  const intent = input.intent.trim();
  if (!intent) throw new Error("Quick proposal authoring requires a business intent.");
  const decisions = input.decisions ?? {};
  const hints = rankActionIntent(input.options.resources, intent);
  const resource = resolveResource(input.options.resources, hints, decisions);
  if (!resource) {
    return needsInput(intent, hints, decisions, {
      kind: "resource",
      title: "Which reviewed table does this action target?",
      help: "The intent did not name one unique reviewed resource. Choose the exact target; this choice does not activate authority.",
      choices: input.options.resources.map((candidate) => ({
        value: candidate.id,
        label: candidate.label ? `${candidate.label} (${candidate.id})` : candidate.id,
        ...(candidate.description ? { detail: candidate.description } : {}),
      })),
    });
  }

  const sourceAvailableOperations = (['insert', 'update', 'delete'] as GuidedActionOperation[])
    .filter((operation) => resource.operation_availability[operation].available);
  if (!sourceAvailableOperations.length) {
    const reasons = (['insert', 'update', 'delete'] as GuidedActionOperation[])
      .map((candidate) => `${candidate.toUpperCase()}: ${resource.operation_availability[candidate].reason}`)
      .join(" ");
    throw new Error(
      `No proposal operation is structurally ready for ${resource.id}. ${reasons} `
      + "Open Readiness for the exact schema remediation; Runner will not substitute another table or weaker guard.",
    );
  }
  const excludedOperations = new Set(hints.excluded_operations ?? []);
  if (decisions.operation && excludedOperations.has(decisions.operation)) {
    throw new Error(
      `${decisions.operation.toUpperCase()} contradicts the stated job, which explicitly excludes that effect. `
      + "Restate the job before preparing a different Action.",
    );
  }
  const availableOperations = sourceAvailableOperations.filter((operation) => !excludedOperations.has(operation));
  if (!availableOperations.length) {
    throw new Error(
      `The stated job explicitly excludes every source-proven proposal effect for ${resource.id}. `
      + "Runner will not infer or ask for a contradictory Action.",
    );
  }
  if (!decisions.operation && hints.operation && !sourceAvailableOperations.includes(hints.operation)) {
    throw new Error(
      `${hints.operation.toUpperCase()} ${resource.id} is unavailable: `
      + `${resource.operation_availability[hints.operation].reason} `
      + "Runner did not substitute a different write effect. Open Readiness for the exact schema or reviewed-boundary remediation.",
    );
  }
  const operation = resolveOperation(resource, availableOperations, hints, decisions);
  if (!operation) {
    return needsInput(intent, hints, { ...decisions, resource: resource.id }, {
      kind: "operation",
      title: "What proposal effect is allowed?",
      help: "Choose one source-proven operation. Proposal-only activation still cannot write to the source database.",
      choices: availableOperations.map((candidate) => ({
        value: candidate,
        label: candidate.toUpperCase(),
        detail: resource.operation_availability[candidate].reason,
      })),
    });
  }

  const guardCandidates = operation === "insert"
    ? resource.insert_dedup_candidates
    : resource.conflict_candidates;
  if (!guardCandidates.length) {
    throw new Error(`${operation.toUpperCase()} ${resource.id} has no source-proven retry or conflict guard.`);
  }
  if (decisions.guard_column && !guardCandidates.includes(decisions.guard_column)) {
    throw new Error(`${decisions.guard_column} is not a source-proven ${operation === "insert" ? "retry identity" : "conflict guard"} for ${resource.id}.`);
  }
  const guardColumn = decisions.guard_column && guardCandidates.includes(decisions.guard_column)
    ? decisions.guard_column
    : guardCandidates.length === 1
      ? guardCandidates[0]
      : undefined;
  if (!guardColumn) {
    return needsInput(intent, hints, { ...decisions, resource: resource.id, operation }, {
      kind: "guard_column",
      title: operation === "insert" ? "Which key makes retries idempotent?" : "Which column detects stale proposals?",
      help: operation === "insert"
        ? "Runner needs one source-proven unique key so a retry cannot create a second logical record."
        : "Runner needs one reviewed conflict guard so a proposal cannot silently overwrite a newer row.",
      choices: guardCandidates.map((candidate) => ({ value: candidate, label: candidate })),
    });
  }

  if (operation === "delete") {
    const expected = `DELETE ${resource.id}`;
    if (decisions.delete_confirmation !== expected) {
      return needsInput(intent, hints, {
        ...decisions,
        resource: resource.id,
        operation,
        guard_column: guardColumn,
      }, {
        kind: "delete_confirmation",
        title: "Confirm hard-delete proposal authority",
        help: "Type the exact phrase. The resulting tool may create a delete proposal, but it still cannot approve or apply it.",
        expected,
      });
    }
    const action = baseProposalAction({ intent, resource, operation, guardColumn, patches: [], deleteConfirmation: expected });
    return ready(intent, hints, action, resource);
  }

  const eligible = resource.structurally_eligible_fields.filter((field) => field.name !== guardColumn);
  // A structured suggestion may include a version-like column before Runner
  // resolves the only source-proven conflict guard. Treat that duplicate as
  // guard metadata, never as a model-writable patch. Other ineligible fields
  // still fail closed.
  if (decisions.fields?.some((field) => field !== guardColumn && !eligible.some((candidate) => candidate.name === field))) {
    const invalid = decisions.fields.find((field) => field !== guardColumn && !eligible.some((candidate) => candidate.name === field));
    throw new Error(`${invalid} is not a structurally eligible model-supplied field for ${operation.toUpperCase()} ${resource.id}.`);
  }
  const selectedNames = new Set<string>();
  for (const field of decisions.fields ?? hints.fields) {
    if (eligible.some((candidate) => candidate.name === field)) selectedNames.add(field);
  }
  if (operation === "insert") {
    for (const field of eligible) if (field.required_for_insert) selectedNames.add(field.name);
  }
  if (!selectedNames.size && eligible.length === 1) selectedNames.add(eligible[0]!.name);
  if (!selectedNames.size) {
    return needsInput(intent, hints, {
      ...decisions,
      resource: resource.id,
      operation,
      guard_column: guardColumn,
    }, {
      kind: "fields",
      title: "Which values may the model supply in a proposal?",
      help: "Select only fields needed for this business action. Trusted tenant and principal columns are never offered here.",
      multiple: true,
      choices: eligible.map((field) => ({
        value: field.name,
        label: field.label ? `${field.label} (${field.name})` : field.name,
        detail: fieldConstraintSummary(field),
      })),
    });
  }

  const patches: NonNullable<GuidedActionInput["patches"]> = [];
  for (const name of [...selectedNames].sort()) {
    const field = eligible.find((candidate) => candidate.name === name);
    if (!field) throw new Error(`${name} is not a structurally eligible field on ${resource.id}.`);
    if (isNumericType(field.data_type)) {
      const supplied = decisions.numeric_bounds?.[name];
      const minimum = supplied?.minimum ?? field.suggested_numeric_minimum;
      const maximum = supplied?.maximum ?? field.suggested_numeric_maximum;
      if (minimum === undefined || maximum === undefined) {
        return needsInput(intent, hints, {
          ...decisions,
          resource: resource.id,
          operation,
          guard_column: guardColumn,
          fields: [...selectedNames],
        }, {
          kind: "numeric_bounds",
          title: `Set the reviewed range for ${field.label ?? name}`,
          help: "Numeric proposal arguments require a finite minimum and maximum. Runner will enforce both server-side.",
          field: name,
          integer: isIntegerType(field.data_type),
          ...(field.suggested_numeric_minimum !== undefined
            ? { suggested_minimum: field.suggested_numeric_minimum }
            : {}),
          ...(field.suggested_numeric_maximum !== undefined
            ? { suggested_maximum: field.suggested_numeric_maximum }
            : {}),
        });
      }
      if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum > maximum) {
        throw new Error(`${name} requires finite numeric bounds with minimum <= maximum.`);
      }
      if (isIntegerType(field.data_type)
        && (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum))) {
        throw new Error(`${name} uses an integer source column and requires whole-number bounds.`);
      }
      patches.push({
        column: name,
        value_source: "argument",
        argument_name: name,
        minimum,
        maximum,
      });
      continue;
    }
    if (field.enum_values.length || isBooleanType(field.data_type)) {
      patches.push({ column: name, value_source: "argument", argument_name: name });
      continue;
    }
    const maxLength = decisions.text_max_lengths?.[name] ?? reviewedTypeLength(field.data_type) ?? 280;
    if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > 100_000) {
      throw new Error(`${name} maximum length must be an integer from 1 through 100000.`);
    }
    patches.push({
      column: name,
      value_source: "argument",
      argument_name: name,
      max_length: maxLength,
    });
  }

  const action = baseProposalAction({ intent, resource, operation, guardColumn, patches });
  return ready(intent, hints, action, resource);
}

export function applySuggestedDeterministicApproval(
  preparation: QuickProposalPreparation,
  assessment: ActionSuggestionAssessment,
): QuickProposalPreparation {
  if (preparation.state !== "ready") return preparation;
  const suggestion = assessment.status === "suggested" ? assessment.suggestion : undefined;
  const policy = suggestion?.approval_policy_proposal;
  if (!policy) return preparation;
  if (preparation.action.operation === "delete") {
    throw new Error("Hard DELETE cannot use deterministic auto-approval.");
  }
  if (suggestion.resource !== preparation.action.resource
    || suggestion.operation !== preparation.action.operation) {
    throw new Error("The approval-policy proposal does not match the exact prepared action target and operation.");
  }
  return applyInterpretedDeterministicApproval(preparation, {
    source: "model_suggestion",
    auto_approval: {
      conditions: structuredClone(policy.conditions),
      max_per_day: policy.max_per_day,
      ...(policy.max_total_per_day === undefined
        ? {}
        : {
            max_total_per_day: policy.max_total_per_day,
            total_field: policy.total_field,
          }),
    },
    shared_limits: structuredClone(policy.shared_limits ?? []),
    rationale: policy.rationale,
  });
}

export function applyInterpretedDeterministicApproval(
  preparation: QuickProposalPreparation,
  input: QuickDeterministicApprovalPolicyInput,
): QuickProposalPreparation {
  if (preparation.state !== "ready") return preparation;
  if (preparation.action.operation === "delete") {
    throw new Error("Hard DELETE cannot use deterministic auto-approval.");
  }
  const normalized = normalizeApprovalPolicy(preparation.action, input.auto_approval);
  const argumentFields = (preparation.action.patches ?? [])
    .filter((patch) => patch.value_source === "argument")
    .map((patch) => patch.column);
  const conditions = normalized.auto_approval.conditions ?? [];
  const uncovered = argumentFields.find((field) => !conditions.some((condition) =>
    (condition.source ?? "patch") === "patch" && condition.field === field));
  if (uncovered) {
    throw new Error(
      `The deterministic policy does not cover prepared model-controlled field ${uncovered}. Use human review or describe a complete policy.`,
    );
  }
  const capabilityStem = preparation.action.capability_name
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .slice(0, 32);
  return {
    ...preparation,
    deterministic_approval_template: {
      source: input.source,
      auto_approval: normalized.auto_approval,
      shared_limits: (input.shared_limits ?? []).map((limit, index) => ({
        id: `${input.source === "model_interview" ? "interview" : "suggested"}_${capabilityStem}_${limit.scope}_${limit.kind}_${index + 1}`,
        kind: limit.kind,
        scope: limit.scope,
        maximum: limit.maximum,
        window_seconds: limit.window_seconds,
        capability: preparation.action.capability_name,
        ...(limit.field ? { field: limit.field } : {}),
      })),
      rationale: input.source === "model_interview"
        ? "Runner translated the operator's business-policy answer through a bounded model tool, then revalidated every exact field, operator, range, and trusted scope."
        : "A model proposed these bounded inputs from structural metadata. Runner revalidated every exact field, operator, and trusted scope.",
      ...(normalized.normalizations.length
        ? { normalizations: normalized.normalizations }
        : {}),
    },
  };
}

function normalizeApprovalPolicy(
  action: GuidedActionInput,
  policy: GuidedActionAutoApprovalInput,
): { auto_approval: GuidedActionAutoApprovalInput; normalizations: string[] } {
  if (!Number.isSafeInteger(policy.max_per_day) || policy.max_per_day < 1 || policy.max_per_day > 1_000_000) {
    throw new Error("The deterministic policy count must be an integer from 1 through 1000000.");
  }
  const patches = new Map((action.patches ?? [])
    .filter((patch) => patch.value_source === "argument")
    .map((patch) => [patch.column, patch]));
  const normalizations: string[] = [];
  const conditions = (policy.conditions ?? []).map((condition) => {
    if ((condition.source ?? "patch") !== "patch") return structuredClone(condition);
    const patch = patches.get(condition.field);
    if (!patch) {
      throw new Error(`Deterministic policy field ${condition.field} is not a model-controlled field in this action.`);
    }
    if (patch.minimum !== undefined && patch.maximum !== undefined) {
      return normalizeNumericCondition(condition, patch.minimum, patch.maximum, normalizations);
    }
    if (condition.operator === "max_length" && patch.max_length !== undefined) {
      if (typeof condition.value !== "number" || !Number.isSafeInteger(condition.value) || condition.value < 1) {
        throw new Error(`${condition.field} max_length must be a positive integer.`);
      }
      if (condition.value > patch.max_length) {
        normalizations.push(
          `${condition.field} maximum length narrowed from ${condition.value} to the reviewed proposal maximum ${patch.max_length}.`,
        );
        return { ...condition, value: patch.max_length };
      }
    }
    return structuredClone(condition);
  });
  if (policy.max_total_per_day !== undefined) {
    if (!Number.isFinite(policy.max_total_per_day) || policy.max_total_per_day <= 0) {
      throw new Error("The aggregate deterministic policy ceiling must be a positive finite number.");
    }
    if (!policy.total_field || !patches.has(policy.total_field)) {
      throw new Error("The aggregate deterministic policy must name one model-controlled numeric field.");
    }
    const totalPatch = patches.get(policy.total_field)!;
    if (totalPatch.minimum === undefined || totalPatch.maximum === undefined) {
      throw new Error(`Aggregate policy field ${policy.total_field} is not a bounded numeric proposal field.`);
    }
  }
  return {
    auto_approval: {
      conditions,
      max_per_day: policy.max_per_day,
      ...(policy.max_total_per_day === undefined
        ? {}
        : {
            max_total_per_day: policy.max_total_per_day,
            total_field: policy.total_field,
          }),
    },
    normalizations,
  };
}

function normalizeNumericCondition(
  condition: NonNullable<GuidedActionAutoApprovalInput["conditions"]>[number],
  minimum: number,
  maximum: number,
  normalizations: string[],
): NonNullable<GuidedActionAutoApprovalInput["conditions"]>[number] {
  if (condition.operator === "in") {
    const values = (condition.values ?? []).filter((value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum);
    if (!values.length) {
      throw new Error(`${condition.field} has no policy value inside the reviewed proposal range ${minimum} through ${maximum}.`);
    }
    if (values.length !== (condition.values ?? []).length) {
      normalizations.push(`${condition.field} allowed values were intersected with the reviewed proposal range ${minimum} through ${maximum}.`);
    }
    return { ...condition, values };
  }
  if (!["gte", "lte", "eq"].includes(condition.operator)
    || typeof condition.value !== "number"
    || !Number.isFinite(condition.value)) {
    throw new Error(`${condition.field} needs a finite numeric gte, lte, eq, or in condition.`);
  }
  if (condition.operator === "eq") {
    if (condition.value < minimum || condition.value > maximum) {
      throw new Error(`${condition.field} exact policy value ${condition.value} is outside the reviewed proposal range ${minimum} through ${maximum}.`);
    }
    return structuredClone(condition);
  }
  if (condition.operator === "gte") {
    if (condition.value > maximum) {
      throw new Error(`${condition.field} policy minimum ${condition.value} leaves no value inside the reviewed proposal range ${minimum} through ${maximum}.`);
    }
    if (condition.value < minimum) {
      normalizations.push(`${condition.field} policy minimum narrowed from ${condition.value} to reviewed proposal minimum ${minimum}.`);
      return { ...condition, value: minimum };
    }
    return structuredClone(condition);
  }
  if (condition.value < minimum) {
    throw new Error(`${condition.field} policy maximum ${condition.value} leaves no value inside the reviewed proposal range ${minimum} through ${maximum}.`);
  }
  if (condition.value > maximum) {
    normalizations.push(`${condition.field} policy maximum narrowed from ${condition.value} to reviewed proposal maximum ${maximum}.`);
    return { ...condition, value: maximum };
  }
  return structuredClone(condition);
}

export function rankActionIntent(
  resources: GuidedActionResourceOption[],
  intentInput?: string,
): ActionIntentHints {
  const intent = intentInput?.trim();
  if (!intent) return { fields: [], notes: [] };
  const allTokens = intentTokens(intent);
  const actionTokens = focusedActionIntentTokens(intent);
  const operationSignals = rankedOperation(intent);
  const operation = operationSignals.operation;
  const hasFocusedFieldEvidence = resources.some((resource) =>
    rankedIntentFieldMatches(resource.structurally_eligible_fields, actionTokens).length > 0);
  const fieldTokens = hasFocusedFieldEvidence ? actionTokens : allTokens;
  const rankedResources = resources
    .map((resource) => {
      const focusedResourceScore = metadataIntentScore(actionTokens, [
        resource.table,
        resource.label,
        resource.description,
      ]);
      // The full sentence may identify the target before the action clause,
      // but broad read vocabulary must not outweigh exact change-field
      // evidence. This matters for mixed jobs such as "inspect shipments and
      // change carrier mode plus delay threshold".
      const fullResourceScore = metadataIntentScore(allTokens, [
        resource.table,
        resource.label,
      ]);
      const fieldMatches = rankedIntentFieldMatches(resource.structurally_eligible_fields, fieldTokens);
      const fieldScores = fieldMatches
        .map((candidate) => candidate.score)
        .slice(0, 3);
      const guardScore = metadataIntentScore(
        actionTokens,
        operation === "insert"
          ? resource.insert_dedup_candidates
          : operation === "update" || operation === "delete"
            ? resource.conflict_candidates
            : [],
      );
      return {
        resource,
        score: (focusedResourceScore * 2)
          + fullResourceScore
          + (fieldScores.reduce((sum, score) => sum + score, 0) * 2)
          + (fieldMatches.length * 4)
          + guardScore,
      };
    })
    .sort((left, right) => right.score - left.score || left.resource.id.localeCompare(right.resource.id));
  const first = rankedResources[0];
  const second = rankedResources[1];
  const resource = first && first.score > 0 && (!second || first.score > second.score)
    ? first.resource.id
    : undefined;
  const selected = resource ? first?.resource : undefined;
  const fields = selected
    ? rankedIntentFieldMatches(selected.structurally_eligible_fields, fieldTokens)
      .map((candidate) => candidate.field.name)
    : [];
  const notes = resource
    ? [`Runner ranked ${resource}${fields.length ? ` and field${fields.length === 1 ? "" : "s"} ${fields.join(", ")}` : ""} from reviewed metadata. Nothing was selected or authorized automatically.`]
    : ["Runner found no unique resource match. Choose the exact reviewed target; ambiguous intent never grants authority."];
  return {
    ...(resource ? { resource } : {}),
    ...(operation ? { operation } : {}),
    ...(operationSignals.excluded.length
      ? { excluded_operations: operationSignals.excluded }
      : {}),
    fields,
    notes,
  };
}

function resolveResource(
  resources: GuidedActionResourceOption[],
  hints: ActionIntentHints,
  decisions: QuickProposalDecisions,
): GuidedActionResourceOption | undefined {
  if (decisions.resource) {
    const resource = resources.find((candidate) => candidate.id === decisions.resource);
    if (!resource) throw new Error(`${decisions.resource} is not an eligible reviewed write target.`);
    return resource;
  }
  if (hints.resource) return resources.find((candidate) => candidate.id === hints.resource);
  return resources.length === 1 ? resources[0] : undefined;
}

function resolveOperation(
  resource: GuidedActionResourceOption,
  available: GuidedActionOperation[],
  hints: ActionIntentHints,
  decisions: QuickProposalDecisions,
): GuidedActionOperation | undefined {
  if (decisions.operation) {
    if (!available.includes(decisions.operation)) {
      throw new Error(`${decisions.operation.toUpperCase()} is unavailable for ${resource.id}: ${resource.operation_availability[decisions.operation].reason}`);
    }
    return decisions.operation;
  }
  if (hints.operation && available.includes(hints.operation)) return hints.operation;
  return available.length === 1 ? available[0] : undefined;
}

function baseProposalAction(input: {
  intent: string;
  resource: GuidedActionResourceOption;
  operation: GuidedActionOperation;
  guardColumn: string;
  patches: NonNullable<GuidedActionInput["patches"]>;
  deleteConfirmation?: string;
}): GuidedActionInput {
  const stem = input.resource.table.replace(/s$/i, "").replace(/[^A-Za-z0-9_]/g, "_");
  return {
    capability_name: `${stem}.propose_${input.operation}_${input.resource.table.replace(/[^A-Za-z0-9_]/g, "_")}`,
    description: input.intent,
    resource: input.resource.id,
    operation: input.operation,
    patches: input.patches,
    ...(input.operation === "insert"
      ? { dedup_proposal_column: input.guardColumn }
      : { conflict_column: input.guardColumn }),
    approval_role: "action_reviewer",
    required_approvals: 1,
    authority_posture: "proposal_only",
    writeback: { mode: "none" },
    supervised_worker_execution: false,
    reversible: false,
    confirmed_trusted_scope: true,
    ...(input.deleteConfirmation ? { delete_confirmation: input.deleteConfirmation } : {}),
  };
}

function ready(
  intent: string,
  hints: ActionIntentHints,
  action: GuidedActionInput,
  resource: GuidedActionResourceOption,
): QuickProposalPreparation {
  const fieldByName = new Map(resource.structurally_eligible_fields.map((field) => [field.name, field]));
  const approvalTemplate = deterministicApprovalTemplate(action, resource);
  return {
    state: "ready",
    intent,
    recommendations: hints,
    action,
    summary: {
      capability: action.capability_name,
      intent,
      resource: resource.id,
      ...(resource.label ? { resource_label: resource.label } : {}),
      operation: action.operation,
      arguments: (action.patches ?? []).map((patch) => {
        const field = fieldByName.get(patch.column)!;
        return {
          field: patch.column,
          ...(field?.label ? { label: field.label } : {}),
          data_type: field?.data_type ?? "reviewed field",
          constraint: patch.minimum !== undefined || patch.maximum !== undefined
            ? `${patch.minimum ?? "-infinity"} through ${patch.maximum ?? "infinity"}`
            : patch.max_length
              ? `maximum ${patch.max_length} characters`
              : field?.enum_values.length
                ? field.enum_values.join(", ")
                : "reviewed typed value",
        };
      }),
      trusted_context: [
        ...(resource.organization_scope
          ? [`whole organization ${resource.organization_scope.organization_id} from reviewed Runner authority`]
          : resource.tenant_key
            ? [`${resource.tenant_key} from trusted Runner context`]
            : []),
        ...(resource.principal_key ? [`${resource.principal_key} from trusted Runner context`] : []),
      ],
      retry_or_conflict_guard: action.operation === "insert"
        ? `deduplicate proposals by ${action.dedup_proposal_column}`
        : `detect stale proposals with ${action.conflict_column}`,
      approval: `one ${action.approval_role} approval`,
      authority: "proposal_only",
      writeback: "none",
    },
    ...(approvalTemplate ? { deterministic_approval_template: approvalTemplate } : {}),
    source_database_changed: false,
    authority_granted: false,
  };
}

function deterministicApprovalTemplate(
  action: GuidedActionInput,
  resource: GuidedActionResourceOption,
): QuickDeterministicApprovalTemplate | undefined {
  if (action.operation === "delete") return undefined;
  const argumentPatches = (action.patches ?? []).filter((patch) => patch.value_source === "argument");
  // Independent field predicates describe a Cartesian product, not a reviewed
  // cross-field pairing. Keep multi-field actions on human review unless an
  // operator or model supplies a separately validated exact policy.
  if (argumentPatches.length !== 1) return undefined;
  const fields = new Map(resource.structurally_eligible_fields.map((field) => [field.name, field]));
  const conditions: NonNullable<GuidedActionAutoApprovalInput["conditions"]> = [];
  for (const patch of argumentPatches) {
    const field = fields.get(patch.column);
    if (!field) return undefined;
    if (isNumericType(field.data_type)) {
      if (!Number.isFinite(patch.maximum)) return undefined;
      conditions.push({ field: patch.column, operator: "lte", value: patch.maximum! });
    } else if (field.enum_values.length > 0 && field.enum_values.length <= 64) {
      conditions.push({ field: patch.column, operator: "in", values: [...field.enum_values] });
    } else if (isBooleanType(field.data_type)) {
      conditions.push({ field: patch.column, operator: "in", values: [false, true] });
    } else if (patch.max_length) {
      conditions.push({ field: patch.column, operator: "max_length", value: patch.max_length });
    } else {
      return undefined;
    }
  }
  if (!conditions.length || conditions.length > 16) return undefined;
  const sharedScope = resource.organization_scope
    ? undefined
    : resource.principal_key
      ? "tenant_principal" as const
      : "tenant" as const;
  return {
    source: "reviewed_structure",
    auto_approval: { conditions, max_per_day: 10 },
    shared_limits: sharedScope
      ? [{
          id: `reviewed_${sharedScope}_count`,
          kind: "count",
          scope: sharedScope,
          maximum: 10,
          window_seconds: 86_400,
          capability: action.capability_name,
        }]
      : [],
    rationale: "Runner derived a disabled starting policy from the full reviewed argument bounds. Narrow any threshold before activation when the business rule requires it.",
  };
}

function needsInput(
  intent: string,
  hints: ActionIntentHints,
  decisions: QuickProposalDecisions,
  decision: QuickProposalDecision,
): QuickProposalPreparation {
  return {
    state: "needs_input",
    intent,
    recommendations: hints,
    selected: {
      ...(decisions.resource ? { resource: decisions.resource } : {}),
      ...(decisions.operation ? { operation: decisions.operation } : {}),
      ...(decisions.guard_column ? { guard_column: decisions.guard_column } : {}),
      ...(decisions.fields ? { fields: decisions.fields } : {}),
    },
    decision,
    source_database_changed: false,
    authority_granted: false,
  };
}

function fieldConstraintSummary(field: GuidedActionResourceOption["structurally_eligible_fields"][number]): string {
  if (field.enum_values.length) return `${field.data_type} | ${field.enum_values.join(", ")}`;
  if (field.suggested_numeric_minimum !== undefined || field.suggested_numeric_maximum !== undefined) {
    return `${field.data_type} | suggested ${field.suggested_numeric_minimum ?? "-infinity"} through ${field.suggested_numeric_maximum ?? "infinity"}`;
  }
  return field.data_type;
}

function intentTokens(value: string): Set<string> {
  const tokens = rawIntentTokens(value);
  return new Set(tokens.flatMap((token) => [token, singularIntentToken(token)]));
}

function rawIntentTokens(value: string): string[] {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return normalized ? normalized.split(/\s+/) : [];
}

function singularIntentToken(value: string): string {
  if (value.length > 4 && value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.length > 3 && value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
  return value;
}

function metadataIntentScore(tokens: Set<string>, values: Array<string | undefined>): number {
  let score = 0;
  const matchedConcepts = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (!value) continue;
    for (const token of rawIntentTokens(value)) {
      const singular = singularIntentToken(token);
      const concept = singular !== token ? singular : token;
      if (token.length <= 1
        || matchedConcepts.has(concept)
        || (!tokens.has(token) && !tokens.has(singular))) continue;
      matchedConcepts.add(concept);
      score += index < 2 ? 4 : 2;
    }
  }
  return score;
}

function rankedIntentFieldMatches(
  fields: GuidedActionResourceOption["structurally_eligible_fields"],
  tokens: Set<string>,
): Array<{ field: GuidedActionResourceOption["structurally_eligible_fields"][number]; score: number }> {
  const candidates = fields.map((field) => {
    const identifyingConcepts = new Set(
      [field.name, field.label]
        .filter((value): value is string => Boolean(value))
        .flatMap(rawIntentTokens)
        .map(singularIntentToken)
        .filter((value) => value.length > 1),
    );
    const matchedConcepts = [...identifyingConcepts]
      .filter((concept) => tokens.has(concept));
    return {
      field,
      identifyingConcepts,
      matchedConcepts,
      score: metadataIntentScore(tokens, [field.name, field.label, field.description]),
    };
  });
  const conceptFrequency = new Map<string, number>();
  for (const candidate of candidates) {
    for (const concept of candidate.matchedConcepts) {
      conceptFrequency.set(concept, (conceptFrequency.get(concept) ?? 0) + 1);
    }
  }
  return candidates
    .filter((candidate) => candidate.score > 0 && (
      candidate.identifyingConcepts.size === 1
      || candidate.matchedConcepts.length >= 2
      || candidate.matchedConcepts.some((concept) => conceptFrequency.get(concept) === 1)
    ))
    .sort((left, right) => right.score - left.score || left.field.name.localeCompare(right.field.name))
    .map(({ field, score }) => ({ field, score }));
}

function rankedOperation(intent: string): {
  operation?: GuidedActionOperation;
  excluded: GuidedActionOperation[];
} {
  const parts = operationIntentParts(intent);
  const scores = new Map<GuidedActionOperation, number>([
    ["insert", 0],
    ["update", 0],
    ["delete", 0],
  ]);
  const excluded = new Set<GuidedActionOperation>();
  for (const [index, part] of parts.entries()) {
    if (part.boundary) continue;
    const cue = ACTION_CUE_WEIGHTS.get(part.value);
    if (!cue || operationCueIsWritePostureNoun(parts, index)) continue;
    if (operationCueIsNegated(parts, index)) {
      excluded.add(cue.operation);
      continue;
    }
    scores.set(cue.operation, (scores.get(cue.operation) ?? 0) + cue.weight);
  }
  const ranked = [...scores.entries()]
    .filter(([operation]) => !excluded.has(operation))
    .map(([operation, score]) => ({ operation, score }))
    .sort((left, right) => right.score - left.score);
  const first = ranked[0];
  const second = ranked[1];
  const operation = first && first.score > 0 && (!second || first.score > second.score)
    ? first.operation
    : undefined;
  return {
    ...(operation ? { operation } : {}),
    excluded: [...excluded].sort(),
  };
}

function focusedActionIntentTokens(intent: string): Set<string> {
  const parts = operationIntentParts(intent);
  const focused = new Set<string>();
  for (const [cueIndex, part] of parts.entries()) {
    if (!ACTION_CUE_WEIGHTS.has(part.value)
      || operationCueIsWritePostureNoun(parts, cueIndex)
      || operationCueIsNegated(parts, cueIndex)) continue;
    let start = cueIndex;
    let precedingWords = 0;
    for (let index = cueIndex - 1; index >= 0 && precedingWords < 6; index -= 1) {
      const candidate = parts[index]!;
      if (strongActionContextBoundary(candidate)) break;
      start = index;
      if (!candidate.boundary) precedingWords += 1;
    }
    let end = parts.length - 1;
    for (let index = cueIndex + 1; index < parts.length; index += 1) {
      if (strongActionContextBoundary(parts[index]!)) {
        end = index - 1;
        break;
      }
    }
    for (let index = start; index <= end; index += 1) {
      const candidate = parts[index]!;
      if (candidate.boundary) continue;
      focused.add(candidate.value);
      focused.add(singularIntentToken(candidate.value));
    }
  }
  return focused.size ? focused : intentTokens(intent);
}

function strongActionContextBoundary(part: { value: string; boundary: boolean }): boolean {
  return part.boundary && part.value !== ",";
}

function operationCueIsWritePostureNoun(
  parts: Array<{ value: string; boundary: boolean }>,
  cueIndex: number,
): boolean {
  if (parts[cueIndex]?.value !== "change") return false;
  const preceding: string[] = [];
  for (let index = cueIndex - 1; index >= 0 && preceding.length < 7; index -= 1) {
    const part = parts[index]!;
    if (strongActionContextBoundary(part)) break;
    if (!part.boundary) preceding.unshift(part.value);
  }
  const previous = preceding.at(-1);
  if (previous === "source" || previous === "database" || previous === "data") return true;
  const controlVerbs = new Set(["apply", "approve", "commit", "execute", "persist", "write", "writeback"]);
  const negators = new Set(["no", "not", "never", "without"]);
  const controlIndex = preceding.findIndex((value) => controlVerbs.has(value));
  return controlIndex >= 0
    && preceding.slice(0, controlIndex + 1).some((value) => negators.has(value));
}

function operationIntentParts(intent: string): Array<{ value: string; boundary: boolean }> {
  const normalized = intent
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/\b(do|does|did|should|must|can|could|would|will)n['’]?t\b/gu, "$1 not")
    .replace(/\bcannot\b/gu, "can not");
  return (normalized.match(/[a-z0-9]+|[,.;!?]/gu) ?? []).map((raw) => {
    const boundary = /^[,.;!?]$/u.test(raw)
      || /^(?:but|however|instead|except|although|yet)$/u.test(raw);
    return { value: boundary ? raw : canonicalActionCue(raw), boundary };
  });
}

function canonicalActionCue(value: string): string {
  const forms: Record<string, string> = {
    added: "add",
    adding: "add",
    adds: "add",
    adjusted: "adjust",
    adjusting: "adjust",
    adjusts: "adjust",
    assigned: "assign",
    assigning: "assign",
    assigns: "assign",
    canceled: "cancel",
    cancelled: "cancel",
    canceling: "cancel",
    cancelling: "cancel",
    changes: "change",
    changed: "change",
    changing: "change",
    closed: "close",
    closes: "close",
    closing: "close",
    created: "create",
    creates: "create",
    creating: "create",
    credited: "credit",
    crediting: "credit",
    credits: "credit",
    deleted: "delete",
    deletes: "delete",
    deleting: "delete",
    inserted: "insert",
    inserting: "insert",
    inserts: "insert",
    marked: "mark",
    marking: "mark",
    marks: "mark",
    opened: "open",
    opening: "open",
    opens: "open",
    purged: "purge",
    purges: "purge",
    purging: "purge",
    refunded: "refund",
    refunding: "refund",
    refunds: "refund",
    registered: "register",
    registering: "register",
    registers: "register",
    removed: "remove",
    removes: "remove",
    removing: "remove",
    setting: "set",
    sets: "set",
    updated: "update",
    updates: "update",
    updating: "update",
  };
  return forms[value] ?? value;
}

function operationCueIsNegated(
  parts: Array<{ value: string; boundary: boolean }>,
  cueIndex: number,
): boolean {
  const negators = new Set(["no", "not", "never", "without"]);
  for (let index = cueIndex - 1, words = 0; index >= 0 && words < 6; index -= 1) {
    const part = parts[index]!;
    if (part.boundary) break;
    words += 1;
    if (negators.has(part.value)) return true;
  }
  for (let index = cueIndex + 1, words = 0; index < parts.length && words < 4; index += 1) {
    const part = parts[index]!;
    if (part.boundary) break;
    words += 1;
    if (negators.has(part.value)) return true;
  }
  return false;
}

function reviewedTypeLength(dataType: string): number | undefined {
  const match = /(?:var)?char(?:acter varying)?\s*\(\s*(\d+)\s*\)/i.exec(dataType);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function isNumericType(dataType: string): boolean {
  return /(?:^|\b)(?:smallint|integer|bigint|int|decimal|numeric|real|double|float|money)(?:\b|$)/i.test(dataType);
}

function isIntegerType(dataType: string): boolean {
  return /(?:^|\b)(?:tinyint|smallint|mediumint|integer|bigint|int|int2|int4|int8|smallserial|serial|bigserial)(?:\b|$)/i.test(dataType)
    && !/(?:^|\b)tinyint\s*\(\s*1\s*\)/i.test(dataType);
}

function isBooleanType(dataType: string): boolean {
  return /(?:^|\b)(?:bool|boolean|tinyint\s*\(\s*1\s*\))(?:\b|$)/i.test(dataType);
}
