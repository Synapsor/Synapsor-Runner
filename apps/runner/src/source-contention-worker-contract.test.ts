import { describe, it, expect } from "vitest";
import { isRetryableWritebackCode, workerFailureRecovery } from "./worker-runtime.js";

describe("typed source contention worker contract", () => {
  const codes = ["SOURCE_DEADLOCK", "SOURCE_LOCK_UNAVAILABLE", "SOURCE_LOCK_TIMEOUT"] as const;
  it.each(codes.flatMap(code => ["legacy", "supervised_worker"].map(mode => ({ code, mode }))))(
    "retains existing contention retry eligibility $code/$mode", ({ code, mode }) => {
      expect(isRetryableWritebackCode(code, mode as "legacy" | "supervised_worker")).toBe(true);
    });
  it.each([ ["SOURCE_DEADLOCK", "deadlock"], ["SOURCE_LOCK_UNAVAILABLE", "lock"], ["SOURCE_LOCK_TIMEOUT", "lock-wait timeout"] ])(
    "shows a bounded specific safe cause %s", (code, cause) => {
      const result = workerFailureRecovery(code);
      expect(result).toContain(cause);
      expect(result).toContain("Existing retry");
      expect(result).not.toMatch(/no effect|source unchanged|fresh request|raise|reset|requeue/);
    });
  it.each(codes)("uncertainty takes precedence over %s", code => {
    const result = workerFailureRecovery(code, "reconciliation_required");
    expect(result).toContain("Do not retry or requeue");
    expect(result).not.toContain("Existing retry");
  });
  it.each(codes)("discarded state remains closed for %s", code => {
    expect(workerFailureRecovery(code, "discarded")).toContain("Closed/discarded work will not retry");
  });
  it.each(codes)("blocked state still needs producer-proof review for %s", code => {
    expect(workerFailureRecovery(code, "blocked")).toContain("only producer-proven no-effect work can close");
  });
  it.each(["SOURCE_DEADLOCK_PRIVATE", "deadlock", "55P03", "ER_LOCK_DEADLOCK"])(
    "does not grant retry or presentation by fragments %s", code => {
      expect(isRetryableWritebackCode(code, "supervised_worker")).toBe(false);
      expect(workerFailureRecovery(code)).toBeUndefined();
    });
});
