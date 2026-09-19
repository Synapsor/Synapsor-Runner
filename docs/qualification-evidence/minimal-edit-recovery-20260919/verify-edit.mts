import fs from 'node:fs/promises';import assert from 'node:assert/strict';
import {loadBoundaryReviewContext} from '../../../apps/runner/src/boundary-commands.js';
import {inspectActionProject} from '../../../apps/runner/src/action-tui.js';
import {readActionRuleAuthorityActivation,readActionRuleAuthorityDraft} from '../../../apps/runner/src/action-rule-authority.js';
import {buildActionRuleAuthoringCatalog} from '../../../apps/runner/src/action-rule-authoring.js';
import {actionRuleModelDraftFromAuthority,compileActionRuleModelDraft} from '../../../apps/runner/src/action-rule-draft.js';
const root=process.cwd(), out=process.env.EVIDENCE_ROOT!;
const context=await loadBoundaryReviewContext(root),inspection=await inspectActionProject(root),active=(await readActionRuleAuthorityActivation(root))!;
assert.equal(active.digest,'sha256:d34194efbc719291dd71cf3107e357d92800c9d1f27eb8ea1b43189eef4fb1fa');
const saved=(await readActionRuleAuthorityDraft(root,active.authority.name))!;assert(saved);assert.equal(saved.state,'disabled');
const baseline=actionRuleModelDraftFromAuthority({authority:active.authority,outcome:active.authority.rules[0]!.rule.outcome,review:active.reviews[0]!,preserveVerificationFields:true});
const expected=structuredClone(baseline);assert.equal((expected.require as any).expressions[4].right.value,2);(expected.require as any).expressions[4].right.value=3;
const built=buildActionRuleAuthoringCatalog({boundary:context.candidate,inspection,retainedCatalog:active.authority.catalog});
const compiled=compileActionRuleModelDraft({draft:expected,builtCatalog:built,readBoundary:context.candidate,readBoundaryDigest:context.bundle.candidate_digest,activatedAt:saved.created_at});
assert.deepEqual(saved.authority,compiled.loaded.authority,'Complete saved authority, including every canonical digest, matches count edit plus derived annotations');
const resume=JSON.parse(await fs.readFile(root+'/.synapsor/boundary-authoring/resume.json','utf8'));
assert.equal(resume.pending_action_revision,undefined);assert.deepEqual(resume.action.completed_outcomes,[baseline.outcome]);
const before=JSON.parse(await fs.readFile(out+'/state-before/manifest.json','utf8'));
const label=process.argv[2]??'after';const after=JSON.parse(await fs.readFile(out+'/state-'+label+'/manifest.json','utf8'));
assert.deepEqual(after.source,before.source);assert.deepEqual(after.config_files,before.config_files);
const permitted=['control_policy_deployments','control_policy_drafts','control_policy_events','control_policy_revisions'];
for(const [table,value] of Object.entries(before.tables))if(!permitted.includes(table))assert.deepEqual(after.tables[table],value,table+' changed');
const changed=Object.keys(before.tables).filter(k=>JSON.stringify(before.tables[k])!==JSON.stringify(after.tables[k]));
const record={pass:true,baseline_authority:active.digest,disabled_authority:saved.digest,read_digest:context.bundle.candidate_digest,
 complete_authority_equals_expected_compilation:true,business_change:{path:'/rule/require/expressions/4/right/value',before:2,after:3},
 additional_metadata_reconciliation:[{binding:'candidate',field:'candidate_state',before:false,after:true},{binding:'candidate',field:'slot_id',before:true,after:false}],
 timestamp:{disabled_rule_activated_at:saved.authority.rules[0]!.activated_at,created_at:saved.created_at,note:'compiler/draft timestamp; active pointer unchanged; no publication'},
 review_before:active.reviews,review_after:saved.reviews,changed_tables:changed,unchanged_application_tables:Object.keys(before.tables).filter(k=>!permitted.includes(k)),
 source_rows:504,source_unchanged:true,configuration_unchanged:true,resume_stage:resume.stage,completed_outcomes:resume.action.completed_outcomes,
 disclosure_review_records:resume.reviewed_action_disclosures??[],original_request:resume.job_intent,plan_intent:resume.action.intent};
await fs.writeFile(out+'/verified-'+label+'.json',JSON.stringify(record,null,2));console.log(JSON.stringify({pass:true,disabled:saved.digest,source_rows:504,changed_tables:changed}));
