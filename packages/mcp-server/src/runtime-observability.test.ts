import { describe, expect, it, vi } from "vitest";
import { withPostgresReadinessClient } from "./runtime-observability.js";

describe("withPostgresReadinessClient", () => {
  it("ends the pool when the initial connection fails", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const pool = {
      connect: vi.fn().mockRejectedValue(new Error("connect failed")),
      end,
    };

    await expect(withPostgresReadinessClient(pool as never, async () => undefined))
      .rejects.toThrow("connect failed");
    expect(end).toHaveBeenCalledOnce();
  });

  it("preserves the readiness failure while still releasing all resources", async () => {
    const release = vi.fn(() => { throw new Error("release failed"); });
    const end = vi.fn().mockRejectedValue(new Error("end failed"));
    const pool = {
      connect: vi.fn().mockResolvedValue({ release }),
      end,
    };

    await expect(withPostgresReadinessClient(pool as never, async () => {
      throw new Error("ledger unavailable");
    })).rejects.toThrow("ledger unavailable");
    expect(release).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });
});
