import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import { parsePolicyCoverage, reviewPolicyCoverage } from "./authoring-policy-coverage.js";
import { bindPolicyCoverage, savePolicySources, loadPolicySources, policyTextSnapshot } from "./authoring-policy-source.js";
import { policyReviewReadiness } from "./authoring-review-readiness.js";
const saved = JSON.parse(readFileSync(new URL("./fixtures/counting-addition-review.json", import.meta.url), "utf8"));
const counter = (r: any) => r.passages.find((p: any) => p.counter_requirements);
const parse = (r = saved.reply, d = saved.draft, s = saved.source, m = saved.operator_messages) => parsePolicyCoverage(r,s,d,m);

describe("faithful source counting across additions", () => {
  it("refuses exact reply16 through producer and leaves the saved session unchanged", async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"counting-addition-"));
    try {
      const state=structuredClone(saved.policy_sources);await savePolicySources(root,state,{expectedDigest:null});
      const conversation=createModelAuthoringConversation();conversation.policySources=state;let calls=0;
      await expect(reviewPolicyCoverage({source:saved.source,draft:saved.draft,env:{OPENAI_API_KEY:"captured-only"},session:{provider:"openai",model:"gpt-5.6-terra",conversation,dependencies:{requestJson:async()=>{calls++;return {status:200,body:{output:[{type:"function_call",name:"runner__review_policy_coverage",call_id:"exact16",arguments:JSON.stringify(saved.reply)}]}};}}}})).rejects.toThrow("COUNTING_REQUIREMENT_MISMATCH");
      expect(calls).toBe(1);expect(await loadPolicySources(root,state.id)).toEqual(saved.policy_sources);
    } finally {await fs.rm(root,{recursive:true,force:true});}
  });
  it("uses canonical vocabulary under a renamed structural variant and refuses ambiguous outcome association", () => {
    const renamed=JSON.parse(JSON.stringify(saved).replaceAll("ratification", "validation").replaceAll("Ratification", "Validation").replaceAll("league.", "sample."));
    expect(()=>parse(renamed.reply,renamed.draft,renamed.source,renamed.operator_messages)).toThrow("COUNTING_REQUIREMENT_MISMATCH");
    const d=structuredClone(saved.draft);d.actions[1].discovery={title:"Result ratification",aliases:[]};
    expect(()=>parse(saved.reply,d)).toThrow("COUNTING_REQUIREMENT_AMBIGUOUS");
  });
  it("keeps genuine boundary-wide null/null without a singleton proof", () => {
    const source=policyTextSnapshot(Buffer.from("At most two automatic approvals across all outcomes in the rolling 24 hours."),"rules.txt");
    const d=structuredClone(saved.draft);const p=structuredClone(counter(saved.reply));p.start=p.end=1;delete p.operator_message_id;
    for(const c of p.counter_requirements)delete c.operator_message_id;
    const report=parse({passages:[p]},d,source,[]);
    expect(report.passages[0]?.counting_requirement_bindings?.every(b=>b.required_capability===null)).toBe(true);
    expect(report.passages[0]?.counting_components).toBeUndefined();expect(report.passages[0]?.disposition).toBe("implemented");
  });
  function explicit() {
    const d=structuredClone(saved.draft),r=structuredClone(saved.reply),p=counter(r),outcome=d.actions[0].outcome;
    for(const l of d.actions[0].approval.shared_limits)l.capability=outcome;
    for(const l of d.runner_evidence.actions[outcome].automatic_limits){l.capability=outcome;l.history_selector.capability=outcome;}
    for(const c of p.counter_requirements){c.current_capability=c.required_capability=outcome;c.operator_message_id=p.operator_message_id;}
    return {d,r,outcome};
  }
  it("saves, restarts and rechecks source-consistent explicit selectors with unchanged non-counting claims",async()=>{
    const {d,r}=explicit(),report=parse(r,d),root=await fs.mkdtemp(path.join(os.tmpdir(),"counting-matching-"));
    try {
      expect(counter(report).counting_requirement_bindings).toHaveLength(2);
      expect(report.passages.filter(p=>p.deployment_prerequisite).length).toBeGreaterThan(0);
      const state=structuredClone(saved.policy_sources);bindPolicyCoverage(state,report,state.coverage_authority_digest);
      await savePolicySources(root,state,{expectedDigest:null});const loaded=await loadPolicySources(root,state.id);
      const recheck=parse({passages:loaded.coverage!.passages},d);expect(counter(recheck).counting_requirement_bindings).toEqual(counter(report).counting_requirement_bindings);
      const changed=structuredClone(loaded);changed.operator_messages!.push("A separate decision remains pending.");await savePolicySources(root,changed,{expectedDigest:canonicalJsonDigest(loaded)});
      await expect(savePolicySources(root,loaded,{expectedDigest:canonicalJsonDigest(loaded)})).rejects.toThrow("POLICY_SOURCE_CHANGED");
    } finally {await fs.rm(root,{recursive:true,force:true});}
  });
  it.each(["human_added","automatic_added","removed_history","missing_domain","old_support","omitted"])("does not erase the source obligation: %s", mode=>{
    const d=structuredClone(saved.draft),r=structuredClone(saved.reply),p=counter(r);
    if(mode==="automatic_added")d.actions[1].approval.mode="policy";
    if(mode==="removed_history"){d.actions.pop();r.passages=r.passages.filter((v:any)=>!v.draft_paths.some((p:string)=>p.startsWith("/actions/1/")));d.runner_evidence.runtime_contract.approval_counter_selection.outcome_domain.retained_automatic_outcomes.push("other.removed");}
    if(mode==="missing_domain")delete d.runner_evidence.runtime_contract.approval_counter_selection.outcome_domain;
    if(mode==="omitted"){
      delete p.counter_requirements;
      const report=parse(r,d);expect(report.passages.some(p=>p.counting_requirement_bindings?.length&&p.disposition==="conflict")).toBe(true);
      expect(policyReviewReadiness(saved.source,report,saved.policy_sources).ready).toBe(false);
    }else expect(()=>parse(r,d)).toThrow("COUNTING_REQUIREMENT_MISMATCH");
  });
  it("keeps an actual source-supported selector difference as a repairable conflict without claiming equivalence", () => {
    const reply=structuredClone(saved.reply),p=counter(reply);p.disposition="conflict";
    for(const c of p.counter_requirements){c.required_capability=saved.draft.actions[0].outcome;c.operator_message_id=p.operator_message_id;}
    const report=parse(reply);
    expect(counter(report)).toMatchObject({disposition:"conflict"});expect(counter(report).counting_components).toBeUndefined();
    expect(counter(report).counting_requirement_bindings).toHaveLength(2);
    expect(policyReviewReadiness(saved.source,report,saved.policy_sources).ready).toBe(false);
  });
  it("wrong explicit support does not inherit paragraph consent; unrelated residual claims stay blocked",()=>{
    const {d,r}=explicit();counter(r).counter_requirements[0].operator_message_id=5;
    expect(()=>parse(r,d)).toThrow("COUNTING_SUPPORT_MISMATCH");
    counter(r).counter_requirements[0].operator_message_id=counter(r).operator_message_id;
    r.passages.push({start:7,end:7,disposition:"conflict",responsibility:"runner",interpretation:"The numeric maximum is wrong.",draft_paths:["/actions/0/approval"]});
    expect(policyReviewReadiness(saved.source,parse(r,d),saved.policy_sources).ready).toBe(false);
  });
});
