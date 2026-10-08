import { afterEach, expect, it, vi } from "vitest";
import * as english from "./read-meaning-evidence.js";
import { typedReadAssistanceFixture } from "./test-fixtures/typed-read-assistance.js";
import { READ_SCOPE_PROTOCOL, type ReadScopeProposal } from "./read-structured-scope.js";
import type { ReadWorkloadAssistanceCheckpoint } from "./read-workload-assistance-checkpoint.js";
import type { AskProviderDependencies } from "./model-ask.js";

const restored: Array<() => void> = [];
afterEach(() => { for (const restore of restored.splice(0)) restore(); });
function forbidEnglish() {
  for (const name of ["isUnknownReadMeaning", "findReadMeaningEvidence", "isExplicitReadMeaningStatement", "readDefinitionPhrases"] as const) {
    const spy = vi.spyOn(english, name).mockImplementation(() => { throw new Error(`RETIRED_ENGLISH_OWNER_CALLED:${name}`); });
    restored.push(() => spy.mockRestore());
  }
}
function visibleJson(body: unknown, prefix: string): any {
  const strings: string[] = [];
  const visit = (v: unknown) => { if (typeof v === "string") strings.push(v); else if (v && typeof v === "object") Object.values(v).forEach(visit); };
  visit(body);
  for (const line of strings.flatMap(text => text.split("\n"))) if (line.startsWith(prefix)) return JSON.parse(line.slice(prefix.length));
  throw new Error(`Missing actual model-visible input: ${prefix}`);
}
// Prepared responses derive target/ref identities solely from transmitted facts.
function response(body: unknown, missing?: string) {
  const refs = visibleJson(body, "Host scope reference inventory: ") as Array<{ id: string; kind: string; text: string }>;
  const catalog = visibleJson(body, "Structural catalog: ") as { resources: Array<{ id: string; fields: Array<{ id: string }> }> };
  const subjects = visibleJson(body, "Host reviewed subject scope inventory: ") as Array<{ root_resource: string; reference: string }>;
  const original = refs.find(r => r.kind === "request")!, resource = catalog.resources.find(r => r.id === "public.orders")!;
  if (!original || !resource?.fields.some(f => f.id === "status")) throw new Error("Declared case target absent from actual catalog");
  const subject = subjects.find(s => s.root_resource === resource.id)!;
  if (!subject) throw new Error("No actual reviewed structural scope");
  const proposal: ReadScopeProposal = { protocol: READ_SCOPE_PROTOCOL, original_request: original.id, applicability: "read_requested", requirements: [{
    id: "declared-order-view", intended_use: original.text, references: refs.filter(r => r.kind === "request" || r.kind === "answer").map(r => r.id),
    disposition: missing ? "unresolved" : "include", subjects: missing ? [] : [{ root_resource: resource.id, mode: "reviewed_resource", scope_reference: subject.reference }],
    targets: missing ? [] : [{ root_resource: resource.id, resource: resource.id, operation: "resource" }, { root_resource: resource.id, resource: resource.id, operation: "return", field: "status" }],
    ...(missing ? { unresolved: missing } : {}),
  }] };
  return { status: 200, body: { output: [{ type: "function_call", call_id: "actual_typed_read", name: "runner__submit_read_workloads", arguments: JSON.stringify({
    read_scope: proposal, allowed: missing ? [] : [{ id: "own_orders", description: original.text, plan: { kind: "rows", resource: resource.id, select: ["status"] } }], forbidden: [],
  }) }] } };
}
const setup = (requestJson: NonNullable<AskProviderDependencies["requestJson"]>) => ({ name: "zero_english_read", allowedQuestions: ["List my orders"],
  provider: "openai" as const, model: "scripted", apiKey: "inert-test-key", egressAcknowledged: true, deferNarration: true, dependencies: { requestJson } });

it("B64 typed initial mapping and bounded correction never enter retired Read English owners", async () => {
  const h = await typedReadAssistanceFixture("List my orders", undefined, "scripted");
  forbidEnglish();
  const send = vi.fn<NonNullable<AskProviderDependencies["requestJson"]>>()
    .mockResolvedValueOnce({ status: 200, body: { output: [] } })
    .mockImplementation(async actual => response(actual.body));
  try {
    const result = await h.run({ ...setup(send), generatedBoundary: h.boundary });
    expect(result.analysis.status).toBe("ready"); expect(send).toHaveBeenCalledTimes(2);
    expect(h.state().operator_questions!.at(-1)?.confirmation).toBeUndefined();
    expect(h.state().operator_questions!.at(-1)?.read_scope?.mode).toBe("review");
  } finally { await h.cleanup(); }
});

it("B64 native unknown-sounding raw testimony reaches typed unresolved, then cold Resume maps without English", async () => {
  const answers: Array<string | null> = ["I'm not sure", null];
  const h = await typedReadAssistanceFixture("List my orders", async () => answers.shift() ?? null, "scripted");
  forbidEnglish(); let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined;
  let calls = 0;
  const send = vi.fn<NonNullable<AskProviderDependencies["requestJson"]>>(async actual => response(actual.body,
    ++calls === 1 ? "Which business meaning belongs in this view?" : "Please clarify the intended business meaning."));
  try {
    await expect(h.run({ ...setup(send), generatedBoundary: h.boundary, onCheckpoint: async cp => { checkpoint = cp; } })).rejects.toThrow("AUTHORING_PAUSED");
    expect(send).toHaveBeenCalledTimes(2);
    const native = h.state().operator_questions!.find(q => q.raw_answer?.text === "I'm not sure")!;
    expect(native.raw_answer!.text).toBe("I'm not sure"); expect(native.confirmation).toBeUndefined();
    expect(checkpoint?.state.scope_answers).toHaveLength(1);
    await h.reload(); answers.push("The fulfillment state on my order records.");
    const next = vi.fn<NonNullable<AskProviderDependencies["requestJson"]>>(async actual => response(actual.body));
    const result = await h.run({ ...setup(next), generatedBoundary: h.boundary, resumeCheckpoint: checkpoint });
    expect(result.analysis.status).toBe("ready"); expect(next).toHaveBeenCalledTimes(1);
    expect(h.state().operator_questions!.filter(q => q.raw_answer).map(q => q.raw_answer!.text)).toContain("I'm not sure");
    expect(h.state().operator_questions!.at(-1)?.confirmation).toBeUndefined();
  } finally { await h.cleanup(); }
});
