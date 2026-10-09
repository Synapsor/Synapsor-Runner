import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { createOperatorQuestion } from "./authoring-operator-question.js";
import { runOperatorQuestionModel } from "./authoring-operator-question-model.js";
import { newPolicySourceSession, policyTextSnapshot } from "./authoring-policy-source.js";
import type { AskProviderDependencies } from "./model-ask.js";

function sourceProducer(question: string, sourcePassages: unknown) {
  const source = policyTextSnapshot(Buffer.from("Unrelated archive: PRIVATE_ARCHIVE_SENTINEL.\nThe priority_note is caller evidence.\nIts length is a missing operator choice."), "rules");
  const session = newPolicySourceSession(); session.snapshots.push(source); session.active = 1;
  const store = canonicalJsonDigest("current store"), outcomes = ["parcel.set_priority"];
  const root = createOperatorQuestion({ id: randomUUID(), revision: 1, kind: "input_bounds", assistedLocalConsumer: true,
    scope_digest: canonicalJsonDigest("current scope"), context_digest: canonicalJsonDigest(session),
    target: { phase: "input_policy", outcomes }, material: ["No source effect or authority."], evidence: [],
    continuation: "input_policy_review", source_binding: { source_session: session.id, source_digest: source.digest as `sha256:${string}`,
      store_digest: store, lines: source.lines, agenda_digest: canonicalJsonDigest({source_session:session.id,source_digest:source.digest,store_digest:store,outcomes}) } });
  const requestJson = vi.fn<NonNullable<AskProviderDependencies["requestJson"]>>(async () => ({ status: 200,
    body: { status: "completed", output: [{ type: "function_call", call_id: randomUUID(), name: "runner__propose_operator_decision",
      arguments: JSON.stringify({question_id:root.id,revision:root.revision,status:"needs_information",source_reference:canonicalJsonDigest(root.source_binding),
        question,source_passages:sourcePassages}) }] } }));
  return { root, requestJson, run: () => runOperatorQuestionModel({question:root,stage:"source-review",policyText:source.text,
    session:{provider:"openai",model:"controlled-naming-producer",apiKey:"inert-control",dependencies:{requestJson}},
    episodeBudget:{admitIteration:async()=>{},reserveToolBatch:async()=>{}},reserveCorrection:async()=>false,
    authorityGuard:expected=>expected,env:{},egressAcknowledged:true}) };
}

describe("B64 I02064 actual bounded Source naming producer preseal", () => {
  it.each(["How short or long may the priority note be?", "What is the permitted length of this note?"])("retains exact typed locators independently of presentation: %s", async question => {
    const source_passages = [{start:2,end:2,identifiers:["priority_note"]}];
    const f = sourceProducer(question,source_passages), before=structuredClone(f.root);
    expect(await f.run()).toMatchObject({state:"question",source_passages,authority_granted:false,source_database_changed:false});
    expect(f.root).toEqual(before); expect(f.root.raw_answer).toBeUndefined(); expect(f.root.confirmation).toBeUndefined();
    expect(f.requestJson).toHaveBeenCalledOnce();
  });
  it.each([
    [{start:0,end:2,identifiers:["priority_note"]}],
    [{start:2,end:4,identifiers:["priority_note"]}],
    [{start:2,end:2,identifiers:["invented_input"]}],
    Array.from({length:13},()=>({start:2,end:2,identifiers:["priority_note"]})),
  ].map(ranges => ({ranges})))("refuses invalid exact ranges/identifier grammar/bounds before any adoption: %j", async ({ranges}) => {
    const f=sourceProducer("How short or long may the priority note be?",ranges);
    await expect(f.run()).rejects.toMatchObject({code:"ASK_TOOL_ARGUMENTS_INVALID"});
    expect(f.root.confirmation).toBeUndefined(); expect(f.root.raw_answer).toBeUndefined();
  });
});
