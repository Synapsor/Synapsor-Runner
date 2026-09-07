import { expect, it } from "vitest";
import { narrateValidatedAuthoringStep } from "./model-authoring-narration.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";

it.each(["short", "verbose", "two_questions", "provider_failure"])("keeps clarification focused with %s narration", async (kind) => {
  let body = "";
  const question = "Should customers see when their support case was last updated, or keep that date internal?";
  const response = kind === "short" ? question : kind === "two_questions" ? `${question} Why?` : `${"The action remains disabled. ".repeat(15)}${question}`;
  const result = await narrateValidatedAuthoringStep({
    session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", conversation: createModelAuthoringConversation(),
      dependencies: { requestJson: async (request) => {
        body = JSON.stringify(request.body);
        if (kind === "provider_failure") throw new Error("Provider unavailable");
        return { status: 200, body: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: response }] }] } };
      } } }, egressAcknowledged: true, responseStyle: "clarification",
    operatorMessage: "Ask the missing business meaning only.",
    validatedFacts: ["The saved action is unchanged. The policy permits relevant customer dates but excludes internal revision markers. The meaning of support_cases.updated_at needs clarification."],
    nextQuestion: "Confirm whether support_cases.updated_at is an internal record-revision marker. If yes, revise Read; if no, record customer-facing use.",
  });
  expect(body).toContain("Ask exactly ONE short business question");
  expect(result).toBe(kind === "short" ? question : undefined);
});
