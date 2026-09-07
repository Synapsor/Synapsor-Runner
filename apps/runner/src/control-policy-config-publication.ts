import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ControlPolicyCommit } from "@synapsor-runner/proposal-store";
import { assertProjectControlPolicyBinding, commitImmutableControlPolicies, openBoundProjectControlPolicies, type BoundProjectPolicyStore } from "./control-policy-store.js";
import { settlePolicyPublication } from "./control-policy-publication-recovery.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

const MAX_BYTES = 16 * 1024 * 1024;
const recordSchema = z.object({
  schema_version: z.literal("synapsor.policy-config-publication/v1"),
  repository_id: z.string().uuid(), deployment_id: z.string().uuid(), project_id: z.string().uuid(),
  target: z.string().min(1).max(4096), expected_epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  before: z.string().max(MAX_BYTES).nullable(), after: z.string().max(MAX_BYTES),
  event: z.object({ event_id: z.string().min(1).max(256), actor: z.string().min(1).max(256),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u) }).strict(),
}).strict();
type PublicationRecord = z.infer<typeof recordSchema>;
type Location = { projectRoot: string; configPath: string; mutationPermit?: ProjectAuthorityMutationPermit };

/** Trusted operator persistence only. This journal is private recovery input,
 * not model context, a policy revision, or permission to issue a new commit. */
export async function publishPolicyConfiguration(input: Location & {
  binding: BoundProjectPolicyStore; before: string | undefined; after: string;
  change: Omit<ControlPolicyCommit, "deployment_id">;
}): Promise<void> {
  const { binding, before, after } = input;
  const change = structuredClone(input.change);
  return withProjectAuthorityMutation(input.projectRoot, async (held) => {
    await assertProjectControlPolicyBinding(held.projectRoot, binding);
    const files = await publicationPaths(held.projectRoot, heldTarget(input, held.projectRoot), true);
    await assertNoRecord(files.journal);
    if (await readPrivateTarget(files.target) !== before) throw configConflict();
    const record = recordSchema.parse({ schema_version: "synapsor.policy-config-publication/v1",
      repository_id: binding.repository_id, deployment_id: binding.deployment_id, project_id: binding.project_id,
      target: files.relative, expected_epoch: change.expected_epoch, before: before ?? null, after,
      event: { event_id: change.event.event_id, actor: change.event.actor, digest: canonicalJsonDigest(change.event) } });
    const text = JSON.stringify({ record, digest: canonicalJsonDigest(record) });
    if (Buffer.byteLength(text) > MAX_BYTES) throw invalidRecord();
    await durableReplace(files.journal, text, true);
    try {
      await durableReplace(files.target, record.after);
      await commitImmutableControlPolicies(binding, change);
    } catch (error) {
      let receipt;
      try { receipt = await binding.repository.event(binding.deployment_id, record.event.event_id); }
      catch (lookupError) { throw unconfirmed(record, lookupError); }
      if (!receipt || canonicalJsonDigest(receipt) !== canonicalJsonDigest({ ...change.event, epoch: record.expected_epoch + 1 })) {
        throw unconfirmed(record, error);
      }
    }
    // Even a confirmed store save does not authorize overwriting a newer file.
    if (await readPrivateTarget(files.target) !== record.after) throw configConflict();
    await finishJournal(files.journal, record, "committed");
  }, { permit: input.mutationPermit });
}

/** Called by operator execution review after restart, never by runtime/model
 * requests. It settles only the saved attempt; it cannot replay activation. */
export async function recoverPolicyConfiguration(input: Location & { env?: NodeJS.ProcessEnv }):
Promise<{ state: "none" | "committed" | "cancelled" }> {
  return withProjectAuthorityMutation(input.projectRoot, async (held) => {
    const files = await publicationPaths(held.projectRoot, heldTarget(input, held.projectRoot), false);
    const record = await readRecord(files.journal);
    if (!record) return { state: "none" };
    if (record.target !== files.relative) throw invalidRecord();
    const binding = await openBoundProjectControlPolicies(held.projectRoot, input.env);
    if (!binding) throw invalidRecord();
    try {
      if (binding.repository_id !== record.repository_id || binding.deployment_id !== record.deployment_id || binding.project_id !== record.project_id) {
        throw invalidRecord();
      }
      const current = await readPrivateTarget(files.target);
      if (current !== record.after && current !== (record.before ?? undefined)) throw configConflict();
      const result = await settlePolicyPublication({ binding, expectedEpoch: record.expected_epoch, event: record.event });
      if (result.state === "unconfirmed") throw unconfirmed(record, new Error(result.reason));
      // A durable cancellation prevents the original delayed transaction from
      // becoming authority after rollback. Missing receipts alone cannot do so.
      if (result.state === "cancelled") {
        if (await readPrivateTarget(files.target) !== current) throw configConflict();
        if (current !== (record.before ?? undefined)) {
          if (record.before === null) { await fs.unlink(files.target); await syncDirectory(path.dirname(files.target)); }
          else await durableReplace(files.target, record.before);
        }
      } else if (await readPrivateTarget(files.target) !== record.after) throw configConflict();
      await finishJournal(files.journal, record, result.state);
      return { state: result.state };
    } finally { await binding.close(); }
  }, { permit: input.mutationPermit });
}

/** Participating config writers must not replace an unresolved publication. */
export async function assertNoPendingPolicyConfiguration(projectRoot: string, configPath: string): Promise<void> {
  const files = await publicationPaths(projectRoot, configPath, false);
  await assertNoRecord(files.journal);
}

async function publicationPaths(projectRoot: string, configPath: string, create: boolean) {
  const root = await fs.realpath(projectRoot), target = path.resolve(configPath);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw invalidRecord();
  // Do not follow nested directory aliases or publish onto the recovery files.
  const parts = relative.split(path.sep);
  if (parts[0] === ".synapsor" && (parts[1] === "control-policy" || parts[1] === "authority-write-lock.sqlite")) throw invalidRecord();
  let parent = root;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    parent = path.join(parent, part);
    const stat = await fs.lstat(parent).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw invalidRecord();
  }
  let directory = root;
  for (const part of [".synapsor", "control-policy", "publications"]) {
    directory = path.join(directory, part);
    if (create) await fs.mkdir(directory, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    const stat = await fs.lstat(directory).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw invalidRecord();
    if (create) await syncDirectory(path.dirname(directory));
  }
  return { target, relative, journal: path.join(directory, `${canonicalJsonDigest(relative).slice(7)}.json`) };
}

function heldTarget(input: Location, root: string): string {
  const relative = path.relative(path.resolve(input.projectRoot), path.resolve(input.configPath));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw invalidRecord();
  return path.resolve(root, relative);
}

async function readPrivateTarget(file: string): Promise<string | undefined> {
  const stat = await fs.lstat(file).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw invalidRecord();
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > MAX_BYTES) throw invalidRecord();
    const text = await handle.readFile("utf8");
    if (Buffer.byteLength(text) > MAX_BYTES) throw invalidRecord();
    return text;
  } finally { await handle.close(); }
}

async function readRecord(file: string): Promise<PublicationRecord | undefined> {
  const text = await readPrivateTarget(file);
  if (text === undefined) return undefined;
  try {
    const parsed = z.object({ record: recordSchema, digest: z.string() }).strict().parse(JSON.parse(text));
    if (canonicalJsonDigest(parsed.record) !== parsed.digest) throw invalidRecord();
    return parsed.record;
  } catch { throw invalidRecord(); }
}

async function assertNoRecord(file: string): Promise<void> {
  if (await readPrivateTarget(file) !== undefined) {
    throw Object.assign(new Error("POLICY_CONFIG_PUBLICATION_PENDING: reopen execution review to recover the previous save before changing this configuration."),
      { code: "POLICY_CONFIG_PUBLICATION_PENDING" });
  }
}

async function durableReplace(file: string, contents: string, exclusive = false): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(contents, "utf8"); await handle.sync(); } finally { await handle.close(); }
    // All publishers/recovery hold the persistent project mutex. A rename
    // avoids a linked temporary inode remaining after process death. Refuse an
    // unexpected existing journal rather than replacing another saved attempt.
    if (exclusive) await assertNoRecord(file);
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally { await fs.rm(temporary, { force: true }); }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function finishJournal(file: string, record: PublicationRecord, state: "committed" | "cancelled"): Promise<void> {
  try { await fs.unlink(file); await syncDirectory(path.dirname(file)); }
  catch (cause) {
    throw Object.assign(new Error(`POLICY_CONFIG_RECOVERY_CLEANUP_PENDING: the publication is confirmed ${state}, but recovery-record cleanup could not be confirmed. Reopen execution review; do not repeat activation.`, { cause }),
      { code: "POLICY_CONFIG_RECOVERY_CLEANUP_PENDING", publication_state: state, event_id: record.event.event_id });
  }
}

function invalidRecord(): Error {
  return Object.assign(new Error("POLICY_CONFIG_RECOVERY_INVALID: the private publication record or path cannot be verified. Preserve it and inspect the project recovery state; no authority was replayed."),
    { code: "POLICY_CONFIG_RECOVERY_INVALID" });
}

function configConflict(): Error {
  return Object.assign(new Error("POLICY_CONFIG_RECOVERY_CONFLICT: the runtime configuration changed outside this save. Preserve the newer file and inspect the pending publication before retrying."),
    { code: "POLICY_CONFIG_RECOVERY_CONFLICT" });
}

function unconfirmed(record: PublicationRecord, cause: unknown): Error {
  return Object.assign(new Error("POLICY_EXECUTION_COMMIT_UNCONFIRMED: the execution save could not be confirmed. Its private recovery record is retained; reopen execution review to check the exact receipt. No rollback was attempted.", { cause }),
    { code: "POLICY_EXECUTION_COMMIT_UNCONFIRMED", event_id: record.event.event_id, expected_epoch: record.expected_epoch });
}
