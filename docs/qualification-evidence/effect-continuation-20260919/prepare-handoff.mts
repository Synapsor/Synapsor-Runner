// Owned administrator preview only. No grants or source mutations.
import fs from 'node:fs/promises';
import {prepareSemanticWriterHandoff} from '../../../apps/runner/src/semantic-action-deployment.js';
import {loadActivatedExplorationBoundaries} from '../../../apps/runner/src/auto-boundary.js';
import {exportWriterProvisioning} from '../../../apps/runner/src/writer-provisioning.js';
import {writebackSetup} from '../../../apps/runner/src/writeback-setup.js';
const root=process.cwd(),out=process.env.EVIDENCE_ROOT!;
const reads=(await loadActivatedExplorationBoundaries(root)).map(r=>({pack:r.pack,digest:r.activation.digest}));
try {
 const checked=await prepareSemanticWriterHandoff({projectRoot:root,outcome:'release.seal_candidate',reads,env:process.env});
 const dir=await exportWriterProvisioning(root,checked.plan);
 await fs.writeFile(out+'/generated-writer-plan.json',JSON.stringify({directory:dir,...checked},null,2));
 await writebackSetup(['--config','synapsor.actions.runner.json','--profile','development','--writer-role',checked.plan.suggested_role,'--setup-url-env','OWNED_ADMIN_URL','--json']);
} catch(e) {await fs.writeFile(out+'/handoff-blocker.json',JSON.stringify({error:String(e),...e as object},null,2));throw e;}
