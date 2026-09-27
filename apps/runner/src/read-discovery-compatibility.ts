import { CATALOG_LIMITS, ScopedCatalogIndex, ScopedCatalogSession, catalogResponseBytes } from "@synapsor-runner/mcp-server";
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
    if (entryBytes <= CATALOG_LIMITS.detailBytes && responseBytes <= CATALOG_LIMITS.responseBytes) return [];
    const id = String((raw.resources as Record<string, unknown>[])[0]!.id);
    try {
      // Match the real exact/section projector, transport envelope and original
      // cumulative session meter. Activation is not blocked by a decomposable
      // complete contract, and never relies on truncation or a fresh page pool.
      const publicEntry = (projected.resources as Record<string, unknown>[])[0]!;
      const rawEntry = (complete.resources as Record<string, unknown>[])[0]!;
      const { resources: _resources, ...context } = complete;
      const { resources: _publicResources, ...publicContext } = projected;
      const index = new ScopedCatalogIndex([{ id, title: id.slice(0, 160), summary: "Reviewed resource contract",
        value: { id, boundary_name: boundaryName }, detail: () => rawEntry }]);
      const session = new ScopedCatalogSession();
      const call = (request: Record<string, unknown>) => session.describe({ index, binding: digest, key: "resources", context,
        detailValue: rawEntry, sectionValue: publicEntry, sectionContext: publicContext,
        exactDetailArguments: () => ({ boundary: boundaryName, resource: id }),
        measureDetail: () => entryBytes,
        measureResponse: value => catalogResponseBytes(projectDescribeDataForModel(value, true, "exact"), "compact"),
        request: { ...request, detail: id } });
      let result = call({});
      const sections: Array<{ next_call: { arguments: Record<string, unknown> } }> = [];
      do {
        const navigation = result.contract_navigation as { sections: typeof sections };
        sections.push(...navigation.sections);
        const steps = (result.discovery as { next_steps: Array<{ kind: string; arguments?: Record<string, unknown> }> }).next_steps;
        const continuation = steps.find(step => step.kind === "continue_contract_index");
        if (!continuation) break;
        const { resource: _resource, boundary: _boundary, ...args } = continuation.arguments!;
        result = call(args);
      } while (true);
      for (const section of sections) {
        const { resource: _resource, boundary: _boundary, ...args } = section.next_call.arguments;
        let page = call(args);
        while (page.next_cursor) page = call({ ...args, cursor: page.next_cursor });
      }
      return [];
    } catch {
      // The original exact measurements remain diagnostic evidence. A genuine
      // indivisible/work/session limit remains an activation concern.
      return [{ resource: id, entry_bytes: entryBytes, response_bytes: responseBytes }];
    }
  });
}

export function readDiscoveryConcernLines(concerns: ReadDiscoveryConcern[]): string[] {
  return concerns.length ? ["Discovery compatibility: exact contracts need revision before activation.",
    ...concerns.map((c) => `${c.resource}: entry ${c.entry_bytes}/${CATALOG_LIMITS.detailBytes} bytes; complete MCP response ${c.response_bytes}/${CATALOG_LIMITS.responseBytes} bytes.`),
    "Shorten redundant reviewed descriptions, or split the intended Read scope into separately reviewed resources/boundaries. Preserve required permissions and privacy controls; do not guess missing contracts.",
    "Revise this saved draft with the model or manual editor, then review the replacement. No constraints were truncated; existing authority is unchanged."] : [];
}
