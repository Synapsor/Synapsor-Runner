import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildBoundaryAuthoringResumeState, assertBoundaryAuthoringResumeState,
  clearBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";

const digest = canonicalJsonDigest("owned protocol fixture");
const base = { binding: { boundary_name: "owned", generation_lock_fingerprint: digest,
  schema_fingerprint: digest, role_posture_fingerprint: digest }, stage: "planning" as const,
  jobIntent: "Review the declared business task.", provider: "openai" as const, model: "offline-scripted" };
const protocol = { version: "synapsor.structured-authoring.v1" as const };
const structured = () => buildBoundaryAuthoringResumeState({ ...base, authoringProtocol: protocol } as Parameters<typeof buildBoundaryAuthoringResumeState>[0]);
const seal = (v: Record<string, unknown>) => { const { revision_digest: _, ...core } = v; return { ...core, revision_digest: canonicalJsonDigest(core) }; };

describe("B64 protocol pin in native Resume", () => {
  it("pins the new explicit mode and preserves it without reinterpreting legacy jobs", () => {
    const legacy = buildBoundaryAuthoringResumeState(base);
    expect(legacy.schema_version).toBe("synapsor.boundary-authoring-resume.v1");
    const fresh = structured();
    expect(fresh.schema_version).toBe("synapsor.boundary-authoring-resume.v3");
    expect(fresh).toHaveProperty("authoring_protocol", protocol);
    const next = buildBoundaryAuthoringResumeState({ ...base, previous: fresh, stage: "read_mapping" });
    expect(next).toHaveProperty("authoring_protocol", protocol);
    expect(next.schema_version).toBe(fresh.schema_version);
    expect(() => buildBoundaryAuthoringResumeState({ ...base, previous: legacy, authoringProtocol: protocol } as Parameters<typeof buildBoundaryAuthoringResumeState>[0]))
      .toThrow("AUTHORING_PROTOCOL_CHANGE_REQUIRES_NEW_JOB");
  });
  it("refuses missing, unknown and legacy-envelope protocol declarations", () => {
    const fresh = structured();
    const mutations = [
      { ...fresh, authoring_protocol: undefined },
      { ...fresh, authoring_protocol: { version: "unknown" } },
      { ...fresh, authoring_protocol: { ...protocol, accepted: true } },
      { ...fresh, schema_version: "synapsor.boundary-authoring-resume.v1" },
    ];
    for (const v of mutations) expect(() => assertBoundaryAuthoringResumeState(seal(v))).toThrow();
  });
  it("refuses a recomputed native downgrade and preserves the exact prior file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-b64-protocol-"));
    try {
      const fresh = structured();
      await writeBoundaryAuthoringResumeState(root, fresh, { expectedRevisionDigest: null });
      const legacy = buildBoundaryAuthoringResumeState(base);
      await expect(writeBoundaryAuthoringResumeState(root, legacy, { expectedRevisionDigest: fresh.revision_digest }))
        .rejects.toThrow("AUTHORING_PROTOCOL_CHANGE_REQUIRES_NEW_JOB");
      await expect(writeBoundaryAuthoringResumeState(root, legacy)).rejects.toThrow("AUTHORING_PROTOCOL_CHANGE_REQUIRES_NEW_JOB");
      expect(await readBoundaryAuthoringResumeState(root, base.binding)).toEqual({ status: "ready", value: fresh });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("requires acknowledged CAS and retains a pinned job even before components exist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-b64-currentness-"));
    try {
      const fresh = structured();
      await writeBoundaryAuthoringResumeState(root, fresh, { expectedRevisionDigest: null });
      const next = buildBoundaryAuthoringResumeState({ ...base, previous: fresh, stage: "read_mapping" });
      await expect(writeBoundaryAuthoringResumeState(root, next)).rejects.toThrow("BOUNDARY_AUTHORING_RESUME_CHANGED");
      await expect(writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: digest })).rejects.toThrow("BOUNDARY_AUTHORING_RESUME_CHANGED");
      expect(await clearBoundaryAuthoringResumeState(root)).toBe(false);
      await writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: fresh.revision_digest });
      expect(await readBoundaryAuthoringResumeState(root, base.binding)).toEqual({ status: "ready", value: next });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("does not equate protocol version with broader program capacity", async () => {
    const { isAuthoringProgramResume } = await import("./authoring-program-capacity.js");
    expect(isAuthoringProgramResume(structured())).toBe(false);
    expect(isAuthoringProgramResume({ schema_version: "synapsor.boundary-authoring-resume.v1", action_workflow: "program" })).toBe(false);
    const program = buildBoundaryAuthoringResumeState({ ...base, authoringProtocol: protocol, actionWorkflow: "program" });
    expect(isAuthoringProgramResume(program)).toBe(true);
    expect(program.schema_version).toBe("synapsor.boundary-authoring-resume.v3");
  });

});
