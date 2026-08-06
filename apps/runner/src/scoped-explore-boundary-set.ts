import path from "node:path";
import {
  ProposalStore,
  type ExploreBudgetLimits,
  type ProposalRuntimeStore,
} from "@synapsor-runner/proposal-store";
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
  type ScopedExploreMode,
  type ScopedExploreTransport,
} from "./scoped-explore.js";
import type { ExploreHttpSessionContext } from "./explore-trusted-scope.js";

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
  trusted_scope?: ScopedExploreRuntime["trusted_scope"];
  describe(input?: BoundarySetDescribeInput): Promise<Record<string, unknown>>;
  explore(plan: unknown, boundaryName?: string): Promise<Record<string, unknown>>;
  projectResultForModel(input: {
    tool: string;
    arguments: Record<string, unknown>;
    result: Record<string, unknown>;
  }): { value: Record<string, unknown>; withheld: boolean };
  close(): Promise<void>;
};

type Child = {
  digest: `sha256:${string}`;
  runtime: ScopedExploreRuntime;
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
}): Promise<ScopedExploreBoundarySetRuntime> {
  const projectRoot = path.resolve(input.projectRoot);
  const ownsStore = !input.store;
  const store = input.store ?? new ProposalStore(path.join(projectRoot, ".synapsor/local.db"));
  const children = new Map<string, Child>();
  let boundaries = await loadActivatedExplorationBoundaries(projectRoot).catch((error) => {
    throw scopedExploreBoundaryLoadError(error);
  });
  let selected = boundaries.at(-1)!;
  let setDigest = activatedExplorationBoundarySetDigest(boundaries);
  let closed = false;

  const refresh = async (): Promise<void> => {
    if (closed) throw new ScopedExploreError("EXPLORE_DISABLED", "Scoped Explore is closed.");
    const current = await loadActivatedExplorationBoundaries(projectRoot).catch((error) => {
      throw scopedExploreBoundaryLoadError(error);
    });
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
    });
    children.set(boundary.pack.name, {
      digest: boundary.activation.digest,
      runtime,
    });
    return runtime;
  };

  const route = (boundaryName: string | undefined, resource: string | undefined) =>
    selectActiveExploreBoundary(boundaries, boundaryName, resource);

  const initialRuntime = await childFor(selected);
  const runtime: ScopedExploreBoundarySetRuntime = {
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
      return children.get(selected.pack.name)?.runtime.session_fingerprint
        ?? initialRuntime.session_fingerprint;
    },
    get trusted_scope() {
      return children.get(selected.pack.name)?.runtime.trusted_scope
        ?? initialRuntime.trusted_scope;
    },
    describe: async (request = {}) => {
      await refresh();
      if (request.boundary || request.resource || boundaries.length === 1) {
        const boundary = route(request.boundary, request.resource);
        const child = await childFor(boundary);
        const described = await child.describe({
          ...(request.resource ? { resource: request.resource } : {}),
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
      const catalog: Array<Record<string, unknown>> = [];
      for (const boundary of boundaries) {
        const child = await childFor(boundary);
        for (const resource of await describeAllResources(
          child,
          request.include_time_coverage,
        )) {
          catalog.push({ ...resource, boundary_name: boundary.pack.name });
        }
      }
      const page = catalog.slice(cursor, cursor + limit);
      return {
        ok: true,
        outcome: { type: "success" },
        active_boundary_set_digest: setDigest,
        boundaries: boundarySummaries(boundaries),
        resources: page,
        next_cursor: cursor + page.length < catalog.length ? cursor + page.length : null,
        raw_sql_available: false,
        source_rows_available_before_activation: false,
        source_database_changed: false,
      };
    },
    explore: async (unknownPlan, boundaryName) => {
      await refresh();
      const resource = isRecord(unknownPlan) && typeof unknownPlan.resource === "string"
        ? unknownPlan.resource
        : undefined;
      const boundary = route(boundaryName, resource);
      const child = await childFor(boundary);
      const result = await child.explore(unknownPlan);
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
      if (!boundary) return { value: structuredClone(result), withheld: false };
      return projectScopedExploreResultForModel({
        tool,
        arguments: args,
        result,
        boundary,
      });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...children.values()].map((child) => child.runtime.close()));
      children.clear();
      if (ownsStore) await store.close();
    },
  };
  return runtime;
}

export function selectActiveExploreBoundary(
  boundaries: ActivatedExplorationBoundary[],
  boundaryName: string | undefined,
  resource: string | undefined,
): ActivatedExplorationBoundary {
  if (boundaryName) {
    const boundary = boundaries.find((candidate) => candidate.pack.name === boundaryName);
    if (!boundary) {
      throw new ScopedExploreError(
        "EXPLORE_BOUNDARY_FORBIDDEN",
        `Boundary ${boundaryName} is not active reviewed Explore authority.`,
      );
    }
    if (resource && !boundary.pack.resources.some((candidate) => candidate.id === resource)) {
      throw new ScopedExploreError(
        "EXPLORE_RESOURCE_FORBIDDEN",
        `Resource ${resource} is not reviewed in boundary ${boundaryName}.`,
      );
    }
    return boundary;
  }
  if (!resource) {
    if (boundaries.length === 1) return boundaries[0]!;
    throw new ScopedExploreError(
      "EXPLORE_BOUNDARY_REQUIRED",
      "Choose one active reviewed boundary before requesting boundary-specific metadata.",
      { active_boundaries: boundaries.map((boundary) => boundary.pack.name).sort() },
    );
  }
  const matches = boundaries.filter((boundary) =>
    boundary.pack.resources.some((candidate) => candidate.id === resource));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new ScopedExploreError(
      "EXPLORE_RESOURCE_FORBIDDEN",
      `Resource ${resource} is outside every active reviewed boundary.`,
    );
  }
  throw new ScopedExploreError(
    "EXPLORE_BOUNDARY_REQUIRED",
    `Resource ${resource} is reviewed in more than one active boundary. Choose the boundary explicitly.`,
    { active_boundaries: matches.map((boundary) => boundary.pack.name).sort() },
  );
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

async function describeAllResources(
  runtime: ScopedExploreRuntime,
  includeTimeCoverage?: boolean,
): Promise<Array<Record<string, unknown>>> {
  const resources: Array<Record<string, unknown>> = [];
  let cursor: number | undefined;
  for (let page = 0; page < 100; page += 1) {
    const described = await runtime.describe({
      limit: 10,
      ...(cursor === undefined ? {} : { cursor }),
      ...(includeTimeCoverage === undefined
        ? {}
        : { include_time_coverage: includeTimeCoverage }),
    });
    resources.push(...recordArray(described.resources));
    cursor = typeof described.next_cursor === "number" ? described.next_cursor : undefined;
    if (cursor === undefined) return resources;
  }
  throw new ScopedExploreError(
    "EXPLORE_PLAN_INVALID",
    "The reviewed boundary catalog exceeded its fixed pagination limit.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
