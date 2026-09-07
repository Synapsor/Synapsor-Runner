import { describe, expect, it } from "vitest";
import { bindSemanticReadScope } from "./semantic-action-read-scope.js";
import type { ActionRuleAuthorityV1 } from "@synapsor-runner/action-rules";
import type { ActivatedExplorationBoundary } from "./auto-boundary.js";

const digest = `sha256:${"a".repeat(64)}`;
const scope = { tenant_setting: "app.account", principal_setting: "app.member" };
const rules = [{ read_boundary_name: "customer", read_boundary_digest: digest,
  verification_boundary: { source: "source", resources: [{ resource: "app.offers" }, { resource: "app.subscriptions" }] },
}] as ActionRuleAuthorityV1["rules"];
const reads = [{ activation: { digest }, pack: { name: "customer", resources: [
  { id: "app.offers", rls_session: scope }, { id: "app.subscriptions", rls_session: scope },
] } }] as ActivatedExplorationBoundary[];

describe("semantic Action reviewed Read scope", () => {
  it("carries exact RLS session bindings without inventing identity or modifying the authority", () => {
    const config = { sources: { source: { engine: "postgres", read_url_env: "DATABASE_URL" } } };
    const before = structuredClone({ config, rules, reads });
    const next = bindSemanticReadScope(config, rules, reads);
    expect(next).toEqual({ sources: { source: { ...config.sources.source, database_scope: { mode: "postgres_rls", ...scope } } } });
    expect({ config, rules, reads }).toEqual(before);
    expect(bindSemanticReadScope(next, rules, reads)).toEqual(next);
  });
  it("refuses mismatched current Read revision, source engine, or configured settings", () => {
    const config = { sources: { source: { engine: "postgres" } } };
    expect(() => bindSemanticReadScope(config, rules, [])).toThrow("READ_SCOPE_STALE");
    expect(() => bindSemanticReadScope(config, rules, [{ ...reads[0]!, activation: { ...reads[0]!.activation, digest: `sha256:${"b".repeat(64)}` } }])).toThrow("READ_SCOPE_STALE");
    expect(() => bindSemanticReadScope({ sources: { source: { engine: "mysql" } } }, rules, reads)).toThrow("READ_SCOPE_MISMATCH");
    expect(() => bindSemanticReadScope({ sources: { source: { engine: "postgres", database_scope: { mode: "postgres_rls", tenant_setting: "wrong.account" } } } }, rules, reads)).toThrow("conflicting");
  });
  it("does not add RLS for ordinary column-scoped resources or silently combine incompatible sessions", () => {
    const config = { sources: { source: { engine: "postgres" } } };
    const ordinary = structuredClone(reads);
    for (const resource of ordinary[0]!.pack.resources) delete resource.rls_session;
    expect(bindSemanticReadScope(config, rules, ordinary)).toEqual(config);
    const incompatible = structuredClone(reads);
    incompatible[0]!.pack.resources[1]!.rls_session = { ...scope, principal_setting: "other.member" };
    expect(() => bindSemanticReadScope(config, rules, incompatible)).toThrow("conflicting");
  });
});
