import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownedRoots = [];

afterEach(async () => {
  for (const root of ownedRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-launcher-"));
  ownedRoots.push(root);
  // Deliberately synthetic source entrypoint; the actual source launcher and
  // pinned exported tsx loader are exercised without database/provider access.
  const checkout = path.join(root, "checkout with spaces é");
  const project = path.join(root, "selected project λ");
  await fs.mkdir(path.join(checkout, "bin"), { recursive: true });
  await fs.mkdir(path.join(checkout, "apps/runner/src"), { recursive: true });
  await fs.mkdir(path.join(checkout, "node_modules"), { recursive: true });
  await fs.mkdir(path.join(project, ".synapsor"), { recursive: true });
  await fs.copyFile(path.join(repositoryRoot, "bin/synapsor-runner"), path.join(checkout, "bin/synapsor-runner"));
  await fs.symlink(path.join(repositoryRoot, "node_modules/tsx"), path.join(checkout, "node_modules/tsx"), "dir");
  await fs.writeFile(path.join(checkout, "apps/runner/src/cli.ts"), `
    interface Result { cwd: string; args: string[]; temporaryRoot: string | undefined; }
    const result: Result = { cwd: process.cwd(), args: process.argv.slice(2), temporaryRoot: process.env.TMPDIR };
    if (result.args[0] === '--wait-for-signal') {
      process.on('SIGTERM', () => process.exit(23));
      setInterval(() => {}, 1000);
    }
    process.stdout.write(JSON.stringify(result) + "\\n");
  `);
  await fs.writeFile(path.join(project, ".synapsor/local.db"), "DERIVED logical store sentinel");
  await fs.writeFile(path.join(project, ".synapsor/control.json"), "DERIVED logical control sentinel");
  const guard = path.join(root, "deny-ipc.cjs");
  await fs.writeFile(guard, `
    const net = require('node:net');
    const originalListen = net.Server.prototype.listen;
    net.Server.prototype.listen = function (...args) {
      if (typeof args[0] === 'string') throw new Error('DERIVED unexpected launcher IPC socket');
      return originalListen.apply(this, args);
    };
  `);
  return { root, checkout, project, guard };
}

async function launch(f, temporaryRoot, args = ["synthetic", "argument with spaces", "λ"], terminateOnOutput = false) {
  const child = spawn(path.join(f.checkout, "bin/synapsor-runner"), args, {
    cwd: f.project,
    env: {
      PATH: process.env.PATH,
      HOME: f.root,
      TMPDIR: temporaryRoot,
      NODE_NO_WARNINGS: "1",
      NODE_OPTIONS: `--require=${JSON.stringify(f.guard)}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [], stderr = [];
  child.stdout.on("data", (data) => {
    stdout.push(data);
    if (terminateOnOutput) child.kill("SIGTERM");
  });
  child.stderr.on("data", (data) => stderr.push(data));
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Source launcher did not exit")); }, 10_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
  });
  expect(result).toEqual({ code: terminateOnOutput ? 23 : 0, signal: null });
  expect(Buffer.concat(stderr).toString()).toBe("");
  expect(JSON.parse(Buffer.concat(stdout).toString())).toEqual({ cwd: f.project, args, temporaryRoot });
  expect(await fs.readFile(path.join(f.project, ".synapsor/local.db"), "utf8")).toBe("DERIVED logical store sentinel");
  expect(await fs.readFile(path.join(f.project, ".synapsor/control.json"), "utf8")).toBe("DERIVED logical control sentinel");
}

describe("source launcher temporary files", () => {
  it("loads the source entrypoint from another cwd without a launcher IPC socket", async () => {
    const f = await fixture();
    const temporaryRoot = path.join(f.root, "ordinary-temp");
    await fs.mkdir(temporaryRoot, { mode: 0o700 });
    await launch(f, temporaryRoot);
    expect(await fs.readdir(temporaryRoot)).toEqual([]);
  });

  it("keeps long UTF-8 temporary roots isolated for concurrent launches", async () => {
    const f = await fixture();
    const temporaryRoot = path.join(f.root, "long temp éλ " + "é".repeat(70));
    await fs.mkdir(temporaryRoot, { mode: 0o700 });
    expect(Buffer.byteLength(temporaryRoot)).toBeGreaterThan(107);
    expect(Buffer.byteLength(temporaryRoot)).toBeGreaterThan(temporaryRoot.length);
    await Promise.all([launch(f, temporaryRoot, ["first"]), launch(f, temporaryRoot, ["second"])]);
    expect(await fs.readdir(temporaryRoot)).toEqual([]);
  });

  it("does not need temporary directory write permission for source startup", async () => {
    const f = await fixture();
    const temporaryRoot = path.join(f.root, "unwritable-temp");
    await fs.mkdir(temporaryRoot, { mode: 0o500 });
    try {
      await launch(f, temporaryRoot);
      expect(await fs.readdir(temporaryRoot)).toEqual([]);
    } finally { await fs.chmod(temporaryRoot, 0o700); }
  });

  it("delivers termination to the running source entrypoint and preserves its exit", async () => {
    const f = await fixture();
    const temporaryRoot = path.join(f.root, "signal-temp");
    await fs.mkdir(temporaryRoot, { mode: 0o700 });
    await launch(f, temporaryRoot, ["--wait-for-signal"], true);
    expect(await fs.readdir(temporaryRoot)).toEqual([]);
  });

  it("leaves colliding or symlinked former IPC directories and outside files untouched", async () => {
    const f = await fixture();
    const temporaryRoot = path.join(f.root, "adversarial-temp");
    const outside = path.join(f.root, "outside-IPC-root");
    await fs.mkdir(temporaryRoot, { mode: 0o700 });
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.writeFile(path.join(outside, "sentinel"), "DERIVED outside sentinel");
    const legacySharedCache = path.join(temporaryRoot, "tsx");
    await fs.mkdir(legacySharedCache, { mode: 0o700 });
    await fs.writeFile(path.join(legacySharedCache, "sentinel"), "DERIVED unowned legacy cache sentinel");
    const formerEndpointDirectory = path.join(temporaryRoot, `tsx-${process.geteuid?.() ?? os.userInfo().username}`);
    await fs.symlink(outside, formerEndpointDirectory, "dir");
    await launch(f, temporaryRoot);
    expect((await fs.lstat(formerEndpointDirectory)).isSymbolicLink()).toBe(true);
    expect(await fs.readdir(outside)).toEqual(["sentinel"]);
    expect(await fs.readFile(path.join(outside, "sentinel"), "utf8")).toBe("DERIVED outside sentinel");
    expect(await fs.readFile(path.join(legacySharedCache, "sentinel"), "utf8")).toBe("DERIVED unowned legacy cache sentinel");
    const collidingTemporaryRoot = path.join(f.root, "colliding-temp");
    await fs.mkdir(collidingTemporaryRoot, { mode: 0o700 });
    const collidingCachePath = path.join(collidingTemporaryRoot, path.basename(formerEndpointDirectory));
    await fs.writeFile(collidingCachePath, "DERIVED cache collision sentinel");
    await launch(f, collidingTemporaryRoot);
    expect(await fs.readdir(collidingTemporaryRoot)).toEqual([path.basename(collidingCachePath)]);
    expect(await fs.readFile(collidingCachePath, "utf8")).toBe("DERIVED cache collision sentinel");
  });
});
