/** Owned local wire fault only. Forward native SQL unchanged; withhold exactly
 * one backend COMMIT CommandComplete after declared native target effects. No
 * fabricated transaction result and no source read is returned to Runner. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID, createHash } from 'node:crypto';

export async function createCommitAckProxy({ backendSocket, capture, targets, expectedEffects, beforeWithhold }) {
  assert(backendSocket.startsWith('/var/tmp/sb61r-') && capture.startsWith('/var/tmp/synapsor-b61-recovery-owned-'));
  assert(Array.isArray(targets) && targets.length && expectedEffects > 0);
  const parent = `/var/tmp/sb61rp-${randomUUID().slice(0,8)}`;
  await fs.mkdir(parent, { mode: 0o700 });
  const socket = path.join(parent, '.s.PGSQL.5432'), recordFile = path.join(capture, 'actual-commit-ack-proxy.json');
  const records = [], peers = new Set();
  let armed = false, dropped = false, serial = 0;
  const save = () => syncFs.writeFileSync(recordFile, JSON.stringify({ schema:'synapsor.dev.commit-ack-proxy.v1',
    parent, backendSocket, armed, dropped, records, sql_changed:false, backend_commit_fabricated:false }, null, 2), {mode:0o600});
  const server = net.createServer(client => {
    const id = ++serial, backend = net.createConnection(path.join(backendSocket, '.s.PGSQL.5432'));
    peers.add(client); peers.add(backend);
    let front = Buffer.alloc(0), back = Buffer.alloc(0), startup = true;
    let targetQuery = false, targetEffects = 0, targetCommit = false;
    const close = () => { client.destroy(); backend.destroy(); peers.delete(client); peers.delete(backend); };
    client.on('error', close); backend.on('error', close); client.on('close', close); backend.on('close', close);
    client.on('data', chunk => {
      front = Buffer.concat([front, chunk]);
      if(startup) {
        if(front.length<4) return;
        const length=front.readInt32BE(0);
        assert(length>=8 && length<=1024*1024, 'Bounded native PostgreSQL startup frame required.');
        if(front.length<length) return;
        // This fixture uses a private Unix socket and no TLS. An SSL request
        // would require a separate proven protocol path; do not misparse it.
        assert.notEqual(front.readInt32BE(4),80877103,'Unexpected SSL request: stop fault preparation.');
        backend.write(front.subarray(0,length)); front=front.subarray(length); startup=false;
      }
      while(front.length>=5) {
        const length=front.readInt32BE(1), total=length+1;
        assert(length>=4 && total<=1024*1024, 'Bounded frontend frame required.');
        if(front.length<total) return;
        const frame=front.subarray(0,total), type=String.fromCharCode(frame[0]);
        if(type==='Q'||type==='P') {
          const payload=frame.subarray(5), sql=type==='Q'?payload.subarray(0,payload.length-1).toString('utf8'):
            payload.subarray(payload.indexOf(0)+1).toString('utf8').split('\0')[0];
          targetQuery=targets.some(target => new RegExp(String.raw`^\s*${target.operation}\s+(?:INTO\s+)?"${target.schema}"\."${target.table}"`, "i").test(sql));
          if(/^\s*COMMIT\s*;?\s*$/i.test(sql)) targetCommit=armed && targetEffects===expectedEffects;
          records.push({id,direction:'frontend',type,declared_target:targetQuery,commit:targetCommit,sql_sha256:createHash('sha256').update(sql).digest('hex')});save();
        }
        backend.write(frame);front=front.subarray(total);
      }
    });
    backend.on('data', chunk => {
      back=Buffer.concat([back,chunk]);
      while(back.length>=5) {
        const length=back.readInt32BE(1), total=length+1;
        assert(length>=4 && total<=8*1024*1024,'Bounded backend frame required.');
        if(back.length<total) return;
        const frame=back.subarray(0,total), type=String.fromCharCode(frame[0]);
        if(type==='C') {
          const command=frame.subarray(5,frame.length-1).toString('utf8');
          if(targetQuery && (command==='INSERT 0 1'||command==='UPDATE 1')) targetEffects++;
          if(targetCommit && command==='COMMIT' && !dropped) {
            dropped=true;armed=false;
            records.push({id,direction:'backend',type,command,backend_commit_observed_at:new Date().toISOString(),
              target_effect_command_completes:targetEffects,ack_forwarded:false,frame_sha256:createHash('sha256').update(frame).digest('hex')});
            save();beforeWithhold?.();close();return;
          }
        }
        if(type==='E') {targetQuery=false;targetCommit=false;}
        client.write(frame);back=back.subarray(total);
      }
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
  await fs.chmod(socket,0o600);save();
  return {socketDirectory:parent,arm:()=>{assert(!armed&&!dropped);armed=true;save();},
    observed:()=>({armed,dropped,records:[...records]}),
    close:async()=>{for(const peer of peers)peer.destroy();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));save();assert.equal(peers.size,0);}};
}
