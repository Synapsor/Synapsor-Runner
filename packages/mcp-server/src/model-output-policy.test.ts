import { describe, expect, it } from "vitest";
import {
  modelAuthorityMetadataMode,
  projectAuthorityMetadataForModel,
} from "./model-output-policy.js";

const digest = `sha256:${"a".repeat(64)}`;

describe("model authority metadata policy", () => {
  it("defaults to semantic metadata and accepts an explicit exact mode", () => {
    expect(modelAuthorityMetadataMode(undefined)).toBe("semantic");
    expect(modelAuthorityMetadataMode({})).toBe("semantic");
    expect(modelAuthorityMetadataMode({
      model_output: { authority_metadata: "exact" },
    })).toBe("exact");
    expect(modelAuthorityMetadataMode({
      model_output: { authority_metadata: "unsupported" as "exact" },
    })).toBe("semantic");
  });

  it("withholds exact Runner metadata without altering source rows", () => {
    const input = {
      ok: true,
      boundary_digest: digest,
      active_boundary_set_digest: digest,
      boundaries: [{ name: "finance", digest }],
      outcome: {
        type: "success",
        result: {
          query_audit_handle: digest,
          decision_hash: digest,
          actor_fingerprint: digest,
        },
      },
      audit: {
        query_fingerprint: digest,
        evidence_bundle_id: "ev_keep_for_resource_access",
      },
      data: [{
        digest,
        boundary_digest: digest,
        ordinary_value: "kept",
      }],
      diff: {
        content_hash: { before: digest, proposed: digest },
      },
    };

    const projected = projectAuthorityMetadataForModel(input, "semantic");

    expect(projected.withheld).toBe(true);
    expect(projected.value).not.toHaveProperty("boundary_digest");
    expect(projected.value).not.toHaveProperty("active_boundary_set_digest");
    expect(projected.value).toMatchObject({
      boundaries: [{ name: "finance" }],
      outcome: { type: "success", result: {} },
      audit: { evidence_bundle_id: "ev_keep_for_resource_access" },
      data: [{
        digest,
        boundary_digest: digest,
        ordinary_value: "kept",
      }],
      diff: {
        content_hash: { before: digest, proposed: digest },
      },
    });
    expect(input.boundary_digest).toBe(digest);
  });

  it("retains exact metadata unchanged in diagnostic mode", () => {
    const input = {
      boundary_digest: digest,
      details: { proof_digest: digest },
    };
    const projected = projectAuthorityMetadataForModel(input, "exact");
    expect(projected).toEqual({ value: input, withheld: false });
    expect(projected.value).not.toBe(input);
  });
});
