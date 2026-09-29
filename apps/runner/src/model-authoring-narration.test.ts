import { localProviderRefusal } from "./test-fixtures/provider-refusal.js";
import { AskError } from "./model-ask.js";
import { expect, it } from "vitest";
import { narrateValidatedAuthoringStep } from "./model-authoring-narration.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";

it.each([1, 2, 3, 4])("groups at most three genuine business questions with non-authorizing suggestions (%s)", async (count) => {
  let body = "";
  const answer = Array.from({ length: count }, (_, i) => `${i + 1}. I suggest keeping the internal date private because it tracks edits. Should customers see that date?`).join("\n");
  const result = await narrateValidatedAuthoringStep({
    session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", conversation: createModelAuthoringConversation(),
      dependencies: { requestJson: async (request) => {
        body = JSON.stringify(request.body);
        return { status: 200, body: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] }] } };
      } } }, egressAcknowledged: true, responseStyle: "business_questions", operatorMessage: "Ask the unanswered date meanings together.",
    validatedFacts: ["Internal revision dates need a business visibility decision; no authority changed."],
    nextQuestion: "Should these dates be private?",
  });
  expect(body).toContain("at most three short numbered questions");
  expect(body).toContain("never an accepted decision");
  expect(result).toBe(count <= 3 ? answer : undefined);
});

it("answers an inspection question from exact evidence without pitching activation or changing anything", async () => {
  let body = "";
  const response = "The finding is the support-case update date (telecom.support_cases.updated_at). Your checked customer-facing interpretation already addresses that naming hint; access is unchanged.";
  const result = await narrateValidatedAuthoringStep({
    session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", conversation: createModelAuthoringConversation(),
      dependencies: { requestJson: async (request) => {
        body = JSON.stringify(request.body);
        return { status: 200, body: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: response }] }] } };
      } } }, egressAcknowledged: true, responseStyle: "inspection",
    operatorMessage: "Which field was flagged? Don't change the draft.",
    validatedFacts: ["telecom.support_cases.updated_at: raw visible; checked business meaning is customer-facing date. No permission changed."],
  });
  expect(result).toBe(response);
  expect(body).toContain("Do not repeat the activation pitch");
  expect(body).toContain("telecom.support_cases.updated_at");
  expect(body).not.toContain("Exact next question:");
});

it.each(["short", "verbose", "two_questions", "provider_failure"])("keeps clarification focused with %s narration", async (kind) => {
  let body = "";
  const question = "Should customers see when their support case was last updated, or keep that date internal?";
  const response = kind === "short" ? question : kind === "two_questions" ? `${question} Why?` : `${"The action remains disabled. ".repeat(15)}${question}`;
  const result = await narrateValidatedAuthoringStep({
    session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", conversation: createModelAuthoringConversation(),
      dependencies: { requestJson: async (request) => {
        body = JSON.stringify(request.body);
        if (kind === "provider_failure") return localProviderRefusal(request);
        return { status: 200, body: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: response }] }] } };
      } } }, egressAcknowledged: true, responseStyle: "clarification",
    operatorMessage: "Ask the missing business meaning only.",
    validatedFacts: ["The saved action is unchanged. The policy permits relevant customer dates but excludes internal revision markers. The meaning of support_cases.updated_at needs clarification."],
    nextQuestion: "Confirm whether support_cases.updated_at is an internal record-revision marker. If yes, revise Read; if no, record customer-facing use.",
  });
  expect(body).toContain("Ask exactly ONE short business question");
  expect(result).toBe(kind === "short" ? question : undefined);
});

it("propagates a transport inspection stop instead of silently continuing the producer",async()=>{
  const failure=new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION","DERIVED interrupted response");let calls=0,diagnostic:unknown;
  await expect(narrateValidatedAuthoringStep({session:{provider:"openai",model:"gpt-test",apiKey:"memory-key",conversation:createModelAuthoringConversation(),
    dependencies:{requestJson:async()=>{calls++;throw failure;}}},egressAcknowledged:true,responseStyle:"inspection",operatorMessage:"Explain the saved draft.",
    validatedFacts:["Saved work is pending; authority unchanged."],onFailure:d=>{diagnostic=d;}})).rejects.toBe(failure);
  expect(calls).toBe(1);expect(diagnostic).toMatchObject({code:failure.code,retryable:false});
});

it("unknown provider failure stops narration instead of treating it as optional prose", async () => {
  let calls = 0;
  await expect(narrateValidatedAuthoringStep({ session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", conversation: createModelAuthoringConversation(),
    dependencies: { requestJson: async () => { calls++; throw new Error("Provider unavailable"); } } },
    egressAcknowledged: true, operatorMessage: "Explain the current draft.", validatedFacts: ["Draft remains pending."],
  })).rejects.toMatchObject({ code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION" });
  expect(calls).toBe(1);
});
