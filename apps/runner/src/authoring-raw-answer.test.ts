import { describe, expect, it, vi } from "vitest";
import { readCurrentAuthoringRawAnswer } from "./authoring-raw-answer.js";

describe("raw business answer ownership", () => {
  it.each(["Why wait? Allow it after two reviewers approve.", "How often? Three times per day.", "retry", "  keep these exact words\n", "", undefined])("returns %j without language-based routing", async answer => {
    const assertCurrent = vi.fn(async () => {});
    const read = vi.fn(async () => answer);
    expect(await readCurrentAuthoringRawAnswer({ assertCurrent, read })).toBe(answer);
    expect(read).toHaveBeenCalledOnce();
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });
  it("does not read when the displayed question was already stale", async () => {
    const read = vi.fn(async () => "yes");
    await expect(readCurrentAuthoringRawAnswer({ read, assertCurrent: async () => { throw new Error("stale"); } })).rejects.toThrow("stale");
    expect(read).not.toHaveBeenCalled();
  });
  it("refuses an answer if currentness changes while the operator is answering", async () => {
    let current = true;
    await expect(readCurrentAuthoringRawAnswer({
      assertCurrent: async () => { if (!current) throw new Error("stale"); },
      read: async () => { current = false; return "yes"; },
    })).rejects.toThrow("stale");
  });
});
