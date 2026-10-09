from pathlib import Path
import subprocess

root = Path('apps/runner/src')
pin = '9f8fe16f14b99594505319aca85307361753b664'
def source(name):
    return subprocess.check_output(['git', 'show', f'{pin}:apps/runner/src/{name}.ts'], text=True)
def between(text, start, end):
    return text.split(start, 1)[1].split(end, 1)[0]

p = source('owner-policy-parent-model')
base = between(p, '  const baseQuestion = ', ';\n  const run =')
system = between(p, '    providerSystemPrompt: ', ',\n    skipRunnerQuestionContext:')
correction = between(p, 'await run(attempt === 0 ? baseQuestion : ', ');\n        if (pendingResolution)')
parent = '''import type { PolicyManagementParent } from "@synapsor-runner/mcp-server";
import type { ParentDelegationCatalog } from "./owner-policy-parent-model.js";

/** Descriptive ownership only; never added to provider bytes, durable records,
 * authority digests or existing in-flight operation pins. */
export const OWNER_POLICY_PARENT_PROMPT = {
  id: "synapsor.owner-policy-parent.delegation",
  version: 1,
  contract: { submission_tool: "runner.draft_operator_parent", states: ["candidate", "clarification"] },
  context_owner: "owner-policy-parent-model",
  correction_owner: "owner-policy-parent-model",
} as const;
const DRAFT_PARENT_TOOL = OWNER_POLICY_PARENT_PROMPT.contract.submission_tool;

/** Already bounded, resolved producer snapshots. Rendering grants no authority
 * and cannot resolve, adopt, save, retry or replace any current context. */
export type OwnerPolicyParentPromptInput = Readonly<{
  operatorMessage: string;
  catalog: ParentDelegationCatalog;
  prior: PolicyManagementParent["delegation"] | null;
  active: Pick<PolicyManagementParent, "delegation"> | null;
  allowedAgents: readonly string[];
}>;

export const OWNER_POLICY_PARENT_SYSTEM_PROMPT = __SYSTEM__;

export function buildOwnerPolicyParentPrompt(input: OwnerPolicyParentPromptInput): string {
  const { operatorMessage, catalog, prior, active, allowedAgents } = input;
  return __BASE__;
}

/** The producer alone decides whether its one bounded correction may run. */
export function buildOwnerPolicyParentCorrectionPrompt(input: Readonly<{ baseQuestion: string; issue: string }>): string {
  const { baseQuestion, issue } = input;
  return __CORRECTION__;
}
'''.replace('__SYSTEM__', system).replace('__BASE__', base).replace('__CORRECTION__', correction)
(root / 'owner-policy-parent-prompt.ts').write_text(parent)
p = p.replace('  const baseQuestion = ' + base + ';', '  const baseQuestion = buildOwnerPolicyParentPrompt({ operatorMessage, catalog, prior, active, allowedAgents });')
p = p.replace('providerSystemPrompt: ' + system, 'providerSystemPrompt: OWNER_POLICY_PARENT_SYSTEM_PROMPT')
p = p.replace('attempt === 0 ? baseQuestion : ' + correction, 'attempt === 0 ? baseQuestion : buildOwnerPolicyParentCorrectionPrompt({ baseQuestion, issue })')
p = 'import { buildOwnerPolicyParentPrompt, buildOwnerPolicyParentCorrectionPrompt, OWNER_POLICY_PARENT_SYSTEM_PROMPT } from "./owner-policy-parent-prompt.js";\n' + p
(root / 'owner-policy-parent-model.ts').write_text(p)

s = source('model-principal-scope-review')
base = between(s, '  const question = ', ';\n  const run =')
system = between(s, '    providerSystemPrompt: ', ',\n    skipRunnerQuestionContext:')
correction = between(s, '    await run(', ');\n  }\n  await gateway.close')
principal = '''import type { ModelPrincipalScopeOption } from "./model-principal-scope-review.js";

/** Descriptive ownership only; never added to provider bytes, durable records,
 * authority digests or existing in-flight operation pins. */
export const MODEL_PRINCIPAL_SCOPE_PROMPT = {
  id: "synapsor.principal-scope.answer",
  version: 1,
  contract: { submission_tool: "runner.review_principal_scope_answer", states: ["resolved", "none", "clarification"] },
  context_owner: "model-principal-scope-review",
  correction_owner: "model-principal-scope-review",
} as const;
const REVIEW_PRINCIPAL_SCOPE_TOOL = MODEL_PRINCIPAL_SCOPE_PROMPT.contract.submission_tool;

/** Exact already reviewed candidate snapshot and bounded answer supplied by the
 * producer; this renderer does not choose scope or trusted identity values. */
export type ModelPrincipalScopePromptInput = Readonly<{
  resourceId: string;
  catalog: readonly ModelPrincipalScopeOption[];
  answer: string;
  scopeKind?: "organization_and_person";
}>;

export const MODEL_PRINCIPAL_SCOPE_SYSTEM_PROMPT = __SYSTEM__;

export function buildModelPrincipalScopePrompt(input: ModelPrincipalScopePromptInput): string {
  const { catalog, answer } = input;
  return __BASE__;
}

/** Eligibility and consumption of the bounded correction remain producer-owned. */
export function buildModelPrincipalScopeCorrectionPrompt(input: Readonly<{ question: string; issue: string }>): string {
  const { question, issue } = input;
  return __CORRECTION__;
}
'''.replace('__SYSTEM__', system).replace('__BASE__', base).replace('__CORRECTION__', correction)
(root / 'model-principal-scope-prompt.ts').write_text(principal)
s = s.replace('  const question = ' + base + ';', '  const question = buildModelPrincipalScopePrompt({ resourceId: input.resourceId, catalog, answer, scopeKind: input.scopeKind });')
s = s.replace('providerSystemPrompt: ' + system, 'providerSystemPrompt: MODEL_PRINCIPAL_SCOPE_SYSTEM_PROMPT')
s = s.replace('    await run(' + correction + ');', '    await run(buildModelPrincipalScopeCorrectionPrompt({ question, issue }));')
s = 'import { buildModelPrincipalScopePrompt, buildModelPrincipalScopeCorrectionPrompt, MODEL_PRINCIPAL_SCOPE_SYSTEM_PROMPT } from "./model-principal-scope-prompt.js";\n' + s
(root / 'model-principal-scope-review.ts').write_text(s)
