import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAutoBoundary, generationLockSharedFactsDigest, writeAutoBoundaryArtifacts } from "./auto-boundary.js";
import { createBoundaryReviewProgress } from "./boundary-review-domain.js";
import { readBoundaryReviewProgress, saveBoundaryReviewProgress } from "./boundary-review-persistence.js";
import { resolveAskDeploymentProfile } from "./ask-authority.js";
import { resolveAskAccessGuidance } from "./ask-access-summary.js";
import { prepareBoundaryRescan } from "./boundary-rescan.js";
import { prepareBoundaryResourceReviewMutation } from "./boundary-review-mutation.js";
import { ownedProgramInspection } from "./test-fixtures/owned-authoring-program.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-artifact-consumer-"));
  await fs.chmod(root, 0o700); await fs.mkdir(path.join(root, ".git"), {mode:0o700});
  const build = buildAutoBoundary({inspection:ownedProgramInspection(),sourceEnv:"DATABASE_URL",inspectedSchema:"studio",deploymentProfile:"development",
    project:{root,package_manager:"npm",frameworks:[],schema_inputs:[],database_env_names:["DATABASE_URL"]}});
  await writeAutoBoundaryArtifacts({projectRoot:root,build});
  return {root,build,file:path.join(root,"synapsor/generated/exploration-boundary.draft.json")};
}

describe("strict Read artifact direct consumers",()=>{
  it("restores a pending policy-only candidate from distinct locks with the same inspected facts", async () => {
    const f = await fixture();
    const overrides = structuredClone(f.build.overrides);
    overrides.resources["studio.parcels"] = { fields: { label: { exposure: "allow_reviewed_use",
      actor: "declared test operator", reason: "Review the parcel label without changing inspected facts.",
      decided_at: "2026-10-09T12:00:00.000Z" } } };
    const next = buildAutoBoundary({ inspection: ownedProgramInspection(), sourceEnv: "DATABASE_URL",
      inspectedSchema: "studio", deploymentProfile: "development", overrides,
      project: { root: f.root, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
    expect(next.exploration_boundary.generation_lock_fingerprint).not.toBe(f.build.exploration_boundary.generation_lock_fingerprint);
    expect(generationLockSharedFactsDigest(next.lock)).toBe(generationLockSharedFactsDigest(f.build.lock));
    await writeAutoBoundaryArtifacts({ projectRoot: f.root, build: next, force: true, preserveReviewProgress: true });
    const progress = createBoundaryReviewProgress({ draft: f.build.exploration_boundary, candidate: next.exploration_boundary,
      actor: "declared test operator", revision: 1 });
    await saveBoundaryReviewProgress(f.root, progress);
    const file = path.join(f.root, ".synapsor/boundary-review-progress.json");
    const before = await fs.readFile(file, "utf8");
    const restored = await readBoundaryReviewProgress(f.root, f.build.exploration_boundary);
    expect(restored?.candidate).toEqual(next.exploration_boundary);
    expect(restored?.confirmed_decisions).toEqual([]);
    expect(await fs.readFile(file, "utf8")).toBe(before);
    const originalLock = path.join(f.root, ".synapsor/exploration-locks",
      `${f.build.exploration_boundary.generation_lock_fingerprint.slice("sha256:".length)}.json`);
    await fs.rename(originalLock, `${originalLock}.preserved`);
    await expect(readBoundaryReviewProgress(f.root, f.build.exploration_boundary)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });
  it("resolves the ordinary writer's wrapped deployment profile",async()=>{
    const f=await fixture();
    expect(await resolveAskDeploymentProfile(f.root)).toBe("development");
    expect(await resolveAskAccessGuidance({projectRoot:f.root,question:"Show reviewed data"})).toBeUndefined();
  });
  it.each(["flat","unknown","wrong-kind"])("Ask refuses %s rather than treating it as missing",async kind=>{
    const f=await fixture();
    const raw=kind==="flat"?f.build.exploration_boundary:{schema_version:kind==="unknown"?"synapsor.exploration-boundary-draft-file.v99":"synapsor.exploration-boundary-active-file.v1",boundary:f.build.exploration_boundary};
    await fs.writeFile(f.file,JSON.stringify(raw)); const before=await fs.readFile(f.file,"utf8");
    await expect(resolveAskDeploymentProfile(f.root)).rejects.toThrow("READ_BOUNDARY_ARTIFACT");
    await expect(resolveAskAccessGuidance({projectRoot:f.root,question:"Show reviewed data"})).rejects.toThrow("READ_BOUNDARY_ARTIFACT");
    expect(await fs.readFile(f.file,"utf8")).toBe(before);
  });
  it("Ask distinguishes present draft with missing lock from genuine absence",async()=>{
    const f=await fixture();await fs.rename(path.join(f.root,".synapsor/generation-lock.json"),path.join(f.root,".synapsor/lock.preserved"));
    await expect(resolveAskAccessGuidance({projectRoot:f.root,question:"Show reviewed data"})).rejects.toThrow("READ_BOUNDARY_ARTIFACT");
    const empty=await fs.mkdtemp(path.join(os.tmpdir(),"read-artifact-empty-"));await fs.mkdir(path.join(empty,".git"));
    expect(await resolveAskAccessGuidance({projectRoot:empty,question:"Show reviewed data"})).toBeUndefined();
  });
  it.each(["rescan","mutation"])("%s rejects wrong-kind file before Source inspection and preserves bytes",async route=>{
    const f=await fixture();await fs.writeFile(f.file,JSON.stringify({schema_version:"synapsor.exploration-boundary-active-file.v1",boundary:f.build.exploration_boundary}));
    const before=await fs.readFile(f.file,"utf8");let inspections=0;
    const inspect=async()=>{inspections++;return ownedProgramInspection();};
    const action=route==="rescan"?()=>prepareBoundaryRescan({projectRoot:f.root,schemaInspector:inspect}):()=>prepareBoundaryResourceReviewMutation(f.root,{resource_id:"studio.parcels",metadata:{label:"Parcels"},actor:"declared artifact test operator",reason:"Review the declared parcel label"},inspect);
    await expect(action()).rejects.toThrow("READ_BOUNDARY_ARTIFACT");
    expect(inspections).toBe(0);expect(await fs.readFile(f.file,"utf8")).toBe(before);
  });
});
