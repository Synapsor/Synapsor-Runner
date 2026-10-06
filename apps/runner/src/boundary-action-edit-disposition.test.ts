import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { actionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import { prepareBoundaryActionEditDisposition, assertBoundaryActionEditDispositionsAdvance } from "./boundary-authoring-resume.js";
import { ownedProgramDraft } from "./test-fixtures/owned-authoring-program.js";

describe("exact current Action edit disposition", () => {
  const digest = canonicalJsonDigest;
  const current = ownedProgramDraft(1);
  const checkpoint = actionRuleAuthoringCheckpoint({ intent_digest: digest("pending edit"), context_digest: digest("original baseline"),
    components: {}, logical_turns: [{ id: "00000000-0000-4000-8000-000000000001", origin_context_digest: digest("original turn"),
      iterations_used: 12, tool_calls_used: 24, wording_correction_used: true, used_version_corrections: ["00000000-0000-4000-8000-000000000002"] }] });
  const pending = { outcome: current.outcome, instruction: "Keep all peers while changing this rule.", baseline_digest: digest("original candidate"), checkpoint };
  const input = { pending, current_draft: current, current_baseline_digest: digest(current), read_digest: digest("current Read"),
    authority_digest: digest("current disabled authority"), generation_recovery_digest: digest("original partial operation remains partial"),
    choice: "keep_current" as const, actor: "fixture reviewer" };
  it("archives exact counters/corrections without creating completion or policy evidence", () => {
    const record = prepareBoundaryActionEditDisposition(input);
    expect(record.pending).toEqual(pending);
    expect(record.pending.checkpoint!.logical_turns![0]).toMatchObject({ iterations_used: 12, tool_calls_used: 24, wording_correction_used: true });
    expect(record.current_draft).toEqual(current);
    expect(record).not.toHaveProperty("coverage_report"); expect(record).not.toHaveProperty("completion");
    expect(input.pending).toEqual(pending);
    assertBoundaryActionEditDispositionsAdvance([], [record]);
  });
  it("refuses checkpoint erasure disguised as a rebase and a mismatched candidate", () => {
    expect(() => prepareBoundaryActionEditDisposition({ ...input, choice: "edit_current" })).toThrow("RESUME_INVALID");
    expect(() => prepareBoundaryActionEditDisposition({ ...input, current_baseline_digest: digest("another candidate") })).toThrow("RESUME_INVALID");
  });
  it("keeps disposition history append-only", () => {
    const first = prepareBoundaryActionEditDisposition(input), second = prepareBoundaryActionEditDisposition(input);
    expect(() => assertBoundaryActionEditDispositionsAdvance([first], [])).toThrow("append-only");
    expect(() => assertBoundaryActionEditDispositionsAdvance([first], [{ ...first, actor: "replacement actor" }])).toThrow("append-only");
    expect(() => assertBoundaryActionEditDispositionsAdvance([first], [first, second])).not.toThrow();
  });
});
