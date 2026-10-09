import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { STRUCTURED_AUTHORING_PROTOCOL_VERSION, STRUCTURED_AUTHORING_RESUME_VERSION, parseStructuredAuthoringProtocol,
  assertCurrentAuthoringEnvelope, assertAuthoringProtocolUnchanged, OLDER_AUTHORING_SETUP_MESSAGE } from "./authoring-protocol.js";
import { actionRuleAuthoringCheckpoint, parseActionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
const hash = canonicalJsonDigest("bounded version format fixture");
const seal = (body: Record<string, unknown>) => { const { digest: _, ...fields } = body; return { ...fields, digest: canonicalJsonDigest(fields) }; };
describe("prospective requirement native format reservations", () => {
  it("requires protocol5, Resume6 and checkpoint4 without protocol fallback", () => {
    expect(STRUCTURED_AUTHORING_PROTOCOL_VERSION).toBe("synapsor.structured-authoring.v5");
    expect(STRUCTURED_AUTHORING_RESUME_VERSION).toBe("synapsor.boundary-authoring-resume.v6");
    const authoring_protocol = { version: STRUCTURED_AUTHORING_PROTOCOL_VERSION };
    expect(() => assertCurrentAuthoringEnvelope({ schema_version: STRUCTURED_AUTHORING_RESUME_VERSION, authoring_protocol })).not.toThrow();
    const checkpoint = actionRuleAuthoringCheckpoint({ authoring_protocol, intent_digest: hash, context_digest: hash, components: {} });
    expect(checkpoint.schema_version).toBe("synapsor.action-authoring-checkpoint.v4");
    expect(parseActionRuleAuthoringCheckpoint(JSON.parse(JSON.stringify(checkpoint)))).toEqual(checkpoint);
    expect(() => parseStructuredAuthoringProtocol({ version: "synapsor.structured-authoring.v3" })).toThrow();
  });
  it("refuses the former native job before interpreting or mutating its history", () => {
    const previous = { schema_version: "synapsor.boundary-authoring-resume.v5", authoring_protocol: { version: "synapsor.structured-authoring.v4" }, history: ["retained original"] };
    const before = JSON.stringify(previous);
    expect(() => assertCurrentAuthoringEnvelope(previous)).toThrow(OLDER_AUTHORING_SETUP_MESSAGE);
    expect(JSON.stringify(previous)).toBe(before);
    expect(() => assertAuthoringProtocolUnchanged(previous.authoring_protocol as never, { version: STRUCTURED_AUTHORING_PROTOCOL_VERSION })).toThrow();
  });
  it("refuses checkpoint2 and a shared proposal hidden in unstructured checkpoint1", () => {
    const legacy = actionRuleAuthoringCheckpoint({ intent_digest: hash, context_digest: hash, components: {} });
    expect(legacy.schema_version).toBe("synapsor.action-authoring-checkpoint.v1");
    expect(() => parseActionRuleAuthoringCheckpoint(seal({ ...legacy, schema_version: "synapsor.action-authoring-checkpoint.v2", authoring_protocol: { version: "synapsor.structured-authoring.v3" } }))).toThrow();
    expect(() => parseActionRuleAuthoringCheckpoint(seal({ ...legacy, schema_version: "synapsor.action-authoring-checkpoint.v2", authoring_protocol: { version: STRUCTURED_AUTHORING_PROTOCOL_VERSION } }))).toThrow();
    expect(() => parseActionRuleAuthoringCheckpoint(seal({ ...legacy, components: { rule: { shared_sum_proposal: {} } } }))).toThrow();
  });
});
