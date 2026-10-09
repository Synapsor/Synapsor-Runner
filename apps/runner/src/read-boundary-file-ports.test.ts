import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
