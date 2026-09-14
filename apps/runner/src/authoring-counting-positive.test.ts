import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { parsePolicyCoverage, reviewPolicyCoverage } from "./authoring-policy-coverage.js";
import { policyTextSnapshot, bindPolicyCoverage, savePolicySources, loadPolicySources } from "./authoring-policy-source.js";
import { policyReviewReadiness } from "./authoring-review-readiness.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import { countingSourceRequirements, configuredCountingLimits } from "./authoring-counting-requirements.js";
import { reviewUnestablishedCounting } from "./authoring-counting-decision-review.js";
const saved = JSON.parse(readFileSync(new URL("./fixtures/mixed-counting-review.json", import.meta.url), "utf8"));
const restart = JSON.parse(readFileSync(new URL("./fixtures/counting-recheck-review.json", import.meta.url), "utf8"));
const clause = "with at most six automatic ratifications overall and two per league in the inclusive rolling 24-hour window";
const wordings = [
  "but no more than two ratifications may be auto-approved per league per day and no more than six overall",
  "and at most six results may be auto-approved as ratifications overall, two per league, each rolling 24 hours",
  "subject to the ratification allowance defined below, which is six overall and two per league each rolling day",
  "under the automatic allowance, which covers ratification only; two per league and six overall in a rolling day",
  "with at most six automatic\nratifications overall and two per league in the inclusive rolling 24-hour window",
];
const counter = (reply: any) => reply.passages.find((p: any) => p.counter_requirements?.length);
function fixture(wording = wordings[0]!) {
  const d = structuredClone(saved.drafts[0]), r = structuredClone(saved.replies[0]);
  d.runner_evidence.counting_interpretations = [];
  const source = policyTextSnapshot(Buffer.from(saved.source.text.replace(clause, wording)), "rules.txt");
  if (wording.includes("\n")) for (const p of r.passages) { if (p.start > 7) p.start++; if (p.end >= 7) p.end++; }
  counter(r).disposition = "implemented";
  for (const c of counter(r).counter_requirements) { c.required_capability = null; delete c.operator_message_id; delete c.operator_clarification; }
  const state = structuredClone(saved.policy_sources);state.snapshots=[source];state.active=source.version;state.approvals=state.approvals.map((a:any)=>({...a,digest:source.digest}));delete state.coverage;
  return { d, r, source, state };
}
async function produce(f: ReturnType<typeof fixture>, r = f.r) {
  const conversation = createModelAuthoringConversation();conversation.policySources=f.state;
  return reviewPolicyCoverage({ source:f.source,draft:f.d,env:{OPENAI_API_KEY:"captured-only"},session:{provider:"openai",model:"gpt-5.6-terra",conversation,
    dependencies:{requestJson:async()=>({status:200,body:{output:[{type:"function_call",name:"runner__review_policy_coverage",call_id:"unchanged-capture",arguments:JSON.stringify(r)}]}})}} });
}
async function record(f: ReturnType<typeof fixture>, report: ReturnType<typeof parsePolicyCoverage>) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"positive-counting-"));
  try { bindPolicyCoverage(f.state,report,canonicalJsonDigest(f.d.actions));await savePolicySources(root,f.state,{expectedDigest:null});
    const loaded=await loadPolicySources(root,f.state.id);
    const again=parsePolicyCoverage({passages:loaded.coverage!.passages},f.source,f.d,loaded.operator_messages!);
    expect(again.counting_inventory).toEqual(report.counting_inventory);
    return {loaded,again};
  }finally{await fs.rm(root,{recursive:true,force:true});}
}
describe("positive counting requirement inventory",()=>{
  it.each(wordings)("refuses exact false equality for %s through producer before saving",async wording=>{
    const f=fixture(wording);expect(configuredCountingLimits(f.d)).toHaveLength(2);
    expect(countingSourceRequirements(f.source,f.d,f.state.operator_messages).every(r=>r.state!=="established")).toBe(true);
    await expect(produce(f)).rejects.toThrow(/COUNTING_REQUIREMENT_(UNESTABLISHED|AMBIGUOUS)/);expect(f.state.coverage).toBeUndefined();
  });
  it.each(["omitted","background"])("cannot erase unknown configured limits with %s",async mode=>{
    const f=fixture();delete counter(f.r).counter_requirements;
    if(mode==="background")f.r.passages.forEach((p:any)=>{p.disposition="background";delete p.operator_message_id;delete p.field_checks;delete p.application_obligations;delete p.deployment_prerequisite;});
    const report=await produce(f),{loaded,again}=await record(f,report);
    expect(report.passages.filter(p=>p.counting_requirement_bindings?.some(r=>r.state==="unknown"))).toHaveLength(2);
    expect(policyReviewReadiness(f.source,again,loaded).ready).toBe(false);
  });
  it("keeps empty comparisons refused and historical zero-proof coverage unready",()=>{
    const f=fixture();counter(f.r).counter_requirements=[];
    expect(()=>parsePolicyCoverage(f.r,f.source,f.d,f.state.operator_messages)).toThrow(/counter requirement/i);
    expect(policyReviewReadiness(f.source,{source_digest:f.source.digest,draft_digest:canonicalJsonDigest(f.d),passages:saved.replies[0].passages}).ready).toBe(false);
  });
  it("never treats missing evidence as an empty configuration",()=>{
    const f=fixture();delete f.d.runner_evidence.actions;
    expect(()=>parsePolicyCoverage(f.r,f.source,f.d,f.state.operator_messages)).toThrow("COUNTING_CONFIGURATION_INCOMPLETE");
  });
  it("does not invent a counting question for a job without configured limits",async()=>{
    const draft={actions:[],runner_evidence:{actions:{}}},source=policyTextSnapshot(Buffer.from("A read-only reference."),"rules.txt");
    expect(countingSourceRequirements(source,draft,[])).toEqual([]);
    expect(await reviewUnestablishedCounting({source,draft,messages:[],session:{confirm:async()=>{throw Error("unrequested question");}},assertCurrent:async()=>{}})).toEqual([]);
    expect(policyReviewReadiness(source,parsePolicyCoverage({passages:[{start:1,end:1,disposition:"background",interpretation:"Reference.",draft_paths:[]}]},source,draft,[])).ready).toBe(true);
  });
  it("operator reviews an unknown set once; exact matching program saves, reloads and reuses without another question",async()=>{
    const f=fixture(),outcome=f.d.actions[0].outcome;
    // A separate narrow authoring fixture, not a rewritten tournament result.
    f.source=policyTextSnapshot(Buffer.from(wordings[0]!),"counting-choice.txt");
    const narrow=structuredClone(counter(f.r));narrow.start=narrow.end=1;delete narrow.operator_message_id;
    f.r={passages:[narrow]};f.state.snapshots=[f.source];f.state.approvals=f.state.approvals.map((a:any)=>({...a,digest:f.source.digest}));
    for(const l of f.d.actions[0].approval.shared_limits)l.capability=outcome;
    for(const l of f.d.runner_evidence.actions[outcome].automatic_limits){l.capability=outcome;l.history_selector.capability=outcome;}
    for(const c of counter(f.r).counter_requirements)c.current_capability=c.required_capability=outcome;
    let choices=0,confirms=0;const contexts:string[][]=[];
    const decisions=await reviewUnestablishedCounting({source:f.source,draft:f.d,messages:f.state.operator_messages,assertCurrent:async()=>{},session:{
      chooseOption:async(_title,_options,options)=>{choices++;contexts.push(options!.context!);return "outcome-0";},confirm:async()=>{confirms++;return true;}}});
    expect(choices).toBe(2);expect(confirms).toBe(2);expect(contexts[0]!.join("\n")).toContain(f.source.text);
    f.d.runner_evidence.counting_decisions=decisions;f.state.counting_decisions=decisions;
    const report=await produce(f),{loaded,again}=await record(f,report);
    expect(policyReviewReadiness(f.source,again,loaded).ready).toBe(true);
    expect(await reviewUnestablishedCounting({source:f.source,draft:f.d,messages:f.state.operator_messages,assertCurrent:async()=>{},session:{confirm:async()=>{throw Error("re-prompt");}}})).toEqual([]);
    expect(f.d.runner_evidence.counting_interpretations).toEqual([]);
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"counting-cas-"));try{
      await savePolicySources(root,loaded,{expectedDigest:null});const newer={...loaded,operator_messages:[...loaded.operator_messages!,"Separate review"]};
      await savePolicySources(root,newer,{expectedDigest:canonicalJsonDigest(loaded)});
      await expect(savePolicySources(root,loaded,{expectedDigest:canonicalJsonDigest(loaded)})).rejects.toThrow("POLICY_SOURCE_CHANGED");
      expect(await loadPolicySources(root,loaded.id)).toEqual(newer);
    }finally{await fs.rm(root,{recursive:true,force:true});}
  });
  it.each(["declined","cancelled","concurrent"])("does not create accepted interpretation when %s",async mode=>{
    const f=fixture();let checks=0;const run=reviewUnestablishedCounting({source:f.source,draft:f.d,messages:f.state.operator_messages,
      assertCurrent:async()=>{if(++checks===2&&mode==="concurrent")throw Error("POLICY_SOURCE_CHANGED");},
      session:{chooseOption:async()=>mode==="cancelled"?"unresolved":"outcome-0",confirm:async()=>mode!=="declined"}});
    if(mode==="concurrent")await expect(run).rejects.toThrow("POLICY_SOURCE_CHANGED");else expect(await run).toBeUndefined();
    expect(f.state.counting_decisions).toBeUndefined();
  });
  it.each(["source","window","maximum","outcome","messages"])("invalidates reviewed meaning on relevant %s change",async mode=>{
    const f=fixture();f.d.runner_evidence.counting_decisions=await reviewUnestablishedCounting({source:f.source,draft:f.d,messages:f.state.operator_messages,
      assertCurrent:async()=>{},session:{chooseOption:async()=>"boundary",confirm:async()=>true}});
    if(mode==="source")f.source=policyTextSnapshot(Buffer.from(f.source.text+"\nAnother requirement."),"rules.txt");
    if(mode==="messages")f.state.operator_messages.push("Count something different.");
    if(mode==="outcome")f.d.runner_evidence.counting_decisions[0].required_capability="different.unknown";
    if(mode==="window"||mode==="maximum")for(const l of [f.d.actions[0].approval.shared_limits[0],f.d.runner_evidence.actions[f.d.actions[0].outcome].automatic_limits[0]])l[mode==="window"?"window_seconds":"maximum"]++;
    expect(countingSourceRequirements(f.source,f.d,f.state.operator_messages).some(r=>r.state==="unknown")).toBe(true);
  });
  it("counts distinct sets in a labeled synthetic multi-outcome history without claiming a withdrawal miscount",()=>{
    const history=[{kind:"automatic",outcome:"example.first"},{kind:"automatic",outcome:"example.second"},{kind:"human",outcome:"example.first"}];
    expect(history.filter(h=>h.kind==="automatic")).toHaveLength(2);
    expect(history.filter(h=>h.kind==="automatic"&&h.outcome==="example.first")).toHaveLength(1);
  });
});
describe("actual post-removal recheck provenance",()=>{
  it.each([0,1])("keeps capture %s unchanged and points to the exact existing decision, not a new owner question",async index=>{
    const f={d:structuredClone(restart.draft),r:structuredClone(restart.replies[index]),source:restart.source,state:structuredClone(restart.policy_sources)};
    const before=JSON.stringify(f.r);
    await expect(produce(f)).rejects.toThrow("Reference the existing exact counting decision");expect(JSON.stringify(f.r)).toBe(before);
    // Derived structural-only correction. The real installed confirmation must
    // come from the provider; this is not claimed as a completed public run.
    for(const c of counter(f.r).counter_requirements)c.operator_message_id=8;
    const report=await produce(f),{loaded,again}=await record(f,report);
    const readiness=policyReviewReadiness(f.source,again,loaded);
    expect(readiness.items?.filter(i=>i.blocksReview).every(i=>i.passages.every(p=>p.application_obligations?.includes("customer_selection")))).toBe(true);
    expect(counter(again).counter_requirements.every((c:any)=>c.current_capability==="league.result_ratification"&&c.required_capability===c.current_capability)).toBe(true);
    expect(f.d).toEqual(restart.draft);
  });
});
