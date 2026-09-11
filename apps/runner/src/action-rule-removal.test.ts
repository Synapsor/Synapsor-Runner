import { beforeEach, describe, expect, it, vi } from "vitest";

const authority = vi.hoisted(() => ({
  listActionRuleAuthorityDrafts: vi.fn(),
  readActionRuleAuthorityActivation: vi.fn(),
  readActionRuleAuthorityRevisionBaseline: vi.fn(),
  removeOutcomeActionRuleAuthorityDraft: vi.fn(),
  deactivateActionRuleAuthorityIfCurrent: vi.fn(),
}));

vi.mock("./action-rule-authority.js", () => authority);

import { prepareSavedActionRuleRemoval, reviewFinalActionRemoval } from "./action-rule-removal.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";

const outcome = "service_appointment.change_duration_minutes";
const retained = "service_appointment.change_reminder_hours";
const pending = { authority_name: "reviewed_staging_rules", draft_digest: `sha256:${"a".repeat(64)}` };
const baseline = { projectRoot: "/fixture", drafts: {}, active: pending.draft_digest };

function authorityWith(outcomes: string[], digest = pending.draft_digest, state: "active" | "disabled" = "active") {
  return {
    schema_version: state === "active"
      ? "synapsor.action-rule-authority-activation.v1"
      : "synapsor.action-rule-authority-draft.v1",
    state,
    authority: {
      name: pending.authority_name,
      rules: outcomes.map(value => ({ rule: { outcome: value } })),
    },
    digest,
    reviews: outcomes.map(value => ({ outcome: value })),
    ...(state === "active" ? { actor: "reviewer", activated_at: "2026-09-10T00:00:00.000Z" }
      : { created_at: "2026-09-10T00:00:00.000Z" }),
  };
}

describe("prepareSavedActionRuleRemoval", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authority.readActionRuleAuthorityRevisionBaseline.mockResolvedValue(baseline);
    authority.listActionRuleAuthorityDrafts.mockResolvedValue([]);
    authority.readActionRuleAuthorityActivation.mockResolvedValue(undefined);
  });

  it("reviews final active removal through deactivation, without an empty draft or model authority", async () => {
    authority.readActionRuleAuthorityActivation.mockResolvedValue(authorityWith([outcome]));
    const removal = await prepareSavedActionRuleRemoval("/fixture", outcome);
    expect(removal).toMatchObject({ mode: "deactivate", completedDeactivation: false, digest: pending.draft_digest });
    if (removal.mode !== "deactivate") throw new Error("Wrong removal route");
    const chooseOption = vi.fn().mockResolvedValueOnce("details").mockResolvedValueOnce("pause");
    const showReviewDetails = vi.fn();
    const session = { chooseOption, showReviewDetails } as unknown as BoundaryReviewInteractiveSession;
    expect((await reviewFinalActionRemoval({ projectRoot: "/fixture", removal, session })).completed).toBe(false);
    expect(showReviewDetails).toHaveBeenCalledWith("Remove the last allowed change", expect.arrayContaining([
      expect.stringContaining(pending.draft_digest), expect.stringContaining("already-dispatched"),
    ]));
    expect(chooseOption).toHaveBeenCalledWith("REMOVE THE LAST ALLOWED CHANGE", expect.any(Array),
      expect.objectContaining({ initialValue: "pause", exactDetails: { title: "Remove the last allowed change", summaryTitle: "Removal review", lines: expect.any(Array) } }));
    expect(authority.deactivateActionRuleAuthorityIfCurrent).not.toHaveBeenCalled();
    chooseOption.mockResolvedValueOnce("remove");
    expect((await reviewFinalActionRemoval({ projectRoot: "/fixture", removal, session })).completed).toBe(true);
    expect(authority.deactivateActionRuleAuthorityIfCurrent).toHaveBeenCalledExactlyOnceWith("/fixture", baseline);
    expect(authority.removeOutcomeActionRuleAuthorityDraft).not.toHaveBeenCalled();
  });

  it("resumes exact final-action review and handles interruption after deactivation without reactivation", async () => {
    authority.readActionRuleAuthorityActivation.mockResolvedValue(authorityWith([outcome]));
    const checkpoint = { ...pending, mode: "deactivate" as const };
    expect(await prepareSavedActionRuleRemoval("/fixture", outcome, checkpoint))
      .toMatchObject({ mode: "deactivate", completedDeactivation: false });
    authority.readActionRuleAuthorityActivation.mockResolvedValue(undefined);
    const removal = await prepareSavedActionRuleRemoval("/fixture", outcome, checkpoint);
    if (removal.mode !== "deactivate") throw new Error("Wrong removal route");
    const chooseOption = vi.fn();
    const result = await reviewFinalActionRemoval({ projectRoot: "/fixture", removal,
      session: { chooseOption } as unknown as BoundaryReviewInteractiveSession });
    expect(result.completed).toBe(true);
    expect(chooseOption).not.toHaveBeenCalled();
    expect(authority.deactivateActionRuleAuthorityIfCurrent).not.toHaveBeenCalled();
  });

  it.each(["changed_digest", "new_outcome", "new_draft"])("refuses stale final-removal consent (%s)", async change => {
    authority.readActionRuleAuthorityActivation.mockResolvedValue(authorityWith(change === "new_outcome" ? [outcome, retained] : [outcome],
      change === "changed_digest" ? `sha256:${"b".repeat(64)}` : pending.draft_digest));
    if (change === "new_draft") authority.listActionRuleAuthorityDrafts.mockResolvedValue([authorityWith([outcome], `sha256:${"c".repeat(64)}`, "disabled")]);
    await expect(prepareSavedActionRuleRemoval("/fixture", outcome, { ...pending, mode: "deactivate" }))
      .rejects.toThrow("ACTION_RULE_REMOVAL_REVIEW_CHANGED");
    expect(authority.deactivateActionRuleAuthorityIfCurrent).not.toHaveBeenCalled();
  });

  it("recognizes an exact activated replacement as a completed removal", async () => {
    const active = authorityWith([retained]);
    authority.readActionRuleAuthorityActivation.mockResolvedValue(active);

    const result = await prepareSavedActionRuleRemoval("/fixture", outcome, pending);

    expect(result).toMatchObject({ draft: { state: "disabled", authority: active.authority, digest: active.digest,
      reviews: active.reviews, created_at: "2026-09-10T00:00:00.000Z" }, active, alreadyRemoved: true, completedActivation: true,
      removedOutcome: outcome, retainedOutcomes: [retained] });
    expect(authority.removeOutcomeActionRuleAuthorityDraft).not.toHaveBeenCalled();
  });

  it("does not treat a changed active authority as the saved completed removal", async () => {
    authority.readActionRuleAuthorityActivation.mockResolvedValue(authorityWith([retained], `sha256:${"b".repeat(64)}`));

    await expect(prepareSavedActionRuleRemoval("/fixture", outcome, pending))
      .rejects.toThrow("ACTION_RULE_REMOVAL_REVIEW_CHANGED");
    expect(authority.removeOutcomeActionRuleAuthorityDraft).not.toHaveBeenCalled();
  });

  it("does not accept an active authority that still contains the removed outcome", async () => {
    authority.readActionRuleAuthorityActivation.mockResolvedValue(authorityWith([retained, outcome]));

    await expect(prepareSavedActionRuleRemoval("/fixture", outcome, pending))
      .rejects.toThrow("ACTION_RULE_REMOVAL_REVIEW_CHANGED");
    expect(authority.removeOutcomeActionRuleAuthorityDraft).not.toHaveBeenCalled();
  });

  it("keeps a matching disabled review resumable without calling it activated", async () => {
    const draft = authorityWith([retained], pending.draft_digest, "disabled");
    authority.listActionRuleAuthorityDrafts.mockResolvedValue([draft]);

    const result = await prepareSavedActionRuleRemoval("/fixture", outcome, pending);

    expect(result).toMatchObject({ draft, alreadyRemoved: true, retainedOutcomes: [retained] });
    expect("completedActivation" in result).toBe(false);
    expect(authority.removeOutcomeActionRuleAuthorityDraft).not.toHaveBeenCalled();
  });
});
