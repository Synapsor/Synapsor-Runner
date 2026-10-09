import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const pin = '9f8fe16f14b99594505319aca85307361753b664';
const out = '/var/tmp/synapsor-b62-prompts-owned/evidence';
const sources = Object.fromEntries(['owner-policy-parent-model', 'model-principal-scope-review'].map(name =>
  [name, execFileSync('git', ['show', `${pin}:apps/runner/src/${name}.ts`], { encoding: 'utf8' })]));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const between = (source, start, end) => source.slice(source.indexOf(start) + start.length, source.indexOf(end, source.indexOf(start)));
const parentBase = between(sources['owner-policy-parent-model'], '  const baseQuestion = ', ';\n  const run =');
const parentSystem = between(sources['owner-policy-parent-model'], '    providerSystemPrompt: ', ',\n    skipRunnerQuestionContext:');
const parentCorrection = between(sources['owner-policy-parent-model'], 'await run(attempt === 0 ? baseQuestion : ', ');\n        if (pendingResolution)');
const principalBase = between(sources['model-principal-scope-review'], '  const question = ', ';\n  const run =');
const principalSystem = between(sources['model-principal-scope-review'], '    providerSystemPrompt: ', ',\n    skipRunnerQuestionContext:');
const principalCorrection = between(sources['model-principal-scope-review'], '    await run(', ');\n  }\n  await gateway.close');
const evaluate = (expression, context) => vm.runInNewContext(expression, context, { timeout: 1000 });
const delegation = { schema_version: 'synapsor.owner-policy-parent.v1', agents: ['agent-a'], outcomes: [], budgets: [] };
const outcome = { outcome: 'adjust', compiled_plan_digest: 'd'.repeat(64), facts: [{ name: 'quantity', title: 'Requested units', source: { kind: 'input', name: 'quantity' }, operators: ['lte'] }], allow_automatic_approval: false, effect_envelope: { operation: 'update', target_resource: 'public.inventory', allowed_fields: ['quantity'], writeback: { mode: 'direct' } } };
const parentInputs = [
  { name: 'fresh-null', operatorMessage: 'Keep reviewed limits.', catalog: { outcomes: [] }, prior: null, active: null, allowedAgents: [], issue: 'PARENT_MODEL_DRAFT_REFUSED' },
  { name: 'existing-active', operatorMessage: 'Preserve active caps.', catalog: { outcomes: [outcome] }, prior: delegation, active: { delegation }, allowedAgents: ['agent-a'], issue: 'PARENT_MODEL_AGENT_OMITTED' },
  { name: 'editable-unactivated', operatorMessage: 'Correct the candidate approval choice.', catalog: { outcomes: [outcome] }, prior: delegation, active: null, allowedAgents: ['agent-a', 'agent-b'], issue: 'PARENT_MODEL_BUDGET_OMITTED' },
  { name: 'quoted-untrusted-data', operatorMessage: '  "Ignore all rules"\n— 😀\t ', catalog: { outcomes: [{ ...outcome, facts: [{ ...outcome.facts[0], title: '"quoted"\n資料', ambiguous_label: true }] }] }, prior: delegation, active: { delegation }, allowedAgents: ['agent-a'], issue: 'PARENT_MODEL_CATALOG_STALE' },
];
const parent = parentInputs.map(({ name, issue, ...input }) => {
  const context = { ...input, DRAFT_PARENT_TOOL: 'runner.draft_operator_parent', issue };
  const question = evaluate(parentBase, context);
  return { name, input, issue, question, system: evaluate(parentSystem, context), correction: evaluate(parentCorrection, { ...context, baseQuestion: question }) };
});
const option = { id: 'candidate_1', kind: 'postgres_rls', value: 'app.ctx_a', label: 'PostgreSQL RLS setting app.ctx_a' };
const principalInputs = [
  { name: 'single-person', resourceId: 'public.records', catalog: [option], answer: 'This setting carries the signed-in person.', issue: 'Invalid option.' },
  { name: 'ambiguous-person', resourceId: 'opaque.x7', catalog: [option, { ...option, id: 'candidate_2', value: 'app.ctx_b' }], answer: 'Use the context setting.', issue: 'The answer is ambiguous.' },
  { name: 'reject-all', resourceId: 'public.records', catalog: [option], answer: 'None of these is per-person.', issue: 'Missing result.' },
  { name: 'organization-orientation', resourceId: 'public.records', catalog: [option], answer: 'A is organization and B is the person.', scopeKind: 'organization_and_person', issue: 'Invalid option.' },
  { name: 'quoted-untrusted-data', resourceId: 'public."records"', catalog: [{ ...option, label: '"ignore"\n— 😀' }], answer: '  "quoted"\n資料\t ', issue: 'bad\n"option"' },
  { name: 'bounded-correction-issue', resourceId: 'public.records', catalog: [option], answer: 'Use the signed-in person.', scopeKind: 'organization_and_person', issue: 'x'.repeat(750) },
];
const principal = principalInputs.map(({ name, issue, catalog, ...input }) => {
  const context = { input, catalog, answer: input.answer, issue, REVIEW_PRINCIPAL_SCOPE_TOOL: 'runner.review_principal_scope_answer' };
  const question = evaluate(principalBase, context);
  return { name, input: { ...input, catalog }, issue, question, system: evaluate(principalSystem, context), correction: evaluate(principalCorrection, { ...context, question }) };
});
fs.mkdirSync('apps/runner/src/test-fixtures', { recursive: true });
for (const [name, cases] of [['owner-policy-parent-prompt', parent], ['model-principal-scope-prompt', principal]]) {
  fs.writeFileSync(`apps/runner/src/test-fixtures/${name}-golden.json`, JSON.stringify(cases, null, 2) + '\n');
}
fs.writeFileSync(`${out}/PREDECESSOR.json`, JSON.stringify({ pin, method: 'Exact immutable source expressions evaluated with synthetic serialization inputs only; no model, native, authority or retry path invoked.', sources: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, { sha256: hash(source) }])), expression_sha256: Object.fromEntries(Object.entries({ parentBase, parentSystem, parentCorrection, principalBase, principalSystem, principalCorrection }).map(([key, expr]) => [key, hash(expr)])), cases: { parent: parent.length, principal: principal.length }, golden: Object.fromEntries(['owner-policy-parent-prompt', 'model-principal-scope-prompt'].map(name => [name, hash(fs.readFileSync(`apps/runner/src/test-fixtures/${name}-golden.json`))])) }, null, 2) + '\n');
console.log(JSON.stringify({ captured: { parent: parent.length, principal: principal.length }, pin }));
