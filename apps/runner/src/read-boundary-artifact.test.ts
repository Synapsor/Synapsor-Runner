import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  READ_BOUNDARY_DRAFT_FILE_VERSION,
  READ_BOUNDARY_ACTIVE_FILE_VERSION,
  READ_BOUNDARY_PAYLOAD_VERSION,
  ReadBoundaryArtifactError,
  decodeReadBoundaryDraftFile,
  decodeReadBoundaryActiveFile,
  encodeReadBoundaryDraftFile,
  encodeReadBoundaryActiveFile,
  type ReadBoundaryPayloadAssertion,
} from "./read-boundary-artifact.js";

// Pure format fixtures, not activated authority. Genuine supported loaders,
// native custody, review receipts and old-reader public refusal belong to Main's
// SC04 controls. No actor, completion, approval or activation receipt is invented.
type FormatPayload = {
  schema_version: typeof READ_BOUNDARY_PAYLOAD_VERSION;
  activation: "disabled_unreviewed" | { state: "active"; opaque_proof: string };
  opaque_payload: { name: string; bytes: string; sequence: number[] };
};
function draft(): FormatPayload {
  return { schema_version: READ_BOUNDARY_PAYLOAD_VERSION, activation: "disabled_unreviewed",
    opaque_payload: { name: "  ΔECLARED Name  ", bytes: "line1\nline2\t世界", sequence: [3, 1, 2] } };
}
function active(): FormatPayload {
  return { ...draft(), activation: { state: "active", opaque_proof: "codec fixture only; not native authority" } };
}
const assertPayload: ReadBoundaryPayloadAssertion<FormatPayload> = (value): asserts value is FormatPayload => {
  if (!value || typeof value !== "object" || !("opaque_payload" in value)
    || !value.opaque_payload || typeof value.opaque_payload !== "object"
    || !("bytes" in value.opaque_payload) || typeof value.opaque_payload.bytes !== "string") {
    throw Object.assign(new Error("TEST_PAYLOAD_INVALID"), { code: "TEST_PAYLOAD_INVALID" });
  }
};
function assertionSpy() {
  const calls = vi.fn();
  const assertion: ReadBoundaryPayloadAssertion<FormatPayload> = (value): asserts value is FormatPayload => {
    calls(value); assertPayload(value);
  };
  return { calls, assertion };
}

// There was no previous envelope codec. These are prospective pure contract
// controls; they are not labeled failing-before evidence against an old loader.
describe("strict Read artifact file envelopes", () => {
  it.each([
    ["draft", draft, encodeReadBoundaryDraftFile, decodeReadBoundaryDraftFile, READ_BOUNDARY_DRAFT_FILE_VERSION],
    ["active", active, encodeReadBoundaryActiveFile, decodeReadBoundaryActiveFile, READ_BOUNDARY_ACTIVE_FILE_VERSION],
  ] as const)("%s wraps only version and exact payload, preserving canonical digest", (_kind, create, encode, decode, version) => {
    const original = create(); const before = structuredClone(original); const digest = canonicalJsonDigest(original);
    const { calls, assertion } = assertionSpy();
    const encoded = encode(original, assertion);
    expect(Object.keys(encoded).sort()).toEqual(["boundary", "schema_version"]);
    expect(encoded.schema_version).toBe(version);
    expect(encoded.boundary).toEqual(before);
    expect(canonicalJsonDigest(encoded.boundary)).toBe(digest);
    expect(original).toEqual(before);
    const serialized = JSON.stringify(encoded);
    const decoded = decode(JSON.parse(serialized), assertion);
    expect(decoded).toEqual(before);
    expect(canonicalJsonDigest(decoded)).toBe(digest);
    expect(JSON.stringify(encoded)).toBe(serialized);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it.each([
    null, [], {}, "text", 3,
    { schema_version: READ_BOUNDARY_DRAFT_FILE_VERSION },
    { schema_version: READ_BOUNDARY_DRAFT_FILE_VERSION, boundary: null },
    { schema_version: READ_BOUNDARY_DRAFT_FILE_VERSION, boundary: [] },
    { schema_version: READ_BOUNDARY_DRAFT_FILE_VERSION, boundary: {} },
    { schema_version: READ_BOUNDARY_DRAFT_FILE_VERSION, boundary: draft(), pack: { resources: [] } },
    { schema_version: READ_BOUNDARY_DRAFT_FILE_VERSION, boundary: draft(), activation: "disabled_unreviewed" },
    { schema_version: READ_BOUNDARY_DRAFT_FILE_VERSION, boundary: draft(), legacy: true },
  ])("malformed draft wrapper refuses before payload validation: %#", (value) => {
    const { calls, assertion } = assertionSpy(); const before = structuredClone(value);
    expect(() => decodeReadBoundaryDraftFile(value, assertion)).toThrow(ReadBoundaryArtifactError);
    expect(calls).not.toHaveBeenCalled(); expect(value).toEqual(before);
  });

  it.each([
    draft(), active(),
    { schema_version: "synapsor.exploration-boundary-draft-file.v0", boundary: draft() },
    { schema_version: "synapsor.exploration-boundary-draft-file.v99", boundary: draft() },
    { schema_version: READ_BOUNDARY_ACTIVE_FILE_VERSION, boundary: active() },
    { schema_version: READ_BOUNDARY_DRAFT_FILE_VERSION, boundary: { ...draft(), schema_version: "synapsor.exploration-boundary.v1" } },
    { schema_version: READ_BOUNDARY_DRAFT_FILE_VERSION, boundary: { ...draft(), schema_version: "synapsor.exploration-boundary.v99" } },
    { schema_version: READ_BOUNDARY_DRAFT_FILE_VERSION, boundary: active() },
    { schema_version: READ_BOUNDARY_DRAFT_FILE_VERSION, boundary: { ...draft(), activation: "disabled" } },
    { schema_version: READ_BOUNDARY_DRAFT_FILE_VERSION, boundary: { ...draft(), activation: undefined } },
  ])("old, unknown or wrong-kind draft input has no fallback: %#", (value) => {
    const { calls, assertion } = assertionSpy(); const before = structuredClone(value);
    expect(() => decodeReadBoundaryDraftFile(value, assertion)).toThrow(ReadBoundaryArtifactError);
    expect(calls).not.toHaveBeenCalled(); expect(value).toEqual(before);
  });

  it.each([
    active(),
    { schema_version: READ_BOUNDARY_DRAFT_FILE_VERSION, boundary: draft() },
    { schema_version: READ_BOUNDARY_ACTIVE_FILE_VERSION, boundary: draft() },
    { schema_version: READ_BOUNDARY_ACTIVE_FILE_VERSION, boundary: { ...active(), activation: {} } },
    { schema_version: READ_BOUNDARY_ACTIVE_FILE_VERSION, boundary: { ...active(), activation: { state: "pending" } } },
    { schema_version: READ_BOUNDARY_ACTIVE_FILE_VERSION, boundary: { ...active(), activation: "active" } },
    { schema_version: READ_BOUNDARY_ACTIVE_FILE_VERSION, boundary: { ...active(), activation: undefined } },
    { schema_version: READ_BOUNDARY_ACTIVE_FILE_VERSION, boundary: active(), activation: { state: "active" } },
    { schema_version: READ_BOUNDARY_ACTIVE_FILE_VERSION, boundary: { ...active(), schema_version: "synapsor.exploration-boundary.v1" } },
  ])("active decoder refuses wrong status/flat projection before callback: %#", (value) => {
    const { calls, assertion } = assertionSpy(); const before = structuredClone(value);
    expect(() => decodeReadBoundaryActiveFile(value, assertion)).toThrow(ReadBoundaryArtifactError);
    expect(calls).not.toHaveBeenCalled(); expect(value).toEqual(before);
  });

  it("keeps existing full-payload validation mandatory and preserves its refusal", () => {
    const source = { schema_version: READ_BOUNDARY_ACTIVE_FILE_VERSION, boundary: active() };
    const before = structuredClone(source);
    const failure = Object.assign(new Error("ACTUAL_PAYLOAD_AUTHORITY_REJECTED"), { code: "ACTUAL_PAYLOAD_AUTHORITY_REJECTED" });
    const reject: ReadBoundaryPayloadAssertion<FormatPayload> = (_value): asserts _value is FormatPayload => { throw failure; };
    expect(() => decodeReadBoundaryActiveFile(source, reject)).toThrow(failure);
    expect(() => encodeReadBoundaryActiveFile(active(), reject)).toThrow(failure);
    expect(source).toEqual(before);
  });

  it.each(["encode", "decode"] as const)("%s refuses callback normalization without modifying original payload", (mode) => {
    const source = draft(); const before = structuredClone(source);
    const mutating: ReadBoundaryPayloadAssertion<FormatPayload> = (value): asserts value is FormatPayload => {
      assertPayload(value); value.opaque_payload.name = value.opaque_payload.name.trim();
    };
    const run = mode === "encode"
      ? () => encodeReadBoundaryDraftFile(source, mutating)
      : () => decodeReadBoundaryDraftFile({ schema_version: READ_BOUNDARY_DRAFT_FILE_VERSION, boundary: source }, mutating);
    expect(run).toThrowError(/READ_BOUNDARY_ARTIFACT_NORMALIZATION_REFUSED/);
    expect(source).toEqual(before);
  });

  it.each([false, true, { replacement: true }, { then: () => { throw new Error("foreign thenable must not execute"); } }])(
    "runtime non-assertion result refuses without substitution: %#", (returned) => {
      const validator = (() => returned) as unknown as ReadBoundaryPayloadAssertion<FormatPayload>;
      expect(() => decodeReadBoundaryDraftFile({ schema_version: READ_BOUNDARY_DRAFT_FILE_VERSION, boundary: draft() }, validator))
        .toThrowError(/READ_BOUNDARY_ARTIFACT_VALIDATOR_INVALID/);
    });

  it("requires a validator at runtime and refuses async assertions without unhandled rejection", async () => {
    const raw = { schema_version: READ_BOUNDARY_DRAFT_FILE_VERSION, boundary: draft() };
    expect(() => decodeReadBoundaryDraftFile(raw, undefined as unknown as ReadBoundaryPayloadAssertion<FormatPayload>))
      .toThrowError(/READ_BOUNDARY_ARTIFACT_VALIDATOR_REQUIRED/);
    for (const validator of [() => Promise.resolve(), () => Promise.reject(new Error("async assertion refused"))]) {
      expect(() => decodeReadBoundaryDraftFile(raw, validator as unknown as ReadBoundaryPayloadAssertion<FormatPayload>))
        .toThrowError(/READ_BOUNDARY_ARTIFACT_VALIDATOR_INVALID/);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("is a file-format projection, not an alias through which a caller can mutate saved payload", () => {
    const source = draft(); const before = structuredClone(source);
    const encoded = encodeReadBoundaryDraftFile(source, assertPayload);
    encoded.boundary.opaque_payload.bytes = "new file candidate";
    expect(source).toEqual(before);
    const raw = { schema_version: READ_BOUNDARY_DRAFT_FILE_VERSION, boundary: draft() };
    const decoded = decodeReadBoundaryDraftFile(raw, assertPayload);
    decoded.opaque_payload.sequence.push(4);
    expect(raw.boundary).toEqual(before);
  });

  it("does not lend the returned payload to a validator's retained mutable alias", () => {
    let lent: FormatPayload | undefined;
    const capture: ReadBoundaryPayloadAssertion<FormatPayload> = (value): asserts value is FormatPayload => {
      assertPayload(value); lent = value;
    };
    const result = decodeReadBoundaryDraftFile({ schema_version: READ_BOUNDARY_DRAFT_FILE_VERSION, boundary: draft() }, capture);
    lent!.opaque_payload.bytes = "changed after callback returned";
    expect(result).toEqual(draft());
  });

  it("does not reinterpret inherited wrapper fields or unknown exact discriminator spelling", () => {
    const { calls, assertion } = assertionSpy();
    const inherited = Object.create({ schema_version: READ_BOUNDARY_DRAFT_FILE_VERSION, boundary: draft() });
    expect(() => decodeReadBoundaryDraftFile(inherited, assertion)).toThrow(ReadBoundaryArtifactError);
    expect(() => decodeReadBoundaryDraftFile({ schema_version: ` ${READ_BOUNDARY_DRAFT_FILE_VERSION}`, boundary: draft() }, assertion)).toThrow(ReadBoundaryArtifactError);
    expect(calls).not.toHaveBeenCalled();
  });
});
