import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { AUTHORING_PROGRAM_CAPACITY as limits } from "./authoring-program-capacity.js";

export const BOUNDARY_DRAFT_BUNDLE_VERSION = "synapsor.boundary-draft-bundle.v1" as const;
const PART_VERSION = "synapsor.boundary-draft-part.v1" as const;
type ObjectValue = Record<string, unknown>;
type RecordKind = "property" | "read_resource" | "action" | "skeleton" | "source";
type DraftRecord = { kind: RecordKind; index: number; key?: string; value: unknown };
type PartMember = { file: string; index: number; bytes: number; digest: string; records: number };
type Manifest = {
  schema_version: typeof BOUNDARY_DRAFT_BUNDLE_VERSION;
  bundle_id: string;
  payload_digest: string;
  parts_directory: string;
  parts: PartMember[];
  records: number;
  part_bytes: number;
  manifest_digest: string;
};
const propertyKeys = ["schema_version", "review_bundle_digest", "bindings", "action_skeleton_candidates",
  "read_request_json_schema", "action_rule_draft_json_schema", "action_authoring_catalog", "read_authoring_catalog", "notes"];
const collectionKinds: Record<string, RecordKind> = { actions: "action", action_skeletons: "skeleton", attached_sources: "source" };

/** Local declarative exchange only. The ordinary authoring parser, compiler and
 * repository CAS still decide whether a proposal can become a disabled draft. */
export async function writeBoundaryDraftExchange(input: {
  projectRoot: string; supplied: string; payload: unknown;
}): Promise<{ path: string; format: "json" | "bundle"; bytes: number; parts: number }> {
  const payload = object(input.payload, "export");
  assertPrivateMaterial(payload);
  const records = draftRecords(payload);
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const root = await fs.realpath(input.projectRoot);
  const target = await projectFile(root, input.supplied, true);
  await absent(target);
  if (byteLength(text) <= limits.structuredDraftBytes) {
    await publishFile(root, target, text);
    return { path: path.relative(root, target), format: "json", bytes: byteLength(text), parts: 0 };
  }

  const bundleId = randomUUID();
  const parts = packParts(records, bundleId);
  const directory = `${target}.parts`;
  await absent(directory);
  const members = parts.map((part, index) => ({ file: partName(index), index,
    bytes: byteLength(part), digest: digest(part), records: JSON.parse(part).records.length }));
  const partBytes = members.reduce((total, member) => total + member.bytes, 0);
  const core = { schema_version: BOUNDARY_DRAFT_BUNDLE_VERSION, bundle_id: bundleId,
    payload_digest: canonicalJsonDigest(payload), parts_directory: path.basename(directory),
    parts: members, records: records.length, part_bytes: partBytes };
  const manifest = `${JSON.stringify({ ...core, manifest_digest: canonicalJsonDigest(core) }, null, 2)}\n`;
  if (byteLength(manifest) > limits.structuredDraftManifestBytes
    || partBytes + byteLength(manifest) > limits.structuredDraftTotalBytes) {
    fail("STRUCTURED_DRAFT_BUNDLE_TOTAL_LIMIT", "The complete local draft bundle exceeds its finite manifest or total byte limit. No inventory was truncated.");
  }
  // An interrupted directory is inert: the complete manifest is published last.
  // mkdir/link are exclusive, so another project's existing output is never replaced.
  await assertParents(root, directory, true);
  await fs.mkdir(directory, { mode: 0o700 });
  let complete = false;
  try {
    for (const [index, part] of parts.entries()) {
      await publishFile(root, path.join(directory, partName(index)), part);
    }
    await syncDirectory(directory);
    await publishFile(root, target, manifest, () => { complete = true; });
  } finally {
    // Remove only this invocation's incomplete files on an ordinary exception.
    // Process death leaves them for inspection and never creates a valid partial manifest.
    if (!complete) {
      // A filesystem error can lose a successful publication acknowledgement.
      // Never remove parts behind a possibly published manifest on that basis.
      const finalPresent = await fs.lstat(target).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      if (!finalPresent) await fs.rm(directory, { recursive: true, force: true });
    }
  }
  return { path: path.relative(root, target), format: "bundle", bytes: partBytes + byteLength(manifest), parts: parts.length };
}

export async function readBoundaryDraftExchange(projectRoot: string, supplied: string): Promise<unknown> {
  const root = await fs.realpath(projectRoot);
  const file = await projectFile(root, supplied, false);
  const initial = await boundedText(root, file, limits.structuredDraftBytes);
  const parsed = parseJson(initial);
  assertPrivateMaterial(parsed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || (parsed as ObjectValue).schema_version !== BOUNDARY_DRAFT_BUNDLE_VERSION) return parsed;
  if (byteLength(initial) > limits.structuredDraftManifestBytes) {
    fail("STRUCTURED_DRAFT_BUNDLE_MANIFEST_LIMIT", "Draft manifest exceeds its finite byte limit.");
  }
  const manifest = parseManifest(parsed, path.basename(file));
  const directory = path.join(path.dirname(file), manifest.parts_directory);
  await assertParents(root, path.join(directory, "member"), false);
  const names = await fs.readdir(directory);
  const expectedNames = manifest.parts.map((part) => part.file).sort();
  if (JSON.stringify(names.sort()) !== JSON.stringify(expectedNames)) {
    fail("STRUCTURED_DRAFT_BUNDLE_MEMBERSHIP_INVALID", "Bundle directory must contain exactly its declared parts, with no missing or extra members.");
  }
  const records: DraftRecord[] = [];
  let partBytes = 0;
  for (const member of manifest.parts) {
    const text = await boundedText(root, path.join(directory, member.file), limits.structuredDraftBytes);
    if (byteLength(text) !== member.bytes || digest(text) !== member.digest) {
      fail("STRUCTURED_DRAFT_BUNDLE_INTEGRITY_INVALID", "A draft part's bytes or digest differ from this exact manifest.");
    }
    partBytes += byteLength(text);
    const part = object(parseJson(text), "part");
    keys(part, ["schema_version", "bundle_id", "index", "records"]);
    if (part.schema_version !== PART_VERSION || part.bundle_id !== manifest.bundle_id || part.index !== member.index
      || !Array.isArray(part.records) || part.records.length !== member.records) {
      fail("STRUCTURED_DRAFT_BUNDLE_PART_INVALID", "Part identity, revision, order or record count does not match this manifest.");
    }
    for (const value of part.records) {
      const record = object(value, "record");
      keys(record, ["kind", "index", "key", "value"]);
      if (!Object.hasOwn(record, "value") || byteLength(JSON.stringify(record)) > limits.structuredDraftRecordBytes) {
        fail("STRUCTURED_DRAFT_BUNDLE_RECORD_LIMIT", "An indivisible draft record exceeds its finite byte limit or is incomplete.");
      }
      records.push(record as DraftRecord);
      if (records.length > limits.structuredDraftRecords) fail("STRUCTURED_DRAFT_BUNDLE_RECORD_LIMIT", "Too many draft records.");
    }
  }
  if (partBytes !== manifest.part_bytes || records.length !== manifest.records
    || partBytes + byteLength(initial) > limits.structuredDraftTotalBytes) {
    fail("STRUCTURED_DRAFT_BUNDLE_TOTAL_LIMIT", "Complete draft membership or aggregate resource use does not match its bounded manifest.");
  }
  const payload = assembleRecords(records);
  assertPrivateMaterial(payload);
  if (canonicalJsonDigest(payload) !== manifest.payload_digest) {
    fail("STRUCTURED_DRAFT_BUNDLE_INTEGRITY_INVALID", "The complete ordered draft payload differs from the manifest.");
  }
  return payload;
}

/** Internal immutable operator agenda storage uses the same bounded private
 * file checks. Its fixed path is selected by the host, never by draft data. */
export async function readPrivateAuthoringJson(projectRoot: string, relative: string, maximum: number): Promise<unknown> {
  const root = await fs.realpath(projectRoot);
  return parseJson(await boundedText(root, await projectFile(root, relative, false), maximum));
}

export async function publishPrivateAuthoringJson(projectRoot: string, relative: string, value: unknown, maximum: number): Promise<void> {
  const root = await fs.realpath(projectRoot), target = path.resolve(root, relative);
  const inside = path.relative(root, target);
  if (!inside.startsWith(`.synapsor${path.sep}boundary-authoring${path.sep}`)) fail("STRUCTURED_DRAFT_PATH_INVALID", "Operator agenda storage requires its fixed authoring directory.");
  assertPrivateMaterial(value);
  const serialized = `${JSON.stringify(value)}\n`;
  if (byteLength(serialized) > maximum) fail("STRUCTURED_DRAFT_BUNDLE_TOTAL_LIMIT", "Complete operator agenda exceeds its finite storage limit; nothing was truncated.");
  await assertParents(root, target, true); await absent(target);
  await publishFile(root, target, serialized);
}

function draftRecords(payload: ObjectValue): DraftRecord[] {
  keys(payload, [...propertyKeys, "read", ...Object.keys(collectionKinds)]);
  const records: DraftRecord[] = [];
  for (const [index, key] of propertyKeys.entries()) {
    if (payload[key] !== undefined) records.push({ kind: "property", index, key, value: payload[key] });
  }
  const read = object(payload.read, "read");
  keys(read, ["resources"]);
  if (!Array.isArray(read.resources)) fail("STRUCTURED_DRAFT_BUNDLE_RECORD_INVALID", "Read resources must be an array.");
  read.resources.forEach((value, index) => records.push({ kind: "read_resource", index, value }));
  for (const [key, kind] of Object.entries(collectionKinds)) {
    const values = payload[key];
    if (values === undefined && key !== "actions") continue;
    if (!Array.isArray(values)) fail("STRUCTURED_DRAFT_BUNDLE_RECORD_INVALID", `${key} must be an array.`);
    // Empty optional arrays must retain their exact declarative presence.
    if (!values.length && key !== "actions") records.push({ kind: "property", index: propertyKeys.length + Object.keys(collectionKinds).indexOf(key), key, value: [] });
    else values.forEach((value, index) => records.push({ kind, index, value }));
  }
  if (records.length > limits.structuredDraftRecords) fail("STRUCTURED_DRAFT_BUNDLE_RECORD_LIMIT", "Complete draft exceeds the finite record-count limit. No inventory was truncated.");
  for (const record of records) if (byteLength(JSON.stringify(record)) > limits.structuredDraftRecordBytes) {
    fail("STRUCTURED_DRAFT_BUNDLE_RECORD_LIMIT", "An indivisible declarative draft record exceeds 256 KiB. Preserve the original and revise that record through normal authoring; no metadata was truncated.");
  }
  return records;
}

function packParts(records: DraftRecord[], bundleId: string): string[] {
  const parts: string[] = [];
  let current: DraftRecord[] = [];
  const encoded = (entries: DraftRecord[]) => `${JSON.stringify({ schema_version: PART_VERSION, bundle_id: bundleId, index: parts.length, records: entries })}\n`;
  for (const record of records) {
    if (current.length && byteLength(encoded([...current, record])) > limits.structuredDraftBytes) {
      parts.push(encoded(current)); current = [];
    }
    current.push(record);
    if (byteLength(encoded(current)) > limits.structuredDraftBytes) fail("STRUCTURED_DRAFT_BUNDLE_PART_LIMIT", "A complete record cannot fit a bounded part.");
  }
  if (current.length) parts.push(encoded(current));
  if (!parts.length || parts.length > limits.structuredDraftParts) fail("STRUCTURED_DRAFT_BUNDLE_PART_LIMIT", "Complete draft exceeds the finite part-count limit.");
  return parts;
}

function assembleRecords(records: DraftRecord[]): ObjectValue {
  const payload: ObjectValue = { read: { resources: [] }, actions: [] };
  const collections: Record<RecordKind, unknown[]> = { property: [], read_resource: (payload.read as { resources: unknown[] }).resources,
    action: payload.actions as unknown[], skeleton: [], source: [] };
  const seen = new Set<string>();
  for (const record of records) {
    if (!["property", "read_resource", "action", "skeleton", "source"].includes(record.kind)
      || !Number.isSafeInteger(record.index) || record.index < 0) fail("STRUCTURED_DRAFT_BUNDLE_RECORD_INVALID", "Invalid typed record or index.");
    if (record.kind === "property") {
      const expected = propertyKeys[record.index] ?? Object.keys(collectionKinds)[record.index - propertyKeys.length];
      if (record.key !== expected || !expected || seen.has(expected)
        || (["actions", "read"].includes(expected))
        || (!propertyKeys.includes(expected) && (!Array.isArray(record.value) || record.value.length))) {
        fail("STRUCTURED_DRAFT_BUNDLE_RECORD_INVALID", "Duplicate, foreign or invalid property record.");
      }
      seen.add(expected); payload[expected] = record.value;
    } else {
      if (record.key !== undefined || record.index !== collections[record.kind].length) fail("STRUCTURED_DRAFT_BUNDLE_RECORD_INVALID", "Collection records must retain exact unique contiguous order.");
      collections[record.kind].push(record.value);
    }
  }
  if (collections.skeleton.length) payload.action_skeletons = collections.skeleton;
  if (collections.source.length) payload.attached_sources = collections.source;
  if (!seen.has("schema_version") || !seen.has("review_bundle_digest") || !seen.has("bindings")) fail("STRUCTURED_DRAFT_BUNDLE_RECORD_INVALID", "Draft header is incomplete.");
  // A fixed canonical record sequence detects reordering even when an attacker
  // recomputes individual file hashes. Hashes still confer no policy authority.
  if (JSON.stringify(draftRecords(payload)) !== JSON.stringify(records)) fail("STRUCTURED_DRAFT_BUNDLE_RECORD_INVALID", "Draft records are not in their declared complete order.");
  return payload;
}

function parseManifest(value: unknown, basename: string): Manifest {
  const manifest = object(value, "manifest");
  keys(manifest, ["schema_version", "bundle_id", "payload_digest", "parts_directory", "parts", "records", "part_bytes", "manifest_digest"]);
  const { manifest_digest: declared, ...core } = manifest;
  if (declared !== canonicalJsonDigest(core) || typeof manifest.bundle_id !== "string"
    || !/^[a-f0-9-]{36}$/u.test(manifest.bundle_id) || !hash(manifest.payload_digest)
    || manifest.parts_directory !== `${basename}.parts` || !Array.isArray(manifest.parts)
    || !manifest.parts.length || manifest.parts.length > limits.structuredDraftParts
    || !integer(manifest.records, 1, limits.structuredDraftRecords)
    || !integer(manifest.part_bytes, 1, limits.structuredDraftTotalBytes)) {
    fail("STRUCTURED_DRAFT_BUNDLE_MANIFEST_INVALID", "Manifest identity, membership, integrity or finite limits are invalid.");
  }
  let bytes = 0, count = 0;
  manifest.parts.forEach((value, index) => {
    const member = object(value, "manifest member"); keys(member, ["file", "index", "bytes", "digest", "records"]);
    if (member.file !== partName(index) || member.index !== index || !hash(member.digest)
      || !integer(member.bytes, 1, limits.structuredDraftBytes) || !integer(member.records, 1, limits.structuredDraftRecords)) {
      fail("STRUCTURED_DRAFT_BUNDLE_MANIFEST_INVALID", "Part names and ordered indexes must be exact local members within finite limits.");
    }
    bytes += member.bytes as number; count += member.records as number;
  });
  if (bytes !== manifest.part_bytes || count !== manifest.records) fail("STRUCTURED_DRAFT_BUNDLE_MANIFEST_INVALID", "Manifest totals do not match its exact membership.");
  return manifest as Manifest;
}

async function projectFile(root: string, supplied: string, writing: boolean): Promise<string> {
  const target = path.resolve(root, supplied);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("STRUCTURED_DRAFT_PATH_INVALID", "Draft exchange files must be inside the selected project.");
  const segments = relative.split(path.sep);
  if (writing && (segments[0] === ".synapsor" || (segments[0] === "synapsor" && segments[1] === "generated"))) fail("STRUCTURED_DRAFT_PATH_INVALID", "Draft exports must not write under Runner authority or generated-artifact directories.");
  await assertParents(root, target, writing);
  return target;
}

async function assertParents(root: string, target: string, create: boolean): Promise<void> {
  let current = root;
  for (const segment of path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let entry = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!entry && create) { await fs.mkdir(current, { mode: 0o700 }); entry = await fs.lstat(current); }
    if (!entry?.isDirectory() || entry.isSymbolicLink()) fail("STRUCTURED_DRAFT_PATH_INVALID", "Draft exchange parent directories must be real project-local directories.");
  }
}

async function boundedText(root: string, file: string, maximum: number): Promise<string> {
  await assertParents(root, file, false);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) fail("STRUCTURED_DRAFT_PATH_INVALID", "Draft input must be a single-link regular file.");
    if (stat.size > maximum) fail("STRUCTURED_DRAFT_TOO_LARGE", `Draft input exceeds ${maximum} bytes. No partial draft was read.`);
    const buffer = Buffer.alloc(maximum + 1); let offset = 0;
    while (offset < buffer.length) { const read = await handle.read(buffer, offset, buffer.length - offset, null); if (!read.bytesRead) break; offset += read.bytesRead; }
    if (offset > maximum) fail("STRUCTURED_DRAFT_TOO_LARGE", `Draft input exceeds ${maximum} bytes. No partial draft was read.`);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)); }
    catch { return fail("STRUCTURED_DRAFT_JSON_INVALID", "Draft input must be valid UTF-8."); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") fail("STRUCTURED_DRAFT_PATH_INVALID", "Draft input must not be a symbolic link.");
    throw error;
  } finally { await handle?.close(); }
}

async function publishFile(root: string, target: string, text: string, published?: () => void): Promise<void> {
  await assertParents(root, target, false);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(text, "utf8"); await handle.sync(); await handle.close(); handle = undefined;
    await assertParents(root, target, false);
    await fs.link(temporary, target); // exclusive atomic publication of complete bytes
    published?.();
    await fs.unlink(temporary);
    await syncDirectory(path.dirname(target));
  } finally { await handle?.close(); await fs.unlink(temporary).catch(() => undefined); }
}

async function absent(target: string): Promise<void> {
  const entry = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (entry) fail("STRUCTURED_DRAFT_OUTPUT_EXISTS", "Draft export refuses to overwrite an existing project file or parts directory.");
}
async function syncDirectory(directory: string): Promise<void> {
  // Directory fsync is available on the supported POSIX host. Some platforms
  // explicitly refuse it; complete-file publication remains atomic there.
  let handle: fs.FileHandle | undefined;
  try { handle = await fs.open(directory, constants.O_RDONLY); await handle.sync(); }
  catch (error) { if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  finally { await handle?.close(); }
}
function object(value: unknown, label: string): ObjectValue { if (!value || typeof value !== "object" || Array.isArray(value)) fail("STRUCTURED_DRAFT_BUNDLE_SHAPE_INVALID", `${label} must be an object.`); return value as ObjectValue; }
function keys(value: ObjectValue, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail("STRUCTURED_DRAFT_BUNDLE_SHAPE_INVALID", "Draft exchange contains unsupported fields."); }
function integer(value: unknown, minimum: number, maximum: number): value is number { return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum; }
function hash(value: unknown): value is string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value); }
function digest(text: string): string { return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`; }
function byteLength(text: string): number { return Buffer.byteLength(text, "utf8"); }
function partName(index: number): string { return `part-${String(index + 1).padStart(4, "0")}.json`; }
function parseJson(text: string): unknown { try { return JSON.parse(text); } catch { fail("STRUCTURED_DRAFT_JSON_INVALID", "Draft input must be one valid JSON document."); } }
function assertPrivateMaterial(value: unknown): void {
  // Reject recognizable credential material, not business meaning or field names.
  // The fixed declarative record shape excludes database row/queue/grant stores.
  const serialized = JSON.stringify(value);
  if (/BEGIN [A-Z ]*PRIVATE KEY|(?:postgres(?:ql)?|mysql|https?):\/\/[^\s"/@:]+:[^\s"/@]+@|(?:api[_-]?key|password)\s*[:=]\s*[^\s";,]{3,}|bearer\s+[A-Za-z0-9._-]{12,}/iu.test(serialized)) {
    fail("STRUCTURED_DRAFT_PRIVATE_MATERIAL_BLOCKED", "Credentials and private keys are not permitted in local declarative draft exchange. Original work is preserved.");
  }
}
function fail(code: string, message: string): never { throw Object.assign(new Error(`${code}: ${message}`), { code }); }
