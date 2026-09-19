import fs from 'node:fs';import assert from 'node:assert/strict';import {approvedFragments,assertPrivateInput} from './privacy-observer.mjs';
const root='/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/minimal-edit-bfc2f19-20260919';
const old='/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/public-operation-3eb09c4-20260919';
const meta=JSON.parse(fs.readFileSync(root+'/public/zero-provider/host-metadata.json'));
const actual=JSON.parse(fs.readFileSync(old+'/final-meter/input-0013.json')).request;
const plan={private_values:JSON.parse(fs.readFileSync(old+'/final-meter/private-values.json')).filter(v=>v!=='consumed'),ambiguous_literals:['consumed'],fragments:approvedFragments(meta,['consumed'])};
// These are fixture-owned synthetic prohibited sentinels, never provider inputs.
plan.private_values.push('SYNTHETIC_PRIVATE_ROW_94c116','SYNTHETIC_CREDENTIAL_94c116','SYNTHETIC_TRUSTED_PERSON_94c116');
assertPrivateInput(JSON.stringify(actual),plan);
for(const sentinel of plan.private_values.slice(-3))assert.throws(()=>assertPrivateInput(JSON.stringify({messages:[{content:sentinel}]}),plan),/PRIVATE_INPUT_REFUSED/);
assert.throws(()=>assertPrivateInput(JSON.stringify({messages:[{content:'Source rows: {"slot_state":"consumed"}'}]}),plan),/UNREVIEWED_LITERAL_REFUSED/);
assert.throws(()=>assertPrivateInput(JSON.stringify({messages:[{content:'An arbitrary private source value is consumed.'}]}),plan),/UNREVIEWED_LITERAL_REFUSED/);
fs.writeFileSync(root+'/observer-private-plan.json',JSON.stringify(plan,null,2),{mode:0o600});
fs.writeFileSync(root+'/observer-selftest.json',JSON.stringify({exit:0,actual:'historical actual consented authoring input-0013',approved_fragment_count:plan.fragments.length,synthetic_private_negatives:3,unreviewed_consumed_negatives:2,note:'Exact schema/effect/policy fragments only; no blanket consumed exemption; missing historical payload not reconstructed.'},null,2));
console.log('Observer actual metadata positive and five synthetic negatives passed.');
