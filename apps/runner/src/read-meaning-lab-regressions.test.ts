import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { explicitReadTaskTargets, findReadMeaningEvidence } from "./read-meaning-evidence.js";

const context_digest = canonicalJsonDigest("current reviewed lab context");
const requested_use_digest = canonicalJsonDigest("show handling stage and priority");
const codebook = "The parcel register is r1. Its c1 field is the handling stage: 11 means waiting, 22 means ready, and 33 means closed. Its c2 field is priority. Its c3 field records current admission; true means admitted.";
const catalog = { resources: [{ id: "lab_f1.r1", fields: ["c1", "c2", "c3", "unexplained"].map(id => ({ id })) }] };
const answer = { resource: "lab_f1.r1", question: "What business records does lab_f1.r1 contain, and what does its referenced field c1 mean?", answer: codebook };
const statement = { text: codebook, origin: "operator_statement" as const, source_digest: canonicalJsonDigest(codebook), source_id: "retained-owner-answer" };
function meaning(field: string, currentCatalog = catalog, text = codebook) {
  return findReadMeaningEvidence({ target: { resource: "lab_f1.r1", field }, catalog: currentCatalog,
    statements: [{ ...statement, text, source_digest: canonicalJsonDigest(text) }], answers: [{ ...answer, answer: text }], context_digest, requested_use_digest });
}

describe("lab regression: exact field meaning in the retained ordinary answer", () => {
  it("reuses the same-call answer before it has been copied into conversation statements", () => {
    const evidence = findReadMeaningEvidence({ target: { resource: "lab_f1.r1", field: "c1" }, catalog,
      statements: [], answers: [answer], context_digest, requested_use_digest });
    expect(evidence).toMatchObject({ field: "c1", reference: { kind: "answered_clarification",
      source_id: canonicalJsonDigest({ target: { resource: answer.resource }, question: answer.question }),
      source_digest: canonicalJsonDigest(codebook), text: codebook } });
    expect(findReadMeaningEvidence({ target: { resource: "lab_f1.r1", field: "c1" }, catalog,
      statements: [], answers: [{ ...answer, resource: "other.r1" }], context_digest, requested_use_digest })).toBeUndefined();
  });
  it.each(["c1", "c2", "c3"])("reuses explicitly explained %s without copying the resource answer to every field", field => {
    expect(meaning(field)).toMatchObject({ resource: "lab_f1.r1", field, context_digest, requested_use_digest,
      reference: { kind: "operator_statement", source_id: "retained-owner-answer", text: codebook, source_digest: canonicalJsonDigest(codebook) } });
    expect(meaning("unexplained")).toBeUndefined();
  });
  it("does not bind an ambiguous leaf, a different resource, a caller input or an unknown meaning", () => {
    const ambiguous = { resources: [...catalog.resources, { id: "lab_f1.other", fields: [{ id: "c1" }] }] };
    expect(meaning("c1", ambiguous)).toBeUndefined();
    expect(meaning("c1", catalog, "other.c1 field is a private balance.")).toBeUndefined();
    expect(meaning("c1", catalog, "Caller input c1 field is the requested amount.")).toBeUndefined();
    expect(meaning("c1", catalog, "Its c1 field is unknown.")).toBeUndefined();
    expect(meaning("c1", ambiguous, "lab_f1.r1.c1 field is the handling stage.")).toMatchObject({ resource: "lab_f1.r1", field: "c1" });
  });
  it("retains conflicting explicit field definitions instead of choosing the last statement", () => {
    expect(() => meaning("c1", catalog, "Its c1 field is the handling stage. Its c1 field is the credit amount.")).toThrow("MEANING_CONFLICT");
  });
});

describe("lab regression: ordinary display-name prose is not an unrelated field reference", () => {
  const wideCatalog = { resources: [
    { id: "lab_f8.assets", fields: [{ id: "display_name" }, { id: "location" }] },
    { id: "lab_f8.sites", fields: [{ id: "name" }] },
  ] };
  it("does not invent sites.name from the display-name phrase in an asset instruction", () => {
    expect(explicitReadTaskTargets("Show asset display name and location.", wideCatalog)).not.toContainEqual({ resource: "lab_f8.sites", field: "name" });
  });
  it.each(["Read lab_f8.sites.name.", "Show the site label from lab_f8.sites.name.", "Display name."])("keeps the exact positive reference: %s", text => {
    expect(explicitReadTaskTargets(text, wideCatalog)).toContainEqual({ resource: "lab_f8.sites", field: "name" });
  });
  it.each(["Do not display name.", 'An example says "Display name".', "If needed, display name."])("does not turn a negative or hypothetical into authority: %s", text => {
    expect(explicitReadTaskTargets(text, wideCatalog)).toEqual([]);
  });
});
