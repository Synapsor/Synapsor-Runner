import test from 'node:test';
import assert from 'node:assert/strict';
import {scanSource,evaluate} from './scan.mjs';
const file='apps/runner/src/decision.ts';
const scan=code=>scanSource(file,code);
const grant=cs=>({version:1,entries:cs.map(c=>({fingerprint:c.fingerprint,file,annotation_id:'INDEPENDENT-FIXTURE',category:'exact_identifier_or_code',reason:'Controlled fixture only; exact pending machine status and original consumers reviewed.',review:{reviewer:'independent-fixture',evidence:'original-source-only',verdict:'accepted'}}))});
for(const [name,before] of Object.entries({map:'const answers = new Map(); answers.set("pending", true); export const isPending = record => answers.get(record.status);',set:'const answers = new Set(); answers.add("pending"); export const isPending = record => answers.has(record.status);'})) test(`changed ${name} vocabulary invalidates exact review`,()=>{
 const after=before.replace('"pending"','"approved"');
 assert.ok(evaluate(scan(after),grant(scan(before))).errors.some(e=>e.kind==='unreviewed_candidate'),`${name} vocabulary changed without review`);
});
