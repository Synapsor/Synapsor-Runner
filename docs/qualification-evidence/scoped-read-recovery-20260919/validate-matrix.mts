import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {parseReadAuthoringDocument} from '../../../apps/runner/src/control-policy-read-authoring.ts';
import {reviewExplorationBoundaryCandidate} from '../../../apps/runner/src/auto-boundary.ts';
const root='/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/scoped-read-recovery-515d260-20260919';
const attempt=process.argv[2];const input=JSON.parse(await fs.readFile(`${root}/${attempt}/stored-observations.json`,'utf8'));
const results=[];
for(const x of input) {
 const a=parseReadAuthoringDocument(x.document);const e=a.entries[0]!;
 for(const b of [e.draft,e.progress.candidate]) if(b.pack.resources.length) {
  const {unresolved_decisions:_a,...before}=b;
  const {unresolved_decisions:_b,...after}=reviewExplorationBoundaryCandidate(b,structuredClone(b)).candidate;
  assert.deepEqual(after,before);
 }
 results.push({schema:x.schema,parse_and_canonical:true,classification:x.classification});
}
// Explicit v_scope3_norls -> v_rename3a map (scope identifiers retained).
const map:any={v_scope3_norls:'v_rename3a',a:'depot',b:'route',c:'stop',d:'scan',a_id:'depot_id',b_id:'route_id',c_id:'stop_id',d_id:'scan_id',a_state:'depot_state',b_state:'route_state',c_state:'stop_state',d_state:'scan_state',version:'revision_no'};
function name(s:string,rename:boolean){return rename?s.split('.').map(t=>map[t]??t).join('.'):s;}
function resourcePolicy(r:any,rename:boolean){
 const copy=structuredClone(r);for(const k of ['id','schema','table','relationships'])delete copy[k];
 function walk(v:any):any {if(typeof v==='string')return name(v,rename);if(Array.isArray(v)){const a=v.map(walk);return a.every(t=>typeof t==='string')?a.sort():a;}if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[name(k,rename),walk(x)]));return v;}
 return walk(copy);
}
function semantics(x:any,rename:boolean){return x.document.entries[0].draft.pack.resources.map((r:any)=>({id:name(r.id,rename),tenant:r.tenant_key,principal:r.principal_key,primary:name(r.primary_key,rename),policy:resourcePolicy(r,rename),paths:r.relationships.map((p:any)=>({target:name(p.target_resource,rename),depth:p.proof.links.length,cardinality:p.cardinality,unmatched:p.unmatched_rows,links:p.proof.links.map((l:any)=>({from:name(l.source_resource,rename),to:name(l.target_resource,rename),source:l.source_columns.map((s:string)=>name(s,rename)),target:l.target_columns.map((s:string)=>name(s,rename)),nullable:l.nullable,cardinality:l.cardinality,uniqueness:{kind:l.target_uniqueness.kind,columns:l.target_uniqueness.columns.map((s:string)=>name(s,rename))}}))})).sort((a:any,b:any)=>a.target.localeCompare(b.target))})).sort((a:any,b:any)=>a.id.localeCompare(b.id));}
const original=input.find((x:any)=>x.schema==='v_scope3_norls'),renamed=input.find((x:any)=>x.schema==='v_rename3a');
assert.deepEqual(semantics(original,true),semantics(renamed,false));assert.deepEqual(original.document.entries[0].draft.budgets,renamed.document.entries[0].draft.budgets);
const result={results,renamed_corresponding_semantics:true,scope_columns_unchanged:true,note:'Full canonical disabled seed compared by explicit table/key/state/version mapping; literal digests and order-based recommendations may differ. Full catalog retains out-of-budget proof paths.'};
await fs.writeFile(`${root}/${attempt}/canonical-results.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
