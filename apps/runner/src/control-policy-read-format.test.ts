import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { decodeOperatorAuthority, encodeOperatorAuthority } from "./control-policy-authority-codec.js";
import { OPERATOR_POLICY_RECORD_VERSION } from "./control-policy-record.js";

describe("Read-family native outer format", () => {
  it("uses the new Read envelope for the actual management selection record", () => {
    const input = { type: "read_selection" as const, selected_name: null };
    const record = encodeOperatorAuthority(input);
    expect(record.content).toMatchObject({ schema_version: "synapsor.stored-operator-authority/v2", ...input });
    expect(record.authority_digest).toBe(canonicalJsonDigest(input));
    expect(decodeOperatorAuthority(record)).toMatchObject(input);
  });

  it("refuses a prior Read envelope even when its content and revision hashes are valid", () => {
    const record = encodeOperatorAuthority({ type: "read_selection", selected_name: null });
    const content = { ...(record.content as Record<string, unknown>), schema_version: "synapsor.stored-operator-authority/v1" };
    const digest = canonicalJsonDigest(content);
    const older = { ...record, content, content_digest: digest, revision_id: `policy:${digest.slice(7)}` };
    const before = structuredClone(older);
    expect(() => decodeOperatorAuthority(older)).toThrow();
    expect(older).toEqual(before);
  });

  it("does not change the format constant used by Action and execution", () => {
    expect(OPERATOR_POLICY_RECORD_VERSION).toBe("synapsor.stored-operator-authority/v1");
  });
});
