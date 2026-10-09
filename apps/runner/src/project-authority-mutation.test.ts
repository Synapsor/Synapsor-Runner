import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import { deactivateExplorationBoundary } from "./auto-boundary.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
const moduleUrl = new URL("./project-authority-mutation.ts", import.meta.url).href;
async function project() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-authority-mutex-")); roots.push(root); return root; }
function mutex(root: string) { return path.join(root, ".synapsor/authority-write-lock.sqlite"); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  }
  // Only uniquely owned test directories, after every holder has exited.
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function writer(root: string, hold: boolean) {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { withProjectAuthorityMutation } from ${JSON.stringify(moduleUrl)};
    import { once } from 'node:events';
    process.send('attempt');
    await withProjectAuthorityMutation(${JSON.stringify(root)}, async () => {
      const released = ${hold} ? once(process, 'message') : undefined;
      process.send('entered');
      await released;
    });
    process.send('done'); process.disconnect();
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(child);
  const messages: unknown[] = [];
  let diagnostics = "";
  child.on("message", (message) => { messages.push(message); });
  child.stderr?.on("data", (text) => { diagnostics = `${diagnostics}${text}`.slice(-4000); });
  return { child, messages, async wait(message: string) {
    await vi.waitFor(() => {
      if (child.exitCode !== null && !messages.includes(message)) throw new Error(diagnostics);
      expect(messages).toContain(message);
    }, { timeout: 10_000, interval: 10 });
  } };
}

describe("project-local authority mutation exclusion", () => {
  it("makes native Read publication wait for the project writer", async () => {
    const root = await project();
    let finished = false;
    let pending!: ReturnType<typeof deactivateExplorationBoundary>;
    const entered = deferred(), release = deferred();
    const holder = withProjectAuthorityMutation(root, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    pending = deactivateExplorationBoundary(root).then((result) => { finished = true; return result; });
    try { await delay(150); expect(finished).toBe(false); }
    finally { release.resolve(); await holder; }
    await expect(pending).resolves.toEqual({ disabled: [], remaining: [] });
  });

  it("refuses an old-format activation lock without deleting it based on age", async () => {
    const root = await project();
    await fs.mkdir(path.join(root, ".synapsor"));
    const legacy = path.join(root, ".synapsor/exploration-boundaries.active.lock");
    await fs.writeFile(legacy, JSON.stringify({ pid: process.pid, created_at: new Date(0).toISOString() }));
    await fs.utimes(legacy, new Date(0), new Date(0));
    await expect(deactivateExplorationBoundary(root)).rejects.toMatchObject({ code: "POLICY_LEGACY_MUTATION_LOCK_PRESENT" });
    expect(JSON.parse(await fs.readFile(legacy, "utf8")).pid).toBe(process.pid);
  });

  it("waits asynchronously and keeps a private persistent inode without a policy table", async () => {
    const root = await project();
    const entered = deferred(), release = deferred();
    const holder = withProjectAuthorityMutation(root, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const before = await fs.stat(mutex(root));
    const contender = vi.fn(async () => "next");
    const pending = withProjectAuthorityMutation(root, contender);
    await delay(50);
    expect(contender).not.toHaveBeenCalled();
    release.resolve(); await holder;
    await expect(pending).resolves.toBe("next");
    const after = await fs.stat(mutex(root));
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o600);
    const db = new DatabaseSync(mutex(root));
    try { expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([]); } finally { db.close(); }
  });

  it("never steals an old live lock, and times out without running the callback", async () => {
    const root = await project();
    const entered = deferred(), release = deferred();
    const holder = withProjectAuthorityMutation(root, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    try {
      await fs.utimes(mutex(root), new Date(0), new Date(0));
      const callback = vi.fn(async () => undefined);
      await expect(withProjectAuthorityMutation(root, callback, { waitMs: 60 })).rejects.toMatchObject({ code: "POLICY_MUTATION_BUSY" });
      expect(callback).not.toHaveBeenCalled();
    } finally { release.resolve(); await holder; }
    await expect(withProjectAuthorityMutation(root, async () => "released")).resolves.toBe("released");
  });

  it.each(["return", "crash"])("serializes independent processes and releases on %s without recreating the inode", async (mode) => {
    const root = await project();
    const holder = writer(root, true); await holder.wait("entered");
    const before = await fs.stat(mutex(root));
    const contender = writer(root, false); await contender.wait("attempt");
    await delay(80); expect(contender.messages).not.toContain("entered");
    if (mode === "crash") { const exited = once(holder.child, "exit"); holder.child.kill("SIGKILL"); await exited; }
    else { holder.child.send("release"); await holder.wait("done"); }
    await contender.wait("done");
    expect((await fs.stat(mutex(root))).ino).toBe(before.ino);
  });

  it("supports explicit nested permits but refuses fabricated, expired, concurrent and wrong-project permits", async () => {
    const root = await project(), other = await project();
    let expired!: ProjectAuthorityMutationPermit;
    await withProjectAuthorityMutation(root, async (permit) => {
      expired = permit;
      await expect(withProjectAuthorityMutation(root, async () => "nested", { permit })).resolves.toBe("nested");
      await expect(withProjectAuthorityMutation(other, async () => undefined, { permit })).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
      const entered = deferred(), release = deferred();
      const child = withProjectAuthorityMutation(root, async () => { entered.resolve(); await release.promise; }, { permit });
      await entered.promise;
      await expect(withProjectAuthorityMutation(root, async () => undefined, { permit })).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
      release.resolve(); await child;
    });
    for (const permit of [expired, { projectRoot: root } as ProjectAuthorityMutationPermit]) {
      await expect(withProjectAuthorityMutation(root, async () => undefined, { permit })).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
    }
  });

  it("drains an already-entered child before releasing the outer writer", async () => {
    const root = await project(), childEntered = deferred(), releaseChild = deferred(), parentReturned = deferred();
    let child!: Promise<void>;
    const parent = withProjectAuthorityMutation(root, async (permit) => {
      child = withProjectAuthorityMutation(root, async () => { childEntered.resolve(); await releaseChild.promise; }, { permit });
      await childEntered.promise;
    }).then(() => { parentReturned.resolve(); });
    await childEntered.promise;
    await expect(withProjectAuthorityMutation(root, async () => undefined, { waitMs: 30 })).rejects.toMatchObject({ code: "POLICY_MUTATION_BUSY" });
    releaseChild.resolve(); await child; await parent; await parentReturned.promise;
  });

  it("converges canonical project aliases and releases when callbacks throw", async () => {
    const root = await project(), parent = await project(), alias = path.join(parent, "alias");
    await fs.symlink(root, alias, "dir");
    await expect(withProjectAuthorityMutation(root, async (permit) => {
      await withProjectAuthorityMutation(alias, async () => undefined, { permit });
      await expect(withProjectAuthorityMutation(alias, async () => undefined, { waitMs: 0 })).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_REQUIRED" });
      throw new Error("original failure");
    })).rejects.toThrow("original failure");
    await expect(withProjectAuthorityMutation(alias, async () => "recovered")).resolves.toBe("recovered");
  });

  it("cancels a waiting writer without cancelling the in-progress owner's work", async () => {
    const root = await project(), controller = new AbortController();
    const entered = deferred(), release = deferred();
    const holder = withProjectAuthorityMutation(root, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    try {
      const callback = vi.fn(async () => undefined);
      const result = withProjectAuthorityMutation(root, callback, { signal: controller.signal });
      const assertion = expect(result).rejects.toMatchObject({ code: "POLICY_MUTATION_CANCELLED" });
      await delay(30); controller.abort(); await assertion;
      expect(callback).not.toHaveBeenCalled();
    } finally { release.resolve(); await holder; }
    await expect(withProjectAuthorityMutation(root, async () => "still available")).resolves.toBe("still available");
  });

  it.each(["directory_symlink", "file_symlink", "file_directory", "hardlink", "corrupt"])("refuses %s without running or deleting state", async (mode) => {
    const root = await project(), other = await project();
    await fs.mkdir(path.join(other, "state"));
    if (mode === "directory_symlink") await fs.symlink(path.join(other, "state"), path.join(root, ".synapsor"), "dir");
    else {
      await fs.mkdir(path.join(root, ".synapsor"));
      const source = path.join(other, "original"); await fs.writeFile(source, "not sqlite");
      if (mode === "file_symlink") await fs.symlink(source, mutex(root));
      if (mode === "file_directory") await fs.mkdir(mutex(root));
      if (mode === "hardlink") await fs.link(source, mutex(root));
      if (mode === "corrupt") await fs.writeFile(mutex(root), "not sqlite");
    }
    const callback = vi.fn(async () => undefined);
    await expect(withProjectAuthorityMutation(root, callback)).rejects.toMatchObject({
      code: mode === "corrupt" ? "POLICY_MUTATION_LOCK_UNAVAILABLE" : "POLICY_MUTATION_PATH_INVALID",
    });
    expect(callback).not.toHaveBeenCalled();
    expect((await fs.lstat(path.join(root, ".synapsor"))).isSymbolicLink()).toBe(mode === "directory_symlink");
    if (mode !== "directory_symlink") expect(await fs.lstat(mutex(root))).toBeDefined();
  });
});
