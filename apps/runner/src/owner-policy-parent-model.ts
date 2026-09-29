import { isAuthoringGenerationStop } from "./authoring-generation-recovery.js";
import { authoringRequestTimeoutSeconds } from "./authoring-request-timeout.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { CompiledActionRuleV1 } from "@synapsor-runner/action-rules";
import {
  assertBoundedOwnerPolicyInput,
  ownerPolicyParentModelJsonSchema,
  ownerPolicyParentModelResultSchema,
  policyManagementParentSchema,
  validateOwnerPolicyParent,
  type PolicyManagementParent,
} from "@synapsor-runner/mcp-server";
import type { OwnerPolicyFact, OwnerPolicyParent } from "../../../packages/mcp-server/src/owner-policy-language.js";
import {
  askToolSurfaceDigest,
  resolveAskProviderConfiguration,
  runAskProviderTurn,
  type AskToolDefinition,
  type AskToolGateway,
} from "./model-ask.js";
import { modelAuthoringHistory, rememberModelAuthoringTurn } from "./model-authoring-conversation.js";
import type { BoundaryJobPlanningSession } from "./boundary-job-model.js";

const DRAFT_PARENT_TOOL = "runner.draft_operator_parent";
const MAX_MESSAGE = 4_000;
const MAX_CATALOG_BYTES = 64 * 1024;

export type TrustedParentIdentityBindings = Pick<PolicyManagementParent, "managers" | "agent_owners" | "runtime_delegations">;
type CatalogFact = OwnerPolicyFact & { ambiguous_label?: true };
export type ParentDelegationCatalog = {
  outcomes: Array<Omit<Pick<OwnerPolicyParent["outcomes"][number], "outcome" | "compiled_plan_digest" | "facts" | "require" | "allow_automatic_approval" | "budget_charges">, "facts"> & { facts: CatalogFact[];
    effect_envelope: Pick<CompiledActionRuleV1["effect_envelope"], "operation" | "target_resource" | "allowed_fields" | "writeback">;
  }>;
};
export type ParentModelDraft = {
  state: "candidate";
  parent: PolicyManagementParent;
  summary: string;
  correction_used: boolean;
  authority_granted: false;
  source_database_changed: false;
} | {
  state: "clarification";
  question: string;
  correction_used: boolean;
  authority_granted: false;
  source_database_changed: false;
};

export class OwnerPolicyParentModelError extends Error {
  constructor(readonly code: string) { super(code); this.name = "OwnerPolicyParentModelError"; }
}

/** Builds model vocabulary from reviewed compiler metadata. Existing parent
 * facts retain their reviewed titles and operator sets; unlabeled scalar
 * sources use raw qualified identifiers and are marked ambiguous. */
export function buildOperatorParentCatalog(
  compiledRules: CompiledActionRuleV1[],
  currentParent?: PolicyManagementParent | null,
): ParentDelegationCatalog {
  if (compiledRules.length > 32) throw new OwnerPolicyParentModelError("PARENT_MODEL_CATALOG_TOO_LARGE");
  const existing = new Map((currentParent?.delegation.outcomes ?? []).map((outcome) => [outcome.outcome, outcome]));
  const outcomes = compiledRules.map((rule) => {
    const prior = existing.get(rule.outcome);
    const reviewedFacts = prior?.compiled_plan_digest === rule.compiled_plan_digest
      ? prior.facts.filter((fact) => isVerifiedScalarFact(rule, fact))
      : [];
    const facts = [...reviewedFacts, ...generatedFacts(rule).filter((candidate) => !reviewedFacts.some(
      (reviewed) => canonicalJsonDigest(reviewed.source) === canonicalJsonDigest(candidate.source),
    ))];
    if (facts.length > 32) throw new OwnerPolicyParentModelError("PARENT_MODEL_CATALOG_TOO_LARGE");
    return {
      outcome: rule.outcome,
      compiled_plan_digest: rule.compiled_plan_digest,
      facts: structuredClone(facts),
      ...(prior?.compiled_plan_digest === rule.compiled_plan_digest && prior.require ? { require: structuredClone(prior.require) } : {}),
      allow_automatic_approval: prior?.compiled_plan_digest === rule.compiled_plan_digest ? prior.allow_automatic_approval : false,
      ...(prior?.compiled_plan_digest === rule.compiled_plan_digest && prior.budget_charges ? { budget_charges: structuredClone(prior.budget_charges) } : {}),
      effect_envelope: { operation: rule.effect_envelope.operation, target_resource: rule.effect_envelope.target_resource,
        ...(rule.effect_envelope.atomic_updates ? { atomic_updates: structuredClone(rule.effect_envelope.atomic_updates) } : {}),
        allowed_fields: structuredClone(rule.effect_envelope.allowed_fields), writeback: structuredClone(rule.effect_envelope.writeback) },
    };
  });
  const catalog = { outcomes };
  if (Buffer.byteLength(JSON.stringify(catalog), "utf8") > MAX_CATALOG_BYTES) throw new OwnerPolicyParentModelError("PARENT_MODEL_CATALOG_TOO_LARGE");
  return catalog;
}

/** Produces untrusted operator-review input only. It cannot activate, write a
 * store, or let a model alter trusted manager/owner/runtime bindings. */
export async function draftOperatorParentPolicy(input: {
  session: BoundaryJobPlanningSession;
  operatorMessage: string;
  currentParent: PolicyManagementParent | null;
  activeParent?: PolicyManagementParent | null;
  identityBindings: TrustedParentIdentityBindings;
  catalog?: ParentDelegationCatalog;
  compiledRules: CompiledActionRuleV1[];
  egressAcknowledged: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<ParentModelDraft> {
  const operatorMessage = boundedText(input.operatorMessage, "Operator message", MAX_MESSAGE);
  const bindings = structuredClone(input.identityBindings);
  const current = input.currentParent === null ? null : structuredClone(input.currentParent);
  const active = input.activeParent === undefined ? current : structuredClone(input.activeParent);
  const catalog = normalizeCatalog(input.catalog ?? buildOperatorParentCatalog(input.compiledRules, current), input.compiledRules);
  assertCurrentBindings(current, bindings);
  assertCurrentBindings(active, bindings);
  const prior = current?.delegation ?? null;
  const allowedAgents = [...new Set(bindings.agent_owners.map((entry) => entry.agent))].sort();
  const tools: AskToolDefinition[] = [{
    name: DRAFT_PARENT_TOOL,
    title: "Draft operator parent delegation",
    description: "Return one disabled-review candidate or one business clarification. This changes no authority.",
    input_schema: ownerPolicyParentModelJsonSchema(),
  }];
  const authorityDigest = askToolSurfaceDigest(tools);
  const configuration = providerConfiguration(input.session, authorityDigest, input.egressAcknowledged, input.env);
  const history = structuredClone(modelAuthoringHistory(input.session.conversation, input.session));
  const stableDigest = canonicalJsonDigest({ catalog, prior, active, bindings });
  let resolution: ParentModelDraft | undefined;
  let pendingResolution: ParentModelDraft | undefined;
  let issue = "PARENT_MODEL_DRAFT_REFUSED";
  let calls = 0;
  let correctionAttempt = false;
  const gateway: AskToolGateway = {
    mode: "authoring",
    listTools: () => tools,
    async callTool(name, args) {
      calls++;
      if (name !== DRAFT_PARENT_TOOL || calls > 2) return refused("Runner accepts one draft and one bounded correction only.");
      try {
        assertBoundedOwnerPolicyInput(args);
        const result = ownerPolicyParentModelResultSchema.parse(args);
        if (result.state === "clarification") {
          pendingResolution = { state: "clarification", question: boundedText(result.question, "Clarification", 600), correction_used: correctionAttempt,
            authority_granted: false, source_database_changed: false };
        } else {
          const parent = assembleParent(result.delegation, bindings, active, catalog, input.compiledRules);
          pendingResolution = { state: "candidate", parent, summary: boundedText(result.summary, "Candidate summary", 1_200), correction_used: correctionAttempt,
            authority_granted: false, source_database_changed: false };
        }
        return { ok: true, value: { state: pendingResolution.state, authority_granted: false, source_database_changed: false } };
      } catch (error) {
        if (isAuthoringGenerationStop(error)) throw error;
        issue = sanitizedIssue(error);
        return refused(issue);
      }
    },
    async close() {},
  };
  const baseQuestion = [
    "Draft one optional operator parent delegation for separate trusted human review.",
    `Operator request: ${JSON.stringify(operatorMessage)}`,
    `Verified Action catalog: ${JSON.stringify(catalog)}`,
    `Editable candidate delegation: ${JSON.stringify(prior)}`,
    `Currently activated delegation: ${JSON.stringify(active?.delegation ?? null)}`,
    "The current conversation is with the deployment operator, not a delegated owner. An unactivated candidate is editable, not an immutable parent ceiling. Correct its approval choice or unwanted candidate-only restriction when requested; do not make the operator restart. Catalog allow_automatic_approval is the starting setting, not a prohibition on an operator-reviewed change. Allowing inheritance never bypasses the compiled Action approval conditions or limits.",
    `Allowed delegable agent IDs: ${JSON.stringify(allowedAgents)}`,
    "Return exactly one structured tool result. You may change only delegation: delegable agents, outcomes, verified facts, predicates, approval posture, and bounded budgets.",
    "Use only the listed allowed agent IDs. Never create manager grants, owner-scope bindings, runtime bindings, credentials, identities, activation, a review approval, execution, writeback, SQL, or source changes. Those bindings are trusted local input and are not shown to you.",
    "Every compiled Action Rule eligibility check remains mandatory at runtime. An owner parent only adds restrictions; it never replaces or repeats compiled checks. Keeping an existing compiled availability, scope, or eligibility check requires no parent fact, predicate, or clarification. Ask only about an additional parent restriction the operator actually requests.",
    "Use only exact outcome names, compiled digests, fact names, sources, types, effect-envelope fields, and operators from the verified catalog. Facts marked ambiguous_label are verified but intentionally have only a raw qualified identifier; ask one concise human clarification before assigning a business title. If an operator request needs an unavailable business condition, ask one concise clarification instead of inventing a fact or bound.",
    "On a revision retain every activated delegated agent and every activated budget meter. Preserve candidate settings unless the operator asks to correct them. Preserve reviewed fact titles and operator sets by default; an operator may explicitly label an ambiguous raw identifier for root review. Do not silently remove caps or agents. This remains an untrusted candidate and grants no authority.",
    "Supported parent budget operations are effect_count and effect_field only. A budget is a positive bounded local window in reviewed integral units: effect_count uses unit effects; effect_field uses an exact allowed effect field with its reviewed integer or money-minor unit. Drafting starts with no runtime effect, reservation, or budget consumption; runtime evaluates only these reviewed effects after separate human review. No source query or execution occurs here.",
    `Call ${DRAFT_PARENT_TOOL} exactly once.`,
  ].join("\n");
  const run = (question: string) => runAskProviderTurn({ configuration, question, history, gateway, tools,
    signal: input.signal ?? new AbortController().signal, dependencies: input.session.dependencies, authorityDigest,
    providerSystemPrompt: "Produce one bounded operator parent delegation candidate through the required tool. Never invent verified facts, identity bindings, activation, or source-write authority.",
    skipRunnerQuestionContext: true, requiredInitialToolName: DRAFT_PARENT_TOOL, completeAfterRequiredTool: true,
    authorityGuard: () => canonicalJsonDigest({ catalog, prior, active, bindings }) === stableDigest ? authorityDigest : canonicalJsonDigest({ stale: true }),
  });
  try {
    for (let attempt = 0; attempt < 2 && !resolution; attempt++) {
      pendingResolution = undefined;
      correctionAttempt = attempt > 0;
      try {
        await run(attempt === 0 ? baseQuestion : [
          "Runner refused the first draft. This is the one bounded correction.",
          `Validation issue: ${issue}`,
          "Return one complete corrected candidate or one clarification. Do not add identity bindings or unverified facts.",
          baseQuestion,
        ].join("\n"));
        if (pendingResolution) {
          if (canonicalJsonDigest({ catalog, prior, active, bindings }) !== stableDigest) {
            throw new OwnerPolicyParentModelError("PARENT_MODEL_AUTHORITY_STALE");
          }
          resolution = pendingResolution;
          continue;
        }
        if (!isCorrectableDraftIssue(issue)) break;
      } catch (error) {
        if (isAuthoringGenerationStop(error)) throw error;
        issue = sanitizedIssue(error);
        pendingResolution = undefined;
        if (!isCorrectableDraftIssue(issue)) break;
      }
    }
  } finally { await gateway.close().catch(() => undefined); }
  if (!resolution) throw new OwnerPolicyParentModelError(issue);
  rememberModelAuthoringTurn(input.session.conversation, operatorMessage,
    resolution.state === "candidate" ? resolution.summary : resolution.question);
  return resolution;
}

function assembleParent(
  delegation: OwnerPolicyParent,
  bindings: TrustedParentIdentityBindings,
  current: PolicyManagementParent | null,
  catalog: ParentDelegationCatalog,
  rules: CompiledActionRuleV1[],
): PolicyManagementParent {
  assertPreservedRevisionFields(delegation, current?.delegation);
  assertKnownCatalog(delegation, catalog);
  for (const agent of delegation.agents) {
    if (!bindings.agent_owners.some((entry) => entry.agent === agent)) throw new OwnerPolicyParentModelError("PARENT_MODEL_AGENT_SCOPE_MISSING");
  }
  const assembled = policyManagementParentSchema.parse({ schema_version: "synapsor.policy-management-parent.v1", ...bindings, delegation });
  validateOwnerPolicyParent({ parent: assembled.delegation, rules });
  return structuredClone(assembled);
}

function assertCurrentBindings(current: PolicyManagementParent | null, bindings: TrustedParentIdentityBindings): void {
  if (!current) return;
  const currentBindings = { managers: current.managers, agent_owners: current.agent_owners, ...(current.runtime_delegations ? { runtime_delegations: current.runtime_delegations } : {}) };
  if (canonicalJsonDigest(currentBindings) !== canonicalJsonDigest(bindings)) throw new OwnerPolicyParentModelError("PARENT_MODEL_BINDINGS_STALE");
}

function assertPreservedRevisionFields(next: OwnerPolicyParent, previous: OwnerPolicyParent | undefined): void {
  if (!previous) return;
  for (const agent of previous.agents) if (!next.agents.includes(agent)) throw new OwnerPolicyParentModelError("PARENT_MODEL_AGENT_OMITTED");
  for (const budget of previous.budgets ?? []) {
    if (!next.budgets?.some((value) => value.meter === budget.meter)) throw new OwnerPolicyParentModelError("PARENT_MODEL_BUDGET_OMITTED");
  }
}

function normalizeCatalog(input: ParentDelegationCatalog, rules: CompiledActionRuleV1[]): ParentDelegationCatalog {
  const catalog = structuredClone(input);
  if (rules.length > 32 || !Array.isArray(catalog.outcomes) || catalog.outcomes.length > 32) throw new OwnerPolicyParentModelError("PARENT_MODEL_CATALOG_INVALID");
  if (Buffer.byteLength(JSON.stringify(catalog), "utf8") > MAX_CATALOG_BYTES) throw new OwnerPolicyParentModelError("PARENT_MODEL_CATALOG_TOO_LARGE");
  const compiled = new Map(rules.map((rule) => [rule.outcome, rule]));
  for (const entry of catalog.outcomes) {
    if (!Array.isArray(entry.facts) || entry.facts.length > 32) throw new OwnerPolicyParentModelError("PARENT_MODEL_CATALOG_INVALID");
    const rule = compiled.get(entry.outcome);
    if (!rule || rule.compiled_plan_digest !== entry.compiled_plan_digest) throw new OwnerPolicyParentModelError("PARENT_MODEL_CATALOG_STALE");
  }
  return catalog;
}

function generatedFacts(rule: CompiledActionRuleV1): CatalogFact[] {
  const inputs = (rule.rule.inputs ?? []).flatMap((input) => {
    if (!scalarKind(input.type.kind)) return [];
    const operators = operatorsFor(input.type.kind);
    const reviewedTitle = input.description.trim();
    const literalRange = numericInputRange(input.type.kind, input.minimum, input.maximum);
    return [{ name: input.name, title: reviewedTitle || `input.${input.name}`, source: { kind: "input" as const, name: input.name }, operators,
      ...(!reviewedTitle ? { ambiguous_label: true as const } : {}),
      ...(literalRange ? { literal_range: literalRange } : {}),
      ...(input.type.kind === "string" && input.type.enum ? { literal_values: [...input.type.enum] } : {}) }];
  });
  const derived = Object.entries(rule.derived_types).flatMap(([name, type]) => scalarKind(type.kind) ? [{
    name: `derived.${name}`, title: `derived.${name}`, source: { kind: "derived" as const, name },
    operators: operatorsFor(type.kind), ambiguous_label: true as const,
  }] : []);
  const fields = rule.bindings.flatMap((binding) => binding.verification.cardinality === "one"
    ? binding.verification.fields.flatMap((field) => scalarKind(field.type.kind) ? [{
      name: `${binding.binding}.${field.name}`, title: `${binding.binding}.${field.name}`,
      source: { kind: "field" as const, binding: binding.binding, field: field.name }, operators: operatorsFor(field.type.kind), ambiguous_label: true as const,
      ...(field.type.kind === "string" && field.type.enum ? { literal_values: [...field.type.enum] } : {}),
    }] : [])
    : []);
  return [...inputs, ...derived, ...fields, trustedTimeFact()];
}

function numericInputRange(kind: string, minimum: unknown, maximum: unknown): { minimum: number; maximum: number } | undefined {
  return (kind === "integer" || kind === "money_minor")
    && typeof minimum === "number" && typeof maximum === "number"
    && Number.isSafeInteger(minimum) && Number.isSafeInteger(maximum) && minimum <= maximum
    ? { minimum, maximum }
    : undefined;
}

function trustedTimeFact(): CatalogFact {
  return {
    name: "current_time",
    title: "Current time",
    source: { kind: "trusted", binding: "transaction_time" },
    operators: ["eq", "neq", "lt", "lte", "gt", "gte", "is_present"],
  };
}

function isVerifiedScalarFact(rule: CompiledActionRuleV1, fact: OwnerPolicyFact): boolean {
  const kind = verifiedFactType(rule, fact);
  return kind !== undefined && scalarKind(kind);
}

function verifiedFactType(rule: CompiledActionRuleV1, fact: OwnerPolicyFact): string | undefined {
  const source = fact.source;
  if (source.kind === "trusted") return "timestamp";
  if (source.kind === "input" && "name" in source) {
    return rule.rule.inputs?.find((input) => input.name === source.name)?.type.kind;
  }
  if (source.kind === "derived" && "name" in source) return rule.derived_types[source.name]?.kind;
  if (source.kind === "field" && "binding" in source && "field" in source) {
    const binding = rule.bindings.find((entry) => entry.binding === source.binding);
    return binding?.verification.cardinality === "one"
      ? binding.verification.fields.find((field) => field.name === source.field)?.type.kind
      : undefined;
  }
  return undefined;
}

function scalarKind(kind: string): boolean { return ["integer", "money_minor", "string", "boolean", "date", "timestamp"].includes(kind); }
function operatorsFor(kind: string): OwnerPolicyFact["operators"] {
  if (kind === "boolean") return ["eq", "neq", "one_of"];
  if (kind === "string") return ["eq", "neq", "one_of"];
  if (kind === "date" || kind === "timestamp") return ["eq", "neq", "lt", "lte", "gt", "gte", "is_present"];
  return ["eq", "neq", "lt", "lte", "gt", "gte"];
}

function assertKnownCatalog(candidate: OwnerPolicyParent, catalog: ParentDelegationCatalog): void {
  const outcomes = new Map(catalog.outcomes.map((entry) => [entry.outcome, entry]));
  for (const outcome of candidate.outcomes) {
    const known = outcomes.get(outcome.outcome);
    if (!known || known.compiled_plan_digest !== outcome.compiled_plan_digest) throw new OwnerPolicyParentModelError("PARENT_MODEL_OUTCOME_UNKNOWN");
    const facts = new Map<string, CatalogFact>(known.facts.map((fact) => [fact.name, fact]));
    for (const fact of outcome.facts) {
      const allowed = facts.get(fact.name);
      if (!allowed || canonicalJsonDigest(fact.source) !== canonicalJsonDigest(allowed.source)
        || fact.operators.some((operator) => !allowed.operators.includes(operator))) {
        throw new OwnerPolicyParentModelError("PARENT_MODEL_FACT_UNKNOWN");
      }
      if (!withinLiteralRange(fact.literal_range, allowed.literal_range)
        || !withinLiteralValues(fact.literal_values, allowed.literal_values)) {
        throw new OwnerPolicyParentModelError("PARENT_MODEL_FACT_BOUND_UNKNOWN");
      }
    }
  }
}

function withinLiteralRange(
  candidate: OwnerPolicyFact["literal_range"],
  allowed: OwnerPolicyFact["literal_range"],
): boolean {
  // No existing literal restriction means the operator may introduce one.
  // This is parent drafting; compiled field/type/effect checks still apply.
  if (!allowed) return true;
  return candidate !== undefined && candidate.minimum >= allowed.minimum && candidate.maximum <= allowed.maximum;
}

function withinLiteralValues(
  candidate: OwnerPolicyFact["literal_values"],
  allowed: OwnerPolicyFact["literal_values"],
): boolean {
  if (!allowed) return true;
  return candidate !== undefined && candidate.every((value) => allowed.some((known) => canonicalJsonDigest(value) === canonicalJsonDigest(known)));
}

function providerConfiguration(session: BoundaryJobPlanningSession, authorityDigest: `sha256:${string}`, egressAcknowledged: boolean, env?: NodeJS.ProcessEnv) {
  const defaultKeyEnv = session.provider === "openai_compatible" ? undefined : defaultProviderKeyEnv(session.provider);
  return resolveAskProviderConfiguration({ provider: session.provider, model: session.model,
    ...(session.baseUrl ? { base_url: session.baseUrl } : {}), ...(session.apiKey ? { api_key: session.apiKey }
      : session.apiKeyEnv ?? defaultKeyEnv ? { api_key_env: session.apiKeyEnv ?? defaultKeyEnv } : {}),
    authority_digest: authorityDigest, egress_acknowledged: egressAcknowledged, request_timeout_seconds: authoringRequestTimeoutSeconds(), max_output_tokens: 6_000,
  }, env ?? process.env, new Date());
}

function boundedText(value: unknown, label: string, maximum: number): string {
  const normalized = typeof value === "string" ? value.trim().replace(/\r\n?/gu, "\n") : "";
  if (!normalized || normalized.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new OwnerPolicyParentModelError("PARENT_MODEL_INPUT_INVALID");
  }
  return normalized;
}
function sanitizedIssue(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^([A-Z]+_){1,8}[A-Z]+$/u.test(code) ? code : "PARENT_MODEL_DRAFT_INVALID";
}
function isCorrectableDraftIssue(code: string): boolean {
  return code === "ASK_REQUIRED_TOOL_NOT_CALLED"
    || code === "ASK_PROVIDER_RESPONSE_INVALID"
    || code === "ASK_TOOL_ARGUMENTS_INVALID"
    || code === "PARENT_MODEL_DRAFT_INVALID"
    || code === "PARENT_MODEL_FACT_UNKNOWN"
    || code === "PARENT_MODEL_FACT_BOUND_UNKNOWN"
    || code === "PARENT_MODEL_OUTCOME_UNKNOWN"
    || code === "PARENT_MODEL_AGENT_SCOPE_MISSING"
    || code === "PARENT_MODEL_AGENT_OMITTED"
    || code === "PARENT_MODEL_BUDGET_OMITTED"
    || code.startsWith("OWNER_POLICY_");
}
function refused(message: string): Awaited<ReturnType<AskToolGateway["callTool"]>> {
  return { ok: false, value: { error_code: "PARENT_MODEL_DRAFT_REFUSED", message, authority_granted: false, source_database_changed: false },
    error_code: "PARENT_MODEL_DRAFT_REFUSED" };
}
import { defaultProviderKeyEnv } from "./hosted-provider-settings.js";
