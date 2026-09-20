// Owner-only readback from the tested host modules. Public terminal/protocol traces
// establish the installed route; this is a separate canonical-state oracle.
import fs from 'node:fs/promises';import assert from 'node:assert/strict';
import {readActionRuleAuthorityActivation,readActionRuleAuthorityDraft} from '../../../apps/runner/src/action-rule-authority.js';
import {inspectSemanticReceiptSetup} from '../../../apps/runner/src/semantic-receipt-setup.js';
import {readSemanticSupervisedExecutionState} from '../../../apps/runner/src/semantic-action-deployment.js';
import {actionRuleEffectInventory} from '../../../packages/action-rules/src/effect-inventory.js';
const root=process.cwd(),out=process.env.EVIDENCE_ROOT!,label=process.argv[2];assert(label&&/^[a-z0-9-]+$/.test(label));
const active=(await readActionRuleAuthorityActivation(root))!,draft=await readActionRuleAuthorityDraft(root,active.authority.name);
const receipt=await inspectSemanticReceiptSetup({projectRoot:root,configPath:root+'/synapsor.actions.runner.json',env:process.env});
const execution=await readSemanticSupervisedExecutionState({projectRoot:root,env:process.env});
const result={evidence:'host readback; public installed UI/protocol traced separately',active,draft,inventory:{active:active.authority.rules.map(actionRuleEffectInventory),draft:draft?.authority.rules.map(actionRuleEffectInventory)},receipt:receipt&&{source:receipt.source_name,action_digest:receipt.action_digest,binding_digest:receipt.binding_digest,selection:receipt.selection,selection_current:receipt.selection_current,revision_id:receipt.revision_id,epoch:receipt.epoch,requirements:receipt.requirements},execution};
await fs.writeFile(out+'/inspection-'+label+'.json',JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify({active:active.digest,draft:draft?.digest,receipt_current:receipt?.selection_current,execution_enabled:execution.enabled,execution_policies:execution.policies.map(p=>({outcome:p.outcome,digest:p.action_boundary_digest})),business_components:result.inventory.active.map(i=>i.components.length)}));
