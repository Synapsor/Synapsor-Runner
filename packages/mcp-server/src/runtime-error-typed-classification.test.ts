import { describe, expect, it } from "vitest";
import { McpRuntimeError, isTransientInfrastructureError, safeRuntimeErrorCode, safeToolError } from "./runtime-errors.js";
import { classifyFreshnessReadError } from "./proposal-freshness.js";

describe("typed infrastructure and freshness outcomes", () => {
  it.each(["connection pool is full", "ECONNREFUSED", "database is shutting down", "operation timed out"])(
    "does not infer retry permission from error prose: %s", message => {
      const error = new Error(message);
      expect(isTransientInfrastructureError(error)).toBe(false);
      expect(safeToolError(error)).toMatchObject({ code: "INTERNAL", retryable: false });
      expect(safeRuntimeErrorCode(error)).toBe("UNCLASSIFIED");
      expect(classifyFreshnessReadError(error)).toEqual({ result: "invalid", safe_code: "FRESHNESS_CHECK_FAILED" });
      expect(JSON.stringify(safeToolError(error))).not.toContain(message);
    });

  it.each([
    { code: "ECONNRESET" }, { code: "53300" }, { code: "08006" },
    { sqlState: "08001" }, { sqlstate: "08P01" }, { code: "ER_LOCK_WAIT_TIMEOUT" }, { errno: 1213 },
  ])("retains exact driver facts %j independently of prose", facts => {
    const error = Object.assign(new Error("no business interpretation is available"), facts);
    expect(isTransientInfrastructureError(error)).toBe(true);
    expect(safeToolError(error)).toMatchObject({ code: "TEMPORARILY_UNAVAILABLE", retryable: true });
    expect(classifyFreshnessReadError(error)).toEqual({ result: "unavailable", safe_code: "FRESHNESS_TEMPORARILY_UNAVAILABLE" });
  });

  it.each(["08", "08 private fact", "080060", "APPROVAL_UNSUPPORTED", "SOME_CONNECTION_RULE"])(
    "does not classify malformed or unrelated codes by fragments: %s", code => {
      const error = Object.assign(new Error("connection pool is full"), { code });
      expect(isTransientInfrastructureError(error)).toBe(false);
      expect(safeRuntimeErrorCode(error)).toBe("UNCLASSIFIED");
      expect(classifyFreshnessReadError(error)).toEqual({ result: "invalid", safe_code: "FRESHNESS_CHECK_FAILED" });
    });

  it("preserves typed host limits, bounded causal traversal and exact topology refusal", () => {
    const wrapped = new Error("private arbitrary details", {
      cause: new McpRuntimeError("SOURCE_POOL_TIMEOUT", "non-English wording", { retry_after_ms: 91_000 }),
    });
    expect(isTransientInfrastructureError(wrapped)).toBe(true);
    expect(safeToolError(wrapped)).toMatchObject({ retryable: true, retry_after_ms: 60_000 });
    expect(classifyFreshnessReadError(wrapped)).toEqual({ result: "unavailable", safe_code: "FRESHNESS_TEMPORARILY_UNAVAILABLE" });
    expect(classifyFreshnessReadError(new McpRuntimeError("FRESHNESS_CROSS_SOURCE_UNSUPPORTED", "unrelated wording")))
      .toEqual({ result: "unsupported", safe_code: "FRESHNESS_TOPOLOGY_UNSUPPORTED" });
    const cycle = Object.assign(new Error("timeout"), { cause: undefined as unknown }); cycle.cause = cycle;
    expect(isTransientInfrastructureError(cycle)).toBe(false);
  });
});
