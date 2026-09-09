import { describe, expect, it } from "vitest";
import { resolveSemanticSupervisedWriterSource } from "./capability-authority.js";
import type { RuntimeConfig, RuntimeSourceConfig, RuntimeSupervisedWorkerOutcomePolicy } from "./runtime-types.js";

const policy = { write_url_env: "SECOND_WRITER_URL" } as RuntimeSupervisedWorkerOutcomePolicy;
function fixture(): RuntimeConfig {
  const source: RuntimeSourceConfig = { engine: "postgres", read_url_env: "READER_URL", read_only: false,
    write_url_env: "FIRST_WRITER_URL", database_scope: { mode: "postgres_rls", tenant_setting: "app.tenant", principal_setting: "app.principal" },
    credential_scope: { mode: "shared" }, statement_timeout_ms: 2000, receipts: { authority: "runner_ledger" } };
  return { version: 1, mode: "review", capabilities: [], sources: { reviewed: source,
    second_writer: { ...structuredClone(source), write_url_env: policy.write_url_env } } };
}

describe("semantic writer source binding", () => {
  it("uses only the exact configured writer and retains every non-writer setting", () => {
    const config = fixture();
    expect(resolveSemanticSupervisedWriterSource(config, "reviewed", policy)).toBe(config.sources!.second_writer);
    expect(resolveSemanticSupervisedWriterSource(config, "reviewed", { ...policy, write_url_env: "FIRST_WRITER_URL" }))
      .toBe(config.sources!.reviewed);
    expect(resolveSemanticSupervisedWriterSource(config, "missing", policy)).toBeUndefined();
  });

  it.each([
    ["read_url_env", "OTHER_DATABASE_URL"], ["engine", "mysql"], ["read_only", true],
    ["database_scope", { mode: "application" }],
    ["database_scope", { mode: "postgres_rls", tenant_setting: "other.tenant", principal_setting: "app.principal" }],
    ["credential_scope", { mode: "tenant_resolver", resolver: "different" }],
    ["receipts", { authority: "source_db", provisioning: "precreated", schema: "other", table: "receipts" }],
    ["statement_timeout_ms", 9000], ["pool", { max_connections: 30 }], ["write_url_env", "UNREVIEWED_WRITER_URL"],
  ])("refuses an alias changing %s", (key, value) => {
    const config = fixture();
    Object.assign(config.sources!.second_writer!, { [key as string]: value });
    expect(resolveSemanticSupervisedWriterSource(config, "reviewed", policy)).toBeUndefined();
  });

  it("refuses missing and ambiguous aliases, including an unrelated source sharing that writer reference", () => {
    const config = fixture();
    config.sources!.duplicate = structuredClone(config.sources!.second_writer!);
    expect(resolveSemanticSupervisedWriterSource(config, "reviewed", policy)).toBeUndefined();
    config.sources!.duplicate.read_url_env = "OTHER_READER_URL";
    expect(resolveSemanticSupervisedWriterSource(config, "reviewed", policy)).toBeUndefined();
    delete config.sources!.duplicate;
    delete config.sources!.second_writer;
    expect(resolveSemanticSupervisedWriterSource(config, "reviewed", policy)).toBeUndefined();
  });

  it("cannot turn a read-only or unconfigured compiled source into execution authority", () => {
    const config = fixture();
    config.sources!.reviewed!.read_only = true;
    expect(resolveSemanticSupervisedWriterSource(config, "reviewed", policy)).toBeUndefined();
    config.sources!.reviewed!.read_only = false;
    delete config.sources!.reviewed!.write_url_env;
    expect(resolveSemanticSupervisedWriterSource(config, "reviewed", policy)).toBeUndefined();
  });
});
