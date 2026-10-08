import { describe, expect, it } from "vitest";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { policyTextSnapshot } from "./authoring-policy-source.js";
import { projectReadScopeHostContext } from "./read-current-evidence.js";

const input = () => ({ request: { id: "original-job", text: "Show selected equipment descriptions." },
  catalog: { digest: d("catalog"), resources: [{ id: "work.equipment", fields: [{ id: "description" }] }], relationships: [] },
  binding: { meaning_digest: d("meaning"), applicability_digest: d("job-identity"), operation_digest: d("reviewed-candidate") } });
describe("B64 production Read host context projection", () => {
  it("derives exact request identity without interpreting its text or claiming confirmation", () => {
    const f = input(), result = projectReadScopeHostContext(f);
    expect(result.references).toEqual([{ kind: "request", id: f.request.id, text: f.request.text, digest: d(f.request.text) }]);
    expect(result.binding).toEqual({ ...f.binding, request_digest: d(f.request.text), source_digest: d(null), catalog_digest: f.catalog.digest });
    expect(result).not.toHaveProperty("confirmation"); expect(result).not.toHaveProperty("proposal");
    result.catalog.resources[0]!.fields[0]!.id = "changed";
    expect(f.catalog.resources[0]!.fields[0]!.id).toBe("description");
  });
  it("projects a long consented Source into bounded exact physical-line references without truncation", () => {
    const lines = ["First rule: " + "a".repeat(2300), "", "Second rule: " + "b".repeat(2300), "Final rule."];
    const snapshot = policyTextSnapshot(Buffer.from(lines.join("\r\n")), "business.txt");
    const result = projectReadScopeHostContext({ ...input(), source: { session_id: "actual-source", snapshot } });
    const refs = result.references.filter(ref => ref.kind === "source");
    expect(refs.length).toBeGreaterThan(1);
    expect(refs.map(ref => ref.text).join("\n")).toBe(lines.join("\n"));
    for (const ref of refs) {
      expect(ref.text).toBe(lines.slice(ref.start_line - 1, ref.end_line).join("\n"));
      expect(ref.digest).toBe(snapshot.digest); expect(ref.source_id).toBe("actual-source");
      expect(ref.text.length).toBeLessThanOrEqual(4000);
    }
  });
  it("rejects a single oversized Source line and changed snapshot numbering or digest", () => {
    const snapshot = policyTextSnapshot(Buffer.from("x".repeat(4001)), "large.txt");
    expect(() => projectReadScopeHostContext({ ...input(), source: { session_id: "source", snapshot } })).toThrow(/no text was truncated/u);
    const good = policyTextSnapshot(Buffer.from("Actual rule."), "rules.txt");
    for (const changed of [{ ...good, lines: 2 }, { ...good, digest: d("forged") }, { ...good, text: "Changed rule." }])
      expect(() => projectReadScopeHostContext({ ...input(), source: { session_id: "source", snapshot: changed } })).toThrow(/snapshot text, digest or numbering changed/u);
  });
  it("does not invent an answer reference from a selected ID or empty history", () => {
    expect(() => projectReadScopeHostContext({ ...input(), answerQuestionIds: ["not-a-native-question"] })).toThrow(/acknowledged question is absent/u);
  });
  it("rejects oversized original requests instead of shortening their requirement binding", () => {
    expect(() => projectReadScopeHostContext({ ...input(), request: { id: "job", text: "x".repeat(4001) } })).toThrow(/not shortened/u);
  });
});
