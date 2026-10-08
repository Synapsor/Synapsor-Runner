import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest as digest } from "@synapsor-runner/protocol";
import { createOperatorQuestion, presentOperatorQuestion, captureOperatorAnswer } from "./authoring-operator-question.js";
import type { AuthoringTransportOperation } from "./authoring-generation-recovery.js";
import { authoringHistoryRecordRef, projectAuthoringOperationHistory, authoringHistoryPage, exactAuthoringHistoryEntry,
  presentAuthoringOperationHistory, type AuthoringHistoryAccess } from "./authoring-operation-history.js";
function question() {
  return captureOperatorAnswer(presentOperatorQuestion(createOperatorQuestion({ id: randomUUID(), revision: 1, handoff_id: randomUUID(),
    kind: "attributed_meaning", scope_digest: digest("scope"), context_digest: digest("current"), target: { phase: "read", resource: "dispatch.parcels", field: "status", outcomes: [] },
    material: ["Current status meaning"], evidence: [], continuation: "read_mapping" }), "What does ready mean?"), "  Ready for collection.\u001b[31m  ");
}
const allow = (owner: AuthoringHistoryAccess["owner"], id: string, record: unknown): AuthoringHistoryAccess => ({ ...authoringHistoryRecordRef(owner, id, record), visibility: "available" });
function operation(): AuthoringTransportOperation {
  return { id: randomUUID(), request_digest: digest("request"), context_digest: digest("context"), deadline: "2026-10-09T00:00:00Z", state: "handled",
    attempts: [{ id: randomUUID(), started_at: "2026-10-08T10:00:00Z", outcome: "response" }] };
}
describe("read-only existing operation history projection", () => {
  it("projects actual captured answer without promoting it into confirmation or save", () => {
    const q = question(), before = structuredClone(q), s = projectAuthoringOperationHistory({ questions: [q], access: [allow("question", q.id, q)] });
    const answer = s.entries.find(e => e.ref.part === "operator")!;
    expect(answer.availability).toBe("available"); expect(answer.lines.join("\n")).toContain("Ready for collection");
    expect(answer.lines.join("\n")).not.toContain("\u001b"); expect(q).toEqual(before);
    expect(s.entries.find(e => e.ref.part === "confirmation")).toMatchObject({ status: "unconfirmed", availability: "unavailable" });
    expect(s.entries.find(e => e.ref.part === "save")).toMatchObject({ status: "not established by question record", availability: "unavailable" });
  });
  it("redacts exact record by default and never reuses a grant for a changed record", () => {
    const q = question(), s = projectAuthoringOperationHistory({ questions: [q], access: [] });
    expect(s.entries.every(e => e.availability === "redacted")).toBe(true); expect(JSON.stringify(s)).not.toContain("Ready for collection");
    const stale = allow("question", q.id, { ...q, revision: q.revision - 1 });
    expect(projectAuthoringOperationHistory({ questions: [q], access: [stale] }).entries.every(e => e.availability === "redacted")).toBe(true);
  });
  it("does not invent request payload or durable save from handled transport", () => {
    const op = operation(), s = projectAuthoringOperationHistory({ operations: [op], access: [allow("native_operation", op.id, op)] });
    expect(s.entries.find(e => e.ref.part === "submission")).toMatchObject({ availability: "unavailable", status: "handled" });
    expect(s.entries.find(e => e.ref.part === "save")).toMatchObject({ availability: "unavailable" });
    const checkpoint = { consumer: "action_rule_components" as const, kind: "compiled_draft" as const, material_digest: digest("material"), response_digest: digest("response") };
    const saved = { ...op, action_checkpoint: checkpoint };
    const current = projectAuthoringOperationHistory({ operations: [saved], access: [allow("native_operation", saved.id, saved)] });
    expect(current.entries.find(e => e.ref.part === "save")?.lines.join("\n")).toContain("not publication, activation");
  });
  it("shows operator-authorized Source text, keeps tentative arbitrary payload out", () => {
    const snapshot = { version: 1, name: "rules.txt", text: "Approved attached business rule", bytes: 31, lines: 1, digest: digest("actual text ref") };
    const submission = { number: 1, reserved_at: "2026-10-08T10:00:00Z", validated: false, diagnostic: "Needs a decision", tentative: { status: "unaccepted_generation" as const, context: digest("context"), raw_response: { private_row: "never dump me" } } };
    const episode = { id: randomUUID(), context: digest("context"), started_at: "2026-10-08T10:00:00Z", submissions: [submission] };
    const id = `source:${episode.id}:1`;
    const s = projectAuthoringOperationHistory({ source_snapshots: [{ session_id: "source", snapshot }], coverage_episodes: [{ session_id: "source", episode }],
      access: [allow("source", "source:snapshot:1", snapshot), allow("source", id, submission)] });
    expect(JSON.stringify(s)).toContain(snapshot.text); expect(JSON.stringify(s)).not.toContain("never dump me");
    expect(s.entries.find(e => e.ref.part === "submission")?.availability).toBe("unavailable");
  });
  it("bounds pages and rejects foreign refs and tampered projections without latest-record fallback", () => {
    const records = Array.from({ length: 3 }, question), s = projectAuthoringOperationHistory({ questions: records, access: records.map(q => allow("question", q.id, q)) });
    expect(authoringHistoryPage(s, 0).entries).toHaveLength(10); expect(authoringHistoryPage(s, 1).entries).toHaveLength(5);
    expect(() => authoringHistoryPage(s, 0, 11)).toThrow("INVALID"); expect(() => authoringHistoryPage(s, 2)).toThrow("INVALID");
    expect(() => exactAuthoringHistoryEntry(s, { ...s.entries[0]!.ref, record_digest: digest("foreign") })).toThrow("INVALID");
    expect(() => exactAuthoringHistoryEntry({ ...s, entries: [] }, s.entries[0]!.ref)).toThrow("projection changed");
    expect(exactAuthoringHistoryEntry(s, s.entries[0]!.ref)).toEqual(s.entries[0]);
  });
  it("uses bounded local pager and stops on stale exact selection before displaying", async () => {
    const records = Array.from({ length: 3 }, question), snapshot = projectAuthoringOperationHistory({ questions: records, access: records.map(q => allow("question", q.id, q)) });
    const choices = ["next", "entry:0", "back"], session = { chooseOption: vi.fn(async (_title: string, _choices: unknown, _options: unknown) => choices.shift()), showReviewDetails: vi.fn(async () => {}) };
    const current = vi.fn(async () => {});
    await presentAuthoringOperationHistory({ snapshot, session, assertCurrent: current });
    expect(session.showReviewDetails).toHaveBeenCalledOnce(); expect(session.chooseOption.mock.calls[0]?.[2]).toMatchObject({ localOnly: true, decisionKind: "business_review" });
    const stale = vi.fn(async () => {}), display = vi.fn(async () => {});
    await expect(presentAuthoringOperationHistory({ snapshot, assertCurrent: stale, session: { showReviewDetails: display,
      chooseOption: async () => { stale.mockRejectedValue(new Error("changed")); return "entry:0"; } } })).rejects.toThrow("changed");
    expect(display).not.toHaveBeenCalled();
  });
});
