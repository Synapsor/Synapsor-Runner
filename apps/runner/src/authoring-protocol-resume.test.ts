import { OLDER_AUTHORING_SETUP_MESSAGE } from "./authoring-protocol.js";
import { savedAuthoringPolicyReview } from "./authoring-saved-review.js";
import { boundaryReviewCommand } from "./boundary-commands.js";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildBoundaryAuthoringResumeState, assertBoundaryAuthoringResumeState,
  type BoundaryAuthoringResumeState, clearBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";

const digest = canonicalJsonDigest("owned protocol fixture");
const base = { binding: { boundary_name: "owned", generation_lock_fingerprint: digest,
  schema_fingerprint: digest, role_posture_fingerprint: digest }, stage: "planning" as const,
  jobIntent: "Review the declared business task.", provider: "openai" as const, model: "offline-scripted" };
const protocol = { version: "synapsor.structured-authoring.v2" as const };
const structured = () => buildBoundaryAuthoringResumeState({ ...base, authoringProtocol: protocol } as Parameters<typeof buildBoundaryAuthoringResumeState>[0]);
const seal = (v: Record<string, unknown>) => { const { revision_digest: _, ...core } = v; return { ...core, revision_digest: canonicalJsonDigest(core) }; };

// A preserved historical-format fixture, never a current builder/migration.
const older = (version = "synapsor.boundary-authoring-resume.v1") => {
  const { authoring_protocol: _, ...body } = structured();
  return seal({ ...body, schema_version: version }) as BoundaryAuthoringResumeState;
};

describe("B64 protocol pin in native Resume", () => {
  it("refuses the earlier structured development pin before inspecting its saved records", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-b64-earlier-pin-"));
    try {
      const relative = await writeBoundaryAuthoringResumeState(root, structured(), { expectedRevisionDigest: null });
      const file = path.resolve(root, relative);
      const old = seal({ ...structured(), authoring_protocol: { version: "synapsor.structured-authoring.v1" },
        operator_questions: [{ deliberately_unsupported_old_record: true }] });
      const bytes = JSON.stringify(old);
      await fs.writeFile(file, bytes);
      const files = await fs.readdir(path.join(root, ".synapsor"));
      const notices: unknown[] = [];
      await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"],
        async () => { throw new Error("Earlier pin must not inspect Source"); }, undefined, undefined,
        { onAuthoringResult: notice => notices.push(notice), boundaryAuthoringChatFactory: () => {
          throw new Error("Earlier pin must not open chat");
        } });
      expect(notices).toEqual([expect.objectContaining({ lines: [OLDER_AUTHORING_SETUP_MESSAGE] })]);
      expect(await readBoundaryAuthoringResumeState(root, base.binding)).toEqual({ status: "invalid", reason: OLDER_AUTHORING_SETUP_MESSAGE });
      await expect(clearBoundaryAuthoringResumeState(root)).rejects.toThrow(OLDER_AUTHORING_SETUP_MESSAGE);
      await expect(writeBoundaryAuthoringResumeState(root, structured())).rejects.toThrow();
      expect(await fs.readdir(path.join(root, ".synapsor"))).toEqual(files);
      expect(await fs.readFile(file, "utf8")).toBe(bytes);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("pins the new explicit mode and preserves it without reinterpreting legacy jobs", () => {
    const legacy = older();
    expect(buildBoundaryAuthoringResumeState(base).authoring_protocol).toEqual(protocol);
    const fresh = structured();
    expect(fresh.schema_version).toBe("synapsor.boundary-authoring-resume.v3");
    expect(fresh).toHaveProperty("authoring_protocol", protocol);
    const next = buildBoundaryAuthoringResumeState({ ...base, previous: fresh, stage: "read_mapping" });
    expect(next).toHaveProperty("authoring_protocol", protocol);
    expect(next.schema_version).toBe(fresh.schema_version);
    expect(() => buildBoundaryAuthoringResumeState({ ...base, previous: legacy, authoringProtocol: protocol } as Parameters<typeof buildBoundaryAuthoringResumeState>[0]))
      .toThrow(OLDER_AUTHORING_SETUP_MESSAGE);
  });
  it.each(["synapsor.boundary-authoring-resume.v1", "synapsor.boundary-authoring-resume.v2"])("refuses opening %s before interpreting or rewriting its history", async version => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-b64-old-refusal-"));
    try {
      const relative = await writeBoundaryAuthoringResumeState(root, structured(), { expectedRevisionDigest: null });
      const file = path.resolve(root, relative), old = older(version), bytes = JSON.stringify(old);
      await fs.writeFile(file, bytes);
      const originalFiles = await fs.readdir(path.join(root, ".synapsor"));
      const notices: unknown[] = [];
      await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"],
        async () => { throw new Error("Old setup must not inspect Source"); }, undefined, undefined,
        { onAuthoringResult: notice => notices.push(notice), boundaryAuthoringChatFactory: () => {
          throw new Error("Old setup must not open chat");
        } });
      expect(notices).toEqual([expect.objectContaining({ lines: [OLDER_AUTHORING_SETUP_MESSAGE] })]);
      expect(await fs.readdir(path.join(root, ".synapsor"))).toEqual(originalFiles);
      expect(await readBoundaryAuthoringResumeState(root, base.binding)).toEqual({ status: "invalid", reason: OLDER_AUTHORING_SETUP_MESSAGE });
      expect(await savedAuthoringPolicyReview({ projectRoot: root, binding: base.binding, readDigest: digest }))
        .toMatchObject({ ready: false, privacy: false, summary: [OLDER_AUTHORING_SETUP_MESSAGE] });
      expect(() => buildBoundaryAuthoringResumeState({ ...base, previous: old })).toThrow(OLDER_AUTHORING_SETUP_MESSAGE);
      await expect(clearBoundaryAuthoringResumeState(root)).rejects.toThrow(OLDER_AUTHORING_SETUP_MESSAGE);
      await expect(writeBoundaryAuthoringResumeState(root, structured())).rejects.toThrow("AUTHORING_PROTOCOL_INVALID");
      expect(await fs.readFile(file, "utf8")).toBe(bytes);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
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
      const legacy = older();
      await expect(writeBoundaryAuthoringResumeState(root, legacy, { expectedRevisionDigest: fresh.revision_digest }))
        .rejects.toThrow(OLDER_AUTHORING_SETUP_MESSAGE);
      await expect(writeBoundaryAuthoringResumeState(root, legacy)).rejects.toThrow(OLDER_AUTHORING_SETUP_MESSAGE);
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

  it("preserves an unsupported saved protocol against legacy explicit replacement", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-b64-unknown-"));
    try {
      const fresh = structured();
      const relative = await writeBoundaryAuthoringResumeState(root, fresh, { expectedRevisionDigest: null });
      const file = path.resolve(root, relative);
      const unsupported = JSON.stringify(seal({ ...fresh, authoring_protocol: { version: "synapsor.structured-authoring.v99" } }));
      await fs.writeFile(file, unsupported);
      await expect(writeBoundaryAuthoringResumeState(root, buildBoundaryAuthoringResumeState(base)))
        .rejects.toThrow("AUTHORING_PROTOCOL_INVALID");
      expect(await fs.readFile(file, "utf8")).toBe(unsupported);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("refuses an unknown native envelope before public metadata or menus", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-b64-future-envelope-"));
    try {
      const relative = await writeBoundaryAuthoringResumeState(root, structured(), { expectedRevisionDigest: null });
      const file = path.resolve(root, relative);
      const bytes = JSON.stringify(seal({ ...structured(), schema_version: "synapsor.boundary-authoring-resume.v99" }));
      await fs.writeFile(file, bytes);
      const files = await fs.readdir(path.join(root, ".synapsor"));
      await expect(boundaryReviewCommand(["--project-root", root, "--access", "--job-first"],
        async () => { throw new Error("Future envelope must not inspect Source"); }, undefined, undefined,
        { boundaryAuthoringChatFactory: () => { throw new Error("Future envelope must not open chat"); } }))
        .rejects.toThrow("AUTHORING_PROTOCOL_INVALID");
      expect(await fs.readdir(path.join(root, ".synapsor"))).toEqual(files);
      expect(await fs.readFile(file, "utf8")).toBe(bytes);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

});
