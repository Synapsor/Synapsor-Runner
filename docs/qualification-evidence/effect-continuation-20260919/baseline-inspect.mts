// Owner-only inspection of actual preserved active and disabled authority.
import fs from 'node:fs/promises';
import {readActionRuleAuthorityActivation,readActionRuleAuthorityDraft,loadActiveActionRuleAuthority} from '../../../apps/runner/src/action-rule-authority.js';
import {inspectSemanticReceiptSetup} from '../../../apps/runner/src/semantic-receipt-setup.js';
import {actionRuleDiscoveryContract} from '../../../packages/action-rules/src/discovery.js';
import {verifiedActionAuthoritySections} from '../../../apps/runner/src/verified-action-review.js';
const root=process.cwd(),out=process.env.EVIDENCE_ROOT!;
const active=(await readActionRuleAuthorityActivation(root))!, draft=(await readActionRuleAuthorityDraft(root,active.authority.name))!;
const loaded=await loadActiveActionRuleAuthority(root);
const setup=await inspectSemanticReceiptSetup({projectRoot:root,configPath:root+'/synapsor.actions.runner.json',env:process.env});
const result={active_digest:active.digest,draft_digest:draft.digest,canonical:active.authority.rules.map(r=>({rule:r.rule,effect:r.effect_envelope})),runtime:loaded.registry.rules.map(r=>actionRuleDiscoveryContract(r.compiled,'policy')),review:verifiedActionAuthoritySections(draft),receipt:setup&&{source:setup.source_name,selection:setup.selection,selection_current:setup.selection_current,revision_id:setup.revision_id}};
await fs.writeFile(out+'/baseline-inspection.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({active:active.digest,disabled:draft.digest,receipt_current:setup?.selection_current,runtime_effect:result.runtime.map((r:any)=>r.proposal_effect)}));
