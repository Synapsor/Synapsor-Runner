// Integration-only read-only verification plus the engine's rolled-back receipt probe.
import fs from 'node:fs/promises';
import {previewSemanticSupervisedExecution,verifySemanticExecutionReadPosture} from '../../../apps/runner/src/semantic-action-deployment.js';
import {loadActivatedExplorationBoundaries} from '../../../apps/runner/src/auto-boundary.js';
const root=process.cwd(),out=process.env.EVIDENCE_ROOT!;
try {
 const p=await previewSemanticSupervisedExecution({projectRoot:root,outcome:'release.seal_candidate',profile:(await loadActivatedExplorationBoundaries(root))[0]!.deployment_profile,writeUrlEnv:'SYNAPSOR_WRITE_RELEASE_SEAL_CANDIDATE_77988288',env:process.env});
 await verifySemanticExecutionReadPosture({projectRoot:root,outcome:p.outcome,activeReads:await loadActivatedExplorationBoundaries(root),env:process.env});
 const {config,...safe}=p;await fs.writeFile(out+'/writer-verified.json',JSON.stringify(safe,null,2));console.log('Current writer verification and rolled-back source receipt probe passed; execution not enabled.');
} catch(e) {await fs.writeFile(out+'/writer-verification-failed02.json',JSON.stringify({error:String(e),...e as object},null,2));throw e;}
