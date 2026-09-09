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
  return bindSemanticReviewedReadScope(config, rules, reads.map((read) => ({ pack: read.pack, digest: read.activation.digest })));
}

/** Pure binding for a checked draft or active revision; never grants authority. */
export function bindSemanticReviewedReadScope(
  config: Record<string, unknown>,
  rules: ActionRuleAuthorityV1["rules"],
  reads: Array<Pick<ActivatedExplorationBoundary, "pack"> & { digest: string }>,
): Record<string, unknown> {
  const next = structuredClone(config);
  const sources = next.sources as Record<string, Record<string, unknown>> | undefined;
  const bindings = new Map<string, { mode: "postgres_rls"; tenant_setting: string; principal_setting?: string }>();
  for (const rule of rules) {
    const read = reads.find((candidate) => candidate.pack.name === rule.read_boundary_name);
    if (!read || read.digest !== rule.read_boundary_digest) {
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
  const aliases: typeof bindings = new Map();
  const compiledSources = new Set(rules.map((rule) => rule.verification_boundary.source));
  for (const [sourceName, binding] of bindings) {
    const source = sources![sourceName]!;
    // Only already-equivalent credential aliases follow the same reviewed Read binding.
    if (source.read_only !== true && typeof source.write_url_env === "string") {
      for (const [name, alias] of Object.entries(sources!)) {
        if (compiledSources.has(name) || typeof alias.write_url_env !== "string") continue;
        if (canonicalJsonDigest({ ...source, write_url_env: alias.write_url_env }) === canonicalJsonDigest(alias)) {
          const previous = aliases.get(name);
          if (previous && canonicalJsonDigest(previous) !== canonicalJsonDigest(binding)) {
            throw new Error("SEMANTIC_ACTION_READ_SCOPE_MISMATCH: a writer alias matches sources with conflicting reviewed RLS session settings.");
          }
          aliases.set(name, binding);
        }
      }
    }
  }
  for (const [name, binding] of [...bindings, ...aliases]) sources![name]!.database_scope = binding;
  return next;
}
