import { describe, expect, it } from "vitest";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { bindBoundaryAuthoringReadAnalysis } from "./boundary-authoring-resume.js";

describe("native Read analysis rebinding", () => {
  const previous = { analysis_id: "saved-analysis", analysis_digest: d("immutable analysis"), scope_question_id: "exact-native-question" };
  it("retains the exact scope question when saving or reusing the same immutable analysis", () => {
    expect(bindBoundaryAuthoringReadAnalysis(previous, previous)).toEqual(previous);
  });
  it.each([{ analysis_id: "different-analysis", analysis_digest: previous.analysis_digest },
    { analysis_id: previous.analysis_id, analysis_digest: d("changed analysis") }])("does not transfer a confirmed scope to another identity %j", next => {
    expect(bindBoundaryAuthoringReadAnalysis(previous, next)).toEqual(next);
    expect(previous.scope_question_id).toBe("exact-native-question");
  });
  it("does not invent a question when none has been recorded", () => {
    const next = { analysis_id: previous.analysis_id, analysis_digest: previous.analysis_digest };
    expect(bindBoundaryAuthoringReadAnalysis(undefined, next)).toEqual(next);
  });
});
