import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { newPolicySourceSession, policyTextSnapshot, savePolicySources, loadPolicySources,
  PolicySourceChangedError, PolicySourceSaveUncertainError } from "./authoring-policy-source.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-source-ack-")); roots.push(root);
  const session = newPolicySourceSession();
  session.snapshots = [policyTextSnapshot(Buffer.from("Original complete rules."), "Rules.txt"),
    policyTextSnapshot(Buffer.from("Retained replacement rules."), "Rules.txt", 2)];
  session.active = 1;
  session.approvals = [{ digest: session.snapshots[0]!.digest, destination: "offline-original-model" },
    { digest: session.snapshots[1]!.digest, destination: "offline-other-model" }];
  session.operator_messages = ["The original complete business answer."];
  return { root, session, file: path.join(root, ".synapsor/boundary-authoring/policy-sources", `${session.id}.json`) };
}

describe("corresponding Source writer acknowledgement", () => {
  it("returns only the actual path and full persisted session, with deeply frozen acknowledgement data", async () => {
    const { root, session, file } = await fixture();
    const expected = JSON.parse(JSON.stringify(session));
    const result = await savePolicySources(root, session, { expectedDigest: null });
    expect(result).toMatchObject({ outcome: { state: "acknowledged", reference: {
      path: file, session_id: session.id, revision_digest: canonicalJsonDigest(expected),
    } }, savedSession: expected });
    expect(result.outcome.reference.revision_digest).not.toBe(session.snapshots[0]!.digest);
    expect(await fs.readFile(file, "utf8")).toBe(JSON.stringify(expected));
    expect(await loadPolicySources(root, session.id)).toEqual(result.savedSession);
    expect(Reflect.set(result.savedSession, "active", 2)).toBe(false);
    expect(Reflect.set(result.savedSession.approvals[0]!, "destination", "changed")).toBe(false);
    expect(Reflect.set(result.outcome.reference, "revision_digest", canonicalJsonDigest("unrelated"))).toBe(false);
  });

  it("captures the invocation session before a caller mutates it across an await", async () => {
    const { root, session, file } = await fixture();
    const expected = structuredClone(session);
    const pending = savePolicySources(root, session, { expectedDigest: null });
    session.operator_messages!.push("A later answer not submitted by this invocation.");
    const result = await pending;
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(expected);
    expect(result.savedSession).toEqual(expected);
    expect(result.outcome.reference.revision_digest).toBe(canonicalJsonDigest(expected));
  });

  it("captures the original CAS and material callback before a caller changes its options", async () => {
    const { root, session } = await fixture();
    const original = vi.fn(async () => {}), replacement = vi.fn(async () => {});
    const options: { expectedDigest: string | null; assertCurrentMaterial: typeof original } = { expectedDigest: null, assertCurrentMaterial: original };
    const pending = savePolicySources(root, session, options);
    options.expectedDigest = canonicalJsonDigest("unrelated revision"); options.assertCurrentMaterial = replacement;
    expect((await pending).outcome.state).toBe("acknowledged");
    expect(original).toHaveBeenCalledTimes(2); expect(replacement).not.toHaveBeenCalled();
  });

  it.each(["cas", "material"] as const)("preserves the original %s rejection and prior Source", async reason => {
    const { root, session, file } = await fixture(); await savePolicySources(root, session);
    const before = await fs.readFile(file, "utf8"), rejection = new Error("native material rejection");
    const next = structuredClone(session); next.operator_messages!.push("The refused new answer.");
    const pending = reason === "cas"
      ? savePolicySources(root, next, { expectedDigest: canonicalJsonDigest("other") })
      : savePolicySources(root, next, { expectedDigest: canonicalJsonDigest(session), assertCurrentMaterial: async () => { throw rejection; } });
    if (reason === "cas") await expect(pending).rejects.toBeInstanceOf(PolicySourceChangedError);
    else await expect(pending).rejects.toBe(rejection);
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  it.each(["unavailable", "mismatch"] as const)("retains the actual write without acknowledgement when its readback is %s", async failure => {
    const { root, session, file } = await fixture();
    const read = fs.readFile.bind(fs), rename = fs.rename.bind(fs); let replaced = false;
    const replacement = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to); replaced = true;
    });
    const readback = vi.spyOn(fs, "readFile").mockImplementation(async (target, options) => {
      if (replaced && target === file) {
        if (failure === "unavailable") throw Object.assign(new Error("native read unavailable"), { code: "EIO" });
        return Buffer.from(JSON.stringify({ ...session, operator_messages: ["Different current file is not this write's acknowledgement."] }));
      }
      return read(target, options);
    });
    let rejected: unknown;
    try { await savePolicySources(root, session, { expectedDigest: null }); } catch (error) { rejected = error; }
    readback.mockRestore();
    expect(rejected).toBeDefined();
    expect(rejected).toBeInstanceOf(PolicySourceSaveUncertainError);
    expect(rejected).toMatchObject({ code: "POLICY_SOURCE_SAVE_UNCERTAIN", stage: "readback" });
    expect(rejected).toMatchObject({ cause: { message: failure === "unavailable" ? "native read unavailable" : "Source readback differs from this invocation's captured bytes." } });
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(await loadPolicySources(root, session.id)).toEqual(session);
    await expect(fs.stat(path.join(root, ".synapsor/boundary-authoring/resume.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
