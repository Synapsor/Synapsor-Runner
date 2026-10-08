import { expect, it } from "vitest";
import { narrateValidatedAuthoringStep } from "./model-authoring-narration.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";

const facts = ["The reviewed Read draft is disabled.", "The principal choice remains unresolved.", "No source effect has been established."];
const question = "Which reviewer is responsible?";
async function run(reply: (body: string) => string, style: "inspection" | "opening" = "inspection") {
  let requests = 0;
  const conversation = createModelAuthoringConversation();
  const result = await narrateValidatedAuthoringStep({
    session: { provider: "openai", model: "declared-test", apiKey: "memory-key", conversation,
      dependencies: { requestJson: async request => { requests++; return { status: 200, body: { output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: reply(JSON.stringify(request.body)) }] },
      ] } }; } } },
    operatorMessage: "Explain the pending record.", validatedFacts: facts, nextQuestion: question,
    responseStyle: style, egressAcknowledged: true,
  });
  return { result, requests, conversation };
}

function advertisedReply(body: string): { kind: string; record_digest: string; fact_indexes: number[] } {
  const decoded = JSON.parse(body);
  const text = JSON.stringify(decoded).replace(/\\n/g, "\n").replace(/\\"/g, '"');
  const line = text.split("\n").find(line => line.startsWith("Typed narration record: "));
  if (!line) throw new Error("The model did not receive a typed narration record.");
  const record = JSON.parse(line.slice("Typed narration record: ".length));
  return { kind: "validated_record", record_digest: record.record_digest,
    fact_indexes: record.facts.map((fact: { index: number }) => fact.index) };
}

it("rejects arbitrary prose even when no English safety pattern recognizes its claim", async () => {
  expect((await run(() => "Every assistant already has unrestricted access and completed the changes.")).result).toBeUndefined();
});
it("renders every supplied caveat and exact pending question from a request-bound typed reply", async () => {
  expect((await run(body => JSON.stringify(advertisedReply(body)))).result).toBe([...facts, question].join("\n"));
});
it.each(["omit", "duplicate", "outside", "unknown_key", "binding", "prose"])("rejects a %s typed reply without losing the pending facts", async variant => {
  const result = await run(body => {
    const reply = advertisedReply(body);
    if (variant === "omit") reply.fact_indexes.pop();
    if (variant === "duplicate") reply.fact_indexes[1] = 0;
    if (variant === "outside") reply.fact_indexes[1] = 999;
    if (variant === "binding") reply.record_digest = "sha256:" + "0".repeat(64);
    return JSON.stringify({ ...reply, ...(variant === "unknown_key" ? { activated: true } : {}),
      ...(variant === "prose" ? { answer: "Everything is enabled." } : {}) });
  });
  expect(result.result).toBeUndefined();
  expect(result.requests).toBe(1);
});
it("renders the host opening with every caveat and exact question without a provider call", async () => {
  const result = await run(() => "Invented model opening.", "opening");
  expect(result.requests).toBe(0);
  for (const text of [...facts, question]) expect(result.result).toContain(text);
});
