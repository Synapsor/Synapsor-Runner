import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
import { projectReadSubjectContext } from "./authoring-read-subject-context.js";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import Ajv from "ajv";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { READ_SCOPE_PROTOCOL, readScopeProposalCodec, readScopeProposalSchema, parseReadScopeProposal,
  parseReadScopeRecord, resolveReadScopeProposal, assessReadScopeDraft, assessReadScopeRecordCurrentness,
  assertReadScopeProvenance,
  type ReadScopeProposal, type ReadScopeTarget, type ReadScopeBinding, type ReadScopeReference, type ReadSubjectBinding } from "./read-structured-scope.js";
import { type ReadWorkloadAnalysis } from "./read-workload-assist.js";

const d = (text: string) => canonicalJsonDigest(text);
const root: ReadScopeTarget = { root_resource: "work.items", resource: "work.items", operation: "resource" };
const title: ReadScopeTarget = { ...root, operation: "return", field: "title" };
const secret: ReadScopeTarget = { ...root, operation: "return", field: "private_note" };
const binding: ReadScopeBinding = { request_digest: d("Show item titles, never private notes."), source_digest: d("policy"),
  catalog_digest: d("catalog"), meaning_digest: d("meaning"), applicability_digest: d("use"), operation_digest: d("candidate") };
const references: ReadScopeReference[] = [
  { id: "job", kind: "request", digest: binding.request_digest, text: "Show item titles, never private notes." },
  { id: "policy:1", kind: "source", digest: binding.source_digest, source_id: "policy", start_line: 1, end_line: 1,
    text: "Customers can see item titles; private notes stay private." },
];
const catalog = { resources: [{ id: "work.items", fields: [{ id: "title" }, { id: "private_note" }] },
  { id: "other.items", fields: [{ id: "title" }] }], relationships: [], subject_scopes: [] as ReadSubjectBinding[] };
let fixtureRoot: string, compiled: ReadWorkloadAnalysis;
beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scope-codec-native-"));
  const prepared = await prepareReviewedReadScope(fixtureRoot, { resources: ["work.items"], field: "title" });
  compiled = prepared.analysis;
  catalog.subject_scopes = projectReadSubjectContext({ context: prepared.context, sourceDigest: binding.source_digest as `sha256:${string}` }).subject_scopes;
});
afterAll(async () => { if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true }); });
function proposal(): ReadScopeProposal {
  return { protocol: READ_SCOPE_PROTOCOL, original_request: "job", applicability: "read_requested", requirements: [
    { id: "titles", intended_use: "Show item titles", references: ["job", "policy:1"], disposition: "include", subjects: [{ root_resource: "work.items", mode: "trusted_principal" }], targets: [root, title] },
    { id: "privacy", intended_use: "Keep private notes hidden", references: ["job", "policy:1"], disposition: "exclude", subjects: [], targets: [secret] },
  ] };
}
const resolve = (value: unknown = proposal()) => resolveReadScopeProposal(value, { expectedBinding: binding, references, catalog, analysis: analysis() });
function analysis(targets: ReadScopeTarget[] = [root, title]): ReadWorkloadAnalysis {
  // Positive atoms come from the actual compiler. Negative variants deliberately
  // vary only the assessed atom set; they do not claim a native saved analysis.
  return { ...structuredClone(compiled), authority_atoms: targets.map(target => ({ id: canonicalJsonDigest(target), ...target })) };
}

describe("B64 typed Read scope", () => {
  it("resolves actual references without promoting provenance to semantic confirmation", () => {
    const record = resolve();
    expect(record.references).toEqual(references);
    expect(assessReadScopeRecordCurrentness({ record, expectedBinding: binding })).toMatchObject({ status: "proposed", authority_granted: false });
    expect(assessReadScopeDraft(record, analysis())).toMatchObject({ status: "compatible", authority_granted: false });
  });
  it("requires an explicit no-Read proposal rather than inferring it from an empty extraction", () => {
    expect(() => resolve({ ...proposal(), requirements: [] })).toThrow(/READ_SCOPE_INVALID/u);
    const noRead = resolve({ ...proposal(), applicability: "no_read_requested", requirements: [] });
    expect(assessReadScopeDraft(noRead, analysis())).toMatchObject({ status: "delta_required", added: [root, title] });
    expect(assessReadScopeRecordCurrentness({ record: noRead, expectedBinding: binding }).status).toBe("proposed");
  });
  it("binds semantic content and original references independently of provider correlation IDs", () => {
    const first = resolve();
    const renamed = proposal(); renamed.requirements[0]!.id = "different-provider-id";
    expect(resolve(renamed).requirement_bindings[0]!.digest).toBe(first.requirement_bindings[0]!.digest);
    renamed.requirements[0]!.intended_use = "Use titles to make another business decision";
    expect(resolve(renamed).requirement_bindings[0]!.digest).not.toBe(first.requirement_bindings[0]!.digest);
  });
  it.each(["actor", "confirmed", "accepted_revision", "recovery_permission"])("rejects provider-owned %s", key => {
    expect(() => parseReadScopeProposal({ ...proposal(), [key]: true })).toThrow(/READ_SCOPE_INVALID/u);
  });
  it("rejects a forged reference and a stale original request", () => {
    const forged = proposal(); forged.requirements[0]!.references = ["invented"];
    expect(() => resolve(forged)).toThrow(/READ_SCOPE_REFERENCE_INVALID/u);
    expect(() => resolveReadScopeProposal(proposal(), { expectedBinding: { ...binding, request_digest: d("other") }, references, catalog }))
      .toThrow(/READ_SCOPE_REFERENCE_INVALID/u);
  });
  it("does not treat valid policy lines as correct semantic mapping", () => {
    const incorrect = proposal(); incorrect.requirements[0]!.intended_use = "These real lines mean something else";
    const record = resolve(incorrect);
    expect(assessReadScopeRecordCurrentness({ record, expectedBinding: binding }).status).toBe("proposed");
  });
  it("rejects unknown and homonymous target identities rather than guessing", () => {
    const bad = proposal(); bad.requirements[0]!.targets = [{ ...title, resource: "items" }];
    expect(() => resolve(bad)).toThrow(/READ_SCOPE_TARGET_INVALID/u);
    bad.requirements[0]!.targets = [{ ...title, field: "name" }];
    expect(() => resolve(bad)).toThrow(/READ_SCOPE_TARGET_INVALID/u);
  });
  it("requires exact field operations; a root association never grants every field", () => {
    const onlyRoot = proposal(); onlyRoot.requirements[0]!.targets = [root];
    expect(assessReadScopeDraft(resolve(onlyRoot), analysis())).toMatchObject({ status: "delta_required", added: [title] });
    const missingField = proposal(); missingField.requirements[0]!.targets = [{ ...root, operation: "return" }];
    expect(() => resolve(missingField)).toThrow(/READ_SCOPE_TARGET_INVALID/u);
  });
  it("refuses a cross-resource field without its exact relationship identity", () => {
    const wrong = proposal(); wrong.requirements[0]!.targets = [{ ...title, resource: "other.items" }];
    expect(() => resolve(wrong)).toThrow(/exact relationship identity/u);
  });
  it("retains exclusions and missing inclusions in subsequent drafts", () => {
    expect(assessReadScopeDraft(resolve(), analysis([root, secret]))).toMatchObject({ status: "delta_required",
      missing: [title], excluded: [secret], added: [secret] });
  });
  it("shows unresolved mappings without inventing coverage or treating a candidate as selected", () => {
    const value = proposal(); value.requirements[0] = { ...value.requirements[0]!, disposition: "unresolved",
      targets: [root], unresolved: "Which item register is intended?" };
    const record = resolve(value);
    expect(assessReadScopeDraft(record, analysis())).toMatchObject({ status: "pending", unresolved: ["titles"] });
    expect(assessReadScopeRecordCurrentness({ record, expectedBinding: binding }).status).toBe("pending");
  });
  it("cannot label a current mechanically valid proposal as confirmed", () => {
    expect(assessReadScopeRecordCurrentness({ record: resolve(), expectedBinding: binding }).status).toBe("proposed");
  });
  it.each(["meaning_digest", "applicability_digest", "operation_digest", "source_digest", "catalog_digest"] as const)(
    "does not reuse confirmation after %s changes", key => {
      const record = resolve();
      expect(assessReadScopeRecordCurrentness({ record, expectedBinding: { ...binding, [key]: d("changed") } }).status).toBe("stale");
    });
  it("rejects tampered record bodies and rewritten requirement bindings", () => {
    const record = resolve();
    record.proposal.requirements[0]!.targets = [secret];
    expect(() => parseReadScopeRecord(record)).toThrow(/READ_SCOPE_RECORD_INVALID/u);
    const { digest: _old, ...body } = record;
    expect(() => parseReadScopeRecord({ ...body, digest: canonicalJsonDigest(body) })).toThrow(/READ_SCOPE_RECORD_INVALID/u);
  });
  it("does not launder edited Source text through recomputed self-consistent hashes", () => {
    const changedInventory = references.map(reference => reference.kind === "source"
      ? { ...reference, text: "Private notes are public now." } : reference);
    const forged = resolveReadScopeProposal(proposal(), { expectedBinding: binding, references: changedInventory, catalog, analysis: analysis() });
    expect(() => parseReadScopeRecord(forged)).not.toThrow(); // Shape/digest is not provenance.
    expect(() => assertReadScopeProvenance(forged, { expectedBinding: binding, references, catalog }))
      .toThrow(/READ_SCOPE_PROVENANCE_STALE/u);
    expect(assertReadScopeProvenance(resolve(), { expectedBinding: binding, references, catalog }).digest).toBe(resolve().digest);
    expect(assertReadScopeProvenance(resolve(), { expectedBinding: binding, references: [...references].reverse(), catalog }).digest).toBe(resolve().digest);
  });
  it("keeps narration outside the typed proposal and makes intended-use changes reviewable", () => {
    const record = resolve();
    expect(parseReadScopeRecord(record).digest).toBe(record.digest);
    const changed = proposal(); changed.requirements[0]!.intended_use += " for marketing";
    expect(resolve(changed).digest).not.toBe(record.digest);
  });
  it("checks provider shape projection against the canonical codec", () => {
    const ajv = new (Ajv as unknown as { new(options: unknown): { compile(schema: unknown): (value: unknown) => boolean } })({ strict: false });
    const accepts = ajv.compile(readScopeProposalSchema);
    for (const value of [proposal(), { ...proposal(), actor: "model" }, { ...proposal(), protocol: "old" },
      { ...proposal(), requirements: [] }, { ...proposal(), original_request: 4 },
      { ...proposal(), requirements: [{ ...proposal().requirements[0]!, targets: [{ ...title, unexpected: true }] }] }])
      expect(accepts(value)).toBe(readScopeProposalCodec.safeParse(value).success);
  });
});
