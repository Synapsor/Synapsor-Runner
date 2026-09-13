"""Freeze two unused synthetic case inputs before any authoring run.

Public policy/owner knowledge is separated from private facts and verifier plans.
This creates no Runner authority and calls no provider. UUID identities and
private sentinels are generated only in the private, uncommitted owned root.
"""
from pathlib import Path
import datetime, hashlib, json, os, secrets, uuid
os.umask(0o077)
E=Path(__file__).resolve().parent; plan=json.loads((E/'assignment-plan.json').read_text()); O=Path(plan['owned_root'])
assert json.loads((E/'envelope-declaration.json').read_text())['case_selection_has_started'] is False
for role in ['authoring','runtime']: assert json.loads((E/(role+'-preflight-1.json')).read_text())['status']=='passed'
assert json.loads((O/'preselection-artifact-verification.json').read_text())['installed_tree_sha256']==plan['candidate_tree']
root=O/'cases';root.mkdir()
def uid(): return str(uuid.uuid4())
def save(p,value):
    p.parent.mkdir(parents=True,exist_ok=True)
    with p.open('x') as f: f.write(json.dumps(value,indent=2)+'\n' if not isinstance(value,str) else value)
def rls(schema,tables,reader):
    sql=f'CREATE ROLE {reader} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;\nGRANT USAGE ON SCHEMA {schema} TO {reader};\n'
    for t in tables:
        sql+=f'''ALTER TABLE {schema}.{t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE {schema}.{t} FORCE ROW LEVEL SECURITY;
CREATE POLICY {t}_trusted_scope ON {schema}.{t} FOR ALL TO PUBLIC
 USING (tenant_id = current_setting('app.tenant_id', true)::uuid AND principal_id = current_setting('app.principal_id', true)::uuid)
 WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid AND principal_id = current_setting('app.principal_id', true)::uuid);
GRANT SELECT ON {schema}.{t} TO {reader};
'''
    return sql
common='''These are synthetic local-development records, not production accounts. The organization owns a tenant; a principal is the separately assigned person within it. A person can belong to only one fixture context here. Two fixture people share the first organization, and two further people belong to two other organizations. Identity values are reviewed privately through operator setup, never through the authoring model.

The existing source application maintains every integer version on every INSERT/UPDATE of mutable records, including status, scope and relationship changes. The test source-owner controls will do the same and record the legitimate business event separately. Runner must use the existing version guard, never invent another counter. UUID primary keys are stable. All declared foreign keys are immediate, validated and include the complete organization/person pair. Null does not mean a successful check.

Only a read-only non-owner role is supplied for onboarding. Exact generated writer grants, any receipt schema provisioning, local identity and execution reviews remain separate operator/administrator work. The administrator may apply the reviewed generated prerequisite SQL to this disposable database; no broad writer fallback or internal authority setter is acceptable. The supervisor makes approvals outside the model. The model cannot select an identity, approve, publish or run SQL.

Automatic approval counts are real committed approvals in this project's common durable history. Two people in an organization share its cap; all organizations share the overall cap. Inclusive rolling 24 hours means 86400 seconds before the fresh admission time through that time, not a UTC midnight reset. An approval still counts if it is awaiting, blocked or never executed. All cooperating processes use this exact candidate and same-host clock assumptions; source-database time is not required.
'''
definitions=[
 {'id':'tournament-ratification','title':'League best-of-three result ratification','schema':'tournament_ops','reader':'tournament_trial_reader','tables':['events','results'],
  'policy':'''# League result ratification

Help a league referee ratify completed best-of-three match results. A referee may see and act only on results assigned to that referee within that league. The referee can read result reference, event name, stage, recorded wins/losses and result state, including a related event's operating state. Do not expose database identities, conflict counters, integrity_hold or referee_private_note as public data. Never reveal, filter, sort, group or aggregate by the private fields; the host may use the hold privately to verify a request.

Ratification is valid only while the related event is open, the result is finished, the winner has exactly two game wins, the loser has zero or one game wins, and there is no integrity hold. Do not correct scores or move a result to another person, event or league. An invalid result is refused, not routed into approval as if valid. A successful ratification changes only result state to ratified, plus the maintained conflict counter.

Valid qualifying-stage results may be approved automatically, with at most six automatic ratifications overall and two per league in the inclusive rolling 24-hour window. Qualifying results beyond either cap go to human review. Every valid championship-stage result requires the league supervisor's human review. Counts are shared across that league's referees; creating a local client does not create more allowance. Explicit supervised execution follows approval. Request a stored Runner-ledger receipt and independently verify the changed source row. No match server or external system is contacted.

Public reads must retain these restrictions as jobs are edited. Ratification never grants a referee permission to change the recorded winner or score.
''',
  'schema_sql':'''CREATE SCHEMA tournament_ops;
CREATE TABLE tournament_ops.events (
 event_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, principal_id uuid NOT NULL,
 event_name text NOT NULL, operating_state text NOT NULL CHECK (operating_state IN ('open','closed')),
 version integer NOT NULL DEFAULT 1 CHECK(version > 0), UNIQUE(event_id,tenant_id,principal_id));
CREATE TABLE tournament_ops.results (
 result_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, principal_id uuid NOT NULL,
 event_id uuid NOT NULL, result_ref text NOT NULL UNIQUE,
 stage text NOT NULL CHECK(stage IN ('qualifying','championship')),
 winner_game_wins integer NOT NULL, loser_game_wins integer NOT NULL,
 result_state text NOT NULL CHECK(result_state IN ('finished','ratified','withdrawn')),
 integrity_hold boolean NOT NULL, referee_private_note text NOT NULL,
 withdrawal_reason varchar(200), version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 FOREIGN KEY(event_id,tenant_id,principal_id) REFERENCES tournament_ops.events(event_id,tenant_id,principal_id));
''',
  'owner':'''An event is a scoped administrative partition assigned to a referee; separate referee partitions can have the same league event name. A result is one finished best-of-three match in that partition. Game wins are counts, never currency or time. Stage is qualifying or championship. An integrity hold always prevents ratification even when public scores look valid; the private note must not be disclosed and is not itself an executable condition. The current withdrawal_reason is unused and null; do not invent a withdrawal job during initial onboarding. The future reviewed withdrawal behavior will use that existing bounded text field.

tenant_id is the owning league and principal_id is the assigned referee. The result-to-event relationship must retain the entire inspected foreign key. All fixture roles have complete visibility of their own partition, with no hidden RLS predicates beyond tenant and principal. No database-origin clock or changing source row is needed to evaluate the rolling approval policy.

The expected receipt deployment is the existing zero-source-schema runner_ledger mode. It proves a stored canonical result corroborated by independent readback; it is not a source-atomic receipt claim.
''',
  'edits':{'automatic_edit':'Lower automatic ratifications per league from two to one per rolling 24 hours. Keep the overall six cap, qualifying/championship distinction, every eligibility rule, scope, private-field restrictions and effects unchanged. Existing automatic history still counts.',
   'add':'Add a separate Withdraw unratified result behavior: only a finished result in an open event with no integrity hold; require the supervisor to review every valid request. Change its state to withdrawn and save a nonempty reason of at most 200 characters in the existing withdrawal_reason. Preserve scores, ratification rules and every unrelated Read restriction.',
   'remove':'Remove only Withdraw unratified result. Preserve ratification, scoped reads, old history and the continuing client. An old unstarted withdrawal must not acquire new dispatch permission after removal.',
   'pause_resume':'Save and leave initial onboarding after a real accepted metadata/business checkpoint and before activation; resume through the normal product route. Record the actual checkpoint rather than claiming one that was not reached.'}},
 {'id':'software-release-sealing','title':'Software build sealing and release-slot consumption','schema':'release_ops','reader':'release_trial_reader','tables':['release_slots','build_candidates','build_checks'],
  'policy':'''# Seal a tested software build record

Help a release coordinator seal a staged build candidate in that coordinator's software organization. This job changes only synthetic database records; it never deploys software, signs a binary or contacts an external system. Coordinators may see only their own organization's assigned candidates and reserved slots. Public information is candidate reference, application name, candidate state, slot reference and slot state. Do not expose database identity keys, version counters, security_hold, internal_finding, or individual check records through rows, filters, ordering, grouping, aggregates or explanations. Check facts and holds may be used privately by the host solely to verify the action.

Seal a candidate only when its current state is staged, its related reserved slot is ready, and security_hold is false. Load the complete set of check records related to that exact candidate: require at least two checks, every check passed, and total elapsed check time no more than 600 seconds. Elapsed times are nonnegative whole seconds. The source contract allows at most twelve checks per candidate; overflow, missing/unknown facts, a failed/pending check or a missing relationship must refuse safely. Do not substitute a cached total or only a convenient subset of checks.

A successful seal must atomically change candidate state to sealed and that same reserved slot's state to consumed, updating both maintained conflict counters. Both rows and the durable source receipt must commit together in this one PostgreSQL database, or neither row may change. Do not split this into independently approved or independently committed actions. One slot belongs to one candidate in the scoped relationship.

Valid requests with total check time no more than 120 seconds may be approved automatically, with a maximum of eight automatic seals overall and three per software organization in the inclusive rolling 24-hour window. A valid slower request (up to 600 seconds), or a request exceeding either automatic cap, requires the release supervisor's human review. Counts are shared across coordinators of the same organization. Human review does not override an invalid check, a hold, a stale version or an unavailable slot. Execution is separately supervised, followed by the stored source receipt and independent readback of both changed rows.
''',
  'schema_sql':'''CREATE SCHEMA release_ops;
CREATE TABLE release_ops.release_slots (
 slot_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, principal_id uuid NOT NULL,
 slot_ref text NOT NULL UNIQUE, slot_state text NOT NULL CHECK(slot_state IN ('ready','consumed','retired')),
 version integer NOT NULL DEFAULT 1 CHECK(version > 0), UNIQUE(slot_id,tenant_id,principal_id));
CREATE TABLE release_ops.build_candidates (
 candidate_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, principal_id uuid NOT NULL,
 slot_id uuid NOT NULL UNIQUE, candidate_ref text NOT NULL UNIQUE, application_name text NOT NULL,
 candidate_state text NOT NULL CHECK(candidate_state IN ('staged','sealed')),
 security_hold boolean NOT NULL, internal_finding text NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 UNIQUE(candidate_id,tenant_id,principal_id),
 FOREIGN KEY(slot_id,tenant_id,principal_id) REFERENCES release_ops.release_slots(slot_id,tenant_id,principal_id));
CREATE TABLE release_ops.build_checks (
 check_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, principal_id uuid NOT NULL, candidate_id uuid NOT NULL,
 check_kind text NOT NULL, check_state text NOT NULL CHECK(check_state IN ('passed','failed','pending')),
 elapsed_seconds integer NOT NULL CHECK(elapsed_seconds >= 0), private_check_note text NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 FOREIGN KEY(candidate_id,tenant_id,principal_id) REFERENCES release_ops.build_candidates(candidate_id,tenant_id,principal_id));
''',
  'owner':'''A release slot is a pre-existing reservation, not an approval budget record. A candidate has one unique reserved slot; the slot is not shared with another candidate. The candidate's children are all its build-check records, not only passed checks. Each elapsed_seconds is a whole count of seconds. The database stores no cached count or total. Application_name is a display label, not executable software or a shell command. security_hold is a private condition and internal_finding/private_check_note are private text; do not expose their content while explaining refusal.

tenant_id is the software organization; principal_id is its assigned coordinator. Candidate, reserved slot and every child check share the same scope values under validated immediate foreign keys. A coordinator's RLS reveals all children of an owned candidate without additional hiding conditions, so a complete set can be verified. At most twelve checks are supported; the deliberate overflow fixture is an invalid refusal control, never a reason to raise the bound.

Require the existing source receipt mode with explicit generated narrow receipt provisioning. The source owner can apply the exact reviewed prerequisite SQL and rescan through the public flow. This is not a new request for arbitrary schema migration or a different engine feature. If the public model-assisted route cannot establish the atomic two-row effect and receipt mode, stop and record that prerequisite; never silently use two independent updates or claim a ledger receipt is source-atomic.
''',
  'edits':{'automatic_edit':'Lower the automatic approval check-time threshold from 120 seconds to 60 seconds. Leave the valid maximum of 600 seconds, two-to-twelve all-passed checks, security hold, source-atomic two-row effect, eight overall and three per-organization rolling caps, scope and privacy unchanged.',
   'add':'Add Retire unused release slot: a coordinator may request retirement only of their own ready slot, with release-supervisor review for every valid request. Change only that slot state to retired plus its maintained version. Keep sealing, its complete checks and atomic effect, all history and unrelated reads unchanged.',
   'remove':'Remove only Retire unused release slot. Keep sealing and all unrelated policy and reads. Previously recorded work/history remains; no old unstarted retirement may obtain a new dispatch after removal.',
   'pause_resume':'Interrupt the automatic-threshold model edit after the full requested change and a real saved checkpoint, before completion. Resume the pending edit through the normal route and compare the actual semantic 120-to-60 change, not only a digest.'}}
]
selection={'selected_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'candidate_tree':plan['candidate_tree'],'exactly_two':True,'external_review':'IN_PROGRESS_EXTERNALLY','authoring_trials_started':0,
 'used_domains_consulted':['student/admissions','telecom','coded warehouse','service appointments','library','manufacturing','museum','municipal','garden','radio','editorial','insurance','gym membership freeze','freight dispatch'],
 'known_open_scope_finding':'manual-mode-test-20260911/FINDINGS.md Finding 8 (line 266) and freight-c2 continuation (line 661): unconventional identity mapping; historical gate2-repair artifact, untested here. Neither selected layout uses unconventional identity names.',
 'rejected_candidates':[
 {'candidate':'gym membership pause or freight dispatch, including renamed variants','reason':'Explicitly USED and excluded by the user; no trial run.'},
 {'candidate':'warehouse replenishment / library reservations / manufacturing order completion / editorial publishing','reason':'Used audit cases or close renamings; not selected.'},
 {'candidate':'utility credit expiry requiring authoritative database-origin now','reason':'Selection requirement outside declared clock contract; no trial run or product defect inferred.'},
 {'candidate':'uncapped automatic organization action','reason':'Missing required overall automatic cap; rejected as a specification selection error before either case was frozen.'}],
 'novelty_basis':'New policies and newly generated tables/facts; no policy, DDL, source rows, saved onboarding, authority or diagnostic correction from a used case is copied. The audit/findings contain no tournament-result ratification or software-build sealing case. Shared generic UPDATE/collection grammar is intentional supported-engine reuse, not claimed to be unseen grammar.',
 'structural_difference':'Tournament: one mutable result and a scoped parent with scalar best-of-three predicates and stage-dependent approval. Software: two distinct mutable records joined by a unique composite-scope FK plus a complete private inverse-FK collection with count/all-passed/sum constraints and a source-atomic receipt.',
 'fixture_author_independence':'Coordinator/implementer is also fixture author; no independent fixture-author claim, no trial onboarding or constructed authority.', 'cases':[]}
for d in definitions:
    case=root/d['id']; case.mkdir(); (case/'project').mkdir();(case/'home').mkdir()
    save(case/'authoring-input/policy.md',d['policy']);save(case/'authoring-input/owner-answers.md',common+'\n'+d['owner'])
    save(case/'schema.sql',d['schema_sql']+rls(d['schema'],d['tables'],d['reader']))
    save(case/'verifier/planned-edits.json',d['edits'])
    tenants=[uid() for _ in range(3)]; contexts={alias:{'tenant_id':tenants[tenant],'principal_id':uid()} for alias,tenant in [('primary',0),('colleague',0),('second-org',1),('third-org',2)]}
    facts={t:[] for t in d['tables']}; subjects={}; checks={}; private_tokens=[]
    for alias,scope in contexts.items():
        subjects[alias]={}
        if d['id']=='tournament-ratification':
            event=uid(); closed=uid()
            for event_id,state in [(event,'open'),(closed,'closed')]: facts['events'].append({'event_id':event_id,**scope,'event_name':'Synthetic Cup '+alias,'operating_state':state,'version':1})
            purposes=['eligible-'+str(i).zfill(2) for i in range(1,17)]+['human-championship','invalid-score','invalid-losses','held','closed-event','already-ratified','withdraw-pending','withdraw-execute']
            for i,purpose in enumerate(purposes,1):
                token='PRIVATE-'+secrets.token_hex(16);private_tokens.append(token)
                row={'result_id':uid(),**scope,'event_id':closed if purpose=='closed-event' else event,'result_ref':alias+'-R'+str(i).zfill(2),'stage':'championship' if purpose=='human-championship' else 'qualifying','winner_game_wins':1 if purpose=='invalid-score' else 2,'loser_game_wins':2 if purpose=='invalid-losses' else 1,'result_state':'ratified' if purpose=='already-ratified' else 'finished','integrity_hold':purpose=='held','referee_private_note':token,'withdrawal_reason':None,'version':1}
                facts['results'].append(row);subjects[alias][purpose]=row['result_ref']
        else:
            purposes=['fast-'+str(i).zfill(2) for i in range(1,17)]+['threshold-90-a','threshold-90-b','human-300','too-slow-601','failed-check','pending-check','too-few','overflow','held','slot-unavailable','already-sealed','retire-pending','retire-execute']
            for i,purpose in enumerate(purposes,1):
                slot,candidate=uid(),uid(); token='PRIVATE-'+secrets.token_hex(16);private_tokens.append(token)
                facts['release_slots'].append({'slot_id':slot,**scope,'slot_ref':alias+'-S'+str(i).zfill(2),'slot_state':'consumed' if purpose=='slot-unavailable' else 'ready','version':1})
                row={'candidate_id':candidate,**scope,'slot_id':slot,'candidate_ref':alias+'-B'+str(i).zfill(2),'application_name':'Synthetic build '+alias,'candidate_state':'sealed' if purpose=='already-sealed' else 'staged','security_hold':purpose=='held','internal_finding':token,'version':1}
                facts['build_candidates'].append(row);subjects[alias][purpose]=row['candidate_ref']
                count=1 if purpose=='too-few' else 13 if purpose=='overflow' else 2
                total=90 if purpose.startswith('threshold-90') else 300 if purpose=='human-300' else 601 if purpose=='too-slow-601' else 40
                times=[total//count]*count;times[0]+=total-sum(times)
                for n in range(count):
                    note='PRIVATE-'+secrets.token_hex(16);private_tokens.append(note)
                    facts['build_checks'].append({'check_id':uid(),**scope,'candidate_id':candidate,'check_kind':'synthetic-check-'+str(n+1),'check_state':'failed' if purpose=='failed-check' and n==0 else 'pending' if purpose=='pending-check' and n==0 else 'passed','elapsed_seconds':times[n],'private_check_note':note,'version':1})
    save(case/'private/source-facts.json',facts);save(case/'private/reviewed-context-inputs.json',contexts);save(case/'private/private-sentinels.json',private_tokens);save(case/'verifier/subject-plan.json',subjects)
    oracle={'functional_correctness':'NOT_RUN','model_assisted_completion':'NOT_RUN','ux':'NOT_MEASURED','policy_unchanged':True,'no_authority_prepared':True,
     'request_allocation':{'eligible/fast-01':'initial real-model request, approved execution, stored receipt and independent readback','eligible/fast-02':'old unstarted automatic work retained across reviewed edit','eligible/fast-03':'identical/replay and deterministic contention control','eligible/fast-04..08':'distinct requests/history via ordinary MCP if required before publication','eligible/fast-09..12':'current-policy positives after edit in applicable contexts','eligible/fast-13..16':'reserved fresh eligible subjects, not replacement cases'},
     'required_rows':['model-assisted initial draft preserves complete policy','disabled authority verified before review','exact Read/Action review','narrow writer/admin/rescan/execution prerequisites','reviewed local identity, own read and four-tool runtime client','actual execution, stored canonical receipt, independent readback','valid human review with separate supervisor approval','invalid/held requests: no automatic approval or source effects','private rows/filter/sort/group/aggregate refusal; private sentinels absent from provider transcript','own and inappropriate reviewed contexts with normal refs; actual rejection layer reported','changed-fact coordination using legitimate owner update plus maintained version; source control remains invalid','real contention measured at product/source coordination, exact durable outcomes','ordinary-language automatic edit, exact semantic meaning and retained unrelated rules/history','same connected runtime client current behavior','old unstarted work current-authority guard','planned saved onboarding or model-edit interruption and resume','ordinary-language add behavior, reviewed execution/pending control','ordinary-language removal preserves other behavior/read/history and refuses old unstarted dispatch'],
     'initial_expectations':{'eligible':'automatic only while both applicable caps permit','human':'valid persisted human review without execution until authorized','invalid':'no approval or executable permission, zero source effects; unapproved proposal presence must be reported accurately','privacy':'private value absence, not just absent public field names','receipt':'runner_ledger plus row readback' if d['id']=='tournament-ratification' else 'same source transaction: two rows plus canonical source receipt'},
     'edit_expectations':d['edits'],'history':'never insert approvals or refund; use fresh public references and ledger differences with real IDs','no_mid_trial_fixture_repair':True,'unrelated_product_failure':'preserve and stop path; no third case or product fix','known_scope_recurrence':'record known Finding 8 if that shape recurs, not a new discovery',
     'ux_counters':['draft time','first verified execution time','hands-on time','provider wait','administrator work','measurement-only time','edit-to-draft and edit-to-behavior','provider calls','genuine business decisions','repeated applicable answers','retries','navigation detours','lost/re-entered context','manual/config interventions','inaccurate completion claims'],
     'assistance':'Fresh case provider/operator transcript and runtime session required; coordinator role overlap disclosed. No internal source/diagnostic engineering sentence may be counted as unaided user work. One labelled continuation max within the same budget.'}
    save(case/'verifier/expected-outcomes.json',oracle)
    save(case/'case.json',{'id':d['id'],'title':d['title'],'schema':d['schema'],'reader_role':d['reader'],'table_order':d['tables'],'candidate_tree':plan['candidate_tree'],'empty_project':str(case/'project'),'authoring_allowed_inputs':['authoring-input/policy.md','authoring-input/owner-answers.md','consented metadata inspected through public product flow','public documentation'],'private_excluded_inputs':['private/','verifier/','source row dumps','credentials','identity values'],'budgets':{k:v for k,v in plan['budgets'].items() if k.startswith('per_case') or k.startswith('assisted_')},'counts':{t:len(rows) for t,rows in facts.items()},'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat()})
    records=[]
    for p in sorted(case.rglob('*')):
        if p.is_file(): records.append({'path':str(p.relative_to(case)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
    tree=hashlib.sha256(json.dumps(records,separators=(',',':')).encode()).hexdigest()
    manifest={'frozen_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'case':d['id'],'case_root':str(case),'candidate_tree':plan['candidate_tree'],'records':records,'fixture_input_tree_sha256':tree,'authoring_runs':0,'database_loaded':False,'project_is_empty':not list((case/'project').iterdir()),'no_fixture_source_or_authority_copied_from_used_case':True}
    save(case/'frozen-input-manifest.json',manifest)
    for rec in records: os.chmod(case/rec['path'],0o400)
    os.chmod(case/'frozen-input-manifest.json',0o400)
    selection['cases'].append({'id':d['id'],'title':d['title'],'root':str(case),'manifest':str(case/'frozen-input-manifest.json'),'manifest_sha256':hashlib.sha256((case/'frozen-input-manifest.json').read_bytes()).hexdigest(),'fixture_input_tree_sha256':tree,'counts':{t:len(rows) for t,rows in facts.items()},'identity_columns':'conventional tenant_id/principal_id','authoring_runs':0})
save(E/'case-selection.json',selection)
print(json.dumps({'selected_cases':[x['id'] for x in selection['cases']],'frozen':True,'authoring_runs':0,'private_facts_committed':False}))
