import {
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
  responseStyle?: "validated_result" | "permission";
}): Promise<string | undefined> {
  if (!input.session.conversation) return undefined;
  const tools: [] = [];
  const authorityDigest = askToolSurfaceDigest(tools);
  const defaultKeyEnv = input.session.provider === "openai"
    ? "OPENAI_API_KEY"
    : input.session.provider === "anthropic"
      ? "ANTHROPIC_API_KEY"
      : undefined;
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
    request_timeout_seconds: 120,
    max_output_tokens: 800,
  }, input.env ?? process.env, new Date());
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
  const question = [
    `Operator message: ${JSON.stringify(input.operatorMessage)}`,
    "Runner-validated record:",
    ...input.validatedFacts.map((fact) => `- ${fact}`),
    ...(input.nextQuestion ? [`Exact next question: ${JSON.stringify(input.nextQuestion)}`] : []),
    "Respond as the selected Boundary-drafting model, not as Runner.",
    permission
      ? "Use at most three short sentences. Answer the operator's question when one was supplied, then explain why this permission is needed and what allowing or declining changes."
      : "Use at most four short sentences. Explain the validated result in ordinary business language.",
    input.nextQuestion
      ? "End by asking the exact next question without changing its meaning."
      : "State the next useful operator choice only when the validated record names one.",
    "Do not mention internal hashes, SQL, credentials, hidden fields, or claim that authority, approval, apply, or source writes occurred.",
    "Do not imply that previously validated work disappeared merely because the current record focuses on one authoring step.",
    "If the operator's rule cannot fit the current action target, say so once and name the recovery choices in the validated record; never ask them to map a missing concept onto an unrelated field.",
  ].join("\n");
  try {
    const result = await runAskProviderTurn({
      configuration,
      question,
      history: modelAuthoringHistory(input.session.conversation),
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
        "Be concise and useful. Do not reproduce internal policy dumps or pretend to be Runner.",
      ].join(" "),
      skipRunnerQuestionContext: true,
      allowToolFreeAuthoringResponse: true,
    });
    if (result.answer_source !== "model" || !result.answer.trim()) return undefined;
    const answer = result.answer.trim();
    if (narrationContradictsValidatedRecord(answer, input.validatedFacts)) return undefined;
    rememberModelAuthoringTurn(
      input.session.conversation,
      input.operatorMessage,
      answer,
    );
    return answer;
  } catch {
    // Narration is presentation only. A provider failure must not discard an
    // already validated disabled draft or change authority state.
    return undefined;
  } finally {
    await gateway.close().catch(() => undefined);
  }
}

function narrationContradictsValidatedRecord(answer: string, facts: string[]): boolean {
  const normalizedAnswer = answer.toLowerCase().replace(/\s+/gu, " ");
  const record = facts.join(" ").toLowerCase().replace(/\s+/gu, " ");
  const scopeResolved = /(?:trusted (?:tenant\/principal )?scope|target row identity)[^.]{0,120}(?:already resolved|are separate runner-validated controls|remain unchanged|passed runner validation)/u.test(record)
    || /scope[^.]{0,80}(?:is|was|has been) (?:resolved|validated)/u.test(record);
  const claimsMissingScope = /(?:scope|tenant|principal|row identity)[^.]{0,80}(?:incomplete|unresolved|missing|not (?:yet )?(?:resolved|validated)|still (?:needs|requires))/u.test(normalizedAnswer);
  const questionsResolvedScope = /(?:is|are|was|were|has|have|whether|confirm|check|clarify|need(?:s|ed)? to know)[^.?!]{0,90}(?:scope|tenant|principal|row identity)[^.?!]{0,90}(?:resolved|validated|available|known|provided|complete)[?!]/u.test(normalizedAnswer)
    || /(?:scope|tenant|principal|row identity)[^.?!]{0,90}(?:already )?(?:resolved|validated|available|known|provided|complete)[?!]/u.test(normalizedAnswer);
  if (scopeResolved && (claimsMissingScope || questionsResolvedScope)) return true;

  const authorityOff = /(?:no authority|authority[^.]{0,60}(?:off|disabled|unchanged|not active)|approval and apply authority remain off)/u.test(record);
  const claimsAuthorityOn = (/(?:(?:read|action|proposal|approval|apply) )?authority[^.]{0,40}(?:active|enabled|granted|approved)/u.test(normalizedAnswer)
    || /(?:proposal|approval|apply|writeback)[^.]{0,30}(?:is|was|has been) (?:active|enabled|granted|approved)/u.test(normalizedAnswer))
    && !/(?:no|not|never|without)[^.]{0,30}(?:authority|proposal|approval|apply|writeback)[^.]{0,30}(?:active|enabled|granted|approved)/u.test(normalizedAnswer);
  if (authorityOff && claimsAuthorityOn) return true;

  const sourceUnchanged = /(?:source (?:database|data|row|rows)[^.]{0,60}(?:unchanged|changed: no|did not change)|no source[^.]{0,50}(?:change|write))/u.test(record);
  const claimsSourceChanged = /(?:source (?:database|data|row|rows)|database)[^.]{0,50}(?:changed|updated|written|mutated)/u.test(normalizedAnswer)
    && !/(?:not|no|never|without)[^.]{0,24}(?:changed|updated|written|mutated)/u.test(normalizedAnswer);
  return sourceUnchanged && claimsSourceChanged;
}
