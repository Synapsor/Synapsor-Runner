import { describe, expect, it } from "vitest";
import { resolveRequestedReadScope } from "./read-requested-scope.js";
import { currentBoundaryJobReadRequests } from "./boundary-job-read-requests.js";
import type { ReadWorkloadView } from "./read-workloads.js";
// Unit projection fixtures deliberately provide only the inspected fields; native public proof uses actual stored records.
const description="Read dispatch summaries.";
const resources=[{id:"lab.q8"},{id:"lab.r4",label:"dispatch summaries"}];
const exactRequests=[{description,resource_ids:["lab.q8"]}];
const resolve=(original=description, overrides: Partial<Parameters<typeof resolveRequestedReadScope>[0]>={})=>resolveRequestedReadScope({original,resources,definitions:[],statements:[],exactRequests,...overrides});
describe("independent current request association 1653",()=>{
 it("V10 unchanged capability noun retains work; an added unknown Read clause stays unresolved",()=>{
   const change="Require two reviewers for shipping. Keep every other Read, Input, Version and receipt duty unchanged.";
   expect(resolve(change)).toMatchObject({ required: [], candidates: [], unresolved: false });
   expect(resolve(change+" Read outstanding invoices.").unresolved).toBe(true);
   expect(resolve("Do not keep Read unchanged.").unresolved).toBe(true);
 });

 it("V1 exact native request wins over another candidate label",()=>{expect(resolve()).toMatchObject({required:["lab.q8"],candidates:[],unresolved:false});});
 it("V2 extra unknown clause is not silently covered",()=>{expect(resolve(description+" Read staff assignments.").unresolved).toBe(true);});
 it("V3 explicit root exclusion still conflicts",()=>{expect(resolve(description+" Do not read lab.q8.").conflicts).toEqual(["lab.q8"]);});
 it("V4 equal duplicate roots differ from conflicting identities",()=>{expect(resolve(description,{exactRequests:[...exactRequests,...exactRequests]}).unresolved).toBe(false);expect(resolve(description,{exactRequests:[...exactRequests,{description,resource_ids:["lab.r4"]}]}).unresolved).toBe(true);});
 it("V5 removed current root is not recovered from saved words",()=>{expect(resolve(description,{resources:[resources[1]!]}).required).toEqual([]);expect(resolve(description,{resources:[resources[1]!]}).candidates.length).toBeGreaterThan(0);});
 it("V6 changed wording is not exact proof",()=>{expect(resolve("Read dispatch summaries and their managers.").candidates.length).toBeGreaterThan(0);});
 it("V7 mixed unknown root rejects whole native association",()=>{const w={state:"reviewed",generated_boundary_digest:"sha256:a",review:{analyzed_candidate_digest:"sha256:b",candidate_digest:"sha256:a"},analysis:{status:"ready",candidate_digest:"sha256:b",candidate:{pack:{resources:[{id:"lab.q8"}]}},allowed:[{description,status:"supported",plan_shape:{resource:"lab.q8"},authority_atoms:[{root_resource:"lab.q8"},{root_resource:"lab.absent"}]}]}} as unknown as ReadWorkloadView;expect(currentBoundaryJobReadRequests({workloads:[w],candidateDigests:new Set(["sha256:a"]),mode:"reviewed"})).toEqual([]);});
 it("V8 stale generated request requires actual current reviewed candidate",()=>{const w={state:"reviewed",generated_boundary_digest:"sha256:old",review:{analyzed_candidate_digest:"sha256:b",candidate_digest:"sha256:a"},analysis:{status:"ready",candidate_digest:"sha256:b",candidate:{pack:{resources:[{id:"lab.q8"}]}},allowed:[{description,status:"supported",plan_shape:{resource:"lab.q8"},authority_atoms:[{root_resource:"lab.q8"}]}]}} as unknown as ReadWorkloadView;expect(currentBoundaryJobReadRequests({workloads:[w],candidateDigests:new Set(["sha256:a"]),mode:"resumable"})).toEqual(exactRequests);delete w.review;expect(currentBoundaryJobReadRequests({workloads:[w],candidateDigests:new Set(["sha256:a"]),mode:"resumable"})).toEqual([]);});
 it("V9 exact quoted business literal remains recognizable; changed literal does not",()=>{const d='Read records marked "awaiting response".';const scope=resolve(d,{exactRequests:[{description:d,resource_ids:["lab.q8"]}]});expect(scope).toMatchObject({required:["lab.q8"],unresolved:false});expect(resolve('Read records marked "response received".',{exactRequests:[{description:d,resource_ids:["lab.q8"]}]}).unresolved).toBe(true);});
});
