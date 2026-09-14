import { afterEach, describe, expect, it, vi } from "vitest";
import * as resumeStore from "./boundary-authoring-resume.js";
import * as readStore from "./control-policy-read-authoring-project.js";
import { actionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import { readSavedActionJobReview, unfinishedActionIntents } from "./saved-action-job-review.js";

const digest = `sha256:${"a".repeat(64)}` as const;
const binding = { boundary_name: "reviewed_staging", generation_lock_fingerprint: digest,
  schema_fingerprint: digest, role_posture_fingerprint: digest };
const base = { binding, stage: "action_drafting" as const, jobIntent: "Help students register and resolve advising holds.",
  provider: "openai" as const, model: "gpt-test" };
const intents = ["Accept an eligible offered seat.", "Restore an erroneous prerequisite drop.", "Release a completed advising hold."];
const outcomes = ["university.accept_seat", "university.restore_drop", "university.release_hold"];
const action = { intent: intents[0]!, intents, completed_outcomes: outcomes.slice(0, 2), strategy: "rule_derived" as const };
const state = (changes: Partial<Parameters<typeof resumeStore.buildBoundaryAuthoringResumeState>[0]> = {}) =>
  resumeStore.buildBoundaryAuthoringResumeState({ ...base, action, ...changes });

afterEach(() => vi.restoreAllMocks());

describe("saved Action job review", () => {
  it("keeps migrated authority review available when its optional guided authoring history is absent", async () => {
    vi.spyOn(readStore, "readProjectReadAuthoring").mockRejectedValue(Object.assign(new Error("missing history"), {
      code: "POLICY_READ_AUTHORING_MISSING",
    }));
    const reader = vi.spyOn(resumeStore, "readBoundaryAuthoringResumeState");
    const result = await readSavedActionJobReview({ projectRoot: "/test-project", boundaryName: binding.boundary_name,
      currentOutcomes: outcomes.slice(0, 2) });
    expect(result.summary.join("\n")).toContain("Saved job status unavailable");
    expect(result.details.join("\n")).toContain("does not establish that the whole job is complete");
    expect(result.detailsLabel).toBe("View saved job status");
    expect(reader).not.toHaveBeenCalled();
  });

  it.each(["POLICY_INTEGRITY_INVALID", "POLICY_AUTHORING_STORE_CHANGED", "SQLITE_BUSY"])(
    "does not hide repository failures (%s) as missing guided history", async code => {
      const failure = Object.assign(new Error("repository failure"), { code });
      vi.spyOn(readStore, "readProjectReadAuthoring").mockRejectedValue(failure);
      const reader = vi.spyOn(resumeStore, "readBoundaryAuthoringResumeState");
      await expect(readSavedActionJobReview({ projectRoot: "/test-project", boundaryName: binding.boundary_name,
        currentOutcomes: outcomes })).rejects.toBe(failure);
      expect(reader).not.toHaveBeenCalled();
    });

  it("keeps concurrent explicit review environments separate without consulting ambient credentials", async () => {
    const ambient = process.env.TEST_POLICY_URL;
    const first = { TEST_POLICY_URL: "first scoped store" };
    const second = { TEST_POLICY_URL: "second scoped store" };
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    vi.spyOn(readStore, "readProjectReadAuthoring").mockImplementation(async (_root, env) => {
      await Promise.resolve();
      seen.push(env);
      if (env !== first && env !== second) throw new Error("explicit review environment lost");
      return undefined;
    });
    const input = { projectRoot: "/test-project", boundaryName: binding.boundary_name, currentOutcomes: outcomes };
    await expect(Promise.all([readSavedActionJobReview({ ...input, env: first }),
      readSavedActionJobReview({ ...input, env: second })])).resolves.toEqual([
      { summary: [], details: [] }, { summary: [], details: [] },
    ]);
    expect(seen).toEqual([first, second]);
    expect(process.env.TEST_POLICY_URL).toBe(ambient);
    await expect(readSavedActionJobReview({ ...input, env: {} })).rejects.toThrow("explicit review environment lost");
  });

  it("distinguishes two prepared outcomes from an unfinished third request without changing the checkpoint", () => {
    const saved = state();
    const before = structuredClone(saved);
    expect(unfinishedActionIntents(saved, outcomes.slice(0, 2))).toEqual([intents[2]]);
    expect(saved).toEqual(before);
    expect(unfinishedActionIntents(state({ action: { ...action, completed_outcomes: outcomes } }), outcomes)).toEqual([]);
  });

  it("does not count saved completion if its outcome is absent from the reviewed authority", () => {
    expect(unfinishedActionIntents(state({ action: { ...action, completed_outcomes: outcomes } }), [outcomes[0]!]))
      .toEqual(intents.slice(1));
  });

  it("preserves an unfinished standalone addition when earlier outcomes are reviewed separately", () => {
    const saved = state({ action: { intent: intents[2]!, checkpoint: actionRuleAuthoringCheckpoint({
      intent_digest: digest, context_digest: digest, components: {}, operator_messages: ["Save pending the missing limits."],
    }) } });
    expect(unfinishedActionIntents(saved, outcomes.slice(0, 2))).toEqual([intents[2]]);
  });

  it("recognizes old single-action review checkpoints, but not merely selecting an outcome during drafting", () => {
    const single = { intent: intents[0]!, outcome: outcomes[0] };
    for (const stage of ["authority_review", "client_setup"] as const) {
      expect(unfinishedActionIntents(state({ stage, action: single }), outcomes)).toEqual([]);
    }
    expect(unfinishedActionIntents(state({ action: single }), outcomes)).toEqual([intents[0]]);
  });

  it("marks the reopened outcome and remaining clarification, not an unrelated earlier intent", () => {
    const checkpoint = actionRuleAuthoringCheckpoint({ intent_digest: digest, context_digest: digest, components: {},
      reopened_draft: { outcome: outcomes[1]!, digest, covered_intent_indexes: [0] } });
    expect(unfinishedActionIntents(state({ action: { ...action, checkpoint } }), outcomes)).toEqual(intents.slice(1));
  });

  it("keeps pending edits, removals and cited additions visible independently of already compiled outcomes", () => {
    const completed = { ...action, completed_outcomes: outcomes };
    const edit = { outcome: outcomes[0]!, instruction: "Require current admission.", baseline_digest: digest };
    const removal = { outcome: outcomes[1]!, authority_name: "university_rules", draft_digest: digest };
    expect(unfinishedActionIntents(state({ action: completed, pendingActionRevision: edit, pendingActionRemoval: removal }), outcomes))
      .toEqual(["Requested edit: Require current admission.", `Requested removal: ${outcomes[1]}`]);
    expect(unfinishedActionIntents(state({ action: completed, pendingActionAddition: { policy_source_digest: digest,
      source_ranges: [{ start: 20, end: 22 }], retained_action: completed } }), outcomes))
      .toEqual(["Additional behavior from attached rules, lines 20-22"]);
  });

  it.each(["none", "ready", "stale", "invalid"] as const)("loads %s state locally and never treats failed status verification as job completion", async status => {
    vi.spyOn(readStore, "readProjectReadAuthoring").mockResolvedValue({ selected: {
      progress: { candidate: { pack: { name: binding.boundary_name }, generation_lock_fingerprint: digest } },
      draft_lock: { schema_fingerprint: digest, role_posture_fingerprint: digest },
    } } as never);
    const saved = state();
    const load = status === "ready" ? { status, value: saved } : status === "stale" ? { status, value: saved, reason: "database schema changed" }
      : status === "invalid" ? { status, reason: "Saved setup integrity check failed." } : { status };
    const reader = vi.spyOn(resumeStore, "readBoundaryAuthoringResumeState").mockResolvedValue(load);
    const result = await readSavedActionJobReview({ projectRoot: "/test-project", boundaryName: binding.boundary_name,
      currentOutcomes: outcomes.slice(0, 2) });
    expect(reader).toHaveBeenCalledExactlyOnceWith("/test-project", binding);
    if (status === "none") expect(result).toEqual({ summary: [], details: [] });
    else if (status === "ready") {
      expect(result.summary.join("\n")).toContain("1 requested change remains unfinished");
      expect(result.details).toContain(`1. ${intents[2]}`);
    } else {
      expect(result.summary.join("\n")).toContain("Saved job status needs review");
      expect(result.details.join("\n")).toContain(load.reason);
    }
  });

  it("does not project a job from a different selected Read boundary", async () => {
    vi.spyOn(readStore, "readProjectReadAuthoring").mockResolvedValue({ selected: {
      progress: { candidate: { pack: { name: "another_boundary" } } },
    } } as never);
    const reader = vi.spyOn(resumeStore, "readBoundaryAuthoringResumeState");
    expect(await readSavedActionJobReview({ projectRoot: "/test-project", boundaryName: binding.boundary_name,
      currentOutcomes: outcomes })).toEqual({ summary: [], details: [] });
    expect(reader).not.toHaveBeenCalled();
  });
});
