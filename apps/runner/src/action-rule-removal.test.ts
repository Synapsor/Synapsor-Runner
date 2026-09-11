import { beforeEach, describe, expect, it, vi } from "vitest";

const authority = vi.hoisted(() => ({
  listActionRuleAuthorityDrafts: vi.fn(),
  readActionRuleAuthorityActivation: vi.fn(),
  readActionRuleAuthorityRevisionBaseline: vi.fn(),
  removeOutcomeActionRuleAuthorityDraft: vi.fn(),
}));

vi.mock("./action-rule-authority.js", () => authority);

import { prepareSavedActionRuleRemoval } from "./action-rule-removal.js";

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
