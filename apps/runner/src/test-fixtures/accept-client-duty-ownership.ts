import { reviewClientDutyOwnership } from "../authoring-client-duties.js";
import type { PolicyCoverage, PolicySourceSession } from "../authoring-policy-source.js";
/** Synthetic operator choice for composed regressions; not installed UI evidence. */
export async function acceptClientDutyOwnership(report: PolicyCoverage, sources: PolicySourceSession) {
  sources.application_assignments = [...(sources.application_assignments ?? []), ...await reviewClientDutyOwnership({ report, sources,
    session: { chooseOption: async () => "assign" }, assertCurrent: async () => {} })];
}
