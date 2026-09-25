import { describe, expect, it } from "vitest";
import { protocolVersions } from "@synapsor-runner/protocol";
import { formatChangeLines, proposalNextCommands } from "./cli-format.js";

describe("proposal change presentation", () => {
  it("does not present an unread old value as unset", () => {
    const proposal = {
      change_set: {
        schema_version: protocolVersions.changeSetV2,
        patch: { base_monthly_cents: 4500, nullable_note: null, observed_limit: 20 },
        before: { record_id: "subscription-1", version: 4, nullable_note: null, observed_limit: 24 },
        after: { base_monthly_cents: 4500, nullable_note: null, observed_limit: 20 },
      },
    } as never;

    expect(formatChangeLines(proposal)).toEqual([
      "  base_monthly_cents: not observed (not read) -> 4500",
      "  nullable_note: null -> null",
      "  observed_limit: 24 -> 20",
    ]);
  });
});

describe("delayed proposal next step", () => {
  it("does not advertise approval after the original pending-human deadline", () => {
    const proposal = { proposal_id: "p_delayed", state: "pending_review", change_set: {
      schema_version: protocolVersions.changeSetV4,
      delayed_work: { requested_at: new Date(Date.now() - 120_000).toISOString(),
        approval_wait_seconds: 60, absolute_request_age_seconds: 3_600 },
    } } as never;
    const next = proposalNextCommands(proposal, "p_delayed", " --config reviewed.json");
    expect(next).toEqual(expect.arrayContaining([expect.stringMatching(/proposals reject p_delayed/)]));
    expect(next.join(" ")).not.toContain("proposals approve");
  });
});
