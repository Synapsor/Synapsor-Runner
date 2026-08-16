import { describe, expect, it, vi } from "vitest";
import { runRuntimeCleanups } from "./runtime-composition.js";

describe("runRuntimeCleanups", () => {
  it("keeps closing resources after an earlier ordered cleanup fails", async () => {
    const stopSync = vi.fn().mockRejectedValue(new Error("sync stop failed"));
    const closeResources = vi.fn().mockResolvedValue(undefined);
    const closeStore = vi.fn().mockResolvedValue(undefined);

    await expect(runRuntimeCleanups([stopSync, closeResources, closeStore]))
      .rejects.toThrow("sync stop failed");
    expect(stopSync).toHaveBeenCalledOnce();
    expect(closeResources).toHaveBeenCalledOnce();
    expect(closeStore).toHaveBeenCalledOnce();
    expect(stopSync.mock.invocationCallOrder[0]).toBeLessThan(closeResources.mock.invocationCallOrder[0]!);
    expect(closeResources.mock.invocationCallOrder[0]).toBeLessThan(closeStore.mock.invocationCallOrder[0]!);
  });

  it("reports all shutdown failures", async () => {
    await expect(runRuntimeCleanups([
      async () => { throw new Error("resource close failed"); },
      async () => { throw new Error("store close failed"); },
    ])).rejects.toMatchObject({
      message: "Runner runtime resources did not all close cleanly.",
      errors: [
        expect.objectContaining({ message: "resource close failed" }),
        expect.objectContaining({ message: "store close failed" }),
      ],
    });
  });
});
