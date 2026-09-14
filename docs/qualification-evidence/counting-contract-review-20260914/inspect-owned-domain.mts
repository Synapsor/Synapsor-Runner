// Host-only diagnostic on a separate whole-project restore; no provider, source
// query, authority setter or readiness injection. The final public fixture is untouched.
import { loadBoundaryReviewContext } from '../../../apps/runner/src/boundary-commands.js';
import { listActionRuleAuthorityDrafts } from '../../../apps/runner/src/action-rule-authority.js';
import { withCountingOutcomeDomain } from '../../../apps/runner/src/authoring-counting-domain.js';
import { loadPolicySources } from '../../../apps/runner/src/authoring-policy-source.js';
import { policyCoverageDraft } from '../../../apps/runner/src/authoring-policy-evidence.js';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=process.cwd(),resume=JSON.parse(await fs.readFile(root+'/.synapsor/boundary-authoring/resume.json','utf8'));
const context=await loadBoundaryReviewContext(root),drafts=await listActionRuleAuthorityDrafts(root);assert.equal(drafts.length,1);
const source=await loadPolicySources(root,resume.policy_source_session);
const domain=await withCountingOutcomeDomain(root,drafts[0]!,async domain=>domain);
const evidence=policyCoverageDraft({read:context.candidate,authority:drafts[0],actions:[],decisions:context.bundle.decisions,policySources:source,
 countingDomain:domain,operatorClarifications:resume.conversation.filter((t:any)=>t.kind==='clarification')});
assert.equal(evidence.runner_evidence.counting_interpretations.length,1);
assert.deepEqual(domain.proposed_outcomes,['league.result_ratification']);assert.equal(domain.complete,true);assert.deepEqual(domain.current_outcomes,[]);assert.deepEqual(domain.retained_automatic_outcomes,[]);
console.log(JSON.stringify({classification:'instrumented host inspection on a separate restored copy; not final installed public review',domain,scoped_interpretations:evidence.runner_evidence.counting_interpretations.length,source_queries:0,provider_calls:0,authority_changed:false},null,2));
