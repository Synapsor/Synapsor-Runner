import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  explorationBoundaryCandidateDigest,
  reviewExplorationBoundaryCandidate,
  type ActivatedExplorationBoundary,
  type ExplorationBoundaryDraft,
  type ExplorationDerivedMeasure,
  type ExplorationRelationship,
} from "./auto-boundary.js";
import {
  compileExplorePlan,
  ScopedExploreError,
  validateExploreRequest,
  type AggregateExplorePlan,
  type AggregateMeasureFunction,
  type ExplorePlan,
} from "./scoped-explore.js";

export const READ_WORKLOAD_SET_VERSION = "synapsor.read-workload-set.v1" as const;
export const READ_WORKLOAD_ANALYSIS_VERSION = "synapsor.read-workload-analysis.v1" as const;

export type ReadWorkloadSource = {
  kind: "operator_exact_plan" | "plan_playground" | "model" | "observed_plan" | "existing_capability";
  provider?: "openai" | "anthropic" | "openai_compatible";
  model?: string;
};

export type ReadWorkloadEntry = {
  id: string;
  description: string;
  plan: Record<string, unknown>;
};

export type ReadWorkloadSet = {
  schema_version: typeof READ_WORKLOAD_SET_VERSION;
  name: string;
  allowed: ReadWorkloadEntry[];
  forbidden: ReadWorkloadEntry[];
  source: ReadWorkloadSource;
};

export type ReadAuthorityOperation =
  | "resource"
  | "return"
  | "filter"
  | "sort"
  | "group"
  | "aggregate"
  | "count_distinct"
  | "presence_measure"
  | "time_bucket"
  | "time_window"
  | "relationship"
  | "derived_measure"
  | "numeric_band"
  | "auto_band";

export type ReadAuthorityAtom = {
  id: string;
  root_resource: string;
  resource: string;
  operation: ReadAuthorityOperation;
  field?: string;
  relationship?: string;
  qualifier?: string;
};

export type ReadWorkloadValidation = {
  id: string;
  description: string;
  status: "supported" | "denied" | "blocked";
  normalized_plan_digest?: `sha256:${string}`;
  plan_shape?: Record<string, unknown>;
  authority_atoms: ReadAuthorityAtom[];
  reason?: string;
};

export type ReadWorkloadAnalysis = {
  schema_version: typeof READ_WORKLOAD_ANALYSIS_VERSION;
  workload_digest: `sha256:${string}`;
  workload_name: string;
  status: "ready" | "blocked";
  allowed: ReadWorkloadValidation[];
  forbidden: ReadWorkloadValidation[];
  authority_atoms: ReadAuthorityAtom[];
  candidate?: ExplorationBoundaryDraft;
  candidate_digest?: `sha256:${string}`;
  coverage: {
    allowed_supported: number;
    allowed_total: number;
    forbidden_denied: number;
    forbidden_total: number;
  };
  exposure: {
    generated_resources: number;
    candidate_resources: number;
    generated_fields: number;
    candidate_return_fields: number;
    candidate_operation_fields: number;
    candidate_relationships: number;
  };
  blockers: string[];
  authority_granted: false;
  source_query_executed: false;
  explore_budget_consumed: false;
  source_database_changed: false;
};

export function normalizeReadWorkloadSet(value: unknown): ReadWorkloadSet {
  if (!isRecord(value)) {
    throw new Error("READ_WORKLOAD_OBJECT_REQUIRED: workload input must be one bounded JSON object.");
  }
  rejectUnknownKeys(value, new Set(["schema_version", "name", "allowed", "forbidden", "source"]), "workload");
  if (value.schema_version !== READ_WORKLOAD_SET_VERSION) {
    throw new Error(`READ_WORKLOAD_VERSION_INVALID: expected ${READ_WORKLOAD_SET_VERSION}.`);
  }
  const name = boundedText(value.name, "workload name", 80);
  const allowed = normalizeEntries(value.allowed, "allowed");
  const forbidden = normalizeEntries(value.forbidden, "forbidden");
  if (allowed.length === 0) {
    throw new Error("READ_WORKLOAD_ALLOWED_REQUIRED: include at least one exact allowed Explore plan.");
  }
  const ids = [...allowed, ...forbidden].map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("READ_WORKLOAD_ID_DUPLICATED: workload entry ids must be unique across allowed and forbidden plans.");
  }
  const source = normalizeSource(value.source);
  return {
    schema_version: READ_WORKLOAD_SET_VERSION,
    name,
    allowed,
    forbidden,
    source,
  };
}

export function analyzeReadWorkloadSet(input: {
  workload: unknown;
  generatedBoundary: ExplorationBoundaryDraft;
}): ReadWorkloadAnalysis {
  const workload = normalizeReadWorkloadSet(input.workload);
  const generated = input.generatedBoundary;
  if (generated.activation !== "disabled_unreviewed") {
    throw new Error("READ_WORKLOAD_BOUNDARY_INVALID: workload analysis requires a disabled generated boundary draft.");
  }
  const validationBoundary = activatedFacade(generated);
  const allowed = workload.allowed.map((entry) => validateAllowedEntry(entry, validationBoundary));
  const forbidden = workload.forbidden.map((entry) => validateForbiddenEntry(entry, validationBoundary));
  const blockers = allowed
    .filter((entry) => entry.status !== "supported")
    .map((entry) => `${entry.id}: ${entry.reason ?? "the allowed plan is not supported by generated authority"}`);
  blockers.push(...forbidden
    .filter((entry) => entry.status === "blocked")
    .map((entry) => `${entry.id}: ${entry.reason ?? "the forbidden plan is not a valid exact workload test"}`));
  const atoms = uniqueAtoms(allowed.flatMap((entry) => entry.authority_atoms));
  let candidate: ExplorationBoundaryDraft | undefined;
  let candidateDigest: `sha256:${string}` | undefined;

  if (blockers.length === 0) {
    try {
      const compiled = compileBoundaryCandidate(generated, atoms);
      const candidateBoundary = activatedFacade(compiled);
      for (const entry of workload.allowed) {
        const validated = validateExploreRequest(entry.plan, candidateBoundary);
        compileExplorePlan(validated.plan, candidateBoundary, placeholderContext(), generatedEngine(generated));
      }
      for (const entry of workload.forbidden) {
        try {
          validateExploreRequest(entry.plan, candidateBoundary);
          blockers.push(
            `${entry.id}: forbidden plan is still expressible by the minimum allowed authority; revise the workload because the allowed and forbidden requirements conflict.`,
          );
        } catch (error) {
          if (!(error instanceof ScopedExploreError)) throw error;
        }
      }
      if (blockers.length === 0) {
        candidate = compiled;
        candidateDigest = explorationBoundaryCandidateDigest(compiled);
      }
    } catch (error) {
      blockers.push(`candidate: ${safeError(error)}`);
    }
  }

  const forbiddenResults = forbidden.map((entry) => {
    if (!candidate || entry.status === "blocked") return entry;
    try {
      validateExploreRequest(
        workload.forbidden.find((candidateEntry) => candidateEntry.id === entry.id)!.plan,
        activatedFacade(candidate),
      );
      return {
        ...entry,
        status: "blocked" as const,
        reason: "The candidate boundary still permits this forbidden plan.",
      };
    } catch (error) {
      if (!(error instanceof ScopedExploreError)) throw error;
      return {
        ...entry,
        status: "denied" as const,
        reason: error.message,
      };
    }
  });
  const generatedFields = generated.pack.resources.reduce(
    (sum, resource) => sum + Object.keys(resource.field_types).length,
    0,
  );
  const operationFields = new Set<string>();
  for (const atom of atoms) {
    if (atom.field) operationFields.add(`${atom.resource}.${atom.field}`);
  }
  const analysisCore = {
    schema_version: READ_WORKLOAD_ANALYSIS_VERSION,
    workload_digest: workloadDigest(workload),
    workload_name: workload.name,
    status: blockers.length === 0 ? "ready" as const : "blocked" as const,
    allowed,
    forbidden: forbiddenResults,
    authority_atoms: atoms,
    ...(candidate ? { candidate } : {}),
    ...(candidateDigest ? { candidate_digest: candidateDigest } : {}),
    coverage: {
      allowed_supported: allowed.filter((entry) => entry.status === "supported").length,
      allowed_total: allowed.length,
      forbidden_denied: forbiddenResults.filter((entry) => entry.status === "denied").length,
      forbidden_total: forbiddenResults.length,
    },
    exposure: {
      generated_resources: generated.pack.resources.length,
      candidate_resources: candidate?.pack.resources.length ?? 0,
      generated_fields: generatedFields,
      candidate_return_fields: candidate?.pack.resources.reduce(
        (sum, resource) => sum + resource.selectable_fields.length,
        0,
      ) ?? 0,
      candidate_operation_fields: operationFields.size,
      candidate_relationships: candidate?.pack.resources.reduce(
        (sum, resource) => sum + resource.relationships.length,
        0,
      ) ?? 0,
    },
    blockers,
    authority_granted: false as const,
    source_query_executed: false as const,
    explore_budget_consumed: false as const,
    source_database_changed: false as const,
  };
  return analysisCore;
}

export function extractReadAuthorityAtoms(
  plan: ExplorePlan,
  boundary: ExplorationBoundaryDraft | ActivatedExplorationBoundary,
): ReadAuthorityAtom[] {
  const atoms: Omit<ReadAuthorityAtom, "id">[] = [];
  const root = resourceFor(boundary, plan.resource);
  addAtom(atoms, { root_resource: root.id, resource: root.id, operation: "resource" });
  const related = (relationship: string | undefined) => {
    if (!relationship) return root;
    const reviewed = relationshipFor(root, relationship);
    addAtom(atoms, {
      root_resource: root.id,
      resource: root.id,
      operation: "relationship",
      relationship,
      qualifier: reviewed.target_resource,
    });
    return resourceFor(boundary, reviewed.target_resource);
  };
  const fieldAtom = (input: {
    operation: ReadAuthorityOperation;
    field: string;
    relationship?: string;
    qualifier?: string;
  }) => {
    const resource = related(input.relationship);
    addAtom(atoms, {
      root_resource: root.id,
      resource: resource.id,
      operation: input.operation,
      field: input.field,
      ...(input.relationship ? { relationship: input.relationship } : {}),
      ...(input.qualifier ? { qualifier: input.qualifier } : {}),
    });
  };

  if (plan.kind === "rows") {
    for (const field of plan.select) fieldAtom({ operation: "return", field });
    for (const filter of plan.where ?? []) {
      fieldAtom({ operation: "filter", field: filter.field, relationship: filter.relationship, qualifier: filter.op });
    }
    for (const order of plan.order_by ?? []) fieldAtom({ operation: "sort", field: order.field });
    if (plan.time_window) {
      fieldAtom({ operation: "time_window", field: plan.time_window.field, relationship: plan.time_window.relationship });
    }
    return uniqueAtoms(atoms.map(withAtomId));
  }

  related(plan.relationship);
  for (const filter of plan.where ?? []) {
    fieldAtom({ operation: "filter", field: filter.field, relationship: filter.relationship, qualifier: filter.op });
  }
  for (const dimension of plan.dimensions ?? []) {
    if ("numeric_band" in dimension) {
      if (typeof dimension.numeric_band === "string") {
        addAtom(atoms, {
          root_resource: root.id,
          resource: root.id,
          operation: "numeric_band",
          qualifier: dimension.numeric_band,
        });
      } else {
        fieldAtom({
          operation: "auto_band",
          field: dimension.numeric_band.field,
          qualifier: `${dimension.numeric_band.method}:${dimension.numeric_band.buckets}`,
        });
      }
      continue;
    }
    fieldAtom({ operation: "group", field: dimension.field, relationship: dimension.relationship });
  }
  for (const measure of plan.measures) {
    if ("derived_measure" in measure) {
      addAtom(atoms, {
        root_resource: root.id,
        resource: root.id,
        operation: "derived_measure",
        qualifier: measure.derived_measure,
      });
      continue;
    }
    related(measure.relationship);
    if (measure.function === "count" && !measure.field) continue;
    if (!measure.field) continue;
    const operation = measure.function === "count_distinct"
      ? "count_distinct"
      : measure.function === "null_count"
          || measure.function === "non_null_count"
          || measure.function === "completion_rate"
        ? "presence_measure"
        : "aggregate";
    fieldAtom({
      operation,
      field: measure.field,
      relationship: measure.relationship,
      qualifier: measure.function,
    });
  }
  if (plan.time_bucket) {
    fieldAtom({
      operation: "time_bucket",
      field: plan.time_bucket.field,
      relationship: plan.time_bucket.relationship,
      qualifier: plan.time_bucket.bucket,
    });
  }
  if (plan.time_window) {
    fieldAtom({ operation: "time_window", field: plan.time_window.field, relationship: plan.time_window.relationship });
  }
  if (plan.comparison) {
    fieldAtom({ operation: "time_window", field: plan.comparison.field, relationship: plan.comparison.relationship });
  }
  return uniqueAtoms(atoms.map(withAtomId));
}

export function sanitizeReadWorkloadPlan(plan: ExplorePlan): Record<string, unknown> {
  const sanitized = structuredClone(plan) as unknown as Record<string, unknown>;
  if (Array.isArray(sanitized.where)) {
    sanitized.where = sanitized.where.map((value) => {
      if (!isRecord(value)) return value;
      return {
        ...value,
        value: literalShape(value.value),
      };
    });
  }
  return sanitized;
}

function validateAllowedEntry(
  entry: ReadWorkloadEntry,
  boundary: ActivatedExplorationBoundary,
): ReadWorkloadValidation {
  try {
    assertExactMetadataReferences(entry.plan, boundary);
    const validated = validateExploreRequest(entry.plan, boundary);
    compileExplorePlan(validated.plan, boundary, placeholderContext(), generatedEngine(boundary));
    return {
      id: entry.id,
      description: entry.description,
      status: "supported",
      normalized_plan_digest: canonicalJsonDigest(validated.plan),
      plan_shape: sanitizeReadWorkloadPlan(validated.plan),
      authority_atoms: extractReadAuthorityAtoms(validated.plan, boundary),
    };
  } catch (error) {
    return {
      id: entry.id,
      description: entry.description,
      status: "blocked",
      authority_atoms: [],
      reason: safeError(error),
    };
  }
}

function validateForbiddenEntry(
  entry: ReadWorkloadEntry,
  boundary: ActivatedExplorationBoundary,
): ReadWorkloadValidation {
  try {
    assertExactMetadataReferences(entry.plan, boundary);
    const validated = validateExploreRequest(entry.plan, boundary);
    return {
      id: entry.id,
      description: entry.description,
      status: "supported",
      normalized_plan_digest: canonicalJsonDigest(validated.plan),
      plan_shape: sanitizeReadWorkloadPlan(validated.plan),
      authority_atoms: extractReadAuthorityAtoms(validated.plan, boundary),
      reason: "Generated authority can express this plan; the minimized candidate must refuse it.",
    };
  } catch (error) {
    if (!(error instanceof ScopedExploreError) || error.code === "EXPLORE_PLAN_INVALID") {
      return {
        id: entry.id,
        description: entry.description,
        status: "blocked",
        authority_atoms: [],
        reason: error instanceof ScopedExploreError
          ? `READ_WORKLOAD_FORBIDDEN_PLAN_INVALID: ${error.message}`
          : safeError(error),
      };
    }
    return {
      id: entry.id,
      description: entry.description,
      status: "denied",
      authority_atoms: [],
      reason: error.message,
    };
  }
}

function compileBoundaryCandidate(
  generated: ExplorationBoundaryDraft,
  atoms: ReadAuthorityAtom[],
): ExplorationBoundaryDraft {
  const requiredResources = requiredResourceClosure(generated, atoms);
  const candidate = structuredClone(generated);
  candidate.pack.resources = candidate.pack.resources
    .filter((resource) => requiredResources.has(resource.id))
    .map((resource) => narrowResource(resource, atoms));
  const reviewed = reviewExplorationBoundaryCandidate(generated, candidate);
  return reviewed.candidate;
}

function narrowResource(
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
  atoms: ReadAuthorityAtom[],
): ExplorationBoundaryDraft["pack"]["resources"][number] {
  const local = atoms.filter((atom) => atom.resource === resource.id);
  const rooted = atoms.filter((atom) => atom.root_resource === resource.id);
  const presence = fieldsFor(local, "presence_measure");
  const selected = new Set([...fieldsFor(local, "return"), ...presence]);
  const sortable = fieldsFor(local, "sort");
  const groupable = fieldsFor(local, "group");
  const countDistinct = fieldsFor(local, "count_distinct");
  const aggregateFields = fieldsFor(local, "aggregate");
  const filterable = mapFieldQualifiers(local, "filter");
  const timeBuckets = mapFieldQualifiers(local, "time_bucket");
  const relationshipIds = new Set(
    rooted.filter((atom) => atom.operation === "relationship" && atom.relationship)
      .map((atom) => atom.relationship!),
  );
  const derivedNames = new Set(
    rooted.filter((atom) => atom.operation === "derived_measure" && atom.qualifier)
      .map((atom) => atom.qualifier!),
  );
  const numericBandNames = new Set(
    rooted.filter((atom) => atom.operation === "numeric_band" && atom.qualifier)
      .map((atom) => atom.qualifier!),
  );
  const autoBandRequests = new Map(
    rooted.filter((atom) => atom.operation === "auto_band" && atom.field && atom.qualifier)
      .map((atom) => [atom.field!, atom.qualifier!] as const),
  );
  for (const name of derivedNames) {
    const definition = resource.derived_measures?.find((measure) => measure.name === name);
    if (!definition) continue;
    if ("child_resource" in definition) relationshipIds.add(definition.relationship);
    if ("base_measure" in definition && baseMeasureRelationship(definition.base_measure)) {
      relationshipIds.add(baseMeasureRelationship(definition.base_measure)!);
    }
    if ("numerator" in definition) {
      const numeratorRelationship = baseMeasureRelationship(definition.numerator);
      const denominatorRelationship = baseMeasureRelationship(definition.denominator);
      if (numeratorRelationship) relationshipIds.add(numeratorRelationship);
      if (denominatorRelationship) relationshipIds.add(denominatorRelationship);
    }
  }
  for (const name of numericBandNames) {
    const definition = resource.numeric_bands?.find((band) => band.name === name);
    if (definition?.relationship) relationshipIds.add(definition.relationship);
  }
  const narrowed = structuredClone(resource);
  narrowed.selectable_fields = narrowed.selectable_fields.filter((field) => selected.has(field));
  narrowed.sortable_fields = narrowed.sortable_fields.filter((field) => sortable.has(field));
  narrowed.groupable_fields = narrowed.groupable_fields.filter((field) => groupable.has(field));
  narrowed.aggregate_measures = narrowed.aggregate_measures.filter((field) => aggregateFields.has(field));
  narrowed.aggregate_measure_functions = Object.fromEntries(
    Object.entries(narrowed.aggregate_measure_functions ?? {})
      .flatMap(([field, functions]) => {
        const requested = new Set(
          local.filter((atom) => atom.operation === "aggregate" && atom.field === field && atom.qualifier)
            .map((atom) => atom.qualifier!),
        );
        const retained = functions.filter((name) => requested.has(name));
        return retained.length ? [[field, retained]] : [];
      }),
  );
  if (!Object.keys(narrowed.aggregate_measure_functions).length) {
    delete narrowed.aggregate_measure_functions;
  }
  narrowed.presence_measure_fields = (narrowed.presence_measure_fields ?? [])
    .filter((field) => presence.has(field));
  if (!narrowed.presence_measure_fields.length) delete narrowed.presence_measure_fields;
  narrowed.count_distinct_fields = narrowed.count_distinct_fields.filter((field) => countDistinct.has(field));
  narrowed.filterable_fields = Object.fromEntries(
    Object.entries(narrowed.filterable_fields).flatMap(([field, operators]) => {
      const requested = filterable.get(field);
      if (!requested) return [];
      const retained = operators.filter((operator) => requested.has(operator));
      return retained.length ? [[field, retained]] : [];
    }),
  );
  const timeWindowFields = fieldsFor(local, "time_window");
  narrowed.time_bucket_fields = Object.fromEntries(
    Object.entries(narrowed.time_bucket_fields).flatMap(([field, buckets]) => {
      const requested = timeBuckets.get(field);
      if (!requested) return timeWindowFields.has(field) ? [[field, []]] : [];
      const retained = buckets.filter((bucket) => requested.has(bucket));
      return retained.length || timeWindowFields.has(field) ? [[field, retained]] : [];
    }),
  );
  narrowed.relationships = narrowed.relationships.filter((relationship) => relationshipIds.has(relationship.id));
  narrowed.derived_measures = (narrowed.derived_measures ?? [])
    .filter((measure) => derivedNames.has(measure.name));
  if (!narrowed.derived_measures.length) delete narrowed.derived_measures;
  narrowed.numeric_bands = (narrowed.numeric_bands ?? [])
    .filter((band) => numericBandNames.has(band.name));
  if (!narrowed.numeric_bands.length) delete narrowed.numeric_bands;
  narrowed.auto_bands = (narrowed.auto_bands ?? []).flatMap((policy) => {
    const request = autoBandRequests.get(policy.field);
    if (!request) return [];
    const [method, bucketsText] = request.split(":");
    const buckets = Number(bucketsText);
    return [{
      ...policy,
      methods: policy.methods.filter((candidate) => candidate === method),
      min_buckets: Math.max(policy.min_buckets, buckets),
      max_buckets: Math.min(policy.max_buckets, buckets),
    }];
  });
  if (!narrowed.auto_bands.length) delete narrowed.auto_bands;
  const enumFields = new Set([
    ...groupable,
    ...filterable.keys(),
  ]);
  narrowed.field_enums = Object.fromEntries(
    Object.entries(narrowed.field_enums).filter(([field]) => enumFields.has(field)),
  );
  return narrowed;
}

function requiredResourceClosure(
  boundary: ExplorationBoundaryDraft,
  atoms: ReadAuthorityAtom[],
): Set<string> {
  const required = new Set(atoms.flatMap((atom) => [atom.root_resource, atom.resource]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...required]) {
      const resource = resourceFor(boundary, id);
      for (const path of [resource.tenant_scope, resource.principal_scope]) {
        for (const link of path?.proof.links ?? []) {
          for (const linked of [link.source_resource, link.target_resource]) {
            if (!required.has(linked)) {
              required.add(linked);
              changed = true;
            }
          }
        }
      }
      for (const atom of atoms.filter((candidate) => candidate.root_resource === id)) {
        if (atom.operation === "relationship" && atom.relationship) {
          const relationship = relationshipFor(resource, atom.relationship);
          for (const linked of relationshipResources(relationship)) {
            if (!required.has(linked)) {
              required.add(linked);
              changed = true;
            }
          }
        }
        if (atom.operation === "derived_measure" && atom.qualifier) {
          const measure = resource.derived_measures?.find((candidate) => candidate.name === atom.qualifier);
          if (measure && "child_resource" in measure && !required.has(measure.child_resource)) {
            required.add(measure.child_resource);
            changed = true;
          }
          for (const relationshipId of derivedMeasureRelationships(measure)) {
            for (const linked of relationshipResources(relationshipFor(resource, relationshipId))) {
              if (!required.has(linked)) {
                required.add(linked);
                changed = true;
              }
            }
          }
        }
        if (atom.operation === "numeric_band" && atom.qualifier) {
          const band = resource.numeric_bands?.find((candidate) => candidate.name === atom.qualifier);
          if (band?.relationship) {
            for (const linked of relationshipResources(relationshipFor(resource, band.relationship))) {
              if (!required.has(linked)) {
                required.add(linked);
                changed = true;
              }
            }
          }
        }
      }
    }
  }
  return required;
}

function relationshipResources(relationship: ExplorationRelationship): string[] {
  return [...new Set([
    relationship.target_resource,
    ...(relationship.proof?.links ?? []).flatMap((link) => [link.source_resource, link.target_resource]),
  ])];
}

function derivedMeasureRelationships(
  measure: ExplorationDerivedMeasure | undefined,
): string[] {
  if (!measure) return [];
  if ("child_resource" in measure) return [measure.relationship];
  if ("base_measure" in measure) {
    const relationship = baseMeasureRelationship(measure.base_measure);
    return relationship ? [relationship] : [];
  }
  return [baseMeasureRelationship(measure.numerator), baseMeasureRelationship(measure.denominator)]
    .filter((value): value is string => Boolean(value));
}

function baseMeasureRelationship(
  measure: { function: "count" } | { relationship?: string },
): string | undefined {
  return "relationship" in measure ? measure.relationship : undefined;
}

function assertExactMetadataReferences(
  plan: Record<string, unknown>,
  boundary: ActivatedExplorationBoundary,
): void {
  if (typeof plan.resource !== "string") return;
  const root = resourceFor(boundary, plan.resource);
  const references: Array<{ field?: unknown; relationship?: unknown }> = [];
  for (const value of Array.isArray(plan.select) ? plan.select : []) references.push({ field: value });
  for (const value of Array.isArray(plan.where) ? plan.where : []) if (isRecord(value)) references.push(value);
  for (const value of Array.isArray(plan.order_by) ? plan.order_by : []) if (isRecord(value)) references.push(value);
  for (const value of Array.isArray(plan.measures) ? plan.measures : []) if (isRecord(value)) references.push(value);
  for (const value of Array.isArray(plan.dimensions) ? plan.dimensions : []) if (isRecord(value)) references.push(value);
  for (const key of ["time_bucket", "time_window", "comparison"] as const) {
    if (isRecord(plan[key])) references.push(plan[key]);
  }
  if (typeof plan.relationship === "string") relationshipFor(root, plan.relationship);
  for (const reference of references) {
    const target = typeof reference.relationship === "string"
      ? resourceFor(boundary, relationshipFor(root, reference.relationship).target_resource)
      : root;
    if (reference.field !== undefined
      && (typeof reference.field !== "string" || !Object.hasOwn(target.field_types, reference.field))) {
      throw new Error(
        `READ_WORKLOAD_FIELD_UNKNOWN: ${String(reference.field)} is not an exact field on ${target.id}.`,
      );
    }
  }
}

function activatedFacade(draft: ExplorationBoundaryDraft): ActivatedExplorationBoundary {
  const { unresolved_decisions: _unresolved, ...rest } = structuredClone(draft);
  return {
    ...rest,
    activation: {
      state: "active",
      digest: explorationBoundaryCandidateDigest(draft),
      actor: "workload-compile-only",
      activated_at: "1970-01-01T00:00:00.000Z",
      generation_lock_fingerprint: draft.generation_lock_fingerprint,
      reviewed_decisions: [],
    },
  };
}

function workloadDigest(workload: ReadWorkloadSet): `sha256:${string}` {
  return canonicalJsonDigest({
    schema_version: READ_WORKLOAD_SET_VERSION,
    name: workload.name,
    allowed: workload.allowed.map((entry) => ({
      id: entry.id,
      description: entry.description,
      plan_digest: canonicalJsonDigest(entry.plan),
    })),
    forbidden: workload.forbidden.map((entry) => ({
      id: entry.id,
      description: entry.description,
      plan_digest: canonicalJsonDigest(entry.plan),
    })),
    source: workload.source,
  });
}

function normalizeEntries(value: unknown, label: "allowed" | "forbidden"): ReadWorkloadEntry[] {
  if (!Array.isArray(value) || value.length > 40) {
    throw new Error(`READ_WORKLOAD_ENTRIES_INVALID: ${label} must be an array with at most 40 entries.`);
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`READ_WORKLOAD_ENTRY_INVALID: ${label}[${index}] must be an object.`);
    rejectUnknownKeys(entry, new Set(["id", "description", "plan"]), `${label}[${index}]`);
    if (typeof entry.id !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(entry.id)) {
      throw new Error(`READ_WORKLOAD_ID_INVALID: ${label}[${index}].id must be one stable lower-case id.`);
    }
    if (!isRecord(entry.plan)) throw new Error(`READ_WORKLOAD_PLAN_INVALID: ${label}[${index}].plan must be an Explore plan object.`);
    if (Buffer.byteLength(JSON.stringify(entry.plan)) > 64 * 1024) {
      throw new Error(`READ_WORKLOAD_PLAN_TOO_LARGE: ${entry.id} exceeds 64 KiB.`);
    }
    return {
      id: entry.id,
      description: boundedText(entry.description, `${entry.id} description`, 280),
      plan: structuredClone(entry.plan),
    };
  });
}

function normalizeSource(value: unknown): ReadWorkloadSource {
  if (!isRecord(value)) throw new Error("READ_WORKLOAD_SOURCE_REQUIRED: source metadata is required.");
  rejectUnknownKeys(value, new Set(["kind", "provider", "model"]), "source");
  const kind = value.kind;
  if (kind !== "operator_exact_plan"
    && kind !== "plan_playground"
    && kind !== "model"
    && kind !== "observed_plan"
    && kind !== "existing_capability") {
    throw new Error("READ_WORKLOAD_SOURCE_INVALID: unsupported workload source.");
  }
  const provider = value.provider;
  if (provider !== undefined && provider !== "openai" && provider !== "anthropic" && provider !== "openai_compatible") {
    throw new Error("READ_WORKLOAD_PROVIDER_INVALID: provider must be openai, anthropic, or openai_compatible.");
  }
  const model = value.model === undefined ? undefined : boundedText(value.model, "model", 128);
  if (kind === "model" && (!provider || !model)) {
    throw new Error("READ_WORKLOAD_MODEL_IDENTITY_REQUIRED: model workloads must name provider and model.");
  }
  if (kind !== "model" && (provider || model)) {
    throw new Error("READ_WORKLOAD_MODEL_IDENTITY_FORBIDDEN: only model workloads may name provider or model.");
  }
  return {
    kind,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}

function fieldsFor(atoms: ReadAuthorityAtom[], operation: ReadAuthorityOperation): Set<string> {
  return new Set(atoms.filter((atom) => atom.operation === operation && atom.field).map((atom) => atom.field!));
}

function mapFieldQualifiers(
  atoms: ReadAuthorityAtom[],
  operation: ReadAuthorityOperation,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const atom of atoms) {
    if (atom.operation !== operation || !atom.field || !atom.qualifier) continue;
    const values = result.get(atom.field) ?? new Set<string>();
    values.add(atom.qualifier);
    result.set(atom.field, values);
  }
  return result;
}

function resourceFor(
  boundary: Pick<ExplorationBoundaryDraft, "pack">,
  id: string,
): ExplorationBoundaryDraft["pack"]["resources"][number] {
  const resource = boundary.pack.resources.find((candidate) => candidate.id === id);
  if (!resource) throw new Error(`READ_WORKLOAD_RESOURCE_UNKNOWN: ${id} is not an exact generated resource id.`);
  return resource;
}

function relationshipFor(
  root: ExplorationBoundaryDraft["pack"]["resources"][number],
  id: string,
): ExplorationRelationship {
  const relationship = root.relationships.find((candidate) => candidate.id === id);
  if (!relationship) {
    throw new Error(`READ_WORKLOAD_RELATIONSHIP_UNKNOWN: ${id} is not an exact generated relationship on ${root.id}.`);
  }
  return relationship;
}

function addAtom(
  atoms: Omit<ReadAuthorityAtom, "id">[],
  atom: Omit<ReadAuthorityAtom, "id">,
): void {
  atoms.push(atom);
}

function withAtomId(atom: Omit<ReadAuthorityAtom, "id">): ReadAuthorityAtom {
  const suffix = [atom.operation, atom.field, atom.relationship, atom.qualifier].filter(Boolean).join(":");
  return { id: `${atom.root_resource}:${atom.resource}:${suffix}`, ...atom };
}

function uniqueAtoms(atoms: ReadAuthorityAtom[]): ReadAuthorityAtom[] {
  return [...new Map(atoms.map((atom) => [atom.id, atom])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
}

function literalShape(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return {
      redacted: true,
      kind: "list",
      count: value.length,
      element_types: [...new Set(value.map(scalarType))].sort(),
    };
  }
  return { redacted: true, kind: "scalar", type: scalarType(value) };
}

function scalarType(value: unknown): string {
  if (value === null) return "null";
  return typeof value;
}

function generatedEngine(
  boundary: Pick<ExplorationBoundaryDraft, "source" | "database_server_authority">,
): "postgres" | "mysql" {
  return boundary.database_server_authority?.engine
    ?? (boundary.source.toLowerCase().includes("mysql") ? "mysql" : "postgres");
}

function placeholderContext(): { tenant: string; principal: string } {
  return {
    tenant: "__synapsor_trusted_tenant_placeholder__",
    principal: "__synapsor_trusted_principal_placeholder__",
  };
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`READ_WORKLOAD_KEY_UNKNOWN: ${label} contains unsupported keys: ${unknown.join(", ")}.`);
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`READ_WORKLOAD_TEXT_INVALID: ${label} must be text.`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`READ_WORKLOAD_TEXT_INVALID: ${label} must be 1 through ${maximum} safe characters.`);
  }
  if (/(?:postgres|mysql):\/\/|BEGIN [A-Z ]*PRIVATE KEY|bearer\s+[A-Za-z0-9._-]+/i.test(normalized)) {
    throw new Error(`READ_WORKLOAD_SECRET_BLOCKED: ${label} appears to contain secret material.`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
