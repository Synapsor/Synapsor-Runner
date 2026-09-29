import { narrateValidatedAuthoringStep } from "./model-authoring-narration.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import { createServer, globalAgent, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { AskError, completedAuthoringQuestion, askToolSurfaceDigest, resolveAskProviderConfiguration, runAskProviderTurn, secureAskJsonRequest,
  type ProviderHttpInput, type ProviderHttpResult } from "./model-ask.js";
import { authoringQuestionCheckpoint, authoringQuestionAnswerCheckpoint, assertAuthoringQuestionHandoff, authoringGenerationCurrentnessCode, authoringGenerationHandled, authoringTransportCheckpoint, configureAuthoringGenerationRecovery,
  recoverAuthoringGeneration, validateAuthoringTransportState, withAuthoringGenerationRecovery,
  type AuthoringGenerationHost, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { runRequiredAuthoringToolCall } from "./authoring-tool-call.js";

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); } });
async function fixture(mode: string) {
  const bodies: string[] = []; let sends = 0;
  const server = createServer(async (req,res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
    bodies.push(Buffer.concat(chunks).toString()); sends++;
    if ((mode === "B-success" && sends === 1) || mode === "B-always") { req.socket.destroy(); return; }
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
    if (mode === "truncated-json") { res.writeHead(200,{"content-type":"application/json","content-length":"999"}); res.write('{"unfinished":');setTimeout(()=>res.destroy(),10);return; }
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

describe("saved authoring generation transport recovery",()=>{
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
  it.each(["openai","openrouter"] as const)("actual %s encoder/HTTP/callback schedule accepts only one local result after B",async provider=>{
    let sends=0,callbacks=0;const bodies:Record<string,unknown>[]=[];
    const server=createServer(async(req,res)=>{
      const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      if(++sends===1){req.socket.destroy();return;}
      res.setHeader("content-type","application/json");
      res.end(JSON.stringify(provider==="openai"?{id:"DERIVED",status:"completed",output:[{type:"function_call",call_id:"local",name:"runner__inspect",arguments:"{}"}]}
        :{choices:[{message:{role:"assistant",content:null,tool_calls:[{id:"local",type:"function",function:{name:"runner__inspect",arguments:"{}"}}]},finish_reason:"tool_calls"}]}));
    });servers.push(server);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
    const endpoint=new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`),m=memory(endpoint);
    const tools=[{name:"runner.inspect",description:"DERIVED local inspection",input_schema:{type:"object",properties:{},additionalProperties:false}}];
    const authorityDigest=askToolSurfaceDigest(tools);
    const configuration=resolveAskProviderConfiguration({provider,model:provider==="openai"?"DERIVED":"openai/DERIVED",api_key:"DERIVED-key",
      authority_digest:authorityDigest,egress_acknowledged:true}, {},new Date());
    // Endpoint-only dependency retains the exact product encoder and real native
    // client. It neither retries nor substitutes model output after transport.
    m.set({...m.read(),policy:{...m.read().policy!,model:provider==="openai"?"DERIVED":"openai/DERIVED",destination_digest:canonicalJsonDigest(provider==="openai"?"https://api.openai.com":"https://openrouter.ai")}});
    const result=await enter(m,()=>runAskProviderTurn({configuration,question:"DERIVED",history:[],tools,authorityDigest,
      gateway:{mode:"authoring",listTools:()=>tools,close:async()=>undefined,callTool:async()=>{callbacks++;m.set(authoringTransportCheckpoint(m.read())!);return {ok:true,value:{accepted:true}};}},
      signal:new AbortController().signal,requiredInitialToolName:"runner.inspect",completeAfterRequiredTool:true,
      dependencies:{requestJson:i=>secureAskJsonRequest({...i,endpoint,scope:"custom_loopback"})}}));
    expect(result.tool_calls).toHaveLength(1);expect(callbacks).toBe(1);expect(sends).toBe(2);expect(bodies[0]).toEqual(bodies[1]);
    expect(m.read().operations[0]!.state).toBe("checkpointed");
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
