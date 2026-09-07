import type { AskHistoryTurn } from "./model-ask.js";
import { policySourceHistory, type PolicySourceSession, type AuthoringDestination } from "./authoring-policy-source.js";

const MAX_AUTHORING_HISTORY_TURNS = 16;
const MAX_AUTHORING_HISTORY_CHARS = 32_768;

export type ModelAuthoringConversation = {
  turns: AskHistoryTurn[];
  policySources?: PolicySourceSession;
};

export function createModelAuthoringConversation(
  initialTurns: readonly AskHistoryTurn[] = [],
): ModelAuthoringConversation {
  const conversation: ModelAuthoringConversation = { turns: [] };
  for (const turn of initialTurns) {
    if (turn.kind === undefined) rememberModelAuthoringTurn(conversation, turn.question, turn.answer);
    else if (turn.kind === "clarification") rememberModelAuthoringClarification(conversation, turn.question, turn.answer);
    else throw new Error("AUTHORING_CONVERSATION_INVALID: unsupported conversation turn kind.");
  }
  return conversation;
}

export function modelAuthoringHistory(
  conversation: ModelAuthoringConversation | undefined,
  destination?: AuthoringDestination,
): AskHistoryTurn[] {
  return [...policySourceHistory(conversation?.policySources, destination), ...(conversation?.turns.map((turn) => ({ ...turn })) ?? [])];
}

export function rememberModelAuthoringTurn(
  conversation: ModelAuthoringConversation | undefined,
  question: string,
  answer: string,
): void {
  rememberAuthoringTurn(conversation, question, answer);
}

/** Retain a model question followed by the operator's direct clarification. */
export function rememberModelAuthoringClarification(
  conversation: ModelAuthoringConversation | undefined,
  question: string,
  answer: string,
): void {
  rememberAuthoringTurn(conversation, question, answer, "clarification");
}

function rememberAuthoringTurn(
  conversation: ModelAuthoringConversation | undefined,
  question: string,
  answer: string,
  kind?: "clarification",
): void {
  if (!conversation) return;
  const normalizedQuestion = boundedConversationText(question, 4_000);
  const normalizedAnswer = boundedConversationText(answer, 8_000);
  if (!normalizedQuestion || !normalizedAnswer) return;
  conversation.turns.push({
    question: normalizedQuestion,
    answer: normalizedAnswer,
    ...(kind ? { kind } : {}),
  });
  while (conversation.turns.length > MAX_AUTHORING_HISTORY_TURNS
    || conversationSize(conversation.turns) > MAX_AUTHORING_HISTORY_CHARS) {
    conversation.turns.shift();
  }
}

function conversationSize(turns: AskHistoryTurn[]): number {
  return turns.reduce(
    (total, turn) => total + turn.question.length + turn.answer.length,
    0,
  );
}

function boundedConversationText(value: string, maximum: number): string {
  const normalized = value.trim().replace(/\r\n?/gu, "\n");
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, Math.max(1, maximum - 1))}…`;
}
