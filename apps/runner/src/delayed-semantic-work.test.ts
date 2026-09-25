import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { assertDelayedSemanticWorkCurrent, currentDelayedSemanticWork } from "./delayed-semantic-work.js";

const digest = `sha256:${"a".repeat(64)}` as const;
const start = "2026-09-24T00:00:00.000Z";

function fixture(): RuntimeConfig {
  return {
    version: 1, mode: "review", storage: { sqlite_path: ".synapsor/local.db" },
    sources: { source: { engine: "postgres", read_url_env: "DATABASE_URL", write_url_env: "WRITE_URL",
      receipts: { authority: "source_db", provisioning: "precreated", schema: "public", table: "receipts" } } },
    capabilities: [],
    supervised_worker: { enabled: true, profile: "staging", capabilities: [], outcomes: [{
      outcome: "example.finalize", action_boundary_digest: digest, mode: "supervised_worker",
      concurrency: 1, queue_limit: 10, lease_seconds: 60, max_attempts: 1, proposal_ttl_seconds: 3_600,
      rate_limit: { executions: 10, window_seconds: 60 }, write_url_env: "WRITE_URL",
      delayed_work: { mode: "reverify_exact_operation", approval_wait_seconds: 1_800,
        approval_validity_seconds: 1_200, absolute_request_age_seconds: 3_600, max_validation_attempts: 4 },
    }] },
  } as RuntimeConfig;
}

describe("reviewed delayed semantic work", () => {
  it("allows the same request past the old proof age only within its fixed waiting and mandate bounds", () => {
    const config = fixture();
    const current = currentDelayedSemanticWork({ config, outcome: "example.finalize",
      action_boundary_digest: digest, source: "source", engine: "postgres" });
    expect(current).toBeDefined();
    const work = { schema_version: "synapsor.delayed-semantic-work.v1" as const, requested_at: start, ...current! };
    const base = { config, delayed_work: work, outcome: "example.finalize",
      action_boundary_digest: digest, source: "source", engine: "postgres" as const };
    expect(() => assertDelayedSemanticWorkCurrent({ ...base, phase: "approval",
      now: "2026-09-24T00:06:00.000Z" })).not.toThrow();
    expect(() => assertDelayedSemanticWorkCurrent({ ...base, phase: "approval",
      now: "2026-09-24T00:30:00.000Z" })).toThrow(/DELAYED_WORK_APPROVAL_EXPIRED/);
    expect(() => assertDelayedSemanticWorkCurrent({ ...base, phase: "dispatch",
      now: "2026-09-24T00:20:00.000Z", approvals: [{ created_at: "2026-09-24T00:05:00.000Z", status: "approved" }] })).not.toThrow();
    expect(() => assertDelayedSemanticWorkCurrent({ ...base, phase: "dispatch",
      now: "2026-09-24T00:25:00.000Z", approvals: [{ created_at: "2026-09-24T00:05:00.000Z", status: "approved" }] })).toThrow(/DELAYED_WORK_MANDATE_EXPIRED/);
    expect(() => assertDelayedSemanticWorkCurrent({ ...base, phase: "dispatch",
      now: "2026-09-24T01:00:00.000Z", approvals: [{ created_at: "2026-09-24T00:50:00.000Z", status: "approved" }] })).toThrow(/DELAYED_WORK_REQUEST_EXPIRED/);
  });

  it("refuses changed execution/receipt bindings and unsupported sources", () => {
    const config = fixture();
    const current = currentDelayedSemanticWork({ config, outcome: "example.finalize",
      action_boundary_digest: digest, source: "source", engine: "postgres" })!;
    const work = { schema_version: "synapsor.delayed-semantic-work.v1" as const, requested_at: start, ...current };
    config.sources!.source!.receipts = { authority: "runner_ledger" };
    expect(() => assertDelayedSemanticWorkCurrent({ config, delayed_work: work, outcome: "example.finalize",
      action_boundary_digest: digest, source: "source", engine: "postgres", phase: "approval",
      now: "2026-09-24T00:06:00.000Z" })).toThrow(/DELAYED_WORK_RECEIPT_REQUIRED/);
    expect(() => currentDelayedSemanticWork({ config: fixture(), outcome: "example.finalize",
      action_boundary_digest: digest, source: "source", engine: "mysql" })).toThrow(/DELAYED_WORK_UNSUPPORTED/);
  });
});
