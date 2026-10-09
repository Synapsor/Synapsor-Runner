import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAutoBoundary, writeAutoBoundaryArtifacts } from "./auto-boundary.js";
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
