import { describe, expect, it } from "vitest";
import { assertSoakServerAlive } from "./production-explore-http-soak.mjs";

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
