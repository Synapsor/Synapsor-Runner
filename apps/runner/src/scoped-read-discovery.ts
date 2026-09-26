import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { CATALOG_LIMITS, McpRuntimeError, ScopedCatalogIndex, ScopedCatalogSession, catalogResponseBytes, catalogContractSizeError } from "@synapsor-runner/mcp-server";
import type { ScopedExploreRuntime } from "./scoped-explore.js";
import { resolveActiveExploreTarget, type ScopedExploreBoundarySetRuntime } from "./scoped-explore-boundary-set.js";

export type ReadDiscoveryRequest = { boundary?: string; resource?: string; query?: string; cursor?: string; limit?: number };

/** Model-facing discovery is bounded independently of operator inspection APIs. */
export function createScopedReadDiscovery(
  runtime: ScopedExploreRuntime | ScopedExploreBoundarySetRuntime,
  projectResponse: (result: Record<string, unknown>, detail: boolean) => Record<string, unknown> = (result) => result,
) {
  const session = new ScopedCatalogSession();
  let cache: { binding: string; index: ScopedCatalogIndex } | undefined;
  const authorizedBoundaries = async () => {
    if ("requireTrustedScope" in runtime) await runtime.requireTrustedScope?.();
    if ("requireCurrentAuthority" in runtime) await runtime.requireCurrentAuthority?.();
    return "boundaries" in runtime
      ? await runtime.authorizedCatalogBoundaries?.() ?? runtime.boundaries
      : [runtime.boundary];
  };
  const authorityBinding = (boundaries: Awaited<ReturnType<typeof authorizedBoundaries>>, request: ReadDiscoveryRequest) =>
    canonicalJsonDigest({ scope: runtime.session_fingerprint,
      boundaries: boundaries.map((boundary) => [boundary.pack.name, boundary.activation.digest]),
      filter: request.boundary ?? null });
  return async (request: ReadDiscoveryRequest): Promise<Record<string, unknown>> => {
    const boundaries = await authorizedBoundaries();
    const binding = authorityBinding(boundaries, request);
    if (!cache || cache.binding !== binding) {
      // Resource summaries are prepared from reviewed metadata, without opening
      // every resource detail or requesting time-coverage/source facts.
      const selected = request.boundary ? boundaries.filter((boundary) => boundary.pack.name === request.boundary) : boundaries;
      cache = { binding, index: new ScopedCatalogIndex(selected.flatMap((boundary) => boundary.pack.resources.map((resource) => {
        const label = resource.label ?? resource.id;
        const description = resource.description ?? label;
        const value = { id: resource.id, label: label.slice(0, 64), description: description.slice(0, 280),
          boundary_name: boundary.pack.name, metadata_only: true, queryable_root: resource.relationship_only !== true };
        return { id: `${boundary.pack.name}/${resource.id}`, title: label.slice(0, 160), summary: description.slice(0, 400),
          aliases: resource.id.length <= 80 ? [resource.id] : [], value, detail: () => value };
      }))) };
    }
    const index = cache.index;
    let detail: string | undefined;
    let detailValue: Record<string, unknown> | undefined;
    let context: Record<string, unknown> = boundaries.length === 1
      ? { boundary_digest: boundaries[0]!.activation.digest } : {};
    if (request.resource) {
      if (request.query !== undefined || request.cursor !== undefined || request.limit !== undefined) {
        throw new McpRuntimeError("ARGUMENT_INVALID", "Use resource with optional boundary for exact details, without query, limit or cursor.");
      }
      let target: ReturnType<typeof resolveActiveExploreTarget>;
      try { target = resolveActiveExploreTarget(boundaries, request.boundary, request.resource); }
      catch { throw new McpRuntimeError("CATALOG_ENTRY_UNAVAILABLE", "That resource is not available unambiguously in the current authorized catalog. Browse authorized resources and use their exact boundary and resource."); }
      detail = `${target.boundary.pack.name}/${target.resource!.id}`;
      if (index.get(detail)) {
        const described = await runtime.describe({ boundary: target.boundary.pack.name,
          resource: target.resource!.id, include_time_coverage: false });
        const resources = described.resources as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(resources) || resources.length !== 1 || resources[0]?.id !== target.resource!.id) {
          throw new McpRuntimeError("CATALOG_ENTRY_UNAVAILABLE", "The exact reviewed resource details are unavailable; retry after operator review.");
        }
        detailValue = resources[0];
        const { resources: _resources, boundaries: _boundaries, next_cursor: _cursor, ...rest } = described;
        context = rest;
      }
    }
    if (authorityBinding(await authorizedBoundaries(), request) !== binding) {
      throw new McpRuntimeError("CATALOG_CURSOR_INVALID", "Reviewed authority changed during discovery. Restart discovery with the current authorized catalog.");
    }
    const result = session.describe({ index, binding, key: "resources", detailValue, context,
      measureDetail: (value) => Buffer.byteLength(JSON.stringify((projectResponse({
        ...context, ok: true, catalog_version: "synapsor.scoped-catalog.v2", resources: [value],
      }, Boolean(detail)).resources as unknown[])[0])),
      measureResponse: (value) => catalogResponseBytes(projectResponse(value, Boolean(detail)), "compact"),
      request: { ...(detail ? { detail } : {}), ...(request.query === undefined ? {} : { query: request.query }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }), ...(request.limit === undefined ? {} : { limit: request.limit }) } });
    if ("requireCurrentAuthority" in runtime) await runtime.requireCurrentAuthority?.();
    const bytes = catalogResponseBytes(projectResponse(result, Boolean(detail)), "compact");
    if (bytes > CATALOG_LIMITS.responseBytes) throw catalogContractSizeError("response", bytes, CATALOG_LIMITS.responseBytes);
    return result;
  };
}
