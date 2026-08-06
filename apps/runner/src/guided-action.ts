import fs from "node:fs/promises";
import path from "node:path";
import { compileAgentDsl, formatAgentDsl } from "@synapsor/dsl";
import { loadRuntimeConfigFromFile } from "@synapsor-runner/mcp-server";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  assessDirectWritePrerequisites,
  type ColumnInfo,
  type SchemaInspection,
  type TableInfo,
} from "@synapsor-runner/schema-inspector";
import { assertValidContract, type JsonScalar, type SynapsorContract } from "@synapsor/spec";
import {
  compareGenerationLock,
  loadActivatedExplorationBoundary,
  type ActivatedExplorationBoundary,
  type GenerationLock,
} from "./auto-boundary.js";
import { extendEnvironmentExample } from "./guided-project.js";

const GUIDED_ACTION_VERSION = "synapsor.guided-action.v1" as const;
const GUIDED_ACTION_INDEX_VERSION = "synapsor.guided-action-index.v1" as const;
const GUIDED_ACTION_ROOT = "synapsor/actions";

export type GuidedActionOperation = "update" | "insert" | "delete";
export type GuidedReceiptMode = "runner_ledger" | "source_auto_migrate" | "source_precreated";

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
  auto_approval?: {
    field: string;
    maximum: number;
    max_per_day: number;
    max_total_per_day: number;
  };
  supervised_worker_execution?: boolean;
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
  boundary_digest: `sha256:${string}`;
  generation_lock_fingerprint: `sha256:${string}`;
  contract_digest: `sha256:${string}`;
  dsl_path: string;
  contract_path: string;
  tests_path: string;
  review_path: string;
  write_url_env: string;
  receipt_mode: GuidedReceiptMode;
  supervised_worker_execution: boolean;
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
  contract_digest: `sha256:${string}`;
  contract_path: string;
  config_path: string;
  actor: string;
  activated_at: string;
  source_database_changed: false;
};

export type GuidedActionStatus = {
  drafts: GuidedActionDraft[];
  activations: GuidedActionActivation[];
};

export type GuidedActionResourceOption = {
  id: string;
  schema: string;
  table: string;
  primary_key: string;
  tenant_key: string;
  principal_key?: string;
  writable_fields: Array<{
    name: string;
    data_type: string;
    enum_values: string[];
    nullable: boolean;
    suggested_numeric_minimum?: number;
    suggested_numeric_maximum?: number;
  }>;
  conflict_candidates: string[];
  insert_dedup_candidates: string[];
  kept_out_fields: string[];
  operation_availability: Record<GuidedActionOperation, { available: boolean; reason: string }>;
};

export async function guidedActionOptions(input: {
  projectRoot: string;
  inspection: SchemaInspection;
}): Promise<{
  boundary_digest: `sha256:${string}`;
  source: string;
  resources: GuidedActionResourceOption[];
  safe_defaults: Record<string, unknown>;
}> {
  const projectRoot = path.resolve(input.projectRoot);
  const boundary = await loadCurrentBoundary(projectRoot, input.inspection);
  return {
    boundary_digest: boundary.activation.digest,
    source: boundary.source,
    resources: boundary.pack.resources.map((resource) => {
      const table = requireInspectedTable(input.inspection, resource.schema, resource.table);
      const writableFields = table.columns
        .filter((column) =>
          !column.generated
          && !column.identity
          && column.name !== resource.primary_key
          && column.name !== resource.tenant_key
          && column.name !== resource.principal_key
          && !resource.kept_out_fields.includes(column.name)
          && resource.selectable_fields.includes(column.name))
        .map((column) => ({
          name: column.name,
          data_type: column.data_type,
          enum_values: column.enum_values ?? [],
          nullable: column.nullable,
        }));
      const insertDedupCandidates = insertIdentityCandidates(table, resource.tenant_key);
      const baseWrite = table.type === "table" && table.writable;
      const hardDeleteBlocked = (table.write_triggers?.length ?? 0) > 0
        || (table.referenced_by ?? []).some((foreignKey) => foreignKey.delete_rule === "CASCADE");
      return {
        id: resource.id,
        schema: resource.schema,
        table: resource.table,
        primary_key: resource.primary_key,
        tenant_key: resource.tenant_key,
        ...(resource.principal_key ? { principal_key: resource.principal_key } : {}),
        writable_fields: writableFields,
        conflict_candidates: table.suggestions.conflict_columns,
        insert_dedup_candidates: insertDedupCandidates,
        kept_out_fields: resource.kept_out_fields,
        operation_availability: {
          update: {
            available: baseWrite && table.suggestions.conflict_columns.length > 0 && writableFields.length > 0,
            reason: !baseWrite
              ? "Requires an inspected writable base table."
              : table.suggestions.conflict_columns.length === 0
                ? "No source-proven conflict/version field was found."
                : writableFields.length === 0
                  ? "No reviewed non-sensitive writable field is available."
                  : "Available with explicit bounds, conflict guard, approval, and receipt mode.",
          },
          insert: {
            available: baseWrite && insertDedupCandidates.length > 0 && writableFields.length > 0,
            reason: !baseWrite
              ? "Requires an inspected writable base table."
              : insertDedupCandidates.length === 0
                ? "No primary/unique proposal-identity column can prove retry deduplication."
                : "Available with an inspected dedup identity and explicit field bounds.",
          },
          delete: {
            available: baseWrite && table.suggestions.conflict_columns.length > 0 && !hardDeleteBlocked,
            reason: !baseWrite
              ? "Requires an inspected writable base table."
              : table.suggestions.conflict_columns.length === 0
                ? "No source-proven conflict/version field was found."
                : hardDeleteBlocked
                  ? "Hard delete is blocked because inspected triggers or cascading references may widen the effect."
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
      writeback: "direct_sql",
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
  now?: string;
}): Promise<{
  draft: GuidedActionDraft;
  dsl: string;
  contract: SynapsorContract;
  tests: Record<string, unknown>;
  preview_args: Record<string, JsonScalar>;
}> {
  const projectRoot = path.resolve(input.projectRoot);
  const boundary = await loadCurrentBoundary(projectRoot, input.inspection);
  const action = normalizeAction(input.action);
  const resource = boundary.pack.resources.find((candidate) => candidate.id === action.resource);
  if (!resource) throw new Error(`GUIDED_ACTION_RESOURCE_UNKNOWN: ${action.resource} is not in the active reviewed boundary.`);
  const table = requireInspectedTable(input.inspection, resource.schema, resource.table);
  const options = (await guidedActionOptions({ projectRoot, inspection: input.inspection })).resources
    .find((candidate) => candidate.id === resource.id)!;
  const availability = options.operation_availability[action.operation];
  if (!availability.available) throw new Error(`GUIDED_ACTION_OPERATION_UNAVAILABLE: ${availability.reason}`);
  if (!action.confirmed_trusted_scope) {
    throw new Error("GUIDED_ACTION_SCOPE_CONFIRMATION_REQUIRED: confirm the inherited reviewed tenant and principal scope.");
  }
  validateActionAgainstSource(action, resource, table);

  const dsl = emitGuidedActionDsl({ action, boundary, resource, table });
  const contract = compileAgentDsl(dsl);
  assertValidContract(contract);
  const capability = contract.capabilities.find((candidate) => candidate.name === action.capability_name);
  if (!capability?.proposal) throw new Error("GUIDED_ACTION_COMPILE_FAILED: generated DSL did not produce proposal authority.");
  const contractDigest = canonicalJsonDigest(contract);
  const tests = guidedActionTests(action, resource);
  const outputRoot = actionDraftRoot(projectRoot, action.capability_name);
  const dslPath = path.join(outputRoot, "capability.synapsor.sql");
  const contractPath = path.join(outputRoot, "synapsor.contract.json");
  const testsPath = path.join(outputRoot, "contract-tests.json");
  const reviewPath = path.join(outputRoot, "REVIEW.md");
  const draft: GuidedActionDraft = {
    schema_version: GUIDED_ACTION_VERSION,
    state: "disabled",
    capability: action.capability_name,
    source: boundary.source,
    resource: action.resource,
    operation: action.operation,
    boundary_digest: boundary.activation.digest,
    generation_lock_fingerprint: boundary.generation_lock_fingerprint,
    contract_digest: contractDigest,
    dsl_path: relativeProjectPath(projectRoot, dslPath),
    contract_path: relativeProjectPath(projectRoot, contractPath),
    tests_path: relativeProjectPath(projectRoot, testsPath),
    review_path: relativeProjectPath(projectRoot, reviewPath),
    write_url_env: action.write_url_env,
    receipt_mode: action.receipt_mode,
    supervised_worker_execution: action.supervised_worker_execution,
    created_at: input.now ?? new Date().toISOString(),
  };
  await writeGuidedActionArtifacts({
    projectRoot,
    outputRoot,
    draft,
    dsl,
    contract,
    tests,
    review: guidedActionReview(draft, action, resource),
  });
  return {
    draft,
    dsl,
    contract,
    tests,
    preview_args: previewArgs(action, table, resource.primary_key),
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
  const configPath = path.resolve(input.configPath ?? path.join(projectRoot, "synapsor.runner.json"));
  const rawConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  const boundary = await loadActivatedExplorationBoundary(projectRoot);
  const previewPath = path.join(actionDraftRoot(projectRoot, draft.capability), "preview.runner.json");
  const previewConfig = configWithGuidedAction({
    projectRoot,
    sourceConfigPath: configPath,
    outputConfigPath: previewPath,
    config: rawConfig,
    contractPath,
    draft,
    boundary,
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
  if (!input.proposalId.trim() || !input.proposalHash.trim()) throw new Error("GUIDED_ACTION_PREVIEW_IDENTITY_REQUIRED: immutable proposal identity is missing.");
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
  const boundary = await loadCurrentBoundary(projectRoot, input.inspection);
  const draft = await readGuidedActionDraft(projectRoot, input.capabilityName);
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

  const activeRoot = path.join(projectRoot, GUIDED_ACTION_ROOT, "active");
  const activeContractPath = path.join(activeRoot, `${safeCapabilityFileName(draft.capability)}.contract.json`);
  const configPath = path.resolve(input.configPath ?? path.join(projectRoot, "synapsor.runner.json"));
  const rawConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  const nextConfig = configWithGuidedAction({
    projectRoot,
    sourceConfigPath: configPath,
    outputConfigPath: configPath,
    config: rawConfig,
    contractPath: activeContractPath,
    draft,
    boundary,
  });
  await validateExpandedGuidedConfig(nextConfig, configPath, "GUIDED_ACTION_CONFIG_INVALID", {
    path: activeContractPath,
    contents: json(contract),
  });
  const previousConfig = await fs.readFile(configPath, "utf8");
  const environmentPath = path.join(projectRoot, ".env.example");
  let environmentRollback: { existed: boolean; contents?: string } | undefined;
  const activatedAt = input.now ?? new Date().toISOString();
  const active: GuidedActionActivation = {
    schema_version: GUIDED_ACTION_VERSION,
    state: "active",
    capability: draft.capability,
    contract_digest: digest,
    contract_path: relativeProjectPath(projectRoot, activeContractPath),
    config_path: relativeProjectPath(projectRoot, configPath),
    actor,
    activated_at: activatedAt,
    source_database_changed: false,
  };
  await fs.mkdir(activeRoot, { recursive: true, mode: 0o700 });
  await writeAtomic(activeContractPath, json(contract));
  try {
    await writeAtomic(configPath, json(nextConfig));
    environmentRollback = await extendEnvironmentExample(
      environmentPath,
      [
        "# Runner reads the writer credential only from the launching shell.",
        "# Keep it separate from the read-only onboarding credential.",
        `${draft.write_url_env}=`,
        "",
      ].join("\n"),
    );
    await writeAtomic(path.join(activeRoot, `${safeCapabilityFileName(draft.capability)}.active.json`), json(active));
  } catch (error) {
    await writeAtomic(configPath, previousConfig).catch(() => undefined);
    if (environmentRollback) {
      if (environmentRollback.existed) {
        await writeAtomic(environmentPath, environmentRollback.contents ?? "").catch(() => undefined);
      } else {
        await fs.rm(environmentPath, { force: true }).catch(() => undefined);
      }
    }
    await fs.rm(activeContractPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return active;
}

export async function readGuidedActionDraft(
  projectRootInput: string,
  capabilityName: string,
): Promise<GuidedActionDraft> {
  const projectRoot = path.resolve(projectRootInput);
  const draftPath = path.join(actionDraftRoot(projectRoot, capabilityName), "draft.json");
  const parsed = JSON.parse(await fs.readFile(draftPath, "utf8")) as GuidedActionDraft;
  if (parsed.schema_version !== GUIDED_ACTION_VERSION || parsed.state !== "disabled" || parsed.capability !== capabilityName) {
    throw new Error("GUIDED_ACTION_DRAFT_INVALID: managed draft metadata is invalid.");
  }
  return parsed;
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
        activations.push(parsed as GuidedActionActivation);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    drafts: drafts.sort((left, right) => left.capability.localeCompare(right.capability)),
    activations: activations.sort((left, right) => left.capability.localeCompare(right.capability)),
  };
}

function emitGuidedActionDsl(input: {
  action: ReturnType<typeof normalizeAction>;
  boundary: ActivatedExplorationBoundary;
  resource: ActivatedExplorationBoundary["pack"]["resources"][number];
  table: TableInfo;
}): string {
  const { action, boundary, resource, table } = input;
  if (boundary.trusted_context.provider !== "environment") {
    throw new Error("Guided write actions are local authoring artifacts and cannot be generated from a production Explore boundary.");
  }
  const contextName = safeIdentifier(`guided_${safeCapabilityFileName(action.capability_name)}`);
  const lookupArgument = action.lookup_argument || `${singular(resource.table)}_id`;
  const lines = [
    `CREATE AGENT CONTEXT ${contextName}`,
    `  BIND tenant_id FROM ENVIRONMENT ${safeIdentifier(boundary.trusted_context.tenant_env)} REQUIRED`,
    `  BIND principal FROM ENVIRONMENT ${safeIdentifier(boundary.trusted_context.principal_env)} REQUIRED`,
    "  TENANT BINDING tenant_id",
    "  PRINCIPAL BINDING principal",
    "END",
    "",
    `CREATE CAPABILITY ${action.capability_name}`,
    `  DESCRIPTION '${escapeDslString(action.description)}'`,
    `  RETURNS HINT '${escapeDslString(action.returns_hint)}'`,
    `  USING CONTEXT ${contextName}`,
    `  SOURCE ${safeIdentifier(boundary.source)}`,
    `  ON ${safeIdentifier(resource.schema)}.${safeIdentifier(resource.table)}`,
    `  PRIMARY KEY ${safeIdentifier(resource.primary_key)}`,
    `  TENANT KEY ${safeIdentifier(resource.tenant_key)}`,
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
    `  ALLOW READ ${resource.selectable_fields.map(safeIdentifier).join(", ")}`,
    ...(resource.kept_out_fields.length ? [`  KEEP OUT ${resource.kept_out_fields.map(safeIdentifier).join(", ")}`] : []),
    "  REQUIRE EVIDENCE",
    "  MAX ROWS 1",
    `  PROPOSE ACTION ${safeIdentifier(lastCapabilitySegment(action.capability_name))} ${action.operation.toUpperCase()}`,
    ...(action.operation === "insert" ? [
      `  DEDUP KEY ${safeIdentifier(resource.tenant_key)} = TRUSTED TENANT, ${safeIdentifier(action.dedup_proposal_column!)} = PROPOSAL ID`,
    ] : []),
    ...(action.operation === "delete" ? [] : [
      `  ALLOW WRITE ${action.patches.map((patch) => safeIdentifier(patch.column)).join(", ")}`,
      ...action.patches.map((patch) => `  PATCH ${safeIdentifier(patch.column)} = ${patchValueDsl(patch)}`),
      ...action.patches.flatMap((patch) => numericBoundDsl(patch, requireColumn(table, patch.column))),
      ...action.patches.flatMap((patch) => transitionDsl(patch)),
    ]),
    ...(action.version_advance ? [
      `  ADVANCE VERSION ${safeIdentifier(action.conflict_column!)} USING ${action.version_advance === "integer_increment" ? "INTEGER INCREMENT" : "DATABASE GENERATED"}`,
    ] : []),
    `  APPROVAL ROLE ${safeIdentifier(action.approval_role)}`,
    ...(action.required_approvals > 1 ? [`  REQUIRE ${action.required_approvals} APPROVALS`] : []),
    ...(action.auto_approval ? [
      `  AUTO APPROVE WHEN ${safeIdentifier(action.auto_approval.field)} <= ${action.auto_approval.maximum}`,
      `  LIMIT ${action.auto_approval.max_per_day} PER DAY`,
      `  LIMIT TOTAL ${action.auto_approval.max_total_per_day} PER DAY`,
    ] : []),
    ...(action.supervised_worker_execution ? ["  ALLOW SUPERVISED WORKER APPLY"] : []),
    "  WRITEBACK DIRECT SQL",
    ...(action.reversible ? ["  REVERSIBLE"] : []),
    "END",
  ];
  const dsl = `${lines.join("\n")}\n`;
  return `${formatAgentDsl(dsl)}\n`;
}

function normalizeAction(input: GuidedActionInput) {
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
  if (receiptMode === "runner_ledger" && operation === "update" && !input.version_advance) {
    throw new Error("GUIDED_ACTION_VERSION_ADVANCE_REQUIRED: runner_ledger UPDATE must advance its exact version field in the source transaction.");
  }
  if (input.reversible && operation !== "update") {
    throw new Error("GUIDED_ACTION_REVERSIBLE_OPERATION_UNSUPPORTED: the guided path supports reviewed compensation for UPDATE only; use advanced authoring for other reviewed shapes.");
  }
  if (input.reversible && input.version_advance !== "integer_increment") {
    throw new Error("GUIDED_ACTION_REVERSIBLE_VERSION_REQUIRED: reversible UPDATE requires exact integer version advancement.");
  }
  if (input.reversible && input.auto_approval) {
    throw new Error("GUIDED_ACTION_REVERSIBLE_AUTO_APPROVAL_FORBIDDEN: reviewed compensation requires independent human approval.");
  }
  if (input.supervised_worker_execution && input.reversible) {
    throw new Error("GUIDED_ACTION_REVERSIBLE_SUPERVISED_WORKER_FORBIDDEN: reviewed compensation remains outside supervised automatic execution.");
  }
  if (input.supervised_worker_execution && operation === "delete") {
    throw new Error("GUIDED_ACTION_DELETE_SUPERVISED_WORKER_FORBIDDEN: hard DELETE remains outside supervised automatic execution.");
  }
  if (input.auto_approval && operation === "delete") {
    throw new Error("GUIDED_ACTION_DELETE_AUTO_APPROVAL_FORBIDDEN: hard DELETE always requires human review.");
  }
  if (input.auto_approval && requiredApprovals > 1) {
    throw new Error("GUIDED_ACTION_QUORUM_AUTO_APPROVAL_FORBIDDEN: a multi-reviewer quorum cannot be presented as immediate policy completion.");
  }
  if (operation === "delete" && input.delete_confirmation !== `DELETE ${input.resource}`) {
    throw new Error(`GUIDED_ACTION_DELETE_CONFIRMATION_REQUIRED: enter DELETE ${input.resource}.`);
  }
  if (input.auto_approval) {
    const patch = patches.find((candidate) => candidate.column === input.auto_approval!.field);
    if (!patch || patch.value_source !== "argument" || !Number.isFinite(patch.minimum) || !Number.isFinite(patch.maximum)) {
      throw new Error("GUIDED_ACTION_AUTO_APPROVAL_FIELD_INVALID: auto-approval must use one bounded numeric argument patch.");
    }
    if (!Number.isFinite(input.auto_approval.maximum)
      || input.auto_approval.maximum < 0
      || input.auto_approval.maximum > patch.maximum!) {
      throw new Error("GUIDED_ACTION_AUTO_APPROVAL_BOUND_INVALID: policy maximum must be non-negative and within the reviewed patch maximum.");
    }
    if (!positiveInteger(input.auto_approval.max_per_day) || !positiveInteger(input.auto_approval.max_total_per_day)) {
      throw new Error("GUIDED_ACTION_AUTO_APPROVAL_LIMIT_REQUIRED: set positive per-day count and aggregate-value circuit breakers.");
    }
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
    auto_approval: input.auto_approval,
    supervised_worker_execution: input.supervised_worker_execution === true,
    reversible: input.reversible === true,
    receipt_mode: receiptMode,
    write_url_env: safeEnvironmentName(input.write_url_env ?? "SYNAPSOR_DATABASE_WRITE_URL"),
    confirmed_trusted_scope: input.confirmed_trusted_scope === true,
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
  resource: ActivatedExplorationBoundary["pack"]["resources"][number],
  table: TableInfo,
): void {
  if (table.type !== "table" || !table.writable) throw new Error("GUIDED_ACTION_TABLE_REQUIRED: direct writeback requires an inspected writable base table.");
  if (table.primary_key.length !== 1 || table.primary_key[0] !== resource.primary_key) {
    throw new Error("GUIDED_ACTION_PRIMARY_KEY_MISMATCH: direct writeback requires the source-proven single-column primary key.");
  }
  const conflict = action.conflict_column;
  if (conflict && !table.suggestions.conflict_columns.includes(conflict)) {
    throw new Error(`GUIDED_ACTION_CONFLICT_UNPROVEN: ${conflict} is not an inspected conflict/version candidate.`);
  }
  for (const patch of action.patches) {
    const column = requireColumn(table, patch.column);
    if (column.generated || column.identity) throw new Error(`GUIDED_ACTION_GENERATED_COLUMN_BLOCKED: ${patch.column} is database-generated.`);
    if (resource.kept_out_fields.includes(patch.column) || !resource.selectable_fields.includes(patch.column)) {
      throw new Error(`GUIDED_ACTION_FIELD_NOT_REVIEWED: ${patch.column} is not raw-visible in the active reviewed boundary.`);
    }
    validatePatchType(patch, column);
  }
  if (action.operation === "insert") {
    const dedup = action.dedup_proposal_column;
    if (!dedup || !insertIdentityCandidates(table, resource.tenant_key).includes(dedup)) {
      throw new Error("GUIDED_ACTION_INSERT_DEDUP_UNPROVEN: select a primary/unique proposal-identity column proven by inspected metadata.");
    }
  }
  const prerequisites = assessDirectWritePrerequisites(table, {
    operation: action.operation,
    primary_key: resource.primary_key,
    tenant_key: resource.tenant_key,
    allowed_columns: action.patches.map((patch) => patch.column),
    patch_columns: action.patches.map((patch) => patch.column),
    ...(conflict ? { conflict_column: conflict } : {}),
    ...(action.version_advance && conflict ? {
      version_advance: { column: conflict, strategy: action.version_advance },
    } : {}),
    ...(action.operation === "insert" && action.dedup_proposal_column
      ? { dedup_columns: [resource.tenant_key, action.dedup_proposal_column] }
      : {}),
  });
  const failures = prerequisites.filter((check) => check.level === "fail");
  if (failures.length) {
    throw new Error(`GUIDED_ACTION_SOURCE_PREREQUISITE_FAILED: ${failures.map((failure) => failure.message).join(" ")}`);
  }
}

function validatePatchType(patch: ReturnType<typeof normalizePatch>, column: ColumnInfo): void {
  const numeric = isNumericType(column.data_type);
  if (patch.value_source === "argument") {
    if (numeric && (!Number.isFinite(patch.minimum) || !Number.isFinite(patch.maximum))) {
      throw new Error(`GUIDED_ACTION_NUMERIC_BOUNDS_REQUIRED: ${patch.column} needs a reviewed minimum and maximum.`);
    }
    if (!numeric && !isBooleanType(column.data_type) && !(column.enum_values?.length) && !positiveInteger(patch.max_length)) {
      throw new Error(`GUIDED_ACTION_TEXT_BOUND_REQUIRED: ${patch.column} needs a max length or inspected enum.`);
    }
  }
  if (patch.value_source === "fixed") {
    const value = patch.fixed_value;
    if (numeric && typeof value !== "number") throw new Error(`GUIDED_ACTION_FIXED_TYPE_MISMATCH: ${patch.column} requires a numeric fixed value.`);
    if (isBooleanType(column.data_type) && typeof value !== "boolean") throw new Error(`GUIDED_ACTION_FIXED_TYPE_MISMATCH: ${patch.column} requires true or false.`);
    if (!numeric && !isBooleanType(column.data_type) && value !== null && typeof value !== "string") {
      throw new Error(`GUIDED_ACTION_FIXED_TYPE_MISMATCH: ${patch.column} requires a string or null fixed value.`);
    }
    if (column.enum_values?.length && value !== null && !column.enum_values.includes(String(value))) {
      throw new Error(`GUIDED_ACTION_ENUM_VALUE_INVALID: ${patch.column} must be one of ${column.enum_values.join(", ")}.`);
    }
  }
  if (/(?:^|_)(?:status|state)$/i.test(patch.column) && patch.value_source === "fixed" && patch.allowed_from.length === 0) {
    throw new Error(`GUIDED_ACTION_TRANSITION_REQUIRED: ${patch.column} needs at least one reviewed source state.`);
  }
}

function configWithGuidedAction(input: {
  projectRoot: string;
  sourceConfigPath: string;
  outputConfigPath: string;
  config: Record<string, unknown>;
  contractPath: string;
  draft: GuidedActionDraft;
  boundary: ActivatedExplorationBoundary;
}): Record<string, unknown> {
  const config = structuredClone(input.config);
  config.mode = "review";
  const sourceConfigDirectory = path.dirname(input.sourceConfigPath);
  const outputConfigDirectory = path.dirname(input.outputConfigPath);
  const existingContracts = Array.isArray(config.contracts)
    ? config.contracts.filter((item): item is string => typeof item === "string")
    : [];
  const contracts = existingContracts.map((contractPath) => {
    const target = path.isAbsolute(contractPath)
      ? contractPath
      : path.resolve(sourceConfigDirectory, contractPath);
    return relativeConfigPath(outputConfigDirectory, target);
  });
  const relativeContract = relativeConfigPath(outputConfigDirectory, input.contractPath);
  if (!contracts.includes(relativeContract)) contracts.push(relativeContract);
  config.contracts = contracts;
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
  source.read_only = false;
  source.write_url_env = input.draft.write_url_env;
  if (databaseScope) source.database_scope = databaseScope;
  source.receipts = input.draft.receipt_mode === "runner_ledger"
    ? { authority: "runner_ledger" }
    : {
      authority: "source_db",
      provisioning: input.draft.receipt_mode === "source_auto_migrate" ? "auto_migrate" : "precreated",
    };
  sources[sourceName] = source;
  config.sources = sources;
  if (input.draft.operation !== "insert") {
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

async function loadCurrentBoundary(
  projectRoot: string,
  inspection: SchemaInspection,
): Promise<ActivatedExplorationBoundary> {
  const boundary = await loadActivatedExplorationBoundary(projectRoot);
  const lock = JSON.parse(await fs.readFile(path.join(projectRoot, ".synapsor/generation-lock.json"), "utf8")) as GenerationLock;
  const comparison = compareGenerationLock(lock, inspection);
  if (!comparison.current) throw new Error(`GUIDED_ACTION_SCHEMA_STALE: ${comparison.changes.join("; ")}.`);
  if (canonicalJsonDigest(lock) !== boundary.generation_lock_fingerprint) {
    throw new Error("GUIDED_ACTION_LOCK_MISMATCH: active boundary does not match the current generation lock.");
  }
  return boundary;
}

function guidedActionTests(
  action: ReturnType<typeof normalizeAction>,
  resource: ActivatedExplorationBoundary["pack"]["resources"][number],
): Record<string, unknown> {
  return {
    schema_version: "synapsor.contract-tests.v1",
    capability: action.capability_name,
    tests: [
      { name: "tool creates proposal only", kind: "source_unchanged_before_approval", expected: "source_database_changed_false" },
      { name: "trusted tenant required", kind: "scope", expected: resource.tenant_key },
      ...(resource.principal_key ? [{ name: "cross-principal denied", kind: "cross_principal_deny", expected: "generic_miss" }] : []),
      { name: "kept-out fields absent", kind: "redaction", expected: resource.kept_out_fields },
      { name: "allowed columns exact", kind: "write_boundary", expected: action.patches.map((patch) => patch.column) },
      { name: "conflict fails closed", kind: "conflict", expected: action.conflict_column ?? "not_applicable" },
      { name: "retry idempotent", kind: "idempotency", expected: "no_duplicate_mutation" },
      { name: "activation outside model", kind: "deny", expected: "no_model_activation_approval_or_apply" },
      ...(action.auto_approval ? [
        { name: "policy threshold bounded", kind: "policy", expected: action.auto_approval.maximum },
        { name: "daily policy circuits", kind: "policy_budget", expected: { count: action.auto_approval.max_per_day, total: action.auto_approval.max_total_per_day } },
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
): string {
  return [
    `# Review ${draft.capability}`,
    "",
    "State: disabled",
    "",
    `Operation: ${action.operation.toUpperCase()} one ${resource.id}`,
    `Trusted tenant column: ${resource.tenant_key}`,
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
  await writeAtomic(indexPath, json({
    schema_version: GUIDED_ACTION_INDEX_VERSION,
    state: "disabled",
    inferred_write_authority: false,
    drafts: drafts.sort((left, right) => left.capability.localeCompare(right.capability)),
    next_action: "Preview the exact proposal effect, then activate only the reviewed digest.",
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

function transitionDsl(patch: ReturnType<typeof normalizePatch>): string[] {
  if (!/(?:^|_)(?:status|state)$/i.test(patch.column) || patch.value_source !== "fixed" || typeof patch.fixed_value !== "string") return [];
  return [`  TRANSITION ${safeIdentifier(patch.column)} ALLOW ${patch.allowed_from.map((value) => `${dslLiteral(value)} -> ${dslLiteral(patch.fixed_value)}`).join(", ")}`];
}

function insertIdentityCandidates(table: TableInfo, tenantKey: string): string[] {
  const uniqueSets = [
    ...(table.primary_key.length ? [table.primary_key] : []),
    ...table.unique_constraints.map((constraint) => constraint.columns),
  ];
  return table.columns
    .map((column) => column.name)
    .filter((column) => uniqueSets.some((set) =>
      (set.length === 1 && set[0] === column)
      || (set.length === 2 && set.includes(column) && set.includes(tenantKey))));
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
