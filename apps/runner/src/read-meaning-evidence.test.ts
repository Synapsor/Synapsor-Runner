import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { findReadMeaningEvidence, normalizeReadMeaningEvidence } from "./read-meaning-evidence.js";

const catalog = { resources: [{ id: "warehouse.dispatch_items", fields: [{ id: "kappa" }, { id: "reason" }] }] };
const target = { resource: "warehouse.dispatch_items", field: "kappa" };
const context_digest = canonicalJsonDigest("exact current reviewed context"), requested_use_digest = canonicalJsonDigest("Read dispatch stage");
const find = (text: string, field = "kappa", currentCatalog = catalog) => findReadMeaningEvidence({ target: { ...target, field }, catalog: currentCatalog,
  statements: [{ origin: "policy_source", text, source_digest: canonicalJsonDigest(text), source_id: "current-source", source_version: 1 }],
  answers: [], context_digest, requested_use_digest });

describe("exact current Read meaning associations", () => {
  it.each(["means", "represents", "records", "is"])("binds an explicit %s statement without model quote echo", verb => {
    const text = `Header\nwarehouse.dispatch_items.kappa ${verb} the lifecycle stage of one dispatch request.`;
    const evidence = find(text)!;
    expect(evidence).toMatchObject({ ...target, origin: "HOST-RESOLVED", context_digest, requested_use_digest,
      reference: { kind: "policy_source", source_id: "current-source", source_version: 1, source_digest: canonicalJsonDigest(text),
        start_line: 2, end_line: 2, text: text.split("\n")[1] } });
    expect(normalizeReadMeaningEvidence([evidence])).toEqual([evidence]);
  });
  it.each(["Use kappa for this job.", "The permitted enum for kappa contains ready and held.",
    "kappa_private means an observed private balance.", "Caller input kappa means the requested amount."])("does not establish meaning from %s", text => {
    expect(find(text)).toBeUndefined();
  });
  it("does not associate an ambiguous leaf field with either of two resources", () => {
    const duplicate = { resources: [...catalog.resources, { id: "warehouse.other_items", fields: [{ id: "kappa" }] }] };
    expect(find("kappa is the lifecycle stage.", "kappa", duplicate)).toBeUndefined();
    expect(find("warehouse.dispatch_items.kappa is the lifecycle stage.", "kappa", duplicate)).toMatchObject(target);
  });
  it("does not turn a table description into evidence for its field", () => {
    expect(find("warehouse.dispatch_items contains dispatch requests.")).toBeUndefined();
  });
  it("retains a full explicit transition line as task-scoped evidence without defining all enum values", () => {
    const text = "3. operation.ready: Set kappa ready only for an open nonblocked item; caller reason string1..64.";
    expect(find(text)?.reference.text).toBe(text);
    expect(find(text, "reason")).toBeUndefined();
  });
  it("uses a short answer only for the exact attributed question target", () => {
    const answers = [{ ...target, question: "What does this field represent for dispatch review?", answer: "The lifecycle stage of a dispatch request." }];
    const known = findReadMeaningEvidence({ target, catalog, answers, statements: [], context_digest, requested_use_digest });
    expect(known?.reference).toMatchObject({ kind: "answered_clarification", text: answers[0]!.answer,
      source_id: canonicalJsonDigest({ target, question: answers[0]!.question }), source_digest: canonicalJsonDigest(answers[0]!.answer) });
    expect(findReadMeaningEvidence({ target: { ...target, field: "reason" }, catalog, answers, statements: [], context_digest, requested_use_digest })).toBeUndefined();
  });
  it("refuses competing attributed answers rather than silently selecting the later one", () => {
    expect(() => findReadMeaningEvidence({ target, catalog, statements: [], context_digest, requested_use_digest,
      answers: [{ ...target, question: "What is it?", answer: "Lifecycle stage" }, { ...target, question: "What is it?", answer: "Credit amount" }] })).toThrow("MEANING_CONFLICT");
  });
  it.each(["unknown_key", "wrong_digest", "missing_version"])("validates persisted audit shape without making it authority: %s", kind => {
    const evidence: any = find("kappa means the lifecycle stage.");
    if (kind === "unknown_key") evidence.permission = "all";
    if (kind === "wrong_digest") evidence.context_digest = "bad";
    if (kind === "missing_version") delete evidence.reference.source_version;
    expect(() => normalizeReadMeaningEvidence([evidence])).toThrow("MEANING_EVIDENCE_INVALID");
  });
});
