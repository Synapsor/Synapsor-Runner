import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSemanticAdapterConformanceVector } from "@synapsor-runner/action-rules";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { sourceCompletionBinding, type RunnerConfig } from "@synapsor-runner/worker-core";

const job = createSemanticAdapterConformanceVector("postgres").job;
function config(databaseUrl: string): RunnerConfig {
  return { controlPlaneUrl: "http://unused.invalid", runnerToken: "unused", runnerId: "binding-test",
    sourceId: job.source_id, databaseUrl, engine: "postgres", pollIntervalMs: 1, logLevel: "error",
    dryRun: false, stateDir: "/unused", receipts: { authority: "source_db", provisioning: "precreated", schema: "receipt_test" },
    sourceCompletionAdmission: { execution_binding_digest: canonicalJsonDigest({ declared: "test admission" }), writer_reference: "DECLARED_WRITER" } };
}
function nativeParameters(url: string) {
  const client = new Client({ connectionString: url });
  // Inspect the real pg parser without connecting, selecting, or claiming authority.
  return (client as unknown as { connectionParameters: { user: string; port: number } }).connectionParameters;
}
afterEach(() => vi.unstubAllEnvs());

describe("Source completion destination binding", () => {
  it("refuses a missing URL user that native pg resolves from ambient PGUSER", () => {
    const url = "postgresql://localhost:5432/declared_fixture";
    vi.stubEnv("PGUSER", "ambient_a");
    const first = nativeParameters(url).user;
    const firstBinding = sourceCompletionBinding(job, config(url));
    vi.stubEnv("PGUSER", "ambient_b");
    expect(nativeParameters(url).user).not.toBe(first);
    expect(firstBinding).toBeUndefined();
    expect(sourceCompletionBinding(job, config(url))).toBeUndefined();
  });

  it("refuses a missing URL port that native pg resolves from ambient PGPORT", () => {
    const url = "postgresql://declared_writer@localhost/declared_fixture";
    vi.stubEnv("PGPORT", "5433");
    const first = nativeParameters(url).port;
    const firstBinding = sourceCompletionBinding(job, config(url));
    vi.stubEnv("PGPORT", "5434");
    expect(nativeParameters(url).port).not.toBe(first);
    expect(firstBinding).toBeUndefined();
    expect(sourceCompletionBinding(job, config(url))).toBeUndefined();
  });

  it("binds an explicit native user and port independently of ambient drift", () => {
    const url = "postgresql://declared_writer@localhost:5432/declared_fixture";
    vi.stubEnv("PGUSER", "ambient_a"); vi.stubEnv("PGPORT", "5433");
    const first = sourceCompletionBinding(job, config(url));
    expect(first).toBeDefined();
    expect(nativeParameters(url)).toMatchObject({ user: "declared_writer", port: 5432 });
    vi.stubEnv("PGUSER", "ambient_b"); vi.stubEnv("PGPORT", "5434");
    expect(nativeParameters(url)).toMatchObject({ user: "declared_writer", port: 5432 });
    expect(sourceCompletionBinding(job, config(url))).toEqual(first);
  });
});
