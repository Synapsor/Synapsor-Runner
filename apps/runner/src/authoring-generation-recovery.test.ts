import { narrateValidatedAuthoringStep } from "./model-authoring-narration.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import { createServer, globalAgent, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { AskError, completedAuthoringQuestion, askToolSurfaceDigest, resolveAskProviderConfiguration, runAskProviderTurn, secureAskJsonRequest,
  type ProviderHttpInput, type ProviderHttpResult, type AskToolCallResult } from "./model-ask.js";
import { authoringReadCheckpoint, assertAuthoringReadCheckpoint, authoringReadDecisionCheckpoint, assertAuthoringReadDecision, authoringQuestionCheckpoint, authoringQuestionAnswerCheckpoint, assertAuthoringQuestionHandoff, authoringGenerationCurrentnessCode, authoringGenerationHandled, authoringTransportCheckpoint, configureAuthoringGenerationRecovery,
  recoverAuthoringGeneration, prepareAuthoringManualRecovery, permitAuthoringManualRecovery,
  prepareAuthoringInterruptedRecovery, permitAuthoringInterruptedRecovery, createAuthoringHostEpisodeBudget,
  assertAuthoringTransportAdvance, authoringInterruptedRecoveryNeeded,
  validateAuthoringTransportState, withAuthoringGenerationRecovery,
  isAuthoringGenerationStop, type AuthoringGenerationHost, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { runRequiredAuthoringToolCall } from "./authoring-tool-call.js";

const servers: Server[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); } });
async function fixture(mode: string) {
  const bodies: string[] = []; let sends = 0;
  const server = createServer(async (req,res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
    bodies.push(Buffer.concat(chunks).toString()); sends++;
    if ((["B-success", "B-credit"].includes(mode) || mode.startsWith("B-refusal-")) && sends === 1 || mode === "B-always") { req.socket.destroy(); return; }
    if (mode === "B-tool-question" && sends === 1) { req.socket.destroy(); return; }
    if (mode === "tool-question" && sends === 1 || mode === "B-tool-question" && sends === 2) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({status: "completed", output: [{type: "function_call", call_id: "DERIVED-call", name: "runner__inspect", arguments: "{}"}]})); return;
    }
    if (mode === "tool-question" && sends === 2 || mode === "B-tool-question" && sends === 3) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({status: "completed", output: [{type: "message", role: "assistant", content: [{type: "output_text", text: "Which role reviews exceptions?"}]}]})); return;
    }
    if (mode.startsWith("B-refusal-")) mode = mode.slice("B-refusal-".length);
    if (mode === "B-credit") {res.writeHead(402); res.end('{"error":"DERIVED credit refusal"}'); return;}
    if (mode === "headers") { res.writeHead(200, {"content-type":"text/event-stream"}); res.flushHeaders(); setTimeout(() => res.destroy(),10); return; }
    if (mode === "partial" || mode === "complete-tool-no-end") {
      res.writeHead(200, {"content-type":"text/event-stream"});
      res.end('data: '+JSON.stringify({type:"response.output_item.added",item:{type:"function_call",name:"runner__inspect",arguments:mode === "partial" ? "" : "{}"}})+'\n\n'); return;
    }
    if (mode.startsWith("complete-chat-")) {
      const reason=mode.includes("filter") ? "content_filter" : "length";
      const payload='data: '+JSON.stringify({choices:[{delta:{content:"DERIVED"},finish_reason:reason}]})+'\n\ndata: [DONE]\n\n';
      res.writeHead(200,{"content-type":"text/event-stream",...(mode.endsWith("truncated")?{"content-length":"9999"}:{})});
      if(mode.endsWith("truncated")){res.write(payload);setTimeout(()=>res.destroy(),10);}else res.end(payload);
      return;
    }
    if (mode === "complete-responses-incomplete") {
      res.writeHead(200,{"content-type":"text/event-stream"});
      res.end('data: '+JSON.stringify({type:"response.incomplete",response:{status:"incomplete",incomplete_details:{reason:"max_output_tokens"},output:[]}})+'\n\n');return;
    }
    if (mode === "bad-json") { res.end('{"unfinished":'); return; }
    if (mode === "truncated-json" || mode === "C-success" && sends === 1 || mode === "success-C" && sends === 2) { res.writeHead(200,{"content-type":"application/json","content-length":"999"}); res.write('{"unfinished":');setTimeout(()=>res.destroy(),10);return; }
    if (mode.startsWith("schema400")) {
      const payload=JSON.stringify({error:{code:"invalid_function_parameters",param:"tools[0].parameters"}});
      res.writeHead(400,{"content-type":"application/json",...(mode.endsWith("truncated")?{"content-length":"9999"}:{})});
      if(mode.endsWith("truncated")){res.write(payload);setTimeout(()=>res.destroy(),10);}else res.end(payload);return;
    }
    if (mode === "402" || mode === "404") {res.writeHead(Number(mode));res.end('{"error":"DERIVED known refusal"}');return;}
    if (mode === "401" || mode === "429" || mode === "400" || mode === "503") { res.writeHead(Number(mode)); res.end('{"error":"DERIVED permanent refusal"}'); return; }
    if (mode === "narration-chat") {
      res.setHeader("content-type","application/json");res.end(JSON.stringify({choices:[{finish_reason:"stop",message:{role:"assistant",content:"Which role reviews exceptions?"}}]}));return;
    }
    res.setHeader("content-type","application/json"); res.end(JSON.stringify({status:"completed",output:mode === "narration" ? [{type:"message",role:"assistant",content:[{type:"output_text",text:"The saved draft is still pending."}]}] : []}));
  });
  servers.push(server); await new Promise<void>(r => server.listen(0,"127.0.0.1",r));
  return {server,endpoint:new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`),bodies,sends:()=>sends};
}
function memory(endpoint: URL, maximum: 0|1|2 = 2, duplicate = true) {
  let state: AuthoringTransportState = {version:1,policy:{maximum_additional_attempts:maximum,duplicate_generation_charges:duplicate,
    provider:"openai",model:"DERIVED",destination_digest:canonicalJsonDigest(endpoint.origin),actor:"local_installation_operator",reviewed_at:new Date().toISOString()},operations:[]};
  let context = canonicalJsonDigest("current"); const saved: AuthoringTransportState[] = [], messages: string[] = [];
  const host: AuthoringGenerationHost = {available:()=>true,read:()=>state,current:async()=>context,
    write:async next=>{validateAuthoringTransportState(next);state=structuredClone(next);saved.push(structuredClone(next));},progress:m=>messages.push(m)};
  return {host,saved,messages,read:()=>state,drift:()=>{context=canonicalJsonDigest("changed");},set:(s:AuthoringTransportState)=>{state=s;}};
}
const input = (endpoint:URL, signal = new AbortController().signal):ProviderHttpInput => ({endpoint,scope:"custom_loopback",headers:{},
  body:{model:"DERIVED",store:false,input:"DERIVED",max_output_tokens:10,tools:[]},signal,timeoutMs:10_000,
  stream:{format:"openai_responses"}});
const enter = <T>(m:ReturnType<typeof memory>, run:()=>Promise<T>) => withAuthoringGenerationRecovery(()=>{configureAuthoringGenerationRecovery(m.host);return run();});

describe("recorded interrupted authoring continuation",()=>{
  const checkpoint = canonicalJsonDigest("acknowledged local checkpoint");
  it("retains native C exactly while one explicit linked request completes normally",async()=>{
    const f=await fixture("C-success"),m=memory(f.endpoint,0);
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest)))
      .rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    const old=JSON.stringify(m.read().operations[0]);expect(m.read().operations[0]!.state).toBe("partial");
    await enter(m,async()=>{const p=await prepareAuthoringInterruptedRecovery(checkpoint);expect(p.remaining_attempts).toBe(2);
      await permitAuthoringInterruptedRecovery(p);});
    expect(f.sends()).toBe(1);expect(JSON.stringify(m.read().operations[0])).toBe(old);
    expect(authoringInterruptedRecoveryNeeded(m.read())).toBe(false);
    await enter(m,async()=>{const r=await recoverAuthoringGeneration({...input(f.endpoint),body:{...input(f.endpoint).body,input:"Continue the current reviewed task"}},secureAskJsonRequest);
      await authoringGenerationHandled([r]);m.set(authoringTransportCheckpoint(m.read())!);});
    expect(f.sends()).toBe(2);expect(JSON.stringify(m.read().operations[0])).toBe(old);
    expect(m.read().operations[1]!.state).toBe("checkpointed");
    expect(m.read().operations[1]!.recovery_of?.root_operation_id).toBe(m.read().operations[0]!.id);
    expect(m.read().interrupted_dispositions![0]!.status).toBe("admitted");
    expect(m.read().operations[0]!.checkpoint_seen).toBeUndefined();
  });
  it("pending inspection and a declined decision require no disposition or send",async()=>{
    const f=await fixture("truncated-json"),m=memory(f.endpoint,0);
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest))).rejects.toBeInstanceOf(AskError);
    const before=JSON.stringify(m.read());
    await enter(m,async()=>{await prepareAuthoringInterruptedRecovery(checkpoint);});
    expect(JSON.stringify(m.read())).toBe(before);expect(f.sends()).toBe(1);
    expect(authoringInterruptedRecoveryNeeded(m.read())).toBe(true);
  });
  it("multiple unresolved steps require exact local decisions before a linked continuation",async()=>{
    const f=await fixture("success-C"),m=memory(f.endpoint,0);
    await expect(enter(m,async()=>{
      await recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest);
      return recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest);
    })).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    const old=m.read().operations.map(o=>JSON.stringify(o));expect(m.read().operations.map(o=>o.state)).toEqual(["received","partial"]);
    await enter(m,async()=>{
      await expect(prepareAuthoringInterruptedRecovery(checkpoint)).rejects.toMatchObject({code:"ASK_GENERATION_INTERRUPTED_RECOVERY_UNAVAILABLE"});
      const p=await prepareAuthoringInterruptedRecovery(checkpoint,undefined,m.read().operations[0]!.id);
      expect(p.unresolved_operation_count).toBe(2);
      await expect(permitAuthoringInterruptedRecovery(p)).rejects.toMatchObject({code:"ASK_GENERATION_INTERRUPTED_RECOVERY_UNAVAILABLE"});
      await permitAuthoringInterruptedRecovery(p,{mode:"local_review"});
    });
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest))).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    await enter(m,async()=>{const p=await prepareAuthoringInterruptedRecovery(checkpoint);expect(p.unresolved_operation_count).toBe(1);
      await permitAuthoringInterruptedRecovery(p);});
    await enter(m,async()=>{const r=await recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest);
      await authoringGenerationHandled([r]);m.set(authoringTransportCheckpoint(m.read())!);});
    expect(m.read().operations.slice(0,2).map(o=>JSON.stringify(o))).toEqual(old);expect(f.sends()).toBe(3);
    expect(m.read().interrupted_dispositions!.map(d=>d.status)).toEqual(["local_review","admitted"]);
  });
  it("reuses fallback counters and correction flags across changed wording and restart",async()=>{
    const f=await fixture("C-success"),m=memory(f.endpoint,0);let owner="";
    await expect(enter(m,async()=>{const b=(await createAuthoringHostEpisodeBudget({keyDigest:canonicalJsonDigest("first question"),conversational:false}))!;
      owner=b.ownerId;await b.admitIteration();await b.reserveToolBatch(2);expect(await b.reserveCorrection()).toBe(true);
      expect(await b.reserveWordingCorrection()).toBe(true);
      try{return await recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest);}finally{b.release();}
    })).rejects.toBeInstanceOf(AskError);
    const old=JSON.stringify(m.read().operations[0]);
    await enter(m,async()=>{await permitAuthoringInterruptedRecovery(await prepareAuthoringInterruptedRecovery(checkpoint));});
    await enter(m,async()=>{const b=(await createAuthoringHostEpisodeBudget({keyDigest:canonicalJsonDigest("narrower current question"),conversational:false}))!;
      expect(b.ownerId).toBe(owner);expect(await b.reserveCorrection()).toBe(false);expect(await b.reserveWordingCorrection()).toBe(false);
      await b.admitIteration();await b.reserveToolBatch(1);
      const r=await recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest);await authoringGenerationHandled([r]);
      m.set(authoringTransportCheckpoint(m.read())!);b.release();});
    expect(m.read().episodes).toHaveLength(1);expect(m.read().episodes![0]).toMatchObject({iterations_used:2,tool_calls_used:3,correction_used:true,wording_correction_used:true});
    expect(JSON.stringify(m.read().operations[0])).toBe(old);expect(f.sends()).toBe(2);
  });
  it("three linked attempts stay exhausted while recorded local review remains available",async()=>{
    const f=await fixture("truncated-json"),m=memory(f.endpoint,0);const historical:string[]=[];
    for(let i=0;i<3;i++){
      await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest))).rejects.toBeInstanceOf(AskError);
      historical.push(JSON.stringify(m.read().operations[i]));
      if(i<2) await enter(m,async()=>{await permitAuthoringInterruptedRecovery(await prepareAuthoringInterruptedRecovery(checkpoint));});
    }
    await enter(m,async()=>{const p=await prepareAuthoringInterruptedRecovery(checkpoint);expect(p.remaining_attempts).toBe(0);
      await expect(permitAuthoringInterruptedRecovery(p)).rejects.toMatchObject({code:"ASK_GENERATION_INTERRUPTED_RECOVERY_UNAVAILABLE"});
      await permitAuthoringInterruptedRecovery(p,{mode:"local_review"});});
    expect(m.read().operations.map(o=>JSON.stringify(o))).toEqual(historical);expect(f.sends()).toBe(3);
    expect(m.read().interrupted_dispositions!.at(-1)).toMatchObject({status:"local_review",decision:"stop_and_review_current"});
    expect(m.read().interrupted_dispositions!.at(-1)!.replacement_operation_id).toBeUndefined();
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest)))
      .rejects.toMatchObject({code:"ASK_GENERATION_INTERRUPTED_RECOVERY_UNAVAILABLE"});expect(f.sends()).toBe(3);
  });
  it("a linked operation cannot renew the root's possible B duplicate reissue",async()=>{
    const f=await fixture("B-always"),m=memory(f.endpoint,2);m.host.allowRetries=()=>false;
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest)))
      .rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_UNKNOWN"});
    const old=JSON.stringify(m.read().operations[0]);m.host.allowRetries=()=>true;
    await enter(m,async()=>{await permitAuthoringInterruptedRecovery(await prepareAuthoringInterruptedRecovery(checkpoint));});
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest)))
      .rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_UNKNOWN"});
    expect(f.sends()).toBe(2);expect(m.read().operations[1]!.attempts).toHaveLength(1);
    expect(JSON.stringify(m.read().operations[0])).toBe(old);expect(m.messages).toEqual([]);
  });
  it("legacy local disposition does not create a fresh same-step budget",async()=>{
    const f=await fixture("C-success"),m=memory(f.endpoint,0);
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest))).rejects.toBeInstanceOf(AskError);
    const old=JSON.stringify(m.read().operations[0]);
    await enter(m,async()=>{await permitAuthoringInterruptedRecovery(await prepareAuthoringInterruptedRecovery(checkpoint),{mode:"local_review"});});
    await expect(enter(m,()=>createAuthoringHostEpisodeBudget({keyDigest:canonicalJsonDigest("same business step"),conversational:false})))
      .rejects.toMatchObject({code:"ASK_GENERATION_INTERRUPTED_RECOVERY_UNAVAILABLE"});
    expect(m.read().episodes).toBeUndefined();m.drift();
    await enter(m,async()=>{const b=(await createAuthoringHostEpisodeBudget({keyDigest:canonicalJsonDigest("different current stage"),conversational:false}))!;
      await b.admitIteration();const r=await recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest);
      await authoringGenerationHandled([r]);m.set(authoringTransportCheckpoint(m.read())!);b.release();});
    expect(JSON.stringify(m.read().operations[0])).toBe(old);expect(f.sends()).toBe(2);
  });
  it.each([false,true])("stale context or competing permission refuses before another request (%s)",async competing=>{
    const f=await fixture("truncated-json"),m=memory(f.endpoint,0);
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest))).rejects.toBeInstanceOf(AskError);
    await enter(m,async()=>{const p=await prepareAuthoringInterruptedRecovery(checkpoint);
      if(competing) await permitAuthoringInterruptedRecovery(p);else m.drift();
      const before=JSON.stringify(m.read());await expect(permitAuthoringInterruptedRecovery(p)).rejects.toMatchObject({code:"ASK_GENERATION_CONTEXT_CHANGED"});
      expect(JSON.stringify(m.read())).toBe(before);});expect(f.sends()).toBe(1);
  });
  it("a disposed live owner's late result cannot return or change its old operation",async()=>{
    const f=await fixture("healthy"),m=memory(f.endpoint,0);let release!:()=>void,started!:()=>void;
    const ready=new Promise<void>(r=>{started=r;});const blocked=new Promise<void>(r=>{release=r;});
    const first=enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),async()=>{started();await blocked;return {status:200,body:{status:"completed",output:[]}};}));
    const observed=first.catch(e=>e);await ready;
    await enter(m,async()=>{await permitAuthoringInterruptedRecovery(await prepareAuthoringInterruptedRecovery(checkpoint));});
    const before=JSON.stringify(m.read());release();expect(await observed).toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(JSON.stringify(m.read())).toBe(before);expect(m.read().operations[0]!.state).toBe("in_flight");expect(f.sends()).toBe(0);
  });
  it("a late successful response rechecks current business context before returning",async()=>{
    const f=await fixture("healthy"),m=memory(f.endpoint,0);
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),async()=>{m.drift();return {status:200,body:{status:"completed",output:[]}};})))
      .rejects.toMatchObject({code:"ASK_GENERATION_CONTEXT_CHANGED"});
    expect(m.read().operations[0]!.checkpoint_seen).toBeUndefined();expect(f.sends()).toBe(0);
  });
  it("Resume advance rejects deletion, old-output reclassification and counter resets",async()=>{
    const f=await fixture("truncated-json"),m=memory(f.endpoint,0);
    await expect(enter(m,async()=>{const b=(await createAuthoringHostEpisodeBudget({keyDigest:canonicalJsonDigest("stable owner"),conversational:false}))!;
      await b.admitIteration();await b.reserveToolBatch(1);await b.reserveCorrection();return recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest);})).rejects.toBeInstanceOf(AskError);
    await enter(m,async()=>{await permitAuthoringInterruptedRecovery(await prepareAuthoringInterruptedRecovery(checkpoint));});
    const old=structuredClone(m.read());
    for(const change of [(s:AuthoringTransportState)=>{s.interrupted_dispositions=[];},
      (s:AuthoringTransportState)=>{s.operations[0]!.state="checkpointed";},
      (s:AuthoringTransportState)=>{s.episodes![0]!.iterations_used=0;},
      (s:AuthoringTransportState)=>{s.episodes![0]!.correction_used=false;}]){
      const next=structuredClone(old);change(next);expect(()=>assertAuthoringTransportAdvance(old,next)).toThrow();
    }
    expect(JSON.stringify(m.read())).toBe(JSON.stringify(old));expect(f.sends()).toBe(1);
  });
});

describe("saved authoring generation transport recovery",()=>{
  it("retains a native no-response boundary for explicit manual recovery without automatic opt-in", async () => {
    const f = await fixture("B-success"), m = memory(f.endpoint, 0);
    m.set({version: 1, operations: []});
    await expect(enter(m, () => recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest)))
      .rejects.toMatchObject({code: "ASK_GENERATION_OUTCOME_UNKNOWN"});
    expect(f.sends()).toBe(1);
    expect(m.read().policy).toBeUndefined();
    expect((m.read().operations[0]!.attempts[0] as any).no_response_boundary).toMatchObject({
      version: 1, transport_closed: true, headers_received: false, content_received: false,
      response_consumer: "not_started", pure_local_generation: true, owner_cancelled: false,
    });
  });
  it("explicit manual permission survives restart and replaces exactly the same operation without acknowledging the old attempt", async () => {
    const f = await fixture("B-success"), m = memory(f.endpoint, 0);
    m.set({version: 1, operations: []});
    await expect(enter(m, () => recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest)))
      .rejects.toMatchObject({code: "ASK_GENERATION_OUTCOME_UNKNOWN"});
    const old = structuredClone(m.read().operations[0]!);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(old.deadline) + 1000);
    const preview = await enter(m, () => prepareAuthoringManualRecovery(canonicalJsonDigest("exact saved checkpoint")));
    expect(m.read().operations[0]).toEqual(old); // Inspecting is not consent.
    await enter(m, () => permitAuthoringManualRecovery(preview));
    expect(f.sends()).toBe(1);
    expect(m.read().policy).toBeUndefined();
    expect(m.read().operations[0]).toMatchObject({state: "unknown", attempts: old.attempts,
      manual_recovery: {actor: "local_installation_operator", status: "permitted", prior_attempt_id: old.attempts[0]!.id}});
    let consumers = 0;
    await enter(m, async () => {
      const response = await recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest);
      consumers++;
      await authoringGenerationHandled([response]);
      m.set(authoringTransportCheckpoint(m.read())!);
    });
    const after = m.read().operations[0]!;
    expect(f.sends()).toBe(2); expect(consumers).toBe(1); expect(f.bodies[1]).toBe(f.bodies[0]);
    expect(m.read().operations).toHaveLength(1);
    expect(after).toMatchObject({id: old.id, deadline: old.deadline, state: "checkpointed",
      manual_recovery: {status: "admitted", replacement_attempt_id: after.attempts[1]!.id}});
    expect(after.attempts[0]).toEqual(old.attempts[0]);
    expect(after.attempts.map(a => a.outcome)).toEqual(["B", "response"]);
    validateAuthoringTransportState(m.read());
    await expect(enter(m, () => prepareAuthoringManualRecovery(preview.checkpoint_digest)))
      .rejects.toMatchObject({code: "ASK_GENERATION_MANUAL_RECOVERY_UNAVAILABLE"});
    expect(f.sends()).toBe(2);
  });
  it("a manual replacement that fails again is terminal even with a later automatic opt-in", async () => {
    const f = await fixture("B-always"), m = memory(f.endpoint, 0);
    await expect(enter(m, () => recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest)))
      .rejects.toMatchObject({code: "ASK_GENERATION_OUTCOME_UNKNOWN"});
    const preview = await enter(m, () => prepareAuthoringManualRecovery(canonicalJsonDigest("checkpoint")));
    await enter(m, () => permitAuthoringManualRecovery(preview));
    m.set({...m.read(), policy: {...m.read().policy!, maximum_additional_attempts: 2}});
    await expect(enter(m, () => recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest)))
      .rejects.toMatchObject({code: "ASK_GENERATION_OUTCOME_UNKNOWN"});
    const stopped = structuredClone(m.read());
    expect(stopped.operations[0]!.attempts.map(a => a.outcome)).toEqual(["B", "B"]);
    await expect(enter(m, () => prepareAuthoringManualRecovery(preview.checkpoint_digest)))
      .rejects.toMatchObject({code: "ASK_GENERATION_MANUAL_RECOVERY_UNAVAILABLE"});
    await expect(enter(m, () => recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest)))
      .rejects.toMatchObject({code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(f.sends()).toBe(2); expect(m.read()).toEqual(stopped);
  });
  it("a refused manual replacement cannot become a new logical operation on restart", async () => {
    const f = await fixture("B-credit"), m = memory(f.endpoint, 0);
    await expect(enter(m, () => recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest)))
      .rejects.toMatchObject({code: "ASK_GENERATION_OUTCOME_UNKNOWN"});
    await enter(m, async () => permitAuthoringManualRecovery(await prepareAuthoringManualRecovery(canonicalJsonDigest("checkpoint"))));
    await expect(enter(m, () => recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest)))
      .rejects.toMatchObject({code: "ASK_PROVIDER_CREDIT_REQUIRED"});
    expect(f.sends()).toBe(2);
    const stopped = structuredClone(m.read());
    await expect(enter(m, () => recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest)))
      .rejects.toMatchObject({code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(f.sends()).toBe(2); expect(m.read()).toEqual(stopped);
  });
  it.each([["402", "ASK_PROVIDER_CREDIT_REQUIRED"], ["404", "ASK_PROVIDER_MODEL_UNAVAILABLE"],
    ["schema400", "ASK_PROVIDER_TOOL_SCHEMA_REJECTED"], ["401", "ASK_PROVIDER_AUTHENTICATION_FAILED"],
    ["429", "ASK_PROVIDER_RATE_LIMITED"]])("manual %s refusal retains its known reason and cannot escape through fallback or restart", async (mode, code) => {
    const f = await fixture(`B-refusal-${mode}`), m = memory(f.endpoint, 0);
    await expect(enter(m, () => recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest))).rejects.toMatchObject({code: "ASK_GENERATION_OUTCOME_UNKNOWN"});
    await enter(m, async () => permitAuthoringManualRecovery(await prepareAuthoringManualRecovery(canonicalJsonDigest("checkpoint"))));
    const error = await enter(m, () => recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest)).catch(e => e);
    expect(error.code).toBe(code);expect(isAuthoringGenerationStop(error)).toBe(true);
    expect(m.read().operations[0]!.manual_recovery?.failure_code).toBe(code);
    const before = structuredClone(m.read());
    await expect(enter(m, () => recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest))).rejects.toMatchObject({code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(f.sends()).toBe(2);expect(m.read()).toEqual(before);
  });
  it("a complete invalid model answer after manual replacement retains ordinary bounded correction", async () => {
    let sends = 0, callbacks = 0;
    const server = createServer(async (req, res) => {
      for await (const _ of req) { /* consume actual encoded request */ }
      if (++sends === 1) {req.socket.destroy();return;}
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({output: [{type: "function_call", call_id: "DERIVED", name: "runner__inspect", arguments: sends === 2 ? "{" : "{}"}]}));
    });servers.push(server);await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`), m = memory(endpoint, 0);
    const tools = [{name: "runner.inspect", description: "DERIVED", input_schema: {type: "object", properties: {}, additionalProperties: false}}];
    const authorityDigest = askToolSurfaceDigest(tools), configuration = resolveAskProviderConfiguration({provider: "openai", model: "DERIVED", api_key: "dummy-local-only", authority_digest: authorityDigest, egress_acknowledged: true}, {}, new Date());
    const run = () => runRequiredAuthoringToolCall({question: "DERIVED", toolName: "runner.inspect", run: question => runAskProviderTurn({configuration, tools, question, history: [], authorityDigest,
      gateway: {mode: "authoring", listTools: () => tools, close: async () => undefined, callTool: async () => {callbacks++;m.set(authoringTransportCheckpoint(m.read())!);return {ok: true, value: {accepted: true}};}},
      signal: new AbortController().signal, requiredInitialToolName: "runner.inspect", completeAfterRequiredTool: true,
      dependencies: {requestJson: i => secureAskJsonRequest({...i, endpoint, scope: "custom_loopback"})}})});
    await expect(enter(m, run)).rejects.toMatchObject({code: "ASK_GENERATION_OUTCOME_UNKNOWN"});
    await enter(m, async () => permitAuthoringManualRecovery(await prepareAuthoringManualRecovery(canonicalJsonDigest("checkpoint"))));
    const result = await enter(m, run);
    expect(result.correction_used).toBe(true);expect(sends).toBe(3);expect(callbacks).toBe(1);
    expect(m.read().operations[0]!.attempts.map(a => a.outcome)).toEqual(["B", "response"]);
    expect(m.read().operations[0]!.manual_recovery?.failure_code).toBeUndefined();
    expect(m.read().operations[0]!.state).toBe("refused");
  });
  it.each(["headers", "partial", "schema400", "bad-json", "503"])("manual review cannot reopen %s", async mode => {
    const f = await fixture(mode), m = memory(f.endpoint, 0);
    await expect(enter(m, () => recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest))).rejects.toBeDefined();
    const stopped = structuredClone(m.read());
    await expect(enter(m, () => prepareAuthoringManualRecovery(canonicalJsonDigest("checkpoint"))))
      .rejects.toMatchObject({code: "ASK_GENERATION_MANUAL_RECOVERY_UNAVAILABLE"});
    expect(m.read()).toEqual(stopped); expect(f.sends()).toBe(1);
  });
  it.each(["missing", "background", "conversation", "remote_tool", "stored_responses", "stored_chat"])("manual eligibility does not invent proof for %s", async mode => {
    const f = await fixture("B-success"), m = memory(f.endpoint, 0), request = input(f.endpoint);
    if (mode === "background") request.body.background = true;
    if (mode === "conversation") request.body.conversation = "remote-shared-state";
    if (mode === "remote_tool") request.body.tools = [{type: "web_search_preview"}];
    if (mode === "stored_responses") delete request.body.store;
    if (mode === "stored_chat") {
      request.endpoint = new URL("/v1/chat/completions", f.endpoint);
      request.stream = {format: "openai_chat"}; request.body.store = true;
    }
    await expect(enter(m, () => recoverAuthoringGeneration(request, secureAskJsonRequest)))
      .rejects.toMatchObject({code: "ASK_GENERATION_OUTCOME_UNKNOWN"});
    if (mode === "missing") delete m.read().operations[0]!.attempts[0]!.no_response_boundary;
    const stopped = structuredClone(m.read());
    await expect(enter(m, () => prepareAuthoringManualRecovery(canonicalJsonDigest("checkpoint"))))
      .rejects.toMatchObject({code: "ASK_GENERATION_MANUAL_RECOVERY_UNAVAILABLE"});
    expect(f.sends()).toBe(1); expect(m.read()).toEqual(stopped);
  });
  it.each(["source", "pending_state", "competing_permission", "lost_permission_ack"])("manual confirmation refuses %s without a new send", async change => {
    const f = await fixture("B-success"), m = memory(f.endpoint, 0);
    await expect(enter(m, () => recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest))).rejects.toBeDefined();
    const preview = await enter(m, () => prepareAuthoringManualRecovery(canonicalJsonDigest("checkpoint")));
    if (change === "source") m.drift();
    if (change === "pending_state") m.set({...m.read(), policy: {...m.read().policy!, maximum_additional_attempts: 1}});
    if (change === "competing_permission") await enter(m, () => permitAuthoringManualRecovery(preview));
    if (change === "lost_permission_ack") {
      const original = m.host.write;
      m.host.write = async state => {await original(state); throw new Error("DERIVED lost permission acknowledgement");};
    }
    await expect(enter(m, () => permitAuthoringManualRecovery(preview))).rejects.toBeDefined();
    expect(f.sends()).toBe(1);
    if (change === "lost_permission_ack") {
      expect(m.read().operations[0]!.manual_recovery?.status).toBe("permitted");
      await expect(enter(m, () => prepareAuthoringManualRecovery(preview.checkpoint_digest)))
        .rejects.toMatchObject({code: "ASK_GENERATION_MANUAL_RECOVERY_UNAVAILABLE"});
    }
  });
  it.each(["different_body", "different_route", "different_context", "unavailable"])("replacement cannot retarget %s", async change => {
    const f = await fixture("B-success"), m = memory(f.endpoint, 0);
    await expect(enter(m, () => recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest))).rejects.toBeDefined();
    const preview = await enter(m, () => prepareAuthoringManualRecovery(canonicalJsonDigest("checkpoint")));
    await enter(m, () => permitAuthoringManualRecovery(preview));
    const before = structuredClone(m.read()), request = input(f.endpoint);
    if (change === "different_body") request.body.input = "Different operation";
    if (change === "different_route") request.endpoint = new URL("/v2/responses", f.endpoint);
    if (change === "different_context") m.drift();
    if (change === "unavailable") m.host.available = () => false;
    await expect(enter(m, () => recoverAuthoringGeneration(request, secureAskJsonRequest)))
      .rejects.toMatchObject({code: change === "unavailable" ? "ASK_GENERATION_MANUAL_RECOVERY_UNAVAILABLE" : "ASK_GENERATION_CONTEXT_CHANGED"});
    expect(f.sends()).toBe(1); expect(m.read()).toEqual(before);
  });
  it("simultaneous confirmations in one owner append at most one permission", async () => {
    const f = await fixture("B-success"), m = memory(f.endpoint, 0);
    await expect(enter(m, () => recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest))).rejects.toBeDefined();
    await enter(m, async () => {
      const preview = await prepareAuthoringManualRecovery(canonicalJsonDigest("checkpoint")), beforeWrites = m.saved.length;
      const results = await Promise.allSettled([permitAuthoringManualRecovery(preview), permitAuthoringManualRecovery(preview)]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
      expect(m.saved.length - beforeWrites).toBe(1);
    });
    expect(f.sends()).toBe(1); expect(m.read().operations[0]!.manual_recovery?.status).toBe("permitted");
  });
  it.each(["admission", "response"])("crash after replacement %s cannot reset its consumed attempt", async phase => {
    const f = await fixture("B-success"), m = memory(f.endpoint, 0);
    await expect(enter(m, () => recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest))).rejects.toBeDefined();
    const preview = await enter(m, () => prepareAuthoringManualRecovery(canonicalJsonDigest("checkpoint")));
    await enter(m, () => permitAuthoringManualRecovery(preview));
    const original = m.host.write; let writes = 0;
    m.host.write = async s => {await original(s); if (++writes === (phase === "admission" ? 1 : 2)) throw new Error("DERIVED crash acknowledgement lost");};
    await expect(enter(m, () => recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest)))
      .rejects.toMatchObject({code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(f.sends()).toBe(phase === "admission" ? 1 : 2);
    expect(m.read().operations[0]!.manual_recovery?.status).toBe("admitted");
    m.host.write = original;
    const before = structuredClone(m.read());
    await expect(enter(m, () => recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest)))
      .rejects.toMatchObject({code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(m.read()).toEqual(before); expect(m.read().operations).toHaveLength(1);
  });
  it("retains healthy zero-retry baseline and marks only acknowledged local completion",async()=>{
    const f=await fixture("healthy"),m=memory(f.endpoint,0);
    await enter(m,async()=>{const r=await recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest);
      expect(m.read().operations[0]!.state).toBe("received");
      await authoringGenerationHandled([r]);expect(m.read().operations[0]!.state).toBe("handled");
      m.set(authoringTransportCheckpoint(m.read())!);});
    expect(f.sends()).toBe(1);expect(m.read().operations[0]!.state).toBe("checkpointed");
  });
  it("new current tracking can suppress inherited retries without resetting history or consent",async()=>{
    const f=await fixture("B-success"),m=memory(f.endpoint,2);
    const policy=structuredClone(m.read().policy);m.host.allowRetries=()=>false;
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest))).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_UNKNOWN"});
    expect(f.sends()).toBe(1);expect(m.read().policy).toEqual(policy);
    expect(m.read().operations[0]!.attempts).toHaveLength(1);
    expect(m.read().operations[0]!.attempts[0]!.outcome).toBe("B");
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest))).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(f.sends()).toBe(1);
  });
  it("opted-in B repeats only identical generation bytes, retains both attempts and returns once",async()=>{
    const f=await fixture("B-success"),m=memory(f.endpoint);let callbacks=0;
    await enter(m,async()=>{await recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest);callbacks++;});
    expect(f.sends()).toBe(2);expect(f.bodies[0]).toBe(f.bodies[1]);expect(callbacks).toBe(1);
    expect(m.read().operations[0]!.attempts.map(a=>a.outcome)).toEqual(["B","response"]);
    expect(m.messages).toHaveLength(1);
  });
  it.each([[0,true],[2,false]] as const)("zero cap/no duplicate opt-in never silently retries (%s/%s)",async(cap,permission)=>{
    const f=await fixture("B-success"),m=memory(f.endpoint,cap,permission);
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest))).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_UNKNOWN"});
    expect(f.sends()).toBe(1);
  });
  it("B is at most one reissue, and neither same-process retry UI nor restart resets it",async()=>{
    const f=await fixture("B-always"),m=memory(f.endpoint);
    await enter(m,async()=>{
      await expect(recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest)).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_UNKNOWN"});
      await expect(recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest)).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    });
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest))).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(f.sends()).toBe(2);
  });
  it.each(["headers","partial","complete-tool-no-end","truncated-json"])("%s remains C and cannot become a semantic correction",async mode=>{
    const f=await fixture(mode),m=memory(f.endpoint);let correction=0;
    await expect(enter(m,()=>runRequiredAuthoringToolCall({question:"DERIVED",toolName:"runner.inspect",onCorrection:()=>correction++,
      run:()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest)}))).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(f.sends()).toBe(1);expect(correction).toBe(0);expect(m.read().operations[0]!.attempts[0]!.outcome).toBe("C");
  });
  it("complete malformed JSON keeps the existing one model correction, not transport recovery",async()=>{
    const f=await fixture("bad-json"),m=memory(f.endpoint);let corrections=0;
    await expect(enter(m,()=>runRequiredAuthoringToolCall({question:"DERIVED",toolName:"runner.inspect",onCorrection:()=>corrections++,
      run:()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest)}))).rejects.toMatchObject({code:"ASK_PROVIDER_RESPONSE_INVALID"});
    expect(f.sends()).toBe(2);expect(corrections).toBe(1);expect(m.read().operations.map(o=>o.state)).toEqual(["refused","refused"]);
    expect(m.read().operations.every(o=>o.attempts.length===1 && o.attempts[0]!.outcome==="response")).toBe(true);
  });
  it.each([0,2] as const)("partial response and disabling retry cannot erase unresolved history (cap %s)",async cap=>{
    const f=await fixture("partial"),m=memory(f.endpoint,cap);
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest))).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    m.set({...m.read(),policy:{...m.read().policy!,maximum_additional_attempts:0,duplicate_generation_charges:false}});
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest))).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(f.sends()).toBe(1);expect(m.read().operations[0]!.state).toBe("partial");
  });
  it.each(["400","401","429"])("permanent HTTP%s does not get a transport retry",async mode=>{
    const f=await fixture(mode),m=memory(f.endpoint);
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest))).rejects.toBeInstanceOf(AskError);
    expect(f.sends()).toBe(1);
  });
  it("a complete local guard HTTP503 cannot masquerade as a retryable model failure",async()=>{
    const f=await fixture("503"),m=memory(f.endpoint);
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest)))
      .rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(f.sends()).toBe(1);expect(m.read().operations[0]!.state).toBe("partial");
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest)))
      .rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(f.sends()).toBe(1);
  });
  it("untrusted dependency/outer guard refusal has no minted A/B permission",async()=>{
    const f=await fixture("healthy"),m=memory(f.endpoint);let calls=0;
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),async()=>{calls++;throw Object.assign(new Error("guard refused"),{code:"ECONNRESET"});}))).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(calls).toBe(1);expect(f.sends()).toBe(0);
  });
  it.each([["schema400","ASK_PROVIDER_TOOL_SCHEMA_REJECTED"],["402","ASK_PROVIDER_CREDIT_REQUIRED"],["404","ASK_PROVIDER_MODEL_UNAVAILABLE"]])("complete native %s retains known refusal",async(mode,code)=>{
    const f=await fixture(mode!),m=memory(f.endpoint);
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest))).rejects.toMatchObject({code});
    expect(m.read().operations[0]).toMatchObject({state:"refused",attempts:[{outcome:"response"}]});expect(f.sends()).toBe(1);
  });
  it("a truncated schema refusal remains C and cannot resend",async()=>{
    const f=await fixture("schema400-truncated"),m=memory(f.endpoint);
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest))).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(m.read().operations[0]).toMatchObject({state:"partial",attempts:[{outcome:"C"}]});expect(f.sends()).toBe(1);
  });
  it.each(["generic_auth_code", "unsupported_auth_code", "unproved_typed_auth_code"])("an unproved %s cannot bypass the unknown-outcome fence",async kind=>{
    const f=await fixture("healthy"),m=memory(f.endpoint);let calls=0;
    const unknown=async()=>{calls++;throw kind === "generic_auth_code"
      ? Object.assign(new Error("credential=do-not-display"), {code:"ASK_PROVIDER_AUTHENTICATION_FAILED"})
      : new AskError(kind === "unproved_typed_auth_code" ? "ASK_PROVIDER_AUTHENTICATION_FAILED" : "ASK_PROVIDER_AUTH_FAILED", "Provider authentication failed.", 401);};
    const error=await enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),unknown)).catch(e=>e);
    expect(error.code).toBe("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION");expect(error.message).not.toContain("do-not-display");
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),unknown))).rejects.toMatchObject({code:error.code});
    expect(calls).toBe(1);expect(f.sends()).toBe(0);expect(m.read().operations[0]!.state).toBe("partial");
  });
  it("the preserved opaque POLICY_TEST_PROVIDER_UNAVAILABLE schedule cannot resend on restart",async()=>{
    const f=await fixture("healthy"),m=memory(f.endpoint,0);let calls=0;
    const unavailable=async()=>{calls++;throw new Error("POLICY_TEST_PROVIDER_UNAVAILABLE");};
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),unavailable))).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    const original=structuredClone(m.read());
    expect(original.operations[0]!.state).toBe("partial");
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),unavailable))).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(m.read()).toEqual(original);expect(calls).toBe(1);expect(f.sends()).toBe(0);
  });
  it.each(["complete-chat-length","complete-chat-filter","complete-responses-incomplete"])("terminal complete %s is a content refusal, never a transport reissue",async mode=>{
    const f=await fixture(mode),m=memory(f.endpoint);
    const request={...input(f.endpoint),stream:{format:mode.startsWith("complete-chat")?"openai_chat" as const:"openai_responses" as const}};
    await expect(enter(m,()=>recoverAuthoringGeneration(request,secureAskJsonRequest))).rejects.toMatchObject({code:"ASK_PROVIDER_RESPONSE_INCOMPLETE"});
    expect(f.sends()).toBe(1);expect(m.read().operations[0]!.state).toBe("refused");
    expect(m.read().operations[0]!.attempts.map(a=>a.outcome)).toEqual(["response"]);
  });
  it("a terminal-looking length event does not excuse a subsequently truncated transfer",async()=>{
    const f=await fixture("complete-chat-length-truncated"),m=memory(f.endpoint);
    await expect(enter(m,()=>recoverAuthoringGeneration({...input(f.endpoint),stream:{format:"openai_chat"}},secureAskJsonRequest)))
      .rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(f.sends()).toBe(1);expect(m.read().operations[0]!.state).toBe("partial");
  });
  it("source drift during B backoff prevents the otherwise healthy second send",async()=>{
    const f=await fixture("B-success"),m=memory(f.endpoint);m.host.progress=()=>m.drift();
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest))).rejects.toMatchObject({code:"ASK_GENERATION_CONTEXT_CHANGED"});expect(f.sends()).toBe(1);
  });
  it("owner cancellation during backoff prevents second send",async()=>{
    const f=await fixture("B-success"),m=memory(f.endpoint),abort=new AbortController();m.host.progress=()=>abort.abort();
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint,abort.signal),secureAskJsonRequest))).rejects.toBeDefined();expect(f.sends()).toBe(1);
  });
  it.each([0,2] as const)("failed pre-send CAS/lost response save acknowledgement never releases output (cap %s)",async cap=>{
    for(const loseAt of [1,2]) {
      const f=await fixture("healthy"),m=memory(f.endpoint,cap);let writes=0,returned=0;const original=m.host.write;
      m.host.write=async s=>{await original(s);if(++writes===loseAt)throw new Error("DERIVED acknowledgement lost");};
      await expect(enter(m,async()=>{await recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest);returned++;})).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
      expect(returned).toBe(0);expect(f.sends()).toBe(loseAt===1?0:1);
      m.host.write=original;
      await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest))).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    }
  });
  it.each([0,1,2,3])("recovery bookkeeping acknowledgement %s cannot be swallowed by narration",async failAt=>{
    const f=await fixture("narration"),m=memory(f.endpoint,0);let writes=0;const write=m.host.write;
    m.host.write=async next=>{await write(next);if(++writes===failAt)throw new Error("DERIVED private checkpoint acknowledgement lost");};
    const run=()=>narrateValidatedAuthoringStep({session:{provider:"openai",model:"DERIVED",apiKey:"dummy-key",conversation:createModelAuthoringConversation(),
      dependencies:{requestJson:request=>secureAskJsonRequest({...request,endpoint:f.endpoint,scope:"custom_loopback",headers:{}})}},
      egressAcknowledged:true,operatorMessage:"Explain this saved state.",validatedFacts:["The saved draft is still pending."]});
    if(!failAt){expect(await enter(m,run)).toBe("The saved draft is still pending.");expect(m.read().operations[0]!.state).toBe("handled");}
    else {
      const error=await enter(m,run).catch(e=>e);expect(error?.code).toBe("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION");
      expect(error.message).not.toContain("private checkpoint");
      m.host.write=write;
      await expect(enter(m,run)).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    }
    expect(f.sends()).toBe(failAt===1?0:1);
  });
  it.each(["POLICY_SOURCE_CHANGED", "BOUNDARY_AUTHORING_RESUME_CHANGED"])("known pre-write %s remains terminal through narration with its safe reason",async code=>{
    const f=await fixture("narration"),m=memory(f.endpoint,0);let writes=0;const write=m.host.write;
    m.host.write=async next=>{if(++writes===2)throw Object.assign(new Error("DERIVED private currentness detail"),{code});await write(next);};
    const run=()=>narrateValidatedAuthoringStep({session:{provider:"openai",model:"DERIVED",apiKey:"dummy-key",conversation:createModelAuthoringConversation(),
      dependencies:{requestJson:request=>secureAskJsonRequest({...request,endpoint:f.endpoint,scope:"custom_loopback",headers:{}})}},
      egressAcknowledged:true,operatorMessage:"Explain the saved state.",validatedFacts:["The saved draft is still pending."]});
    const error=await enter(m,run).catch(e=>e);
    expect(error?.code).toBe("ASK_GENERATION_CONTEXT_CHANGED");expect(authoringGenerationCurrentnessCode(error)).toBe(code);
    expect(error.message).not.toContain("private currentness");expect(m.read().operations[0]!.state).toBe("in_flight");
    m.host.write=write;
    await expect(enter(m,run)).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});expect(f.sends()).toBe(1);
  });
  it("genuine semantic invalid tool output retains the ordinary bounded correction",async()=>{
    let calls=0;
    const result=await runRequiredAuthoringToolCall({question:"DERIVED",toolName:"runner.inspect",run:async()=>{
      if(++calls===1)throw new AskError("ASK_TOOL_ARGUMENTS_INVALID","DERIVED invalid arguments");return "valid";
    }});expect(result.correction_used).toBe(true);expect(calls).toBe(2);
  });
  it("pure-generation eligibility refuses hosted/shared provider state",async()=>{
    const f=await fixture("B-success"),m=memory(f.endpoint);const i=input(f.endpoint);i.body.previous_response_id="not-authorized";
    await expect(enter(m,()=>recoverAuthoringGeneration(i,secureAskJsonRequest))).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_UNKNOWN"});expect(f.sends()).toBe(1);
  });
  it("positive new-connection refusal A can recover without duplicate-charge permission",async()=>{
    const f=await fixture("healthy"),port=(f.server.address() as AddressInfo).port;
    await new Promise<void>(r=>f.server.close(()=>r()));
    const m=memory(f.endpoint,1,false);
    m.host.progress=()=>{f.server.listen(port,"127.0.0.1");};
    await enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest));
    expect(f.sends()).toBe(1);expect(m.read().operations[0]!.attempts.map(a=>a.outcome)).toEqual(["A","response"]);
  });
  it.each([["openai", "automatic"], ["openrouter", "automatic"], ["openai", "manual"], ["openrouter", "manual"]] as const)("actual %s encoder/HTTP/callback schedule accepts only one local result after B (%s)",async(provider, recovery)=>{
    let sends=0,callbacks=0;const bodies:Record<string,unknown>[]=[];
    const server=createServer(async(req,res)=>{
      const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      if(++sends===1){req.socket.destroy();return;}
      res.setHeader("content-type","application/json");
      res.end(JSON.stringify(provider==="openai"?{id:"DERIVED",status:"completed",output:[{type:"function_call",call_id:"local",name:"runner__inspect",arguments:"{}"}]}
        :{choices:[{message:{role:"assistant",content:null,tool_calls:[{id:"local",type:"function",function:{name:"runner__inspect",arguments:"{}"}}]},finish_reason:"tool_calls"}]}));
    });servers.push(server);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
    const endpoint=new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`),m=memory(endpoint, recovery === "manual" ? 0 : 2);
    const tools=[{name:"runner.inspect",description:"DERIVED local inspection",input_schema:{type:"object",properties:{},additionalProperties:false}}];
    const authorityDigest=askToolSurfaceDigest(tools);
    const configuration=resolveAskProviderConfiguration({provider,model:provider==="openai"?"DERIVED":"openai/DERIVED",api_key:"DERIVED-key",
      authority_digest:authorityDigest,egress_acknowledged:true}, {},new Date());
    // Endpoint-only dependency retains the exact product encoder and real native
    // client. It neither retries nor substitutes model output after transport.
    m.set({...m.read(),policy:{...m.read().policy!,model:provider==="openai"?"DERIVED":"openai/DERIVED",destination_digest:canonicalJsonDigest(provider==="openai"?"https://api.openai.com":"https://openrouter.ai")}});
    const run=()=>runAskProviderTurn({configuration,question:"DERIVED",history:[],tools,authorityDigest,
      gateway:{mode:"authoring",listTools:()=>tools,close:async()=>undefined,callTool:async()=>{callbacks++;m.set(authoringTransportCheckpoint(m.read())!);return {ok:true,value:{accepted:true}};}},
      signal:new AbortController().signal,requiredInitialToolName:"runner.inspect",completeAfterRequiredTool:true,
      dependencies:{requestJson:i=>secureAskJsonRequest({...i,endpoint,scope:"custom_loopback"})}});
    let original: AuthoringTransportState | undefined;
    if (recovery === "manual") {
      delete m.read().policy;
      await expect(enter(m, run)).rejects.toMatchObject({code: "ASK_GENERATION_OUTCOME_UNKNOWN"});
      expect(callbacks).toBe(0); expect(sends).toBe(1);
      original = structuredClone(m.read());
      await enter(m, async () => permitAuthoringManualRecovery(await prepareAuthoringManualRecovery(canonicalJsonDigest("actual encoder saved checkpoint"))));
    }
    const result=await enter(m,run);
    expect(result.tool_calls).toHaveLength(1);expect(callbacks).toBe(1);expect(sends).toBe(2);expect(bodies[0]).toEqual(bodies[1]);
    expect(m.read().operations[0]!.state).toBe("checkpointed");
    if (original) {
      expect(m.read().operations).toHaveLength(1);
      expect(m.read().operations[0]!.id).toBe(original.operations[0]!.id);
      expect(m.read().operations[0]!.attempts[0]).toEqual(original.operations[0]!.attempts[0]);
      expect(m.read().operations[0]!.manual_recovery?.status).toBe("admitted");
      expect(m.read().policy).toBeUndefined();
    }
    if(provider==="openai"){expect(bodies[0]!.store).toBe(false);expect(bodies[0]!.parallel_tool_calls).toBe(false);}
    else expect(bodies[0]!.provider).toMatchObject({allow_fallbacks:false,data_collection:"deny"});
  });

  it.each(["openai_responses","openai_chat","anthropic"] as const)("%s uses its actual completion contract for complete invalid arguments",async format=>{
    const events = format === "openai_responses"
      ? [{type:"response.output_item.added",item:{type:"function_call",name:"runner__inspect"}}, {type:"response.completed",response:{status:"completed",output:[{type:"function_call",call_id:"x",name:"runner__inspect",arguments:"{"}]}}]
      : format === "openai_chat"
        ? [{choices:[{delta:{tool_calls:[{index:0,id:"x",function:{name:"runner__inspect",arguments:"{"}}]},finish_reason:"tool_calls"}]}]
        : [{type:"message_start",message:{usage:{input_tokens:1}}},{type:"content_block_start",index:0,content_block:{type:"tool_use",id:"x",name:"runner__inspect"}},
          {type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:"{"}},{type:"message_stop"}];
    let sends=0;const server=createServer(async(req,res)=>{for await(const _ of req){}sends++;res.setHeader("content-type","text/event-stream");
      res.end(events.map(e=>"data: "+JSON.stringify(e)+"\n\n").join(""));});servers.push(server);
    await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
    const endpoint=new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`),m=memory(endpoint);
    const i={...input(endpoint),stream:{format}};
    if(format === "anthropic") {
      await expect(enter(m,()=>recoverAuthoringGeneration(i,secureAskJsonRequest))).rejects.toMatchObject({code:"ASK_TOOL_ARGUMENTS_INVALID"});
      expect(m.read().operations[0]!.state).toBe("refused");
    } else {
      // The completed adapter envelope is returned unchanged. Its ordinary
      // downstream argument parser, not a transport retry, owns the bad JSON.
      const result=await enter(m,()=>recoverAuthoringGeneration(i,secureAskJsonRequest));
      expect(JSON.stringify(result.body)).toContain('"arguments":"{"');
      expect(m.read().operations[0]!.attempts[0]!.outcome).toBe("response");
    }
    expect(sends).toBe(1);
  });
  it.each([0,2] as const)("a tool save with lost acknowledgement is C and cannot replay at cap %s",async cap=>{
    const f=await fixture("healthy"),m=memory(f.endpoint,cap);let calls=0,callbacks=0;
    const tools=[{name:"runner.inspect",description:"DERIVED",input_schema:{type:"object",properties:{},additionalProperties:false}}];
    const authorityDigest=askToolSurfaceDigest(tools), configuration=resolveAskProviderConfiguration({provider:"openai",model:"DERIVED",api_key:"DERIVED-key",authority_digest:authorityDigest,egress_acknowledged:true},{},new Date());
    const run=()=>runAskProviderTurn({configuration,question:"DERIVED",history:[],tools,authorityDigest,signal:new AbortController().signal,
      requiredInitialToolName:"runner.inspect",completeAfterRequiredTool:true,
      gateway:{mode:"authoring",listTools:()=>tools,close:async()=>{},callTool:async()=>{
        callbacks++;m.set(authoringTransportCheckpoint(m.read())!);throw new Error("DERIVED save acknowledgement lost");}},
      dependencies:{requestJson:async()=>{calls++;return {status:200,body:{status:"completed",output:[{type:"function_call",call_id:"x",name:"runner__inspect",arguments:"{}"}]}};}}});
    await expect(enter(m,run)).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(m.read().operations[0]!.state).toBe("partial");
    await expect(enter(m,run)).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(calls).toBe(1);expect(callbacks).toBe(1);
  });
  it("serial admission fences overlapping generation while preserving the healthy companion",async()=>{
    const f=await fixture("healthy"),m=memory(f.endpoint,0);let unblock!:()=>void;
    const pending=new Promise<void>(r=>{unblock=r;});let calls=0;
    await enter(m,async()=>{
      const first=recoverAuthoringGeneration(input(f.endpoint),async i=>{calls++;await pending;return secureAskJsonRequest(i);});
      await new Promise(r=>setTimeout(r,10));
      await expect(recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest)).rejects.toMatchObject({code:"ASK_GENERATION_ALREADY_ACTIVE"});
      unblock();const r=await first;await authoringGenerationHandled([r]);m.set(authoringTransportCheckpoint(m.read())!);
    });expect(calls).toBe(1);expect(f.sends()).toBe(1);
  });

  it("a late dependency response cannot extend the original generation deadline",async()=>{
    const f=await fixture("healthy"),m=memory(f.endpoint);let calls=0;
    await expect(enter(m,()=>recoverAuthoringGeneration({...input(f.endpoint),timeoutMs:15},async()=>{
      calls++;await new Promise(r=>setTimeout(r,30));return {status:200,body:{status:"completed",output:[]}};
    }))).rejects.toMatchObject({code:"ASK_GENERATION_DEADLINE"});
    expect(calls).toBe(1);expect(m.read().operations[0]!.state).toBe("partial");
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest))).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(f.sends()).toBe(0);
  });
  it("66 sequential actual native requests retain one acknowledged result per generation",async()=>{
    const f=await fixture("healthy"),m=memory(f.endpoint,0);
    await enter(m,async()=>{
      for(let n=0;n<66;n++){
        const r=await recoverAuthoringGeneration({...input(f.endpoint),body:{...input(f.endpoint).body,input:`DERIVED step ${n}`}},secureAskJsonRequest);
        expect(r.body.status).toBe("completed");await authoringGenerationHandled([r]);m.set(authoringTransportCheckpoint(m.read())!);
      }
    });
    expect(f.sends()).toBe(66);expect(m.read().operations).toHaveLength(66);
    for (const sockets of Object.values(globalAgent.freeSockets)) for (const socket of sockets ?? []) {
      expect(socket.listenerCount("connect")).toBeLessThanOrEqual(1);
      expect(socket.listenerCount("secureConnect")).toBeLessThanOrEqual(1);
    }
    expect(new Set(m.read().operations.map(o=>o.attempts[0]!.id)).size).toBe(66);
    expect(m.read().operations.every(o=>o.state==="checkpointed"&&o.attempts.length===1)).toBe(true);
  });
  it("a live nested review may inherit only completed owned operations; a restart may not",async()=>{
    const f=await fixture("healthy"),m=memory(f.endpoint,0);
    await enter(m,async()=>{
      const r=await recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest);await authoringGenerationHandled([r]);
      await withAuthoringGenerationRecovery(async()=>{configureAuthoringGenerationRecovery(m.host);
        const next=await recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest);await authoringGenerationHandled([next]);m.set(authoringTransportCheckpoint(m.read())!);
      },true);
    });expect(f.sends()).toBe(2);expect(m.read().operations.every(o=>o.state==="checkpointed")).toBe(true);
    const f2=await fixture("healthy"),m2=memory(f2.endpoint,0);
    await enter(m2,async()=>{const r=await recoverAuthoringGeneration(input(f2.endpoint),secureAskJsonRequest);await authoringGenerationHandled([r]);});
    await expect(enter(m2,()=>recoverAuthoringGeneration(input(f2.endpoint),secureAskJsonRequest))).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(f2.sends()).toBe(1);
  });

});


describe("B33 exact completed consumer handoff", () => {
  async function toolQuestion(endpoint: URL, callback: () => Promise<AskToolCallResult>) {
    const tools = [{name: "runner.inspect", description: "DERIVED", input_schema: {type: "object", properties: {}, additionalProperties: false}}];
    const authorityDigest = askToolSurfaceDigest(tools);
    const configuration = resolveAskProviderConfiguration({provider: "openai", model: "DERIVED", api_key: "DERIVED-key",
      authority_digest: authorityDigest, egress_acknowledged: true}, {}, new Date());
    const result = await runAskProviderTurn({configuration, question: "DERIVED", history: [], tools, authorityDigest,
      signal: new AbortController().signal, gateway: {mode: "authoring", listTools: () => tools, close: async () => {}, callTool: callback},
      dependencies: {requestJson: r => secureAskJsonRequest({...r, endpoint, scope: "custom_loopback", headers: {}})}});
    const completion = completedAuthoringQuestion(result)!;
    return {digest: canonicalJsonDigest({completion, question: result.answer}), pending_question: {question: result.answer, completion}};
  }
  it.each(["private_prerequisite", "prerequisite_mapping"] as const)("binds a native internal Read result without inventing human consent: %s", async kind => {
    const f = await fixture("tool-question"), m = memory(f.endpoint, 0);
    const record = { consumer: "read_revision" as const, kind, material_digest: canonicalJsonDigest({ reason: "Review the necessary access meaning." }) };
    const completion = await enter(m, async () => {
      const cp = await toolQuestion(f.endpoint, async () => ({ ok: true, value: { status: "internal_mapping_request" } }));
      const completion = cp.pending_question.completion;
      expect(() => authoringReadCheckpoint(m.read(), { ...completion, response_digest: canonicalJsonDigest("foreign response") }, record))
        .toThrow("completed consumer association");
      m.set(authoringReadCheckpoint(m.read(), completion, record));
      return completion;
    });
    assertAuthoringReadCheckpoint(m.read(), completion, record);
    if (kind === "prerequisite_mapping") {
      const material = { reason: "Review the necessary access meaning." }, decision = { state: "confirmed", operator_evidence: "Use this exact proposed condition." };
      expect(() => assertAuthoringReadDecision(m.read(), completion, material, decision)).toThrow("operator decision");
      m.set(authoringReadDecisionCheckpoint(m.read(), completion, material, decision));
      assertAuthoringReadDecision(m.read(), completion, material, decision);
      expect(() => authoringReadDecisionCheckpoint(m.read(), completion, material, { state: "revise", instruction: "A different choice" })).toThrow("RESUME_INVALID");
    }
    expect(m.read().operations.every(op => op.state === "checkpointed")).toBe(true);
    expect(m.read().operations.every(op => !op.question_handoff)).toBe(true);
    expect(() => assertAuthoringReadCheckpoint(m.read(), completion, { ...record, material_digest: canonicalJsonDigest("wrong source") })).toThrow("RESUME_INVALID");
    await enter(m, async () => {
      expect(() => authoringReadCheckpoint(m.read(), completion, record)).toThrow("completed consumer association");
      assertAuthoringReadCheckpoint(m.read(), completion, record);
    });
    expect(f.sends()).toBe(2); // Resume checks the persisted receipt; it cannot mint another native completion.
  });
  it.each(["planning", "read_clarification", "read_value_context"] as const)("the actual completed turn binds the selected host consumer: %s", async consumer => {
    const f = await fixture("tool-question"), m = memory(f.endpoint, 0);
      const cp = await enter(m, async () => {
        const completed = await toolQuestion(f.endpoint, async () => ({ok: true, value: {status: "clarification"}}));
        const cp = {...completed, consumer};
        m.set(authoringTransportCheckpoint(authoringQuestionCheckpoint(m.read(), cp))!);
        return cp;
      });
      assertAuthoringQuestionHandoff(m.read(), cp);
      expect(() => assertAuthoringQuestionHandoff(m.read(), {...cp, consumer: "action_rule_clarification"})).toThrow("RESUME_INVALID");
      const next = {digest: canonicalJsonDigest({question: cp.pending_question.question, answer: "This selected record."}),
        operator_messages: ["This selected record."]};
      m.set(authoringQuestionAnswerCheckpoint(m.read(), cp, next)!);
      validateAuthoringTransportState(m.read());
      expect(m.read().operations.at(-1)!.question_handoff).toMatchObject({consumer,
        answered: {answer: "This selected record.", actor: "local_installation_operator"}});
      expect(f.sends()).toBe(2);
      // The shared fixture's afterEach closes its owned server/connections.
  });
  it("a recovered tool and question from one completed turn remain resumable after the saved answer", async () => {
    const f = await fixture("B-tool-question"), m = memory(f.endpoint, 0); let callbacks = 0;
    const call = () => toolQuestion(f.endpoint, async () => { callbacks++; return {ok: true, value: {status: "clarification"}}; });
    await expect(enter(m, call)).rejects.toMatchObject({code: "ASK_GENERATION_OUTCOME_UNKNOWN"});
    await enter(m, async () => { await permitAuthoringManualRecovery(await prepareAuthoringManualRecovery(canonicalJsonDigest("saved B"))); });
    const cp = await enter(m, async () => {
      const cp = await call();
      m.set(authoringTransportCheckpoint(authoringQuestionCheckpoint(m.read(), cp))!);
      return cp;
    });
    expect(f.sends()).toBe(3); expect(callbacks).toBe(1); expect(f.bodies[1]).toBe(f.bodies[0]);
    const original = m.read().operations[0]!;
    expect(original.attempts.map(a => a.outcome)).toEqual(["B", "response"]);
    expect(original.manual_recovery?.status).toBe("admitted");
    await enter(m, async () => {
      assertAuthoringQuestionHandoff(m.read(), cp);
      const next = {digest: canonicalJsonDigest("answered current question"), operator_messages: ["One scoped reviewer."]};
      m.set(authoringQuestionAnswerCheckpoint(m.read(), cp, next)!);
      await expect(recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest)).resolves.toMatchObject({status: 200});
    });
    expect(f.sends()).toBe(4); expect(callbacks).toBe(1);
    expect(m.read().operations[0]!.state).toBe("checkpointed");
  });
  it("the same-turn question acknowledgement excludes an unrelated earlier handled response", async () => {
    const prior = await fixture("narration"), f = await fixture("tool-question"), m = memory(f.endpoint, 0); let callbacks = 0;
    await enter(m, async () => {
      await completedQuestion(m, prior.endpoint); // No committed handoff for this separate turn.
      const cp = await toolQuestion(f.endpoint, async () => { callbacks++; return {ok: true, value: {status: "inspected"}}; });
      m.set(authoringTransportCheckpoint(authoringQuestionCheckpoint(m.read(), cp))!);
      expect(m.read().operations.map(op => op.state)).toEqual(["handled", "checkpointed", "checkpointed"]);
    });
    await expect(enter(m, () => recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest)))
      .rejects.toMatchObject({code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(prior.sends()).toBe(1); expect(f.sends()).toBe(2); expect(callbacks).toBe(1);
  });
  it("a failed tool consumer cannot mint a same-turn question acknowledgement", async () => {
    const f = await fixture("tool-question"), m = memory(f.endpoint, 0);
    await expect(enter(m, () => toolQuestion(f.endpoint, async () => { throw new Error("DERIVED uncertain callback acknowledgement"); })))
      .rejects.toMatchObject({code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(m.read().operations[0]!.state).toBe("partial");
    await expect(enter(m, () => recoverAuthoringGeneration(input(f.endpoint), secureAskJsonRequest)))
      .rejects.toMatchObject({code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(f.sends()).toBe(1);
  });
  it("same-turn checkpoint refuses a changed sibling and cannot reload its private association", async () => {
    const f = await fixture("tool-question"), m = memory(f.endpoint, 0); let cp: Awaited<ReturnType<typeof toolQuestion>>;
    await enter(m, async () => {
      cp = await toolQuestion(f.endpoint, async () => ({ok: true, value: {status: "inspected"}}));
      const changed = structuredClone(m.read()); changed.operations[0]!.request_digest = canonicalJsonDigest("competing request");
      expect(() => authoringQuestionCheckpoint(changed, cp)).toThrow("RESUME_INVALID");
      expect(m.read().operations.every(op => op.state === "handled")).toBe(true);
    });
    await expect(enter(m, async () => authoringQuestionCheckpoint(m.read(), cp!)))
      .rejects.toMatchObject({code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(m.read().operations.every(op => op.state === "handled")).toBe(true); expect(f.sends()).toBe(2);
  });
  async function completedQuestion(m: ReturnType<typeof memory>, endpoint: URL, provider: "openai"|"openrouter" = "openai") {
    const tools = [{name:"runner.inspect",description:"DERIVED",input_schema:{type:"object",properties:{},additionalProperties:false}}];
    const authorityDigest = askToolSurfaceDigest(tools);
    const configuration = resolveAskProviderConfiguration({provider,model:provider === "openrouter" ? "openai/gpt-5.6-terra" : "DERIVED",api_key:"DERIVED-key",authority_digest:authorityDigest,egress_acknowledged:true},{},new Date());
    const result = await runAskProviderTurn({configuration,question:"DERIVED",history:[],tools,authorityDigest,signal:new AbortController().signal,
      gateway:{mode:"authoring",listTools:()=>tools,close:async()=>{},callTool:async()=>{throw new Error("Unexpected callback");}},
      dependencies:{requestJson:r=>secureAskJsonRequest({...r,endpoint,scope:"custom_loopback",headers:{}})}});
    const completion = completedAuthoringQuestion(result)!;
    expect(completion.operation_id).toBe(m.read().operations.at(-1)!.id);
    return {digest:canonicalJsonDigest({completion,question:result.answer}),pending_question:{question:result.answer,completion}};
  }
  it.each(["openai","openrouter"] as const)("%s actual encoder retains an exact durable question association",async provider=>{
    const f=await fixture(provider === "openrouter" ? "narration-chat" : "narration"),m=memory(f.endpoint,0);
    await enter(m,async()=>{
      const cp=await completedQuestion(m,f.endpoint,provider);
      m.set(authoringTransportCheckpoint(authoringQuestionCheckpoint(m.read(),cp))!);
      assertAuthoringQuestionHandoff(m.read(),cp);
      expect(m.read().operations[0]!.question_handoff!.question).toBe(cp.pending_question.question);
    });
    expect(f.sends()).toBe(1);const sent=JSON.parse(f.bodies[0]!);
    if(provider === "openai"){expect(sent.store).toBe(false);expect(sent.parallel_tool_calls).toBe(false);}
    else expect(sent.provider).toMatchObject({allow_fallbacks:false,data_collection:"deny"});
  });
  it("binds decoded response, exact checkpoint and attributed answer without acknowledging historical work", async () => {
    const f=await fixture("narration"),m=memory(f.endpoint,0);
    const cp=await enter(m,async()=>{
      const cp=await completedQuestion(m,f.endpoint);
      expect(m.read().operations[0]!.state).toBe("handled");
      expect(()=>assertAuthoringQuestionHandoff(m.read(),cp)).toThrow("RESUME_INVALID");
      m.set(authoringQuestionCheckpoint(m.read(),cp)!);
      validateAuthoringTransportState(m.read());
      assertAuthoringQuestionHandoff(m.read(),cp);
      return cp;
    });
    await enter(m,async()=>{assertAuthoringQuestionHandoff(m.read(),cp);});
    expect(f.sends()).toBe(1);
    const next={digest:canonicalJsonDigest("answered checkpoint"),operator_messages:["One scoped reviewer."]};
    const answered=authoringQuestionAnswerCheckpoint(m.read(),cp,next)!;
    expect(answered.operations[0]!.question_handoff).toMatchObject({question:cp.pending_question.question,
      answered:{answer:"One scoped reviewer.",actor:"local_installation_operator",checkpoint_digest:next.digest}});
    validateAuthoringTransportState(answered);
    expect(()=>authoringQuestionAnswerCheckpoint(answered,cp,next)).toThrow("RESUME_INVALID");
    expect(()=>assertAuthoringQuestionHandoff(m.read(),{...cp,digest:canonicalJsonDigest("competing checkpoint")})).toThrow("RESUME_INVALID");
    expect(()=>assertAuthoringQuestionHandoff(m.read(),{...cp,pending_question:{...cp.pending_question,question:"Different question"}})).toThrow("RESUME_INVALID");
    await expect(enter(m,async()=>authoringQuestionCheckpoint(m.read(),cp))).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(f.sends()).toBe(1);
  });
  it("the enclosing generic checkpoint cannot promote an unrelated earlier handled operation",async()=>{
    const f=await fixture("narration"),m=memory(f.endpoint,0);
    await enter(m,async()=>{
      await completedQuestion(m,f.endpoint); // No typed handoff: remains unresolved.
      const cp=await completedQuestion(m,f.endpoint);
      m.set(authoringTransportCheckpoint(authoringQuestionCheckpoint(m.read(),cp))!);
      expect(m.read().operations.map(op=>op.state)).toEqual(["handled","checkpointed"]);
      const next={digest:canonicalJsonDigest("answer"),operator_messages:["One scoped reviewer."]};
      m.set(authoringTransportCheckpoint(authoringQuestionAnswerCheckpoint(m.read(),cp,next))!);
      expect(m.read().operations.map(op=>op.state)).toEqual(["handled","checkpointed"]);
    });
    await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest))).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    expect(f.sends()).toBe(2);
  });
  it.each([false,true])("handoff write acknowledgement loss recovers only from an actual committed pair (committed %s)",async committed=>{
    const f=await fixture("narration"),m=memory(f.endpoint,0);
    let cp: Awaited<ReturnType<typeof completedQuestion>>|undefined;
    await expect(enter(m,async()=>{
      cp=await completedQuestion(m,f.endpoint);
      const next=authoringQuestionCheckpoint(m.read(),cp)!;
      if(committed)m.set(next); // DERIVED single-file commit before lost acknowledgement.
      throw new Error("DERIVED handoff write failed");
    })).rejects.toThrow("DERIVED handoff write failed");
    if(committed)assertAuthoringQuestionHandoff(m.read(),cp);
    else {
      expect(()=>assertAuthoringQuestionHandoff(m.read(),cp)).toThrow("RESUME_INVALID");
      await expect(enter(m,()=>recoverAuthoringGeneration(input(f.endpoint),secureAskJsonRequest))).rejects.toMatchObject({code:"ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"});
    }
    expect(f.sends()).toBe(1);
  });
});
