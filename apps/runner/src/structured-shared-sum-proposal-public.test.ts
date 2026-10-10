import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parseSharedSumDesignation } from '@synapsor-runner/action-rules';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { onboard } from './guided-start.js';
import { structuredBoundaryAuthoringCommand, parseStructuredActionDraft } from './boundary-structured-authoring.js';
import { readProjectReadAuthoring } from './control-policy-read-authoring-project.js';
import { readActionRuleAuthorityActivation, readActionRuleAuthorityDraft, readActionRuleAuthorityRevisionBaseline } from './action-rule-authority.js';
import { structuredTestAction, structuredTestInspection } from './structured-authoring-test-fixture.js';
import type { BoundaryReviewInteractiveSession } from './boundary-cli-picker.js';
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
it.each(['dry_run','save','legacy'] as const)('public structured proposal is retained for genuine owner review or refused before publication: %s',async mode=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'structured-shared-sum-public-'));roots.push(root);
 const inspection=structuredTestInspection();
 for(const name of ['adjustments','limits']){const t=structuredClone(inspection.tables[0]!);t.name=name;t.unique_constraints[0]!.name=`${name}_pkey`;inspection.tables.push(t);}
 vi.stubEnv('SHARED_SUM_TEST_READ_URL','postgresql://fixture.invalid/not-used');
 const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No provider or network in this declared-metadata public handler control'));
 const stdout=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
 const inspect=vi.fn(async()=>structuredClone(inspection));
 expect(await onboard(['db','--project-root',root,'--from-env','SHARED_SUM_TEST_READ_URL','--schema','warehouse','--json'],{interactive:false,schemaInspector:inspect})).toBe(0);
 const session:BoundaryReviewInteractiveSession={chooseResource:async()=>undefined,editFieldTiers:async()=>undefined,promptText:async()=>undefined,confirm:async()=>true,
  chooseOption:async title=>title==='SELECT MAINTAINED CONFLICT COUNTER'?'field:version':title==='REVIEW CHANGED-RECORD PROTECTION'?'confirm':undefined};
 const run=(args:string[])=>structuredBoundaryAuthoringCommand(['--project-root',root,'--json',...args],inspect,session);
 expect(await structuredBoundaryAuthoringCommand(['--project-root',root,'--export-draft','read.json'],inspect)).toBe(0);
 const input=JSON.parse(await fs.readFile(path.join(root,'read.json'),'utf8'));input.read.resources=[];
 const rule=structuredTestAction('quantity','q_av',50,20);rule.approval={class_name:'warehouse.shared',mode:'human',required_role:'warehouse_manager',required_approvals:1,shared_limits:[]};
 const designation=parseSharedSumDesignation({schema_version:'synapsor.shared-sum-designation.v1',kind:'shared_sum',source:input.action_authoring_catalog.source,
  scope:{tenant_field:'tenant_id',principal_field:'principal_id'},limit:{resource:'warehouse.limits',field:'reorder_point'},populations:[{resource:'warehouse.items',field:'q_av'},{resource:'warehouse.adjustments',field:'q_av'}],
  unit:{kind:'integer',unit:'units',meaning:'The two complete scoped populations consume the same declared limit.'},time:'current_state',external_writers:'participating_only'});
 input.actions=[mode==='legacy'?rule:{...rule,schema_version:'synapsor.action-rule-model-draft.v2',shared_sum_proposal:designation}];
 if(mode!=='legacy')expect(parseStructuredActionDraft(input.actions[0],0).shared_sum_proposal).toEqual(designation);
 await fs.writeFile(path.join(root,'action.json'),JSON.stringify(input));
 const originalInput=await fs.readFile(path.join(root,'action.json'),'utf8'),baseline=await readActionRuleAuthorityRevisionBaseline(root),readBefore=await readProjectReadAuthoring(root);
 stdout.mockClear();
 const status=await run(['--draft','action.json','--review-counters',...(mode==='dry_run'?['--dry-run']:[])]);
 const name=`${readBefore!.selected!.progress.candidate.pack.name}_rules`,saved=await readActionRuleAuthorityDraft(root,name);
 const output=stdout.mock.calls.map(([chunk])=>String(chunk)).join('');
 const observation={mode,status,parsedProposal:mode!=='legacy',savedDisabled:Boolean(saved),savedSharedSum:Boolean(saved?.authority.shared_sum),baselineUnchanged:canonicalJsonDigest(await readActionRuleAuthorityRevisionBaseline(root))===canonicalJsonDigest(baseline),active:Boolean(await readActionRuleAuthorityActivation(root)),typedRefusal:output.includes('STRUCTURED_DRAFT_SHARED_SUM_REVIEW_REQUIRED')};
 if(process.env.B66_SHARED_SUM_OBSERVATION_DIR)await fs.writeFile(path.join(process.env.B66_SHARED_SUM_OBSERVATION_DIR,`observation-${mode}.json`),JSON.stringify(observation,null,2)+'\n');
 expect(fetch).not.toHaveBeenCalled();expect(await fs.readFile(path.join(root,'action.json'),'utf8')).toBe(originalInput);expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
 if(mode==='legacy'){expect(status).toBe(0);expect(saved?.state).toBe('disabled');return;}
 // A parsed proposal is not reviewed authority. This route must preserve it
 // through a genuine native review owner, or truthfully refuse before save.
 expect(status).toBe(2);
 expect(output).toContain('STRUCTURED_DRAFT_SHARED_SUM_REVIEW_REQUIRED');
 expect(await readActionRuleAuthorityRevisionBaseline(root)).toEqual(baseline);
 expect(await readProjectReadAuthoring(root)).toEqual(readBefore);
});
