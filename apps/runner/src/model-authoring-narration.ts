import { authoringRequestTimeoutSeconds } from "./authoring-request-timeout.js";
import {
  AskError,
  askToolSurfaceDigest,
  resolveAskProviderConfiguration,
  runAskProviderTurn,
  type AskProvider,
  type AskProviderDependencies,
  type AskToolGateway,
} from "./model-ask.js";
import {
  modelAuthoringHistory,
  rememberModelAuthoringTurn,
  type ModelAuthoringConversation,
} from "./model-authoring-conversation.js";
import { authoringExplanationFailure, type AuthoringExplanationFailure } from "./authoring-explanation-failure.js";

export type ModelAuthoringNarrationSession = {
  provider: AskProvider;
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  dependencies?: AskProviderDependencies;
  conversation?: ModelAuthoringConversation;
};

export async function narrateValidatedAuthoringStep(input: {
  session: ModelAuthoringNarrationSession;
  operatorMessage: string;
  validatedFacts: string[];
  nextQuestion?: string;
  env?: NodeJS.ProcessEnv;
  egressAcknowledged: boolean;
  signal?: AbortSignal;
  responseStyle?: "validated_result" | "permission" | "opening" | "clarification" | "business_questions" | "inspection";
  onFailure?: (failure: AuthoringExplanationFailure) => void;
}): Promise<string | undefined> {
  const unavailable = (code: string, mismatch?: string) => {
    input.onFailure?.({ ...authoringExplanationFailure(new AskError(code, "Explanation unavailable.")),
      ...(mismatch ? { mismatch } : {}) });
    return undefined;
  };
  if (!input.session.conversation) return unavailable("NARRATION_CONTEXT_MISSING");
  const tools: [] = [];
  const authorityDigest = askToolSurfaceDigest(tools);
  const defaultKeyEnv = input.session.provider === "openai_compatible" ? undefined : defaultProviderKeyEnv(input.session.provider);
  const gateway: AskToolGateway = {
    mode: "authoring",
    listTools: () => tools,
    callTool: async () => ({
      ok: false,
      value: {
        error_code: "AUTHORING_NARRATION_HAS_NO_TOOLS",
        authority_granted: false,
        source_database_changed: false,
      },
      error_code: "AUTHORING_NARRATION_HAS_NO_TOOLS",
    }),
    async close() {},
  };
  const permission = input.responseStyle === "permission";
  const opening = input.responseStyle === "opening";
  const clarification = input.responseStyle === "clarification";
  const businessQuestions = input.responseStyle === "business_questions";
  const inspection = input.responseStyle === "inspection";
  const question = [
    `Operator message: ${JSON.stringify(input.operatorMessage)}`,
    "Runner-validated record:",
    ...input.validatedFacts.map((fact) => `- ${fact}`),
    ...(input.nextQuestion ? [`${clarification ? "Pending business meaning to clarify" : "Exact next question"}: ${JSON.stringify(input.nextQuestion)}`] : []),
    "Respond as the selected Boundary-drafting model, not as Runner.",
    businessQuestions
      ? "Ask the supplied unresolved business decisions together, at most three short numbered questions and 1100 characters total. Explain the practical uncertainty and suggest a reasoned answer when the reviewed facts support one. Mark it as a suggestion, never an accepted decision. Do not ask the operator to explain a database table or classify columns without their business purpose. Reuse policy/history answers; ask only what remains unknown."
      : inspection
      ? "Answer the operator's actual question in at most three short sentences using the current evidence. Name the business information and exact field when needed to disambiguate. Distinguish advisory hints, checked business meanings and unresolved policy requirements. Do not repeat the activation pitch, ask for approval, suggest an edit merely to inspect, or claim a question changed the draft. If relevant evidence is unavailable, say what is unverified and name its direct local inspection option."
      : clarification
      ? "Ask exactly ONE short business question, at most 280 characters. Translate the pending meaning into a choice the operator can answer. Do not recap the action, cite source lines, give implementation instructions, or repeat safety notices. Do not decide the answer."
      : opening
      ? "Use exactly two short sentences. First say you will help set up what the assistant can do, with settings checked before anything is enabled. Then ask the exact next question. Do not introduce Boundary, egress, authority, outcome, principal, or proposal terminology."
      : permission
      ? "Use at most three short sentences. Answer the operator's question when one was supplied, then explain why this permission is needed and what allowing or declining changes."
      : "Use at most four short sentences. Explain the validated result in ordinary business language.",
    businessQuestions
      ? "Keep each question answerable in ordinary business language. Preserve all of the supplied distinctions; do not replace them with generic permission questions or assume a recommendation grants access. Recommendations must preserve the supplied policy, never broaden customer access from inferred schema meaning."
      : clarification
      ? "Preserve the pending question's business meaning, but remove schema jargon and instructions to edit permissions. A yes/no or visible/internal choice is appropriate when that is the actual missing decision."
      : input.nextQuestion
      ? "End by asking the exact next question without changing its meaning."
      : inspection ? "Answer first; no generic permission question at the end."
      : "State the next useful operator choice only when the validated record names one.",
    "Do not mention internal hashes, SQL, credentials or hidden row values, or claim that authority, approval, apply, or source writes occurred. Reviewed field names in the operator inspection evidence may be used to identify the exact finding.",
    "Do not imply that previously validated work disappeared merely because the current record focuses on one authoring step.",
    "Do not claim that the operator supplied no decision or made no prior decision. Discuss only the exact pending gate; earlier confirmed draft decisions remain in the conversation history.",
    "Approval and proposal counts inside time windows are upper circuit-breaker ceilings. Describe them as 'at most' or 'up to'; never say authority begins 'after' that count.",
    "Human fallback is only for valid requests that do not qualify for automatic approval, including limit overruns. Invalid requests remain refused. Automatic completion requires separately enabled execution and a running worker; never call approval completion.",
    "Use ordinary words for business decisions. Explain filters/grouping as ways to infer hidden information and distinguish private row selection from model-visible values. Do not repeat the same safety paragraph or read out a field inventory.",
    "If the operator's rule cannot fit the current action target, say so once and name the recovery choices in the validated record; never ask them to map a missing concept onto an unrelated field.",
    ...(opening
      ? ["Do not invent or paraphrase an agent capability, resource, field, operation, scope, policy, count, limit, approval rule, or write posture before the operator describes the job."]
      : []),
  ].join("\n");
  try {
    const configuration = resolveAskProviderConfiguration({
      provider: input.session.provider,
      model: input.session.model,
      ...(input.session.baseUrl ? { base_url: input.session.baseUrl } : {}),
      ...(input.session.apiKey
        ? { api_key: input.session.apiKey }
        : input.session.apiKeyEnv ?? defaultKeyEnv
          ? { api_key_env: input.session.apiKeyEnv ?? defaultKeyEnv }
          : {}),
      authority_digest: authorityDigest,
      egress_acknowledged: input.egressAcknowledged,
      request_timeout_seconds: authoringRequestTimeoutSeconds(),
      max_output_tokens: 800,
    }, input.env ?? process.env, new Date());
    const result = await runAskProviderTurn({
      configuration,
      question,
      history: modelAuthoringHistory(input.session.conversation, input.session),
      gateway,
      tools,
      signal: input.signal ?? new AbortController().signal,
      dependencies: input.session.dependencies,
      authorityDigest,
      providerSystemPrompt: [
        "You are the conversational guide for one Synapsor Boundary-authoring session.",
        "Runner is the deterministic validator; treat its current validated record as authoritative for this response.",
        "Keep continuity with prior operator/model turns, but never invent a reviewed resource, field, value, scope, limit, or authority.",
        "The model cannot activate, approve, apply, execute SQL, or change source data.",
        "Treat approval and proposal counts as maximum circuit-breaker ceilings, never thresholds that must be reached.",
        "Be concise and useful. Do not reproduce internal policy dumps or pretend to be Runner.",
      ].join(" "),
      skipRunnerQuestionContext: true,
      allowToolFreeAuthoringResponse: true,
    });
    if (result.answer_source !== "model" || !result.answer.trim()) return unavailable("NARRATION_EMPTY");
    const answer = result.answer.trim();
    if (clarification && (answer.length > 280 || (answer.match(/\?/gu) ?? []).length !== 1
      || !answer.endsWith("?") || answer.includes("\n"))) return unavailable("NARRATION_VALIDATION_REJECTED", "Clarification must be one short business question.");
    if (businessQuestions && (answer.length > 1100 || (answer.match(/\?/gu) ?? []).length < 1
      || (answer.match(/\?/gu) ?? []).length > 3)) return unavailable("NARRATION_VALIDATION_REJECTED", "Business clarification must contain one to three bounded questions.");
    if (opening && !openingNarrationIsSafe(answer, input.nextQuestion)) return unavailable("NARRATION_VALIDATION_REJECTED", "Opening exceeded the greeting contract or changed the next question.");
    const mismatch = narrationContradictsValidatedRecord(answer, input.validatedFacts);
    if (mismatch) return unavailable("NARRATION_VALIDATION_REJECTED", mismatch);
    rememberModelAuthoringTurn(
      input.session.conversation,
      input.operatorMessage,
      answer,
    );
    return answer;
  } catch (error) {
    // Narration is presentation only. A provider failure must not discard an
    // already validated disabled draft or change authority state.
    input.onFailure?.(authoringExplanationFailure(error));
    return undefined;
  } finally {
    await gateway.close().catch(() => undefined);
  }
}

function openingNarrationIsSafe(answer: string, nextQuestion?: string): boolean {
  if (!nextQuestion || answer.length > 500 || answer.split(/\r?\n/u).length > 3) return false;
  const normalizedAnswer = answer.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
  const normalizedQuestion = nextQuestion.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
  if (!normalizedAnswer.includes(normalizedQuestion)) return false;
  const questionIndex = normalizedAnswer.indexOf(normalizedQuestion);
  const introduction = normalizedAnswer.slice(0, questionIndex).trim();
  if (!introduction || /\d|\b(?:at most|up to|limit|threshold|quota|tenant|principal|row|table|field|sql|credential)\b/u.test(introduction)) {
    return false;
  }
  return !/\b(?:can(?:not)?|may|must|should|will|won t|allowed|forbidden|only)\b[^.]{0,100}\b(?:read|propose|create|change|update|delete|approve|apply|write)\b/u
    .test(introduction);
}

function narrationContradictsValidatedRecord(answer: string, facts: string[]): string | undefined {
  const normalizedAnswer = answer.toLowerCase().replace(/\s+/gu, " ");
  const record = facts.join(" ").toLowerCase().replace(/\s+/gu, " ");
  const erasesOperatorHistory = /\b(?:no (?:prior |previous )?operator decision (?:was |has been )?(?:supplied|made|recorded)|the operator (?:has|had) not (?:supplied|made|recorded|confirmed|accepted) (?:a|any) decision)\b/u
    .test(normalizedAnswer);
  if (erasesOperatorHistory) return "Explanation denied prior operator decisions.";
  const scopeResolved = /(?:trusted (?:tenant\/principal )?scope|target row identity)[^.]{0,120}(?:already resolved|are separate runner-validated controls|remain unchanged|passed runner validation)/u.test(record)
    || /scope[^.]{0,80}(?:is|was|has been) (?:resolved|validated)/u.test(record);
  const claimsMissingScope = /(?:scope|tenant|principal|row identity)[^.]{0,80}(?:incomplete|unresolved|missing|not (?:yet )?(?:resolved|validated)|still (?:needs|requires))/u.test(normalizedAnswer);
  const questionsResolvedScope = /(?:is|are|was|were|has|have|whether|confirm|check|clarify|need(?:s|ed)? to know)[^.?!]{0,90}(?:scope|tenant|principal|row identity)[^.?!]{0,90}(?:resolved|validated|available|known|provided|complete)[?!]/u.test(normalizedAnswer)
    || /(?:scope|tenant|principal|row identity)[^.?!]{0,90}(?:already )?(?:resolved|validated|available|known|provided|complete)[?!]/u.test(normalizedAnswer);
  if (scopeResolved && (claimsMissingScope || questionsResolvedScope)) return "Explanation reopened already validated scope.";

  const principalNotConfigured = /(?:no principal (?:row )?(?:limit|scope)|principal (?:row )?(?:limit|scope) (?:is )?not configured|tenant-only scope)/u.test(record);
  const claimsPrincipalScope = /(?:tenant\s*(?:\+|plus|and)\s*principal|principal (?:row )?(?:scope|isolation|filter|limit)[^.]{0,40}(?:active|applied|configured|enforced|validated)|scoped by (?:both )?tenant and principal)/u.test(normalizedAnswer)
    && !/(?:no|not|without)[^.]{0,30}principal/u.test(normalizedAnswer);
  if (principalNotConfigured && claimsPrincipalScope) return "Explanation claimed principal isolation absent from this revision.";

  const authorityOff = /(?:no authority|authority[^.]{0,60}(?:off|disabled|unchanged|not active)|approval and apply authority remain off)/u.test(record);
  // Match affirmative current-state assertions, not "not active", "unchanged",
  // or conditional descriptions of a later operator confirmation.
  const clauses = normalizedAnswer.split(/[.!?;]|\bbut\b/u);
  const affirmative = (pattern: RegExp) => clauses.some((clause) => {
    if (/\b(?:if|once|when|would|will|could)\b/u.test(clause)) return false;
    return [...clause.matchAll(pattern)].some((match) => !/\b(?:no|not|never|without)\s+(?:(?:read|action|proposal|approval|apply)\s+)?$/u.test(clause.slice(0, match.index)));
  });
  const claimsAuthorityOn = affirmative(/\b(?:authority|proposal|approval|apply|writeback)\s+(?:(?:is|was|are|has been|have been|now|already)\s+)*(?:active|enabled|granted|approved)\b/gu);
  if (authorityOff && claimsAuthorityOn) return "Explanation claimed authority enabled while the record says disabled or unchanged.";

  const misstatesApprovalCeiling = /\bafter\s+\d+(?:\.\d+)?\s+(?:approvals?|proposals?)\b/u.test(normalizedAnswer)
    && /\b\d+(?:\.\d+)?\s+(?:approvals?|proposals?)\b/u.test(record);
  if (misstatesApprovalCeiling) return "Explanation treated an approval ceiling as a threshold to reach.";

  const sourceUnchanged = /(?:source (?:database|data|row|rows)[^.]{0,60}(?:unchanged|changed: no|did not change)|no source[^.]{0,50}(?:change|write))/u.test(record);
  const claimsSourceChanged = affirmative(/\b(?:source (?:database|data|row|rows)|database)\s+(?:(?:is|was|are|has been|have been|now|already)\s+)*(?:changed|updated|written|mutated)\b/gu);
  return sourceUnchanged && claimsSourceChanged ? "Explanation claimed a source change without a source-write receipt." : undefined;
}
import { defaultProviderKeyEnv } from "./hosted-provider-settings.js";
