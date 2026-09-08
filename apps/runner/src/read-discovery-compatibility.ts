import { CATALOG_LIMITS, catalogResponseBytes } from "@synapsor-runner/mcp-server";
import { projectDescribeDataForModel } from "./read-catalog-presentation.js";

export type ReadDiscoveryConcern = { resource: string; entry_bytes: number; response_bytes: number };

/** Uses runtime presentation and wire accounting, without opening a DB or activating a draft. */
export function checkReadDiscoveryContracts(descriptions: Record<string, unknown>[], digest: string, boundaryName: string): ReadDiscoveryConcern[] {
  return descriptions.flatMap((raw) => {
    const complete = { ...raw, boundary_digest: digest, boundary_name: boundaryName,
      active_boundary_set_digest: digest,
      resources: (raw.resources as Record<string, unknown>[]).map((entry) => ({ ...entry, boundary_name: boundaryName })),
      catalog_version: "synapsor.scoped-catalog.v2",
      discovery: { mode: "detail", eligibility: "not_checked",
        next_step: "Search or browse a shortlist, request exact details, then use the selected contract. Discovery grants no authority." },
      source_database_changed: false };
    // Exact metadata mode is supported too; preflight the larger representation.
    const projected = projectDescribeDataForModel(complete, true, "exact");
    const entryBytes = Buffer.byteLength(JSON.stringify((projected.resources as unknown[])[0]));
    const responseBytes = catalogResponseBytes(projected, "compact");
    return entryBytes > CATALOG_LIMITS.detailBytes || responseBytes > CATALOG_LIMITS.responseBytes
      ? [{ resource: String((raw.resources as Record<string, unknown>[])[0]!.id), entry_bytes: entryBytes, response_bytes: responseBytes }] : [];
  });
}

export function readDiscoveryConcernLines(concerns: ReadDiscoveryConcern[]): string[] {
  return concerns.length ? ["Discovery compatibility: exact contracts need revision before activation.",
    ...concerns.map((c) => `${c.resource}: entry ${c.entry_bytes}/${CATALOG_LIMITS.detailBytes} bytes; complete MCP response ${c.response_bytes}/${CATALOG_LIMITS.responseBytes} bytes.`),
    "Shorten redundant reviewed descriptions, or split the intended Read scope into separately reviewed resources/boundaries. Preserve required permissions and privacy controls; do not guess missing contracts.",
    "Revise this saved draft with the model or manual editor, then review the replacement. No constraints were truncated; existing authority is unchanged."] : [];
}
