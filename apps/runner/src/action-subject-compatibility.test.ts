import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe,it,expect } from "vitest";
import { actionSubjectCompatibility, assertActionSubjectsObtainable } from "./action-subject-compatibility.js";
import { parseActionRuleAuthority } from "@synapsor-runner/action-rules";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { writeActionRuleAuthorityDraft, readActionRuleAuthorityDraft } from "./action-rule-authority.js";
import { policyCoverageDraft } from "./authoring-policy-evidence.js";
import { parsePolicyCoverage } from "./authoring-policy-coverage.js";
import { policyTextSnapshot } from "./authoring-policy-source.js";
const saved=JSON.parse(readFileSync(new URL("./fixtures/software-subject-contract.json",import.meta.url),"utf8"));
const check=(read=saved.read,action=saved.action.authority)=>actionSubjectCompatibility(action,[read]);

describe("four-tool Action subject compatibility",()=>{
  it("reproduces the exact saved direct slot contract while the original candidate and internal slot binding work",()=>{
    const result=check();expect(result.subjects).toEqual([
      expect.objectContaining({outcome:"release_ops.retire_unused_slot",binding:"slot",obtainable:false,code:"ACTION_SUBJECT_RELATIONSHIP_ONLY"}),
      expect.objectContaining({outcome:"release_ops.seal_candidate",binding:"candidate",obtainable:true}),
    ]);
    expect(()=>assertActionSubjectsObtainable(saved.action.authority,[saved.read])).toThrow("ACTION_SUBJECT_UNOBTAINABLE");
    const seal=structuredClone(saved.action.authority);seal.rules=seal.rules.filter((r:any)=>r.rule.outcome.endsWith("seal_candidate"));
    // Existing complete compiler validates its unique candidate -> related slot
    // binding. This is evidence for sealing, not universal retirement coverage.
    parseActionRuleAuthority(saved.action.authority,saved.action.digest);
    expect(check(saved.read,seal).compatible).toBe(true);
  });
  it.each(["missing","source","private","analytical","relationship_only","identity","scope"])("revalidates changed Read prerequisites: %s",mode=>{
    const read=structuredClone(saved.read);const root=read.pack.resources.find((r:any)=>r.id.endsWith("build_candidates"));
    if(mode==="missing")read.pack.resources=read.pack.resources.filter((r:any)=>r!==root);
    if(mode==="source")read.source="different_source";
    if(mode==="private"||mode==="analytical")root.selectable_fields=[];
    if(mode==="relationship_only")root.relationship_only=true;
    if(mode==="identity")root.primary_key="different_key";
    if(mode==="scope")root.tenant_key="different_tenant";
    const result=check(read);expect(result.subjects.find(s=>s.binding==="candidate")?.obtainable).toBe(false);
    expect(result.read_digest).not.toBe(check().read_digest);
  });
  it("does not depend on current eligible rows and does not confuse internal bindings with external subjects",()=>{
    const seal=structuredClone(saved.action.authority);seal.rules=seal.rules.filter((r:any)=>r.rule.outcome.endsWith("seal_candidate"));
    const result=check(saved.read,seal);expect(result.subjects).toHaveLength(1);expect(result.subjects[0]?.obtainable).toBe(true);
    // No source is opened, and no sample row is used as a route proof.
    expect(result.subjects.some(s=>s.binding==="slot")).toBe(false);
  });
  it("keeps incompatible disabled work saveable, reloads it unchanged and reports a business-readiness blocker",async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"subject-compatibility-"));
    try{
      const before=canonicalJsonDigest(saved.action);await writeActionRuleAuthorityDraft(root,saved.action);
      const loaded=await readActionRuleAuthorityDraft(root,saved.action.authority.name);expect(loaded).toEqual(saved.action);expect(canonicalJsonDigest(saved.action)).toBe(before);
      const draft=policyCoverageDraft({read:saved.read,actions:[],authority:loaded!,decisions:[]});
      const source=policyTextSnapshot(Buffer.from("Keep the reviewed business changes available to this client."),"rules.txt");
      const report=parsePolicyCoverage({passages:[{start:1,end:1,disposition:"implemented",interpretation:"The draft is prepared.",draft_paths:["/actions/0"]}]},source,draft,[]);
      expect(report.passages.at(-1)).toMatchObject({disposition:"unsupported",topic:"Action subject reference unavailable"});
    }finally{await fs.rm(root,{recursive:true,force:true});}
  });
});
