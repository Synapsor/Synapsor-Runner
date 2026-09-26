import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { McpRuntimeError, type ModelAuthorityMetadataMode } from "@synapsor-runner/mcp-server";
import { projectDescribeDataForModel } from "./read-catalog-presentation.js";
import type { ScopedExploreRuntime } from "./scoped-explore.js";
import type { ScopedExploreBoundarySetRuntime } from "./scoped-explore-boundary-set.js";

/** Navigation copies the existing public Read contract; never Action verifier facts. */
export function createActionSubjectNavigation(runtime: ScopedExploreRuntime | ScopedExploreBoundarySetRuntime,
  mode: ModelAuthorityMetadataMode = runtime.model_authority_metadata ?? "semantic") {
  const authorized = async () => {
    if ("requireTrustedScope" in runtime) await runtime.requireTrustedScope?.();
    if ("requireCurrentAuthority" in runtime) await runtime.requireCurrentAuthority?.();
    return "boundaries" in runtime ? await runtime.authorizedCatalogBoundaries?.() ?? runtime.boundaries : [runtime.boundary];
  };
  const binding = (boundaries: Awaited<ReturnType<typeof authorized>>) => canonicalJsonDigest({
    session: runtime.session_fingerprint,
    boundaries: boundaries.map(boundary => [boundary.pack.name, boundary.activation.digest]),
  });
  return async (requested: readonly string[]) => {
    const boundaries = await authorized();
    const before = binding(boundaries);
    const resources: Record<string, Record<string, unknown>> = {};
    for (const id of new Set(requested)) {
      const matches = boundaries.flatMap(boundary => boundary.pack.resources.filter(resource => resource.id === id)
        .map(resource => ({ boundary, resource })));
      if (matches.length !== 1) {
        resources[id] = { status: "unavailable", guidance: "No unambiguous current permitted Read/reference route is established. Ask the operator to review access; do not guess a resource or reference." };
        continue;
      }
      const { boundary, resource } = matches[0]!;
      const describeData = { boundary: boundary.pack.name, resource: id };
      if (resource.relationship_only) {
        resources[id] = { status: "relationship_only",
          guidance: "This resource is available only through a permitted relationship, not as an independent rows root. No independent subject-reference path is established." };
        continue;
      }
      const described = await runtime.describe({ ...describeData, include_time_coverage: false });
      const projected = projectDescribeDataForModel(described, true, mode);
      const details = Array.isArray(projected.resources) ? projected.resources.filter(record) : [];
      if (details.length !== 1 || details[0]?.id !== id) {
        throw new McpRuntimeError("CATALOG_ENTRY_UNAVAILABLE", "The exact current Read details are unavailable. Restart discovery after operator review.");
      }
      const detail = details[0]!;
      const withheld = new Set(strings(detail.model_withheld_fields));
      // A navigational subset, not a second complete Read contract. Keep order
      // from the reviewed projection; do not guess which label denotes identity.
      const selectable = strings(detail.selectable_fields).filter(field => !withheld.has(field)).slice(0, 3);
      const selected = new Set(selectable);
      const filters = record(detail.filter_operators) ? Object.fromEntries(Object.entries(detail.filter_operators)
        .filter(([field]) => selected.has(field)).map(([field, operators]) => [field, strings(operators)])) : {};
      const supportsReferences = "boundaries" in runtime
        ? await runtime.supportsSubjectReferences?.(id, boundary.pack.name)
        : await runtime.supportsSubjectReferences?.(id);
      const usable = selectable.length > 0 && supportsReferences === true;
      resources[id] = { status: usable ? "rows_reference_available" : "reference_not_established", describe_data: describeData,
        field_scope: "bounded_navigation_subset; exact describe_data gives the complete current permitted grammar",
        selectable_fields: selectable, filter_operators: filters,
        ...(usable ? { explore_data: { boundary: boundary.pack.name, plan: { kind: "rows", resource: id,
          select: selectable } },
          reference: "Use the opaque reference returned in subjects for the selected row_index in this same rows result; no extra lookup is needed when present." } : {}),
        guidance: "Use only the listed fields/operators. Public rows and references identify possible subjects, not private eligibility or missing caller inputs. If no matching row/reference is returned, do not fabricate one.",
      };
    }
    if (binding(await authorized()) !== before) {
      throw new McpRuntimeError("CATALOG_CURSOR_INVALID", "Reviewed Read authority changed during Action navigation. Restart discovery with the current authorized catalog.");
    }
    return { binding: canonicalJsonDigest({ authority: before, resources }), resources };
  };
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []; }
