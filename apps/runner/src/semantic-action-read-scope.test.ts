import { describe, expect, it } from "vitest";
import { bindSemanticReadScope } from "./semantic-action-read-scope.js";
import type { ActionRuleAuthorityV1 } from "@synapsor-runner/action-rules";
import type { ActivatedExplorationBoundary } from "./auto-boundary.js";
import { resolveSemanticSupervisedWriterSource, type RuntimeConfig } from "@synapsor-runner/mcp-server";

const digest = `sha256:${"a".repeat(64)}`;
const scope = { tenant_setting: "app.account", principal_setting: "app.member" };
const rules = [{ read_boundary_name: "customer", read_boundary_digest: digest,
  verification_boundary: { source: "source", resources: [{ resource: "app.offers" }, { resource: "app.subscriptions" }] },
}] as ActionRuleAuthorityV1["rules"];
const reads = [{ activation: { digest }, pack: { name: "customer", resources: [
  { id: "app.offers", rls_session: scope }, { id: "app.subscriptions", rls_session: scope },
] } }] as ActivatedExplorationBoundary[];

describe("semantic Action reviewed Read scope", () => {
  it("never overwrites another compiled source's reviewed scope and refuses an ambiguous shared alias", () => {
    const source = { engine: "postgres", read_url_env: "DATABASE_URL", read_only: false,
      write_url_env: "FIRST_WRITER_URL", receipts: { authority: "runner_ledger" } };
    const otherScope = { ...scope, tenant_setting: "other.account" };
    const jointRules = [...rules, { ...rules[0]!, read_boundary_name: "other",
      verification_boundary: { ...rules[0]!.verification_boundary, source: "other" } }];
    const jointReads = [...reads, { ...reads[0]!, pack: { ...reads[0]!.pack, name: "other",
      resources: reads[0]!.pack.resources.map((resource) => ({ ...resource, rls_session: otherScope })) } }];
    const config = { sources: { source, other: { ...source, write_url_env: "OTHER_WRITER_URL" } } };
    const next = bindSemanticReadScope(config, jointRules, jointReads) as unknown as RuntimeConfig;
    expect(next.sources!.source!.database_scope).toEqual({ mode: "postgres_rls", ...scope });
    expect(next.sources!.other!.database_scope).toEqual({ mode: "postgres_rls", ...otherScope });
    const ambiguous = { sources: { ...config.sources, alias: { ...source, write_url_env: "ALIAS_WRITER_URL" } } };
    const before = structuredClone(ambiguous);
    expect(() => bindSemanticReadScope(ambiguous, jointRules, jointReads)).toThrow(/READ_SCOPE_MISMATCH/);
    expect(ambiguous).toEqual(before);
  });

  it("restores the exact reviewed scope to existing equivalent writer aliases without changing writer references", () => {
    const source = { engine: "postgres", read_url_env: "DATABASE_URL", read_only: false,
      write_url_env: "FIRST_WRITER_URL", receipts: { authority: "runner_ledger" } };
    const config = { sources: { source, second: { ...source, write_url_env: "SECOND_WRITER_URL" } } };
    const next = bindSemanticReadScope(config, rules, reads) as unknown as RuntimeConfig;
    expect(next.sources!.source!.database_scope).toEqual({ mode: "postgres_rls", ...scope });
    expect(resolveSemanticSupervisedWriterSource(next, "source", { write_url_env: "SECOND_WRITER_URL" }))
      .toEqual({ ...config.sources.second, database_scope: { mode: "postgres_rls", ...scope } });
    expect(bindSemanticReadScope(next as unknown as Record<string, unknown>, rules, reads)).toEqual(next);
    expect(config.sources.source).not.toHaveProperty("database_scope");
  });

  it.each([
    { read_url_env: "FOREIGN_DATABASE_URL" }, { receipts: { authority: "source_db" } },
    { database_scope: { mode: "postgres_rls", tenant_setting: "foreign.account" } },
  ])("does not repair a conflicting writer alias (%j)", (change) => {
    const source = { engine: "postgres", read_url_env: "DATABASE_URL", read_only: false,
      write_url_env: "FIRST_WRITER_URL", receipts: { authority: "runner_ledger" } };
    const second = { ...source, write_url_env: "SECOND_WRITER_URL", ...change };
    const next = bindSemanticReadScope({ sources: { source, second } }, rules, reads) as unknown as RuntimeConfig;
    expect(next.sources!.second).toEqual(second);
    expect(resolveSemanticSupervisedWriterSource(next, "source", { write_url_env: "SECOND_WRITER_URL" })).toBeUndefined();
  });

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
