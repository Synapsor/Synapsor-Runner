import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire('/home/sandesh-tiwari/.npm-global/lib/node_modules/npm/package.json');
const cacache=require('cacache');
process.umask(0o077);
const source="/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/reviewed-local-clients-8d64270-20260913/offline-home/.npm/_cacache";
const lock=JSON.parse(await fs.readFile("/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/reviewed-local-clients-8d64270-20260913/frozen/installed/package-lock.json",'utf8'));
const names=new Set(['@types/node','undici-types']);
for(const location of Object.keys(lock.packages)) if(location.includes('node_modules/')) names.add(location.split('node_modules/').at(-1));
names.delete('@synapsor/runner');names.delete('@synapsor/spec');
const home="/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/authoring-review-repair-9c7219d-20260913/offline-home"; await fs.mkdir(home,{mode:0o700});
const target=path.join(home,'.npm/_cacache');
const entries=Object.values(await cacache.ls(source));
let count=0,bytes=0;
for(const entry of entries){
 const prefix='make-fetch-happen:request-cache:https://registry.npmjs.org/';
 if(!entry.key.startsWith(prefix))continue;
 const name=decodeURIComponent(entry.key.slice(prefix.length).split('/-/')[0]);
 if(!names.has(name))continue;
 const {data,metadata}=await cacache.get(source,entry.key);
 await cacache.put(target,entry.key,data,{metadata});count++;bytes+=data.length;
}
const report={home,cache:target,entries_copied:count,bytes,selection:'Only cached npm metadata/tarballs for names in the existing frozen dependency lock, plus types/node and undici-types. No registry request.'};
await fs.writeFile('docs/qualification-evidence/authoring-review-repair-20260913/offline-cache-copy.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
