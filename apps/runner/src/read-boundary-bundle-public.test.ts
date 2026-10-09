import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { boundaryActivateCommand, boundaryReviewCommand } from "./boundary-commands.js";
import { loadBoundaryReviewContext, BOUNDARY_REVIEW_BUNDLE_VERSION, type BoundaryReviewBundle } from "./boundary-review-context.js";
import { loadActivatedExplorationBoundaries } from "./auto-boundary.js";
import { readProjectReadAuthoring } from "./control-policy-read-authoring-project.js";
import { nativeReadScopeActivationFixture, reviewNativeReadScopeActivationFixture } from "./test-fixtures/native-read-scope-activation.js";

describe("public prospective Read review bundle version binding",()=>{
  let f:Awaited<ReturnType<typeof nativeReadScopeActivationFixture>>;
  let exported:BoundaryReviewBundle;
  let exportPath:string;
  beforeAll(async()=>{
    f=await nativeReadScopeActivationFixture();
    await reviewNativeReadScopeActivationFixture(f,true);
    exportPath=path.join(f.dir,"public-review-export.json");
    expect(await boundaryReviewCommand(["--project-root",f.dir,"--output",exportPath],async()=>f.prepared.inspection)).toBe(0);
    exported=JSON.parse(await fs.readFile(exportPath,"utf8")) as BoundaryReviewBundle;
    expect(exported.schema_version).toBe(BOUNDARY_REVIEW_BUNDLE_VERSION);
    expect(exported).toEqual((await loadBoundaryReviewContext(f.dir)).bundle);
  },30000);

  async function rejectAtGate(name:string,value:unknown,error:RegExp) {
    const file=path.join(f.dir,`import-${name}.json`);
    await fs.writeFile(file,JSON.stringify(value));
    const bytes=await fs.readFile(file,"utf8"), exportedBytes=await fs.readFile(exportPath,"utf8");
    const nativeBefore=await readProjectReadAuthoring(f.dir), resumeBefore=await f.readSavedState();
    expect(nativeBefore).toBeDefined();
    let inspections=0;
    await expect(boundaryActivateCommand(["--project-root",f.dir,"--headless","--review-bundle",file,
      "--confirm",`ACTIVATE ${exported.candidate_digest}`],async()=>{inspections++;return f.prepared.inspection;})).rejects.toThrow(error);
    // The normal entry inspects metadata before its bundle/identity gates. No
    // source effect, synthetic actor, signed decision or activation is supplied.
    expect(inspections).toBe(1);
    expect(await readProjectReadAuthoring(f.dir)).toEqual(nativeBefore);
    expect(await f.readSavedState()).toEqual(resumeBefore);
    expect(await fs.readFile(file,"utf8")).toBe(bytes);
    expect(await fs.readFile(exportPath,"utf8")).toBe(exportedBytes);
    await expect(loadActivatedExplorationBoundaries(f.dir)).rejects.toMatchObject({code:"ENOENT"});
  }

  it("exports current v2 and imports it to the existing verified-identity prerequisite without activating",async()=>{
    await rejectAtGate("current",exported,/Headless activation requires a configured signed_key or jwt_oidc operator identity/);
  });
  it.each(["old","unknown","wrong-kind"])("rejects %s outer version without saved-state mutation",async kind=>{
    const schema_version=kind==="old"?"synapsor.boundary-review-bundle.v1":kind==="unknown"?"synapsor.boundary-review-bundle.v99":"synapsor.exploration-boundary-active-file.v1";
    await rejectAtGate(kind,{...exported,schema_version},/Unsupported boundary review bundle version/);
  });
  it("rejects mixed old inner candidate under current outer version using the unchanged exported digest",async()=>{
    await rejectAtGate("mixed",{...exported,candidate:{...exported.candidate,schema_version:"synapsor.exploration-boundary.v1"}},/Boundary review bundle digest does not match its contents/);
  });
});
