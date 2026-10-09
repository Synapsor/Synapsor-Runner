import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withProjectAuthorityMutation, withHeldProjectAuthorityAccess, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import { loadBoundaryReviewContext, loadBoundaryReviewContextHeld } from "./boundary-review-context.js";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";

const roots: string[] = [];
async function project() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-held-access-")); roots.push(root); return root; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("explicit authority access propagation contract", () => {
  it("diagnoses a dropped permit in its active call chain before attempting reacquisition", async () => {
    const root = await project(), entered = vi.fn(async () => undefined);
    await withProjectAuthorityMutation(root, async () => {
      await expect(withProjectAuthorityMutation(root, entered, { waitMs: 0 }))
        .rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_REQUIRED" });
    });
    expect(entered).not.toHaveBeenCalled();
    await expect(withProjectAuthorityMutation(root, async () => "released")).resolves.toBe("released");
  });

  it("detects canonical A-to-B-to-A reacquisition without granting ambient access", async () => {
    const root = await project(), other = await project(), alias = path.join(other, "same-project");
    await fs.symlink(root, alias, "dir");
    await withProjectAuthorityMutation(root, async () => {
      await withProjectAuthorityMutation(other, async () => {
        await expect(withProjectAuthorityMutation(alias, async () => undefined, { waitMs: 0 }))
          .rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_REQUIRED" });
      });
    });
  });

  it("keeps independently initiated same-process contention distinct from missing propagation", async () => {
    const root = await project(), entered = deferred(), release = deferred();
    const holder = withProjectAuthorityMutation(root, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const callback = vi.fn(async () => "next");
    try {
      await expect(withProjectAuthorityMutation(root, callback, { waitMs: 0 }))
        .rejects.toMatchObject({ code: "POLICY_MUTATION_BUSY" });
      expect(callback).not.toHaveBeenCalled();
    } finally { release.resolve(); await holder; }
    await expect(withProjectAuthorityMutation(root, callback)).resolves.toBe("next");
  });

  it("cancels only a genuinely independent waiting acquisition", async () => {
    const root = await project(), entered = deferred(), release = deferred(), controller = new AbortController();
    const holder = withProjectAuthorityMutation(root, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const callback = vi.fn(async () => undefined);
    const contender = withProjectAuthorityMutation(root, callback, { signal: controller.signal });
    const rejected = expect(contender).rejects.toMatchObject({ code: "POLICY_MUTATION_CANCELLED" });
    try { await delay(35); controller.abort(); await rejected; expect(callback).not.toHaveBeenCalled(); }
    finally { release.resolve(); await holder; }
  });

  it("reports the actual native review reader's dropped access without changing its acknowledged state", async () => {
    const root = await project();
    const prepared = await prepareReviewedReadScope(root, {
      resources: ["work.items"], field: "label", review: { allow_reviewed_fields: ["label"] },
    });
    await withProjectAuthorityMutation(root, async () => {
      await expect(loadBoundaryReviewContext(root)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_REQUIRED" });
    });
    expect(await loadBoundaryReviewContext(root)).toEqual(prepared.context);
  });
});

// Compile-time boundary only; never executed and no runtime permit is minted.
function missingHeldArgumentsMustNotCompile(root: string) {
  // @ts-expect-error Required held access cannot be omitted.
  void loadBoundaryReviewContextHeld(root);
  // @ts-expect-error A JSON-shaped object does not carry the runtime brand.
  void loadBoundaryReviewContextHeld(root, { projectRoot: root });
  // @ts-expect-error The common held runner requires the explicit permit and callback.
  void withHeldProjectAuthorityAccess(root, async () => undefined);
}
void missingHeldArgumentsMustNotCompile;

describe("required held access lifecycle", () => {
  it("rejects missing, serialized, forged, expired and foreign handles without entering the callback", async () => {
    const root = await project(), foreign = await project();
    const callback = vi.fn(async () => undefined);
    let expired!: ProjectAuthorityMutationPermit;
    await withProjectAuthorityMutation(root, async permit => {
      expired = permit;
      await expect(withHeldProjectAuthorityAccess(foreign, permit, callback))
        .rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
      for (const invalid of [undefined, null, {}, JSON.parse(JSON.stringify(permit))]) {
        await expect(withHeldProjectAuthorityAccess(root, invalid as ProjectAuthorityMutationPermit, callback))
          .rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
      }
    });
    await expect(withHeldProjectAuthorityAccess(root, expired, callback))
      .rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
    expect(callback).not.toHaveBeenCalled();
  });

  it("requires the actual scoped child for descendants and permits sequential successors", async () => {
    const root = await project(), other = await project(), alias = path.join(other, "alias");
    await fs.symlink(root, alias, "dir");
    await withProjectAuthorityMutation(root, async parent => {
      await withHeldProjectAuthorityAccess(alias, parent, async child => {
        expect(child).not.toBe(parent);
        await expect(withHeldProjectAuthorityAccess(root, parent, async () => undefined))
          .rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
        await expect(withHeldProjectAuthorityAccess(root, child, async () => "descendant")).resolves.toBe("descendant");
      });
      await expect(withHeldProjectAuthorityAccess(root, parent, async () => "successor")).resolves.toBe("successor");
    });
  });

  it("keeps inherited scope detection live while an unawaited child drains, then expires it", async () => {
    const root = await project(), childEntered = deferred(), releaseChild = deferred(), tryDuringDrain = deferred();
    const freshAfterDrain = deferred();
    let child!: Promise<void>, inheritedDuring!: Promise<unknown>, inheritedAfter!: Promise<unknown>;
    let expired!: ProjectAuthorityMutationPermit;
    const parent = withProjectAuthorityMutation(root, async permit => {
      expired = permit;
      inheritedDuring = tryDuringDrain.promise.then(() => withProjectAuthorityMutation(root, async () => "unexpected", { waitMs: 0 }));
      inheritedAfter = freshAfterDrain.promise.then(() => withProjectAuthorityMutation(root, async () => "fresh"));
      child = withHeldProjectAuthorityAccess(root, permit, async () => { childEntered.resolve(); await releaseChild.promise; });
      await childEntered.promise;
    });
    await childEntered.promise;
    await delay(0); // Parent callback has returned, but the actual child is still held.
    try {
      const rejected = expect(inheritedDuring).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_REQUIRED" });
      tryDuringDrain.resolve(); await rejected;
      await expect(withHeldProjectAuthorityAccess(root, expired, async () => undefined))
        .rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
      await expect(withProjectAuthorityMutation(root, async () => undefined, { waitMs: 0 }))
        .rejects.toMatchObject({ code: "POLICY_MUTATION_BUSY" });
    } finally { releaseChild.resolve(); await child; await parent; }
    freshAfterDrain.resolve(); await expect(inheritedAfter).resolves.toBe("fresh");
  });

  it("drains children on throw and preserves prior file effects rather than claiming rollback", async () => {
    const root = await project(), entered = deferred(), release = deferred();
    let child!: Promise<void>;
    const file = path.join(root, "earlier-effect.json");
    const parent = withProjectAuthorityMutation(root, async permit => {
      await fs.writeFile(file, '{"committed":true}');
      child = withHeldProjectAuthorityAccess(root, permit, async () => { entered.resolve(); await release.promise; });
      await entered.promise; throw new Error("later operation failed");
    });
    const rejected = expect(parent).rejects.toThrow("later operation failed");
    await entered.promise;
    await expect(withProjectAuthorityMutation(root, async () => undefined, { waitMs: 0 }))
      .rejects.toMatchObject({ code: "POLICY_MUTATION_BUSY" });
    release.resolve(); await child; await rejected;
    expect(await fs.readFile(file, "utf8")).toBe('{"committed":true}');
    await expect(withProjectAuthorityMutation(root, async () => "released")).resolves.toBe("released");
  });
});
