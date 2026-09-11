import { describe, expect, it } from "vitest";
import { protocolVersions } from "@synapsor-runner/protocol";
import { formatChangeLines } from "./cli-format.js";

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
