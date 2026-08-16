import { describe, expect, it, vi } from "vitest";
import { runAllCleanups, withPreservedCleanup } from "./resource-lifecycle.js";

describe("withPreservedCleanup", () => {
  it("returns the operation result and always cleans up", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);

    await expect(withPreservedCleanup(async () => "ok", cleanup)).resolves.toBe("ok");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("preserves an operation error when cleanup also fails", async () => {
    await expect(withPreservedCleanup(
      async () => { throw new Error("source unavailable"); },
      async () => { throw new Error("cleanup failed"); },
    )).rejects.toThrow("source unavailable");
  });

  it("reports a cleanup error after a successful operation", async () => {
    await expect(withPreservedCleanup(
      async () => "ok",
      async () => { throw new Error("cleanup failed"); },
    )).rejects.toThrow("cleanup failed");
  });
});

describe("runAllCleanups", () => {
  it("attempts every cleanup when an earlier cleanup throws", async () => {
    const first = vi.fn(() => { throw new Error("release failed"); });
    const second = vi.fn().mockResolvedValue(undefined);

    await expect(runAllCleanups([first, second], "cleanup failed"))
      .rejects.toThrow("release failed");
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it("reports every cleanup failure", async () => {
    await expect(runAllCleanups([
      async () => { throw new Error("release failed"); },
      async () => { throw new Error("pool end failed"); },
    ], "cleanup failed")).rejects.toMatchObject({
      message: "cleanup failed",
      errors: [
        expect.objectContaining({ message: "release failed" }),
        expect.objectContaining({ message: "pool end failed" }),
      ],
    });
  });
});
