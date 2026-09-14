// Read-only corroboration against actual stored proposal/outcome identifiers.
// The normal store evaluator is separately exercised by automatic-approval-admission.test.ts.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
const E=path.dirname(new URL(import.meta.url).pathname),p=JSON.parse(fs.readFileSync(path.join(E,'assignment-plan.json'))),R=path.join(p.owned_root,'runs/recovery-tournament-assisted'),dbpath=path.join(R,'project/.synapsor/local.db');
assert(fs.realpathSync(dbpath).startsWith(R+'/project/'));const db=new DatabaseSync(dbpath,{readOnly:true});
try{db.exec('BEGIN');const rows=db.prepare(`SELECT a.proposal_id,a.action_boundary_name,a.created_at,a.status,COALESCE(p.capability,p.action) AS outcome FROM approvals a JOIN proposals p ON p.proposal_id=a.proposal_id WHERE a.action_boundary_name IS NOT NULL ORDER BY a.created_at`).all();
const canonical='league.result_ratification';assert(rows.length>0);assert(rows.every(r=>r.outcome===canonical));const at=new Date().toISOString(),start=new Date(Date.parse(at)-86400000).toISOString();
const broad=rows.filter(r=>r.status==='approved'&&r.created_at>=start&&r.created_at<=at),filtered=broad.filter(r=>r.outcome===canonical);assert.deepEqual(filtered,broad);db.exec('COMMIT');
const result={at,classification:'read-only stored-history corroboration; evaluator regression separate',canonical_outcome:canonical,stored_automatic_rows:rows,window:{start,end:at,inclusive:true},absent_selector_count:broad.length,explicit_selector_count:filtered.length,all_prior_automatic_proposals_match_canonical_outcome:true,source_or_store_mutation:false};
fs.writeFileSync(path.join(E,'history-before-selector.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({rows:rows.length,absent:broad.length,filtered:filtered.length}));}finally{db.close();}
