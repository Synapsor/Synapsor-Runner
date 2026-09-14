// Normal finite installed worker, launched after the separately reviewed writer configuration.
import fs from 'node:fs';import path from 'node:path';import {operator,D} from './known-runtime.mjs';
const label=process.argv[2];if(!/^[a-z-]+$/.test(label))throw Error('label');const r=await operator(['worker','run','--supervised','--once','--yes','--config','synapsor.actions.runner.json','--worker-id','semantic_action_worker']);fs.writeFileSync(path.join(D,label+'-result.json'),JSON.stringify(r,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(r));
