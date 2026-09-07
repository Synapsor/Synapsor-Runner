import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectRuntimeOperations, withProjectRuntimeAdmission, withProjectRuntimeCutover } from "./project-runtime-admission.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";

const roots: string[] = [], children: ChildProcess[] = [];
async function project() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-runtime-admission-")); roots.push(root); return root; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
  }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("local runtime cutover admission", () => {
  it("allows concurrent readers and waits for both before cutover", async () => {
    const root = await project(), first = deferred(), second = deferred();
    const entered: string[] = [];
    const a = withProjectRuntimeAdmission(root, async () => { entered.push("a"); await first.promise; });
    const b = withProjectRuntimeAdmission(root, async () => { entered.push("b"); await second.promise; });
    await vi.waitFor(() => expect(entered).toHaveLength(2));
    const callback = vi.fn(async () => undefined);
    const cutover = withProjectRuntimeCutover(root, callback);
    await delay(50); expect(callback).not.toHaveBeenCalled();
    first.resolve(); await a; await delay(50); expect(callback).not.toHaveBeenCalled();
    second.resolve(); await b; await cutover; expect(callback).toHaveBeenCalledOnce();
  });

  it("supports nested reads while cutover waits without deadlocking", async () => {
    const root = await project(); let cutover!: Promise<void>;
    await withProjectRuntimeAdmission(root, async () => {
      cutover = withProjectRuntimeCutover(root, async () => undefined);
      await delay(50);
      await expect(withProjectRuntimeAdmission(root, async () => "nested")).resolves.toBe("nested");
      // Ordinary revision writers do not depend on the cutover gate.
      await withProjectAuthorityMutation(root, async () => undefined);
    });
    await cutover;
  });

  it("blocks new runtime work throughout cutover and releases after failure", async () => {
    const root = await project(), callback = vi.fn(async () => undefined);
    await expect(withProjectRuntimeCutover(root, async () => {
      await expect(withProjectRuntimeAdmission(root, callback, { waitMs: 50 })).rejects.toHaveProperty("code", "POLICY_RUNTIME_BUSY");
      expect(callback).not.toHaveBeenCalled(); throw new Error("cutover refused");
    })).rejects.toThrow("cutover refused");
    await withProjectRuntimeAdmission(root, callback); expect(callback).toHaveBeenCalledOnce();
  });

  it("drains accepted work before closing and refuses new work", async () => {
    const root = await project(), entered = deferred(), release = deferred(), cleanup = vi.fn(async () => undefined);
    const runtime = projectRuntimeOperations(root);
    const work = runtime.run(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const close = runtime.close(cleanup);
    await expect(runtime.run(async () => undefined)).rejects.toHaveProperty("code", "POLICY_RUNTIME_CLOSED");
    expect(cleanup).not.toHaveBeenCalled(); release.resolve(); await work; await close;
    await runtime.close(cleanup); expect(cleanup).toHaveBeenCalledOnce();
  });

  it("preserves a private inode and follows the original canonical root", async () => {
    const root = await project(), other = await project(), alias = path.join(other, "alias");
    await fs.symlink(root, alias);
    await withProjectRuntimeAdmission(alias, async (canonical) => {
      expect(canonical).toBe(root);
      await fs.unlink(alias); await fs.symlink(other, alias);
      await expect(withProjectRuntimeCutover(root, async () => undefined, { waitMs: 30 })).rejects.toHaveProperty("code", "POLICY_RUNTIME_BUSY");
    });
    const file = path.join(root, ".synapsor/runtime-admission.sqlite"), before = await fs.stat(file);
    await withProjectRuntimeCutover(root, async () => undefined);
    const after = await fs.stat(file); expect(after.ino).toBe(before.ino); expect(after.mode & 0o777).toBe(0o600);
    const db = new DatabaseSync(file);
    try { expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([]); } finally { db.close(); }
    await expect(fs.stat(path.join(other, ".synapsor"))).rejects.toHaveProperty("code", "ENOENT");
  });

  it("closes idle owned resources during cutover without waiting for admission", async () => {
    const root = await project(), runtime = projectRuntimeOperations(root), cleanup = vi.fn(async () => undefined);
    await withProjectRuntimeCutover(root, async () => { await runtime.close(cleanup); });
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(runtime.run(async () => undefined)).rejects.toHaveProperty("code", "POLICY_RUNTIME_CLOSED");
  });

  it("releases failed work before an idempotent failing close", async () => {
    const root = await project(), runtime = projectRuntimeOperations(root), cleanup = vi.fn(async () => { throw new Error("close failed"); });
    await expect(runtime.run(async () => { throw new Error("work failed"); })).rejects.toThrow("work failed");
    await expect(runtime.close(cleanup)).rejects.toThrow("close failed");
    await expect(runtime.close(cleanup)).rejects.toThrow("close failed");
    expect(cleanup).toHaveBeenCalledOnce();
    await withProjectRuntimeCutover(root, async () => undefined);
  });

  it.each(["symlink", "hardlink", "wal"])("refuses a %s gate without running work", async (kind) => {
    const root = await project(), file = path.join(root, ".synapsor/runtime-admission.sqlite");
    await fs.mkdir(path.dirname(file));
    if (kind === "wal") {
      const db = new DatabaseSync(file); db.exec("PRAGMA journal_mode = WAL; CREATE TABLE marker (id INTEGER)"); db.close();
    } else {
      const target = path.join(root, "target"); await fs.writeFile(target, "");
      if (kind === "symlink") await fs.symlink(target, file); else await fs.link(target, file);
    }
    const work = vi.fn(async () => undefined);
    await expect(withProjectRuntimeAdmission(root, work)).rejects.toHaveProperty("code", "POLICY_RUNTIME_GATE_INVALID");
    expect(work).not.toHaveBeenCalled();
  });

  it("cancels before entering without changing the live gate", async () => {
    const root = await project(), controller = new AbortController(), work = vi.fn(async () => undefined);
    await withProjectRuntimeCutover(root, async () => {
      const waiting = withProjectRuntimeAdmission(root, work, { signal: controller.signal });
      const result = expect(waiting).rejects.toHaveProperty("code", "POLICY_RUNTIME_CANCELLED");
      await delay(30); controller.abort(); await result; expect(work).not.toHaveBeenCalled();
    });
  });

  it("releases a crashed independent reader without deleting its inode", async () => {
    const root = await project(), url = new URL("./project-runtime-admission.ts", import.meta.url).href;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { withProjectRuntimeAdmission } from ${JSON.stringify(url)};
      import { once } from 'node:events';
      await withProjectRuntimeAdmission(${JSON.stringify(root)}, async () => {
        process.send('entered'); await once(process, 'message');
      });
    `], { stdio: ["ignore", "ignore", "pipe", "ipc"] }); children.push(child);
    await once(child, "message");
    const file = path.join(root, ".synapsor/runtime-admission.sqlite"), before = await fs.stat(file);
    await expect(withProjectRuntimeCutover(root, async () => undefined, { waitMs: 30 })).rejects.toHaveProperty("code", "POLICY_RUNTIME_BUSY");
    const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
    await withProjectRuntimeCutover(root, async () => undefined);
    expect((await fs.stat(file)).ino).toBe(before.ino);
  });
});
