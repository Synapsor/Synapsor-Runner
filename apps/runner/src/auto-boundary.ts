import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { compileAgentDsl, formatAgentDsl } from "@synapsor/dsl";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  rolePostureFingerprint,
  schemaFingerprintForInspection,
  type SchemaInspection,
  type TableInfo,
} from "@synapsor-runner/schema-inspector";
import { normalizeContract, type SynapsorContract } from "@synapsor/spec";
import type { ProjectDetectionSummary } from "./onboarding-artifacts.js";
import {
  parseSchemaCandidateSource,
  type CandidateObject,
  type ParsedSchema,
  type SchemaCandidateFormat,
} from "./schema-candidates.js";

export const AUTO_BOUNDARY_VERSION = "synapsor.auto-boundary.v1";
export const GENERATION_LOCK_VERSION = "synapsor.generation-lock.v1";
export const EXPLORATION_BOUNDARY_VERSION = "synapsor.exploration-boundary.v1";
export const AUTO_BOUNDARY_COMPILER_VERSION = "1.6.0";
export const AUTO_BOUNDARY_SPEC_VERSION = "1.5.0";
export const DEFAULT_GENERATED_DIR = "synapsor/generated";

const MAX_STATIC_INPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_BUDGETS: ExplorationBudgets = {
  max_rows: 50,
  max_groups: 50,
  max_top_n: 25,
  max_measures: 3,
  max_dimensions: 3,
  max_time_ranges: 2,
  max_relationship_hops: 1,
  max_response_cells: 500,
  max_response_bytes: 64 * 1024,
  statement_timeout_ms: 3000,
  max_complexity: 24,
  max_queries_per_session: 40,
  max_extracted_cells_per_session: 4000,
  max_differencing_queries: 6,
  rate_limit_per_minute: 20,
};

export type InferenceConfidence = "high" | "medium" | "low";

export type BoundaryInference<T> = {
  selected?: T;
  candidates: T[];
  evidence: Array<{ source: "database" | "prisma" | "drizzle" | "openapi" | "synapsor"; detail: string }>;
  confidence: InferenceConfidence;
  confirmation_required: boolean;
  safety_consequence: string;
};

export type AutoBoundaryField = {
  name: string;
  data_type: string;
  nullable: boolean;
  primary_key: boolean;
  sensitive_suggestion: boolean;
  raw_visible_suggestion: boolean;
  aggregate_measure_suggestion: boolean;
  count_distinct_suggestion: boolean;
  groupable_suggestion: boolean;
  time_bucket_suggestion: boolean;
  evidence: string[];
};

export type AutoBoundaryResource = {
  id: string;
  schema: string;
  table: string;
  type: "table" | "view";
  primary_key: BoundaryInference<string>;
  tenant_key: BoundaryInference<string>;
  principal_key: BoundaryInference<string>;
  fields: AutoBoundaryField[];
  relationships: Array<{
    name: string;
    columns: string[];
    referenced_resource: string;
    referenced_columns: string[];
    reviewed_cardinality: "many_to_one_candidate";
    review_required: true;
  }>;
  rls: {
    enabled: boolean | "unknown";
    forced: boolean | "unknown" | "unsupported";
    effective_for_current_role: boolean | "unknown" | "unsupported";
    policy_names: string[];
    using_expressions: string[];
  };
  role_posture: {
    read_only: boolean;
    owner: boolean;
    can_assume_owner: boolean;
    write_capable: boolean;
    verified: boolean;
  };
  status: "draft_read" | "blocked_scope" | "blocked_identifier" | "blocked_role";
  blockers: string[];
};

export type AutoBoundaryEvidenceGraph = {
  schema_version: typeof AUTO_BOUNDARY_VERSION;
  engine: SchemaInspection["engine"];
  database_role: {
    name: string;
    verified: boolean;
    read_only: boolean;
    superuser: boolean | "unknown" | "unsupported";
    bypass_rls: boolean | "unknown" | "unsupported";
    fingerprint: `sha256:${string}`;
  };
  project: {
    frameworks: string[];
    schema_inputs: ProjectDetectionSummary["schema_inputs"];
  };
  resources: AutoBoundaryResource[];
  structured_actions: Array<{
    name: string;
    source: "openapi" | "synapsor";
    resource_hint?: string;
    status: "disabled_requires_business_review";
  }>;
  warnings: string[];
};

export type ExplorationBudgets = {
  max_rows: number;
  max_groups: number;
  max_top_n: number;
  max_measures: number;
  max_dimensions: number;
  max_time_ranges: 2;
  max_relationship_hops: 1;
  max_response_cells: number;
  max_response_bytes: number;
  statement_timeout_ms: number;
  max_complexity: number;
  max_queries_per_session: number;
  max_extracted_cells_per_session: number;
  max_differencing_queries: number;
  rate_limit_per_minute: number;
};

export type ExplorationBoundaryDraft = {
  schema_version: typeof EXPLORATION_BOUNDARY_VERSION;
  activation: "disabled_unreviewed";
  deployment_profile: "development" | "staging";
  source: string;
  compiler_version: string;
  spec_version: string;
  trusted_context: {
    provider: "environment";
    tenant_env: string;
    principal_env: string;
  };
  generation_lock_fingerprint: `sha256:${string}`;
  role_posture_fingerprint: `sha256:${string}`;
  pack: {
    name: string;
    resources: Array<{
      id: string;
      schema: string;
      table: string;
      primary_key: string;
      tenant_key: string;
      principal_key?: string;
      field_types: Record<string, string>;
      field_enums: Record<string, string[]>;
      selectable_fields: string[];
      filterable_fields: Record<string, Array<"eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "in">>;
      sortable_fields: string[];
      groupable_fields: string[];
      aggregate_measures: string[];
      count_distinct_fields: string[];
      time_bucket_fields: Record<string, Array<"day" | "week" | "month">>;
      kept_out_fields: string[];
      relationships: Array<{
        id: string;
        target_resource: string;
        local_columns: string[];
        target_columns: string[];
        counted_entity: string;
        cardinality: "many_to_one";
        max_fan_out: 1;
      }>;
      rls_session?: {
        tenant_setting?: string;
        principal_setting?: string;
      };
      minimum_cohort_size: number;
      suppression_aware_totals: true;
    }>;
  };
  budgets: ExplorationBudgets;
  unresolved_decisions: string[];
};

export type ActivatedExplorationBoundary = Omit<ExplorationBoundaryDraft, "activation" | "unresolved_decisions"> & {
  activation: {
    state: "active";
    digest: `sha256:${string}`;
    actor: string;
    activated_at: string;
    generation_lock_fingerprint: `sha256:${string}`;
    reviewed_decisions: Array<{
      decision: string;
      confirmed: true;
    }>;
  };
};

export type GenerationLock = {
  schema_version: typeof GENERATION_LOCK_VERSION;
  compiler_version: string;
  spec_version: string;
  engine: SchemaInspection["engine"];
  source_env: string;
  schema_fingerprint: `sha256:${string}`;
  role_posture_fingerprint: `sha256:${string}`;
  evidence_fingerprint: `sha256:${string}`;
  generated_contract_digest: `sha256:${string}`;
  reviewed_overrides_digest: `sha256:${string}`;
  protected_authority: string[];
};

export type AutoBoundaryBuild = {
  graph: AutoBoundaryEvidenceGraph;
  dsl: string;
  contract: SynapsorContract;
  contract_digest: `sha256:${string}`;
  lock: GenerationLock;
  exploration_boundary: ExplorationBoundaryDraft;
  review: {
    schema_version: typeof AUTO_BOUNDARY_VERSION;
    activation: "blocked_unreviewed";
    database_role: AutoBoundaryEvidenceGraph["database_role"];
    warnings: string[];
    summary: {
      objects: number;
      draft_reads: number;
      blocked_objects: number;
      sensitive_fields_kept_out: number;
      rls_policies: number;
      structured_write_candidates: number;
    };
    unresolved_decisions: string[];
    resources: AutoBoundaryResource[];
    structured_actions: AutoBoundaryEvidenceGraph["structured_actions"];
  };
  tests: {
    schema_version: "synapsor.generated-tests.v1";
    contract_digest: `sha256:${string}`;
    cases: Array<Record<string, unknown>>;
  };
};

export type AutoBoundaryWriteResult = {
  root: string;
  files: string[];
  contract_digest: `sha256:${string}`;
  schema_fingerprint: `sha256:${string}`;
  draft_reads: number;
  blocked_objects: number;
};

export async function loadStructuredProjectEvidence(
  summary: ProjectDetectionSummary,
): Promise<{ parsed: ParsedSchema[]; existingContracts: SynapsorContract[]; warnings: string[] }> {
  const parsed: ParsedSchema[] = [];
  const existingContracts: SynapsorContract[] = [];
  const warnings: string[] = [];
  for (const input of summary.schema_inputs) {
    const absolute = path.resolve(summary.root, input.path.replace(/\/$/, ""));
    if (input.path.endsWith("/")) continue;
    if (input.kind === "prisma" || input.kind === "drizzle" || input.kind === "openapi") {
      try {
        const source = await readBoundedText(absolute);
        parsed.push(parseSchemaCandidateSource(input.kind satisfies SchemaCandidateFormat, source, absolute));
      } catch (error) {
        warnings.push(`${input.kind}:${input.path} could not be parsed statically: ${safeMessage(error)}`);
      }
      continue;
    }
    if (input.kind === "synapsor" && /\.json$/i.test(input.path)) {
      try {
        const candidate = JSON.parse(await readBoundedText(absolute)) as unknown;
        if (isRecord(candidate) && candidate.kind === "SynapsorContract") {
          existingContracts.push(normalizeContract(candidate as unknown as SynapsorContract));
        }
      } catch (error) {
        warnings.push(`synapsor:${input.path} could not be parsed as a canonical contract: ${safeMessage(error)}`);
      }
    }
  }
  return { parsed, existingContracts, warnings };
}

export function buildAutoBoundary(input: {
  inspection: SchemaInspection;
  project: ProjectDetectionSummary;
  parsedEvidence?: ParsedSchema[];
  existingContracts?: SynapsorContract[];
  sourceEnv: string;
  sourceName?: string;
  overrides?: Record<string, unknown>;
}): AutoBoundaryBuild {
  const parsedEvidence = input.parsedEvidence ?? [];
  const existingContracts = input.existingContracts ?? [];
  const sourceName = input.sourceName ?? (input.inspection.engine === "postgres" ? "local_postgres" : "local_mysql");
  const staticObjects = parsedEvidence.flatMap((evidence) => evidence.objects.map((object) => ({ format: evidence.format, object })));
  const graph = buildEvidenceGraph(input.inspection, input.project, staticObjects, existingContracts);
  const eligibleResources = graph.resources.filter((resource) => resource.status === "draft_read");
  if (eligibleResources.length === 0) {
    const blockers = graph.resources
      .flatMap((resource) => resource.blockers.map((blocker) => `${resource.id}: ${blocker}`))
      .slice(0, 8);
    throw new Error(
      `Auto Boundary found no eligible tenant-scoped resource with a supported identifier and verified read-only posture.` +
      `${blockers.length ? ` Blockers: ${blockers.join("; ")}.` : " The selected schema contains no inspectable tables or views."}`,
    );
  }
  const dsl = emitDraftDsl(graph, sourceName);
  const contract = compileAgentDsl(dsl);
  const contractDigest = canonicalJsonDigest(contract);
  const schemaFingerprint = schemaFingerprintForInspection(input.inspection);
  const roleFingerprint = graph.database_role.fingerprint;
  const overridesDigest = canonicalJsonDigest(input.overrides ?? {});
  const evidenceFingerprint = canonicalJsonDigest({
    graph: graph.resources,
    structured_actions: graph.structured_actions,
    project: graph.project,
  });
  const lock: GenerationLock = {
    schema_version: GENERATION_LOCK_VERSION,
    compiler_version: AUTO_BOUNDARY_COMPILER_VERSION,
    spec_version: AUTO_BOUNDARY_SPEC_VERSION,
    engine: input.inspection.engine,
    source_env: input.sourceEnv,
    schema_fingerprint: schemaFingerprint,
    role_posture_fingerprint: roleFingerprint,
    evidence_fingerprint: evidenceFingerprint,
    generated_contract_digest: contractDigest,
    reviewed_overrides_digest: overridesDigest,
    protected_authority: graph.resources.filter((resource) => resource.status === "draft_read").map((resource) => resource.id),
  };
  const explorationBoundary = buildExplorationBoundaryDraft(graph, sourceName, canonicalJsonDigest(lock));
  const unresolved = unresolvedDecisions(graph);
  const review: AutoBoundaryBuild["review"] = {
    schema_version: AUTO_BOUNDARY_VERSION,
    activation: "blocked_unreviewed" as const,
    database_role: graph.database_role,
    warnings: graph.warnings,
    summary: {
      objects: graph.resources.length,
      draft_reads: graph.resources.filter((resource) => resource.status === "draft_read").length,
      blocked_objects: graph.resources.filter((resource) => resource.status !== "draft_read").length,
      sensitive_fields_kept_out: graph.resources.reduce((count, resource) => count + resource.fields.filter((field) => field.sensitive_suggestion).length, 0),
      rls_policies: graph.resources.reduce((count, resource) => count + resource.rls.policy_names.length, 0),
      structured_write_candidates: graph.structured_actions.length,
    },
    unresolved_decisions: unresolved,
    resources: graph.resources,
    structured_actions: graph.structured_actions,
  };
  return {
    graph,
    dsl,
    contract,
    contract_digest: contractDigest,
    lock,
    exploration_boundary: explorationBoundary,
    review,
    tests: generatedContractTests(graph, contractDigest),
  };
}

export async function writeAutoBoundaryArtifacts(input: {
  projectRoot: string;
  build: AutoBoundaryBuild;
  outputRoot?: string;
  force?: boolean;
}): Promise<AutoBoundaryWriteResult> {
  const projectRoot = path.resolve(input.projectRoot);
  const outputRoot = path.resolve(projectRoot, input.outputRoot ?? DEFAULT_GENERATED_DIR);
  assertInsideProject(projectRoot, outputRoot);
  const existing = await exists(outputRoot);
  if (existing && !input.force) {
    throw new Error(`Auto Boundary output already exists at ${outputRoot}; review it or rerun with --force.`);
  }
  if (existing) await assertManagedBoundaryOutput(outputRoot);

  await fs.mkdir(path.dirname(outputRoot), { recursive: true });
  const temporary = await fs.mkdtemp(path.join(path.dirname(outputRoot), `.${path.basename(outputRoot)}.tmp-`));
  const files = [
    "domain.synapsor.sql",
    "read-capabilities.synapsor.sql",
    "synapsor.candidate.contract.json",
    "exploration-boundary.draft.json",
    "generation-review.json",
    "contract-tests.json",
    "REVIEW.md",
    ".synapsor-auto-boundary.json",
  ];
  try {
    await fs.mkdir(temporary, { recursive: true });
    await fs.writeFile(path.join(temporary, "domain.synapsor.sql"), contextDsl(input.build.dsl), "utf8");
    await fs.writeFile(path.join(temporary, "read-capabilities.synapsor.sql"), capabilityDsl(input.build.dsl), "utf8");
    await fs.writeFile(path.join(temporary, "synapsor.candidate.contract.json"), json(input.build.contract), "utf8");
    await fs.writeFile(path.join(temporary, "exploration-boundary.draft.json"), json(input.build.exploration_boundary), "utf8");
    await fs.writeFile(path.join(temporary, "generation-review.json"), json(input.build.review), "utf8");
    await fs.writeFile(path.join(temporary, "contract-tests.json"), json(input.build.tests), "utf8");
    await fs.writeFile(path.join(temporary, "REVIEW.md"), reviewMarkdown(input.build), "utf8");
    await fs.writeFile(path.join(temporary, ".synapsor-auto-boundary.json"), json({
      schema_version: AUTO_BOUNDARY_VERSION,
      contract_digest: input.build.contract_digest,
      schema_fingerprint: input.build.lock.schema_fingerprint,
    }), "utf8");
    if (existing) await fs.rm(outputRoot, { recursive: true, force: true });
    await fs.mkdir(path.dirname(outputRoot), { recursive: true });
    await fs.rename(temporary, outputRoot);
    const stateDir = path.join(projectRoot, ".synapsor");
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(stateDir, "generation-lock.json"), json(input.build.lock), { encoding: "utf8", mode: 0o600 });
    await fs.writeFile(path.join(stateDir, "review-report.json"), json(input.build.review), { encoding: "utf8", mode: 0o600 });
    return {
      root: outputRoot,
      files: [...files.map((file) => path.join(outputRoot, file)), path.join(stateDir, "generation-lock.json"), path.join(stateDir, "review-report.json")],
      contract_digest: input.build.contract_digest,
      schema_fingerprint: input.build.lock.schema_fingerprint,
      draft_reads: input.build.review.summary.draft_reads,
      blocked_objects: input.build.review.summary.blocked_objects,
    };
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function compareGenerationLock(
  lock: GenerationLock,
  inspection: SchemaInspection,
): {
  current: boolean;
  current_schema_fingerprint: `sha256:${string}`;
  current_role_posture_fingerprint: `sha256:${string}`;
  changes: string[];
} {
  const schemaFingerprint = schemaFingerprintForInspection(inspection);
  const roleFingerprint = rolePostureFingerprint(inspection);
  const changes = [
    ...(schemaFingerprint !== lock.schema_fingerprint ? ["schema metadata changed"] : []),
    ...(roleFingerprint !== lock.role_posture_fingerprint ? ["database role, grants, ownership, or RLS posture changed"] : []),
    ...(lock.compiler_version !== AUTO_BOUNDARY_COMPILER_VERSION ? ["Auto Boundary compiler version changed"] : []),
    ...(lock.spec_version !== AUTO_BOUNDARY_SPEC_VERSION ? ["canonical Spec version changed"] : []),
  ];
  return {
    current: changes.length === 0,
    current_schema_fingerprint: schemaFingerprint,
    current_role_posture_fingerprint: roleFingerprint,
    changes,
  };
}

export async function activateExplorationBoundary(input: {
  projectRoot: string;
  candidate: ExplorationBoundaryDraft;
  expectedDigest: string;
  actor: string;
  confirmation: string;
  confirmedDecisions: string[];
  currentInspection: SchemaInspection;
}): Promise<ActivatedExplorationBoundary> {
  const projectRoot = path.resolve(input.projectRoot);
  const draftPath = path.join(projectRoot, DEFAULT_GENERATED_DIR, "exploration-boundary.draft.json");
  const lockPath = path.join(projectRoot, ".synapsor/generation-lock.json");
  const draft = JSON.parse(await fs.readFile(draftPath, "utf8")) as ExplorationBoundaryDraft;
  const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as GenerationLock;
  assertBoundaryCandidateNarrowsDraft(draft, input.candidate);
  const reviewedDecisions = assertExactDecisionReview(draft.unresolved_decisions, input.confirmedDecisions);
  const comparison = compareGenerationLock(lock, input.currentInspection);
  if (!comparison.current) {
    throw new Error(`Generation lock is stale: ${comparison.changes.join("; ")}.`);
  }
  assertExploreRolePosture(input.currentInspection, input.candidate);
  const normalizedAuthority = boundaryAuthority(input.candidate);
  const digest = canonicalJsonDigest(normalizedAuthority);
  if (input.expectedDigest !== digest) throw new Error("Exploration-boundary digest changed after review; reload and review the exact candidate.");
  if (input.confirmation !== `ACTIVATE ${digest}`) {
    throw new Error(`Activation requires the exact confirmation ACTIVATE ${digest}.`);
  }
  const actor = input.actor.trim();
  if (!actor || actor.length > 128 || /[\u0000-\u001f\u007f]/.test(actor)) throw new Error("Activation actor must be a non-empty local operator identifier.");
  const active: ActivatedExplorationBoundary = {
    schema_version: input.candidate.schema_version,
    deployment_profile: input.candidate.deployment_profile,
    source: input.candidate.source,
    compiler_version: input.candidate.compiler_version,
    spec_version: input.candidate.spec_version,
    trusted_context: input.candidate.trusted_context,
    generation_lock_fingerprint: input.candidate.generation_lock_fingerprint,
    role_posture_fingerprint: input.candidate.role_posture_fingerprint,
    pack: input.candidate.pack,
    budgets: input.candidate.budgets,
    activation: {
      state: "active",
      digest,
      actor,
      activated_at: new Date().toISOString(),
      generation_lock_fingerprint: input.candidate.generation_lock_fingerprint,
      reviewed_decisions: reviewedDecisions.map((decision) => ({ decision, confirmed: true as const })),
    },
  };
  const stateDir = path.join(projectRoot, ".synapsor");
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const auditKeyPath = path.join(stateDir, "explore-audit.key");
  try {
    await fs.writeFile(auditKeyPath, crypto.randomBytes(32).toString("base64url"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const temporary = path.join(stateDir, `.exploration-boundary.active.${process.pid}.${cryptoRandomSuffix()}.tmp`);
  try {
    await fs.writeFile(temporary, json(active), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, path.join(stateDir, "exploration-boundary.active.json"));
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return active;
}

export function explorationBoundaryCandidateDigest(candidate: ExplorationBoundaryDraft): `sha256:${string}` {
  return canonicalJsonDigest(boundaryAuthority(candidate));
}

export function reviewExplorationBoundaryCandidate(
  draft: ExplorationBoundaryDraft,
  candidate: ExplorationBoundaryDraft,
): { digest: `sha256:${string}`; candidate: ExplorationBoundaryDraft } {
  assertBoundaryCandidateNarrowsDraft(draft, candidate);
  return { digest: explorationBoundaryCandidateDigest(candidate), candidate };
}

export async function loadActivatedExplorationBoundary(projectRoot: string): Promise<ActivatedExplorationBoundary> {
  const resolved = path.join(path.resolve(projectRoot), ".synapsor/exploration-boundary.active.json");
  const active = JSON.parse(await fs.readFile(resolved, "utf8")) as ActivatedExplorationBoundary;
  if (active.activation?.state !== "active") throw new Error("Exploration boundary is not active.");
  const authority = {
    schema_version: active.schema_version,
    activation: "reviewed",
    deployment_profile: active.deployment_profile,
    source: active.source,
    compiler_version: active.compiler_version,
    spec_version: active.spec_version,
    trusted_context: active.trusted_context,
    generation_lock_fingerprint: active.generation_lock_fingerprint,
    role_posture_fingerprint: active.role_posture_fingerprint,
    pack: active.pack,
    budgets: active.budgets,
  };
  if (canonicalJsonDigest(authority) !== active.activation.digest) {
    throw new Error("Activated exploration boundary digest does not match its authority.");
  }
  return active;
}

export { rolePostureFingerprint, schemaFingerprintForInspection };

function buildEvidenceGraph(
  inspection: SchemaInspection,
  project: ProjectDetectionSummary,
  staticObjects: Array<{ format: SchemaCandidateFormat; object: CandidateObject }>,
  existingContracts: SynapsorContract[],
): AutoBoundaryEvidenceGraph {
  const staticByTable = new Map<string, Array<{ format: SchemaCandidateFormat; object: CandidateObject }>>();
  for (const item of staticObjects) {
    const key = `${item.object.schema}.${item.object.table}`.toLowerCase();
    const values = staticByTable.get(key) ?? [];
    values.push(item);
    staticByTable.set(key, values);
  }
  const resources = inspection.tables
    .map((table) => buildResource(table, inspection, staticByTable.get(`${table.schema}.${table.name}`.toLowerCase()) ?? []))
    .sort((left, right) => left.id.localeCompare(right.id));
  const structuredActions = [
    ...staticObjects.flatMap(({ format, object }) => format === "openapi"
      ? object.action_candidates.filter((action) => action.kind === "proposal").map((action) => ({
        name: action.name,
        source: "openapi" as const,
        resource_hint: object.name,
        status: "disabled_requires_business_review" as const,
      }))
      : []),
    ...existingContracts.flatMap((contract) => contract.capabilities.filter((capability) => capability.kind === "proposal").map((capability) => ({
      name: capability.name,
      source: "synapsor" as const,
      resource_hint: capability.subject.resource ?? capability.subject.table,
      status: "disabled_requires_business_review" as const,
    }))),
  ].sort((left, right) => left.name.localeCompare(right.name));
  const rolePosture = inspection.role_posture;
  return {
    schema_version: AUTO_BOUNDARY_VERSION,
    engine: inspection.engine,
    database_role: {
      name: inspection.current_user,
      verified: rolePosture?.verified === true,
      read_only: rolePosture?.read_only === true,
      superuser: rolePosture?.superuser ?? "unknown",
      bypass_rls: rolePosture?.bypass_rls ?? "unknown",
      fingerprint: rolePostureFingerprint(inspection),
    },
    project: {
      frameworks: [...project.frameworks].sort(),
      schema_inputs: [...project.schema_inputs].sort((left, right) => `${left.kind}:${left.path}`.localeCompare(`${right.kind}:${right.path}`)),
    },
    resources,
    structured_actions: structuredActions,
    warnings: [
      "Names and comments are untrusted naming evidence only; they never grant authority.",
      "Tenant, principal, field exposure, aggregate permissions, relationships, privacy limits, and activation require human review.",
      ...(!rolePosture?.read_only ? ["The inspected credential is not demonstrably read-only; source-row exploration is blocked."] : []),
    ],
  };
}

function boundaryAuthority(candidate: ExplorationBoundaryDraft): Record<string, unknown> {
  const { unresolved_decisions: _unresolved, activation: _activation, ...authority } = candidate;
  return { ...authority, activation: "reviewed" };
}

function assertBoundaryCandidateNarrowsDraft(
  draft: ExplorationBoundaryDraft,
  candidate: ExplorationBoundaryDraft,
): void {
  if (candidate.schema_version !== draft.schema_version) throw new Error("Exploration boundary schema version cannot change during review.");
  if (candidate.activation !== "disabled_unreviewed") throw new Error("A reviewed candidate must still be disabled before activation.");
  if (candidate.deployment_profile !== "development" && candidate.deployment_profile !== "staging") {
    throw new Error("Scoped Explore activation is limited to an explicit development or staging profile.");
  }
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(candidate.pack.name)) {
    throw new Error("The reviewed authoring pack name must be a stable lower-case identifier.");
  }
  for (const immutable of ["source", "compiler_version", "spec_version", "generation_lock_fingerprint", "role_posture_fingerprint"] as const) {
    if (candidate[immutable] !== draft[immutable]) throw new Error(`${immutable} cannot change during boundary review.`);
  }
  if (JSON.stringify(candidate.trusted_context) !== JSON.stringify(draft.trusted_context)) {
    throw new Error("trusted_context cannot change during boundary review.");
  }
  if (JSON.stringify(candidate.unresolved_decisions) !== JSON.stringify(draft.unresolved_decisions)) {
    throw new Error("Required boundary-review decisions cannot be removed, added, or changed.");
  }
  assertBudgetsNarrow(draft.budgets, candidate.budgets);
  const draftResources = new Map(draft.pack.resources.map((resource) => [resource.id, resource]));
  const candidateResources = new Map(candidate.pack.resources.map((resource) => [resource.id, resource]));
  if (candidate.pack.resources.length < 1) throw new Error("Boundary review must retain at least one reviewed resource.");
  if (candidate.pack.resources.length > draft.pack.resources.length) throw new Error("Boundary review cannot add resources.");
  if (candidateResources.size !== candidate.pack.resources.length) throw new Error("Boundary review cannot duplicate resources.");
  for (const resource of candidate.pack.resources) {
    const original = draftResources.get(resource.id);
    if (!original) throw new Error(`Boundary review cannot add resource ${resource.id}.`);
    for (const field of ["schema", "table", "primary_key", "tenant_key", "principal_key"] as const) {
      if (resource[field] !== original[field]) throw new Error(`${resource.id} ${field} cannot change during review.`);
    }
    if (JSON.stringify(resource.field_types) !== JSON.stringify(original.field_types)
      || JSON.stringify(resource.field_enums) !== JSON.stringify(original.field_enums)
      || JSON.stringify(resource.rls_session ?? null) !== JSON.stringify(original.rls_session ?? null)) {
      throw new Error(`${resource.id} field types, enums, and RLS session bindings cannot change during review.`);
    }
    assertSubset(resource.selectable_fields, original.selectable_fields, `${resource.id} selectable fields`);
    assertSubset(resource.sortable_fields, original.sortable_fields, `${resource.id} sortable fields`);
    assertSubset(resource.groupable_fields, original.groupable_fields, `${resource.id} groupable fields`);
    assertSubset(resource.aggregate_measures, original.aggregate_measures, `${resource.id} aggregate measures`);
    assertSubset(resource.count_distinct_fields, original.count_distinct_fields, `${resource.id} count-distinct fields`);
    assertSubset(original.kept_out_fields, resource.kept_out_fields, `${resource.id} generated kept-out fields`);
    assertSubset(resource.kept_out_fields, Object.keys(original.field_types), `${resource.id} kept-out fields`);
    for (const [field, operators] of Object.entries(resource.filterable_fields)) {
      const originalOperators = original.filterable_fields[field];
      if (!originalOperators) throw new Error(`${resource.id} cannot add filterable field ${field}.`);
      assertSubset(operators, originalOperators, `${resource.id}.${field} filter operators`);
    }
    for (const [field, buckets] of Object.entries(resource.time_bucket_fields)) {
      const originalBuckets = original.time_bucket_fields[field];
      if (!originalBuckets) throw new Error(`${resource.id} cannot add time-bucket field ${field}.`);
      assertSubset(buckets, originalBuckets, `${resource.id}.${field} time buckets`);
    }
    const originalRelationships = new Map(original.relationships.map((relationship) => [relationship.id, relationship]));
    for (const relationship of resource.relationships) {
      const expected = originalRelationships.get(relationship.id);
      if (!expected || JSON.stringify(relationship) !== JSON.stringify(expected)) {
        throw new Error(`${resource.id} cannot add or alter relationship ${relationship.id}.`);
      }
      const target = candidateResources.get(relationship.target_resource);
      if (!target) throw new Error(`${resource.id} relationship ${relationship.id} targets a resource removed from the reviewed pack.`);
      if (relationship.local_columns.some((field) => resource.kept_out_fields.includes(field))
        || relationship.target_columns.some((field) => target.kept_out_fields.includes(field))) {
        throw new Error(`${resource.id} relationship ${relationship.id} cannot use a kept-out field.`);
      }
    }
    assertKeptOutUnavailable(resource);
    if (!Number.isSafeInteger(resource.minimum_cohort_size) || resource.minimum_cohort_size < original.minimum_cohort_size) {
      throw new Error(`${resource.id} minimum cohort size may only stay the same or increase.`);
    }
    if (resource.suppression_aware_totals !== true) throw new Error(`${resource.id} suppression-aware totals cannot be disabled.`);
  }
}

function assertExactDecisionReview(required: string[], confirmed: string[]): string[] {
  if (!Array.isArray(confirmed) || confirmed.some((decision) => typeof decision !== "string")) {
    throw new Error("Boundary activation requires an explicit confirmation for every generated review decision.");
  }
  const normalizedRequired = [...new Set(required)].sort();
  const normalizedConfirmed = [...new Set(confirmed)].sort();
  if (normalizedConfirmed.length !== confirmed.length
    || JSON.stringify(normalizedConfirmed) !== JSON.stringify(normalizedRequired)) {
    throw new Error("Boundary activation requires the exact complete set of generated review decisions.");
  }
  return normalizedRequired;
}

function assertBudgetsNarrow(draft: ExplorationBudgets, candidate: ExplorationBudgets): void {
  for (const key of Object.keys(draft) as Array<keyof ExplorationBudgets>) {
    const value = candidate[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > draft[key]) {
      throw new Error(`Exploration budget ${key} may only stay the same or decrease.`);
    }
  }
}

function assertExploreRolePosture(inspection: SchemaInspection, candidate: ExplorationBoundaryDraft): void {
  const role = inspection.role_posture;
  const enginePrivilegePostureSafe = inspection.engine === "mysql"
    ? (role?.superuser === false || role?.superuser === "unsupported")
      && (role?.bypass_rls === false || role?.bypass_rls === "unsupported")
    : role?.superuser === false && role?.bypass_rls === false;
  if (!role?.verified || !role.read_only || !enginePrivilegePostureSafe) {
    throw new Error("Scoped Explore requires a verified non-superuser, non-BYPASSRLS, read-only database role.");
  }
  const tables = new Map(inspection.tables.map((table) => [`${table.schema}.${table.name}`, table]));
  for (const resource of candidate.pack.resources) {
    const table = tables.get(resource.id);
    const posture = table?.role_posture;
    if (!table || !posture || posture.current_role_is_owner || posture.current_role_can_assume_owner) {
      throw new Error(`Scoped Explore cannot prove non-owner role posture for ${resource.id}.`);
    }
    if (!posture.privileges.select || posture.privileges.insert || posture.privileges.update || posture.privileges.delete || posture.privileges.truncate || posture.privileges.trigger) {
      throw new Error(`Scoped Explore requires SELECT-only authority for ${resource.id}.`);
    }
    if (table.row_level_security === true && posture.row_security_effective_for_current_role !== true) {
      throw new Error(`Configured RLS does not constrain the exact exploration role for ${resource.id}.`);
    }
  }
}

function assertSubset<T>(values: T[], allowed: T[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} cannot contain duplicates.`);
  const set = new Set(allowed);
  if (values.some((value) => !set.has(value))) throw new Error(`${label} may not widen the generated draft.`);
}

function assertKeptOutUnavailable(
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
): void {
  for (const field of resource.kept_out_fields) {
    if (resource.selectable_fields.includes(field)
      || Object.hasOwn(resource.filterable_fields, field)
      || resource.sortable_fields.includes(field)
      || resource.groupable_fields.includes(field)
      || resource.aggregate_measures.includes(field)
      || resource.count_distinct_fields.includes(field)
      || Object.hasOwn(resource.time_bucket_fields, field)) {
      throw new Error(`${resource.id} kept-out field ${field} cannot retain read, filter, sort, group, aggregate, count-distinct, or time-bucket authority.`);
    }
  }
}

function cryptoRandomSuffix(): string {
  return crypto.randomBytes(6).toString("hex");
}

function buildResource(
  table: TableInfo,
  inspection: SchemaInspection,
  staticObjects: Array<{ format: SchemaCandidateFormat; object: CandidateObject }>,
): AutoBoundaryResource {
  const primaryCandidates = unique([
    ...table.primary_key,
    ...staticObjects.flatMap((item) => item.object.primary_key_candidates),
  ]);
  const tenantCandidates = unique([
    ...table.suggestions.tenant_columns,
    ...staticObjects.flatMap((item) => item.object.tenant_candidates),
  ]);
  const principalCandidates = unique(staticObjects.flatMap((item) => item.object.principal_candidates));
  const primarySelected = table.primary_key.length === 1 ? table.primary_key[0] : undefined;
  const tenantSelected = table.suggestions.tenant_columns.includes("tenant_id")
    ? "tenant_id"
    : table.suggestions.tenant_columns.length === 1
      ? table.suggestions.tenant_columns[0]
      : undefined;
  const principalSelected = principalCandidates.length === 1 ? principalCandidates[0] : undefined;
  const posture = table.role_posture;
  const writeCapable = posture
    ? posture.privileges.insert || posture.privileges.update || posture.privileges.delete || posture.privileges.truncate || posture.privileges.trigger
    : true;
  const blockers = [
    ...(!primarySelected ? ["single-column primary key is unresolved"] : []),
    ...(!tenantSelected ? ["trusted tenant scope is unresolved"] : []),
  ];
  const status: AutoBoundaryResource["status"] = !primarySelected
    ? "blocked_identifier"
    : !tenantSelected
      ? "blocked_scope"
      : "draft_read";
  const evidence = staticObjects.map((item) => `${item.format}:${item.object.name}`);
  return {
    id: `${table.schema}.${table.name}`,
    schema: table.schema,
    table: table.name,
    type: table.type,
    primary_key: inference(primarySelected, primaryCandidates, [
      { source: "database", detail: `inspected primary key: ${table.primary_key.join(", ") || "none"}` },
      ...evidence.map((detail) => ({ source: sourceKind(detail), detail })),
    ], Boolean(primarySelected), "The wrong identifier could select a different row or make one-row guarantees impossible."),
    tenant_key: inference(tenantSelected, tenantCandidates, [
      { source: "database", detail: `structural tenant candidates: ${table.suggestions.tenant_columns.join(", ") || "none"}` },
      ...evidence.map((detail) => ({ source: sourceKind(detail), detail })),
    ], false, "The wrong tenant key can cause cross-tenant reads; confirmation is mandatory."),
    principal_key: inference(principalSelected, principalCandidates, evidence.map((detail) => ({ source: sourceKind(detail), detail })), false, "An incorrect owner/assignee key can expose another principal's row."),
    fields: table.columns.map((column): AutoBoundaryField => ({
      name: column.name,
      data_type: column.data_type,
      nullable: column.nullable,
      primary_key: table.primary_key.includes(column.name),
      sensitive_suggestion: column.suggestions.sensitive,
      raw_visible_suggestion: !column.suggestions.sensitive && !column.suggestions.large_or_binary,
      aggregate_measure_suggestion: !column.suggestions.sensitive && isNumericType(column.data_type),
      count_distinct_suggestion: table.primary_key.includes(column.name) && !column.suggestions.sensitive,
      groupable_suggestion: !column.suggestions.sensitive && isCategoricalType(column.data_type, column.enum_values),
      time_bucket_suggestion: !column.suggestions.sensitive && isTimestampType(column.data_type),
      evidence: [
        `database column ${column.name} ${column.data_type}`,
        ...(column.enum_values?.length ? [`database enum values: ${column.enum_values.join(", ")}`] : []),
        ...evidence,
      ],
    })),
    relationships: table.foreign_keys.map((foreignKey) => ({
      name: foreignKey.name,
      columns: foreignKey.columns,
      referenced_resource: `${foreignKey.referenced_schema}.${foreignKey.referenced_table}`,
      referenced_columns: foreignKey.referenced_columns,
      reviewed_cardinality: "many_to_one_candidate",
      review_required: true,
    })),
    rls: {
      enabled: table.row_level_security ?? "unknown",
      forced: posture?.row_security_forced ?? (inspection.engine === "postgres" ? "unknown" : "unsupported"),
      effective_for_current_role: posture?.row_security_effective_for_current_role ?? (inspection.engine === "postgres" ? "unknown" : "unsupported"),
      policy_names: (table.row_level_security_policies ?? []).map((policy) => policy.name).sort(),
      using_expressions: (table.row_level_security_policies ?? []).flatMap((policy) => policy.using_expression ? [policy.using_expression] : []).sort(),
    },
    role_posture: {
      read_only: Boolean(posture?.privileges.select) && !writeCapable,
      owner: posture?.current_role_is_owner ?? false,
      can_assume_owner: posture?.current_role_can_assume_owner ?? false,
      write_capable: writeCapable,
      verified: Boolean(posture),
    },
    status,
    blockers,
  };
}

function emitDraftDsl(graph: AutoBoundaryEvidenceGraph, sourceName: string): string {
  const lines = [
    "CREATE AGENT CONTEXT generated_operator",
    "  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED",
    "  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED",
    "  TENANT BINDING tenant_id",
    "  PRINCIPAL BINDING principal",
    "END",
    "",
  ];
  for (const resource of graph.resources.filter((candidate) => candidate.status === "draft_read")) {
    const primaryKey = resource.primary_key.selected!;
    const tenantKey = resource.tenant_key.selected!;
    const principalKey = resource.principal_key.selected;
    const object = singularize(resource.table);
    const capabilityName = `${safeNamespace(resource.schema)}.inspect_${safeIdentifier(object)}`;
    const lookupArg = `${safeIdentifier(object)}_id`;
    const trustedScopeFields = new Set([tenantKey, principalKey].filter((field): field is string => Boolean(field)));
    const visible = unique([
      primaryKey,
      ...resource.fields
        .filter((field) => field.raw_visible_suggestion && !trustedScopeFields.has(field.name))
        .map((field) => field.name),
    ]);
    const keptOut = unique([
      ...resource.fields.filter((field) => field.sensitive_suggestion || !field.raw_visible_suggestion).map((field) => field.name),
      ...trustedScopeFields,
    ]);
    lines.push(
      `CREATE CAPABILITY ${capabilityName}`,
      `  DESCRIPTION '${escapeDslString(`Inspect one ${humanize(object)} inside the reviewed trusted tenant boundary.`)}'`,
      `  RETURNS HINT '${escapeDslString(`Returns reviewed ${humanize(object)} fields plus evidence and query-audit handles; it never exposes raw SQL.`)}'`,
      "  USING CONTEXT generated_operator",
      `  SOURCE ${safeIdentifier(sourceName)}`,
      `  ON ${safeIdentifier(resource.schema)}.${safeIdentifier(resource.table)}`,
      `  PRIMARY KEY ${safeIdentifier(primaryKey)}`,
      `  TENANT KEY ${safeIdentifier(tenantKey)}`,
      ...(principalKey ? [`  PRINCIPAL SCOPE KEY ${safeIdentifier(principalKey)}`] : []),
      `  LOOKUP ${lookupArg} BY ${safeIdentifier(primaryKey)}`,
      `  ARG ${lookupArg} STRING REQUIRED MAX LENGTH 128 DESCRIPTION 'Reviewed ${escapeDslString(humanize(object))} identifier.'`,
      `  ALLOW READ ${visible.map(safeIdentifier).join(", ")}`,
      ...(keptOut.length ? [`  KEEP OUT ${keptOut.map(safeIdentifier).join(", ")}`] : []),
      "  REQUIRE EVIDENCE",
      "  MAX ROWS 1",
      "END",
      "",
    );
  }
  return `${formatAgentDsl(lines.join("\n"))}\n`;
}

function buildExplorationBoundaryDraft(
  graph: AutoBoundaryEvidenceGraph,
  sourceName: string,
  lockFingerprint: `sha256:${string}`,
): ExplorationBoundaryDraft {
  const resources = graph.resources.filter((resource) => resource.status === "draft_read").map((resource) => {
    const trustedScopeFields = new Set([resource.tenant_key.selected, resource.principal_key.selected].filter((field): field is string => Boolean(field)));
    const keptOut = unique([
      ...resource.fields.filter((field) => field.sensitive_suggestion || !field.raw_visible_suggestion).map((field) => field.name),
      ...trustedScopeFields,
    ]);
    const keptOutSet = new Set(keptOut);
    const selectable = resource.fields.filter((field) => field.raw_visible_suggestion && !trustedScopeFields.has(field.name)).map((field) => field.name);
    const filterable = Object.fromEntries(resource.fields
      .filter((field) => field.raw_visible_suggestion && !trustedScopeFields.has(field.name))
      .map((field) => [field.name, operatorsForType(field.data_type)]));
    const relationships = resource.relationships
      .filter((relationship) => {
        const target = graph.resources.find((candidate) => candidate.id === relationship.referenced_resource);
        if (!target
          || target.status !== "draft_read"
          || relationship.columns.length !== 1
          || relationship.referenced_columns.length !== 1
          || relationship.columns.some((field) => keptOutSet.has(field))) {
          return false;
        }
        const targetTrustedFields = new Set([target.tenant_key.selected, target.principal_key.selected]
          .filter((field): field is string => Boolean(field)));
        const targetKeptOut = new Set([
          ...target.fields
            .filter((field) => field.sensitive_suggestion || !field.raw_visible_suggestion)
            .map((field) => field.name),
          ...targetTrustedFields,
        ]);
        return !relationship.referenced_columns.some((field) => targetKeptOut.has(field));
      })
      .map((relationship) => ({
        id: relationship.name,
        target_resource: relationship.referenced_resource,
        local_columns: relationship.columns,
        target_columns: relationship.referenced_columns,
        counted_entity: resource.primary_key.selected!,
        cardinality: "many_to_one" as const,
        max_fan_out: 1 as const,
      }));
    return {
      id: resource.id,
      schema: resource.schema,
      table: resource.table,
      primary_key: resource.primary_key.selected!,
      tenant_key: resource.tenant_key.selected!,
      ...(resource.principal_key.selected ? { principal_key: resource.principal_key.selected } : {}),
      field_types: Object.fromEntries(resource.fields.map((field) => [field.name, field.data_type])),
      field_enums: Object.fromEntries(resource.fields
        .filter((field) => field.evidence.some((item) => item.startsWith("database enum values:")))
        .map((field) => [
          field.name,
          field.evidence.find((item) => item.startsWith("database enum values:"))!.slice("database enum values:".length).trim().split(/,\s*/),
        ])),
      selectable_fields: selectable,
      filterable_fields: filterable,
      sortable_fields: selectable,
      groupable_fields: resource.fields.filter((field) => field.groupable_suggestion && !keptOutSet.has(field.name)).map((field) => field.name),
      aggregate_measures: resource.fields.filter((field) => field.aggregate_measure_suggestion && !keptOutSet.has(field.name)).map((field) => field.name),
      count_distinct_fields: resource.fields.filter((field) => field.count_distinct_suggestion && !keptOutSet.has(field.name)).map((field) => field.name),
      time_bucket_fields: Object.fromEntries(resource.fields.filter((field) => field.time_bucket_suggestion && !keptOutSet.has(field.name)).map((field) => [
        field.name,
        ["day", "week", "month"] as Array<"day" | "week" | "month">,
      ])),
      kept_out_fields: keptOut,
      relationships,
      ...explorationRlsSession(resource),
      minimum_cohort_size: 5,
      suppression_aware_totals: true as const,
    };
  });
  return {
    schema_version: EXPLORATION_BOUNDARY_VERSION,
    activation: "disabled_unreviewed",
    deployment_profile: "staging",
    source: sourceName,
    compiler_version: AUTO_BOUNDARY_COMPILER_VERSION,
    spec_version: AUTO_BOUNDARY_SPEC_VERSION,
    trusted_context: {
      provider: "environment",
      tenant_env: "SYNAPSOR_TENANT_ID",
      principal_env: "SYNAPSOR_PRINCIPAL",
    },
    generation_lock_fingerprint: lockFingerprint,
    role_posture_fingerprint: graph.database_role.fingerprint,
    pack: { name: "reviewed_staging", resources },
    budgets: { ...DEFAULT_BUDGETS },
    unresolved_decisions: unresolvedDecisions(graph),
  };
}

function generatedContractTests(
  graph: AutoBoundaryEvidenceGraph,
  digest: `sha256:${string}`,
): AutoBoundaryBuild["tests"] {
  const cases: Array<Record<string, unknown>> = [];
  for (const resource of graph.resources.filter((candidate) => candidate.status === "draft_read")) {
    cases.push(
      { name: `${resource.id}: trusted tenant required`, kind: "scope", expected: "deny_without_trusted_tenant" },
      { name: `${resource.id}: model tenant override absent`, kind: "schema", expected: "tenant_not_model_argument" },
      { name: `${resource.id}: kept-out fields unavailable`, kind: "redaction", fields: resource.fields.filter((field) => field.sensitive_suggestion).map((field) => field.name) },
      { name: `${resource.id}: schema fingerprint current`, kind: "drift", expected: "generation_lock_match" },
    );
  }
  return {
    schema_version: "synapsor.generated-tests.v1",
    contract_digest: digest,
    cases,
  };
}

function unresolvedDecisions(graph: AutoBoundaryEvidenceGraph): string[] {
  return unique([
    "deployment profile: confirm development or staging authoring-only use",
    "trusted context: confirm operator-supplied tenant and principal bindings remain outside model arguments",
    ...(!graph.database_role.verified || !graph.database_role.read_only
      ? ["database role: use and verify a non-owner, non-superuser, non-BYPASSRLS, read-only credential before enabling Scoped Explore"]
      : []),
    ...graph.resources.flatMap((resource) => [
    ...(resource.status !== "draft_read" ? resource.blockers.map((blocker) => `${resource.id}: ${blocker}`) : []),
    ...(resource.status === "draft_read" ? [
      `${resource.id}: confirm tenant key ${resource.tenant_key.selected}`,
      `${resource.id}: confirm visible and kept-out fields`,
      `${resource.id}: confirm filter/sort/group/aggregate-only field permissions`,
      `${resource.id}: confirm minimum cohort and extraction/differencing budgets`,
      ...resource.relationships.map((relationship) => `${resource.id}: review relationship ${relationship.name} cardinality and scope on ${relationship.referenced_resource}`),
    ] : []),
    ]),
  ]).sort();
}

function reviewMarkdown(build: AutoBoundaryBuild): string {
  const lines = [
    "# Auto Boundary Review",
    "",
    "Status: disabled and unreviewed. These files grant no runtime authority until a human activates the exact reviewed digest in the local Workbench.",
    "",
    `Candidate contract digest: \`${build.contract_digest}\``,
    `Schema fingerprint: \`${build.lock.schema_fingerprint}\``,
    `Role posture fingerprint: \`${build.lock.role_posture_fingerprint}\``,
    "",
    "## Summary",
    "",
    `- Objects inspected: ${build.review.summary.objects}`,
    `- Draft exact-row reads: ${build.review.summary.draft_reads}`,
    `- Blocked objects: ${build.review.summary.blocked_objects}`,
    `- Sensitive fields kept out by suggestion: ${build.review.summary.sensitive_fields_kept_out}`,
    `- Structured write candidates (disabled): ${build.review.summary.structured_write_candidates}`,
    "",
    "## Required Review",
    "",
    ...build.review.unresolved_decisions.map((decision) => `- [ ] ${decision}`),
    "",
    "Database, ORM, and API comments are naming evidence only. They never create read, write, approval, or activation authority.",
    "",
  ];
  return lines.join("\n");
}

function inference<T>(
  selected: T | undefined,
  candidates: T[],
  evidence: BoundaryInference<T>["evidence"],
  structurallyProven: boolean,
  safetyConsequence: string,
): BoundaryInference<T> {
  return {
    ...(selected !== undefined ? { selected } : {}),
    candidates,
    evidence,
    confidence: structurallyProven ? "high" : candidates.length === 1 ? "medium" : "low",
    confirmation_required: true,
    safety_consequence: safetyConsequence,
  };
}

function sourceKind(detail: string): "prisma" | "drizzle" | "openapi" | "synapsor" {
  const prefix = detail.split(":", 1)[0];
  return prefix === "prisma" || prefix === "drizzle" || prefix === "openapi" ? prefix : "synapsor";
}

function isNumericType(type: string): boolean {
  return /(?:^|\b)(smallint|integer|bigint|numeric|decimal|real|double|float|money|number|tinyint|mediumint)(?:\b|$)/i.test(type);
}

function isTimestampType(type: string): boolean {
  return /date|time/i.test(type);
}

function isCategoricalType(type: string, enumValues?: string[]): boolean {
  return Boolean(enumValues?.length) || /char|text|enum|boolean|bool/i.test(type);
}

function operatorsForType(type: string): Array<"eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "in"> {
  if (isNumericType(type) || isTimestampType(type)) return ["eq", "neq", "lt", "lte", "gt", "gte", "in"];
  return ["eq", "neq", "in"];
}

function explorationRlsSession(resource: AutoBoundaryResource): { rls_session?: { tenant_setting?: string; principal_setting?: string } } {
  if (resource.rls.enabled !== true) return {};
  const tenant = resource.tenant_key.selected
    ? settingForScopedColumn(resource.rls.using_expressions, resource.tenant_key.selected)
    : undefined;
  const principal = resource.principal_key.selected
    ? settingForScopedColumn(resource.rls.using_expressions, resource.principal_key.selected)
    : undefined;
  if (!tenant && !principal) return {};
  return {
    rls_session: {
      ...(tenant ? { tenant_setting: tenant } : {}),
      ...(principal ? { principal_setting: principal } : {}),
    },
  };
}

function settingForScopedColumn(expressions: string[], column: string): string | undefined {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const columnReference = `(?:(?:[A-Za-z_][A-Za-z0-9_$]*|\"[^\"]+\")\\s*\\.\\s*)?(?:${escaped}|\"${escaped}\")`;
  const settingCall = `current_setting\\(\\s*'([A-Za-z0-9_.-]+)'`;
  const candidates = expressions.flatMap((expression) => {
    const direct = expression.match(new RegExp(`${columnReference}\\s*=\\s*${settingCall}`, "i"));
    const reverse = expression.match(new RegExp(`${settingCall}[^)]*\\)\\s*=\\s*${columnReference}`, "i"));
    return [direct?.[1], reverse?.[1]].filter((value): value is string => Boolean(value));
  });
  const uniqueCandidates = unique(candidates);
  return uniqueCandidates.length === 1 ? uniqueCandidates[0] : undefined;
}

function singularize(value: string): string {
  if (/ies$/i.test(value)) return `${value.slice(0, -3)}y`;
  if (/sses$/i.test(value)) return value.slice(0, -2);
  if (/s$/i.test(value) && !/ss$/i.test(value)) return value.slice(0, -1);
  return value;
}

function safeNamespace(value: string): string {
  const candidate = safeIdentifier(value);
  return candidate === "public" ? "app" : candidate;
}

function safeIdentifier(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const prefixed = /^[a-z_]/.test(normalized) ? normalized : `resource_${normalized}`;
  return prefixed || "resource";
}

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

function escapeDslString(value: string): string {
  return value.replace(/'/g, "''");
}

function contextDsl(source: string): string {
  const marker = "\nCREATE CAPABILITY ";
  const index = source.indexOf(marker);
  return index === -1 ? source : `${source.slice(0, index).trim()}\n`;
}

function capabilityDsl(source: string): string {
  const marker = "CREATE CAPABILITY ";
  const index = source.indexOf(marker);
  return index === -1 ? "" : `${source.slice(index).trim()}\n`;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

async function readBoundedText(filePath: string): Promise<string> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("input must be a regular file");
  if (stat.size > MAX_STATIC_INPUT_BYTES) throw new Error(`input exceeds ${MAX_STATIC_INPUT_BYTES} bytes`);
  return fs.readFile(filePath, "utf8");
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/(?:postgres|mysql)(?:ql)?:\/\/\S+/gi, "<redacted-database-url>") : String(error);
}

function assertInsideProject(projectRoot: string, outputRoot: string): void {
  const relative = path.relative(projectRoot, outputRoot);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    if (!relative) return;
    throw new Error("Auto Boundary output must stay inside the project root.");
  }
}

async function assertManagedBoundaryOutput(outputRoot: string): Promise<void> {
  const marker = path.join(outputRoot, ".synapsor-auto-boundary.json");
  if (!await exists(marker)) throw new Error(`Refusing to replace unmanaged directory ${outputRoot}.`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
