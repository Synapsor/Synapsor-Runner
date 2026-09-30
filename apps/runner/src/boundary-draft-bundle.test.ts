import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { readBoundaryDraftExchange, writeBoundaryDraftExchange } from "./boundary-draft-bundle.js";
import { ownedProgramDraft } from "./test-fixtures/owned-authoring-program.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
async function root() { const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-exchange-")); roots.push(directory); return directory; }
function payload(count = 64) {
  return { schema_version: "synapsor.boundary-draft-input.v2", review_bundle_digest: canonicalJsonDigest("fixture current review"),
    bindings: { proposal: "metadata only; real bindings are checked by authoring" }, read: { resources: [{ resource_id: "studio.parcels", include: true }] },
    actions: Array.from({ length: count }, (_, index) => ({ ...ownedProgramDraft(index + 1), review: { ...ownedProgramDraft(index + 1).review,
      when: "Untrusted declarative draft explanation. ".repeat(400) } })),
    action_skeletons: [], notes: { state: "untrusted_declarative_proposals" } };
}
async function bundle(directory: string, file = "draft.json") { const value = payload(); const result = await writeBoundaryDraftExchange({ projectRoot: directory, supplied: file, payload: value }); return { value, result, file: path.join(directory, file), parts: path.join(directory, `${file}.parts`) }; }
async function editManifest(file: string, edit: (manifest: any) => void) {
  const manifest = JSON.parse(await fs.readFile(file, "utf8")); edit(manifest);
  const { manifest_digest: _, ...core } = manifest; manifest.manifest_digest = canonicalJsonDigest(core);
  await fs.writeFile(file, JSON.stringify(manifest)); return manifest;
}
async function editPart(file: string, parts: string, edit: (part: any) => void) {
  const manifest = JSON.parse(await fs.readFile(file, "utf8")), member = manifest.parts[0];
  const target = path.join(parts, member.file), part = JSON.parse(await fs.readFile(target, "utf8")); edit(part);
  const text = JSON.stringify(part); await fs.writeFile(target, text);
  await editManifest(file, manifest => { const before = manifest.parts[0].bytes; manifest.parts[0].bytes = Buffer.byteLength(text);
    manifest.parts[0].digest = hash(text); manifest.part_bytes += Buffer.byteLength(text) - before; });
}

describe("bounded declarative draft exchange", () => {
  it("preserves small ordinary JSON with exclusive atomic publication", async () => {
    const directory = await root(), value = { ...payload(1), actions: [ownedProgramDraft(1)] };
    expect(await writeBoundaryDraftExchange({ projectRoot: directory, supplied: "draft.json", payload: value })).toMatchObject({ format: "json", parts: 0 });
    expect(await readBoundaryDraftExchange(directory, "draft.json")).toEqual(value);
    const before = await fs.readFile(path.join(directory, "draft.json"));
    await expect(writeBoundaryDraftExchange({ projectRoot: directory, supplied: "draft.json", payload: value })).rejects.toMatchObject({ code: "STRUCTURED_DRAFT_OUTPUT_EXISTS" });
    expect(await fs.readFile(path.join(directory, "draft.json"))).toEqual(before);
    expect((await fs.stat(path.join(directory, "draft.json"))).mode & 0o777).toBe(0o600);
  });

  it("preserves all 64 ordered proposals across bounded local parts", async () => {
    const directory = await root(), { value, result, file, parts } = await bundle(directory);
    expect(result.format).toBe("bundle"); expect(result.parts).toBeGreaterThan(1);
    expect(result.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    const manifest = JSON.parse(await fs.readFile(file, "utf8"));
    expect(manifest.parts.length).toBeLessThanOrEqual(16);
    for (const member of manifest.parts) expect((await fs.stat(path.join(parts, member.file))).size).toBeLessThanOrEqual(512 * 1024);
    expect(await readBoundaryDraftExchange(directory, "draft.json")).toEqual(value);
  });

  it.each(["missing", "extra", "tampered", "duplicate_name", "reordered_manifest", "foreign_path", "foreign_bundle", "record_order", "mixed_revision", "payload_tamper"])("rejects %s before yielding any proposal", async fault => {
    const directory = await root(), { file, parts } = await bundle(directory);
    const manifest = JSON.parse(await fs.readFile(file, "utf8"));
    if (fault === "missing") await fs.unlink(path.join(parts, manifest.parts[0].file));
    if (fault === "extra") await fs.writeFile(path.join(parts, "foreign.json"), "{}");
    if (fault === "tampered") await fs.appendFile(path.join(parts, manifest.parts[0].file), " ");
    if (fault === "duplicate_name") await editManifest(file, value => { value.parts[1].file = value.parts[0].file; });
    if (fault === "reordered_manifest") await editManifest(file, value => { value.parts.reverse(); });
    if (fault === "foreign_path") await editManifest(file, value => { value.parts_directory = "../outside"; });
    if (fault === "foreign_bundle") await editPart(file, parts, value => { value.bundle_id = "00000000-0000-4000-8000-000000000000"; });
    if (fault === "record_order") await editPart(file, parts, value => { value.records.reverse(); });
    if (fault === "mixed_revision") await editPart(file, parts, value => { value.schema_version = "synapsor.boundary-draft-part.v99"; });
    if (fault === "payload_tamper") await editPart(file, parts, value => { value.records.find((record: any) => record.kind === "action").value.ttl_seconds = 600; });
    await expect(readBoundaryDraftExchange(directory, "draft.json")).rejects.toMatchObject({ code: expect.stringMatching(/^STRUCTURED_DRAFT_BUNDLE_/u) });
  });

  it.each(["input_parent", "input_final", "member", "parts_directory", "hard_link", "output_parent"])("refuses the %s filesystem hazard", async fault => {
    const directory = await root(), outside = await root();
    if (fault === "output_parent") {
      await fs.symlink(outside, path.join(directory, "foreign"), "dir");
      await expect(writeBoundaryDraftExchange({ projectRoot: directory, supplied: "foreign/draft.json", payload: payload() })).rejects.toMatchObject({ code: "STRUCTURED_DRAFT_PATH_INVALID" });
      expect(await fs.readdir(outside)).toEqual([]); return;
    }
    const { file, parts } = await bundle(directory);
    const manifest = JSON.parse(await fs.readFile(file, "utf8"));
    let supplied = "draft.json";
    if (fault === "input_parent") { await fs.symlink(directory, path.join(outside, "foreign"), "dir"); await expect(readBoundaryDraftExchange(outside, "foreign/draft.json")).rejects.toMatchObject({ code: "STRUCTURED_DRAFT_PATH_INVALID" }); return; }
    if (fault === "input_final") { await fs.symlink(file, path.join(directory, "linked.json")); supplied = "linked.json"; }
    if (fault === "member") { const target = path.join(parts, manifest.parts[0].file); await fs.rename(target, path.join(outside, "part.json")); await fs.symlink(path.join(outside, "part.json"), target); }
    if (fault === "parts_directory") { await fs.rename(parts, path.join(outside, "parts")); await fs.symlink(path.join(outside, "parts"), parts, "dir"); }
    if (fault === "hard_link") await fs.link(file, path.join(outside, "hard.json"));
    await expect(readBoundaryDraftExchange(directory, supplied)).rejects.toMatchObject({ code: "STRUCTURED_DRAFT_PATH_INVALID" });
  });

  it.each([".synapsor/draft.json", "synapsor/generated/draft.json", "../outside.json"])("refuses an authority or escaping output %s", async supplied => {
    const directory = await root(); await expect(writeBoundaryDraftExchange({ projectRoot: directory, supplied, payload: payload() })).rejects.toMatchObject({ code: "STRUCTURED_DRAFT_PATH_INVALID" });
  });

  it("does not publish a final manifest after an interrupted part write", async () => {
    const directory = await root(), original = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
      if (String(to).endsWith("part-0002.json")) throw Object.assign(new Error("owned before-part fault"), { code: "EIO" });
      return original(from, to);
    });
    await expect(writeBoundaryDraftExchange({ projectRoot: directory, supplied: "draft.json", payload: payload() })).rejects.toThrow("owned before-part fault");
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("retains a coherent published bundle when its publication acknowledgement is lost", async () => {
    const directory = await root(), original = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
      await original(from, to);
      if (String(to) === path.join(directory, "draft.json")) throw Object.assign(new Error("owned lost publication ack"), { code: "EIO" });
    });
    const value = payload();
    await expect(writeBoundaryDraftExchange({ projectRoot: directory, supplied: "draft.json", payload: value })).rejects.toThrow("owned lost publication ack");
    expect(await readBoundaryDraftExchange(directory, "draft.json")).toEqual(value);
  });

  it.each(["record", "count", "total", "source_secret", "authority_store"])("refuses %s overflow or forbidden material without publishing", async fault => {
    const directory = await root(), value: any = payload();
    if (fault === "record") value.read_authoring_catalog = { explanation: "x".repeat(256 * 1024) };
    if (fault === "count") value.read.resources = Array.from({ length: 193 }, (_, index) => ({ resource_id: `studio.resource_${index}` }));
    if (fault === "total") for (const action of value.actions) action.review.when = "x".repeat(80 * 1024);
    if (fault === "source_secret") value.attached_sources = [{ name: "rules.txt", text: "BEGIN RSA PRIVATE KEY", version: 1, digest: canonicalJsonDigest("secret") }];
    if (fault === "authority_store") value.operation_id = "old-operation-must-not-be-exported";
    await expect(writeBoundaryDraftExchange({ projectRoot: directory, supplied: "draft.json", payload: value })).rejects.toMatchObject({ code: expect.stringMatching(/^STRUCTURED_DRAFT_/u) });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("rejects invalid UTF-8 and over-bound regular input without partial parsing", async () => {
    const directory = await root(); await fs.writeFile(path.join(directory, "bad.json"), Buffer.from([0xc0, 0xaf]));
    await expect(readBoundaryDraftExchange(directory, "bad.json")).rejects.toMatchObject({ code: "STRUCTURED_DRAFT_JSON_INVALID" });
    await fs.writeFile(path.join(directory, "large.json"), "x".repeat(512 * 1024 + 1));
    await expect(readBoundaryDraftExchange(directory, "large.json")).rejects.toMatchObject({ code: "STRUCTURED_DRAFT_TOO_LARGE" });
  });

  it("accepts an exact 256 KiB indivisible typed record and refuses one extra byte", async () => {
    const directory = await root(), value: any = { ...payload(1), actions: [ownedProgramDraft(1)], read_authoring_catalog: { explanation: "" } };
    const wrapper = { kind: "property", index: 7, key: "read_authoring_catalog", value: value.read_authoring_catalog };
    value.read_authoring_catalog.explanation = "x".repeat(256 * 1024 - Buffer.byteLength(JSON.stringify(wrapper)));
    expect(Buffer.byteLength(JSON.stringify(wrapper))).toBe(256 * 1024);
    await writeBoundaryDraftExchange({ projectRoot: directory, supplied: "exact.json", payload: value });
    expect(await readBoundaryDraftExchange(directory, "exact.json")).toEqual(value);
    value.read_authoring_catalog.explanation += "x";
    await expect(writeBoundaryDraftExchange({ projectRoot: directory, supplied: "over.json", payload: value })).rejects.toMatchObject({ code: "STRUCTURED_DRAFT_BUNDLE_RECORD_LIMIT" });
  });

  it("accepts exactly 192 typed records and refuses record 193 without truncating", async () => {
    const directory = await root(), value: any = { schema_version: "serialization-count-control", actions: [],
      read: { resources: Array.from({ length: 191 }, (_, index) => ({ resource_id: `resource_${index}` })) } };
    await writeBoundaryDraftExchange({ projectRoot: directory, supplied: "exact.json", payload: value });
    expect(await readBoundaryDraftExchange(directory, "exact.json")).toEqual(value);
    value.read.resources.push({ resource_id: "resource_191" });
    await expect(writeBoundaryDraftExchange({ projectRoot: directory, supplied: "over.json", payload: value })).rejects.toMatchObject({ code: "STRUCTURED_DRAFT_BUNDLE_RECORD_LIMIT" });
  });

  it("accepts a 64 KiB manifest and refuses the next byte or a seventeenth part", async () => {
    const directory = await root(), { value, file } = await bundle(directory), original = await fs.readFile(file, "utf8");
    await fs.writeFile(file, original + " ".repeat(64 * 1024 - Buffer.byteLength(original)));
    expect(await readBoundaryDraftExchange(directory, "draft.json")).toEqual(value);
    await fs.appendFile(file, " ");
    await expect(readBoundaryDraftExchange(directory, "draft.json")).rejects.toMatchObject({ code: "STRUCTURED_DRAFT_BUNDLE_MANIFEST_LIMIT" });
    await fs.writeFile(file, original);
    await editManifest(file, manifest => { manifest.parts = Array.from({ length: 17 }, (_, index) => ({ ...manifest.parts[0], index, file: `part-${String(index + 1).padStart(4, "0")}.json` })); });
    await expect(readBoundaryDraftExchange(directory, "draft.json")).rejects.toMatchObject({ code: "STRUCTURED_DRAFT_BUNDLE_MANIFEST_INVALID" });
  });

  it("accepts an exact 512 KiB part and refuses a declared over-bound part", async () => {
    const directory = await root(), { value, file, parts } = await bundle(directory), manifest = JSON.parse(await fs.readFile(file, "utf8"));
    const member = manifest.parts[0], target = path.join(parts, member.file), original = await fs.readFile(target, "utf8");
    const text = original + " ".repeat(512 * 1024 - Buffer.byteLength(original));
    await fs.writeFile(target, text);
    await editManifest(file, value => { value.part_bytes += Buffer.byteLength(text) - value.parts[0].bytes; value.parts[0].bytes = Buffer.byteLength(text); value.parts[0].digest = hash(text); });
    expect(await readBoundaryDraftExchange(directory, "draft.json")).toEqual(value);
    await editManifest(file, value => { value.part_bytes++; value.parts[0].bytes++; });
    await expect(readBoundaryDraftExchange(directory, "draft.json")).rejects.toMatchObject({ code: "STRUCTURED_DRAFT_BUNDLE_MANIFEST_INVALID" });
  });

  it("accepts exactly 4 MiB total serialized membership and refuses one extra byte", async () => {
    const directory = await root(), value: any = { schema_version: "serialization-total-control", read: { resources: [] },
      actions: Array.from({ length: 16 }, () => ({ text: "x".repeat(250_000) })), notes: { text: "x".repeat(100_000) } };
    let bytes = 0;
    // Protocol calibration only; these are not valid compiler or model drafts.
    // UUID/digest widths and member count are fixed in this finite family.
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = await writeBoundaryDraftExchange({ projectRoot: directory, supplied: `calibration-${attempt}.json`, payload: value });
      bytes = result.bytes; if (bytes === 4 * 1024 * 1024) break;
      value.notes.text += "x".repeat(4 * 1024 * 1024 - bytes);
    }
    expect(bytes).toBe(4 * 1024 * 1024);
    value.notes.text += "x";
    await expect(writeBoundaryDraftExchange({ projectRoot: directory, supplied: "calibration-x.json", payload: value })).rejects.toMatchObject({ code: "STRUCTURED_DRAFT_BUNDLE_TOTAL_LIMIT" });
  });
});
