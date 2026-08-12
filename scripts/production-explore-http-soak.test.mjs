import { describe, expect, it, vi } from "vitest";
import {
  assertSoakServerAlive,
  closeStreamableHttpClientHandle,
  summarizeExploreToolCalls,
} from "./production-explore-http-soak.mjs";

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
  });
});
