// Owner-only downstream evidence inspection, not a provider call or save.
import fs from 'node:fs/promises';
import {loadBoundaryReviewContext} from '../../../apps/runner/src/boundary-commands.js';
import {readActionRuleAuthorityActivation,readActionRuleAuthorityDraft} from '../../../apps/runner/src/action-rule-authority.js';
import {policyCoverageDraft} from '../../../apps/runner/src/authoring-policy-evidence.js';
const root=process.cwd(),out=process.env.EVIDENCE_ROOT!;
const context=await loadBoundaryReviewContext(root),active=(await readActionRuleAuthorityActivation(root))!;
const saved=(await readActionRuleAuthorityDraft(root,active.authority.name))!;
const evidence=(authority:any)=>policyCoverageDraft({read:context.candidate,actions:[],decisions:[],authority});
const before=evidence(active),after=evidence(saved);
const diff=(a:any,b:any,p=''):any[]=>JSON.stringify(a)===JSON.stringify(b)?[]:a&&b&&typeof a==='object'&&typeof b==='object'?[...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(k=>diff(a[k],b[k],p+'/'+k)):[{path:p,before:a,after:b}];
const changes=diff(before,after);
await fs.writeFile(out+'/derived-evidence.json',JSON.stringify({read_digest:context.bundle.candidate_digest,before,after,changes},null,2));
console.log(JSON.stringify({paths:changes.map(c=>c.path)}));
