import fs from "node:fs/promises";
import path from "node:path";
import { compileAgentDsl, formatAgentDsl } from "@synapsor/dsl";
import { loadRuntimeConfigFromFile } from "@synapsor-runner/mcp-server";
import {
  canonicalJsonDigest,
  type ActionBoundarySharedLimitV1,
} from "@synapsor-runner/protocol";
import {
  assessDirectWritePrerequisites,
  sourcePrimaryKeyMatchesReviewedWriteIdentity,
  type ColumnInfo,
  type SchemaInspection,
  type TableInfo,
} from "@synapsor-runner/schema-inspector";
import { assertValidContract, type JsonScalar, type SynapsorContract } from "@synapsor/spec";
import {
  compareGenerationLock,
  explorationBoundaryCandidateDigest,
  loadActivatedExplorationBoundary,
  type ActivatedExplorationBoundary,
  type ExplorationBoundaryDraft,
  type GenerationLock,
} from "./auto-boundary.js";
import { recommendedBoundaryReviewCandidate } from "./boundary-candidate.js";
import {
  boundaryReviewDecisions,
  readBoundaryReviewProgress,
} from "./boundary-review-domain.js";
import {
  extendEnvironmentExample,
  readGuidedOnboardingState,
} from "./guided-project.js";
import {
  actionAuthorityForCapability,
  classifyActionAuthorityTransition,
  resolveActionAuthority,
  type ActionAuthorityTransition,
  type ActionAuthorityPosture,
  type ActionWritebackMode,
  type ResolvedActionAuthority,
} from "./action-authority.js";
import {
  DEFAULT_ACTION_BOUNDARY_NAME,
  actionBoundaryStatus,
  buildActionBoundaryDraft,
  completeActionBoundaryPublication,
  publishActionBoundaryActivation,
  readActionBoundaryDraft,
  reviseActionBoundaryDraft,
  writeActionBoundaryDraft,
  type ActionBoundaryCandidate,
  type ActionBoundaryActivation,
  type ActionBoundaryCapabilityReference,
  type ActionBoundaryDraft,
  type ActionBoundaryStatus,
} from "./action-boundary.js";

const GUIDED_ACTION_VERSION = "synapsor.guided-action.v1" as const;
const GUIDED_ACTION_INDEX_VERSION = "synapsor.guided-action-index.v1" as const;
const GUIDED_ACTION_ROOT = "synapsor/actions";

export type GuidedActionOperation = "update" | "insert" | "delete";
export type GuidedReceiptMode = "runner_ledger" | "source_auto_migrate" | "source_precreated";

export type GuidedActionWorkerPolicyInput = {
  profile?: "development" | "staging" | "production";
  concurrency?: number;
  queue_limit?: number;
  lease_seconds?: number;
  max_attempts?: number;
  proposal_ttl_seconds?: number;
  rate_limit?: {
    executions: number;
    window_seconds: number;
  };
  worker_identity?: string;
  control_role?: string;
  require_least_privilege_writer?: boolean;
  writer_posture_fingerprint?: `sha256:${string}`;
};

export type GuidedActionWorkerPolicy = {
  profile: "development" | "staging" | "production";
  concurrency: number;
  queue_limit: number;
  lease_seconds: number;
  max_attempts: number;
  proposal_ttl_seconds: number;
  rate_limit: {
    executions: number;
    window_seconds: number;
  };
  require_least_privilege_writer: boolean;
  worker_identity?: string;
  control_role?: string;
  writer_posture_fingerprint?: `sha256:${string}`;
};

export type GuidedActionPatchInput = {
  column: string;
  value_source: "argument" | "fixed";
  argument_name?: string;
  argument_description?: string;
  fixed_value?: JsonScalar;
  minimum?: number;
  maximum?: number;
  max_length?: number;
  allowed_from?: string[];
};

export type GuidedActionAutoApprovalCondition = {
  source?: "patch" | "before";
  field: string;
  operator: "lte" | "gte" | "eq" | "in" | "max_length";
  value?: JsonScalar;
  values?: JsonScalar[];
};

export type GuidedActionAutoApprovalInput = {
  /** Legacy single-threshold input retained for existing automation. */
  field?: string;
  maximum?: number;
  conditions?: GuidedActionAutoApprovalCondition[];
  max_per_day: number;
  max_total_per_day?: number;
  total_field?: string;
};

export type GuidedActionInput = {
  capability_name: string;
  description: string;
  returns_hint?: string;
  resource: string;
  operation: GuidedActionOperation;
  lookup_argument?: string;
  patches?: GuidedActionPatchInput[];
  conflict_column?: string;
  version_advance?: "integer_increment" | "database_generated";
  dedup_proposal_column?: string;
  approval_role: string;
  required_approvals?: number;
  auto_approval?: GuidedActionAutoApprovalInput;
  /** Proposal-only is the default. Execution is a separate reviewed revision. */
  authority_posture?: ActionAuthorityPosture;
  writeback?: {
    mode: ActionWritebackMode;
    executor?: string;
  };
  supervised_worker_execution?: boolean;
  worker_policy?: GuidedActionWorkerPolicyInput;
  reversible?: boolean;
  receipt_mode?: GuidedReceiptMode;
  write_url_env?: string;
  confirmed_trusted_scope: boolean;
  delete_confirmation?: string;
};

export type GuidedActionDraft = {
  schema_version: typeof GUIDED_ACTION_VERSION;
  state: "disabled";
  capability: string;
  source: string;
  resource: string;
  operation: GuidedActionOperation;
  /** Exact read boundary this disabled action revision depends on. */
  boundary_name?: string;
  boundary_digest: `sha256:${string}`;
  generation_lock_fingerprint: `sha256:${string}`;
  action_boundary_name?: string;
  action_boundary_digest?: `sha256:${string}`;
  /** Trusted-scope limits reviewed for this exact disabled action revision. */
  action_boundary_shared_limits?: ActionBoundarySharedLimitV1[];
  contract_digest: `sha256:${string}`;
  dsl_path: string;
  contract_path: string;
  tests_path: string;
  review_path: string;
  write_url_env: string;
  receipt_mode: GuidedReceiptMode;
  authority_posture: ActionAuthorityPosture;
  writeback_mode: ActionWritebackMode;
  writeback_executor?: string;
  supervised_worker_execution: boolean;
  worker_policy?: GuidedActionWorkerPolicy;
  design_path: string;
  runtime_config_path: string;
  created_at: string;
  effect_preview?: {
    contract_digest: `sha256:${string}`;
    proposal_id: string;
    proposal_hash: string;
    source_database_changed: false;
    previewed_at: string;
  };
};

export type GuidedActionActivation = {
  schema_version: typeof GUIDED_ACTION_VERSION;
  state: "active";
  capability: string;
  resource?: string;
  operation?: GuidedActionOperation;
  source?: string;
  boundary_name?: string;
  boundary_digest?: `sha256:${string}`;
  generation_lock_fingerprint?: `sha256:${string}`;
  trusted_context_fingerprint?: `sha256:${string}`;
  action_boundary_name?: string;
  action_boundary_digest?: `sha256:${string}`;
  contract_digest: `sha256:${string}`;
  contract_path: string;
  design_path: string;
  dsl_path: string;
  tests_path: string;
  review_path: string;
  config_path: string;
  authority_posture: ActionAuthorityPosture;
  writeback_mode: ActionWritebackMode;
  writeback_executor?: string;
  actor: string;
  activated_at: string;
  source_database_changed: false;
};

export type GuidedActionStatus = {
  drafts: GuidedActionDraft[];
  activations: GuidedActionActivation[];
  action_boundary: ActionBoundaryStatus;
};

export type GuidedActionAuthorityRevisionInput = {
  authority_posture: ActionAuthorityPosture;
  writeback: {
    mode: ActionWritebackMode;
    executor?: string;
  };
  supervised_worker_execution?: boolean;
  worker_policy?: GuidedActionWorkerPolicyInput;
  receipt_mode?: GuidedReceiptMode;
  write_url_env?: string;
  version_advance?: GuidedActionInput["version_advance"];
};

export type GuidedActionAuthorityRevision = {
  previous: GuidedActionActivation;
  transition: ActionAuthorityTransition;
  draft: GuidedActionDraft;
  dsl: string;
  contract: SynapsorContract;
  tests: Record<string, unknown>;
  preview_args: Record<string, JsonScalar>;
};

export type GuidedActionResourceOption = {
  id: string;
  schema: string;
  table: string;
  label?: string;
  description?: string;
  primary_key: string;
  tenant_key?: string;
  organization_scope?: NonNullable<ActivatedExplorationBoundary["organization_scope"]>;
  principal_key?: string;
  /** Reviewed PostgreSQL session setting applied transaction-locally before source access. */
  principal_rls_setting?: string;
  writable_fields: Array<{
    name: string;
    data_type: string;
    enum_values: string[];
    nullable: boolean;
    required_for_insert: boolean;
    label?: string;
    description?: string;
    suggested_numeric_minimum?: number;
    suggested_numeric_maximum?: number;
  }>;
  /** Structural candidates only. Human review still decides write authority. */
  structurally_eligible_fields: GuidedActionResourceOption["writable_fields"];
  conflict_candidates: string[];
  insert_dedup_candidates: string[];
  kept_out_fields: string[];
  operation_availability: Record<GuidedActionOperation, { available: boolean; reason: string }>;
};

export type GuidedActionBlockedResource = {
  id: string;
  label?: string;
  reasons: string[];
  next_steps: string[];
};

export type GuidedActionOptions = {
  boundary_name: string;
  boundary_state: "active" | "reviewed_pending";
  boundary_digest: `sha256:${string}`;
  source: string;
  deployment_profile: "development" | "staging" | "production";
  resources: GuidedActionResourceOption[];
  blocked_resources: GuidedActionBlockedResource[];
  safe_defaults: Record<string, unknown>;
};

export async function guidedActionOptions(input: {
  projectRoot: string;
  inspection: SchemaInspection;
  boundaryName?: string;
  allowReviewedPending?: boolean;
}): Promise<GuidedActionOptions> {
  const projectRoot = path.resolve(input.projectRoot);
  const resolved = await loadGuidedActionBoundary(projectRoot, input.inspection, {
    ...(input.boundaryName ? { boundaryName: input.boundaryName } : {}),
    allowReviewedPending: input.allowReviewedPending === true,
  });
  return buildGuidedActionOptions(resolved.boundary, resolved.state, input.inspection);
}

/**
 * Builds non-authoritative action-mapping options from the disabled catalog
 * used by job-first onboarding. The candidate is still reviewed and activated
 * through the normal Read Boundary path before any Action Boundary can depend
 * on it.
 */
export function guidedActionOptionsFromCandidate(input: {
  candidate: ExplorationBoundaryDraft;
  inspection: SchemaInspection;
}): GuidedActionOptions {
  const { activation: _activation, unresolved_decisions: _unresolved, ...authority } = input.candidate;
  const boundary: ActivatedExplorationBoundary = {
    ...structuredClone(authority),
    activation: {
      state: "active",
      digest: explorationBoundaryCandidateDigest(input.candidate),
      actor: "job_mapping_catalog",
      activated_at: new Date(0).toISOString(),
      generation_lock_fingerprint: input.candidate.generation_lock_fingerprint,
      reviewed_decisions: [],
    },
  };
  return buildGuidedActionOptions(boundary, "reviewed_pending", input.inspection);
}

function buildGuidedActionOptions(
  boundary: ActivatedExplorationBoundary,
  boundaryState: "active" | "reviewed_pending",
  inspection: SchemaInspection,
): GuidedActionOptions {
  return {
    boundary_name: boundary.pack.name,
    boundary_state: boundaryState,
    boundary_digest: boundary.activation.digest,
    source: boundary.source,
    deployment_profile: boundary.deployment_profile,
    blocked_resources: boundary.pack.resources.flatMap((resource): GuidedActionBlockedResource[] => {
      const reasons: string[] = [];
      const nextSteps: string[] = [];
      if (!resource.tenant_key && !boundary.organization_scope) {
        reasons.push("Guarded writes require a direct reviewed tenant column; relationship-carried read scope is not write authority.");
        nextSteps.push(`Add or review a direct tenant binding on ${resource.id}, then rescan and activate the Read Boundary.`);
      }
      if (resource.principal_scope) {
        reasons.push("This resource carries principal scope through a relationship; guarded writes require a direct principal column when principal scope applies.");
        nextSteps.push(`Add or review a direct principal binding on ${resource.id}, then rescan and activate the Read Boundary.`);
      }
      if (!reasons.length) return [];
      return [{
        id: resource.id,
        ...(resource.label ? { label: resource.label } : {}),
        reasons,
        next_steps: nextSteps,
      }];
    }),
    resources: boundary.pack.resources
      .filter((resource) =>
        (Boolean(resource.tenant_key) || Boolean(boundary.organization_scope))
        && !resource.principal_scope)
      .map((resource) => {
      const table = requireInspectedTable(inspection, resource.schema, resource.table);
      const structurallyEligibleFields = table.columns
        .filter((column) =>
          !column.generated
          && !column.identity
          && !column.suggestions.immutable
          && column.name !== resource.primary_key
          && column.name !== resource.tenant_key
          && column.name !== resource.principal_key
          && !resource.kept_out_fields.includes(column.name)
          && !(resource.model_withheld_fields ?? []).includes(column.name))
        .map((column) => ({
          name: column.name,
          data_type: column.data_type,
          enum_values: column.enum_values ?? [],
          nullable: column.nullable,
          required_for_insert: !column.nullable && column.default === undefined,
        }));
      const writableFieldNames = new Set(structurallyEligibleFields.map((field) => field.name));
      const requiredInsertColumns = table.columns
        .filter((column) =>
          !column.nullable
          && column.default === undefined
          && !column.generated
          && !column.identity)
        .map((column) => column.name);
      const sourceInsertDedupCandidates = (resource.tenant_key
        ? insertIdentityCandidates(table, resource.tenant_key)
        : []);
      const insertDedupCandidates = sourceInsertDedupCandidates
        .filter((candidate) => requiredInsertColumns.every((column) =>
          column === resource.tenant_key
          || column === resource.principal_key
          || column === candidate
          || writableFieldNames.has(column)));
      const blockedRequiredInsertColumns = requiredInsertColumns.filter((column) =>
        column !== resource.tenant_key
        && column !== resource.principal_key
        && !sourceInsertDedupCandidates.includes(column)
        && !writableFieldNames.has(column));
      const baseWrite = table.type === "table" && table.writable;
      const directWriteIdentity = sourcePrimaryKeyMatchesReviewedWriteIdentity(table, {
        primary_key: resource.primary_key,
        ...(resource.tenant_key ? { tenant_key: resource.tenant_key } : {}),
        ...(resource.principal_key ? { principal_scope_key: resource.principal_key } : {}),
      });
      const reviewedOrganization = Boolean(boundary.organization_scope);
      const hardDeleteBlocked = (table.write_triggers?.length ?? 0) > 0
        || (table.referenced_by ?? []).some((foreignKey) => foreignKey.delete_rule === "CASCADE");
      return {
        id: resource.id,
        schema: resource.schema,
        table: resource.table,
        ...(resource.label ? { label: resource.label } : {}),
        ...(resource.description ? { description: resource.description } : {}),
        primary_key: resource.primary_key,
        ...(resource.tenant_key ? { tenant_key: resource.tenant_key } : {}),
        ...(boundary.organization_scope ? { organization_scope: boundary.organization_scope } : {}),
        ...(resource.principal_key ? { principal_key: resource.principal_key } : {}),
        ...(resource.rls_session?.principal_setting
          ? { principal_rls_setting: resource.rls_session.principal_setting }
          : {}),
        writable_fields: structurallyEligibleFields.map((field) => ({
          ...field,
          ...(resource.field_metadata?.[field.name]?.label
            ? { label: resource.field_metadata[field.name]!.label }
            : {}),
          ...(resource.field_metadata?.[field.name]?.description
            ? { description: resource.field_metadata[field.name]!.description }
            : {}),
        })),
        structurally_eligible_fields: structurallyEligibleFields.map((field) => ({
          ...field,
          enum_values: [...field.enum_values],
          ...(resource.field_metadata?.[field.name]?.label
            ? { label: resource.field_metadata[field.name]!.label }
            : {}),
          ...(resource.field_metadata?.[field.name]?.description
            ? { description: resource.field_metadata[field.name]!.description }
            : {}),
        })),
        conflict_candidates: table.suggestions.conflict_columns,
        insert_dedup_candidates: insertDedupCandidates,
        kept_out_fields: resource.kept_out_fields,
        operation_availability: {
          update: {
            available: baseWrite && directWriteIdentity && table.suggestions.conflict_columns.length > 0 && structurallyEligibleFields.length > 0,
            reason: !baseWrite
              ? "Requires an inspected writable base table."
              : !directWriteIdentity
                ? "Requires the reviewed row identity plus direct trusted scope to cover every source primary-key column."
              : table.suggestions.conflict_columns.length === 0
                ? "No source-proven conflict/version field was found."
                : structurallyEligibleFields.length === 0
                  ? "No non-kept-out mutable field is structurally eligible for a separate Action Boundary review."
                  : reviewedOrganization
                    ? "Available as proposal-only authority under the reviewed whole-organization scope."
                    : "Available with explicit bounds, conflict guard, approval, and receipt mode.",
          },
          insert: {
            available: !reviewedOrganization && baseWrite && directWriteIdentity && insertDedupCandidates.length > 0 && structurallyEligibleFields.length > 0,
            reason: reviewedOrganization
              ? "Single-organization INSERT remains unavailable until source-enforced organization-safe deduplication is reviewed."
              : !baseWrite
              ? "Requires an inspected writable base table."
              : !directWriteIdentity
                ? "Requires the reviewed row identity plus direct trusted scope to cover every source primary-key column."
              : structurallyEligibleFields.length === 0
                ? "No non-kept-out mutable field is structurally eligible for a separate Action Boundary review."
              : insertDedupCandidates.length === 0
                ? sourceInsertDedupCandidates.length === 0
                  ? "No primary/unique proposal-identity column can prove retry deduplication."
                  : blockedRequiredInsertColumns.length > 0
                    ? `Required INSERT column${blockedRequiredInsertColumns.length === 1 ? "" : "s"} ${blockedRequiredInsertColumns.join(", ")} ${blockedRequiredInsertColumns.length === 1 ? "is" : "are"} not reviewed for Action Boundary use (kept out or structurally ineligible) and ${blockedRequiredInsertColumns.length === 1 ? "has" : "have"} no source default.`
                    : "No source-proven INSERT shape satisfies every required column."
                : "Available with an inspected dedup identity and explicit field bounds.",
          },
          delete: {
            available: baseWrite && directWriteIdentity && table.suggestions.conflict_columns.length > 0 && !hardDeleteBlocked,
            reason: !baseWrite
              ? "Requires an inspected writable base table."
              : !directWriteIdentity
                ? "Requires the reviewed row identity plus direct trusted scope to cover every source primary-key column."
              : table.suggestions.conflict_columns.length === 0
                ? "No source-proven conflict/version field was found."
                : hardDeleteBlocked
                  ? "Hard delete is blocked because inspected triggers or cascading references may widen the effect."
                  : reviewedOrganization
                    ? "Available as a proposal-only destructive intent with human approval; no writeback authority is granted."
                    : "Available only with human approval and an exact destructive confirmation.",
          },
        },
      };
    }),
    safe_defaults: {
      state: "disabled",
      approval: "human",
      auto_approval: false,
      supervised_worker_execution: false,
      reversible: false,
      receipt_mode: "runner_ledger",
      writeback: "none",
      authority_posture: "proposal_only",
      source_database_changed: false,
      model_can_activate: false,
      model_can_approve: false,
      model_can_apply: false,
    },
  };
}

export async function createGuidedActionDraft(input: {
  projectRoot: string;
  action: GuidedActionInput;
  inspection: SchemaInspection;
  boundaryName?: string;
  allowReviewedPending?: boolean;
  actionBoundaryJobIntent?: string;
  now?: string;
}): Promise<{
  draft: GuidedActionDraft;
  dsl: string;
  contract: SynapsorContract;
  tests: Record<string, unknown>;
  preview_args: Record<string, JsonScalar>;
}> {
  const projectRoot = path.resolve(input.projectRoot);
  const resolved = await loadGuidedActionBoundary(projectRoot, input.inspection, {
    ...(input.boundaryName ? { boundaryName: input.boundaryName } : {}),
    allowReviewedPending: input.allowReviewedPending === true,
  });
  const boundary = resolved.boundary;
  const action = normalizeAction(input.action, boundary.deployment_profile);
  const resource = boundary.pack.resources.find((candidate) => candidate.id === action.resource);
  if (!resource) throw new Error(`GUIDED_ACTION_RESOURCE_UNKNOWN: ${action.resource} is not in the selected reviewed boundary.`);
  assertGuidedActionScopeAuthority(action, boundary, resource);
  const table = requireInspectedTable(input.inspection, resource.schema, resource.table);
  const options = (await guidedActionOptions({
    projectRoot,
    inspection: input.inspection,
    boundaryName: boundary.pack.name,
    allowReviewedPending: resolved.state === "reviewed_pending",
  })).resources
    .find((candidate) => candidate.id === resource.id)!;
  const availability = options.operation_availability[action.operation];
  if (!availability.available) throw new Error(`GUIDED_ACTION_OPERATION_UNAVAILABLE: ${availability.reason}`);
  if (!action.confirmed_trusted_scope) {
    throw new Error("GUIDED_ACTION_SCOPE_CONFIRMATION_REQUIRED: confirm the inherited reviewed tenant and principal scope.");
  }
  validateActionAgainstSource(action, boundary, resource, table);

  const dsl = emitGuidedActionDsl({ action, boundary, resource, table });
  const contract = compileAgentDsl(dsl);
  assertValidContract(contract);
  const capability = contract.capabilities.find((candidate) => candidate.name === action.capability_name);
  if (!capability?.proposal) throw new Error("GUIDED_ACTION_COMPILE_FAILED: generated DSL did not produce proposal authority.");
  const contractDigest = canonicalJsonDigest(contract);
  const tests = guidedActionTests(action, resource, boundary.organization_scope);
  const outputRoot = actionDraftRoot(projectRoot, action.capability_name);
  const dslPath = path.join(outputRoot, "capability.synapsor.sql");
  const contractPath = path.join(outputRoot, "synapsor.contract.json");
  const testsPath = path.join(outputRoot, "contract-tests.json");
  const reviewPath = path.join(outputRoot, "REVIEW.md");
  const designPath = path.join(outputRoot, "action-design.json");
  const runtimeConfigPath = path.join(projectRoot, "synapsor.actions.runner.json");
  const priorDraft = await readOptionalJson(path.join(outputRoot, "draft.json"));
  const preservedPreview = priorDraft?.schema_version === GUIDED_ACTION_VERSION
    && priorDraft.capability === action.capability_name
    && priorDraft.contract_digest === contractDigest
    && isRecord(priorDraft.effect_preview)
    && priorDraft.effect_preview.contract_digest === contractDigest
      ? priorDraft.effect_preview as GuidedActionDraft["effect_preview"]
      : undefined;
  let draft: GuidedActionDraft = {
    schema_version: GUIDED_ACTION_VERSION,
    state: "disabled",
    capability: action.capability_name,
    source: boundary.source,
    resource: action.resource,
    operation: action.operation,
    boundary_name: boundary.pack.name,
    boundary_digest: boundary.activation.digest,
    generation_lock_fingerprint: boundary.generation_lock_fingerprint,
    contract_digest: contractDigest,
    dsl_path: relativeProjectPath(projectRoot, dslPath),
    contract_path: relativeProjectPath(projectRoot, contractPath),
    tests_path: relativeProjectPath(projectRoot, testsPath),
    review_path: relativeProjectPath(projectRoot, reviewPath),
    design_path: relativeProjectPath(projectRoot, designPath),
    runtime_config_path: relativeProjectPath(projectRoot, runtimeConfigPath),
    write_url_env: action.write_url_env,
    receipt_mode: action.receipt_mode,
    authority_posture: action.authority.posture,
    writeback_mode: action.authority.writeback.mode,
    ...(action.authority.writeback.executor
      ? { writeback_executor: action.authority.writeback.executor }
      : {}),
    supervised_worker_execution: action.authority.supervised_worker_execution,
    ...(action.worker_policy ? { worker_policy: action.worker_policy } : {}),
    created_at: input.now ?? new Date().toISOString(),
    ...(preservedPreview ? { effect_preview: preservedPreview } : {}),
  };
  const actionBoundaryDraft = await prospectiveActionBoundaryDraft({
    projectRoot,
    boundary,
    candidateDraft: draft,
    candidateContract: contract,
    ...(input.actionBoundaryJobIntent
      ? { jobIntent: input.actionBoundaryJobIntent }
      : {}),
    now: input.now,
  });
  draft = {
    ...draft,
    action_boundary_name: actionBoundaryDraft.name,
    action_boundary_digest: actionBoundaryDraft.digest,
  };
  await writeGuidedActionArtifacts({
    projectRoot,
    outputRoot,
    draft,
    dsl,
    contract,
    tests,
    design: action,
    review: guidedActionReview(draft, action, resource, boundary.organization_scope),
  });
  await writeActionBoundaryDraft(projectRoot, actionBoundaryDraft);
  return {
    draft,
    dsl,
    contract,
    tests,
    preview_args: previewArgs(action, table, resource.primary_key),
  };
}

/**
 * Drafts a new exact-digest authority revision from the currently active
 * reviewed design. The active revision remains unchanged until the new draft
 * is previewed and explicitly activated.
 */
export async function reviseGuidedActionAuthority(input: {
  projectRoot: string;
  capabilityName: string;
  expectedCurrentDigest: string;
  authority: GuidedActionAuthorityRevisionInput;
  inspection: SchemaInspection;
  now?: string;
}): Promise<GuidedActionAuthorityRevision> {
  const projectRoot = path.resolve(input.projectRoot);
  const previous = await readGuidedActionActivation(projectRoot, input.capabilityName);
  if (!previous) {
    throw new Error(`GUIDED_ACTION_ACTIVE_REQUIRED: ${input.capabilityName} has no active reviewed revision to promote or demote.`);
  }
  if (previous.contract_digest !== input.expectedCurrentDigest) {
    throw new Error("GUIDED_ACTION_ACTIVE_CHANGED: reload the current action revision before drafting an authority change.");
  }
  const designPath = containedProjectPath(projectRoot, previous.design_path);
  const rawDesign = await fs.readFile(designPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error(
        "GUIDED_ACTION_DESIGN_MISSING: this legacy activation predates managed ActionDesign artifacts; recreate it through the action editor before changing execution authority.",
      );
    }
    throw error;
  });
  const design = JSON.parse(rawDesign) as ReturnType<typeof normalizeAction>;
  const previousAuthority = resolveActionAuthority({
    authority_posture: previous.authority_posture,
    writeback: {
      mode: previous.writeback_mode,
      ...(previous.writeback_executor ? { executor: previous.writeback_executor } : {}),
    },
    supervised_worker_execution: previous.authority_posture === "supervised_execution",
  });
  const { authority: _oldAuthority, worker_policy: _oldWorkerPolicy, ...reviewedDesign } = design;
  const nextInput: GuidedActionInput = {
    ...reviewedDesign,
    authority_posture: input.authority.authority_posture,
    writeback: input.authority.writeback,
    supervised_worker_execution: input.authority.supervised_worker_execution === true,
    ...(input.authority.worker_policy ? { worker_policy: input.authority.worker_policy } : {}),
    receipt_mode: input.authority.receipt_mode ?? design.receipt_mode,
    write_url_env: input.authority.write_url_env ?? design.write_url_env,
    ...(input.authority.version_advance ? { version_advance: input.authority.version_advance } : {}),
    confirmed_trusted_scope: true,
  };
  const created = await createGuidedActionDraft({
    projectRoot,
    action: nextInput,
    inspection: input.inspection,
    ...(input.now ? { now: input.now } : {}),
  });
  const capability = created.contract.capabilities.find((candidate) => candidate.name === created.draft.capability);
  const nextAuthority = capability ? actionAuthorityForCapability(capability) : undefined;
  if (!nextAuthority) throw new Error("GUIDED_ACTION_AUTHORITY_MISSING: the new revision did not compile proposal authority.");
  const transition = classifyActionAuthorityTransition(previousAuthority, nextAuthority);
  if (!transition.requires_new_revision || created.draft.contract_digest === previous.contract_digest) {
    throw new Error("GUIDED_ACTION_AUTHORITY_UNCHANGED: the requested execution posture already matches the active revision.");
  }
  return {
    previous,
    transition,
    ...created,
  };
}

export async function prepareGuidedActionPreview(input: {
  projectRoot: string;
  capabilityName: string;
  configPath?: string;
}): Promise<{
  config_path: string;
  capability: string;
  draft_digest: `sha256:${string}`;
}> {
  const projectRoot = path.resolve(input.projectRoot);
  const draft = await readGuidedActionDraft(projectRoot, input.capabilityName);
  const contractPath = containedProjectPath(projectRoot, draft.contract_path);
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8")) as SynapsorContract;
  if (canonicalJsonDigest(contract) !== draft.contract_digest) {
    throw new Error("GUIDED_ACTION_DRAFT_TAMPERED: the canonical draft no longer matches its reviewed digest.");
  }
  const baseConfigPath = path.resolve(input.configPath ?? path.join(projectRoot, "synapsor.runner.json"));
  const runtimeConfigPath = containedProjectPath(projectRoot, draft.runtime_config_path);
  const sourceConfigPath = await existingFile(runtimeConfigPath) ?? baseConfigPath;
  const rawConfig = JSON.parse(await fs.readFile(sourceConfigPath, "utf8")) as Record<string, unknown>;
  const boundary = (await loadGuidedActionBoundary(projectRoot, undefined, {
    ...(draft.boundary_name ? { boundaryName: draft.boundary_name } : {}),
    expectedDigest: draft.boundary_digest,
    allowReviewedPending: true,
  })).boundary;
  const previewPath = path.join(actionDraftRoot(projectRoot, draft.capability), "preview.runner.json");
  const previousActivation = await readGuidedActionActivation(projectRoot, draft.capability);
  const retainDirectSqlSource = await otherActiveGuidedActionsRequireDirectSql(projectRoot, draft.capability);
  const actionBoundary = await prospectiveActionBoundaryDraft({
    projectRoot,
    boundary,
    candidateDraft: draft,
    candidateContract: contract,
    now: draft.created_at,
  });
  const previewConfig = configWithGuidedAction({
    projectRoot,
    sourceConfigPath,
    outputConfigPath: previewPath,
    config: rawConfig,
    contractPath,
    ...(previousActivation
      ? { replaceContractPath: containedProjectPath(projectRoot, previousActivation.contract_path) }
      : {}),
    retainDirectSqlSource,
    isolatedPreview: true,
    draft,
    boundary,
    actionBoundary,
  });
  await validateExpandedGuidedConfig(previewConfig, previewPath, "GUIDED_ACTION_PREVIEW_CONFIG_INVALID");
  await writeAtomic(previewPath, json(previewConfig));
  return {
    config_path: relativeProjectPath(projectRoot, previewPath),
    capability: draft.capability,
    draft_digest: draft.contract_digest,
  };
}

export async function recordGuidedActionPreview(input: {
  projectRoot: string;
  capabilityName: string;
  contractDigest: string;
  proposalId: string;
  proposalHash: string;
  sourceDatabaseChanged: boolean;
  now?: string;
}): Promise<GuidedActionDraft> {
  const projectRoot = path.resolve(input.projectRoot);
  const draft = await readGuidedActionDraft(projectRoot, input.capabilityName);
  if (input.contractDigest !== draft.contract_digest) throw new Error("GUIDED_ACTION_PREVIEW_DIGEST_MISMATCH: preview belongs to another draft.");
  if (input.sourceDatabaseChanged) throw new Error("GUIDED_ACTION_PREVIEW_MUTATED_SOURCE: disabled action preview changed source data.");
  if (!input.proposalId.trim()
    || input.proposalId.length > 256
    || /[\u0000-\u001f\u007f]/.test(input.proposalId)
    || !/^sha256:[a-f0-9]{64}$/.test(input.proposalHash)) {
    throw new Error("GUIDED_ACTION_PREVIEW_IDENTITY_REQUIRED: immutable proposal id and full lowercase sha256 hash are required.");
  }
  const updated: GuidedActionDraft = {
    ...draft,
    effect_preview: {
      contract_digest: draft.contract_digest,
      proposal_id: input.proposalId,
      proposal_hash: input.proposalHash,
      source_database_changed: false,
      previewed_at: input.now ?? new Date().toISOString(),
    },
  };
  await writeAtomic(path.join(actionDraftRoot(projectRoot, draft.capability), "draft.json"), json(updated));
  await updateActionIndex(projectRoot, updated);
  return updated;
}

export async function activateGuidedAction(input: {
  projectRoot: string;
  capabilityName: string;
  expectedDigest: string;
  confirmation: string;
  actor: string;
  inspection: SchemaInspection;
  configPath?: string;
  now?: string;
}): Promise<GuidedActionActivation> {
  const projectRoot = path.resolve(input.projectRoot);
  const actor = reviewedText(input.actor, "operator identity", 128);
  const draft = await readGuidedActionDraft(projectRoot, input.capabilityName);
  const boundary = await loadCurrentBoundary(projectRoot, input.inspection, {
    ...(draft.boundary_name ? { boundaryName: draft.boundary_name } : {}),
    expectedDigest: draft.boundary_digest,
  });
  if (draft.boundary_digest !== boundary.activation.digest
    || draft.generation_lock_fingerprint !== boundary.generation_lock_fingerprint) {
    throw new Error("GUIDED_ACTION_BOUNDARY_STALE: the reviewed data boundary changed; generate and preview a new action draft.");
  }
  const contractPath = containedProjectPath(projectRoot, draft.contract_path);
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8")) as SynapsorContract;
  const digest = canonicalJsonDigest(contract);
  if (digest !== draft.contract_digest || input.expectedDigest !== digest) {
    throw new Error("GUIDED_ACTION_DRAFT_CHANGED: reload and review the exact current draft.");
  }
  if (input.confirmation !== `ACTIVATE ${digest}`) {
    throw new Error(`GUIDED_ACTION_CONFIRMATION_REQUIRED: enter ACTIVATE ${digest}.`);
  }
  if (!draft.effect_preview || draft.effect_preview.contract_digest !== digest || draft.effect_preview.source_database_changed) {
    throw new Error("GUIDED_ACTION_EFFECT_PREVIEW_REQUIRED: run one exact staging proposal preview for this digest before activation.");
  }
  const prospectiveBoundary = await prospectiveActionBoundaryDraft({
    projectRoot,
    boundary,
    candidateDraft: draft,
    candidateContract: contract,
    now: draft.created_at,
  });
  if (draft.action_boundary_name !== prospectiveBoundary.name
    || draft.action_boundary_digest !== prospectiveBoundary.digest) {
    throw new Error(
      "GUIDED_ACTION_BOUNDARY_SET_CHANGED: another action revision changed the prospective Action Boundary; reload and rehearse this draft.",
    );
  }

  const activeRoot = path.join(projectRoot, GUIDED_ACTION_ROOT, "active");
  const revisionRoot = path.join(
    projectRoot,
    GUIDED_ACTION_ROOT,
    "revisions",
    safeCapabilityFileName(draft.capability),
    digest.replace(/^sha256:/, ""),
  );
  const activeContractPath = path.join(revisionRoot, "synapsor.contract.json");
  const activeDesignPath = path.join(revisionRoot, "action-design.json");
  const activeDslPath = path.join(revisionRoot, "capability.synapsor.sql");
  const activeTestsPath = path.join(revisionRoot, "contract-tests.json");
  const activeReviewPath = path.join(revisionRoot, "REVIEW.md");
  const baseConfigPath = path.resolve(input.configPath ?? path.join(projectRoot, "synapsor.runner.json"));
  const configPath = containedProjectPath(projectRoot, draft.runtime_config_path);
  const sourceConfigPath = await existingFile(configPath) ?? baseConfigPath;
  const rawConfig = JSON.parse(await fs.readFile(sourceConfigPath, "utf8")) as Record<string, unknown>;
  const previousActivation = await readGuidedActionActivation(projectRoot, draft.capability);
  const retainDirectSqlSource = await otherActiveGuidedActionsRequireDirectSql(projectRoot, draft.capability);
  const nextConfig = configWithGuidedAction({
    projectRoot,
    sourceConfigPath,
    outputConfigPath: configPath,
    config: rawConfig,
    contractPath: activeContractPath,
    ...(previousActivation
      ? { replaceContractPath: containedProjectPath(projectRoot, previousActivation.contract_path) }
      : {}),
    retainDirectSqlSource,
    draft,
    boundary,
    actionBoundary: prospectiveBoundary,
  });
  await validateExpandedGuidedConfig(nextConfig, configPath, "GUIDED_ACTION_CONFIG_INVALID", {
    path: activeContractPath,
    contents: json(contract),
  });
  const previousConfig = await fs.readFile(configPath, "utf8").then(
    (contents) => ({ existed: true, contents }),
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return { existed: false, contents: undefined };
      throw error;
    },
  );
  const activePointerPath = guidedActionActivationPath(projectRoot, draft.capability);
  const previousActivePointer = await fs.readFile(activePointerPath, "utf8").then(
    (contents) => ({ existed: true, contents }),
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return { existed: false, contents: undefined };
      throw error;
    },
  );
  const environmentPath = path.join(projectRoot, ".env.example");
  let environmentRollback: { existed: boolean; contents?: string } | undefined;
  let actionBoundaryPublication: Awaited<ReturnType<typeof publishActionBoundaryActivation>> | undefined;
  let remainingDraftsPublication: Awaited<ReturnType<typeof rebaseDisabledGuidedActionDrafts>> | undefined;
  const previousActionBoundaryDraft = await readActionBoundaryDraft(projectRoot, prospectiveBoundary.name);
  const activatedAt = input.now ?? new Date().toISOString();
  const active: GuidedActionActivation = {
    schema_version: GUIDED_ACTION_VERSION,
    state: "active",
    capability: draft.capability,
    resource: draft.resource,
    operation: draft.operation,
    source: draft.source,
    boundary_name: draft.boundary_name,
    boundary_digest: draft.boundary_digest,
    generation_lock_fingerprint: draft.generation_lock_fingerprint,
    trusted_context_fingerprint: guidedActionTrustedContextFingerprint(boundary),
    action_boundary_name: prospectiveBoundary.name,
    action_boundary_digest: prospectiveBoundary.digest,
    contract_digest: digest,
    contract_path: relativeProjectPath(projectRoot, activeContractPath),
    design_path: relativeProjectPath(projectRoot, activeDesignPath),
    dsl_path: relativeProjectPath(projectRoot, activeDslPath),
    tests_path: relativeProjectPath(projectRoot, activeTestsPath),
    review_path: relativeProjectPath(projectRoot, activeReviewPath),
    config_path: relativeProjectPath(projectRoot, configPath),
    authority_posture: draft.authority_posture,
    writeback_mode: draft.writeback_mode,
    ...(draft.writeback_executor ? { writeback_executor: draft.writeback_executor } : {}),
    actor,
    activated_at: activatedAt,
    source_database_changed: false,
  };
  await fs.mkdir(activeRoot, { recursive: true, mode: 0o700 });
  const revisionExisted = Boolean(await existingFile(revisionRoot));
  try {
    await fs.mkdir(revisionRoot, { recursive: true, mode: 0o700 });
    await writeAtomic(activeContractPath, json(contract));
    await Promise.all([
      copyGuidedArtifact(projectRoot, draft.design_path, activeDesignPath),
      copyGuidedArtifact(projectRoot, draft.dsl_path, activeDslPath),
      copyGuidedArtifact(projectRoot, draft.tests_path, activeTestsPath),
      copyGuidedArtifact(projectRoot, draft.review_path, activeReviewPath),
    ]);
    if (draft.writeback_mode === "direct_sql") {
      environmentRollback = await extendEnvironmentExample(
        environmentPath,
        [
          "# Runner reads the writer credential only from the launching shell.",
          "# Keep it separate from the read-only onboarding credential.",
          `${draft.write_url_env}=`,
          "",
        ].join("\n"),
      );
    }
    await writeAtomic(path.join(revisionRoot, "activation.json"), json(active));
    await writeAtomic(activePointerPath, json(active));
    actionBoundaryPublication = await publishActionBoundaryActivation({
      projectRoot,
      draft: prospectiveBoundary,
      actor,
      now: activatedAt,
    });
    // Runtime configuration is the actual tool authority. Publish it last so
    // an interrupted activation can only be temporarily under-authorized.
    await writeAtomic(configPath, json(nextConfig));
    await completeActionBoundaryPublication(projectRoot, prospectiveBoundary.name);
    remainingDraftsPublication = await rebaseDisabledGuidedActionDrafts({
      projectRoot,
      inspection: input.inspection,
    });
  } catch (error) {
    await remainingDraftsPublication?.rollback().catch(() => undefined);
    if (previousActionBoundaryDraft) {
      await writeActionBoundaryDraft(projectRoot, previousActionBoundaryDraft).catch(() => undefined);
    } else {
      await completeActionBoundaryPublication(projectRoot, prospectiveBoundary.name).catch(() => undefined);
    }
    await actionBoundaryPublication?.rollback().catch(() => undefined);
    if (previousConfig.existed) await writeAtomic(configPath, previousConfig.contents!).catch(() => undefined);
    else await fs.rm(configPath, { force: true }).catch(() => undefined);
    if (environmentRollback) {
      if (environmentRollback.existed) {
        await writeAtomic(environmentPath, environmentRollback.contents ?? "").catch(() => undefined);
      } else {
        await fs.rm(environmentPath, { force: true }).catch(() => undefined);
      }
    }
    if (previousActivePointer.existed) {
      await writeAtomic(activePointerPath, previousActivePointer.contents!).catch(() => undefined);
    } else {
      await fs.rm(activePointerPath, { force: true }).catch(() => undefined);
    }
    if (!revisionExisted) await fs.rm(revisionRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return active;
}

/**
 * A job may prepare several disabled actions before activating any of them.
 * Once one revision becomes active, every remaining draft must name the new
 * prospective Action Boundary (active set plus that one draft). The action
 * contract and its rehearsal remain byte-for-byte unchanged.
 */
async function rebaseDisabledGuidedActionDrafts(input: {
  projectRoot: string;
  inspection: SchemaInspection;
}): Promise<{ rollback: () => Promise<void> }> {
  const indexPath = path.join(input.projectRoot, ".synapsor/guided-action-drafts.json");
  const priorIndex = await fs.readFile(indexPath, "utf8").then(
    (contents) => ({ existed: true, contents }),
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return { existed: false, contents: undefined };
      throw error;
    },
  );
  const status = await guidedActionStatus(input.projectRoot);
  const activeByCapability = new Map(status.activations.map((activation) => [
    activation.capability,
    activation.contract_digest,
  ]));
  const remaining = status.drafts.filter((draft) =>
    activeByCapability.get(draft.capability) !== draft.contract_digest);
  const priorDraftFiles = await Promise.all(remaining.map(async (draft) => {
    const draftPath = path.join(actionDraftRoot(input.projectRoot, draft.capability), "draft.json");
    return { draftPath, contents: await fs.readFile(draftPath, "utf8") };
  }));
  const rebased: Array<{ draft: GuidedActionDraft; boundary: ActionBoundaryDraft }> = [];
  for (const draft of remaining) {
    let boundary: ActivatedExplorationBoundary;
    try {
      boundary = (await loadGuidedActionBoundary(input.projectRoot, input.inspection, {
        ...(draft.boundary_name ? { boundaryName: draft.boundary_name } : {}),
        expectedDigest: draft.boundary_digest,
        allowReviewedPending: true,
      })).boundary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/GUIDED_ACTION_READ_(?:BOUNDARY_REQUIRED|DEPENDENCY_INACTIVE)/.test(message)) {
        // A draft tied to another unavailable Read Boundary remains untouched.
        continue;
      }
      throw error;
    }
    const contract = JSON.parse(
      await fs.readFile(containedProjectPath(input.projectRoot, draft.contract_path), "utf8"),
    ) as SynapsorContract;
    if (canonicalJsonDigest(contract) !== draft.contract_digest) {
      throw new Error(`GUIDED_ACTION_DRAFT_TAMPERED: ${draft.capability} no longer matches its reviewed digest.`);
    }
    const nextBoundary = await prospectiveActionBoundaryDraft({
      projectRoot: input.projectRoot,
      boundary,
      candidateDraft: draft,
      candidateContract: contract,
      now: draft.created_at,
    });
    rebased.push({
      draft: {
        ...draft,
        action_boundary_name: nextBoundary.name,
        action_boundary_digest: nextBoundary.digest,
      },
      boundary: nextBoundary,
    });
  }

  let rolledBack = false;
  try {
    for (const item of rebased) {
      await writeAtomic(
        path.join(actionDraftRoot(input.projectRoot, item.draft.capability), "draft.json"),
        json(item.draft),
      );
    }
    const byCapability = new Map(rebased.map((item) => [item.draft.capability, item.draft]));
    await writeActionIndex(
      input.projectRoot,
      remaining.map((draft) => byCapability.get(draft.capability) ?? draft),
    );
    const nextBoundary = rebased
      .sort((left, right) => left.draft.capability.localeCompare(right.draft.capability))[0]?.boundary;
    if (nextBoundary) await writeActionBoundaryDraft(input.projectRoot, nextBoundary);
  } catch (error) {
    await Promise.all(priorDraftFiles.map(({ draftPath, contents }) =>
      writeAtomic(draftPath, contents).catch(() => undefined)));
    if (priorIndex.existed) await writeAtomic(indexPath, priorIndex.contents!).catch(() => undefined);
    else await fs.rm(indexPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    rollback: async () => {
      if (rolledBack) return;
      rolledBack = true;
      await Promise.all(priorDraftFiles.map(({ draftPath, contents }) => writeAtomic(draftPath, contents)));
      if (priorIndex.existed) await writeAtomic(indexPath, priorIndex.contents!);
      else await fs.rm(indexPath, { force: true });
    },
  };
}

export async function readGuidedActionDraft(
  projectRootInput: string,
  capabilityName: string,
): Promise<GuidedActionDraft> {
  const projectRoot = path.resolve(projectRootInput);
  const draftPath = path.join(actionDraftRoot(projectRoot, capabilityName), "draft.json");
  const parsed = normalizeGuidedActionDraft(
    projectRoot,
    JSON.parse(await fs.readFile(draftPath, "utf8")) as GuidedActionDraft,
  );
  if (parsed.schema_version !== GUIDED_ACTION_VERSION || parsed.state !== "disabled" || parsed.capability !== capabilityName) {
    throw new Error("GUIDED_ACTION_DRAFT_INVALID: managed draft metadata is invalid.");
  }
  return parsed;
}

export async function readGuidedActionActivation(
  projectRootInput: string,
  capabilityName: string,
): Promise<GuidedActionActivation | undefined> {
  const projectRoot = path.resolve(projectRootInput);
  const parsed = await readOptionalJson(guidedActionActivationPath(projectRoot, capabilityName));
  if (!parsed) return undefined;
  if (parsed.schema_version !== GUIDED_ACTION_VERSION
    || parsed.state !== "active"
    || parsed.capability !== capabilityName) {
    throw new Error("GUIDED_ACTION_ACTIVATION_INVALID: managed activation metadata is invalid.");
  }
  return normalizeGuidedActionActivation(projectRoot, parsed as GuidedActionActivation);
}

/**
 * Loads the reviewed design behind a managed draft or activation and converts
 * its normalized authority representation back into bounded authoring input.
 * Callers still have to create, rehearse, and activate a new immutable digest.
 */
export async function readGuidedActionDesignInput(
  projectRootInput: string,
  capabilityName: string,
  source: "draft" | "active" = "draft",
): Promise<GuidedActionInput> {
  const projectRoot = path.resolve(projectRootInput);
  let artifact: GuidedActionDraft | GuidedActionActivation | undefined;
  if (source === "draft") {
    try {
      artifact = await readGuidedActionDraft(projectRoot, capabilityName);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } else {
    artifact = await readGuidedActionActivation(projectRoot, capabilityName);
  }
  if (!artifact) {
    throw new Error(source === "draft"
      ? `GUIDED_ACTION_DRAFT_REQUIRED: ${capabilityName} has no disabled managed revision.`
      : `GUIDED_ACTION_ACTIVE_REQUIRED: ${capabilityName} has no active managed revision.`);
  }
  const parsed = JSON.parse(
    await fs.readFile(containedProjectPath(projectRoot, artifact.design_path), "utf8"),
  ) as ReturnType<typeof normalizeAction>;
  if (!isRecord(parsed) || !isRecord(parsed.authority)) {
    throw new Error("GUIDED_ACTION_DESIGN_INVALID: the managed ActionDesign is malformed.");
  }
  const authority = parsed.authority as unknown as ResolvedActionAuthority;
  const {
    authority: _authority,
    worker_policy: workerPolicy,
    ...reviewed
  } = parsed;
  return {
    ...reviewed,
    authority_posture: authority.posture,
    writeback: {
      mode: authority.writeback.mode,
      ...(authority.writeback.executor ? { executor: authority.writeback.executor } : {}),
    },
    supervised_worker_execution: authority.supervised_worker_execution,
    ...(workerPolicy ? { worker_policy: workerPolicy } : {}),
    confirmed_trusted_scope: true,
  } as GuidedActionInput;
}

/** Removes one exact disabled managed draft. Active revisions are untouched. */
export async function discardGuidedActionDraft(input: {
  projectRoot: string;
  capabilityName: string;
  expectedDigest: string;
}): Promise<{ capability: string; contract_digest: `sha256:${string}`; source_database_changed: false }> {
  const projectRoot = path.resolve(input.projectRoot);
  const draft = await readGuidedActionDraft(projectRoot, input.capabilityName);
  if (draft.contract_digest !== input.expectedDigest) {
    throw new Error("GUIDED_ACTION_DRAFT_CHANGED: reload the disabled revision before discarding it.");
  }
  const outputRoot = path.dirname(containedProjectPath(projectRoot, draft.design_path));
  const marker = await readOptionalJson(path.join(outputRoot, ".synapsor-guided-action.json"));
  if (marker?.schema_version !== GUIDED_ACTION_VERSION || marker.capability !== draft.capability) {
    throw new Error(`GUIDED_ACTION_OUTPUT_UNMANAGED: refusing to remove ${outputRoot}.`);
  }
  await removeActionFromIndex(projectRoot, draft.capability);
  await fs.rm(outputRoot, { recursive: true, force: false });
  return {
    capability: draft.capability,
    contract_digest: draft.contract_digest,
    source_database_changed: false,
  };
}

export async function guidedActionDraftDetails(
  projectRootInput: string,
  capabilityName: string,
): Promise<{
  draft: GuidedActionDraft;
  dsl: string;
  contract: SynapsorContract;
  tests: Record<string, unknown>;
  preview_args: Record<string, JsonScalar>;
}> {
  const projectRoot = path.resolve(projectRootInput);
  const draft = await readGuidedActionDraft(projectRoot, capabilityName);
  const dsl = await fs.readFile(containedProjectPath(projectRoot, draft.dsl_path), "utf8");
  const contract = JSON.parse(
    await fs.readFile(containedProjectPath(projectRoot, draft.contract_path), "utf8"),
  ) as SynapsorContract;
  const tests = JSON.parse(
    await fs.readFile(containedProjectPath(projectRoot, draft.tests_path), "utf8"),
  ) as Record<string, unknown>;
  if (canonicalJsonDigest(contract) !== draft.contract_digest) {
    throw new Error("GUIDED_ACTION_DRAFT_TAMPERED: the canonical draft no longer matches its reviewed digest.");
  }
  const capability = contract.capabilities.find((candidate) => candidate.name === draft.capability);
  if (!capability) throw new Error("GUIDED_ACTION_CAPABILITY_MISSING: the managed contract no longer contains its action.");
  const previewArgs = Object.fromEntries(Object.entries(capability.args ?? {}).map(([name, definition]) => {
    if (definition.type === "object_array") {
      throw new Error("GUIDED_ACTION_ARGUMENT_SHAPE_UNSUPPORTED: guided actions do not emit object-array arguments.");
    }
    if (definition.type === "number") return [name, definition.minimum ?? 0];
    if (definition.type === "boolean") return [name, false];
    if (definition.enum?.length) return [name, definition.enum[0]!];
    return [name, `replace-with-${name.replace(/_/g, "-")}`];
  }));
  return { draft, dsl, contract, tests, preview_args: previewArgs };
}

export async function guidedActionStatus(projectRootInput: string): Promise<GuidedActionStatus> {
  const projectRoot = path.resolve(projectRootInput);
  const index = await readOptionalJson(path.join(projectRoot, ".synapsor/guided-action-drafts.json"));
  const drafts = Array.isArray(index?.drafts)
    ? index.drafts.filter((item): item is GuidedActionDraft =>
      isRecord(item)
      && item.schema_version === GUIDED_ACTION_VERSION
      && item.state === "disabled"
      && typeof item.capability === "string")
      .map((item) => normalizeGuidedActionDraft(projectRoot, item))
    : [];
  const activeRoot = path.join(projectRoot, GUIDED_ACTION_ROOT, "active");
  const activations: GuidedActionActivation[] = [];
  try {
    for (const entry of await fs.readdir(activeRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".active.json")) continue;
      const parsed = await readOptionalJson(path.join(activeRoot, entry.name));
      if (parsed
        && parsed.schema_version === GUIDED_ACTION_VERSION
        && parsed.state === "active"
        && typeof parsed.capability === "string") {
        activations.push(normalizeGuidedActionActivation(projectRoot, parsed as GuidedActionActivation));
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const sortedDrafts = drafts.sort((left, right) => left.capability.localeCompare(right.capability));
  const sortedActivations = activations.sort((left, right) => left.capability.localeCompare(right.capability));
  const storedBoundary = await actionBoundaryStatus(projectRoot);
  return {
    drafts: sortedDrafts,
    activations: sortedActivations,
    action_boundary: !storedBoundary.active && sortedActivations.length
      ? await synthesizedLegacyActionBoundaryStatus(projectRoot, sortedActivations)
      : storedBoundary,
  };
}

/**
 * Persists the trusted-scope limits that belong to one exact disabled action.
 * The Action Boundary draft remains the authority; this copy lets a later
 * multi-action review reconstruct each disabled prospective revision without
 * borrowing limits from whichever draft happens to be current.
 */
export async function recordGuidedActionBoundaryLimits(input: {
  projectRoot: string;
  capabilityName: string;
  limits?: ActionBoundarySharedLimitV1[];
}): Promise<GuidedActionDraft> {
  const projectRoot = path.resolve(input.projectRoot);
  const draft = await readGuidedActionDraft(projectRoot, input.capabilityName);
  const updated: GuidedActionDraft = {
    ...draft,
    ...(input.limits === undefined
      ? { action_boundary_shared_limits: undefined }
      : { action_boundary_shared_limits: structuredClone(input.limits) }),
  };
  await writeAtomic(path.join(actionDraftRoot(projectRoot, draft.capability), "draft.json"), json(updated));
  await updateActionIndex(projectRoot, updated);
  return updated;
}

export async function reviseGuidedActionBoundary(input: {
  projectRoot: string;
  inspection: SchemaInspection;
  sharedLimits: ActionBoundarySharedLimitV1[];
  label?: string;
  jobIntent?: string;
  now?: string;
}): Promise<ActionBoundaryDraft> {
  const projectRoot = path.resolve(input.projectRoot);
  const status = await guidedActionStatus(projectRoot);
  const current = status.action_boundary.draft ?? status.action_boundary.active;
  if (!current) {
    throw new Error("ACTION_BOUNDARY_REQUIRED: create at least one disabled proposal action before reviewing shared limits.");
  }
  await assertActionBoundarySharedLimitsMatchContracts(projectRoot, current, input.sharedLimits);
  const previousDraft = status.action_boundary.draft;
  const revised = reviseActionBoundaryDraft({
    current,
    sharedLimits: input.sharedLimits,
    ...(input.label ? { label: input.label } : {}),
    ...(input.jobIntent ? { jobIntent: input.jobIntent } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  await writeActionBoundaryDraft(projectRoot, revised);
  try {
    await rebaseDisabledGuidedActionDrafts({
      projectRoot,
      inspection: input.inspection,
    });
  } catch (error) {
    if (previousDraft) await writeActionBoundaryDraft(projectRoot, previousDraft).catch(() => undefined);
    else await completeActionBoundaryPublication(projectRoot, revised.name).catch(() => undefined);
    throw error;
  }
  return (await readActionBoundaryDraft(projectRoot, revised.name)) ?? revised;
}

export async function activateGuidedActionBoundary(input: {
  projectRoot: string;
  expectedDigest: string;
  confirmation: string;
  actor: string;
  configPath?: string;
  now?: string;
}): Promise<ActionBoundaryActivation> {
  const projectRoot = path.resolve(input.projectRoot);
  const status = await guidedActionStatus(projectRoot);
  const draft = status.action_boundary.draft;
  if (!draft) throw new Error("ACTION_BOUNDARY_DRAFT_REQUIRED: no disabled Action Boundary revision is ready to activate.");
  if (draft.digest !== input.expectedDigest) {
    throw new Error("ACTION_BOUNDARY_DRAFT_CHANGED: reload and review the exact current Action Boundary revision.");
  }
  if (input.confirmation !== `ACTIVATE ${draft.digest}`) {
    throw new Error(`ACTION_BOUNDARY_CONFIRMATION_REQUIRED: enter ACTIVATE ${draft.digest}.`);
  }
  const activeContracts = new Map(status.activations.map((activation) => [
    activation.capability,
    activation.contract_digest,
  ]));
  const draftContracts = new Map(draft.authority.capabilities.map((capability) => [
    capability.capability,
    capability.contract_digest,
  ]));
  const exactActiveSet = activeContracts.size === draftContracts.size
    && [...draftContracts].every(([capability, digest]) => activeContracts.get(capability) === digest);
  if (!exactActiveSet) {
    throw new Error(
      "ACTION_BOUNDARY_ACTION_REVIEW_REQUIRED: this boundary also contains a disabled action revision; activate that rehearsed action instead so capability and boundary authority publish together.",
    );
  }
  const configPaths = [...new Set(status.activations.map((activation) =>
    containedProjectPath(projectRoot, activation.config_path)))];
  const configPath = input.configPath
    ? path.resolve(input.configPath)
    : configPaths.length === 1
      ? configPaths[0]!
      : undefined;
  if (!configPath || (configPaths.length && !configPaths.includes(configPath))) {
    throw new Error("ACTION_BOUNDARY_CONFIG_REQUIRED: active action revisions do not identify one common managed runtime config.");
  }
  const previousConfig = await fs.readFile(configPath, "utf8");
  const nextConfig = JSON.parse(previousConfig) as Record<string, unknown>;
  nextConfig.action_boundary = {
    schema_version: draft.schema_version,
    name: draft.name,
    digest: draft.digest,
    authority: draft.authority,
  };
  await validateExpandedGuidedConfig(nextConfig, configPath, "ACTION_BOUNDARY_CONFIG_INVALID");
  let publication: Awaited<ReturnType<typeof publishActionBoundaryActivation>> | undefined;
  try {
    publication = await publishActionBoundaryActivation({
      projectRoot,
      draft,
      actor: reviewedText(input.actor, "operator identity", 128),
      ...(input.now ? { now: input.now } : {}),
    });
    // Runtime configuration is the effective authority and remains the final
    // publication step for a limit-only Action Boundary revision.
    await writeAtomic(configPath, json(nextConfig));
    await completeActionBoundaryPublication(projectRoot, draft.name);
    return publication.activation;
  } catch (error) {
    await publication?.rollback().catch(() => undefined);
    await writeAtomic(configPath, previousConfig).catch(() => undefined);
    await writeActionBoundaryDraft(projectRoot, draft).catch(() => undefined);
    throw error;
  }
}

async function assertActionBoundarySharedLimitsMatchContracts(
  projectRoot: string,
  boundary: ActionBoundaryDraft | ActionBoundaryActivation,
  limits: ActionBoundarySharedLimitV1[],
): Promise<void> {
  // Protocol normalization validates ids, scopes, windows, and capability
  // references. Rebuilding a disabled revision also makes those checks apply
  // before any managed artifact changes.
  const normalized = reviseActionBoundaryDraft({ current: boundary, sharedLimits: limits });
  for (const limit of normalized.authority.shared_limits) {
    if (limit.kind !== "total" || !limit.field) continue;
    const applicable = limit.capability
      ? normalized.authority.capabilities.filter((candidate) => candidate.capability === limit.capability)
      : normalized.authority.capabilities;
    for (const reference of applicable) {
      const contract = await readActionBoundaryReferencedContract(projectRoot, boundary, reference);
      if (canonicalJsonDigest(contract) !== reference.contract_digest) {
        throw new Error(`ACTION_BOUNDARY_ACTIVE_CONTRACT_CHANGED: ${reference.capability} no longer matches its reviewed digest.`);
      }
      const capability = contract.capabilities.find((candidate) => candidate.name === reference.capability);
      if (!capability?.proposal || !guidedProposalPatchFieldIsNumeric(capability, limit.field)) {
        throw new Error(
          `ACTION_BOUNDARY_TOTAL_FIELD_NOT_NUMERIC: ${limit.id} requires ${reference.capability}.${limit.field} to be a reviewed numeric patch field.`,
        );
      }
    }
  }
}

async function readActionBoundaryReferencedContract(
  projectRoot: string,
  boundary: ActionBoundaryDraft | ActionBoundaryActivation,
  reference: ActionBoundaryCapabilityReference,
): Promise<SynapsorContract> {
  const immutablePath = containedProjectPath(projectRoot, reference.contract_path);
  try {
    return JSON.parse(await fs.readFile(immutablePath, "utf8")) as SynapsorContract;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || boundary.state !== "disabled") throw error;
  }

  // A disabled Action Boundary names the immutable path that activation will
  // publish. Until then, validate against the exact-digest managed draft.
  const draft = await readGuidedActionDraft(projectRoot, reference.capability);
  if (draft.contract_digest !== reference.contract_digest) {
    throw new Error(`ACTION_BOUNDARY_DRAFT_CHANGED: ${reference.capability} no longer matches its disabled Action Boundary digest.`);
  }
  return JSON.parse(
    await fs.readFile(containedProjectPath(projectRoot, draft.contract_path), "utf8"),
  ) as SynapsorContract;
}

function guidedProposalPatchFieldIsNumeric(
  capability: SynapsorContract["capabilities"][number],
  field: string,
): boolean {
  if (!capability.proposal || !isRecord(capability.proposal.patch)) return false;
  const binding = capability.proposal.patch[field];
  if (!isRecord(binding)) return false;
  if (typeof binding.fixed === "number" && Number.isFinite(binding.fixed)) return true;
  if (typeof binding.from_arg === "string") {
    const argument = capability.args?.[binding.from_arg];
    return argument?.type === "number";
  }
  return false;
}

async function synthesizedLegacyActionBoundaryStatus(
  projectRoot: string,
  activations: GuidedActionActivation[],
): Promise<ActionBoundaryStatus> {
  const fallbackBoundary = await loadActivatedExplorationBoundary(projectRoot);
  const candidates = await Promise.all(activations.map((activation) =>
    actionBoundaryCandidateForActivation(projectRoot, activation, fallbackBoundary)));
  const draft = buildActionBoundaryDraft({
    candidates,
    now: activations.map((activation) => activation.activated_at).sort().at(-1),
  });
  const active: ActionBoundaryActivation = {
    schema_version: draft.schema_version,
    state: "active",
    name: draft.name,
    label: draft.label,
    job_intent: draft.job_intent,
    authority: draft.authority,
    digest: draft.digest,
    actor: "legacy_action_migration",
    activated_at: activations.map((activation) => activation.activated_at).sort().at(-1)!,
  };
  return {
    active,
    synthesized_from_legacy_actions: true,
  };
}

async function prospectiveActionBoundaryDraft(input: {
  projectRoot: string;
  boundary: ActivatedExplorationBoundary;
  candidateDraft: GuidedActionDraft;
  candidateContract: SynapsorContract;
  jobIntent?: string;
  now?: string;
}): Promise<ActionBoundaryDraft> {
  const status = await guidedActionStatus(input.projectRoot);
  const existingCandidates = await Promise.all(status.activations
    .filter((activation) => activation.capability !== input.candidateDraft.capability)
    .map((activation) => actionBoundaryCandidateForActivation(
      input.projectRoot,
      activation,
      input.boundary,
    )));
  const candidate = actionBoundaryCandidate({
    draft: input.candidateDraft,
    contract: input.candidateContract,
    boundary: input.boundary,
    contractPath: futureGuidedActionContractPath(
      input.projectRoot,
      input.candidateDraft.capability,
      input.candidateDraft.contract_digest,
    ),
  });
  const current = status.action_boundary.draft ?? status.action_boundary.active;
  const includedCapabilities = new Set([
    ...existingCandidates.map((item) => item.capability.capability),
    candidate.capability.capability,
  ]);
  const sharedLimits = uniqueSharedLimits([
    ...(current?.authority.shared_limits.filter((limit) =>
      !limit.capability || includedCapabilities.has(limit.capability)) ?? []),
    ...(input.candidateDraft.action_boundary_shared_limits ?? []),
  ]);
  return buildActionBoundaryDraft({
    name: current?.name ?? DEFAULT_ACTION_BOUNDARY_NAME,
    label: current?.label ?? "Default action boundary",
    jobIntent: current?.job_intent
      ?? input.jobIntent
      ?? "Allow the reviewed agent actions collected for this project.",
    candidates: [...existingCandidates, candidate],
    sharedLimits,
    ...(input.now ? { now: input.now } : {}),
  });
}

function uniqueSharedLimits(limits: ActionBoundarySharedLimitV1[]): ActionBoundarySharedLimitV1[] {
  const byId = new Map<string, ActionBoundarySharedLimitV1>();
  for (const limit of limits) byId.set(limit.id, limit);
  return [...byId.values()];
}

async function actionBoundaryCandidateForActivation(
  projectRoot: string,
  activation: GuidedActionActivation,
  fallbackBoundary: ActivatedExplorationBoundary,
): Promise<ActionBoundaryCandidate> {
  const contract = JSON.parse(
    await fs.readFile(containedProjectPath(projectRoot, activation.contract_path), "utf8"),
  ) as SynapsorContract;
  if (canonicalJsonDigest(contract) !== activation.contract_digest) {
    throw new Error(`ACTION_BOUNDARY_ACTIVE_CONTRACT_CHANGED: ${activation.capability} no longer matches its active digest.`);
  }
  const boundary = activation.boundary_name && activation.boundary_digest
    ? await loadActivatedExplorationBoundary(projectRoot, {
        name: activation.boundary_name,
        digest: activation.boundary_digest,
      })
    : fallbackBoundary;
  return actionBoundaryCandidate({
    draft: {
      schema_version: GUIDED_ACTION_VERSION,
      state: "disabled",
      capability: activation.capability,
      source: activation.source ?? boundary.source,
      resource: activation.resource ?? actionCapabilityResource(contract, activation.capability),
      operation: activation.operation ?? actionCapabilityOperation(contract, activation.capability),
      boundary_name: activation.boundary_name ?? boundary.pack.name,
      boundary_digest: activation.boundary_digest ?? boundary.activation.digest,
      generation_lock_fingerprint: activation.generation_lock_fingerprint ?? boundary.generation_lock_fingerprint,
      contract_digest: activation.contract_digest,
      dsl_path: activation.dsl_path,
      contract_path: activation.contract_path,
      tests_path: activation.tests_path,
      review_path: activation.review_path,
      write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
      receipt_mode: "runner_ledger",
      authority_posture: activation.authority_posture,
      writeback_mode: activation.writeback_mode,
      ...(activation.writeback_executor ? { writeback_executor: activation.writeback_executor } : {}),
      supervised_worker_execution: activation.authority_posture === "supervised_execution",
      design_path: activation.design_path,
      runtime_config_path: activation.config_path,
      created_at: activation.activated_at,
    },
    contract,
    boundary,
    contractPath: activation.contract_path,
  });
}

function actionBoundaryCandidate(input: {
  draft: GuidedActionDraft;
  contract: SynapsorContract;
  boundary: ActivatedExplorationBoundary;
  contractPath: string;
}): ActionBoundaryCandidate {
  const capability = input.contract.capabilities.find((candidate) => candidate.name === input.draft.capability);
  if (!capability?.proposal) {
    throw new Error(`ACTION_BOUNDARY_CAPABILITY_MISSING: ${input.draft.capability} is not a proposal capability in its exact contract.`);
  }
  const approval = capability.proposal.approval ?? { mode: "human" as const };
  const referencedPolicy = approval.policy
    ? input.contract.policies?.find((policy) => policy.name === approval.policy)
    : undefined;
  const executionAuthority = {
    authority_posture: input.draft.authority_posture,
    writeback: capability.proposal.writeback ?? { mode: input.draft.writeback_mode },
    execution: capability.proposal.execution ?? null,
    worker_policy: input.draft.worker_policy ?? null,
    receipt_mode: input.draft.receipt_mode,
  };
  return {
    read_dependency: {
      name: input.draft.boundary_name ?? input.boundary.pack.name,
      source: input.draft.source,
      digest: input.draft.boundary_digest,
      generation_lock_fingerprint: input.draft.generation_lock_fingerprint,
      trusted_context_fingerprint: guidedActionTrustedContextFingerprint(input.boundary),
    },
    capability: {
      capability: input.draft.capability,
      resource: input.draft.resource,
      operation: input.draft.operation,
      contract_digest: input.draft.contract_digest,
      contract_path: input.contractPath,
    },
    approval_policy: {
      capability: input.draft.capability,
      mode: approval.mode === "policy" ? "policy" : "human",
      authority: {
        approval,
        policy: referencedPolicy ?? null,
      },
    },
    execution_profile: {
      capability: input.draft.capability,
      authority_posture: input.draft.authority_posture,
      writeback_mode: input.draft.writeback_mode,
      ...(input.draft.writeback_executor ? { writeback_executor: input.draft.writeback_executor } : {}),
      authority: executionAuthority,
    },
  };
}

function guidedActionTrustedContextFingerprint(boundary: ActivatedExplorationBoundary): `sha256:${string}` {
  return canonicalJsonDigest({
    trusted_context: boundary.trusted_context,
    organization_scope: boundary.organization_scope ?? null,
  });
}

function futureGuidedActionContractPath(
  projectRoot: string,
  capability: string,
  digest: `sha256:${string}`,
): string {
  return relativeProjectPath(projectRoot, path.join(
    projectRoot,
    GUIDED_ACTION_ROOT,
    "revisions",
    safeCapabilityFileName(capability),
    digest.replace(/^sha256:/, ""),
    "synapsor.contract.json",
  ));
}

function actionCapabilityResource(contract: SynapsorContract, capabilityName: string): string {
  const capability = contract.capabilities.find((candidate) => candidate.name === capabilityName);
  const schema = capability?.subject.schema;
  const table = capability?.subject.table;
  if (!schema || !table) throw new Error(`ACTION_BOUNDARY_RESOURCE_MISSING: ${capabilityName} has no reviewed source resource.`);
  return `${schema}.${table}`;
}

function actionCapabilityOperation(contract: SynapsorContract, capabilityName: string): GuidedActionOperation {
  const capability = contract.capabilities.find((candidate) => candidate.name === capabilityName);
  const operation = capability?.proposal?.operation?.kind;
  if (operation !== "insert" && operation !== "update" && operation !== "delete") {
    throw new Error(`ACTION_BOUNDARY_OPERATION_MISSING: ${capabilityName} has no reviewed write operation.`);
  }
  return operation;
}

async function otherActiveGuidedActionsRequireDirectSql(
  projectRoot: string,
  excludedCapability: string,
): Promise<boolean> {
  const status = await guidedActionStatus(projectRoot);
  return status.activations.some((activation) =>
    activation.capability !== excludedCapability && activation.writeback_mode === "direct_sql");
}

function emitGuidedActionDsl(input: {
  action: ReturnType<typeof normalizeAction>;
  boundary: ActivatedExplorationBoundary;
  resource: ActivatedExplorationBoundary["pack"]["resources"][number];
  table: TableInfo;
}): string {
  const { action, boundary, resource, table } = input;
  const organizationScope = boundary.organization_scope;
  const tenantKey = organizationScope ? undefined : requireDirectWriteTenantKey(resource);
  const contextName = safeIdentifier(`guided_${safeCapabilityFileName(action.capability_name)}`);
  const lookupArgument = action.lookup_argument || `${singular(resource.table)}_id`;
  const principalBinding = resource.principal_key
    ? boundary.trusted_context.provider === "http_claims"
      ? `  BIND principal FROM HTTP_CLAIM ${safeBindingKey(boundary.trusted_context.principal_claim)} REQUIRED`
      : `  BIND principal FROM ENVIRONMENT ${safeIdentifier(boundary.trusted_context.principal_env)} REQUIRED`
    : undefined;
  const tenantBinding = organizationScope
    ? `  BIND tenant_id FROM REVIEWED_ORGANIZATION ${organizationScope.organization_id} REQUIRED`
    : boundary.trusted_context.provider === "http_claims"
      ? `  BIND tenant_id FROM HTTP_CLAIM ${safeBindingKey(boundary.trusted_context.tenant_claim!)} REQUIRED`
      : `  BIND tenant_id FROM ENVIRONMENT ${safeIdentifier(boundary.trusted_context.tenant_env)} REQUIRED`;
  const contextBindings = [tenantBinding, ...(principalBinding ? [principalBinding] : [])];
  const actionOnlyReadFields = [
    ...(action.operation === "insert"
      ? []
      : [resource.primary_key]),
    ...action.patches.map((patch) => patch.column),
    ...(action.auto_approval?.conditions
      .filter((condition) => condition.source === "before")
      .map((condition) => condition.field) ?? []),
    ...(action.operation !== "insert" && action.conflict_column ? [action.conflict_column] : []),
  ];
  const actionReadFields = [...new Set([
    ...resource.selectable_fields,
    ...actionOnlyReadFields,
  ])].filter((field) => !resource.kept_out_fields.includes(field));
  const actionModelWithheldFields = [...new Set([
    ...(resource.model_withheld_fields ?? []),
    ...actionOnlyReadFields.filter((field) => !resource.selectable_fields.includes(field)),
  ])].filter((field) => actionReadFields.includes(field));
  const lines = [
    `CREATE AGENT CONTEXT ${contextName}`,
    ...contextBindings,
    "  TENANT BINDING tenant_id",
    ...(principalBinding ? ["  PRINCIPAL BINDING principal"] : []),
    "END",
    "",
    `CREATE CAPABILITY ${action.capability_name}`,
    `  DESCRIPTION '${escapeDslString(action.description)}'`,
    `  RETURNS HINT '${escapeDslString(action.returns_hint)}'`,
    `  USING CONTEXT ${contextName}`,
    `  SOURCE ${safeIdentifier(boundary.source)}`,
    `  ON ${safeIdentifier(resource.schema)}.${safeIdentifier(resource.table)}`,
    `  PRIMARY KEY ${safeIdentifier(resource.primary_key)}`,
    ...(tenantKey ? [`  TENANT KEY ${safeIdentifier(tenantKey)}`] : []),
    ...(resource.principal_key ? [`  PRINCIPAL SCOPE KEY ${safeIdentifier(resource.principal_key)}`] : []),
    ...(action.operation === "insert" ? [] : [
      `  CONFLICT GUARD ${safeIdentifier(action.conflict_column!)}`,
      `  LOOKUP ${safeIdentifier(lookupArgument)} BY ${safeIdentifier(resource.primary_key)}`,
      argumentDsl(lookupArgument, requireColumn(table, resource.primary_key), {
        argument_description: `Exact ${singular(resource.table)} identifier.`,
      }),
    ]),
    ...action.patches
      .filter((patch) => patch.value_source === "argument")
      .map((patch) => argumentDsl(patch.argument_name!, requireColumn(table, patch.column), patch)),
    `  ALLOW READ ${actionReadFields.map(safeIdentifier).join(", ")}`,
    ...(actionModelWithheldFields.length
      ? [`  MODEL WITHHELD ${actionModelWithheldFields.map(safeIdentifier).join(", ")}`]
      : []),
    ...(resource.kept_out_fields.length ? [`  KEEP OUT ${resource.kept_out_fields.map(safeIdentifier).join(", ")}`] : []),
    "  REQUIRE EVIDENCE",
    "  MAX ROWS 1",
    `  PROPOSE ACTION ${safeIdentifier(lastCapabilitySegment(action.capability_name))} ${action.operation.toUpperCase()}`,
    ...(organizationScope
      ? [`  ACTION SINGLE ORGANIZATION '${escapeDslString(organizationScope.organization_id)}' ACKNOWLEDGED`]
      : []),
    ...(action.operation === "insert" ? [
      `  DEDUP KEY ${safeIdentifier(tenantKey!)} = TRUSTED TENANT, ${safeIdentifier(action.dedup_proposal_column!)} = PROPOSAL ID`,
    ] : []),
    ...(action.operation === "delete" ? [] : [
      `  ALLOW WRITE ${action.patches.map((patch) => safeIdentifier(patch.column)).join(", ")}`,
      ...action.patches.map((patch) => `  PATCH ${safeIdentifier(patch.column)} = ${patchValueDsl(patch)}`),
      ...action.patches.flatMap((patch) => numericBoundDsl(patch, requireColumn(table, patch.column))),
      ...action.patches.flatMap((patch) => transitionDsl(patch, action.operation)),
    ]),
    ...(action.version_advance ? [
      `  ADVANCE VERSION ${safeIdentifier(action.conflict_column!)} USING ${action.version_advance === "integer_increment" ? "INTEGER INCREMENT" : "DATABASE GENERATED"}`,
    ] : []),
    `  APPROVAL ROLE ${safeIdentifier(action.approval_role)}`,
    ...(action.required_approvals > 1 ? [`  REQUIRE ${action.required_approvals} APPROVALS`] : []),
    ...(action.auto_approval ? [
      ...action.auto_approval.conditions.map(autoApprovalConditionDsl),
      `  LIMIT ${action.auto_approval.max_per_day} PER DAY`,
      ...(action.auto_approval.max_total_per_day !== undefined
        ? [`  LIMIT TOTAL ${action.auto_approval.max_total_per_day} OF ${safeIdentifier(action.auto_approval.total_field!)} PER DAY`]
        : []),
    ] : []),
    ...(action.authority.supervised_worker_execution ? ["  ALLOW SUPERVISED WORKER APPLY"] : []),
    guidedActionWritebackDsl(action.authority),
    ...(action.reversible ? ["  REVERSIBLE"] : []),
    "END",
  ];
  const dsl = `${lines.join("\n")}\n`;
  return `${formatAgentDsl(dsl)}\n`;
}

function guidedActionWritebackDsl(authority: ResolvedActionAuthority): string {
  if (authority.writeback.mode === "none") return "  WRITEBACK NONE";
  if (authority.writeback.mode === "direct_sql") return "  WRITEBACK DIRECT SQL";
  if (authority.writeback.mode === "cloud_worker") return "  WRITEBACK CLOUD WORKER";
  return `  WRITEBACK APP HANDLER EXECUTOR ${safeIdentifier(authority.writeback.executor!)}`;
}

type NormalizedGuidedAutoApproval = {
  conditions: Array<Required<Pick<GuidedActionAutoApprovalCondition, "source" | "field" | "operator">> & {
    value?: JsonScalar;
    values?: JsonScalar[];
  }>;
  max_per_day: number;
  max_total_per_day?: number;
  total_field?: string;
};

function normalizeGuidedAutoApproval(
  input: GuidedActionAutoApprovalInput | undefined,
  patches: Array<ReturnType<typeof normalizePatch>>,
): NormalizedGuidedAutoApproval | undefined {
  if (!input) return undefined;
  const legacy = input.field !== undefined || input.maximum !== undefined;
  if (legacy && input.conditions?.length) {
    throw new Error("GUIDED_ACTION_AUTO_APPROVAL_SHAPE_CONFLICT: use legacy field/maximum or typed conditions, not both.");
  }
  let rawConditions: GuidedActionAutoApprovalCondition[];
  if (legacy) {
    if (!input.field || typeof input.maximum !== "number" || !Number.isFinite(input.maximum)) {
      throw new Error("GUIDED_ACTION_AUTO_APPROVAL_FIELD_INVALID: legacy auto-approval requires one field and finite maximum.");
    }
    rawConditions = [{ field: input.field, operator: "lte", value: input.maximum }];
  } else {
    rawConditions = input.conditions ?? [];
  }
  if (rawConditions.length < 1 || rawConditions.length > 16) {
    throw new Error("GUIDED_ACTION_AUTO_APPROVAL_CONDITION_COUNT: use 1 through 16 deterministic conditions.");
  }
  const seen = new Set<string>();
  const conditions = rawConditions.map((condition) => {
    const source = condition.source ?? "patch";
    const field = safeIdentifier(condition.field);
    const key = `${source}:${field}:${condition.operator}`;
    if (seen.has(key)) throw new Error(`GUIDED_ACTION_AUTO_APPROVAL_CONDITION_DUPLICATE: ${key}.`);
    seen.add(key);
    if (source !== "patch" && source !== "before") {
      throw new Error("GUIDED_ACTION_AUTO_APPROVAL_SOURCE_INVALID: conditions may read patch or before values only.");
    }
    if (condition.operator === "in") {
      if (!Array.isArray(condition.values) || condition.values.length < 1 || condition.values.length > 64) {
        throw new Error(`GUIDED_ACTION_AUTO_APPROVAL_VALUES_INVALID: ${field} IN requires 1 through 64 reviewed values.`);
      }
      condition.values.forEach((value) => assertJsonScalar(value, `auto-approval ${field} value`));
      return { source, field, operator: "in" as const, values: [...condition.values] };
    }
    if (condition.operator !== "lte" && condition.operator !== "gte" && condition.operator !== "eq" && condition.operator !== "max_length") {
      throw new Error(`GUIDED_ACTION_AUTO_APPROVAL_OPERATOR_INVALID: ${condition.operator}.`);
    }
    if (!Object.prototype.hasOwnProperty.call(condition, "value")) {
      throw new Error(`GUIDED_ACTION_AUTO_APPROVAL_VALUE_REQUIRED: ${source}.${field} ${condition.operator}.`);
    }
    assertJsonScalar(condition.value, `auto-approval ${field} value`);
    if ((condition.operator === "lte" || condition.operator === "gte" || condition.operator === "max_length")
      && (typeof condition.value !== "number" || !Number.isFinite(condition.value))) {
      throw new Error(`GUIDED_ACTION_AUTO_APPROVAL_NUMERIC_VALUE_REQUIRED: ${source}.${field} ${condition.operator}.`);
    }
    return { source, field, operator: condition.operator, value: condition.value };
  });
  const modelControlledFields = patches
    .filter((patch) => patch.value_source === "argument")
    .map((patch) => patch.column);
  for (const field of modelControlledFields) {
    if (!conditions.some((condition) => condition.source === "patch" && condition.field === field)) {
      throw new Error(`GUIDED_ACTION_AUTO_APPROVAL_FIELD_UNCOVERED: model-controlled patch ${field} needs an explicit policy condition.`);
    }
  }
  if (!positiveInteger(input.max_per_day)) {
    throw new Error("GUIDED_ACTION_AUTO_APPROVAL_LIMIT_REQUIRED: max_per_day must be a positive integer.");
  }
  let totalField = input.total_field ? safeIdentifier(input.total_field) : undefined;
  if (input.max_total_per_day !== undefined) {
    if (!positiveInteger(input.max_total_per_day)) {
      throw new Error("GUIDED_ACTION_AUTO_APPROVAL_TOTAL_INVALID: max_total_per_day must be a positive integer.");
    }
    if (!totalField) {
      const numericFields = [...new Set(conditions
        .filter((condition) => condition.source === "patch" && (condition.operator === "lte" || condition.operator === "gte"))
        .map((condition) => condition.field))];
      if (numericFields.length !== 1) {
        throw new Error("GUIDED_ACTION_AUTO_APPROVAL_TOTAL_FIELD_REQUIRED: choose one numeric patch field for the aggregate circuit breaker.");
      }
      [totalField] = numericFields;
    }
  } else if (totalField) {
    throw new Error("GUIDED_ACTION_AUTO_APPROVAL_TOTAL_REQUIRED: total_field requires max_total_per_day.");
  }
  return {
    conditions,
    max_per_day: input.max_per_day,
    ...(input.max_total_per_day !== undefined ? { max_total_per_day: input.max_total_per_day } : {}),
    ...(totalField ? { total_field: totalField } : {}),
  };
}

function autoApprovalConditionDsl(condition: NormalizedGuidedAutoApproval["conditions"][number]): string {
  const prefix = condition.source === "before" ? "CURRENT " : "";
  if (condition.operator === "in") {
    return `  AUTO APPROVE WHEN ${prefix}${safeIdentifier(condition.field)} IN (${condition.values!.map(dslLiteral).join(", ")})`;
  }
  if (condition.operator === "max_length") {
    return `  AUTO APPROVE WHEN ${prefix}${safeIdentifier(condition.field)} LENGTH <= ${condition.value}`;
  }
  const operator = condition.operator === "lte" ? "<=" : condition.operator === "gte" ? ">=" : "=";
  return `  AUTO APPROVE WHEN ${prefix}${safeIdentifier(condition.field)} ${operator} ${dslLiteral(condition.value)}`;
}

function assertJsonScalar(value: unknown, label: string): asserts value is JsonScalar {
  if (value !== null && typeof value !== "string" && typeof value !== "boolean"
    && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`GUIDED_ACTION_LITERAL_INVALID: ${label} must be a finite JSON scalar.`);
  }
}

function normalizeAction(
  input: GuidedActionInput,
  deploymentProfile: "development" | "staging" | "production",
) {
  const capabilityName = qualifiedCapabilityName(input.capability_name);
  const operation = input.operation;
  if (!["update", "insert", "delete"].includes(operation)) throw new Error("GUIDED_ACTION_OPERATION_INVALID: choose update, insert, or delete.");
  const description = reviewedText(input.description, "description", 500);
  const returnsHint = reviewedText(
    input.returns_hint ?? "Returns an immutable reviewable proposal and source_database_changed:false.",
    "returns hint",
    500,
  );
  const approvalRole = safeIdentifier(input.approval_role);
  const requiredApprovals = input.required_approvals ?? 1;
  if (!Number.isSafeInteger(requiredApprovals) || requiredApprovals < 1 || requiredApprovals > 10) {
    throw new Error("GUIDED_ACTION_APPROVAL_QUORUM_INVALID: required approvals must be from 1 through 10.");
  }
  const patches = operation === "delete" ? [] : (input.patches ?? []).map(normalizePatch);
  if (operation !== "delete" && patches.length === 0) throw new Error("GUIDED_ACTION_PATCH_REQUIRED: choose at least one exact field and value.");
  if (new Set(patches.map((patch) => patch.column)).size !== patches.length) throw new Error("GUIDED_ACTION_PATCH_DUPLICATED: each column may appear once.");
  if ((operation === "update" || operation === "delete") && !input.conflict_column) {
    throw new Error("GUIDED_ACTION_CONFLICT_REQUIRED: UPDATE and DELETE require a source-proven conflict/version field.");
  }
  const receiptMode = input.receipt_mode ?? "runner_ledger";
  if (!["runner_ledger", "source_auto_migrate", "source_precreated"].includes(receiptMode)) {
    throw new Error("GUIDED_ACTION_RECEIPT_MODE_INVALID: choose runner_ledger, source_auto_migrate, or source_precreated.");
  }
  const authority = resolveActionAuthority(input, {
    legacyExecutableHint: input.reversible === true || input.receipt_mode !== undefined || input.write_url_env !== undefined,
  });
  const workerPolicy = authority.supervised_worker_execution
    ? normalizeWorkerPolicy(input.worker_policy, authority, deploymentProfile)
    : undefined;
  if (authority.writeback.mode === "direct_sql"
    && receiptMode === "runner_ledger"
    && operation === "update"
    && !input.version_advance) {
    throw new Error("GUIDED_ACTION_VERSION_ADVANCE_REQUIRED: runner_ledger UPDATE must advance its exact version field in the source transaction.");
  }
  if (input.reversible && operation !== "update") {
    throw new Error("GUIDED_ACTION_REVERSIBLE_OPERATION_UNSUPPORTED: the guided path supports reviewed compensation for UPDATE only; use advanced authoring for other reviewed shapes.");
  }
  if (input.reversible && input.version_advance !== "integer_increment") {
    throw new Error("GUIDED_ACTION_REVERSIBLE_VERSION_REQUIRED: reversible UPDATE requires exact integer version advancement.");
  }
  const autoApproval = normalizeGuidedAutoApproval(input.auto_approval, patches);
  if (input.reversible && autoApproval) {
    throw new Error("GUIDED_ACTION_REVERSIBLE_AUTO_APPROVAL_FORBIDDEN: reviewed compensation requires independent human approval.");
  }
  if (authority.supervised_worker_execution && input.reversible) {
    throw new Error("GUIDED_ACTION_REVERSIBLE_SUPERVISED_WORKER_FORBIDDEN: reviewed compensation remains outside supervised automatic execution.");
  }
  if (authority.supervised_worker_execution && operation === "delete") {
    throw new Error("GUIDED_ACTION_DELETE_SUPERVISED_WORKER_FORBIDDEN: hard DELETE remains outside supervised automatic execution.");
  }
  if (autoApproval && operation === "delete") {
    throw new Error("GUIDED_ACTION_DELETE_AUTO_APPROVAL_FORBIDDEN: hard DELETE always requires human review.");
  }
  if (autoApproval && requiredApprovals > 1) {
    throw new Error("GUIDED_ACTION_QUORUM_AUTO_APPROVAL_FORBIDDEN: a multi-reviewer quorum cannot be presented as immediate policy completion.");
  }
  if (input.reversible && authority.writeback.mode !== "direct_sql") {
    throw new Error("GUIDED_ACTION_REVERSIBLE_DIRECT_SQL_REQUIRED: reviewed compensation requires Runner-owned direct_sql execution authority.");
  }
  if (operation === "delete" && input.delete_confirmation !== `DELETE ${input.resource}`) {
    throw new Error(`GUIDED_ACTION_DELETE_CONFIRMATION_REQUIRED: enter DELETE ${input.resource}.`);
  }
  if (autoApproval && !positiveInteger(autoApproval.max_per_day)) {
    throw new Error("GUIDED_ACTION_AUTO_APPROVAL_LIMIT_REQUIRED: set a positive per-day count circuit breaker.");
  }
  return {
    ...input,
    capability_name: capabilityName,
    description,
    returns_hint: returnsHint,
    operation,
    patches,
    conflict_column: input.conflict_column ? safeIdentifier(input.conflict_column) : undefined,
    lookup_argument: input.lookup_argument ? safeIdentifier(input.lookup_argument) : undefined,
    dedup_proposal_column: input.dedup_proposal_column ? safeIdentifier(input.dedup_proposal_column) : undefined,
    approval_role: approvalRole,
    required_approvals: requiredApprovals,
    authority,
    auto_approval: autoApproval,
    supervised_worker_execution: authority.supervised_worker_execution,
    worker_policy: workerPolicy,
    reversible: input.reversible === true,
    receipt_mode: receiptMode,
    write_url_env: safeEnvironmentName(input.write_url_env ?? "SYNAPSOR_DATABASE_WRITE_URL"),
    confirmed_trusted_scope: input.confirmed_trusted_scope === true,
  };
}

function normalizeWorkerPolicy(
  input: GuidedActionWorkerPolicyInput | undefined,
  authority: ResolvedActionAuthority,
  deploymentProfile: "development" | "staging" | "production",
): GuidedActionWorkerPolicy {
  if (!authority.supervised_worker_execution || authority.writeback.mode !== "direct_sql") {
    throw new Error("GUIDED_ACTION_WORKER_AUTHORITY_INVALID: supervised execution requires reviewed direct_sql authority.");
  }
  const profile = input?.profile ?? deploymentProfile;
  if (profile !== deploymentProfile) {
    throw new Error(`GUIDED_ACTION_WORKER_PROFILE_MISMATCH: worker profile ${profile} must match boundary profile ${deploymentProfile}.`);
  }
  const boundedInteger = (value: number | undefined, fallback: number, minimum: number, maximum: number, name: string) => {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
      throw new Error(`GUIDED_ACTION_WORKER_BOUND_INVALID: ${name} must be an integer from ${minimum} through ${maximum}.`);
    }
    return resolved;
  };
  const requireLeastPrivilege = input?.require_least_privilege_writer ?? profile === "production";
  if (profile === "production" && (!requireLeastPrivilege || !input?.writer_posture_fingerprint)) {
    throw new Error(
      "GUIDED_ACTION_PRODUCTION_WORKER_POSTURE_REQUIRED: production supervised execution requires an exact reviewed least-privilege writer posture fingerprint.",
    );
  }
  if (input?.writer_posture_fingerprint
    && !/^sha256:[a-f0-9]{64}$/.test(input.writer_posture_fingerprint)) {
    throw new Error("GUIDED_ACTION_WORKER_POSTURE_INVALID: writer_posture_fingerprint must be an exact lowercase sha256 digest.");
  }
  return {
    profile,
    concurrency: boundedInteger(input?.concurrency, 1, 1, 32, "concurrency"),
    queue_limit: boundedInteger(input?.queue_limit, 100, 1, 10_000, "queue_limit"),
    lease_seconds: boundedInteger(input?.lease_seconds, 300, 15, 3_600, "lease_seconds"),
    max_attempts: boundedInteger(input?.max_attempts, 5, 1, 100, "max_attempts"),
    proposal_ttl_seconds: boundedInteger(input?.proposal_ttl_seconds, 86_400, 60, 2_592_000, "proposal_ttl_seconds"),
    rate_limit: {
      executions: boundedInteger(input?.rate_limit?.executions, 60, 1, 100_000, "rate_limit.executions"),
      window_seconds: boundedInteger(input?.rate_limit?.window_seconds, 60, 1, 86_400, "rate_limit.window_seconds"),
    },
    require_least_privilege_writer: requireLeastPrivilege,
    ...(input?.worker_identity ? { worker_identity: safeIdentifier(input.worker_identity) } : {}),
    ...(input?.control_role ? { control_role: safeIdentifier(input.control_role) } : {}),
    ...(input?.writer_posture_fingerprint
      ? { writer_posture_fingerprint: input.writer_posture_fingerprint }
      : {}),
  };
}

function normalizePatch(input: GuidedActionPatchInput): GuidedActionPatchInput & {
  column: string;
  argument_name?: string;
  allowed_from: string[];
} {
  const column = safeIdentifier(input.column);
  if (input.value_source !== "argument" && input.value_source !== "fixed") {
    throw new Error(`GUIDED_ACTION_VALUE_SOURCE_INVALID: ${column} must use an argument or fixed reviewed value.`);
  }
  if (input.value_source === "argument" && !input.argument_name) {
    throw new Error(`GUIDED_ACTION_ARGUMENT_REQUIRED: ${column} requires an argument name.`);
  }
  if (input.value_source === "fixed" && !Object.hasOwn(input, "fixed_value")) {
    throw new Error(`GUIDED_ACTION_FIXED_VALUE_REQUIRED: ${column} requires one explicit fixed value.`);
  }
  if (input.minimum !== undefined && !Number.isFinite(input.minimum)) throw new Error(`GUIDED_ACTION_BOUND_INVALID: ${column} minimum must be finite.`);
  if (input.maximum !== undefined && !Number.isFinite(input.maximum)) throw new Error(`GUIDED_ACTION_BOUND_INVALID: ${column} maximum must be finite.`);
  if (input.minimum !== undefined && input.maximum !== undefined && input.minimum > input.maximum) {
    throw new Error(`GUIDED_ACTION_BOUND_INVALID: ${column} minimum exceeds maximum.`);
  }
  return {
    ...input,
    column,
    ...(input.argument_name ? { argument_name: safeIdentifier(input.argument_name) } : {}),
    allowed_from: [...new Set(input.allowed_from ?? [])].map((value) => reviewedText(value, `${column} transition source`, 128)),
  };
}

function validateActionAgainstSource(
  action: ReturnType<typeof normalizeAction>,
  boundary: ActivatedExplorationBoundary,
  resource: ActivatedExplorationBoundary["pack"]["resources"][number],
  table: TableInfo,
): void {
  const tenantKey = boundary.organization_scope ? undefined : requireDirectWriteTenantKey(resource);
  if (table.type !== "table" || !table.writable) throw new Error("GUIDED_ACTION_TABLE_REQUIRED: a Safe Action requires an inspected writable base table, even when its first revision is proposal-only.");
  if (!sourcePrimaryKeyMatchesReviewedWriteIdentity(table, {
    primary_key: resource.primary_key,
    ...(tenantKey ? { tenant_key: tenantKey } : {}),
    ...(resource.principal_key ? { principal_scope_key: resource.principal_key } : {}),
  })) {
    throw new Error("GUIDED_ACTION_PRIMARY_KEY_MISMATCH: the reviewed row identity plus direct trusted scope must cover every source primary-key column.");
  }
  const conflict = action.conflict_column;
  if (conflict && !table.suggestions.conflict_columns.includes(conflict)) {
    throw new Error(`GUIDED_ACTION_CONFLICT_UNPROVEN: ${conflict} is not an inspected conflict/version candidate.`);
  }
  for (const patch of action.patches) {
    const column = requireColumn(table, patch.column);
    if (column.generated || column.identity) throw new Error(`GUIDED_ACTION_GENERATED_COLUMN_BLOCKED: ${patch.column} is database-generated.`);
    if (column.suggestions.immutable) throw new Error(`GUIDED_ACTION_IMMUTABLE_COLUMN_BLOCKED: ${patch.column} is inspected as immutable.`);
    if (resource.kept_out_fields.includes(patch.column)) {
      throw new Error(`GUIDED_ACTION_FIELD_NOT_REVIEWED: ${patch.column} is kept out by the reviewed structural catalog.`);
    }
    validatePatchType(patch, column, action.operation);
  }
  if (action.auto_approval) {
    validateGuidedAutoApprovalAgainstSource(action.auto_approval, action.patches, resource, table);
  }
  if (action.operation === "insert") {
    const dedup = action.dedup_proposal_column;
    if (!tenantKey || !dedup || !insertIdentityCandidates(table, tenantKey).includes(dedup)) {
      throw new Error("GUIDED_ACTION_INSERT_DEDUP_UNPROVEN: select a primary/unique proposal-identity column proven by inspected metadata.");
    }
  }
  if (tenantKey) {
    const prerequisites = assessDirectWritePrerequisites(table, {
      operation: action.operation,
      primary_key: resource.primary_key,
      tenant_key: tenantKey,
      ...(resource.principal_key ? { principal_scope_key: resource.principal_key } : {}),
      allowed_columns: action.patches.map((patch) => patch.column),
      patch_columns: action.patches.map((patch) => patch.column),
      ...(conflict ? { conflict_column: conflict } : {}),
      ...(action.version_advance && conflict ? {
        version_advance: { column: conflict, strategy: action.version_advance },
      } : {}),
      ...(action.operation === "insert" && action.dedup_proposal_column
        ? { dedup_columns: [tenantKey, action.dedup_proposal_column] }
        : {}),
    });
    const failures = prerequisites.filter((check) => check.level === "fail");
    if (failures.length) {
      throw new Error(`GUIDED_ACTION_SOURCE_PREREQUISITE_FAILED: ${failures.map((failure) => failure.message).join(" ")}`);
    }
  }
}

function assertGuidedActionScopeAuthority(
  action: ReturnType<typeof normalizeAction>,
  boundary: ActivatedExplorationBoundary,
  resource: ActivatedExplorationBoundary["pack"]["resources"][number],
): void {
  if (!boundary.organization_scope) {
    requireDirectWriteTenantKey(resource);
    return;
  }
  if (resource.tenant_key) {
    throw new Error("GUIDED_ACTION_SCOPE_MODES_CONFLICT: a whole-organization boundary cannot also grant a direct tenant-column action scope.");
  }
  if (action.operation === "insert") {
    throw new Error("GUIDED_ACTION_ORGANIZATION_INSERT_UNSUPPORTED: single-organization INSERT proposals still require source-enforced organization-safe deduplication.");
  }
  if (action.authority.posture !== "proposal_only"
    || action.authority.writeback.mode !== "none"
    || action.authority.supervised_worker_execution) {
    throw new Error(
      "GUIDED_ACTION_ORGANIZATION_PROPOSAL_ONLY: a reviewed whole-organization action can create proposals in this release, but executable writeback still requires a direct reviewed tenant column.",
    );
  }
}

function validateGuidedAutoApprovalAgainstSource(
  policy: NormalizedGuidedAutoApproval,
  patches: Array<ReturnType<typeof normalizePatch>>,
  resource: ActivatedExplorationBoundary["pack"]["resources"][number],
  table: TableInfo,
): void {
  for (const condition of policy.conditions) {
    const column = requireColumn(table, condition.field);
    if (condition.source === "patch" && !patches.some((patch) => patch.column === condition.field)) {
      throw new Error(`GUIDED_ACTION_AUTO_APPROVAL_FIELD_NOT_PATCHED: ${condition.field}.`);
    }
    if (condition.source === "before" && resource.kept_out_fields.includes(condition.field)) {
      throw new Error(`GUIDED_ACTION_AUTO_APPROVAL_BEFORE_FIELD_NOT_REVIEWED: ${condition.field} is kept out of the reviewed pre-change snapshot.`);
    }
    const values = condition.operator === "in" ? condition.values! : [condition.value];
    if (condition.operator === "max_length") {
      if (condition.source !== "patch" || isNumericType(column.data_type) || isBooleanType(column.data_type)
        || !Number.isSafeInteger(condition.value) || Number(condition.value) < 1) {
        throw new Error(`GUIDED_ACTION_AUTO_APPROVAL_LENGTH_INVALID: ${condition.field} requires a positive reviewed string length.`);
      }
      const patch = patches.find((candidate) => candidate.column === condition.field);
      if (!patch || patch.value_source !== "argument" || !patch.max_length || Number(condition.value) > patch.max_length) {
        throw new Error(`GUIDED_ACTION_AUTO_APPROVAL_LENGTH_EXCEEDS_BOUND: ${condition.field}.`);
      }
      continue;
    }
    if (condition.operator === "lte" || condition.operator === "gte") {
      if (!isNumericType(column.data_type)) {
        throw new Error(`GUIDED_ACTION_AUTO_APPROVAL_FIELD_NOT_NUMERIC: ${condition.field}.`);
      }
      if (condition.source === "patch") {
        const patch = patches.find((candidate) => candidate.column === condition.field)!;
        const value = condition.value as number;
        if (patch.value_source !== "argument" || !Number.isFinite(patch.minimum) || !Number.isFinite(patch.maximum)
          || value < patch.minimum! || value > patch.maximum!) {
          throw new Error(`GUIDED_ACTION_AUTO_APPROVAL_BOUND_INVALID: ${condition.field} ${condition.operator} must stay within its reviewed numeric patch range.`);
        }
      }
    }
    for (const value of values) validateAutoApprovalLiteralForColumn(condition.field, value, column);
  }
  if (policy.total_field) {
    const patch = patches.find((candidate) => candidate.column === policy.total_field);
    const column = requireColumn(table, policy.total_field);
    if (!patch || patch.value_source !== "argument" || !isNumericType(column.data_type)) {
      throw new Error("GUIDED_ACTION_AUTO_APPROVAL_TOTAL_FIELD_INVALID: aggregate limits require one model-supplied numeric patch field.");
    }
  }
}

function validateAutoApprovalLiteralForColumn(field: string, value: JsonScalar | undefined, column: ColumnInfo): void {
  if (value === null) return;
  if (isNumericType(column.data_type) && typeof value !== "number") {
    throw new Error(`GUIDED_ACTION_AUTO_APPROVAL_TYPE_MISMATCH: ${field} requires numeric policy values.`);
  }
  if (isIntegerType(column.data_type) && typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error(`GUIDED_ACTION_AUTO_APPROVAL_INTEGER_REQUIRED: ${field} requires whole-number policy values.`);
  }
  if (isBooleanType(column.data_type) && typeof value !== "boolean") {
    throw new Error(`GUIDED_ACTION_AUTO_APPROVAL_TYPE_MISMATCH: ${field} requires boolean policy values.`);
  }
  if (!isNumericType(column.data_type) && !isBooleanType(column.data_type) && typeof value !== "string") {
    throw new Error(`GUIDED_ACTION_AUTO_APPROVAL_TYPE_MISMATCH: ${field} requires string policy values.`);
  }
  if (column.enum_values?.length && !column.enum_values.includes(String(value))) {
    throw new Error(`GUIDED_ACTION_AUTO_APPROVAL_ENUM_INVALID: ${field} must use ${column.enum_values.join(", ")}.`);
  }
}

function requireDirectWriteTenantKey(
  resource: ActivatedExplorationBoundary["pack"]["resources"][number],
): string {
  if (!resource.tenant_key) {
    throw new Error(
      `GUIDED_ACTION_DIRECT_TENANT_REQUIRED: ${resource.id} uses relationship-carried read scope; guarded writes still require a direct tenant column.`,
    );
  }
  if (resource.principal_scope) {
    throw new Error(
      `GUIDED_ACTION_DIRECT_PRINCIPAL_REQUIRED: ${resource.id} uses relationship-carried principal read scope; guarded writes require a direct principal column when principal scope applies.`,
    );
  }
  return resource.tenant_key;
}

function validatePatchType(
  patch: ReturnType<typeof normalizePatch>,
  column: ColumnInfo,
  operation: GuidedActionOperation,
): void {
  const numeric = isNumericType(column.data_type);
  if (patch.value_source === "argument") {
    if (numeric && (!Number.isFinite(patch.minimum) || !Number.isFinite(patch.maximum))) {
      throw new Error(`GUIDED_ACTION_NUMERIC_BOUNDS_REQUIRED: ${patch.column} needs a reviewed minimum and maximum.`);
    }
    if (isIntegerType(column.data_type)
      && (!Number.isSafeInteger(patch.minimum) || !Number.isSafeInteger(patch.maximum))) {
      throw new Error(`GUIDED_ACTION_INTEGER_BOUNDS_REQUIRED: ${patch.column} uses an integer source column and needs whole-number bounds.`);
    }
    if (!numeric && !isBooleanType(column.data_type) && !(column.enum_values?.length) && !positiveInteger(patch.max_length)) {
      throw new Error(`GUIDED_ACTION_TEXT_BOUND_REQUIRED: ${patch.column} needs a max length or inspected enum.`);
    }
  }
  if (patch.value_source === "fixed") {
    const value = patch.fixed_value;
    if (numeric && typeof value !== "number") throw new Error(`GUIDED_ACTION_FIXED_TYPE_MISMATCH: ${patch.column} requires a numeric fixed value.`);
    if (isIntegerType(column.data_type) && typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new Error(`GUIDED_ACTION_FIXED_INTEGER_REQUIRED: ${patch.column} uses an integer source column and requires a whole-number fixed value.`);
    }
    if (isBooleanType(column.data_type) && typeof value !== "boolean") throw new Error(`GUIDED_ACTION_FIXED_TYPE_MISMATCH: ${patch.column} requires true or false.`);
    if (!numeric && !isBooleanType(column.data_type) && value !== null && typeof value !== "string") {
      throw new Error(`GUIDED_ACTION_FIXED_TYPE_MISMATCH: ${patch.column} requires a string or null fixed value.`);
    }
    if (column.enum_values?.length && value !== null && !column.enum_values.includes(String(value))) {
      throw new Error(`GUIDED_ACTION_ENUM_VALUE_INVALID: ${patch.column} must be one of ${column.enum_values.join(", ")}.`);
    }
  }
  if (operation === "update"
    && /(?:^|_)(?:status|state)$/i.test(patch.column)
    && patch.value_source === "fixed"
    && patch.allowed_from.length === 0) {
    throw new Error(`GUIDED_ACTION_TRANSITION_REQUIRED: ${patch.column} needs at least one reviewed source state.`);
  }
}

function configWithGuidedAction(input: {
  projectRoot: string;
  sourceConfigPath: string;
  outputConfigPath: string;
  config: Record<string, unknown>;
  contractPath: string;
  replaceContractPath?: string;
  retainDirectSqlSource: boolean;
  isolatedPreview?: boolean;
  draft: GuidedActionDraft;
  boundary: ActivatedExplorationBoundary;
  actionBoundary: ActionBoundaryDraft;
}): Record<string, unknown> {
  const config = structuredClone(input.config);
  config.mode = "review";
  // Production Explore remains a separate, locked read-only endpoint. Action
  // runtimes reuse its verified HTTP identity settings but never widen that
  // two-tool surface in place.
  delete config.production_explore;
  const sourceConfigDirectory = path.dirname(input.sourceConfigPath);
  const outputConfigDirectory = path.dirname(input.outputConfigPath);
  const existingContracts = Array.isArray(config.contracts)
    ? config.contracts.filter((item): item is string => typeof item === "string")
    : [];
  const replaceTarget = input.replaceContractPath ? path.resolve(input.replaceContractPath) : undefined;
  const contracts = existingContracts.flatMap((contractPath) => {
    const target = path.isAbsolute(contractPath)
      ? contractPath
      : path.resolve(sourceConfigDirectory, contractPath);
    return replaceTarget && path.resolve(target) === replaceTarget
      ? []
      : [relativeConfigPath(outputConfigDirectory, target)];
  });
  const relativeContract = relativeConfigPath(outputConfigDirectory, input.contractPath);
  if (!contracts.includes(relativeContract)) contracts.push(relativeContract);
  config.contracts = contracts;
  config.action_boundary = {
    schema_version: input.actionBoundary.schema_version,
    name: input.actionBoundary.name,
    digest: input.actionBoundary.digest,
    authority: input.actionBoundary.authority,
  };
  const sources = isRecord(config.sources) ? config.sources : {};
  const sourceName = input.draft.source;
  const source = isRecord(sources[sourceName]) ? structuredClone(sources[sourceName] as Record<string, unknown>) : undefined;
  if (!source) throw new Error(`GUIDED_ACTION_SOURCE_CONFIG_MISSING: source ${sourceName} is not configured.`);
  const databaseScope = guidedActionDatabaseScope(input.boundary, input.draft);
  if (databaseScope
    && source.database_scope !== undefined
    && JSON.stringify(source.database_scope) !== JSON.stringify(databaseScope)) {
    throw new Error("GUIDED_ACTION_DATABASE_SCOPE_MISMATCH: the source no longer matches the reviewed RLS session boundary.");
  }
  // Proposal-only UPDATE and DELETE drafts still read one reviewed source row
  // to freeze a conflict snapshot. Apply the reviewed RLS session settings to
  // that read even though no writeback authority exists yet.
  if (databaseScope) source.database_scope = databaseScope;
  if (input.draft.writeback_mode === "direct_sql") {
    source.read_only = false;
    source.write_url_env = input.draft.write_url_env;
    source.receipts = input.draft.receipt_mode === "runner_ledger"
      ? { authority: "runner_ledger" }
      : {
        authority: "source_db",
        provisioning: input.draft.receipt_mode === "source_auto_migrate" ? "auto_migrate" : "precreated",
      };
  } else if (!input.retainDirectSqlSource) {
    source.read_only = true;
    delete source.write_url_env;
    delete source.receipts;
  }
  sources[sourceName] = source;
  config.sources = sources;
  if (input.isolatedPreview) {
    const storage = isRecord(config.storage) ? structuredClone(config.storage) : {};
    delete storage.shared_postgres;
    storage.sqlite_path = "./preview-proposals.db";
    config.storage = storage;
  }
  if (input.draft.operation !== "insert" && input.draft.writeback_mode === "direct_sql") {
    const proposalFreshness = isRecord(config.proposal_freshness)
      ? structuredClone(config.proposal_freshness)
      : {};
    if (!isRecord(proposalFreshness[input.draft.capability])) {
      proposalFreshness[input.draft.capability] = {
        approval: "required",
        dependencies: [],
      };
    }
    config.proposal_freshness = proposalFreshness;
  } else if (isRecord(config.proposal_freshness)) {
    const proposalFreshness = structuredClone(config.proposal_freshness);
    delete proposalFreshness[input.draft.capability];
    if (Object.keys(proposalFreshness).length > 0) config.proposal_freshness = proposalFreshness;
    else delete config.proposal_freshness;
  }
  const existingWorker = isRecord(config.supervised_worker)
    ? structuredClone(config.supervised_worker)
    : undefined;
  const otherWorkerCapabilities = existingWorker
    && Array.isArray(existingWorker.capabilities)
    ? existingWorker.capabilities.filter((entry) =>
      isRecord(entry) && entry.capability !== input.draft.capability)
    : [];
  if (input.draft.supervised_worker_execution && input.draft.worker_policy) {
    const policy = input.draft.worker_policy;
    config.supervised_worker = {
      ...(existingWorker ?? {}),
      enabled: true,
      profile: policy.profile,
      capabilities: [
        ...otherWorkerCapabilities,
        {
          capability: input.draft.capability,
          contract_digest: input.draft.contract_digest,
          mode: "supervised_worker",
          concurrency: policy.concurrency,
          queue_limit: policy.queue_limit,
          lease_seconds: policy.lease_seconds,
          max_attempts: policy.max_attempts,
          proposal_ttl_seconds: policy.proposal_ttl_seconds,
          rate_limit: policy.rate_limit,
          write_url_env: input.draft.write_url_env,
          require_least_privilege_writer: policy.require_least_privilege_writer,
          ...(policy.writer_posture_fingerprint
            ? { writer_posture_fingerprint: policy.writer_posture_fingerprint }
            : {}),
          ...(policy.worker_identity ? { worker_identity: policy.worker_identity } : {}),
          ...(policy.control_role ? { control_role: policy.control_role } : {}),
        },
      ],
    };
  } else if (existingWorker && otherWorkerCapabilities.length > 0) {
    config.supervised_worker = {
      ...existingWorker,
      capabilities: otherWorkerCapabilities,
    };
  } else {
    delete config.supervised_worker;
  }
  return config;
}

async function validateExpandedGuidedConfig(
  config: Record<string, unknown>,
  outputConfigPath: string,
  errorCode: string,
  stagedArtifact?: { path: string; contents: string },
): Promise<void> {
  const directory = path.dirname(outputConfigPath);
  const temporaryPath = path.join(
    directory,
    `.synapsor-guided-config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  const previousArtifact = stagedArtifact
    ? await fs.readFile(stagedArtifact.path, "utf8").then(
      (contents) => ({ existed: true, contents }),
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return { existed: false, contents: undefined };
        throw error;
      },
    )
    : undefined;
  if (stagedArtifact) {
    await fs.mkdir(path.dirname(stagedArtifact.path), { recursive: true, mode: 0o700 });
    await writeAtomic(stagedArtifact.path, stagedArtifact.contents);
  }
  await writeAtomic(temporaryPath, json(config));
  try {
    loadRuntimeConfigFromFile(temporaryPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${errorCode}: ${message}`);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    if (stagedArtifact && previousArtifact) {
      if (previousArtifact.existed) {
        await writeAtomic(stagedArtifact.path, previousArtifact.contents!);
      } else {
        await fs.rm(stagedArtifact.path, { force: true }).catch(() => undefined);
      }
    }
  }
}

function guidedActionDatabaseScope(
  boundary: ActivatedExplorationBoundary,
  draft: GuidedActionDraft,
): {
  mode: "postgres_rls";
  tenant_setting: string;
  principal_setting?: string;
} | undefined {
  const resource = boundary.pack.resources.find((candidate) => candidate.id === draft.resource);
  if (!resource) throw new Error(`GUIDED_ACTION_RESOURCE_UNKNOWN: ${draft.resource} is no longer in the active reviewed boundary.`);
  const tenantSetting = resource.rls_session?.tenant_setting;
  if (!tenantSetting) return undefined;
  return {
    mode: "postgres_rls",
    tenant_setting: tenantSetting,
    ...(resource.rls_session?.principal_setting
      ? { principal_setting: resource.rls_session.principal_setting }
      : {}),
  };
}

type GuidedActionBoundaryResolution = {
  boundary: ActivatedExplorationBoundary;
  state: "active" | "reviewed_pending";
};

type GuidedActionBoundarySelector = {
  boundaryName?: string;
  expectedDigest?: string;
  allowReviewedPending?: boolean;
};

async function loadCurrentBoundary(
  projectRoot: string,
  inspection: SchemaInspection,
  selector: Omit<GuidedActionBoundarySelector, "allowReviewedPending"> = {},
): Promise<ActivatedExplorationBoundary> {
  return (await loadGuidedActionBoundary(projectRoot, inspection, selector)).boundary;
}

async function loadGuidedActionBoundary(
  projectRoot: string,
  inspection: SchemaInspection | undefined,
  selector: GuidedActionBoundarySelector = {},
): Promise<GuidedActionBoundaryResolution> {
  const active = await readOptionalGuidedActionActiveBoundary(projectRoot, selector);
  const pending = await readReviewedPendingActionBoundary(projectRoot, selector);
  if (selector.allowReviewedPending && pending
    && (!active || active.activation.digest !== pending.activation.digest)) {
    await assertGuidedActionBoundaryCurrent(projectRoot, pending, inspection);
    return { boundary: pending, state: "reviewed_pending" };
  }
  if (active) {
    await assertGuidedActionBoundaryCurrent(projectRoot, active, inspection);
    return { boundary: active, state: "active" };
  }
  if (pending) {
    throw new Error(
      `GUIDED_ACTION_READ_DEPENDENCY_INACTIVE: reviewed read boundary ${pending.pack.name} `
      + `at ${pending.activation.digest} must be activated before this proposal action can be activated.`,
    );
  }
  throw new Error(
    selector.boundaryName
      ? `GUIDED_ACTION_READ_BOUNDARY_REQUIRED: ${selector.boundaryName} is not a fully reviewed pending or active read boundary.`
      : "GUIDED_ACTION_READ_BOUNDARY_REQUIRED: finish reviewing one read boundary before drafting a proposal action.",
  );
}

async function readOptionalGuidedActionActiveBoundary(
  projectRoot: string,
  selector: GuidedActionBoundarySelector,
): Promise<ActivatedExplorationBoundary | undefined> {
  try {
    return await loadActivatedExplorationBoundary(projectRoot, {
      ...(selector.boundaryName ? { name: selector.boundaryName } : {}),
      ...(selector.expectedDigest && /^sha256:[a-f0-9]{64}$/.test(selector.expectedDigest)
        ? { digest: selector.expectedDigest as `sha256:${string}` }
        : {}),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readReviewedPendingActionBoundary(
  projectRoot: string,
  selector: GuidedActionBoundarySelector,
): Promise<ActivatedExplorationBoundary | undefined> {
  const journey = await readGuidedOnboardingState(projectRoot);
  const boundaryRoot = path.resolve(
    projectRoot,
    journey?.artifacts.boundary_root ?? "synapsor/generated",
  );
  const relativeRoot = path.relative(projectRoot, boundaryRoot);
  if (relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot)) {
    throw new Error("GUIDED_ACTION_BOUNDARY_ROOT_INVALID: managed boundary root escapes the project.");
  }
  const draft = await fs.readFile(
    path.join(boundaryRoot, "exploration-boundary.draft.json"),
    "utf8",
  ).then(
    (value) => JSON.parse(value) as ExplorationBoundaryDraft,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (!draft) return undefined;
  const progress = await readBoundaryReviewProgress(projectRoot, draft);
  const candidate = progress?.candidate ?? recommendedBoundaryReviewCandidate(draft);
  if (selector.boundaryName && candidate.pack.name !== selector.boundaryName) return undefined;
  const digest = explorationBoundaryCandidateDigest(candidate);
  if (selector.expectedDigest && selector.expectedDigest !== digest) return undefined;
  if (!progress || progress.policy_migration.status === "review_required") return undefined;
  const confirmed = new Set(progress.confirmed_decisions);
  const decisions = boundaryReviewDecisions(candidate);
  if (decisions.some((decision) => !confirmed.has(decision.decision))) return undefined;
  const {
    activation: _disabledActivation,
    unresolved_decisions: _unresolvedDecisions,
    ...authority
  } = candidate;
  return {
    ...authority,
    activation: {
      state: "active",
      digest,
      actor: progress.confirmations.at(-1)?.actor ?? "reviewed-pending-boundary",
      activated_at: progress.updated_at,
      generation_lock_fingerprint: candidate.generation_lock_fingerprint,
      reviewed_decisions: decisions.map((decision) => ({
        decision: decision.decision,
        confirmed: true as const,
      })),
    },
  };
}

async function assertGuidedActionBoundaryCurrent(
  projectRoot: string,
  boundary: ActivatedExplorationBoundary,
  inspection: SchemaInspection | undefined,
): Promise<void> {
  const lock = JSON.parse(await fs.readFile(path.join(projectRoot, ".synapsor/generation-lock.json"), "utf8")) as GenerationLock;
  if (inspection) {
    const comparison = compareGenerationLock(lock, inspection);
    if (!comparison.current) throw new Error(`GUIDED_ACTION_SCHEMA_STALE: ${comparison.changes.join("; ")}.`);
  }
  if (canonicalJsonDigest(lock) !== boundary.generation_lock_fingerprint) {
    throw new Error("GUIDED_ACTION_LOCK_MISMATCH: reviewed boundary does not match the current generation lock.");
  }
}

function guidedActionTests(
  action: ReturnType<typeof normalizeAction>,
  resource: ActivatedExplorationBoundary["pack"]["resources"][number],
  organizationScope?: ActivatedExplorationBoundary["organization_scope"],
): Record<string, unknown> {
  return {
    schema_version: "synapsor.contract-tests.v1",
    capability: action.capability_name,
    tests: [
      { name: "tool creates proposal only", kind: "source_unchanged_before_approval", expected: "source_database_changed_false" },
      organizationScope
        ? { name: "reviewed organization fixed", kind: "scope", expected: organizationScope.organization_id }
        : { name: "trusted tenant required", kind: "scope", expected: resource.tenant_key },
      ...(resource.principal_key ? [{ name: "cross-principal denied", kind: "cross_principal_deny", expected: "generic_miss" }] : []),
      { name: "kept-out fields absent", kind: "redaction", expected: resource.kept_out_fields },
      { name: "allowed columns exact", kind: "write_boundary", expected: action.patches.map((patch) => patch.column) },
      { name: "conflict fails closed", kind: "conflict", expected: action.conflict_column ?? "not_applicable" },
      { name: "retry idempotent", kind: "idempotency", expected: "no_duplicate_mutation" },
      { name: "activation outside model", kind: "deny", expected: "no_model_activation_approval_or_apply" },
      ...(action.auto_approval ? [
        { name: "policy conditions bounded", kind: "policy", expected: action.auto_approval.conditions },
        { name: "daily policy circuits", kind: "policy_budget", expected: {
          count: action.auto_approval.max_per_day,
          ...(action.auto_approval.max_total_per_day !== undefined
            ? { total: action.auto_approval.max_total_per_day, field: action.auto_approval.total_field }
            : {}),
        } },
      ] : []),
      ...(action.supervised_worker_execution ? [{
        name: "supervised execution remains dual opt-in",
        kind: "execution_boundary",
        expected: "exact_digest_contract_and_deployment_permission",
      }] : []),
      ...(action.reversible ? [{ name: "revert remains reviewed", kind: "reversibility", expected: "new_independently_approved_proposal" }] : []),
    ],
  };
}

function guidedActionReview(
  draft: GuidedActionDraft,
  action: ReturnType<typeof normalizeAction>,
  resource: ActivatedExplorationBoundary["pack"]["resources"][number],
  organizationScope?: ActivatedExplorationBoundary["organization_scope"],
): string {
  return [
    `# Review ${draft.capability}`,
    "",
    "State: disabled",
    "",
    `Operation: ${action.operation.toUpperCase()} one ${resource.id}`,
    ...(resource.tenant_key
      ? [`Trusted tenant column: ${resource.tenant_key}`]
      : [`Reviewed whole organization: ${organizationScope?.organization_id ?? "not configured"}; no tenant predicate is applied.`]),
    `Trusted principal column: ${resource.principal_key ?? "not configured"}`,
    `Allowed write fields: ${action.patches.map((patch) => patch.column).join(", ") || "none"}`,
    `Conflict guard: ${action.conflict_column ?? "not applicable"}`,
    `Approval role: ${action.approval_role}`,
    `Approval quorum: ${action.required_approvals}`,
    `Automatic approval: ${action.auto_approval ? "reviewed bounded policy" : "off"}`,
    `Supervised worker execution: ${action.supervised_worker_execution ? "contract permission enabled; exact deployment opt-in still required" : "off"}`,
    `Reviewed compensation: ${action.reversible ? "enabled; revert creates another proposal" : "off"}`,
    `Receipt mode: ${action.receipt_mode}`,
    "",
    "The model can call this capability only after exact-digest activation.",
    "The call creates a proposal and cannot approve or apply it.",
    "Activation requires a real staging proposal preview with the source unchanged.",
    "",
    `Contract digest: ${draft.contract_digest}`,
    "",
  ].join("\n");
}

async function writeGuidedActionArtifacts(input: {
  projectRoot: string;
  outputRoot: string;
  draft: GuidedActionDraft;
  dsl: string;
  contract: SynapsorContract;
  tests: Record<string, unknown>;
  design: ReturnType<typeof normalizeAction>;
  review: string;
}): Promise<void> {
  const markerPath = path.join(input.outputRoot, ".synapsor-guided-action.json");
  const existing = await readOptionalJson(markerPath);
  if (existing && (existing.schema_version !== GUIDED_ACTION_VERSION || existing.capability !== input.draft.capability)) {
    throw new Error(`GUIDED_ACTION_OUTPUT_UNMANAGED: refusing to overwrite ${input.outputRoot}.`);
  }
  await fs.mkdir(input.outputRoot, { recursive: true, mode: 0o700 });
  await writeAtomic(path.join(input.outputRoot, "capability.synapsor.sql"), input.dsl);
  await writeAtomic(path.join(input.outputRoot, "synapsor.contract.json"), json(input.contract));
  await writeAtomic(path.join(input.outputRoot, "contract-tests.json"), json(input.tests));
  await writeAtomic(path.join(input.outputRoot, "action-design.json"), json(input.design));
  await writeAtomic(path.join(input.outputRoot, "REVIEW.md"), input.review);
  await writeAtomic(path.join(input.outputRoot, "draft.json"), json(input.draft));
  await writeAtomic(markerPath, json({ schema_version: GUIDED_ACTION_VERSION, capability: input.draft.capability }));
  await updateActionIndex(input.projectRoot, input.draft);
}

async function updateActionIndex(projectRoot: string, draft: GuidedActionDraft): Promise<void> {
  const indexPath = path.join(projectRoot, ".synapsor/guided-action-drafts.json");
  const existing = await readOptionalJson(indexPath);
  if (existing && existing.schema_version !== "synapsor.guided-action-drafts.v1" && existing.schema_version !== GUIDED_ACTION_INDEX_VERSION) {
    throw new Error("GUIDED_ACTION_INDEX_UNMANAGED: refusing to replace an unknown action index.");
  }
  const drafts = Array.isArray(existing?.drafts)
    ? existing.drafts.filter((item): item is GuidedActionDraft => isRecord(item) && typeof item.capability === "string" && item.capability !== draft.capability)
    : [];
  drafts.push(draft);
  await writeActionIndex(projectRoot, drafts);
}

async function removeActionFromIndex(projectRoot: string, capability: string): Promise<void> {
  const indexPath = path.join(projectRoot, ".synapsor/guided-action-drafts.json");
  const existing = await readOptionalJson(indexPath);
  if (!existing
    || (existing.schema_version !== "synapsor.guided-action-drafts.v1"
      && existing.schema_version !== GUIDED_ACTION_INDEX_VERSION)) {
    throw new Error("GUIDED_ACTION_INDEX_UNMANAGED: refusing to replace an unknown action index.");
  }
  const drafts = Array.isArray(existing.drafts)
    ? existing.drafts.filter((item): item is GuidedActionDraft =>
        isRecord(item) && typeof item.capability === "string" && item.capability !== capability)
    : [];
  await writeActionIndex(projectRoot, drafts);
}

async function writeActionIndex(projectRoot: string, drafts: GuidedActionDraft[]): Promise<void> {
  const indexPath = path.join(projectRoot, ".synapsor/guided-action-drafts.json");
  await writeAtomic(indexPath, json({
    schema_version: GUIDED_ACTION_INDEX_VERSION,
    state: "disabled",
    inferred_write_authority: false,
    drafts: drafts.sort((left, right) => left.capability.localeCompare(right.capability)),
    next_action: drafts.length
      ? "Preview the exact proposal effect, then activate only the reviewed digest."
      : "Create a disabled reviewed Safe Action before activating any write proposal authority.",
  }));
}

function previewArgs(
  action: ReturnType<typeof normalizeAction>,
  table: TableInfo,
  primaryKey: string,
): Record<string, JsonScalar> {
  const args: Record<string, JsonScalar> = {};
  if (action.operation !== "insert") {
    const name = action.lookup_argument || `${singular(table.name)}_id`;
    const column = requireColumn(table, primaryKey);
    args[name] = isNumericType(column.data_type) ? 1 : `replace-with-${singular(table.name)}-id`;
  }
  for (const patch of action.patches) {
    if (patch.value_source !== "argument") continue;
    const column = requireColumn(table, patch.column);
    args[patch.argument_name!] = samplePatchValue(patch, column);
  }
  return args;
}

function samplePatchValue(patch: ReturnType<typeof normalizePatch>, column: ColumnInfo): JsonScalar {
  if (isNumericType(column.data_type)) return patch.minimum ?? 0;
  if (isBooleanType(column.data_type)) return true;
  if (column.enum_values?.length) return column.enum_values[0]!;
  return `replace-with-${patch.column.replace(/_/g, "-")}`;
}

function argumentDsl(
  name: string,
  column: ColumnInfo,
  input: Pick<GuidedActionPatchInput, "argument_description" | "minimum" | "maximum" | "max_length">,
): string {
  const description = escapeDslString(input.argument_description?.trim() || `Reviewed value for ${column.name}.`);
  if (isNumericType(column.data_type)) {
    return `  ARG ${safeIdentifier(name)} NUMBER REQUIRED${input.minimum === undefined ? "" : ` MIN ${input.minimum}`}${input.maximum === undefined ? "" : ` MAX ${input.maximum}`} DESCRIPTION '${description}'`;
  }
  if (isBooleanType(column.data_type)) {
    return `  ARG ${safeIdentifier(name)} BOOLEAN REQUIRED DESCRIPTION '${description}'`;
  }
  const enumClause = column.enum_values?.length ? ` ENUM(${column.enum_values.map(dslLiteral).join(", ")})` : "";
  const maxLength = input.max_length ?? (column.name === "id" || /_id$/i.test(column.name) ? 128 : undefined);
  if (!enumClause && !maxLength) throw new Error(`GUIDED_ACTION_TEXT_BOUND_REQUIRED: ${column.name} requires max_length.`);
  return `  ARG ${safeIdentifier(name)} STRING${enumClause} REQUIRED${maxLength ? ` MAX LENGTH ${maxLength}` : ""} DESCRIPTION '${description}'`;
}

function patchValueDsl(patch: ReturnType<typeof normalizePatch>): string {
  return patch.value_source === "argument"
    ? `ARG ${safeIdentifier(patch.argument_name!)}`
    : dslLiteral(patch.fixed_value);
}

function numericBoundDsl(patch: ReturnType<typeof normalizePatch>, column: ColumnInfo): string[] {
  if (!isNumericType(column.data_type)) return [];
  if (patch.value_source === "fixed" && typeof patch.fixed_value === "number") {
    return [`  BOUND ${safeIdentifier(patch.column)} ${patch.fixed_value}..${patch.fixed_value}`];
  }
  return [`  BOUND ${safeIdentifier(patch.column)} ${patch.minimum}..${patch.maximum}`];
}

function transitionDsl(
  patch: ReturnType<typeof normalizePatch>,
  operation: GuidedActionOperation,
): string[] {
  if (operation !== "update" || !/(?:^|_)(?:status|state)$/i.test(patch.column) || patch.value_source !== "fixed" || typeof patch.fixed_value !== "string") return [];
  return [`  TRANSITION ${safeIdentifier(patch.column)} ALLOW ${patch.allowed_from.map((value) => `${dslLiteral(value)} -> ${dslLiteral(patch.fixed_value)}`).join(", ")}`];
}

function insertIdentityCandidates(table: TableInfo, tenantKey: string): string[] {
  const uniqueSets = [
    ...(table.primary_key.length ? [table.primary_key] : []),
    ...table.unique_constraints.map((constraint) => constraint.columns),
  ];
  return table.columns
    .filter(proposalIdCompatibleColumn)
    .map((column) => column.name)
    .filter((column) => uniqueSets.some((set) =>
      (set.length === 1 && set[0] === column)
      || (set.length === 2 && set.includes(column) && set.includes(tenantKey))));
}

function proposalIdCompatibleColumn(column: ColumnInfo): boolean {
  if (column.generated || column.identity) return false;
  return /(?:^|\b)(?:text|varchar|character varying|char|character)(?:\b|\s*\()/i.test(column.data_type)
    && !/(?:^|\b)(?:enum|set)(?:\b|\s*\()/i.test(column.data_type);
}

function requireInspectedTable(inspection: SchemaInspection, schema: string, table: string): TableInfo {
  const found = inspection.tables.find((candidate) => candidate.schema === schema && candidate.name === table);
  if (!found) throw new Error(`GUIDED_ACTION_TABLE_MISSING: ${schema}.${table} is not in the current inspection.`);
  return found;
}

function requireColumn(table: TableInfo, name: string): ColumnInfo {
  const column = table.columns.find((candidate) => candidate.name === name);
  if (!column) throw new Error(`GUIDED_ACTION_COLUMN_MISSING: ${table.schema}.${table.name}.${name} is not in the current inspection.`);
  return column;
}

function qualifiedCapabilityName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) {
    throw new Error("GUIDED_ACTION_NAME_INVALID: use a qualified business name such as membership.set_loyalty_balance.");
  }
  return name;
}

function safeIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`GUIDED_ACTION_IDENTIFIER_INVALID: ${value}.`);
  return value;
}

function safeBindingKey(value: string): string {
  if (!/^[A-Za-z0-9_.:-]+$/.test(value)) throw new Error(`GUIDED_ACTION_BINDING_KEY_INVALID: ${value}.`);
  return value;
}

function safeEnvironmentName(value: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(value)) throw new Error(`GUIDED_ACTION_ENV_INVALID: ${value}.`);
  return value;
}

function safeCapabilityFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/\.+/g, "_");
}

function lastCapabilitySegment(value: string): string {
  return value.split(".").at(-1)!;
}

function singular(value: string): string {
  return value.endsWith("ies") ? `${value.slice(0, -3)}y` : value.endsWith("s") ? value.slice(0, -1) : value;
}

function isNumericType(value: string): boolean {
  return /(?:int|numeric|decimal|real|double|float|money|number)/i.test(value);
}

function isIntegerType(value: string): boolean {
  return /(?:^|\b)(?:tinyint|smallint|mediumint|integer|bigint|int|int2|int4|int8|smallserial|serial|bigserial)(?:\b|$)/i.test(value)
    && !/(?:^|\b)tinyint\s*\(\s*1\s*\)/i.test(value);
}

function isBooleanType(value: string): boolean {
  return /bool/i.test(value);
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function dslLiteral(value: JsonScalar | undefined): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("GUIDED_ACTION_LITERAL_INVALID: numeric values must be finite.");
    return String(value);
  }
  if (typeof value === "string") return `'${escapeDslString(value)}'`;
  throw new Error("GUIDED_ACTION_LITERAL_INVALID: fixed values must be strings, numbers, booleans, or null.");
}

function escapeDslString(value: string): string {
  return value.replace(/'/g, "''").replace(/\r?\n/g, " ");
}

function reviewedText(value: string, label: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maximum) throw new Error(`GUIDED_ACTION_TEXT_INVALID: ${label} must be 1 through ${maximum} characters.`);
  if (/(?:postgres|mysql):\/\/|BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key\s*[:=]|bearer\s+[A-Za-z0-9._-]+/i.test(normalized)) {
    throw new Error(`GUIDED_ACTION_SECRET_BLOCKED: ${label} appears to contain secret material.`);
  }
  return normalized;
}

function actionDraftRoot(projectRoot: string, capability: string): string {
  return path.join(projectRoot, GUIDED_ACTION_ROOT, "drafts", safeCapabilityFileName(capability));
}

function guidedActionActivationPath(projectRoot: string, capability: string): string {
  return path.join(projectRoot, GUIDED_ACTION_ROOT, "active", `${safeCapabilityFileName(capability)}.active.json`);
}

function normalizeGuidedActionDraft(projectRoot: string, draft: GuidedActionDraft): GuidedActionDraft {
  const draftRoot = actionDraftRoot(projectRoot, draft.capability);
  return {
    ...draft,
    authority_posture: draft.authority_posture
      ?? (draft.supervised_worker_execution ? "supervised_execution" : "executable"),
    writeback_mode: draft.writeback_mode ?? "direct_sql",
    design_path: draft.design_path
      ?? relativeProjectPath(projectRoot, path.join(draftRoot, "action-design.json")),
    runtime_config_path: draft.runtime_config_path ?? "./synapsor.runner.json",
  };
}

function normalizeGuidedActionActivation(
  projectRoot: string,
  active: GuidedActionActivation,
): GuidedActionActivation {
  const legacyDraftRoot = actionDraftRoot(projectRoot, active.capability);
  return {
    ...active,
    authority_posture: active.authority_posture ?? "executable",
    writeback_mode: active.writeback_mode ?? "direct_sql",
    design_path: active.design_path
      ?? relativeProjectPath(projectRoot, path.join(legacyDraftRoot, "action-design.json")),
    dsl_path: active.dsl_path
      ?? relativeProjectPath(projectRoot, path.join(legacyDraftRoot, "capability.synapsor.sql")),
    tests_path: active.tests_path
      ?? relativeProjectPath(projectRoot, path.join(legacyDraftRoot, "contract-tests.json")),
    review_path: active.review_path
      ?? relativeProjectPath(projectRoot, path.join(legacyDraftRoot, "REVIEW.md")),
  };
}

async function copyGuidedArtifact(projectRoot: string, sourcePath: string, targetPath: string): Promise<void> {
  const source = containedProjectPath(projectRoot, sourcePath);
  await writeAtomic(targetPath, await fs.readFile(source, "utf8"));
}

async function existingFile(targetPath: string): Promise<string | undefined> {
  try {
    await fs.stat(targetPath);
    return targetPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function containedProjectPath(projectRoot: string, relativePath: string): string {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("GUIDED_ACTION_PATH_ESCAPE: managed path leaves the project.");
  return resolved;
}

function relativeProjectPath(projectRoot: string, target: string): string {
  const relative = path.relative(projectRoot, target).replace(/\\/g, "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("GUIDED_ACTION_PATH_ESCAPE: artifact leaves the project.");
  return relative.startsWith("./") ? relative : `./${relative}`;
}

function relativeConfigPath(configDirectory: string, target: string): string {
  const relative = path.relative(configDirectory, target).replace(/\\/g, "/");
  return relative === "." || relative.startsWith("./") || relative.startsWith("../")
    ? relative
    : `./${relative}`;
}

async function readOptionalJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error(`Expected a JSON object at ${filePath}.`);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
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
