import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ActionRuleAuthorityV1 } from "@synapsor-runner/action-rules";
import type { ActivatedExplorationBoundary } from "./auto-boundary.js";

// RLS session names are reviewed Read authority, not model-provided bindings.
// The same source transaction must use them for private verification and apply.
export function bindSemanticReadScope(
  config: Record<string, unknown>,
  rules: ActionRuleAuthorityV1["rules"],
  reads: ActivatedExplorationBoundary[],
): Record<string, unknown> {
  const next = structuredClone(config);
  const sources = next.sources as Record<string, Record<string, unknown>> | undefined;
  const bindings = new Map<string, { mode: "postgres_rls"; tenant_setting: string; principal_setting?: string }>();
  for (const rule of rules) {
    const read = reads.find((candidate) => candidate.pack.name === rule.read_boundary_name);
    if (!read || read.activation.digest !== rule.read_boundary_digest) {
      throw new Error("SEMANTIC_ACTION_READ_SCOPE_STALE: review the Action's exact Read dependency before preparing its runtime.");
    }
    for (const resource of rule.verification_boundary.resources) {
      const reviewed = read.pack.resources.find((candidate) => candidate.id === resource.resource)?.rls_session;
      if (!reviewed) continue;
      const source = sources?.[rule.verification_boundary.source];
      if (!source || source.engine !== "postgres") {
        throw new Error("SEMANTIC_ACTION_READ_SCOPE_MISMATCH: the reviewed RLS binding requires the same PostgreSQL source.");
      }
      if (!reviewed.tenant_setting) {
        throw new Error("SEMANTIC_ACTION_READ_SCOPE_UNSUPPORTED: this Action runtime requires a reviewed tenant RLS setting alongside principal-only RLS. Review the source binding; no setting was invented.");
      }
      const binding = { mode: "postgres_rls" as const, ...reviewed, tenant_setting: reviewed.tenant_setting };
      const existing = bindings.get(rule.verification_boundary.source) ?? source.database_scope;
      if (existing !== undefined && canonicalJsonDigest(existing) !== canonicalJsonDigest(binding)) {
        throw new Error("SEMANTIC_ACTION_READ_SCOPE_MISMATCH: the Action source has conflicting reviewed RLS session settings. Review that source binding; no configuration was changed.");
      }
      bindings.set(rule.verification_boundary.source, binding);
    }
  }
  for (const [source, binding] of bindings) sources![source]!.database_scope = binding;
  return next;
}
