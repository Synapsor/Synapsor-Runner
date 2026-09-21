import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {Readable} from 'node:stream';
import assert from 'node:assert/strict';
import {reserve,settleRuntimeTurn,provisionRuntimeUsage} from './provider-budget.mjs';
import {captureBody,sha,assertNoPrivateInput} from './capture-redaction.mjs';
export const toolNames=['app.describe_data','app.explore_data','app.describe_actions','app.request_change'];
export const wireToolNamesFor=(server='synapsor')=>toolNames.flatMap(x=>['mcp__'+server+'__'+x,'mcp__'+server+'__'+x.replaceAll('.','_')]);
export const wireToolNames=wireToolNamesFor();
export async function runtimeProxy({plan,root,secrets,privateValues,forward=fetch,onRefusal=()=>{}}){
  const serverName=plan.selected_mcp_server??'synapsor';const allowedWireNames=wireToolNamesFor(serverName);
  const calls=[],pending=[],currentTurnCalls=[];let lastCumulativeCost=0;
  const save=(name,value)=>fs.writeFile(path.join(root,name),value,{flag:'wx',mode:0o600});
  const log=x=>fs.appendFile(path.join(root,'proxy-events.jsonl'),JSON.stringify({at:new Date().toISOString(),...x})+'\n',{mode:0o600});
  const server=http.createServer(async(req,res)=>{let reservation;try{
    if(req.method!=='POST'||!/^\/v1\/messages(?:\?.*)?$/.test(req.url??'')){
      await log({kind:'unsupported_startup_path',method:req.method,path:(req.url??'').split('?')[0]});res.statusCode=503;res.end('{}');return;
    }
    const chunks=[];let size=0;for await(const x of req){size+=x.length;assert(size<=1024*1024,'Runtime request exceeds declared measurement bound');chunks.push(x);}
    assert(size<=plan.runtime_request_byte_ceiling,'Runtime request exceeds declared per-transport byte ceiling');const body=Buffer.concat(chunks).toString();assertNoPrivateInput(body,[...privateValues,...secrets]);
    // Capture a safely disclosed attempted envelope even when a local guard refuses it;
    // this is NOT a provider transport or reserved call.
    await fs.appendFile(path.join(root,'attempted-envelopes.jsonl'),captureBody(body,secrets)+'\n',{mode:0o600});
    const request=JSON.parse(body);assert.equal(request.model,'claude-opus-5');assert.equal(request.max_tokens,4096);assert.equal(request.output_config?.effort,'high');
    const offered=(request.tools??[]).map(x=>x.name);assert.equal(offered.length,4);assert(offered.every(x=>allowedWireNames.includes(x)));
    const canonical=offered.map(name=>toolNames.find(x=>name==='mcp__'+serverName+'__'+x||name==='mcp__'+serverName+'__'+x.replaceAll('.','_')));
    assert.deepEqual([...canonical].sort(),[...toolNames].sort(),'Require all four semantic tools, not duplicate aliases');
    if(currentTurnCalls.length===0){const ledger=JSON.parse(requireRead(plan.ledger));const c=ledger.case_allocations.find(x=>x.case_id===plan.case_id);assert(c?.status==='LIVE','Case is not live');const amount=x=>x.cost_usd??x.provisional_upper_usd??x.reservation_usd??0;const caseUsed=(c.transports??[]).filter(x=>!x.cost_group).reduce((n,x)=>n+amount(x),0)+(c.runtime_cost_groups??[]).reduce((n,x)=>n+x.cost_usd,0);const sharedUsed=ledger.case_allocations.reduce((n,a)=>n+(a.transports??[]).filter(x=>!x.cost_group).reduce((m,x)=>m+amount(x),0)+(a.runtime_cost_groups??[]).reduce((m,x)=>m+x.cost_usd,0),0);assert(caseUsed+plan.whole_turn_worst_case_usd<=c.spend_ceiling_usd,'Whole native turn exceeds case funding');assert(sharedUsed+plan.whole_turn_worst_case_usd<=ledger.spend_ceiling_usd,'Whole native turn exceeds shared funding');}
    assert(currentTurnCalls.length < plan.whole_turn_transport_count,'Whole native turn transport ceiling reached');reservation=reserve(plan.ledger,plan.case_id,'runtime',plan.runtime_phase_file?JSON.parse(await fs.readFile(plan.runtime_phase_file,'utf8')).phase:'runtime',request);calls.push(reservation.id);currentTurnCalls.push(reservation.id);
    await save(reservation.id+'-request.json',captureBody(body,secrets));
    const headers={...req.headers};for(const x of ['host','connection','content-length'])delete headers[x];
    await log({kind:'transport',id:reservation.id,model:request.model,tool_names:offered,request_sha256:sha(body)});
    const upstream=await forward('https://api.anthropic.com'+req.url,{method:'POST',headers,body,redirect:'error',signal:AbortSignal.timeout(120000)});
    const capture=(async()=>{const reader=upstream.clone().body?.getReader();const data=[];let bytes=0;if(reader)for(;;){const x=await reader.read();if(x.done)break;bytes+=x.value.length;assert(bytes<=8*1024*1024,'Runtime capture exceeds existing wire bound');data.push(Buffer.from(x.value));}const response=Buffer.concat(data).toString();await save(reservation.id+'-response.txt',captureBody(response,secrets));
      const usage={};let completed=false;
      for(const line of response.split('\n'))if(line.startsWith('data:')){try{const event=JSON.parse(line.slice(5));if(event.type==='message_stop')completed=true;const u=event.type==='message_start'?event.message?.usage:event.type==='message_delta'?event.usage:null;for(const key of ['input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens'])if(Number.isInteger(u?.[key])&&u[key]>=0)usage[key]=Math.max(usage[key]??0,u[key]);}catch{}}
      if(completed&&Number.isInteger(usage.input_tokens)&&Number.isInteger(usage.output_tokens)){const provisional=(usage.input_tokens+(usage.cache_creation_input_tokens??0)+(usage.cache_read_input_tokens??0))*0.000020+usage.output_tokens*0.000100;assert(provisional<=plan.runtime_provisional_response_ceiling_usd,'Runtime provisional response ceiling exceeded');provisionRuntimeUsage(plan.ledger,plan.case_id,reservation.id,usage);}
      await log({kind:'response',id:reservation.id,http_status:upstream.status,bytes,response_sha256:sha(response)});})();
    pending.push(capture);capture.catch(error=>{void log({kind:'capture_error',id:reservation.id,error:error.name,code:typeof error.code==='string'?error.code:'unavailable'});onRefusal();});
    res.statusCode=upstream.status;for(const[k,v]of upstream.headers)if(!['content-encoding','content-length','transfer-encoding','connection'].includes(k))res.setHeader(k,v);
    if(upstream.body)Readable.fromWeb(upstream.body).pipe(res);else res.end();
  }catch(error){await log({kind:'local_measurement_refusal',id:reservation?.id,error:error.name,message:error.message});if(!res.headersSent)res.statusCode=503;res.end('{}');onRefusal();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,calls,
    settleTurn(result){
      const total=result.total_cost_usd;assert(Number.isFinite(total)&&total>=lastCumulativeCost,'Missing/nonmonotone native runtime cost');
      const ledger=JSON.parse(requireRead(plan.ledger));const accounted=new Set((ledger.case_allocations.find(x=>x.case_id===plan.case_id).runtime_cost_groups??[]).flatMap(x=>x.transport_ids));
      const ids=currentTurnCalls.filter(id=>!accounted.has(id));if(ids.length)settleRuntimeTurn(plan.ledger,plan.case_id,ids,total-lastCumulativeCost);currentTurnCalls.length=0;lastCumulativeCost=total;
    },async close(){server.closeAllConnections();server.close();await Promise.allSettled(pending);}};
}
// Synchronous ledger snapshot for local completed-turn accounting only.
import {readFileSync as requireRead} from 'node:fs';
