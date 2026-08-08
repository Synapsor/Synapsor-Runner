import fs from "node:fs/promises";
import path from "node:path";
import { compileAgentDsl, formatAgentDsl } from "@synapsor/dsl";
import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type {
  JsonScalar,
  SynapsorContract,
} from "@synapsor/spec";
import {
  deactivateExplorationBoundary,
  loadActivatedExplorationBoundary,
  loadActivatedExplorationBoundaries,
  reviewedRankedGroupLimit,
  type ActivatedExplorationBoundary,
  type ExplorationDerivedBaseMeasure,
  type GenerationLock,
} from "./auto-boundary.js";
import { loadCompletedBoundaryReviewOverrides } from "./boundary-review-policy.js";
import {
  listProtectedPlans,
  loadProtectedPlan,
  modelWithheldExploreOutputColumns,
  prepareScopedExplore,
  scopedExploreBoundaryLoadError,
  assertPreparedExplorePlanAuthority,
  validateExplorePlan,
  type AggregateExplorePlan,
  type ExploreFilter,
  type ExplorePlan,
} from "./scoped-explore.js";

const PROTECTED_QUERY_VERSION = "synapsor.protected-query.v1";
const PROTECTED_DIR = "synapsor/protected";

type BoundaryResource = ActivatedExplorationBoundary["pack"]["resources"][number];
type ProtectedRelationshipLinkPlan = {
  source: BoundaryResource;
  target: BoundaryResource;
  localKey: string;
  targetKey: string;
  unmatchedRows: "exclude" | "keep_null";
};
type ProtectedRelationshipPlan = {
  name: string;
  links: ProtectedRelationshipLinkPlan[];
};
type ReviewedMinimumCohortAuthority = {
  resource: string;
  minimum_cohort_size: number;
  review_digest: `sha256:${string}`;
};
type ContractMinimumCohortAuthority = Omit<
  ReviewedMinimumCohortAuthority,
  "review_digest"
>;

export type ProtectLiteralPosition = {
  location: string;
  field: string;
  relationship?: string;
  current_value: JsonScalar;
  inferred_type: "string" | "number" | "boolean";
  reviewed_enum?: JsonScalar[];
  suggested_argument: string;
};

export type PersistedProtectLiteralPosition = Omit<ProtectLiteralPosition, "current_value">;

export type ProtectArgumentSelection = {
  location: string;
  name: string;
  description: string;
  max_length?: number;
  minimum?: number;
  maximum?: number;
};

export type ProtectedQueryDraft = {
  schema_version: typeof PROTECTED_QUERY_VERSION;
  state: "disabled";
  capability: string;
  source: string;
  mode: ExplorePlan["kind"];
  boundary_digest: `sha256:${string}`;
  generation_lock_fingerprint: `sha256:${string}`;
  contract_digest: `sha256:${string}`;
  dsl_path: string;
  contract_path: string;
  tests_path: string;
  review_path: string;
  literal_positions: PersistedProtectLiteralPosition[];
  converted_arguments: ProtectArgumentSelection[];
  minimum_cohort_override?: {
    resource: string;
    minimum_cohort_size: number;
    review_digest: `sha256:${string}`;
    reconfirmed_by: string;
    reconfirmed_at: string;
  };
};

export type ProtectedQueryActivation = {
  schema_version: typeof PROTECTED_QUERY_VERSION;
  state: "active";
  capability: string;
  contract_digest: `sha256:${string}`;
  contract_path: string;
  config_path: string;
  actor: string;
  activated_at: string;
  exploration_disabled: boolean;
  minimum_cohort_override?: {
    resource: string;
    minimum_cohort_size: number;
    review_digest: `sha256:${string}`;
    reconfirmed_by: string;
    reconfirmed_at: string;
  };
};

export async function loadProtectedQueryDraft(input: {
  projectRoot: string;
  capabilityName: string;
}): Promise<ProtectedQueryDraft> {
  const projectRoot = path.resolve(input.projectRoot);
  assertQualifiedCapabilityName(input.capabilityName);
  const draft = JSON.parse(
    await fs.readFile(
      path.join(draftRoot(projectRoot, input.capabilityName), "draft.json"),
      "utf8",
    ),
  ) as ProtectedQueryDraft;
  if (draft.schema_version !== PROTECTED_QUERY_VERSION
    || draft.state !== "disabled"
    || draft.capability !== input.capabilityName
    || !/^sha256:[a-f0-9]{64}$/.test(draft.boundary_digest)) {
    throw new Error("Protected capability draft is invalid or belongs to another capability.");
  }
  return draft;
}

export function protectMinimumCohortConfirmation(
  resource: string,
  minimumCohortSize: number,
): string {
  return `PROTECT WITH MINIMUM COHORT ${minimumCohortSize} FOR ${resource}`;
}

export function activateMinimumCohortConfirmation(
  resource: string,
  minimumCohortSize: number,
  contractDigest: string,
): string {
  return `ACTIVATE ${contractDigest} WITH MINIMUM COHORT ${minimumCohortSize} FOR ${resource}`;
}

export async function listProtectableQueries(input: {
  projectRoot: string;
  now?: number;
}): Promise<Array<{
  token: string;
  expires_at: string;
  boundary_digest: `sha256:${string}`;
  kind: ExplorePlan["kind"];
  resource: string;
  normalized_plan: ExplorePlan;
  literal_positions: ProtectLiteralPosition[];
  created_at?: string;
  answer_id?: string;
  evidence_bundle_id?: string;
  query_audit_handle?: string;
  outcome?: "ok" | "empty" | "fully_suppressed" | "incomplete_comparison";
  returned_rows_or_groups?: number;
  returned_cells?: number;
  suppressed_groups?: number;
  minimum_cohort_override?: {
    resource: string;
    minimum_cohort_size: number;
    confirmation: string;
  };
}>> {
  const projectRoot = path.resolve(input.projectRoot);
  const boundaries = await loadActivatedExplorationBoundaries(projectRoot).catch((error) => {
    throw scopedExploreBoundaryLoadError(error);
  });
  const boundaryByDigest = new Map(
    boundaries.map((boundary) => [boundary.activation.digest, boundary]),
  );
  const items = await listProtectedPlans({ projectRoot, ...(input.now === undefined ? {} : { now: input.now }) });
  return items
    .filter((item) => boundaryByDigest.has(item.boundary_digest))
    .map((item) => {
      const boundary = boundaryByDigest.get(item.boundary_digest)!;
      const plan = validateExplorePlan(item.plan, boundary);
      const resource = boundary.pack.resources.find((candidate) => candidate.id === plan.resource);
      const minimumCohortOverride = plan.kind === "aggregate"
        && resource?.minimum_cohort_overridden === true
        ? {
          resource: resource.id,
          minimum_cohort_size: resource.minimum_cohort_size,
          confirmation: protectMinimumCohortConfirmation(
            resource.id,
            resource.minimum_cohort_size,
          ),
        }
        : undefined;
      return {
        token: item.token,
        expires_at: item.expires_at,
        boundary_digest: item.boundary_digest,
        kind: plan.kind,
        resource: plan.resource,
        normalized_plan: plan,
        literal_positions: protectLiteralPositions(plan, boundary),
        ...(minimumCohortOverride ? { minimum_cohort_override: minimumCohortOverride } : {}),
        ...item.metadata,
      };
    });
}

export function describeProtectableAnalysis(plan: ExplorePlan): string {
  const resource = humanWords(plan.resource.split(".").pop() ?? plan.resource);
  if (plan.kind === "rows") {
    return `Reviewed ${resource} rows with ${plan.select.length} visible field${plan.select.length === 1 ? "" : "s"}`;
  }
  const measures = plan.measures.map((measure) => {
    if ("derived_measure" in measure) return `reviewed ${humanWords(measure.derived_measure)}`;
    if (measure.function === "count") return resource;
    const field = humanWords(measure.field ?? "value");
    return `${measure.function.replace("_", " ")} ${field}`;
  }).join(" and ");
  const groups = [
    ...(plan.dimensions ?? []).map((dimension) =>
      humanWords("numeric_band" in dimension ? dimension.numeric_band : dimension.field)),
    ...(plan.time_bucket ? [`${plan.time_bucket.bucket} ${humanWords(plan.time_bucket.field)}`] : []),
  ];
  const comparison = plan.comparison ? " across two reviewed periods" : "";
  return `${measures || resource}${groups.length ? ` grouped by ${groups.join(" and ")}` : ""}${comparison}`;
}

export function suggestProtectedCapabilityName(plan: ExplorePlan): string {
  const resource = safeCapabilitySegment(plan.resource.split(".").pop() ?? "analysis");
  if (plan.kind === "rows") return `analytics.${resource}_rows`;
  const measure = plan.measures[0];
  const measureSegment = measure && "derived_measure" in measure
    ? safeCapabilitySegment(measure.derived_measure)
    : measure?.function === "count"
    ? "count"
    : safeCapabilitySegment(`${measure?.function ?? "measure"}_${measure?.field ?? "value"}`);
  const groupSegments = [
    ...(plan.dimensions ?? []).map((dimension) =>
      safeCapabilitySegment("numeric_band" in dimension ? dimension.numeric_band : dimension.field)),
    ...(plan.time_bucket ? [safeCapabilitySegment(plan.time_bucket.bucket)] : []),
  ];
  const candidate = `analytics.${resource}_${measureSegment}${groupSegments.length ? `_by_${groupSegments.join("_and_")}` : ""}`;
  return candidate.length <= 128 ? candidate : `${candidate.slice(0, 111)}_${canonicalJsonDigest(plan).slice(-16)}`;
}

function humanWords(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function safeCapabilitySegment(value: string): string {
  const normalized = value.toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "analysis";
}

export async function createProtectedQueryDraft(input: {
  projectRoot: string;
  token: string;
  capabilityName: string;
  description: string;
  returnsHint: string;
  arguments?: ProtectArgumentSelection[];
  minimumCohortConfirmation?: string;
  minimumCohortConfirmed?: true;
  minimumCohortActor?: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
  inspectDatabaseFn?: Parameters<typeof prepareScopedExplore>[0]["inspectDatabaseFn"];
}): Promise<{ draft: ProtectedQueryDraft; dsl: string; contract: SynapsorContract; tests: Record<string, unknown> }> {
  const projectRoot = path.resolve(input.projectRoot);
  assertQualifiedCapabilityName(input.capabilityName);
  const description = reviewedText(input.description, "description", 500);
  const returnsHint = reviewedText(input.returnsHint, "returns hint", 500);
  const protectedPlan = await loadProtectedPlan({ projectRoot, token: input.token, ...(input.now === undefined ? {} : { now: input.now }) });
  const boundary = await loadActivatedExplorationBoundary(projectRoot, {
    digest: protectedPlan.boundary_digest,
  });
  if (boundary.organization_scope) {
    throw new Error(
      "Protect conversion is unavailable for single-organization Explore because protected capabilities still require a direct tenant column. The reviewed Explore boundary remains read-only.",
    );
  }
  const prepared = await prepareScopedExplore({
    projectRoot,
    transport: "loopback_workbench",
    boundaryName: boundary.pack.name,
    env: input.env ?? process.env,
    ...(input.inspectDatabaseFn ? { inspectDatabaseFn: input.inspectDatabaseFn } : {}),
  });
  if (protectedPlan.boundary_digest !== boundary.activation.digest) throw new Error("Protect token belongs to a different or superseded exploration boundary.");
  const plan = validateExplorePlan(protectedPlan.plan, boundary);
  assertPreparedExplorePlanAuthority(plan, prepared);
  const reviewedCohortOverride = await reviewedMinimumCohortOverride({
    projectRoot,
    boundary,
    plan,
  });
  let minimumCohortOverride: ProtectedQueryDraft["minimum_cohort_override"];
  if (reviewedCohortOverride) {
    const expected = protectMinimumCohortConfirmation(
      reviewedCohortOverride.resource,
      reviewedCohortOverride.minimum_cohort_size,
    );
    if (input.minimumCohortConfirmed !== true && input.minimumCohortConfirmation !== expected) {
      throw new Error(
        "Protect requires an explicit human re-confirmation of the lowered small-group threshold.",
      );
    }
    if (typeof input.minimumCohortActor !== "string") {
      throw new Error("Protect requires the human identity re-confirming the lowered minimum cohort.");
    }
    minimumCohortOverride = {
      ...reviewedCohortOverride,
      reconfirmed_by: reviewedText(
        input.minimumCohortActor,
        "minimum cohort reviewer",
        128,
      ),
      reconfirmed_at: new Date().toISOString(),
    };
  }
  const positions = protectLiteralPositions(plan, boundary);
  const selections = validateArgumentSelections(input.arguments ?? [], positions);
  const requiresPrincipal = protectedPlanRequiresPrincipal(plan, boundary);
  const dsl = emitProtectedQueryDsl({
    capabilityName: input.capabilityName,
    description,
    returnsHint,
    plan,
    boundary,
    positions,
    selections,
    requiresPrincipal,
  });
  const contract = compileAgentDsl(dsl);
  const capability = contract.capabilities.find((candidate) => candidate.name === input.capabilityName);
  if (!capability?.protected_read) throw new Error("Protect conversion did not produce canonical protected_read authority.");
  const contractDigest = canonicalJsonDigest(contract);
  const outputRoot = draftRoot(projectRoot, input.capabilityName);
  const dslPath = path.join(outputRoot, "capability.synapsor.sql");
  const contractPath = path.join(outputRoot, "synapsor.contract.json");
  const testsPath = path.join(outputRoot, "contract-tests.json");
  const reviewPath = path.join(outputRoot, "REVIEW.md");
  const tests = protectedQueryTests(contract, capability);
  const draft: ProtectedQueryDraft = {
    schema_version: PROTECTED_QUERY_VERSION,
    state: "disabled",
    capability: input.capabilityName,
    source: boundary.source,
    mode: plan.kind,
    boundary_digest: boundary.activation.digest,
    generation_lock_fingerprint: boundary.generation_lock_fingerprint,
    contract_digest: contractDigest,
    dsl_path: relativeProjectPath(projectRoot, dslPath),
    contract_path: relativeProjectPath(projectRoot, contractPath),
    tests_path: relativeProjectPath(projectRoot, testsPath),
    review_path: relativeProjectPath(projectRoot, reviewPath),
    literal_positions: positions.map(({ current_value: _currentValue, ...position }) => position),
    converted_arguments: [...selections.values()],
    ...(minimumCohortOverride ? { minimum_cohort_override: minimumCohortOverride } : {}),
  };
  await writeDraftArtifacts({
    outputRoot,
    dsl,
    contract,
    tests,
    draft,
    review: protectedReviewMarkdown(draft, plan),
  });
  return { draft, dsl, contract, tests };
}

export async function activateProtectedQuery(input: {
  projectRoot: string;
  capabilityName: string;
  expectedDigest: string;
  confirmation?: string;
  operatorConfirmed?: true;
  actor: string;
  minimumCohortConfirmation?: string;
  minimumCohortConfirmed?: true;
  configPath?: string;
  disableExplore?: boolean;
  env?: NodeJS.ProcessEnv;
  prepareScopedExploreFn?: typeof prepareScopedExplore;
}): Promise<ProtectedQueryActivation> {
  const projectRoot = path.resolve(input.projectRoot);
  assertQualifiedCapabilityName(input.capabilityName);
  const actor = reviewedText(input.actor, "actor", 128);
  const outputRoot = draftRoot(projectRoot, input.capabilityName);
  const draft = await loadProtectedQueryDraft({
    projectRoot,
    capabilityName: input.capabilityName,
  });
  const contract = JSON.parse(await fs.readFile(path.join(outputRoot, "synapsor.contract.json"), "utf8")) as SynapsorContract;
  const digest = canonicalJsonDigest(contract);
  const contractCohortOverride = protectedContractMinimumCohortOverride(
    contract,
    input.capabilityName,
  );
  if (draft.state !== "disabled" || draft.contract_digest !== digest || input.expectedDigest !== digest) {
    throw new Error("Protected capability changed after review; reload and review the exact draft.");
  }
  if (!sameProtectedMinimumCohortOverride(
    draft.minimum_cohort_override,
    contractCohortOverride,
  )) {
    throw new Error(
      "Protected capability minimum-cohort authority does not match its recorded owner review; regenerate and review the draft.",
    );
  }
  const legacyExactConfirmation = input.confirmation === `ACTIVATE ${digest}`;
  if (input.operatorConfirmed !== true && !legacyExactConfirmation) {
    throw new Error("Protected capability activation requires an explicit human confirmation of the reviewed preview.");
  }
  if (contractCohortOverride) {
    const expected = activateMinimumCohortConfirmation(
      contractCohortOverride.resource,
      contractCohortOverride.minimum_cohort_size,
      digest,
    );
    if (input.minimumCohortConfirmed !== true && input.minimumCohortConfirmation !== expected) {
      throw new Error(
        "Protected capability activation requires an explicit human re-confirmation of the lowered small-group threshold.",
      );
    }
  }
  const prepared = await (input.prepareScopedExploreFn ?? prepareScopedExplore)({
    projectRoot,
    transport: "loopback_workbench",
    boundaryName: (await loadActivatedExplorationBoundary(projectRoot, {
      digest: draft.boundary_digest,
    })).pack.name,
    env: input.env ?? process.env,
  });
  if (prepared.boundary.activation.digest !== draft.boundary_digest
    || prepared.boundary.generation_lock_fingerprint !== draft.generation_lock_fingerprint) {
    throw new Error("Protected capability is not bound to the current reviewed boundary and generation lock.");
  }
  if (contractCohortOverride) {
    const currentOverride = await reviewedMinimumCohortOverrideForResource({
      projectRoot,
      boundary: prepared.boundary,
      resourceId: contractCohortOverride.resource,
    });
    if (!currentOverride
      || currentOverride.minimum_cohort_size !== contractCohortOverride.minimum_cohort_size
      || currentOverride.review_digest !== draft.minimum_cohort_override?.review_digest) {
      throw new Error(
        "Protected capability minimum-cohort authority no longer matches the current recorded owner decision.",
      );
    }
  }

  const activeRoot = path.join(projectRoot, PROTECTED_DIR, "active");
  await fs.mkdir(activeRoot, { recursive: true, mode: 0o700 });
  const activeContractPath = path.join(activeRoot, `${safeCapabilityFileName(input.capabilityName)}.contract.json`);
  await writeAtomic(activeContractPath, json(contract), 0o600);
  const configPath = path.resolve(input.configPath ?? path.join(projectRoot, "synapsor.runner.json"));
  await addProtectedContractToRuntimeConfig({
    projectRoot,
    configPath,
    contractPath: activeContractPath,
    sourceName: draft.source,
    lock: prepared.lock,
    databaseScope: protectedDatabaseScope(contract, prepared.boundary),
    statementTimeoutMs: contract.capabilities[0]?.protected_read?.limits.statement_timeout_ms ?? 3000,
    capabilityName: input.capabilityName,
    contractDigest: digest,
    minimumCohortOverride: draft.minimum_cohort_override,
  });
  const explorationDisabled = input.disableExplore !== false;
  if (explorationDisabled) {
    await deactivateExplorationBoundary(projectRoot, prepared.boundary.pack.name);
  }
  const activation: ProtectedQueryActivation = {
    schema_version: PROTECTED_QUERY_VERSION,
    state: "active",
    capability: input.capabilityName,
    contract_digest: digest,
    contract_path: relativeProjectPath(projectRoot, activeContractPath),
    config_path: relativeProjectPath(projectRoot, configPath),
    actor,
    activated_at: new Date().toISOString(),
    exploration_disabled: explorationDisabled,
    ...(draft.minimum_cohort_override
      ? {
        minimum_cohort_override: {
          ...draft.minimum_cohort_override,
          reconfirmed_by: actor,
          reconfirmed_at: new Date().toISOString(),
        },
      }
      : {}),
  };
  await writeAtomic(path.join(activeRoot, `${safeCapabilityFileName(input.capabilityName)}.activation.json`), json(activation), 0o600);
  return activation;
}

export async function disableScopedExplore(
  projectRoot: string,
  boundaryName?: string,
): Promise<{ disabled: boolean; disabled_boundaries: string[]; remaining_boundaries: string[] }> {
  const result = await deactivateExplorationBoundary(projectRoot, boundaryName);
  return {
    disabled: result.disabled.length > 0,
    disabled_boundaries: result.disabled,
    remaining_boundaries: result.remaining.map((boundary) => boundary.pack.name),
  };
}

export function protectLiteralPositions(plan: ExplorePlan, boundary: ActivatedExplorationBoundary): ProtectLiteralPosition[] {
  const root = resourceFor(boundary, plan.resource);
  const positions: ProtectLiteralPosition[] = [];
  for (const [index, filter] of (plan.where ?? []).entries()) {
    if (Array.isArray(filter.value)) continue;
    positions.push(positionFor({
      location: `where.${index}.value`,
      value: filter.value,
      field: filter.field,
      relationship: filter.relationship,
      root,
      boundary,
    }));
  }
  if (plan.kind === "aggregate") {
    for (const [index, range] of (plan.comparison?.ranges ?? []).entries()) {
      positions.push(positionFor({
        location: `comparison.ranges.${index}.start`,
        value: range.start,
        field: plan.comparison!.field,
        relationship: plan.comparison!.relationship,
        root,
        boundary,
      }));
      positions.push(positionFor({
        location: `comparison.ranges.${index}.end`,
        value: range.end,
        field: plan.comparison!.field,
        relationship: plan.comparison!.relationship,
        root,
        boundary,
      }));
    }
  }
  return positions;
}

function emitProtectedQueryDsl(input: {
  capabilityName: string;
  description: string;
  returnsHint: string;
  plan: ExplorePlan;
  boundary: ActivatedExplorationBoundary;
  positions: ProtectLiteralPosition[];
  selections: Map<string, ProtectArgumentSelection>;
  requiresPrincipal: boolean;
}): string {
  const root = resourceFor(input.boundary, input.plan.resource);
  const rootTenantKey = requireProtectedDirectTenantKey(root);
  const relationships = relationshipsForPlan(input.plan, root, input.boundary);
  const lines = [
    "CREATE AGENT CONTEXT protected_operator",
    `  BIND tenant_id FROM ENVIRONMENT ${input.boundary.trusted_context.tenant_env} REQUIRED`,
    ...(input.requiresPrincipal
      ? [`  BIND principal FROM ENVIRONMENT ${input.boundary.trusted_context.principal_env} REQUIRED`]
      : []),
    "  TENANT BINDING tenant_id",
    ...(input.requiresPrincipal ? ["  PRINCIPAL BINDING principal"] : []),
    "END",
    "",
    `CREATE CAPABILITY ${input.capabilityName}`,
    `  DESCRIPTION '${escapeDslString(input.description)}'`,
    `  RETURNS HINT '${escapeDslString(input.returnsHint)}'`,
    "  USING CONTEXT protected_operator",
    `  SOURCE ${safeIdentifier(input.boundary.source)}`,
    `  ON ${safeIdentifier(root.schema)}.${safeIdentifier(root.table)}`,
    `  PRIMARY KEY ${safeIdentifier(root.primary_key)}`,
    `  TENANT KEY ${safeIdentifier(rootTenantKey)}`,
    ...(root.principal_key ? [`  PRINCIPAL SCOPE KEY ${safeIdentifier(root.principal_key)}`] : []),
    ...argumentDsl(input.positions, input.selections),
    `  PROTECTED READ ${input.plan.kind === "rows" ? "ROWS" : "AGGREGATE"}`,
    `  BOUNDARY DIGEST ${input.boundary.activation.digest}`,
    `  GENERATION LOCK ${input.boundary.generation_lock_fingerprint}`,
    ...relationshipsDsl(relationships),
    ...predicateDsl(input.plan.where ?? [], input.selections),
  ];
  if (input.plan.kind === "rows") {
    lines.push(
      `  ALLOW READ ${input.plan.select.map(safeIdentifier).join(", ")}`,
      ...(input.plan.order_by ?? []).map((order) => `  ROW ORDER BY ${safeIdentifier(order.field)} ${order.direction.toUpperCase()}`),
    );
  } else {
    lines.push(...aggregateDsl(input.plan, input.selections, root.minimum_cohort_size, root));
  }
  if (root.kept_out_fields.length) lines.push(`  KEEP OUT ${root.kept_out_fields.map(safeIdentifier).join(", ")}`);
  const modelWithheldFields = modelWithheldExploreOutputColumns(input.plan, input.boundary);
  if (modelWithheldFields.length) {
    lines.push(`  MODEL WITHHELD ${modelWithheldFields.map(safeIdentifier).join(", ")}`);
  }
  lines.push(
    "  REQUIRE EVIDENCE",
    protectedLimitsDsl(input.plan, input.boundary, root),
    "END",
  );
  return `${formatAgentDsl(lines.join("\n"))}\n`;
}

function aggregateDsl(
  plan: AggregateExplorePlan,
  selections: Map<string, ProtectArgumentSelection>,
  minimumGroupSize: number,
  root: BoundaryResource,
): string[] {
  const aliases = aggregateAliases(plan);
  const lines = plan.measures.map((measure, index) => {
    if ("derived_measure" in measure) {
      const definition = protectedDerivedMeasure(root, measure.derived_measure);
      if ("base_measure" in definition) {
        const modifier = definition.shape === "rank"
          ? ` ${definition.direction!.toUpperCase()}`
          : definition.shape === "moving_average"
            ? ` WINDOW ${definition.window_size}`
            : "";
        return `  MEASURE ${aliases.measures[index]} POST ${definition.shape.toUpperCase()}${modifier} OF ${protectedDerivedOperandDsl(definition.base_measure)}`;
      }
      return `  MEASURE ${aliases.measures[index]} DERIVED ${definition.shape.toUpperCase()} NUMERATOR ${protectedDerivedOperandDsl(definition.numerator)} DENOMINATOR ${protectedDerivedOperandDsl(definition.denominator)}`;
    }
    if (measure.function === "count") return `  MEASURE ${aliases.measures[index]} COUNT ROWS`;
    const target = protectedFieldName(measure.field, measure.relationship);
    if (measure.function === "count_distinct") return `  MEASURE ${aliases.measures[index]} COUNT DISTINCT ${target}`;
    return `  MEASURE ${aliases.measures[index]} ${measure.function.toUpperCase()} ${target}`;
  });
  for (const [index, dimension] of (plan.dimensions ?? []).entries()) {
    if ("numeric_band" in dimension) {
      const band = protectedNumericBand(root, dimension.numeric_band);
      lines.push(
        `  GROUP DIMENSION ${aliases.dimensions[index]} BY BAND OF ${protectedFieldName(band.field, band.relationship)} ` +
        `EDGES (${band.edges.join(", ")}) LABELS (${band.bucket_labels.map(dslLiteral).join(", ")})`,
      );
    } else {
      lines.push(`  GROUP DIMENSION ${aliases.dimensions[index]} BY ${protectedFieldName(dimension.field, dimension.relationship)}`);
    }
  }
  if (plan.time_bucket) {
    lines.push(`  TIME DIMENSION ${aliases.timeBucket} BY ${plan.time_bucket.bucket.toUpperCase()} OF ${protectedFieldName(plan.time_bucket.field, plan.time_bucket.relationship)}`);
  }
  for (const [index, range] of (plan.comparison?.ranges ?? []).entries()) {
    lines.push(`  COMPARE RANGE ${protectedFieldName(plan.comparison!.field, plan.comparison!.relationship)} FROM ${valueDsl(range.start, selections.get(`comparison.ranges.${index}.start`))} TO ${valueDsl(range.end, selections.get(`comparison.ranges.${index}.end`))}`);
  }
  if (plan.order_by?.kind === "measure") {
    lines.push(`  AGGREGATE ORDER BY MEASURE ${aliases.measures[plan.order_by.index]} ${plan.order_by.direction.toUpperCase()}`);
  } else if (plan.order_by?.kind === "comparison_change") {
    lines.push(`  AGGREGATE ORDER BY ${plan.order_by.change.toUpperCase()} CHANGE ${aliases.measures[plan.order_by.index]} ${plan.order_by.direction.toUpperCase()}`);
  } else if (plan.order_by?.kind === "time_bucket") {
    lines.push(`  AGGREGATE ORDER BY TIME BUCKET ${plan.order_by.direction.toUpperCase()}`);
  }
  lines.push(`  TOP ${plan.top_n} GROUPS`);
  const effectiveMinimumGroupSize = plan.measures.some((measure) =>
    "derived_measure" in measure
      || ["stddev_samp", "stddev_pop", "var_samp", "var_pop"].includes(measure.function))
    ? Math.max(minimumGroupSize, 5)
    : minimumGroupSize;
  lines.push(`  MIN GROUP SIZE ${effectiveMinimumGroupSize}`);
  return lines;
}

function protectedLimitsDsl(
  plan: ExplorePlan,
  boundary: ActivatedExplorationBoundary,
  root: BoundaryResource,
): string {
  const budgets = boundary.budgets;
  const rows = plan.kind === "rows" ? plan.limit : budgets.max_rows;
  const ranked = plan.kind === "aggregate"
    && (plan.order_by?.kind === "measure"
      || plan.order_by?.kind === "comparison_change"
      || plan.measures.some((measure) => "derived_measure" in measure
        && "base_measure" in protectedDerivedMeasure(root, measure.derived_measure)));
  const rankedGroups = ranked
    ? ` RANKED GROUPS ${reviewedRankedGroupLimit(budgets)}`
    : "";
  return `  PROTECTED LIMITS ROWS ${rows} GROUPS ${budgets.max_groups}${rankedGroups} CELLS ${budgets.max_response_cells} BYTES ${budgets.max_response_bytes} TIMEOUT MS ${budgets.statement_timeout_ms} QUERIES ${budgets.max_queries_per_session} EXTRACTED CELLS ${budgets.max_extracted_cells_per_session} DIFFERENCING ${budgets.max_differencing_queries} RATE PER MINUTE ${budgets.rate_limit_per_minute}`;
}

function predicateDsl(filters: ExploreFilter[], selections: Map<string, ProtectArgumentSelection>): string[] {
  return filters.map((filter, index) => {
    const field = protectedFieldName(filter.field, filter.relationship);
    if (filter.op === "in") {
      if (!Array.isArray(filter.value)) throw new Error("Reviewed IN filter lost its fixed value list.");
      return `  PROTECTED FILTER ${field} IN (${filter.value.map(dslLiteral).join(", ")})`;
    }
    if (Array.isArray(filter.value)) throw new Error("Only IN filters may contain a value list.");
    return `  PROTECTED FILTER ${field} ${filter.op.toUpperCase()} ${valueDsl(filter.value, selections.get(`where.${index}.value`))}`;
  });
}

function argumentDsl(positions: ProtectLiteralPosition[], selections: Map<string, ProtectArgumentSelection>): string[] {
  const byLocation = new Map(positions.map((position) => [position.location, position]));
  return [...selections.values()].sort((left, right) => left.name.localeCompare(right.name)).map((selection) => {
    const position = byLocation.get(selection.location)!;
    const description = escapeDslString(selection.description);
    if (position.inferred_type === "number") {
      return `  ARG ${safeIdentifier(selection.name)} NUMBER REQUIRED MIN ${selection.minimum} MAX ${selection.maximum} DESCRIPTION '${description}'`;
    }
    if (position.inferred_type === "boolean") {
      const enumClause = position.reviewed_enum?.length ? ` ENUM(${position.reviewed_enum.map(dslLiteral).join(", ")})` : "";
      return `  ARG ${safeIdentifier(selection.name)} BOOLEAN${enumClause} REQUIRED DESCRIPTION '${description}'`;
    }
    const enumClause = position.reviewed_enum?.length ? ` ENUM(${position.reviewed_enum.map(dslLiteral).join(", ")})` : "";
    return `  ARG ${safeIdentifier(selection.name)} STRING${enumClause} REQUIRED MAX LENGTH ${selection.max_length} DESCRIPTION '${description}'`;
  });
}

function valueDsl(value: JsonScalar, selection: ProtectArgumentSelection | undefined): string {
  return selection ? `ARG ${safeIdentifier(selection.name)}` : `FIXED ${dslLiteral(value)}`;
}

function relationshipsForPlan(
  plan: ExplorePlan,
  root: BoundaryResource,
  boundary: ActivatedExplorationBoundary,
): ProtectedRelationshipPlan[] {
  const names = new Set<string>();
  if (plan.kind === "aggregate" && plan.relationship) names.add(plan.relationship);
  for (const filter of plan.where ?? []) if (filter.relationship) names.add(filter.relationship);
  if (plan.kind === "aggregate") {
    for (const measure of plan.measures) {
      if ("derived_measure" in measure) {
        const definition = protectedDerivedMeasure(root, measure.derived_measure);
        const operands = "base_measure" in definition
          ? [definition.base_measure]
          : [definition.numerator, definition.denominator];
        for (const operand of operands) {
          if ("relationship" in operand && operand.relationship) names.add(operand.relationship);
        }
      } else if (measure.relationship) names.add(measure.relationship);
    }
    for (const dimension of plan.dimensions ?? []) {
      const relationship = "numeric_band" in dimension
        ? protectedNumericBand(root, dimension.numeric_band).relationship
        : dimension.relationship;
      if (relationship) names.add(relationship);
    }
    if (plan.time_bucket?.relationship) names.add(plan.time_bucket.relationship);
    if (plan.comparison?.relationship) names.add(plan.comparison.relationship);
  }
  if (names.size === 0) return [];
  if (names.size > 3) throw new Error("Protect conversion permits at most three reviewed relationship paths.");
  return [...names].map((name) => {
    const relationship = root.relationships.find((candidate) => candidate.id === name);
    if (!relationship || relationship.cardinality !== "many_to_one" || relationship.max_fan_out !== 1) {
      throw new Error(`Protect conversion requires ${name} to remain a cardinality-proven many-to-one relationship.`);
    }
    const proofLinks = relationship.proof?.links ?? [{
      constraint_name: relationship.id,
      source_resource: root.id,
      target_resource: relationship.target_resource,
      source_columns: relationship.local_columns,
      target_columns: relationship.target_columns,
      target_uniqueness: {
        kind: "primary_key" as const,
        name: `legacy:${relationship.target_resource}`,
        columns: relationship.target_columns,
      },
      nullable: false,
      cardinality: "many_to_one" as const,
      max_fan_out: 1 as const,
    }];
    if (proofLinks.length < 1 || proofLinks.length > 2) {
      throw new Error(`Protect conversion requires ${name} to contain one or two reviewed relationship links.`);
    }
    if (relationship.proof && (
      relationship.proof.source !== "database_catalog"
      || canonicalJsonDigest(proofLinks) !== relationship.proof.digest
    )) {
      throw new Error(`Protect conversion refused ${name} because its catalog proof changed after review.`);
    }
    let expectedSource = root.id;
    let preserveUnmatched = false;
    const links = proofLinks.map((link, index): ProtectedRelationshipLinkPlan => {
      if (link.source_resource !== expectedSource
        || link.cardinality !== "many_to_one"
        || link.max_fan_out !== 1
        || link.source_columns.length !== 1
        || link.target_columns.length !== 1
        || link.target_uniqueness.columns.length !== 1
        || link.target_uniqueness.columns[0] !== link.target_columns[0]) {
        throw new Error(`Protect conversion refused ${name} because link ${index + 1} is not a contiguous, uniquely targeted many-to-one link.`);
      }
      const source = resourceFor(boundary, link.source_resource);
      const target = resourceFor(boundary, link.target_resource);
      requireProtectedDirectTenantKey(source);
      requireProtectedDirectTenantKey(target);
      const localKey = link.source_columns[0]!;
      const targetKey = link.target_columns[0]!;
      if (source.kept_out_fields.includes(localKey) || target.kept_out_fields.includes(targetKey)) {
        throw new Error(`Protect conversion refused ${name} because a relationship key is kept out.`);
      }
      if (link.nullable
        && relationship.unmatched_rows !== "exclude"
        && relationship.unmatched_rows !== "keep_null") {
        throw new Error(`Protect conversion requires an explicit unmatched-row decision for nullable relationship ${name}.`);
      }
      if (link.nullable && relationship.unmatched_rows === "keep_null") preserveUnmatched = true;
      const unmatchedRows = preserveUnmatched ? "keep_null" : "exclude";
      expectedSource = target.id;
      return { source, target, localKey, targetKey, unmatchedRows };
    });
    if (expectedSource !== relationship.target_resource) {
      throw new Error(`Protect conversion refused ${name} because its reviewed target no longer matches its proof path.`);
    }
    return { name, links };
  });
}

function protectedPlanRequiresPrincipal(
  plan: ExplorePlan,
  boundary: ActivatedExplorationBoundary,
): boolean {
  const root = resourceFor(boundary, plan.resource);
  if (root.principal_key) return true;
  return relationshipsForPlan(plan, root, boundary).some((relationship) =>
    relationship.links.some((link) => Boolean(link.source.principal_key || link.target.principal_key)));
}

function relationshipsDsl(relationships: ProtectedRelationshipPlan[]): string[] {
  if (relationships.length === 0) return [];
  const only = relationships.length === 1 ? relationships[0] : undefined;
  if (only?.links.length === 1 && only.links[0]?.unmatchedRows === "exclude") {
    const link = only.links[0];
    return [
      `  PROTECTED RELATIONSHIP ${safeIdentifier(only.name)} ON ${safeIdentifier(link.localKey)} REFERENCES ${safeIdentifier(link.target.schema)}.${safeIdentifier(link.target.table)}.${safeIdentifier(link.targetKey)} PRIMARY KEY ${safeIdentifier(link.target.primary_key)} TENANT KEY ${safeIdentifier(requireProtectedDirectTenantKey(link.target))}${link.target.principal_key ? ` PRINCIPAL SCOPE KEY ${safeIdentifier(link.target.principal_key)}` : ""}`,
    ];
  }
  return relationships.flatMap((relationship) => relationship.links.map((link, index) =>
    `  PROTECTED RELATIONSHIP ${safeIdentifier(relationship.name)} LINK ${index + 1} ON ${safeIdentifier(link.localKey)} REFERENCES ${safeIdentifier(link.target.schema)}.${safeIdentifier(link.target.table)}.${safeIdentifier(link.targetKey)} PRIMARY KEY ${safeIdentifier(link.target.primary_key)} TENANT KEY ${safeIdentifier(requireProtectedDirectTenantKey(link.target))}${link.target.principal_key ? ` PRINCIPAL SCOPE KEY ${safeIdentifier(link.target.principal_key)}` : ""} UNMATCHED ${link.unmatchedRows === "keep_null" ? "KEEP NULL" : "EXCLUDE"}`));
}

function requireProtectedDirectTenantKey(
  resource: ActivatedExplorationBoundary["pack"]["resources"][number],
): string {
  if (!resource.tenant_key) {
    throw new Error(
      `Protect conversion refused ${resource.id} because relationship-carried tenant scope is read-only Explore authority; protected capabilities currently require a direct tenant column.`,
    );
  }
  if (resource.principal_scope) {
    throw new Error(
      `Protect conversion refused ${resource.id} because relationship-carried principal scope is read-only Explore authority; protected capabilities currently require a direct principal column when principal scope applies.`,
    );
  }
  return resource.tenant_key;
}

function aggregateAliases(plan: AggregateExplorePlan): {
  measures: string[];
  dimensions: string[];
  timeBucket: string;
} {
  const used = new Set<string>();
  const uniqueAlias = (candidate: string): string => {
    const base = safeAlias(candidate);
    let value = base;
    let suffix = 2;
    while (used.has(value)) value = `${base}_${suffix++}`;
    used.add(value);
    return value;
  };
  return {
    measures: plan.measures.map((measure) => uniqueAlias("derived_measure" in measure
      ? measure.derived_measure
      : measure.function === "count"
      ? "row_count"
      : `${measure.function}_${measure.relationship ? `${measure.relationship}_` : ""}${measure.field}`)),
    dimensions: (plan.dimensions ?? []).map((dimension) => uniqueAlias(
      "numeric_band" in dimension
        ? dimension.numeric_band
        : `${dimension.relationship ? `${dimension.relationship}_` : ""}${dimension.field}`,
    )),
    timeBucket: uniqueAlias(`${plan.time_bucket?.relationship ? `${plan.time_bucket.relationship}_` : ""}${plan.time_bucket?.field ?? "time"}_${plan.time_bucket?.bucket ?? "bucket"}`),
  };
}

function protectedDerivedMeasure(
  root: BoundaryResource,
  name: string,
): NonNullable<BoundaryResource["derived_measures"]>[number] {
  const definition = root.derived_measures?.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Reviewed derived measure ${root.id}.${name} is no longer active.`);
  return definition;
}

function protectedNumericBand(
  root: BoundaryResource,
  name: string,
): NonNullable<BoundaryResource["numeric_bands"]>[number] {
  const definition = root.numeric_bands?.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Reviewed numeric band ${root.id}.${name} is no longer active.`);
  return definition;
}

function protectedDerivedOperandDsl(
  operand: ExplorationDerivedBaseMeasure,
): string {
  if (operand.function === "count") return "COUNT ROWS";
  const target = protectedFieldName(operand.field, operand.relationship);
  return operand.function === "count_distinct"
    ? `COUNT DISTINCT ${target}`
    : `${operand.function.toUpperCase()} ${target}`;
}

function validateArgumentSelections(
  values: ProtectArgumentSelection[],
  positions: ProtectLiteralPosition[],
): Map<string, ProtectArgumentSelection> {
  if (!Array.isArray(values) || values.length > positions.length) throw new Error("Protect arguments must select only presented literal positions.");
  const byLocation = new Map(positions.map((position) => [position.location, position]));
  const selected = new Map<string, ProtectArgumentSelection>();
  const names = new Set<string>();
  for (const value of values) {
    const position = byLocation.get(value.location);
    if (!position) throw new Error(`Unknown protected literal position: ${value.location}.`);
    const name = safeIdentifier(value.name);
    if (names.has(name)) throw new Error(`Protected argument name ${name} is duplicated.`);
    names.add(name);
    const description = reviewedText(value.description, `${name} description`, 300);
    const normalized: ProtectArgumentSelection = { location: value.location, name, description };
    if (position.inferred_type === "number") {
      if (!Number.isFinite(value.minimum) || !Number.isFinite(value.maximum) || Number(value.minimum) > Number(value.maximum)) {
        throw new Error(`Numeric protected argument ${name} requires a finite reviewed minimum and maximum.`);
      }
      if (typeof position.current_value !== "number" || position.current_value < Number(value.minimum) || position.current_value > Number(value.maximum)) {
        throw new Error(`Numeric bounds for ${name} must include the reviewed current literal.`);
      }
      normalized.minimum = Number(value.minimum);
      normalized.maximum = Number(value.maximum);
    } else if (position.inferred_type === "string") {
      const currentLength = String(position.current_value).length;
      const maxLength = value.max_length ?? Math.max(32, Math.min(512, currentLength || 1));
      if (!Number.isSafeInteger(maxLength) || maxLength < currentLength || maxLength > 512) {
        throw new Error(`String protected argument ${name} requires max_length from ${currentLength} through 512.`);
      }
      normalized.max_length = maxLength;
    }
    selected.set(value.location, normalized);
  }
  return selected;
}

function positionFor(input: {
  location: string;
  value: JsonScalar;
  field: string;
  relationship?: string;
  root: BoundaryResource;
  boundary: ActivatedExplorationBoundary;
}): ProtectLiteralPosition {
  const resource = input.relationship ? relationshipResource(input.root, input.relationship, input.boundary) : input.root;
  const dataType = resource.field_types[input.field] ?? "";
  const inferredType = /(?:int|numeric|decimal|real|double|float|money|number)/i.test(dataType)
    ? "number"
    : /bool/i.test(dataType)
      ? "boolean"
      : "string";
  if (input.value !== null && typeof input.value !== inferredType) throw new Error(`Reviewed literal at ${input.location} no longer matches ${resource.id}.${input.field}.`);
  return {
    location: input.location,
    field: input.field,
    ...(input.relationship ? { relationship: input.relationship } : {}),
    current_value: input.value,
    inferred_type: inferredType,
    ...(resource.field_enums[input.field]?.length ? { reviewed_enum: resource.field_enums[input.field] } : {}),
    suggested_argument: safeAlias(`${input.field}_${input.location.endsWith("start") ? "start" : input.location.endsWith("end") ? "end" : "value"}`),
  };
}

function protectedQueryTests(
  contract: SynapsorContract,
  capability: SynapsorContract["capabilities"][number],
): Record<string, unknown> {
  if (!capability.protected_read) {
    throw new Error("Protected-query tests require canonical protected-read authority.");
  }
  const context = contract.contexts.find((candidate) => candidate.name === capability.context);
  const tenantBinding = context?.bindings.find((binding) => binding.name === context.tenant_binding);
  const principalBinding = context?.bindings.find((binding) => binding.name === context.principal_binding);
  const keptOutFields = capability.kept_out_fields ?? [];
  const scope = JSON.parse(JSON.stringify({
    context: capability.context,
    tenant_key: capability.subject.tenant_key,
    tenant_binding: context?.tenant_binding,
    tenant_authority: tenantBinding
      ? { source: tenantBinding.source, key: tenantBinding.key, required: tenantBinding.required === true }
      : null,
    principal_binding: context?.principal_binding,
    principal_authority: principalBinding
      ? { source: principalBinding.source, key: principalBinding.key, required: principalBinding.required === true }
      : null,
  })) as Record<string, unknown>;
  return {
    $schema: "https://schemas.synapsor.ai/synapsor.contract-tests.schema.json",
    version: 1,
    name: `${capability.name} protected boundary`,
    tests: [
      {
        id: "protected-read-shape-suppression-drift-and-boundaries",
        kind: "protected_read_boundary",
        capability: capability.name,
        expected: capability.protected_read,
      },
      {
        id: "trusted-scope-remains-outside-model-arguments",
        kind: "trusted_scope",
        capability: capability.name,
        expected: scope,
      },
      ...(keptOutFields.length
        ? [{
          id: "kept-out-fields-remain-unavailable",
          kind: "hide_fields",
          capability: capability.name,
          fields: keptOutFields,
        }]
        : []),
      {
        id: "evidence-and-query-audit-remain-required",
        kind: "evidence_requirement",
        capability: capability.name,
        expected: capability.evidence ?? {},
      },
      {
        id: "operator-controls-remain-outside-mcp",
        kind: "operator_boundary",
        capability: capability.name,
      },
    ],
  };
}

async function writeDraftArtifacts(input: {
  outputRoot: string;
  dsl: string;
  contract: SynapsorContract;
  tests: Record<string, unknown>;
  draft: ProtectedQueryDraft;
  review: string;
}): Promise<void> {
  await fs.mkdir(input.outputRoot, { recursive: true, mode: 0o700 });
  const markerPath = path.join(input.outputRoot, ".synapsor-protected-query.json");
  const existing = await readOptionalJson(markerPath);
  if (existing && existing.schema_version !== PROTECTED_QUERY_VERSION) {
    throw new Error(`Refusing to overwrite unmanaged protected-query directory ${input.outputRoot}.`);
  }
  await writeAtomic(path.join(input.outputRoot, "capability.synapsor.sql"), input.dsl, 0o600);
  await writeAtomic(path.join(input.outputRoot, "synapsor.contract.json"), json(input.contract), 0o600);
  await writeAtomic(path.join(input.outputRoot, "contract-tests.json"), json(input.tests), 0o600);
  await writeAtomic(path.join(input.outputRoot, "REVIEW.md"), input.review, 0o600);
  await writeAtomic(path.join(input.outputRoot, "draft.json"), json(input.draft), 0o600);
  await writeAtomic(markerPath, json({ schema_version: PROTECTED_QUERY_VERSION, capability: input.draft.capability }), 0o600);
}

async function addProtectedContractToRuntimeConfig(input: {
  projectRoot: string;
  configPath: string;
  contractPath: string;
  sourceName: string;
  capabilityName: string;
  contractDigest: `sha256:${string}`;
  lock: GenerationLock;
  databaseScope?: {
    mode: "postgres_rls";
    tenant_setting: string;
    principal_setting?: string;
  };
  statementTimeoutMs: number;
  minimumCohortOverride?: ProtectedQueryDraft["minimum_cohort_override"];
}): Promise<void> {
  const existing = await readOptionalJson(input.configPath);
  const relativeContract = relativeConfigPath(path.dirname(input.configPath), input.contractPath);
  const config = existing ?? {
    version: 1,
    mode: "read_only",
    storage: { sqlite_path: "./.synapsor/local.db" },
    contracts: [],
    sources: {},
    strict: true,
  };
  if (!isRecord(config)) throw new Error("Runner config must be a JSON object.");
  const contracts = Array.isArray(config.contracts) ? config.contracts.filter((item): item is string => typeof item === "string") : [];
  if (!contracts.includes(relativeContract)) contracts.push(relativeContract);
  config.contracts = contracts;
  const generationLockPath = relativeConfigPath(
    path.dirname(input.configPath),
    path.join(input.projectRoot, ".synapsor/generation-lock.json"),
  );
  if (config.generated_authority !== undefined) {
    if (!isRecord(config.generated_authority)
      || config.generated_authority.generation_lock_path !== generationLockPath
      || config.generated_authority.enforcement !== "required"
      || (config.generated_authority.reporting_timezone !== undefined
        && config.generated_authority.reporting_timezone !== input.lock.reporting_timezone)) {
      const existingPath = isRecord(config.generated_authority)
        && typeof config.generated_authority.generation_lock_path === "string"
        ? config.generated_authority.generation_lock_path
        : "(missing)";
      throw new Error(
        `Existing generated_authority lock path ${existingPath} does not match the reviewed project lock ${generationLockPath}.`,
      );
    }
  } else {
    config.generated_authority = {
      generation_lock_path: generationLockPath,
      enforcement: "required",
      ...(input.lock.reporting_timezone
        ? { reporting_timezone: input.lock.reporting_timezone }
        : {}),
    };
  }
  if (input.lock.reporting_timezone && isRecord(config.generated_authority)) {
    config.generated_authority.reporting_timezone = input.lock.reporting_timezone;
  }
  if (!isRecord(config.generated_authority)) {
    throw new Error("Protected capability requires generated_authority configuration.");
  }
  if (Array.isArray(config.capabilities)
    && config.capabilities.length === 0
    && isRecord(config.trusted_context)
    && config.trusted_context.provider === "environment") {
    delete config.trusted_context.principal_binding;
    if (isRecord(config.trusted_context.values)) {
      delete config.trusted_context.values.principal_env;
    }
  }
  const currentCohortOverrides = isRecord(config.generated_authority.minimum_cohort_overrides)
    ? config.generated_authority.minimum_cohort_overrides
    : {};
  if (input.minimumCohortOverride) {
    currentCohortOverrides[input.capabilityName] = {
      contract_digest: input.contractDigest,
      minimum_cohort_size: input.minimumCohortOverride.minimum_cohort_size,
      review_digest: input.minimumCohortOverride.review_digest,
    };
  } else {
    delete currentCohortOverrides[input.capabilityName];
  }
  if (Object.keys(currentCohortOverrides).length > 0) {
    config.generated_authority.minimum_cohort_overrides = currentCohortOverrides;
  } else {
    delete config.generated_authority.minimum_cohort_overrides;
  }
  const sources = isRecord(config.sources) ? config.sources : {};
  const existingSource = sources[input.sourceName];
  const expectedSource = {
    engine: input.lock.engine,
    read_url_env: input.lock.source_env,
    read_only: true,
    statement_timeout_ms: input.statementTimeoutMs,
    ...(input.databaseScope ? { database_scope: input.databaseScope } : {}),
  };
  if (existingSource !== undefined) {
    if (!isRecord(existingSource)
      || existingSource.engine !== expectedSource.engine
      || existingSource.read_url_env !== expectedSource.read_url_env
      || existingSource.read_only === false
      || (input.databaseScope
        && existingSource.database_scope !== undefined
        && JSON.stringify(existingSource.database_scope) !== JSON.stringify(input.databaseScope))) {
      throw new Error(`Existing source ${input.sourceName} does not match the protected capability's inspected source.`);
    }
    existingSource.read_only = true;
    existingSource.statement_timeout_ms = Math.min(
      typeof existingSource.statement_timeout_ms === "number" ? existingSource.statement_timeout_ms : input.statementTimeoutMs,
      input.statementTimeoutMs,
    );
    if (input.databaseScope) existingSource.database_scope = input.databaseScope;
  } else {
    sources[input.sourceName] = expectedSource;
  }
  config.sources = sources;
  const validation = validateRunnerCapabilityConfig(config);
  if (!validation.ok) throw new Error(`Protected capability would make Runner config invalid: ${validation.errors.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}`);
  await writeAtomic(input.configPath, json(config), 0o600);
}

export function protectedDatabaseScope(
  contract: SynapsorContract,
  boundary: ActivatedExplorationBoundary,
): {
  mode: "postgres_rls";
  tenant_setting: string;
  principal_setting?: string;
} | undefined {
  const capability = contract.capabilities.find((candidate) => candidate.protected_read);
  if (!capability) throw new Error("Protected contract does not contain protected_read authority.");
  const rootSchema = capability.subject.schema;
  const rootTable = capability.subject.table;
  if (!rootSchema || !rootTable) throw new Error("Protected capability must retain an explicit root schema and table.");
  const references = new Map<string, { schema: string; table: string; principalRequired: boolean }>();
  const addReference = (schema: string, table: string, principalRequired: boolean): void => {
    const key = `${schema}\u0000${table}`;
    const existing = references.get(key);
    references.set(key, {
      schema,
      table,
      principalRequired: principalRequired || Boolean(existing?.principalRequired),
    });
  };
  addReference(rootSchema, rootTable, Boolean(capability.subject.principal_scope_key));
  const legacyRelationship = capability.protected_read?.relationship;
  if (legacyRelationship) {
    addReference(
      legacyRelationship.schema,
      legacyRelationship.table,
      Boolean(legacyRelationship.principal_scope_key),
    );
  }
  for (const relationship of capability.protected_read?.relationships ?? []) {
    for (const link of relationship.links) {
      addReference(link.schema, link.table, Boolean(link.principal_scope_key));
    }
  }
  const reviewedReferences = [...references.values()];
  const resources = reviewedReferences.map((reference) =>
    boundary.pack.resources.find((resource) =>
      resource.schema === reference.schema && resource.table === reference.table));
  if (resources.some((resource) => !resource)) {
    throw new Error("Protected capability references a resource outside the activated exploration boundary.");
  }
  for (const resource of resources) requireProtectedDirectTenantKey(resource!);
  const scopes = resources
    .map((resource) => resource!.rls_session)
    .filter((scope): scope is NonNullable<typeof scope> => scope !== undefined);
  if (scopes.length === 0) return undefined;
  if (scopes.length !== resources.length
    || scopes.some((scope) => !scope.tenant_setting)) {
    throw new Error("Protected capability cannot preserve the reviewed PostgreSQL RLS session bindings for every participating relation.");
  }
  const principalRequired = resources.map((resource, index) => Boolean(
    resource!.principal_key || reviewedReferences[index]?.principalRequired,
  ));
  if (principalRequired.some((required, index) => required && !scopes[index]?.principal_setting)) {
    throw new Error("Protected capability declares principal scope on a relation whose reviewed PostgreSQL RLS principal binding is incomplete.");
  }
  const principalSettings = new Set(scopes.flatMap((scope) =>
    scope.principal_setting ? [scope.principal_setting] : []));
  const requiresPrincipal = principalRequired.some(Boolean);
  const tenantSettings = new Set(scopes.map((scope) => scope.tenant_setting));
  if (tenantSettings.size !== 1 || (requiresPrincipal && principalSettings.size !== 1)) {
    throw new Error("Protected capability requires one consistent reviewed tenant/principal RLS setting across its relationship path.");
  }
  return {
    mode: "postgres_rls",
    tenant_setting: scopes[0]!.tenant_setting!,
    ...(requiresPrincipal ? { principal_setting: scopes[0]!.principal_setting! } : {}),
  };
}

function protectedReviewMarkdown(draft: ProtectedQueryDraft, plan: ExplorePlan): string {
  const cohortOverride = draft.minimum_cohort_override
    ? `
Minimum cohort: **${draft.minimum_cohort_override.minimum_cohort_size} (explicit owner override)**

Override review digest: \`${draft.minimum_cohort_override.review_digest}\`

This threshold was explicitly re-confirmed for Protect by \`${draft.minimum_cohort_override.reconfirmed_by}\`. A value of 1 disables small-group suppression and permits groups of one, which can identify individuals. Protected-capability activation requires a second explicit confirmation.
`
    : "";
  return `# Protected Query Review

State: **DISABLED**

Capability: \`${draft.capability}\`

Contract digest: \`${draft.contract_digest}\`

Boundary digest: \`${draft.boundary_digest}\`

Generation lock: \`${draft.generation_lock_fingerprint}\`
${cohortOverride}

This draft freezes one successful ${plan.kind === "aggregate" ? "privacy-suppressed aggregate" : "bounded row"} exploration plan. It cannot be called until a local operator reviews the generated DSL, tests, arguments, trusted scope, and exact digest through the secured CLI or Workbench operator surface.

Activation binds the operator's confirmation to this digest internally. The operator must not copy or type the digest.

Approval, activation, and commit authority are not exposed through MCP.
`;
}

async function reviewedMinimumCohortOverride(input: {
  projectRoot: string;
  boundary: ActivatedExplorationBoundary;
  plan: ExplorePlan;
}): Promise<ReviewedMinimumCohortAuthority | undefined> {
  if (input.plan.kind !== "aggregate") return undefined;
  return reviewedMinimumCohortOverrideForResource({
    projectRoot: input.projectRoot,
    boundary: input.boundary,
    resourceId: input.plan.resource,
  });
}

async function reviewedMinimumCohortOverrideForResource(input: {
  projectRoot: string;
  boundary: ActivatedExplorationBoundary;
  resourceId: string;
}): Promise<ReviewedMinimumCohortAuthority | undefined> {
  const resource = resourceFor(input.boundary, input.resourceId);
  if (resource.minimum_cohort_overridden !== true) return undefined;
  const overrides = await loadCompletedBoundaryReviewOverrides({
    projectRoot: input.projectRoot,
    boundaryName: input.boundary.pack.name,
  });
  if (!overrides) {
    throw new Error(
      `Boundary ${input.boundary.pack.name} has legacy owner-review evidence that is not yet isolated from other boundaries. Open /access, review this boundary, and activate its disabled revision before protecting this lowered cohort threshold.`,
    );
  }
  const decision = overrides.resources[resource.id]?.minimum_cohort;
  if (!decision || decision.value !== resource.minimum_cohort_size) {
    throw new Error(
      "The active minimum-cohort override no longer has matching recorded owner review evidence.",
    );
  }
  return {
    resource: resource.id,
    minimum_cohort_size: resource.minimum_cohort_size,
    review_digest: canonicalJsonDigest({
      schema_version: "synapsor.minimum-cohort-owner-decision.v1",
      resource: resource.id,
      value: decision.value,
      actor: decision.actor,
      reason: decision.reason,
      decided_at: decision.decided_at,
    }),
  };
}

function protectedContractMinimumCohortOverride(
  contract: SynapsorContract,
  capabilityName: string,
): ContractMinimumCohortAuthority | undefined {
  const capability = contract.capabilities.find((candidate) =>
    candidate.name === capabilityName);
  const aggregate = capability?.protected_read?.mode === "aggregate"
    ? capability.protected_read.aggregate
    : undefined;
  if (!capability || !aggregate || aggregate.minimum_group_size >= 5) {
    return undefined;
  }
  return {
    resource: `${capability.subject.schema}.${capability.subject.table}`,
    minimum_cohort_size: aggregate.minimum_group_size,
  };
}

function sameProtectedMinimumCohortOverride(
  recorded: ProtectedQueryDraft["minimum_cohort_override"] | undefined,
  contractDerived: ContractMinimumCohortAuthority | undefined,
): boolean {
  return contractDerived === undefined
    ? recorded === undefined
    : recorded?.resource === contractDerived.resource
      && recorded.minimum_cohort_size === contractDerived.minimum_cohort_size;
}

function resourceFor(boundary: ActivatedExplorationBoundary, id: string): BoundaryResource {
  const resource = boundary.pack.resources.find((candidate) => candidate.id === id);
  if (!resource) throw new Error(`Reviewed resource ${id} is no longer active.`);
  return resource;
}

function relationshipResource(root: BoundaryResource, id: string, boundary: ActivatedExplorationBoundary): BoundaryResource {
  const relationship = root.relationships.find((candidate) => candidate.id === id);
  if (!relationship || relationship.cardinality !== "many_to_one" || relationship.max_fan_out !== 1) {
    throw new Error(`Reviewed relationship ${id} is no longer a proven many-to-one path.`);
  }
  return resourceFor(boundary, relationship.target_resource);
}

function protectedFieldName(field: string | undefined, relationship?: string): string {
  if (!field) throw new Error("Protected field is required.");
  return relationship ? `${safeIdentifier(relationship)}.${safeIdentifier(field)}` : safeIdentifier(field);
}

function safeAlias(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const prefixed = /^[a-z_]/.test(normalized) ? normalized : `value_${normalized}`;
  return safeIdentifier(prefixed.slice(0, 64) || "value");
}

function safeIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Unsafe generated identifier: ${value}.`);
  return value;
}

export function assertQualifiedCapabilityName(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error("Invalid protected capability name. Use namespace.name, for example analytics.customers_by_region.");
  }
}

function reviewedText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} must be non-empty, bounded review text.`);
  }
  return normalized;
}

function dslLiteral(value: JsonScalar): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Protected numeric literals must be finite.");
    return String(value);
  }
  if (/[\r\n\u0000-\u001f\u007f]/.test(value)) throw new Error("Protected string literals cannot contain control characters.");
  return `'${escapeDslString(value)}'`;
}

function escapeDslString(value: string): string {
  return value.replace(/'/g, "''");
}

function draftRoot(projectRoot: string, capabilityName: string): string {
  return path.join(projectRoot, PROTECTED_DIR, "drafts", safeCapabilityFileName(capabilityName));
}

function safeCapabilityFileName(capabilityName: string): string {
  assertQualifiedCapabilityName(capabilityName);
  return capabilityName.replace(".", "__");
}

function relativeProjectPath(projectRoot: string, value: string): string {
  return path.relative(projectRoot, value).split(path.sep).join("/");
}

function relativeConfigPath(configRoot: string, value: string): string {
  const relative = path.relative(configRoot, value).split(path.sep).join("/");
  return relative === "." || relative.startsWith("./") || relative.startsWith("../")
    ? relative
    : `./${relative}`;
}

async function writeAtomic(filePath: string, content: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode, flag: "wx" });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readOptionalJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
