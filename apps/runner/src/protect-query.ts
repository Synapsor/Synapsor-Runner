import fs from "node:fs/promises";
import path from "node:path";
import { compileAgentDsl, formatAgentDsl } from "@synapsor/dsl";
import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { JsonScalar, SynapsorContract } from "@synapsor/spec";
import {
  loadActivatedExplorationBoundary,
  type ActivatedExplorationBoundary,
  type GenerationLock,
} from "./auto-boundary.js";
import {
  listProtectedPlans,
  loadProtectedPlan,
  prepareScopedExplore,
  validateExplorePlan,
  type AggregateExplorePlan,
  type ExploreFilter,
  type ExplorePlan,
} from "./scoped-explore.js";

const PROTECTED_QUERY_VERSION = "synapsor.protected-query.v1";
const PROTECTED_DIR = "synapsor/protected";

type BoundaryResource = ActivatedExplorationBoundary["pack"]["resources"][number];
type ProtectedRelationshipPlan = {
  name: string;
  localKey: string;
  targetKey: string;
  target: BoundaryResource;
};

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
};

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
}>> {
  const projectRoot = path.resolve(input.projectRoot);
  const boundary = await loadActivatedExplorationBoundary(projectRoot);
  const items = await listProtectedPlans({ projectRoot, ...(input.now === undefined ? {} : { now: input.now }) });
  return items
    .filter((item) => item.boundary_digest === boundary.activation.digest)
    .map((item) => {
      const plan = validateExplorePlan(item.plan, boundary);
      return {
        token: item.token,
        expires_at: item.expires_at,
        boundary_digest: item.boundary_digest,
        kind: plan.kind,
        resource: plan.resource,
        normalized_plan: plan,
        literal_positions: protectLiteralPositions(plan, boundary),
      };
    });
}

export async function createProtectedQueryDraft(input: {
  projectRoot: string;
  token: string;
  capabilityName: string;
  description: string;
  returnsHint: string;
  arguments?: ProtectArgumentSelection[];
  now?: number;
}): Promise<{ draft: ProtectedQueryDraft; dsl: string; contract: SynapsorContract; tests: Record<string, unknown> }> {
  const projectRoot = path.resolve(input.projectRoot);
  assertQualifiedCapabilityName(input.capabilityName);
  const description = reviewedText(input.description, "description", 500);
  const returnsHint = reviewedText(input.returnsHint, "returns hint", 500);
  const boundary = await loadActivatedExplorationBoundary(projectRoot);
  const protectedPlan = await loadProtectedPlan({ projectRoot, token: input.token, ...(input.now === undefined ? {} : { now: input.now }) });
  if (protectedPlan.boundary_digest !== boundary.activation.digest) throw new Error("Protect token belongs to a different or superseded exploration boundary.");
  const plan = validateExplorePlan(protectedPlan.plan, boundary);
  const positions = protectLiteralPositions(plan, boundary);
  const selections = validateArgumentSelections(input.arguments ?? [], positions);
  const dsl = emitProtectedQueryDsl({
    capabilityName: input.capabilityName,
    description,
    returnsHint,
    plan,
    boundary,
    positions,
    selections,
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
  const tests = protectedQueryTests(input.capabilityName, plan, capability.protected_read.boundary_digest);
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
  confirmation: string;
  actor: string;
  configPath?: string;
  disableExplore?: boolean;
  env?: NodeJS.ProcessEnv;
  prepareScopedExploreFn?: typeof prepareScopedExplore;
}): Promise<ProtectedQueryActivation> {
  const projectRoot = path.resolve(input.projectRoot);
  assertQualifiedCapabilityName(input.capabilityName);
  const actor = reviewedText(input.actor, "actor", 128);
  const outputRoot = draftRoot(projectRoot, input.capabilityName);
  const draft = JSON.parse(await fs.readFile(path.join(outputRoot, "draft.json"), "utf8")) as ProtectedQueryDraft;
  const contract = JSON.parse(await fs.readFile(path.join(outputRoot, "synapsor.contract.json"), "utf8")) as SynapsorContract;
  const digest = canonicalJsonDigest(contract);
  if (draft.state !== "disabled" || draft.contract_digest !== digest || input.expectedDigest !== digest) {
    throw new Error("Protected capability changed after review; reload and review the exact draft.");
  }
  if (input.confirmation !== `ACTIVATE ${digest}`) throw new Error(`Activation requires the exact confirmation ACTIVATE ${digest}.`);
  const prepared = await (input.prepareScopedExploreFn ?? prepareScopedExplore)({
    projectRoot,
    transport: "loopback_workbench",
    env: input.env ?? process.env,
  });
  if (prepared.boundary.activation.digest !== draft.boundary_digest
    || prepared.boundary.generation_lock_fingerprint !== draft.generation_lock_fingerprint) {
    throw new Error("Protected capability is not bound to the current reviewed boundary and generation lock.");
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
  });
  const explorationDisabled = input.disableExplore !== false;
  if (explorationDisabled) {
    await fs.rm(path.join(projectRoot, ".synapsor/exploration-boundary.active.json"), { force: true });
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
  };
  await writeAtomic(path.join(activeRoot, `${safeCapabilityFileName(input.capabilityName)}.activation.json`), json(activation), 0o600);
  return activation;
}

export async function disableScopedExplore(projectRoot: string): Promise<{ disabled: boolean }> {
  const activePath = path.join(path.resolve(projectRoot), ".synapsor/exploration-boundary.active.json");
  try {
    await fs.rm(activePath);
    return { disabled: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { disabled: false };
    throw error;
  }
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
}): string {
  const root = resourceFor(input.boundary, input.plan.resource);
  const relationship = relationshipForPlan(input.plan, root, input.boundary);
  const lines = [
    "CREATE AGENT CONTEXT protected_operator",
    `  BIND tenant_id FROM ENVIRONMENT ${input.boundary.trusted_context.tenant_env} REQUIRED`,
    `  BIND principal FROM ENVIRONMENT ${input.boundary.trusted_context.principal_env} REQUIRED`,
    "  TENANT BINDING tenant_id",
    "  PRINCIPAL BINDING principal",
    "END",
    "",
    `CREATE CAPABILITY ${input.capabilityName}`,
    `  DESCRIPTION '${escapeDslString(input.description)}'`,
    `  RETURNS HINT '${escapeDslString(input.returnsHint)}'`,
    "  USING CONTEXT protected_operator",
    `  SOURCE ${safeIdentifier(input.boundary.source)}`,
    `  ON ${safeIdentifier(root.schema)}.${safeIdentifier(root.table)}`,
    `  PRIMARY KEY ${safeIdentifier(root.primary_key)}`,
    `  TENANT KEY ${safeIdentifier(root.tenant_key)}`,
    ...(root.principal_key ? [`  PRINCIPAL SCOPE KEY ${safeIdentifier(root.principal_key)}`] : []),
    ...argumentDsl(input.positions, input.selections),
    `  PROTECTED READ ${input.plan.kind === "rows" ? "ROWS" : "AGGREGATE"}`,
    `  BOUNDARY DIGEST ${input.boundary.activation.digest}`,
    `  GENERATION LOCK ${input.boundary.generation_lock_fingerprint}`,
    ...(relationship ? [relationshipDsl(relationship)] : []),
    ...predicateDsl(input.plan.where ?? [], input.selections),
  ];
  if (input.plan.kind === "rows") {
    lines.push(
      `  ALLOW READ ${input.plan.select.map(safeIdentifier).join(", ")}`,
      ...(input.plan.order_by ?? []).map((order) => `  ROW ORDER BY ${safeIdentifier(order.field)} ${order.direction.toUpperCase()}`),
    );
  } else {
    lines.push(...aggregateDsl(input.plan, input.selections, root.minimum_cohort_size));
  }
  if (root.kept_out_fields.length) lines.push(`  KEEP OUT ${root.kept_out_fields.map(safeIdentifier).join(", ")}`);
  lines.push(
    "  REQUIRE EVIDENCE",
    protectedLimitsDsl(input.plan, input.boundary),
    "END",
  );
  return `${formatAgentDsl(lines.join("\n"))}\n`;
}

function aggregateDsl(plan: AggregateExplorePlan, selections: Map<string, ProtectArgumentSelection>, minimumGroupSize: number): string[] {
  const aliases = aggregateAliases(plan);
  const lines = plan.measures.map((measure, index) => {
    if (measure.function === "count") return `  MEASURE ${aliases.measures[index]} COUNT ROWS`;
    const target = protectedFieldName(measure.field, measure.relationship);
    if (measure.function === "count_distinct") return `  MEASURE ${aliases.measures[index]} COUNT DISTINCT ${target}`;
    return `  MEASURE ${aliases.measures[index]} ${measure.function.toUpperCase()} ${target}`;
  });
  for (const [index, dimension] of (plan.dimensions ?? []).entries()) {
    lines.push(`  GROUP DIMENSION ${aliases.dimensions[index]} BY ${protectedFieldName(dimension.field, dimension.relationship)}`);
  }
  if (plan.time_bucket) {
    lines.push(`  TIME DIMENSION ${aliases.timeBucket} BY ${plan.time_bucket.bucket.toUpperCase()} OF ${protectedFieldName(plan.time_bucket.field, plan.time_bucket.relationship)}`);
  }
  for (const [index, range] of (plan.comparison?.ranges ?? []).entries()) {
    lines.push(`  COMPARE RANGE ${protectedFieldName(plan.comparison!.field, plan.comparison!.relationship)} FROM ${valueDsl(range.start, selections.get(`comparison.ranges.${index}.start`))} TO ${valueDsl(range.end, selections.get(`comparison.ranges.${index}.end`))}`);
  }
  if (plan.order_by?.kind === "measure") {
    lines.push(`  AGGREGATE ORDER BY MEASURE ${aliases.measures[plan.order_by.index]} ${plan.order_by.direction.toUpperCase()}`);
  } else if (plan.order_by?.kind === "time_bucket") {
    lines.push(`  AGGREGATE ORDER BY TIME BUCKET ${plan.order_by.direction.toUpperCase()}`);
  }
  lines.push(`  TOP ${plan.top_n} GROUPS`);
  lines.push(`  MIN GROUP SIZE ${minimumGroupSize}`);
  return lines;
}

function protectedLimitsDsl(plan: ExplorePlan, boundary: ActivatedExplorationBoundary): string {
  const budgets = boundary.budgets;
  const rows = plan.kind === "rows" ? plan.limit : budgets.max_rows;
  return `  PROTECTED LIMITS ROWS ${rows} GROUPS ${budgets.max_groups} CELLS ${budgets.max_response_cells} BYTES ${budgets.max_response_bytes} TIMEOUT MS ${budgets.statement_timeout_ms} QUERIES ${budgets.max_queries_per_session} EXTRACTED CELLS ${budgets.max_extracted_cells_per_session} DIFFERENCING ${budgets.max_differencing_queries} RATE PER MINUTE ${budgets.rate_limit_per_minute}`;
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

function relationshipForPlan(
  plan: ExplorePlan,
  root: BoundaryResource,
  boundary: ActivatedExplorationBoundary,
): ProtectedRelationshipPlan | undefined {
  const names = new Set<string>();
  if (plan.kind === "aggregate" && plan.relationship) names.add(plan.relationship);
  for (const filter of plan.where ?? []) if (filter.relationship) names.add(filter.relationship);
  if (plan.kind === "aggregate") {
    for (const measure of plan.measures) if (measure.relationship) names.add(measure.relationship);
    for (const dimension of plan.dimensions ?? []) if (dimension.relationship) names.add(dimension.relationship);
    if (plan.time_bucket?.relationship) names.add(plan.time_bucket.relationship);
    if (plan.comparison?.relationship) names.add(plan.comparison.relationship);
  }
  if (names.size === 0) return undefined;
  if (names.size !== 1) throw new Error("Protect conversion permits at most one reviewed relationship.");
  const name = [...names][0]!;
  const relationship = root.relationships.find((candidate) => candidate.id === name);
  if (!relationship || relationship.cardinality !== "many_to_one" || relationship.max_fan_out !== 1
    || relationship.local_columns.length !== 1 || relationship.target_columns.length !== 1) {
    throw new Error("Protect conversion requires one cardinality-proven many-to-one relationship.");
  }
  const target = resourceFor(boundary, relationship.target_resource);
  return {
    name,
    localKey: relationship.local_columns[0]!,
    targetKey: relationship.target_columns[0]!,
    target,
  };
}

function relationshipDsl(relationship: ProtectedRelationshipPlan): string {
  return `  PROTECTED RELATIONSHIP ${safeIdentifier(relationship.name)} ON ${safeIdentifier(relationship.localKey)} REFERENCES ${safeIdentifier(relationship.target.schema)}.${safeIdentifier(relationship.target.table)}.${safeIdentifier(relationship.targetKey)} PRIMARY KEY ${safeIdentifier(relationship.target.primary_key)} TENANT KEY ${safeIdentifier(relationship.target.tenant_key)}${relationship.target.principal_key ? ` PRINCIPAL SCOPE KEY ${safeIdentifier(relationship.target.principal_key)}` : ""}`;
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
    measures: plan.measures.map((measure) => uniqueAlias(measure.function === "count"
      ? "row_count"
      : `${measure.function}_${measure.relationship ? `${measure.relationship}_` : ""}${measure.field}`)),
    dimensions: (plan.dimensions ?? []).map((dimension) => uniqueAlias(`${dimension.relationship ? `${dimension.relationship}_` : ""}${dimension.field}`)),
    timeBucket: uniqueAlias(`${plan.time_bucket?.relationship ? `${plan.time_bucket.relationship}_` : ""}${plan.time_bucket?.field ?? "time"}_${plan.time_bucket?.bucket ?? "bucket"}`),
  };
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

function protectedQueryTests(capability: string, plan: ExplorePlan, boundaryDigest: string): Record<string, unknown> {
  const aggregate = plan.kind === "aggregate";
  return {
    schema_version: "synapsor.contract-tests.v1",
    capability,
    boundary_digest: boundaryDigest,
    tests: [
      { name: "positive reviewed shape", kind: "positive", expected: aggregate ? "bounded_suppressed_groups" : "bounded_rows" },
      { name: "trusted tenant required", kind: "scope", expected: "deny_without_trusted_tenant" },
      { name: "trusted principal required", kind: "scope", expected: "deny_without_trusted_principal" },
      { name: "model scope override denied", kind: "deny", expected: "tenant_and_principal_absent_from_args" },
      { name: "kept-out field denied", kind: "redaction", expected: "unavailable_for_all_operations" },
      { name: "generation lock current", kind: "drift", expected: "exact_lock_digest" },
      { name: "response boundary", kind: "boundary", expected: "fail_closed_above_reviewed_limits" },
      ...(aggregate ? [
        { name: "small cohort suppressed", kind: "suppression", expected: "no_group_values" },
        { name: "differencing budget", kind: "privacy", expected: "fail_closed_after_budget" },
        { name: "unreviewed join denied", kind: "join", expected: "no_general_join_planner" },
      ] : []),
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
  lock: GenerationLock;
  databaseScope?: {
    mode: "postgres_rls";
    tenant_setting: string;
    principal_setting?: string;
  };
  statementTimeoutMs: number;
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
      || config.generated_authority.enforcement !== "required") {
      throw new Error("Existing generated_authority does not match this project's reviewed generation lock.");
    }
  } else {
    config.generated_authority = {
      generation_lock_path: generationLockPath,
      enforcement: "required",
    };
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
        && JSON.stringify(existingSource.database_scope ?? null) !== JSON.stringify(input.databaseScope))) {
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

function protectedDatabaseScope(
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
  const resources = [
    boundary.pack.resources.find((resource) => resource.schema === rootSchema && resource.table === rootTable),
    ...(capability.protected_read?.relationship
      ? [boundary.pack.resources.find((resource) =>
        resource.schema === capability.protected_read!.relationship!.schema
        && resource.table === capability.protected_read!.relationship!.table)]
      : []),
  ];
  if (resources.some((resource) => !resource)) {
    throw new Error("Protected capability references a resource outside the activated exploration boundary.");
  }
  const scopes = resources
    .map((resource) => resource!.rls_session)
    .filter((scope): scope is NonNullable<typeof scope> => scope !== undefined);
  if (scopes.length === 0) return undefined;
  if (scopes.length !== resources.length
    || scopes.some((scope) => !scope.tenant_setting)) {
    throw new Error("Protected capability cannot preserve the reviewed PostgreSQL RLS session bindings for every participating relation.");
  }
  const principalSettings = new Set(scopes.flatMap((scope) => scope.principal_setting ? [scope.principal_setting] : []));
  const requiresPrincipal = principalSettings.size > 0 || Boolean(
    capability.subject.principal_scope_key
    || capability.protected_read?.relationship?.principal_scope_key,
  );
  if (requiresPrincipal && scopes.some((scope) => !scope.principal_setting)) {
    throw new Error("Protected capability declares principal scope but its reviewed PostgreSQL RLS session binding is incomplete.");
  }
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
  return `# Protected Query Review

State: **DISABLED**

Capability: \`${draft.capability}\`

Contract digest: \`${draft.contract_digest}\`

Boundary digest: \`${draft.boundary_digest}\`

Generation lock: \`${draft.generation_lock_fingerprint}\`

This draft freezes one successful ${plan.kind === "aggregate" ? "privacy-suppressed aggregate" : "bounded row"} exploration plan. It cannot be called until a local operator reviews the generated DSL, tests, arguments, trusted scope, and exact digest in the secured Workbench.

Activation must use:

\`ACTIVATE ${draft.contract_digest}\`

Approval, activation, and commit authority are not exposed through MCP.
`;
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

function assertQualifiedCapabilityName(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error("Protected capability name must be namespace.name.");
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
  return relative.startsWith(".") ? relative : `./${relative}`;
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
