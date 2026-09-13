import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {owner,timeout,log} from './runtime-driver.mjs';
const waitFor=(inspector,point)=>new Promise((resolve,reject)=>{
 const handler=e=>{if(e.point===point){inspector.off('boundary',handler);inspector.off('observer_error',reject);resolve(e);}};
 inspector.once('observer_error',reject);inspector.on('boundary',handler);
});
// Pauses only the unmodified installed code. The second process performs the
// real SQLite BEGIN IMMEDIATE wait; no alternate delivery or accounting path.
export async function contend(first,firstArgs,second,secondArgs){
 assert.notEqual(first.child.pid,second.child.pid);
 const one=first.inspector,two=second.inspector;assert(one&&two);
 const begins=[one.boundaries.length,two.boundaries.length];
 one.holdNext('approval_entry');two.holdNext('approval_entry');
 const atEntry=[waitFor(one,'approval_entry'),waitFor(two,'approval_entry')];
 const requests=[first.call('app.request_change',firstArgs),second.call('app.request_change',secondArgs)];requests.forEach(p=>p.catch(()=>{}));
 const observations={topology:'two installed stdio processes; one shared SQLite control store; actual BEGIN IMMEDIATE wait; observer pauses only',entry:await timeout(Promise.all(atEntry),10000,'both requests reach definitive admission')};
 try{
  one.holds.add('writer_acquired');const acquired=waitFor(one,'writer_acquired');await one.release();
  observations.first_acquired=await timeout(acquired,5000,'first real writer acquired');
  const file=path.join(owner.project,'.synapsor/local.db');assert(fs.realpathSync(file).startsWith(fs.realpathSync(owner.owned)+path.sep));
  const probe=new DatabaseSync(file);try{probe.exec('PRAGMA busy_timeout=0');assert.throws(()=>probe.exec('BEGIN IMMEDIATE'),/database is locked/);observations.independent_writer_probe='SQLITE_BUSY';}finally{probe.close();}
  const attempting=waitFor(two,'writer_attempt');await two.release();observations.second_attempt=await timeout(attempting,3000,'second real writer attempt');
  await new Promise(r=>setTimeout(r,250));
  assert(!two.boundaries.slice(begins[1]).some(e=>e.point==='writer_acquired'),'second writer cannot acquire while first holds it');
  observations.release_requested_at=new Date().toISOString();await one.release();
  observations.responses=await timeout(Promise.all(requests),15000,'both real admission outcomes');
  observations.boundaries=[one.boundaries.slice(begins[0]),two.boundaries.slice(begins[1])];
  for(const points of observations.boundaries){const writer=points.find(e=>e.point==='writer_acquired');const clock=points.find(e=>e.point==='admission_clock_selected');assert(writer&&clock);assert(points.indexOf(clock)>points.indexOf(writer));assert(Date.parse(clock.locals.now)>=Date.parse(observations.release_requested_at),'admission time remains after held writer coordination');}
  assert(Date.parse(observations.boundaries[1].find(e=>e.point==='writer_acquired').at)>=Date.parse(observations.release_requested_at));
  log('accounting_contention',observations);return observations;
 }finally{for(const i of [one,two]){i.holds.clear();if(i.held)await i.release().catch(()=>{});}}
}
