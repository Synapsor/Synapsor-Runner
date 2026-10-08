import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";
import { saveReadReviewSignoff } from "./authoring-read-review-save.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-signoff-binding-")); roots.push(root);
  const { context } = await prepareReviewedReadScope(root);
  if (!context.progress) throw new Error("Expected real ordinary structural signoff");
  return { root, context, progress: { ...structuredClone(context.progress), revision: context.progress.revision + 1 } };
}

describe("Read signoff actual predecessor boundary", () => {
  it("refuses an inapplicable expected review before its protected save", async () => {
    const { root, context, progress } = await fixture();
    const before = canonicalJsonDigest(await loadBoundaryReviewContext(root));
    const continued = vi.fn();
    const options = { projectRoot: root, context, progress,
      assertBeforeSave: () => { throw new Error("EXACT_SUBJECT_REVIEW_PREDECESSOR_CHANGED"); },
      onReviewSignoff: continued };
    await expect(saveReadReviewSignoff(options)).rejects.toThrow("EXACT_SUBJECT_REVIEW_PREDECESSOR_CHANGED");
    expect(continued).not.toHaveBeenCalled();
    expect(canonicalJsonDigest(await loadBoundaryReviewContext(root))).toBe(before);
  });

  it("reports the actual checked predecessor separately from the acknowledged successor", async () => {
    const { root, context, progress } = await fixture();
    const checked = vi.fn(), continued = vi.fn(async (...args: unknown[]) => {
      const prior = args[2] as typeof context | undefined;
      expect(prior).toBeDefined();
      expect(canonicalJsonDigest(prior)).toBe(canonicalJsonDigest(context));
      const after = args[0] as typeof context;
      expect(after.progress?.revision).toBe(progress.revision);
      expect(prior!.progress?.revision).toBe(progress.revision - 1);
    });
    const options = { projectRoot: root, context, progress, assertBeforeSave: checked, onReviewSignoff: continued };
    await saveReadReviewSignoff(options);
    expect(checked).toHaveBeenCalledOnce();
    expect(continued).toHaveBeenCalledOnce();
  });

  it("still refuses a competing actual native save without continuation or another save", async () => {
    const { root, context, progress } = await fixture();
    await saveReadReviewSignoff({ projectRoot: root, context, progress });
    const current = canonicalJsonDigest(await loadBoundaryReviewContext(root));
    const continued = vi.fn();
    const options = { projectRoot: root, context, progress, assertBeforeSave: () => {}, onReviewSignoff: continued };
    await expect(saveReadReviewSignoff(options)).rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
    expect(continued).not.toHaveBeenCalled();
    expect(canonicalJsonDigest(await loadBoundaryReviewContext(root))).toBe(current);
  });
});
