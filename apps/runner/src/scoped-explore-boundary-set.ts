import path from "node:path";
import { assertRuntimeControlPolicyContinuity, borrowRuntimeControlPolicies, createProjectRuntimeStore, type BoundProjectPolicyStore } from "./control-policy-store.js";
import { projectRuntimeOperations, withProjectRuntimeAdmission } from "./project-runtime-admission.js";
import {
  type ExploreBudgetLimits,
  type ProposalRuntimeStore,
} from "@synapsor-runner/proposal-store";
import {
  projectAuthorityMetadataForModel,
  type ModelAuthorityMetadataMode,
  type SubjectReferenceService,
  type RuntimeConfig,
} from "@synapsor-runner/mcp-server";
import {
  activatedExplorationBoundarySetDigest,
  loadActivatedExplorationBoundaries,
  type ActivatedExplorationBoundary,
} from "./auto-boundary.js";
import {
  createScopedExploreRuntime,
  projectScopedExploreResultForModel,
  SCOPED_EXPLORE_QUERY_TOOL,
  scopedExploreBoundaryLoadError,
  ScopedExploreError,
  type ExplorePlan,
  type InspectDatabaseFn,
  type ResolveExploreTrustedScopeFn,
  type ScopedExploreExecutor,
  type ScopedExploreRuntime,
  type ScopedExploreValidationResult,
  type ScopedExploreMode,
  type ScopedExploreTransport,
} from "./scoped-explore.js";
import type { ExploreHttpSessionContext } from "./explore-trusted-scope.js";
import {
  RELATIVE_TIME_COMPARISONS,
  RELATIVE_TIME_WINDOWS,
} from "./relative-time-window.js";
import { runAllCleanups } from "./resource-lifecycle.js";

export type BoundarySetDescribeInput = {
  boundary?: string;
  resource?: string;
  cursor?: number;
  limit?: number;
  include_time_coverage?: boolean;
};

export type ScopedExploreBoundarySetRuntime = {
  boundary: ActivatedExplorationBoundary;
  boundaries: ActivatedExplorationBoundary[];
  active_boundary_set_digest: `sha256:${string}`;
  session_fingerprint: `sha256:${string}`;
  model_authority_metadata?: ModelAuthorityMetadataMode;
  trusted_scope?: ScopedExploreRuntime["trusted_scope"];
  requireTrustedScope?(): Promise<void>;
  supportsSubjectReferences?(resource: string, boundary?: string): Promise<boolean>;
  withOperation?: ScopedExploreRuntime["withOperation"];
  authorizedCatalogBoundaries?(): Promise<ActivatedExplorationBoundary[]>;
  describe(input?: BoundarySetDescribeInput): Promise<Record<string, unknown>>;
  validate(plan: unknown, boundaryName?: string): Promise<ScopedExploreValidationResult & {
    active_boundary_set_digest: `sha256:${string}`;
  }>;
  explore(plan: unknown, boundaryName?: string): Promise<Record<string, unknown>>;
  projectResultForModel(input: {
    tool: string;
    arguments: Record<string, unknown>;
    result: Record<string, unknown>;
  }): {
    value: Record<string, unknown>;
    withheld: boolean;
    operator_metadata_withheld?: boolean;
  };
  close(): Promise<void>;
};

type Child = {
  digest: `sha256:${string}`;
  runtime: ScopedExploreRuntime;
};

export type ActiveExploreTarget = {
  boundary: ActivatedExplorationBoundary;
  resource?: ActivatedExplorationBoundary["pack"]["resources"][number];
};

export async function createScopedExploreBoundarySetRuntime(input: {
  projectRoot: string;
  transport: ScopedExploreTransport;
  mode?: ScopedExploreMode;
  env?: NodeJS.ProcessEnv;
  executor?: ScopedExploreExecutor;
  store?: ProposalRuntimeStore;
  sessionContext?: ExploreHttpSessionContext;
  productionPrivacyHmacKey?: Buffer;
  productionAccountingNamespace?: string;
  productionTenantLimits?: ExploreBudgetLimits;
  clock?: () => number;
  inspectDatabaseFn?: InspectDatabaseFn;
  resolveTrustedScopeFn?: ResolveExploreTrustedScopeFn;
  runtimeFactory?: typeof createScopedExploreRuntime;
  modelAuthorityMetadata?: ModelAuthorityMetadataMode;
  /** Local stdio can advertise fixed tool schemas before a caller identity is
   * supplied. Every describe/validate/explore call still initializes scope. */
  deferTrustedScope?: boolean;
  subjectReferences?: {
    service: SubjectReferenceService;
    workflow_session_id: string;
  };
}): Promise<ScopedExploreBoundarySetRuntime> {
  return withProjectRuntimeAdmission(input.projectRoot, (root) => createAdmittedBoundarySet({ ...input, projectRoot: root }));
}

async function createAdmittedBoundarySet(input: Parameters<typeof createScopedExploreBoundarySetRuntime>[0]): Promise<ScopedExploreBoundarySetRuntime> {
  if (input.deferTrustedScope && (input.transport !== "stdio" || input.mode === "production_http")) {
    throw new ScopedExploreError("EXPLORE_PLAN_INVALID", "Deferred scope initialization is restricted to local stdio protocol setup.");
  }
  const projectRoot = path.resolve(input.projectRoot);
  const ownsStore = !input.store;
  const store = input.store ?? await createProjectRuntimeStore({ projectRoot, config: {} as RuntimeConfig,
    env: input.env, storePath: path.join(projectRoot, ".synapsor/local.db") });
  try {
    const policyStore = await borrowRuntimeControlPolicies(projectRoot, store);
    const runtime = await createBoundarySetWithStore(input, store, ownsStore, policyStore);
    const operations = projectRuntimeOperations(projectRoot);
    runtime.withOperation = (operation) => operations.run(operation);
    const describe = runtime.describe.bind(runtime), validate = runtime.validate.bind(runtime), explore = runtime.explore.bind(runtime);
    const close = runtime.close.bind(runtime), scope = runtime.requireTrustedScope?.bind(runtime);
    const catalog = runtime.authorizedCatalogBoundaries?.bind(runtime);
    const references = runtime.supportsSubjectReferences?.bind(runtime);
    runtime.describe = (request) => operations.run(() => describe(request));
    runtime.validate = (plan, name) => operations.run(() => validate(plan, name));
    runtime.explore = (plan, name) => operations.run(() => explore(plan, name));
    if (scope) runtime.requireTrustedScope = () => operations.run(scope);
    if (catalog) runtime.authorizedCatalogBoundaries = () => operations.run(catalog);
    if (references) runtime.supportsSubjectReferences = (resource, boundary) => operations.run(() => references(resource, boundary));
    runtime.close = () => operations.close(close);
    return runtime;
  } catch (error) {
    if (ownsStore) await store.close();
    throw error;
  }
}

async function createBoundarySetWithStore(input: Parameters<typeof createScopedExploreBoundarySetRuntime>[0],
  store: ProposalRuntimeStore, ownsStore: boolean, policyStore?: BoundProjectPolicyStore): Promise<ScopedExploreBoundarySetRuntime> {
  const projectRoot = path.resolve(input.projectRoot);
  const children = new Map<string, Child>();
  await assertRuntimeControlPolicyContinuity(projectRoot, policyStore);
  let boundaries = await loadActivatedExplorationBoundaries(projectRoot, policyStore).catch((error) => {
    throw scopedExploreBoundaryLoadError(error);
  });
  await assertRuntimeControlPolicyContinuity(projectRoot, policyStore);
  let selected = boundaries.at(-1)!;
  let setDigest = activatedExplorationBoundarySetDigest(boundaries);
  let closed = false;

  const refresh = async (): Promise<void> => {
    if (closed) throw new ScopedExploreError("EXPLORE_DISABLED", "Scoped Explore is closed.");
    await assertRuntimeControlPolicyContinuity(projectRoot, policyStore);
    const current = await loadActivatedExplorationBoundaries(projectRoot, policyStore).catch((error) => {
      throw scopedExploreBoundaryLoadError(error);
    });
    await assertRuntimeControlPolicyContinuity(projectRoot, policyStore);
    const currentNames = new Set(current.map((boundary) => boundary.pack.name));
    for (const [name, child] of children) {
      const active = current.find((boundary) => boundary.pack.name === name);
      if (!active || active.activation.digest !== child.digest) {
        children.delete(name);
        await child.runtime.close();
      }
    }
    boundaries = current;
    selected = current.at(-1)!;
    setDigest = activatedExplorationBoundarySetDigest(current);
    for (const name of children.keys()) {
      if (!currentNames.has(name)) children.delete(name);
    }
  };

  const childFor = async (boundary: ActivatedExplorationBoundary): Promise<ScopedExploreRuntime> => {
    const existing = children.get(boundary.pack.name);
    if (existing?.digest === boundary.activation.digest) return existing.runtime;
    if (existing) await existing.runtime.close();
    const runtime = await (input.runtimeFactory ?? createScopedExploreRuntime)({
      projectRoot,
      transport: input.transport,
      mode: input.mode,
      boundaryName: boundary.pack.name,
      env: input.env,
      store,
      ...(input.sessionContext ? { sessionContext: input.sessionContext } : {}),
      ...(input.productionPrivacyHmacKey ? { productionPrivacyHmacKey: input.productionPrivacyHmacKey } : {}),
      ...(input.productionAccountingNamespace ? { productionAccountingNamespace: input.productionAccountingNamespace } : {}),
      ...(input.productionTenantLimits ? { productionTenantLimits: input.productionTenantLimits } : {}),
      ...(input.executor ? { executor: input.executor } : {}),
      ...(input.clock ? { clock: input.clock } : {}),
      ...(input.inspectDatabaseFn ? { inspectDatabaseFn: input.inspectDatabaseFn } : {}),
      ...(input.resolveTrustedScopeFn ? { resolveTrustedScopeFn: input.resolveTrustedScopeFn } : {}),
      ...(input.subjectReferences ? { subjectReferences: input.subjectReferences } : {}),
      modelAuthorityMetadata: input.modelAuthorityMetadata ?? "semantic",
    });
    children.set(boundary.pack.name, {
      digest: boundary.activation.digest,
      runtime,
    });
    return runtime;
  };

  const route = (boundaryName: string | undefined, resource: string | undefined) =>
    resolveActiveExploreTarget(boundaries, boundaryName, resource);

  const initialRuntime = input.deferTrustedScope ? undefined : await childFor(selected);
  const runtime: ScopedExploreBoundarySetRuntime = {
    authorizedCatalogBoundaries: async () => {
      await refresh();
      const allowed: ActivatedExplorationBoundary[] = [];
      for (const boundary of boundaries) {
        try { await childFor(boundary); allowed.push(boundary); }
        catch (error) {
          if (!(error instanceof ScopedExploreError) || error.code !== "EXPLORE_SCOPE_FORBIDDEN") throw error;
        }
      }
      return allowed;
    },
    requireTrustedScope: async () => { await refresh(); await childFor(selected); },
    supportsSubjectReferences: async (resource, boundaryName) => {
      await refresh();
      const target = route(boundaryName, resource);
      if (target.resource?.relationship_only) return false;
      const child = await childFor(target.boundary);
      return await child.supportsSubjectReferences?.(resource) ?? false;
    },
    get boundary() {
      return selected;
    },
    get boundaries() {
      return [...boundaries];
    },
    get active_boundary_set_digest() {
      return setDigest;
    },
    get session_fingerprint() {
      const fingerprint = children.get(selected.pack.name)?.runtime.session_fingerprint
        ?? initialRuntime?.session_fingerprint;
      if (!fingerprint) throw new ScopedExploreError("EXPLORE_SCOPE_FORBIDDEN", "A trusted runtime identity is required before scoped tool use.");
      return fingerprint;
    },
    model_authority_metadata: input.modelAuthorityMetadata ?? "semantic",
    get trusted_scope() {
      return children.get(selected.pack.name)?.runtime.trusted_scope
        ?? initialRuntime?.trusted_scope;
    },
    describe: async (request = {}) => {
      await refresh();
      if (input.deferTrustedScope) await childFor(selected);
      if (request.boundary || request.resource || boundaries.length === 1) {
        const target = route(request.boundary, request.resource);
        const boundary = target.boundary;
        const child = await childFor(boundary);
        const described = await child.describe({
          ...(target.resource ? { resource: target.resource.id } : {}),
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
          ...(request.include_time_coverage === undefined
            ? {}
            : { include_time_coverage: request.include_time_coverage }),
        });
        return addBoundaryCatalog(described, boundary, boundaries, setDigest);
      }

      const limit = request.limit ?? 8;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
        throw new ScopedExploreError("EXPLORE_PLAN_INVALID", "app.describe_data limit must be an integer from 1 through 10.");
      }
      const cursor = request.cursor ?? 0;
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        throw new ScopedExploreError("EXPLORE_PLAN_INVALID", "app.describe_data cursor must be a non-negative integer.");
      }
      const page: Array<Record<string, unknown>> = [];
      let skipped = 0;
      let total = 0;
      for (const boundary of boundaries) {
        total += boundary.pack.resources.length;
        const localOffset = Math.max(0, cursor - skipped);
        skipped += boundary.pack.resources.length;
        if (localOffset >= boundary.pack.resources.length || page.length >= limit) continue;
        const child = await childFor(boundary);
        const described = await child.describe({ cursor: localOffset, limit: limit - page.length,
          include_time_coverage: request.include_time_coverage === true });
        page.push(...recordArray(described.resources).map((resource) => ({ ...resource, boundary_name: boundary.pack.name })));
      }
      const relativeTimeAvailable = boundaries.some((boundary) =>
        boundary.reporting_timezone === "UTC");
      return {
        ok: true,
        outcome: { type: "success" },
        active_boundary_set_digest: setDigest,
        boundaries: boundarySummaries(boundaries),
        relative_time_windows: {
          available: relativeTimeAvailable,
          reporting_timezone: relativeTimeAvailable ? "UTC" : null,
          windows: relativeTimeAvailable ? [...RELATIVE_TIME_WINDOWS] : [],
          comparison_partners: relativeTimeAvailable ? [...RELATIVE_TIME_COMPARISONS] : [],
          range_semantics: "half-open [start, end)",
          week_starts_on: "Monday",
          model_supplied_date_arithmetic: false,
        },
        resources: page,
        next_cursor: cursor + page.length < total ? cursor + page.length : null,
        raw_sql_available: false,
        source_rows_available_before_activation: false,
        source_database_changed: false,
      };
    },
    validate: async (unknownPlan, boundaryName) => {
      await refresh();
      if (input.deferTrustedScope) await childFor(selected);
      const resource = isRecord(unknownPlan) && typeof unknownPlan.resource === "string"
        ? unknownPlan.resource
        : undefined;
      const target = route(boundaryName, resource);
      const boundary = target.boundary;
      const child = await childFor(boundary);
      const canonicalPlan = target.resource && isRecord(unknownPlan)
        ? { ...unknownPlan, resource: target.resource.id }
        : unknownPlan;
      const result = await child.validate(canonicalPlan);
      return {
        ...result,
        boundary_name: boundary.pack.name,
        active_boundary_set_digest: setDigest,
      };
    },
    explore: async (unknownPlan, boundaryName) => {
      await refresh();
      if (input.deferTrustedScope) await childFor(selected);
      const resource = isRecord(unknownPlan) && typeof unknownPlan.resource === "string"
        ? unknownPlan.resource
        : undefined;
      const target = route(boundaryName, resource);
      const boundary = target.boundary;
      const child = await childFor(boundary);
      const canonicalPlan = target.resource && isRecord(unknownPlan)
        ? { ...unknownPlan, resource: target.resource.id }
        : unknownPlan;
      const result = await child.explore(canonicalPlan);
      return {
        ...result,
        boundary_name: boundary.pack.name,
        active_boundary_set_digest: setDigest,
      };
    },
    projectResultForModel: ({ tool, arguments: args, result }) => {
      if (tool !== SCOPED_EXPLORE_QUERY_TOOL) {
        return { value: structuredClone(result), withheld: false };
      }
      const name = typeof result.boundary_name === "string"
        ? result.boundary_name
        : typeof args.boundary === "string"
          ? args.boundary
          : undefined;
      const boundary = name
        ? boundaries.find((candidate) => candidate.pack.name === name)
        : undefined;
      if (!boundary) {
        const value = structuredClone(result);
        const operatorMetadataWithheld = Object.hasOwn(value, "operator_budget")
          || Object.hasOwn(value, "operator_time_windows");
        delete value.operator_budget;
        delete value.operator_time_windows;
        const authority = projectAuthorityMetadataForModel(
          value,
          input.modelAuthorityMetadata ?? "semantic",
        );
        return {
          value: authority.value,
          withheld: false,
          ...(operatorMetadataWithheld || authority.withheld
            ? { operator_metadata_withheld: true }
            : {}),
        };
      }
      const rawPlan = isRecord(args.plan) ? args.plan : undefined;
      const target = rawPlan && typeof rawPlan.resource === "string"
        ? resolveActiveExploreTarget(boundaries, boundary.pack.name, rawPlan.resource)
        : undefined;
      const canonicalArguments = target?.resource && rawPlan
        ? { ...args, plan: { ...rawPlan, resource: target.resource.id } }
        : args;
      return projectScopedExploreResultForModel({
        tool,
        arguments: canonicalArguments,
        result,
        boundary,
        authorityMetadata: input.modelAuthorityMetadata ?? "semantic",
      });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await runAllCleanups([
          ...[...children.values()].map((child) => () => child.runtime.close()),
          ...(ownsStore ? [async () => { await store.close(); }] : []),
        ], "Scoped Explore boundary-set cleanup failed");
      } finally {
        children.clear();
      }
    },
  };
  return runtime;
}

export function selectActiveExploreBoundary(
  boundaries: ActivatedExplorationBoundary[],
  boundaryName: string | undefined,
  resource: string | undefined,
): ActivatedExplorationBoundary {
  return resolveActiveExploreTarget(boundaries, boundaryName, resource).boundary;
}

export function resolveActiveExploreTarget(
  boundaries: ActivatedExplorationBoundary[],
  boundaryName: string | undefined,
  resource: string | undefined,
): ActiveExploreTarget {
  if (boundaryName) {
    const boundary = boundaries.find((candidate) => candidate.pack.name === boundaryName);
    if (!boundary) {
      throw new ScopedExploreError(
        "EXPLORE_BOUNDARY_FORBIDDEN",
        `Boundary ${boundaryName} is not active reviewed Explore authority.`,
      );
    }
    if (!resource) return { boundary };
    const matches = matchingResources([{ boundary }], resource);
    if (matches.length === 1) return matches[0]!;
    throw unknownResourceError(resource, [{ boundary }], `boundary ${boundaryName}`);
  }
  if (!resource) {
    if (boundaries.length === 1) return { boundary: boundaries[0]! };
    throw new ScopedExploreError(
      "EXPLORE_BOUNDARY_REQUIRED",
      "Choose one active reviewed boundary before requesting boundary-specific metadata.",
      { active_boundaries: boundaries.map((boundary) => boundary.pack.name).sort() },
    );
  }
  const candidates = boundaries.map((boundary) => ({ boundary }));
  const matches = matchingResources(candidates, resource);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw unknownResourceError(resource, candidates, "the active reviewed boundaries");
  }
  const reviewedCandidates = matches.map((match) => ({
    boundary: match.boundary.pack.name,
    resource: match.resource!.id,
  })).sort(compareResourceCandidate);
  throw new ScopedExploreError(
    "EXPLORE_BOUNDARY_REQUIRED",
    `Resource ${resource} matches more than one active reviewed resource. Choose one boundary explicitly: ${formatResourceCandidates(reviewedCandidates)}.`,
    {
      active_boundaries: [...new Set(reviewedCandidates.map((candidate) => candidate.boundary))],
      reviewed_candidates: reviewedCandidates,
    },
  );
}

function matchingResources(
  candidates: Array<{ boundary: ActivatedExplorationBoundary }>,
  requested: string,
): ActiveExploreTarget[] {
  const resources = candidates.flatMap(({ boundary }) => boundary.pack.resources.map((resource) => ({
    boundary,
    resource,
  })));
  const exact = resources.filter((candidate) => candidate.resource.id === requested);
  if (exact.length > 0) return exact;
  const normalized = normalizeResourceAlias(requested);
  return resources.filter((candidate) => resourceAliases(candidate.resource.id).has(normalized));
}

function resourceAliases(resourceId: string): Set<string> {
  const table = resourceId.split(".").at(-1) ?? resourceId;
  return new Set([
    normalizeResourceAlias(resourceId),
    normalizeResourceAlias(table),
    normalizeResourceAlias(table.replaceAll("_", " ")),
  ]);
}

function normalizeResourceAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function unknownResourceError(
  requested: string,
  candidates: Array<{ boundary: ActivatedExplorationBoundary }>,
  location: string,
): ScopedExploreError {
  const valid = candidates.flatMap(({ boundary }) => boundary.pack.resources.map((resource) => ({
    boundary: boundary.pack.name,
    resource: resource.id,
  }))).sort(compareResourceCandidate);
  const suggestion = nearestResource(requested, valid);
  const shown = valid.slice(0, 12);
  const remainder = valid.length - shown.length;
  return new ScopedExploreError(
    "EXPLORE_RESOURCE_FORBIDDEN",
    `Resource ${requested} is not a reviewed resource in ${location}.`
      + (suggestion ? ` Did you mean ${suggestion.resource} in boundary ${suggestion.boundary}?` : "")
      + ` Valid reviewed resources: ${formatResourceCandidates(shown)}`
      + (remainder > 0 ? `; ${remainder} more are available from app.describe_data.` : "."),
    {
      requested_resource: requested,
      ...(suggestion ? { suggested_resource: suggestion } : {}),
      valid_resources: shown,
      ...(remainder > 0 ? { additional_resource_count: remainder } : {}),
    },
  );
}

function nearestResource(
  requested: string,
  candidates: Array<{ boundary: string; resource: string }>,
): { boundary: string; resource: string } | undefined {
  const needle = normalizeResourceAlias(requested);
  if (!needle) return undefined;
  const ranked = candidates.map((candidate) => {
    const table = candidate.resource.split(".").at(-1) ?? candidate.resource;
    return {
      candidate,
      distance: Math.min(
        editDistance(needle, normalizeResourceAlias(candidate.resource)),
        editDistance(needle, normalizeResourceAlias(table)),
      ),
    };
  }).sort((left, right) => left.distance - right.distance
    || compareResourceCandidate(left.candidate, right.candidate));
  const closest = ranked[0];
  if (!closest) return undefined;
  const limit = Math.max(2, Math.floor(needle.length / 3));
  return closest.distance <= limit ? closest.candidate : undefined;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}

function compareResourceCandidate(
  left: { boundary: string; resource: string },
  right: { boundary: string; resource: string },
): number {
  return left.resource.localeCompare(right.resource) || left.boundary.localeCompare(right.boundary);
}

function formatResourceCandidates(candidates: Array<{ boundary: string; resource: string }>): string {
  return candidates.map((candidate) => `${candidate.resource} [${candidate.boundary}]`).join(", ");
}

function addBoundaryCatalog(
  described: Record<string, unknown>,
  boundary: ActivatedExplorationBoundary,
  boundaries: ActivatedExplorationBoundary[],
  setDigest: `sha256:${string}`,
): Record<string, unknown> {
  return {
    ...described,
    boundary_name: boundary.pack.name,
    active_boundary_set_digest: setDigest,
    boundaries: boundarySummaries(boundaries),
    resources: recordArray(described.resources).map((resource) => ({
      ...resource,
      boundary_name: boundary.pack.name,
    })),
  };
}

function boundarySummaries(boundaries: ActivatedExplorationBoundary[]): Array<Record<string, unknown>> {
  return boundaries
    .map((boundary) => ({
      name: boundary.pack.name,
      digest: boundary.activation.digest,
      table_count: boundary.pack.resources.length,
      resources: boundary.pack.resources.map((resource) => resource.id),
    }))
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
