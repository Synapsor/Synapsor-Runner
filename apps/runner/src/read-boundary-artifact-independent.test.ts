import {it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import {canonicalJsonDigest} from '@synapsor-runner/protocol';
import {decodeReadBoundaryDraftFile as draft,decodeReadBoundaryActiveFile as active,encodeReadBoundaryDraftFile as encode,READ_BOUNDARY_DRAFT_FILE_VERSION as DV,READ_BOUNDARY_ACTIVE_FILE_VERSION as AV,type ReadBoundaryPayloadAssertion} from './read-boundary-artifact.js';
type Payload={schema_version:string;activation:unknown;data:{text:string;values:number[]}};
const make=():Payload=>({schema_version:'synapsor.exploration-boundary.v2',activation:'disabled_unreviewed',data:{text:' 日本語\n unchanged ',values:[3,1,2]}});
const check:ReadBoundaryPayloadAssertion<Payload>=(v):asserts v is Payload=>{if(!v||typeof v!=='object'||!('data'in v))throw new Error('PAYLOAD_REQUIRED')};
it('AC01-03 exact gates precede host callback',()=>{
 const spy=vi.fn();const gate=spy as unknown as ReadBoundaryPayloadAssertion<Payload>;
 for(const x of [make(),{schema_version:'unknown',boundary:make()},{schema_version:AV,boundary:make()},{schema_version:DV,boundary:{...make(),schema_version:'synapsor.exploration-boundary.v1'}},{schema_version:DV,boundary:make(),pack:{}},{schema_version:DV,boundary:make(),activation:{state:'active'}}])expect(()=>draft(x,gate)).toThrow();
 expect(spy).not.toHaveBeenCalled();
});
it('AC04/08 active wrapper is not proof and inner state cannot cross kind',()=>{
 const raw={schema_version:AV,boundary:{...make(),activation:{state:'active'}}};
 const reject:ReadBoundaryPayloadAssertion<Payload>=()=>{throw new Error('UNPROVEN_AUTHORITY')};
 expect(()=>active(raw,reject)).toThrow('UNPROVEN_AUTHORITY');expect(()=>active({schema_version:AV,boundary:make()},check)).toThrow('KIND_MISMATCH');
 expect(()=>draft({schema_version:DV,boundary:raw.boundary},check)).toThrow('KIND_MISMATCH');
});
it('AC05 serialization and delayed validator aliases cannot change accepted payload',()=>{
 const source=make(),hash=canonicalJsonDigest(source);let alias:Payload|undefined;
 const validator:ReadBoundaryPayloadAssertion<Payload>=(v):asserts v is Payload=>{check(v);alias=v};
 const wrapped=encode(source,validator);alias!.data.text='later';expect(canonicalJsonDigest(wrapped.boundary)).toBe(hash);expect(canonicalJsonDigest(source)).toBe(hash);
 const decoded=draft(JSON.parse(JSON.stringify(wrapped)),validator);alias!.data.values.reverse();expect(canonicalJsonDigest(decoded)).toBe(hash);decoded.data.text='caller';expect(canonicalJsonDigest(wrapped.boundary)).toBe(hash);
});
it('AC06 normalization refuses and caller input unchanged',()=>{
 const source=make(),before=JSON.stringify(source);const normalize:ReadBoundaryPayloadAssertion<Payload>=(v):asserts v is Payload=>{check(v);v.data.text=v.data.text.trim()};
 expect(()=>encode(source,normalize)).toThrow('NORMALIZATION_REFUSED');expect(JSON.stringify(source)).toBe(before);
});
it.each([undefined,false,{replacement:true}])('AC04/06 absent or non-undefined validator outcome refuses %#',result=>{
 const validator=result===undefined?undefined:(()=>result);expect(()=>draft({schema_version:DV,boundary:make()},validator as unknown as ReadBoundaryPayloadAssertion<Payload>)).toThrow();
});
it('AC07 original failure preserved; foreign then hook never invoked',()=>{
 const error=new Error('HOST_REFUSAL');expect(()=>encode(make(),(()=>{throw error}) as ReadBoundaryPayloadAssertion<Payload>)).toThrow(error);
 const then=vi.fn();expect(()=>encode(make(),(()=>({then})) as unknown as ReadBoundaryPayloadAssertion<Payload>)).toThrow('VALIDATOR_INVALID');expect(then).not.toHaveBeenCalled();
});
it.each(['local','foreign'])('AC07 rejected native Promise in %s realm is refused without unhandled rejection',realm=>{
 const text=readFileSync(new URL('./read-boundary-artifact.ts',import.meta.url),'utf8');
 const js=ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const uri='data:text/javascript;base64,'+Buffer.from(js).toString('base64');
 const code=`import vm from 'node:vm'; const c=await import(${JSON.stringify(uri)}); const value=${JSON.stringify(make())}; const promise=${realm==='foreign'?`vm.runInNewContext('Promise.reject(new Error("EXPECTED_ASYNC_REFUSAL"))')`:`Promise.reject(new Error('EXPECTED_ASYNC_REFUSAL'))`}; let refused=false; try{c.encodeReadBoundaryDraftFile(value,()=>promise)}catch(e){refused=e.code==='READ_BOUNDARY_ARTIFACT_VALIDATOR_INVALID'} if(!refused)process.exitCode=9; await new Promise(r=>setImmediate(r));`;
 const child=spawnSync(process.execPath,['--unhandled-rejections=strict','--input-type=module','-e',code],{encoding:'utf8'});
 expect(child.status,child.stderr).toBe(0);expect(child.stderr).not.toContain('EXPECTED_ASYNC_REFUSAL');
});
it('AC09 encoder rejects unsupported payload before callback',()=>{
 const spy=vi.fn();expect(()=>encode({...make(),schema_version:'old'},spy as unknown as ReadBoundaryPayloadAssertion<Payload>)).toThrow('UNSUPPORTED');expect(spy).not.toHaveBeenCalled();
});
