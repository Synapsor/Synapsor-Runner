import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { buildAutoBoundary, writeAutoBoundaryArtifacts, readOptionalExplorationDraft } from "./auto-boundary.js";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";
import { ownedProgramInspection } from "./test-fixtures/owned-authoring-program.js";
import { READ_BOUNDARY_DRAFT_FILE_VERSION } from "./read-boundary-artifact.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-artifact-files-"));
  await fs.chmod(root, 0o700); await fs.mkdir(path.join(root, ".git"), {mode:0o700});
  const build = buildAutoBoundary({inspection:ownedProgramInspection(),sourceEnv:"DATABASE_URL",inspectedSchema:"studio",
    project:{root,package_manager:"npm",frameworks:[],schema_inputs:[],database_env_names:["DATABASE_URL"]}});
  await writeAutoBoundaryArtifacts({projectRoot:root,build});
  const file=path.join(root,"synapsor/generated/exploration-boundary.draft.json");
  return {root,build,file};
}
describe("strict prospective Read artifact file ports",()=>{
  it("ordinary writer envelopes the exact disabled payload without changing its identity",async()=>{
    const f=await fixture(), raw=JSON.parse(await fs.readFile(f.file,"utf8"));
    expect(raw.schema_version).toBe(READ_BOUNDARY_DRAFT_FILE_VERSION);
    expect(Object.keys(raw).sort()).toEqual(["boundary","schema_version"]);
    expect(canonicalJsonDigest(raw.boundary)).toBe(canonicalJsonDigest(f.build.exploration_boundary));
    expect(await readOptionalExplorationDraft(f.root)).toEqual(f.build.exploration_boundary);
    expect((await loadBoundaryReviewContext(f.root)).draft).toEqual(f.build.exploration_boundary);
  });
  it("both supported draft loaders refuse a flat old file without rewriting it",async()=>{
    const f=await fixture();await fs.writeFile(f.file,JSON.stringify(f.build.exploration_boundary));
    const before=await fs.readFile(f.file,"utf8");
    await expect(readOptionalExplorationDraft(f.root)).rejects.toThrow("READ_BOUNDARY_ARTIFACT");
    await expect(loadBoundaryReviewContext(f.root)).rejects.toThrow("READ_BOUNDARY_ARTIFACT");
    expect(await fs.readFile(f.file,"utf8")).toBe(before);
  });
  it("does not classify a present draft with a missing lock as absent",async()=>{
    const f=await fixture(),lock=path.join(f.root,".synapsor/generation-lock.json");
    await fs.rename(lock,`${lock}.preserved`);
    const before=await fs.readFile(f.file,"utf8");
    const error=await readOptionalExplorationDraft(f.root).catch(error=>error);
    expect(error).toBeInstanceOf(Error);expect(error.code).not.toBe("ENOENT");
    expect(await fs.readFile(f.file,"utf8")).toBe(before);
  });
  it.each(["unknown","wrong-kind","duplicate-projection","old-inner"])("refuses %s before using payload",async kind=>{
    const f=await fixture(), value:any={schema_version:READ_BOUNDARY_DRAFT_FILE_VERSION,boundary:f.build.exploration_boundary};
    if(kind==="unknown")value.schema_version="synapsor.exploration-boundary-draft-file.v99";
    if(kind==="wrong-kind")value.schema_version="synapsor.exploration-boundary-active-file.v1";
    if(kind==="duplicate-projection")value.pack=value.boundary.pack;
    if(kind==="old-inner")value.boundary={...value.boundary,schema_version:"synapsor.exploration-boundary.v1"};
    await fs.writeFile(f.file,JSON.stringify(value));const before=await fs.readFile(f.file,"utf8");
    await expect(readOptionalExplorationDraft(f.root)).rejects.toThrow("READ_BOUNDARY_ARTIFACT");
    await expect(loadBoundaryReviewContext(f.root)).rejects.toThrow("READ_BOUNDARY_ARTIFACT");
    expect(await fs.readFile(f.file,"utf8")).toBe(before);
  });
});

import { boundaryActivateCommand } from "./boundary-commands.js";
import { nativeReadScopeActivationFixture, reviewNativeReadScopeActivationFixture } from "./test-fixtures/native-read-scope-activation.js";
import { loadActivatedExplorationBoundary, loadActivatedExplorationBoundaries, explorationBoundaryCandidateDigest,
  encodeExplorationBoundaryActiveArtifact, activatedExplorationBoundarySetDigest, type ActivatedExplorationBoundary } from "./auto-boundary.js";

describe("active file format from genuinely activated native authority",()=>{
  let active:ActivatedExplorationBoundary;
  beforeAll(async()=>{
    const f=await nativeReadScopeActivationFixture();
    await reviewNativeReadScopeActivationFixture(f,true);
    expect(await boundaryActivateCommand(["--project-root",f.dir,"--actor","declared fixture operator",
      "--confirm",`ACTIVATE ${explorationBoundaryCandidateDigest(f.prepared.context.candidate)}`],async()=>f.prepared.inspection,{
      presentationMode:"conversation",promptText:async()=>undefined,chooseResource:async()=>undefined,editFieldTiers:async()=>undefined,
      confirm:async(_message,options)=>{expect(options?.defaultValue).toBe(false);return true;},
    })).toBe(0);
    active=await loadActivatedExplorationBoundary(f.dir);
    expect(active.activation.state).toBe("active");
  },30000);
  async function files() {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"read-active-artifact-"));await fs.chmod(root,0o700);
    await fs.mkdir(path.join(root,".git"),{mode:0o700});await fs.mkdir(path.join(root,".synapsor"),{mode:0o700});
    const mirror=path.join(root,".synapsor/exploration-boundary.active.json"),registry=path.join(root,".synapsor/exploration-boundaries.active.json");
    await fs.writeFile(mirror,JSON.stringify(encodeExplorationBoundaryActiveArtifact(active)));
    return {root,mirror,registry};
  }
  it("loads the strict selected file preserving exact real activation identity",async()=>{
    const f=await files();expect(await loadActivatedExplorationBoundary(f.root)).toEqual(active);
    expect(activatedExplorationBoundarySetDigest([active])).toBe(canonicalJsonDigest({schema_version:"synapsor.active-exploration-boundaries.v1",
      boundaries:[{name:active.pack.name,digest:active.activation.digest}]}));
  });
  it("rejects old flat active files without normalization or resave",async()=>{
    const f=await files();await fs.writeFile(f.mirror,JSON.stringify(active));const before=await fs.readFile(f.mirror,"utf8");
    await expect(loadActivatedExplorationBoundary(f.root)).rejects.toThrow("READ_BOUNDARY_ARTIFACT");
    expect(await fs.readFile(f.mirror,"utf8")).toBe(before);
  });
  it("loads file-registry v2 while preserving authority-set domain v1",async()=>{
    const f=await files();await fs.writeFile(f.registry,JSON.stringify({schema_version:"synapsor.active-exploration-boundaries.v2",
      selected_name:active.pack.name,boundaries:[active],updated_at:"2026-10-08T00:00:00.000Z"}));
    expect(await loadActivatedExplorationBoundaries(f.root)).toEqual([active]);
  });
  it.each(["old-registry","mixed-inner","unknown-inner","extra-key"])("rejects %s without falling back to a valid selected mirror",async kind=>{
    const f=await files(),raw:any={schema_version:"synapsor.active-exploration-boundaries.v2",selected_name:active.pack.name,
      boundaries:[active],updated_at:"2026-10-08T00:00:00.000Z"};
    if(kind==="old-registry")raw.schema_version="synapsor.active-exploration-boundaries.v1";
    if(kind==="mixed-inner"||kind==="unknown-inner")raw.boundaries.push({...active,schema_version:kind==="mixed-inner"?"synapsor.exploration-boundary.v1":"synapsor.exploration-boundary.v99"});
    if(kind==="extra-key")raw.authority=true;
    await fs.writeFile(f.registry,JSON.stringify(raw));const before=await fs.readFile(f.registry,"utf8"),mirror=await fs.readFile(f.mirror,"utf8");
    await expect(loadActivatedExplorationBoundary(f.root)).rejects.toThrow();
    await expect(loadActivatedExplorationBoundaries(f.root)).rejects.toThrow();
    expect(await fs.readFile(f.registry,"utf8")).toBe(before);expect(await fs.readFile(f.mirror,"utf8")).toBe(mirror);
  });
});
