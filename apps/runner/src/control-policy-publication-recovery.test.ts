import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ControlPolicyCommit, ControlPolicyRevision } from "@synapsor-runner/proposal-store";
import { migrateProjectControlPolicies, type BoundProjectPolicyStore } from "./control-policy-store.js";
import { settlePolicyPublication } from "./control-policy-publication-recovery.js";
import { assertNoPendingPolicyConfiguration, publishPolicyConfiguration, recoverPolicyConfiguration } from "./control-policy-config-publication.js";

const key = { scope: { level: "operator" as const }, kind: "action" as const, name: "inventory.replenish" };
function revision(maximum: number): ControlPolicyRevision {
  const content = { maximum };
  return { ...key, revision_id: `fixture-v${maximum}`, content, content_digest: canonicalJsonDigest(content), authority_digest: canonicalJsonDigest(content) };
}

async function useStore(backend: string, run: (binding: BoundProjectPolicyStore, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-publication-recovery-"));
  const schema = `recovery_${randomUUID().replaceAll("-", "")}`;
  const admin = backend === "postgres" ? new Pool({ connectionString: process.env.SYNAPSOR_TEST_POSTGRES_URL, connectionTimeoutMillis: 2000 }) : undefined;
  let binding: BoundProjectPolicyStore | undefined;
  try {
    const config = { storage: backend === "postgres"
      ? { shared_postgres: { mode: "runtime_store", schema, url_env: "POLICY_TEST_URL" } }
      : { sqlite_path: path.join(root, "control.db") } } as RuntimeConfig;
    binding = (await migrateProjectControlPolicies({ projectRoot: root, storePath: path.join(root, "control.db"), config,
      env: { POLICY_TEST_URL: process.env.SYNAPSOR_TEST_POSTGRES_URL }, actor: "operator",
      readLegacySnapshot: async () => ({ revisions: [revision(10)], active: [{ ...key, revision_id: revision(10).revision_id }], drafts: [], provenance: [] }),
      validateSnapshot: async () => undefined,
    })).binding;
    await run(binding, root);
  } finally {
    await binding?.close();
    if (admin) { try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); } }
    await fs.rm(root, { recursive: true, force: true });
  }
}

for (const backend of ["sqlite", ...(process.env.SYNAPSOR_TEST_POSTGRES_URL ? ["postgres"] : [])]) {
  describe(`${backend} publication settlement`, () => {
    it.each(["committed", "cancel", "commit_race", "cancellation_lost", "unavailable", "mismatch", "concurrent", "repeated"])(
      "fences the original attempt without changing unrelated authority: %s", async (mode) => {
      await useStore(backend, async (binding) => {
        const repo = binding.repository;
        const event = { event_id: randomUUID(), actor: "operator", occurred_at: new Date().toISOString(), receipt: { operation: "test_reviewed_publication" } };
        const input = { binding, expectedEpoch: 1, event: { event_id: event.event_id, actor: event.actor, digest: canonicalJsonDigest(event) } };
        const publication: ControlPolicyCommit = { deployment_id: binding.deployment_id, expected_epoch: 1,
          revisions: [revision(20)], active: [{ ...key, revision_id: revision(20).revision_id }], event };
        const commit = repo.commit.bind(repo), lookup = repo.event.bind(repo);
        if (mode === "committed") await commit(publication);
        if (mode === "mismatch") await commit({ ...publication, event: { ...event, actor: "different_operator" } });
        if (mode === "concurrent") await commit({ ...publication, revisions: [], active: [], event: { ...event, event_id: randomUUID() } });
        let observedMissing = false;
        const eventSpy = vi.spyOn(repo, "event").mockImplementation(async (...args) => {
          if (mode === "unavailable") throw new Error("receipt unavailable");
          const result = await lookup(...args);
          if (mode === "commit_race" && !observedMissing) {
            observedMissing = true;
            expect(result).toBeUndefined();
            await commit(publication);
          }
          return result;
        });
        const commitSpy = vi.spyOn(repo, "commit").mockImplementation(async (change) => {
          const epoch = await commit(change);
          if (mode === "cancellation_lost") throw new Error("lost cancellation acknowledgement");
          return epoch;
        });
        let result;
        try { result = await settlePolicyPublication(input); }
        finally { eventSpy.mockRestore(); commitSpy.mockRestore(); }
        const isCommitted = mode === "committed" || mode === "commit_race";
        const isCancelled = mode === "cancel" || mode === "cancellation_lost" || mode === "repeated";
        expect(result.state).toBe(isCommitted ? "committed" : isCancelled ? "cancelled" : "unconfirmed");
        if (isCancelled) {
          await expect(commit(publication)).rejects.toMatchObject({ code: "POLICY_REVISION_CONFLICT" });
          expect((await settlePolicyPublication(input)).state).toBe("cancelled");
          expect((await repo.deployment(binding.deployment_id))!.epoch).toBe(2);
        }
        if (mode === "unavailable") expect((await repo.deployment(binding.deployment_id))!.epoch).toBe(1);
        expect((await repo.active(binding.deployment_id, key))!.revision_id).toBe(isCommitted || mode === "mismatch" ? revision(20).revision_id : revision(10).revision_id);
        if (isCancelled) expect((await repo.event(binding.deployment_id, event.event_id))!.receipt).toMatchObject({
          operation: "cancel_unconfirmed_policy_publication", publication_event_digest: canonicalJsonDigest(event), authority_changed: false,
        });
      });
    });

    it.each(["before_replace", "before_commit", "unknown_commit", "journal_cleanup", "newer_config", "corrupt_record", "missing_config", "unavailable", "lost_cancellation", "restore_race"])(
      "recovers a durable private config intent without replay or lost edits: %s", async (mode) => {
      await useStore(backend, async (binding, projectRoot) => {
        const configPath = path.join(projectRoot, "runner.json");
        const before = JSON.stringify({ marker: "before", private_fixture: "do-not-disclose" });
        const after = JSON.stringify({ marker: "after", private_fixture: "do-not-disclose" });
        if (mode !== "missing_config") await fs.writeFile(configPath, before);
        const event = { event_id: randomUUID(), actor: "operator", occurred_at: new Date().toISOString(), receipt: { operation: "test_reviewed_publication", private_fixture: "receipt-not-journaled" } };
        const change = { expected_epoch: 1, revisions: [revision(20)], active: [{ ...key, revision_id: revision(20).revision_id }], event };
        const args = { binding, projectRoot, configPath, before: mode === "missing_config" ? undefined : before, after, change };
        const commit = binding.repository.commit.bind(binding.repository), lookup = binding.repository.event.bind(binding.repository);
        const journalDirectory = path.join(projectRoot, ".synapsor/control-policy/publications");
        const rename = fs.rename.bind(fs), unlink = fs.unlink.bind(fs);
        const renameFault = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
          if (mode === "before_replace" && to === configPath) throw new Error("Interrupted before config replace");
          return rename(from, to);
        });
        const unlinkFault = vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
          if (mode === "journal_cleanup" && String(file).startsWith(journalDirectory)) throw new Error("Interrupted after policy commit");
          return unlink(file);
        });
        const commitFault = vi.spyOn(binding.repository, "commit").mockImplementation(async (input) => {
          if (["unknown_commit", "journal_cleanup"].includes(mode)) {
            const epoch = await commit(input);
            if (mode === "journal_cleanup") return epoch;
          }
          throw new Error("Interrupted or lost commit response");
        });
        const lookupFault = vi.spyOn(binding.repository, "event").mockImplementation(async (...input) => {
          if (mode === "unknown_commit") throw new Error("Receipt temporarily unavailable");
          return lookup(...input);
        });
        try { await expect(publishPolicyConfiguration(args)).rejects.toThrow(mode === "journal_cleanup" ? "POLICY_CONFIG_RECOVERY_CLEANUP_PENDING" : "POLICY_EXECUTION_COMMIT_UNCONFIRMED"); }
        finally { commitFault.mockRestore(); lookupFault.mockRestore(); renameFault.mockRestore(); unlinkFault.mockRestore(); }
        const journals = (await fs.readdir(journalDirectory)).filter((file) => file.endsWith(".json"));
        expect(journals).toHaveLength(1);
        const journalPath = path.join(journalDirectory, journals[0]!);
        const journal = await fs.readFile(journalPath, "utf8");
        expect((await fs.stat(journalPath)).mode & 0o777).toBe(0o600);
        expect(JSON.parse(journal).record).toMatchObject({ repository_id: binding.repository_id,
          event: { event_id: event.event_id, actor: event.actor, digest: canonicalJsonDigest(event) } });
        expect(journal).not.toContain("receipt-not-journaled");
        await expect(assertNoPendingPolicyConfiguration(projectRoot, configPath)).rejects.toThrow("POLICY_CONFIG_PUBLICATION_PENDING");
        await expect(publishPolicyConfiguration({ ...args, before: after })).rejects.toThrow("POLICY_CONFIG_PUBLICATION_PENDING");
        if (mode === "newer_config") await fs.writeFile(configPath, "newer local edit");
        if (mode === "corrupt_record") await fs.writeFile(journalPath, journal.replace("do-not-disclose", "changed"));
        // Reopen the configured repository through its durable project binding;
        // recovery does not depend on the original connection or config parse.
        const recovery = { projectRoot, configPath, env: { POLICY_TEST_URL: process.env.SYNAPSOR_TEST_POSTGRES_URL } };
        if (mode === "newer_config" || mode === "corrupt_record") {
          await expect(recoverPolicyConfiguration(recovery)).rejects.toThrow(mode === "newer_config" ? "POLICY_CONFIG_RECOVERY_CONFLICT" : "POLICY_CONFIG_RECOVERY_INVALID");
          expect((await binding.repository.deployment(binding.deployment_id))!.epoch).toBe(1);
          expect(await fs.readFile(configPath, "utf8")).toBe(mode === "newer_config" ? "newer local edit" : after);
          return;
        }
        if (mode === "unavailable" || mode === "lost_cancellation" || mode === "restore_race") {
          const prototype = Object.getPrototypeOf(binding.repository) as typeof binding.repository;
          const originalCommit = prototype.commit, originalEvent = prototype.event;
          let cancelled = false;
          const fault = vi.spyOn(prototype, "commit").mockImplementation(async function (this: typeof prototype, input) {
            const epoch = await originalCommit.call(this, input);
            if (mode === "lost_cancellation") { cancelled = true; throw new Error("Lost cancellation response"); }
            if (mode === "restore_race") await fs.writeFile(configPath, "newer edit during cancellation");
            return epoch;
          });
          const eventFault = vi.spyOn(prototype, "event").mockImplementation(async function (this: typeof prototype, ...input) {
            if (mode === "unavailable" || cancelled) throw new Error("Recovery receipt unavailable");
            return originalEvent.call(this, ...input);
          });
          try { await expect(recoverPolicyConfiguration(recovery)).rejects.toThrow(mode === "restore_race" ? "POLICY_CONFIG_RECOVERY_CONFLICT" : "POLICY_EXECUTION_COMMIT_UNCONFIRMED"); }
          finally { fault.mockRestore(); eventFault.mockRestore(); }
          expect(await fs.readFile(configPath, "utf8")).toBe(mode === "restore_race" ? "newer edit during cancellation" : after);
          expect(await fs.readFile(journalPath, "utf8")).toBe(journal);
          if (mode === "restore_race") return;
        }
        const committed = mode === "unknown_commit" || mode === "journal_cleanup";
        await expect(recoverPolicyConfiguration(recovery)).resolves.toEqual({ state: committed ? "committed" : "cancelled" });
        await expect(recoverPolicyConfiguration(recovery)).resolves.toEqual({ state: "none" });
        expect(await fs.readFile(configPath, "utf8").catch((error) => { if (error.code === "ENOENT") return undefined; throw error; }))
          .toBe(committed ? after : args.before);
        expect((await binding.repository.deployment(binding.deployment_id))!.epoch).toBe(2);
        expect((await binding.repository.active(binding.deployment_id, key))!.revision_id).toBe(revision(committed ? 20 : 10).revision_id);
        if (!committed) await expect(commit({ ...change, deployment_id: binding.deployment_id })).rejects.toMatchObject({ code: "POLICY_REVISION_CONFLICT" });
        expect(await fs.readdir(journalDirectory)).toEqual([]);
      });
    });

    it("rejects mismatched bindings and unsafe paths before saving any config intent", async () => {
      await useStore(backend, async (binding, projectRoot) => {
        const configPath = path.join(projectRoot, "runner.json"), before = "original";
        await fs.writeFile(configPath, before);
        const change = { expected_epoch: 1, revisions: [], active: [], event: {
          event_id: randomUUID(), actor: "operator", occurred_at: new Date().toISOString(), receipt: {} } };
        await expect(publishPolicyConfiguration({ projectRoot, configPath, before, after: "changed", change,
          binding: { ...binding, deployment_id: randomUUID() } })).rejects.toMatchObject({ code: "POLICY_REPOSITORY_MISMATCH" });
        expect(await fs.readFile(configPath, "utf8")).toBe(before);
        const alias = path.join(projectRoot, "alias.json"); await fs.symlink(configPath, alias);
        await expect(publishPolicyConfiguration({ projectRoot, configPath: alias, before, after: "changed", change, binding }))
          .rejects.toMatchObject({ code: "POLICY_CONFIG_RECOVERY_INVALID" });
        const escape = path.join(projectRoot, "directory-alias"); await fs.symlink(projectRoot, escape, "dir");
        await expect(publishPolicyConfiguration({ projectRoot, configPath: path.join(escape, "runner.json"), before, after: "changed", change, binding }))
          .rejects.toMatchObject({ code: "POLICY_CONFIG_RECOVERY_INVALID" });
        expect((await binding.repository.deployment(binding.deployment_id))!.epoch).toBe(1);
        expect(await fs.readdir(path.join(projectRoot, ".synapsor/control-policy/publications"))).toEqual([]);
      });
    });

    it("enforces cancellation as a no-op fence in the actual repository", async () => {
      await useStore(backend, async (binding) => {
        const cancellation = { event_id: randomUUID(), actor: "operator", occurred_at: new Date().toISOString(), receipt: {
          operation: "cancel_unconfirmed_policy_publication", publication_event_digest: canonicalJsonDigest({ reviewed: true }),
          authority_changed: false, source_database_changed: false } };
        for (const mutation of [
          { revisions: [revision(20)], active: [] },
          { revisions: [], active: [{ ...key, revision_id: null }] },
          { revisions: [], active: [], drafts: [{ ...key, revision_id: revision(10).revision_id }] },
        ]) {
          await expect(binding.repository.commit({ deployment_id: binding.deployment_id, expected_epoch: 1,
            ...mutation, event: cancellation })).rejects.toMatchObject({ code: "POLICY_PUBLICATION_FENCE_INVALID" });
        }
        expect((await binding.repository.deployment(binding.deployment_id))!.epoch).toBe(1);
        expect(await binding.repository.event(binding.deployment_id, cancellation.event_id)).toBeUndefined();
        await binding.repository.commit({ deployment_id: binding.deployment_id, expected_epoch: 1, revisions: [], active: [], event: cancellation });
        expect((await binding.repository.active(binding.deployment_id, key))!.revision_id).toBe(revision(10).revision_id);
      });
    });

    it.each(["before_config", "before_commit", "after_commit"])("recovers after a real process death: %s", async (stage) => {
      await useStore(backend, async (binding, projectRoot) => {
        const configPath = path.join(projectRoot, "runner.json"), before = '{"marker":"before"}', after = '{"marker":"after"}';
        await fs.writeFile(configPath, before);
        const event = { event_id: randomUUID(), actor: "operator", occurred_at: new Date().toISOString(), receipt: { operation: "test_reviewed_publication" } };
        const change = { expected_epoch: 1, revisions: [revision(20)], active: [{ ...key, revision_id: revision(20).revision_id }], event };
        const storeModule = new URL("./control-policy-store.ts", import.meta.url).href;
        const publicationModule = new URL("./control-policy-config-publication.ts", import.meta.url).href;
        const code = `
          import fs from 'node:fs/promises';
          import { openBoundProjectControlPolicies } from ${JSON.stringify(storeModule)};
          import { publishPolicyConfiguration } from ${JSON.stringify(publicationModule)};
          const input = ${JSON.stringify({ projectRoot, configPath, before, after, change })};
          const binding = await openBoundProjectControlPolicies(input.projectRoot);
          const pause = async () => { setInterval(() => {}, 1000); process.send('publication-paused'); await new Promise(() => {}); };
          if (${JSON.stringify(stage)} === 'before_config') {
            const rename = fs.rename.bind(fs);
            fs.rename = async (from, to) => { if (to === input.configPath) await pause(); return rename(from, to); };
          }
          const commit = binding.repository.commit.bind(binding.repository);
          binding.repository.commit = async (change) => {
            if (${JSON.stringify(stage)} === 'before_commit') await pause();
            const result = await commit(change);
            if (${JSON.stringify(stage)} === 'after_commit') await pause();
            return result;
          };
          await publishPolicyConfiguration({ ...input, binding });
        `;
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
          cwd: fileURLToPath(new URL("../../../", import.meta.url)),
          env: { ...process.env, POLICY_TEST_URL: process.env.SYNAPSOR_TEST_POSTGRES_URL }, stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        let diagnostics = "";
        child.stderr!.on("data", (chunk) => { diagnostics += chunk.toString(); });
        const closed = once(child, "close");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            once(child, "message").then(([message]) => message),
            closed.then(() => { throw new Error(`Child exited before fault point: ${diagnostics}`); }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Child did not reach fault point: ${diagnostics}`)), 15_000); }),
          ]);
          expect(result).toBe("publication-paused");
        } finally {
          if (timer) clearTimeout(timer);
          child.kill("SIGKILL"); await closed;
        }
        const args = { projectRoot, configPath, env: { POLICY_TEST_URL: process.env.SYNAPSOR_TEST_POSTGRES_URL } };
        await expect(recoverPolicyConfiguration(args)).resolves.toEqual({ state: stage === "after_commit" ? "committed" : "cancelled" });
        expect(await fs.readFile(configPath, "utf8")).toBe(stage === "after_commit" ? after : before);
        expect((await binding.repository.active(binding.deployment_id, key))!.revision_id).toBe(revision(stage === "after_commit" ? 20 : 10).revision_id);
        expect((await binding.repository.deployment(binding.deployment_id))!.epoch).toBe(2);
        await expect(recoverPolicyConfiguration(args)).resolves.toEqual({ state: "none" });
      });
    });
  });
}
