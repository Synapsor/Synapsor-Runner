import { describe, expect, it, vi } from "vitest";
import {
  assertSoakHasNoUnexpectedErrors,
  assertSoakOperationCoverage,
  assertSoakProcessResourcesBounded,
  assertSoakServerAlive,
  closeStreamableHttpClientHandle,
  expectedStandaloneQueryAuditRange,
  summarizeExploreToolCalls,
} from "./production-explore-http-soak.mjs";

describe("production Explore soak release gate", () => {
  it("requires exactly zero unexpected errors even below the former percentage threshold", () => {
    expect(assertSoakHasNoUnexpectedErrors({
      requests: 2_000,
      unexpected_errors: 0,
      security_failures: 0,
    })).toBe(0);
    expect(() => assertSoakHasNoUnexpectedErrors({ requests: 2_000, unexpected_errors: 1 }))
      .toThrow(/recorded 1 unexpected error.*0\.050%/i);
    expect(() => assertSoakHasNoUnexpectedErrors({
      requests: 2_000,
      unexpected_errors: 0,
      security_failures: 1,
    })).toThrow(/recorded 1 security failure/i);
    expect(() => assertSoakHasNoUnexpectedErrors({ requests: 0, unexpected_errors: 0 }))
      .toThrow(/without sending a request/i);
  });

  it("requires every configured operation family to execute", () => {
    expect(assertSoakOperationCoverage({
      catalog: { attempted: 3 },
      grouped_count: { attempted: 10 },
      deliberate_refusal: { attempted: 2 },
    })).toEqual({
      pass: true,
      operations: ["catalog", "deliberate_refusal", "grouped_count"],
    });
    expect(() => assertSoakOperationCoverage({
      catalog: { attempted: 1 },
      relative_window: { attempted: 0 },
    })).toThrow(/did not execute: relative_window/i);
    expect(() => assertSoakOperationCoverage({})).toThrow(/no configured operation coverage/i);
  });

  it("separates handler refusals from strict MCP schema refusals in the audit gate", () => {
    expect(expectedStandaloneQueryAuditRange({
      accepted: { expected_refusals: 0, audit_expectation: "evidence_bundle" },
      reviewed_value_refusal: { expected_refusals: 75, audit_expectation: "query_audit" },
      model_scope_refusal: { expected_refusals: 42, audit_expectation: "pre_handler_no_query_audit" },
    })).toEqual({
      minimum: 75,
      maximum: 75,
      handler_refusals: 75,
      strict_schema_refusals: 42,
      additional_unclassified_refusals: 0,
    });
    expect(expectedStandaloneQueryAuditRange({
      reviewed_value_refusal: { expected_refusals: 75, audit_expectation: "query_audit" },
    }, 3)).toMatchObject({ minimum: 75, maximum: 78 });
  });

  it("fails on unbounded process growth while allowing concurrent-session descriptor headroom", () => {
    const healthy = {
      samples: 100,
      first: { rss_kib: 250_000, threads: 18, file_descriptors: 50 },
      last: { rss_kib: 285_000, threads: 18, file_descriptors: 72 },
      first_quarter_median_rss_kib: 260_000,
      last_quarter_median_rss_kib: 285_000,
      max_rss_kib: 300_000,
      max_peak_rss_kib: 305_000,
      max_threads: 18,
      max_file_descriptors: 100,
    };
    expect(assertSoakProcessResourcesBounded({ process: healthy, active_clients: 20 }))
      .toMatchObject({ pass: true, descriptor_ceiling: 142 });
    expect(() => assertSoakProcessResourcesBounded({
      process: { ...healthy, last_quarter_median_rss_kib: 400_000 },
      active_clients: 20,
    })).toThrow(/sustained RSS grew/i);
    expect(() => assertSoakProcessResourcesBounded({
      process: { ...healthy, max_peak_rss_kib: 520_000 },
      active_clients: 20,
    })).toThrow(/peak RSS grew/i);
    expect(() => assertSoakProcessResourcesBounded({
      process: { ...healthy, max_threads: 27 },
      active_clients: 20,
    })).toThrow(/threads reached 27/i);
    expect(() => assertSoakProcessResourcesBounded({
      process: { ...healthy, max_file_descriptors: 143 },
      active_clients: 20,
    })).toThrow(/file descriptors reached 143/i);
  });
});

const sample = (processes) => ({
  at: "2026-08-10T00:00:00.000Z",
  processes,
  rss_kib: 100,
  peak_rss_kib: 100,
  threads: 2,
  file_descriptors: 3,
});

describe("production Explore soak server monitor", () => {
  it("retains the initial process count while the server group is healthy", () => {
    expect(assertSoakServerAlive({ process_sample: sample(2) })).toBe(2);
    expect(assertSoakServerAlive({ process_sample: sample(2), expected_processes: 2 })).toBe(2);
  });

  it("fails immediately when the launched CLI reports an exit", () => {
    expect(() => assertSoakServerAlive({
      exit_state: { code: null, signal: "SIGTERM", at: "2026-08-10T00:01:00.000Z" },
      process_sample: sample(1),
      expected_processes: 2,
    })).toThrow("server process exited during soak (SIGTERM)");
  });

  it("fails when the process group disappears or changes size", () => {
    expect(() => assertSoakServerAlive({ expected_processes: 2 }))
      .toThrow("process group disappeared during soak");
    expect(() => assertSoakServerAlive({ process_sample: sample(1), expected_processes: 2 }))
      .toThrow("process group changed from 2 to 1 processes");
  });
});

describe("production Explore soak client lifecycle", () => {
  it("terminates the remote Streamable HTTP session before closing the local client", async () => {
    const calls = [];
    const handle = {
      transport: {
        terminateSession: vi.fn(async () => { calls.push("terminate"); }),
      },
      client: {
        close: vi.fn(async () => { calls.push("close"); }),
      },
    };

    await expect(closeStreamableHttpClientHandle(handle)).resolves.toBeUndefined();
    expect(calls).toEqual(["terminate", "close"]);
  });

  it("still closes the local client when remote session termination fails", async () => {
    const close = vi.fn(async () => undefined);
    const failure = new Error("session termination failed");
    const handle = {
      transport: { terminateSession: vi.fn(async () => { throw failure; }) },
      client: { close },
    };

    await expect(closeStreamableHttpClientHandle(handle)).rejects.toThrow("session termination failed");
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("production Explore local-model accounting", () => {
  it("counts every successful Explore execution inside one accepted question", () => {
    const first = { tool: "app.explore_data", status: "ok", arguments: { plan: { kind: "aggregate" } } };
    const refused = { tool: "app.explore_data", status: "refused", error_code: "LOCAL_PLAN_INTENT_MISMATCH" };
    const second = { tool: "app.explore_data", status: "ok", arguments: { plan: { kind: "aggregate" } } };
    const summary = summarizeExploreToolCalls([
      { tool: "app.describe_data", status: "ok" },
      first,
      refused,
      second,
    ]);

    expect(summary.successful).toEqual([first, second]);
    expect(summary.refused).toEqual([refused]);
    expect(summary.last_successful).toBe(second);
    expect(summary.last_refused).toBe(refused);
    expect(summary.refused).toHaveLength(1);
  });
});
