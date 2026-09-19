import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {loadBoundaryReviewContext} from '../../../apps/runner/src/boundary-commands.js';
import {inspectActionProject} from '../../../apps/runner/src/action-tui.js';
import {readActionRuleAuthorityActivation,readActionRuleAuthorityDraft,listActionRuleAuthorityDrafts,readActionRuleAuthorityRevisionBaseline,writeActionRuleAuthorityDraftIfCurrent,buildActionRuleAuthorityDraft,mergeActionRuleAuthorityDraft} from '../../../apps/runner/src/action-rule-authority.js';
import {buildActionRuleAuthoringCatalog} from '../../../apps/runner/src/action-rule-authoring.js';
import {actionRuleModelDraftFromAuthority,compileActionRuleModelDraft} from '../../../apps/runner/src/action-rule-draft.js';
const project=process.cwd(), out=process.env.EVIDENCE_ROOT!;
const context=await loadBoundaryReviewContext(project), inspection=await inspectActionProject(project);
const active=(await readActionRuleAuthorityActivation(project))!;
const drafts=await listActionRuleAuthorityDrafts(project);
const baseline=drafts.sort((a,b)=>b.created_at.localeCompare(a.created_at))[0]??active;
assert.equal(baseline.digest,'sha256:d34194efbc719291dd71cf3107e357d92800c9d1f27eb8ea1b43189eef4fb1fa');
const old=baseline.authority.rules[0]!;
assert.equal(old.read_boundary_digest,context.bundle.candidate_digest);
const built=buildActionRuleAuthoringCatalog({boundary:context.candidate,inspection,retainedCatalog:baseline.authority.catalog});
const draft=actionRuleModelDraftFromAuthority({authority:baseline.authority,outcome:old.rule.outcome,review:baseline.reviews[0]!,preserveVerificationFields:true});
const diff=(a:any,b:any,p=''):any[]=>JSON.stringify(a)===JSON.stringify(b)?[]:a&&b&&typeof a==='object'&&typeof b==='object'?[...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(k=>diff(a[k],b[k],p+'/'+k)):[{path:p,before:a,after:b}];
let cas=await readActionRuleAuthorityRevisionBaseline(project);
const results=[];
for(const mode of ['noop','numeric']) {
 const next=structuredClone(draft);
 if(mode==='numeric') {const expression=(next.require as any).expressions[4];assert.equal(expression.right.value,2);expression.right.value=3;}
 const compiled=compileActionRuleModelDraft({draft:next,builtCatalog:built,readBoundary:context.candidate,readBoundaryDigest:context.bundle.candidate_digest});
 const authority=compiled.loaded.authority;
 const incoming=buildActionRuleAuthorityDraft({name:authority.name,action_boundary_name:authority.action_boundary.name,catalog:authority.catalog,rules:authority.rules,approval_classes:authority.approval_classes,reviews:[{outcome:compiled.rule.outcome,...compiled.review}],now:authority.rules[0]!.activated_at});
 const saved=mergeActionRuleAuthorityDraft({existing:baseline,incoming,now:incoming.created_at});
 cas=await writeActionRuleAuthorityDraftIfCurrent(project,saved,cas);
 const reloaded=(await readActionRuleAuthorityDraft(project,saved.authority.name))!;
 assert.deepEqual(reloaded,saved);assert.deepEqual(await readActionRuleAuthorityActivation(project),active);
 results.push({mode,read_digest:context.bundle.candidate_digest,baseline:baseline.digest,compiled:authority.digest,saved:reloaded.digest,differences:diff(old,reloaded.authority.rules[0])});
}
const fields=old.verification_boundary.resources.flatMap(resource=>resource.fields.map(field=>({binding:resource.binding,resource:resource.resource,source:resource.source,field:field.name,old:field.model_visible,derived:built.authoring.resources.find(r=>r.name===resource.resource)?.fields.find(f=>f.name===field.name)?.role,read:context.candidate.pack.resources.find(r=>r.id===resource.resource)})));
await fs.writeFile(out+'/metadata-baseline.json',JSON.stringify({results,fields},null,2));
await fs.writeFile(out+'/host-metadata.json',JSON.stringify({context,inspection,baseline,built,draft},null,2));
console.log(JSON.stringify(results,null,2));
