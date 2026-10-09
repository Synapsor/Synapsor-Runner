const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const child = require('node:child_process');
const source = fs.readFileSync('apps/runner/src/read-workload-model.ts','utf8');
const scope = fs.readFileSync('apps/runner/src/read-structured-scope.ts','utf8');
const start = source.indexOf('  const workloadDescriptionGuidance = ');
const end = source.indexOf('  const diagnostics: ReadWorkloadDiagnostic[]',start);
if(start < 0 || end < 0)throw Error('Exact predecessor block unavailable');
const captured = source.slice(start,end);
const protocol = JSON.parse(scope.match(/export const READ_SCOPE_PROTOCOL = ("[^"]+") as const;/)[1]);
const guidance = JSON.parse(scope.match(/export const READ_SUBJECT_SCOPE_GUIDANCE = (".*");/)[1]);
const digest='sha256:'+'0'.repeat(64);
const base={name:'read_example',allowedQuestions:['Show labels.'],forbiddenQuestions:[],originalNamingSources:['Show labels.'],references:[],subjectScopes:[],serializedCatalog:'{"resources":[],"relationships":[]}'};
const ref={kind:'request',id:'job',digest,text:'Show labels.'};
const subject={root_resource:'work.items',reference:'reviewed_scope',source_digest:digest,review_digest:digest,configuration_digest:digest,kind:'principal'};
const proposal={protocol,original_request:'job',applicability:'read_requested',requirements:[{id:'labels',intended_use:'Show labels',references:['job'],disposition:'include',subjects:[{root_resource:'work.items',mode:'trusted_principal'}],targets:[{root_resource:'work.items',resource:'work.items',operation:'return',field:'label'}]}]};
const variants=[
 ['unconfirmed-empty-inventory',{}],
 ['unicode-quotes-newlines',{name:'Résumé "秋"',allowedQuestions:['Show "labels".\nKeep \\ escapes.'],originalNamingSources:['原文\n"Show labels"'] }],
 ['request-and-answer-references',{references:[ref,{kind:'answer',id:'answer_1',digest,text:'The declared labels',question_id:'question_1',question_revision:2,answer_id:'answer_1'}]}],
 ['principal-subject-inventory',{references:[ref],subjectScopes:[subject]}],
 ['global-subject-inventory',{subjectScopes:[{...subject,kind:'global'}]}],
 ['confirmed-scope',{references:[ref],subjectScopes:[subject],confirmedProposal:proposal}],
 ['explicit-exclusion',{forbiddenQuestions:['Do not return the note.'],confirmedProposal:{...proposal,requirements:[...proposal.requirements,{id:'note',intended_use:'Do not disclose notes',references:['job'],disposition:'exclude',subjects:[],targets:[{root_resource:'work.items',resource:'work.items',operation:'return',field:'note'}]}]}}],
 ['changed-current-snapshot',{references:[{...ref,text:'Show current labels.'}],serializedCatalog:'{"resources":[{"id":"work.items","fields":[{"id":"label","type":"text"}]}],"relationships":[]}'}],
];
const rows=variants.map(([name,override])=>{
 const input={...structuredClone(base),...override};
 const context={name:input.name,allowedQuestions:input.allowedQuestions,forbiddenQuestions:input.forbiddenQuestions,originalNamingSources:input.originalNamingSources,scopeReferences:()=>input.references,structuredScopeInput:{catalog:{subject_scopes:input.subjectScopes}},confirmedScope:input.confirmedProposal?{proposal:input.confirmedProposal}:undefined,serializeCatalog:()=>input.serializedCatalog,READ_SCOPE_PROTOCOL:protocol,READ_SUBJECT_SCOPE_GUIDANCE:guidance};
 const output=vm.runInNewContext(captured.replace('structuredScopeInput!.catalog','structuredScopeInput.catalog')+'\n({question:baseQuestion(),system:providerSystemPrompt})',context);
 return {name,input,...output};
});
fs.writeFileSync('apps/runner/src/test-fixtures/read-workload-prompt-golden.json',JSON.stringify(rows,null,2)+'\n');
fs.writeFileSync('docs/development/b62-read-prompt-extraction/PREDECESSOR.json',JSON.stringify({pin:child.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),source_file:'apps/runner/src/read-workload-model.ts',source_sha256:crypto.createHash('sha256').update(source).digest('hex'),captured_block_sha256:crypto.createHash('sha256').update(captured).digest('hex'),captured_block_start:'const workloadDescriptionGuidance',captured_block_end:'const diagnostics',capture_method:'Evaluate exact preexisting array/system literal with declared serialization-only snapshots; remove only TypeScript nonnull assertion. No provider/authority/CAS path executed.',cases:rows.length,protocol,golden_sha256:crypto.createHash('sha256').update(fs.readFileSync('apps/runner/src/test-fixtures/read-workload-prompt-golden.json')).digest('hex')},null,2)+'\n');
console.log('Captured '+rows.length+' exact predecessor prompt pairs; no Source copies/provider calls.');
