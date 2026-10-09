import { describe, expect, it } from "vitest";
import { requestedSharedCatalogResources, analyzedReadCoverage } from "./authoring-read-catalog-projection.js";
import { READ_SCOPE_PROTOCOL, type ReadScopeProposal } from "./read-structured-scope.js";
const catalog=[{resource_id:"catalog.offer"},{resource_id:"catalog.offers"},{resource_id:"catalog.terms"}];
const proposal = ():ReadScopeProposal => ({protocol:READ_SCOPE_PROTOCOL,original_request:"original",applicability:"read_requested",requirements:[
  {id:"offer",intended_use:"Do not use this prose to choose a table",references:["original"],disposition:"include",subjects:[],targets:[{resource:"catalog.offers",root_resource:"catalog.terms",operation:"resource"}]},
]});
describe("typed catalog and analyzed plan projection",()=>{
  it("offers only exact declared targets for separate structural review",()=>{
    expect(requestedSharedCatalogResources(catalog,proposal())).toEqual(catalog.slice(1));
  });
  it.each(["exclude","unresolved"] as const)("does not offer %s targets",disposition=>{
    const p=proposal();p.requirements[0]!.disposition=disposition;
    expect(requestedSharedCatalogResources(catalog,p)).toEqual([]);
  });
  it("does not infer shared resources from missing scope or intended-use prose",()=>{
    expect(requestedSharedCatalogResources(catalog,undefined)).toEqual([]);
    const p=proposal();p.requirements[0]!.intended_use="Show catalog.offer";p.requirements[0]!.targets=[];
    expect(requestedSharedCatalogResources(catalog,p)).toEqual([]);
  });
  it("refuses malformed typed proposals rather than using language fallback",()=>{
    expect(()=>requestedSharedCatalogResources(catalog,{...proposal(),protocol:"old"} as unknown as ReadScopeProposal)).toThrow();
  });
  it("counts all analyzed plans regardless of identifiers or descriptions",()=>{
    const allowed=[{id:"action_review_1",description:"Review the exact fields required to update",status:"supported" as const,authority_atoms:[]},
      {id:"semantic_action_subject_1",description:"ignored prose",status:"blocked" as const,authority_atoms:[]}];
    expect(analyzedReadCoverage({allowed})).toEqual({supported:1,total:2});
  });
});
