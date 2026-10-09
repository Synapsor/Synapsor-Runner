import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const pin = '9f8fe16f14b99594505319aca85307361753b664';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const between = (text, start, end) => text.slice(text.indexOf(start) + start.length, text.indexOf(end, text.indexOf(start)));
const records = [];
for (const name of ['owner-policy-parent-model', 'model-principal-scope-review']) {
  const file = `apps/runner/src/${name}.ts`;
  const before = execFileSync('git', ['show', `${pin}:${file}`], { encoding: 'utf8' });
  const after = fs.readFileSync(file, 'utf8');
  let restored = after.slice(after.indexOf('\n') + 1);
  const parent = name === 'owner-policy-parent-model';
  const base = between(before, parent ? '  const baseQuestion = ' : '  const question = ', ';\n  const run =');
  const system = between(before, '    providerSystemPrompt: ', ',\n    skipRunnerQuestionContext:');
  const correction = between(before, parent ? 'await run(attempt === 0 ? baseQuestion : ' : '    await run(', parent ? ');\n        if (pendingResolution)' : ');\n  }\n  await gateway.close');
  const replacements = parent ? [
    ['buildOwnerPolicyParentPrompt({ operatorMessage, catalog, prior, active, allowedAgents })', base],
    ['providerSystemPrompt: OWNER_POLICY_PARENT_SYSTEM_PROMPT', `providerSystemPrompt: ${system}`],
    ['buildOwnerPolicyParentCorrectionPrompt({ baseQuestion, issue })', correction],
  ] : [
    ['buildModelPrincipalScopePrompt({ resourceId: input.resourceId, catalog, answer, scopeKind: input.scopeKind })', base],
    ['providerSystemPrompt: MODEL_PRINCIPAL_SCOPE_SYSTEM_PROMPT', `providerSystemPrompt: ${system}`],
    ['buildModelPrincipalScopeCorrectionPrompt({ question, issue })', correction],
  ];
  for (const [find, replacement] of replacements) {
    if (restored.split(find).length !== 2) throw new Error(`Expected exactly one substitution: ${find}`);
    restored = restored.replace(find, replacement);
  }
  if (restored !== before) throw new Error(`Host changed outside prompt assemblies/import: ${file}`);
  records.push({ file, before_sha256: hash(before), after_sha256: hash(after), restored_sha256: hash(restored), outside_prompt_assembly_and_import_byte_identical: true });
}
const report = { pin, records, caveat: 'Source comparison only. No runtime, native, provider or correction behavior verdict.' };
fs.writeFileSync('/var/tmp/synapsor-b62-prompts-owned/evidence/SOURCE-PARITY.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
