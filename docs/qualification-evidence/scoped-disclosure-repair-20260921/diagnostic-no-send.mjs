import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
const root=process.env.QUALIFICATION_PROVIDER_METER;
function stop(){if(root)fs.appendFileSync(path.join(root,'diagnostic-send-refused.jsonl'),JSON.stringify({at:new Date().toISOString(),kind:'local_pretransport_diagnostic_guard',forwarded:false})+'\n',{mode:0o600});throw new Error('DIAGNOSTIC_PROVIDER_SEND_BLOCKED: local zero-provider trace; no upstream transport');}
http.request=stop;http.get=stop;https.request=stop;https.get=stop;globalThis.fetch=stop;syncBuiltinESMExports();
