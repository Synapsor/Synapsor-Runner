import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTryExperience } from "./try-experience.js";
import {
  classifyUnsafeTryStateContainer,
  prepareTryState,
  resolveTryStateLocation,
  TryStateError,
} from "./try-state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

describe("Synapsor try managed state", () => {
  it("uses a managed child and preserves unrelated caller files across repeated runs", async () => {
    const container = await temporaryDirectory("synapsor-try-container-");
    const sentinel = path.join(container, "do-not-delete.txt");
    await fs.writeFile(sentinel, "owned by the caller\n", "utf8");

    const first = await runTryExperience({ root_dir: container, review: async () => "reject" });
    expect(first.paths.root).toBe(path.join(container, ".synapsor-try"));
    expect(await fs.readFile(sentinel, "utf8")).toBe("owned by the caller\n");

    const unrelatedManagedFile = path.join(first.paths.root, "operator-notes.txt");
    await fs.writeFile(unrelatedManagedFile, "preserve this too\n", "utf8");
    const second = await runTryExperience({ root_dir: container, review: async () => "reject" });
    expect(second.paths.root).toBe(first.paths.root);
    expect(await fs.readFile(sentinel, "utf8")).toBe("owned by the caller\n");
    expect(await fs.readFile(unrelatedManagedFile, "utf8")).toBe("preserve this too\n");
  }, 20_000);

  it("fails closed on protected native paths and parent traversal", async () => {
    const repositoryRoot = process.cwd();
    const candidates = [
      "",
      ".",
      "..",
      path.parse(repositoryRoot).root,
      os.homedir(),
      repositoryRoot,
      path.dirname(repositoryRoot),
      `safe${path.sep}..${path.sep}state`,
    ];
    for (const candidate of candidates) {
      await expect(prepareTryState(candidate)).rejects.toMatchObject({
        code: "UNSAFE_TRY_STATE_PATH",
      } satisfies Partial<TryStateError>);
    }
  });

  it("classifies POSIX and Windows protected paths without host-dependent string prefixes", () => {
    const posix = { cwd: "/srv/app", home: "/home/alice", repository_root: "/srv/app" };
    expect(classifyUnsafeTryStateContainer("/", posix, "posix")).toMatch(/filesystem root/);
    expect(classifyUnsafeTryStateContainer("/home/alice", posix, "posix")).toMatch(/home/);
    expect(classifyUnsafeTryStateContainer("/srv", posix, "posix")).toMatch(/ancestor/);
    expect(classifyUnsafeTryStateContainer("/tmp/synapsor state", posix, "posix")).toBeUndefined();

    const windows = {
      cwd: "C:\\work\\app",
      home: "C:\\Users\\alice",
      repository_root: "C:\\work\\app",
    };
    expect(classifyUnsafeTryStateContainer("C:\\", windows, "win32")).toMatch(/filesystem root/);
    expect(classifyUnsafeTryStateContainer("c:\\users\\ALICE", windows, "win32")).toMatch(/home/);
    expect(classifyUnsafeTryStateContainer("C:\\work", windows, "win32")).toMatch(/ancestor/);
    expect(classifyUnsafeTryStateContainer("\\\\server\\share\\", windows, "win32")).toMatch(/filesystem root/);
    expect(classifyUnsafeTryStateContainer("D:\\temp\\synapsor state", windows, "win32")).toBeUndefined();
  });

  it("rejects an unrelated Git repository root discovered at the candidate path", async () => {
    const repository = await temporaryDirectory("synapsor-try-external-repository-");
    await fs.mkdir(path.join(repository, ".git"));

    await expect(prepareTryState(repository)).rejects.toMatchObject({
      code: "UNSAFE_TRY_STATE_PATH",
    } satisfies Partial<TryStateError>);
    await expect(fs.access(path.join(repository, ".synapsor-try"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlink supplied as the state container", async () => {
    const parent = await temporaryDirectory("synapsor-try-symlink-parent-");
    const target = await temporaryDirectory("synapsor-try-symlink-target-");
    const sentinel = path.join(target, "sentinel.txt");
    await fs.writeFile(sentinel, "untouched\n", "utf8");
    const link = path.join(parent, "linked-state");
    await fs.symlink(target, link, "dir");

    await expect(prepareTryState(link)).rejects.toMatchObject({
      code: "UNSAFE_TRY_STATE_PATH",
    } satisfies Partial<TryStateError>);
    expect(await fs.readFile(sentinel, "utf8")).toBe("untouched\n");
  });

  it("rejects a managed child that is a symlink", async () => {
    const container = await temporaryDirectory("synapsor-try-child-link-");
    const target = await temporaryDirectory("synapsor-try-child-target-");
    const sentinel = path.join(target, "sentinel.txt");
    await fs.writeFile(sentinel, "untouched\n", "utf8");
    await fs.symlink(target, resolveTryStateLocation(container).root, "dir");

    await expect(prepareTryState(container)).rejects.toMatchObject({
      code: "UNSAFE_TRY_STATE_PATH",
    } satisfies Partial<TryStateError>);
    expect(await fs.readFile(sentinel, "utf8")).toBe("untouched\n");
  });

  it("rejects nested symlink traversal in a custom state path", async () => {
    const parent = await temporaryDirectory("synapsor-try-nested-link-");
    const target = await temporaryDirectory("synapsor-try-nested-target-");
    const sentinel = path.join(target, "sentinel.txt");
    await fs.writeFile(sentinel, "untouched\n", "utf8");
    const link = path.join(parent, "linked-parent");
    await fs.symlink(target, link, "dir");

    await expect(prepareTryState(path.join(link, "state"))).rejects.toMatchObject({
      code: "UNSAFE_TRY_STATE_PATH",
    } satisfies Partial<TryStateError>);
    expect(await fs.readFile(sentinel, "utf8")).toBe("untouched\n");
  });

  it("rejects a managed data file replaced by a symlink", async () => {
    const container = await temporaryDirectory("synapsor-try-file-link-");
    const first = await runTryExperience({ root_dir: container, review: async () => "reject" });
    const target = path.join(container, "external-source.json");
    await fs.writeFile(target, "external\n", "utf8");
    await fs.rm(first.paths.source, { force: true });
    await fs.symlink(target, first.paths.source, "file");

    await expect(runTryExperience({ root_dir: container, review: async () => "reject" })).rejects.toMatchObject({
      code: "UNSAFE_TRY_STATE_PATH",
    } satisfies Partial<TryStateError>);
    expect(await fs.readFile(target, "utf8")).toBe("external\n");
  }, 10_000);

  it("preserves and rejects an unmarked lookalike managed directory", async () => {
    const container = await temporaryDirectory("synapsor-try-unowned-");
    const root = resolveTryStateLocation(container).root;
    await fs.mkdir(root);
    const sentinel = path.join(root, "source.json");
    await fs.writeFile(sentinel, "caller data\n", "utf8");

    await expect(prepareTryState(container)).rejects.toMatchObject({
      code: "TRY_STATE_UNOWNED",
    } satisfies Partial<TryStateError>);
    expect(await fs.readFile(sentinel, "utf8")).toBe("caller data\n");
  });

  it("recovers a valid dead-process lease left by an interrupted run", async () => {
    const container = await temporaryDirectory("synapsor-try-stale-lock-");
    const initialized = await prepareTryState(container);
    const root = initialized.root;
    await initialized.release();
    await fs.writeFile(path.join(root, ".synapsor-try.lock"), `${JSON.stringify({
      schema_version: "synapsor.try-lock.v1",
      pid: 2_147_483_647,
      token: "a".repeat(32),
      created_at: "2026-07-20T00:00:00.000Z",
    })}\n`, { encoding: "utf8", mode: 0o600 });

    const recovered = await runTryExperience({ root_dir: container, review: async () => "reject" });
    expect(recovered.ok).toBe(true);
    await expect(fs.access(path.join(root, ".synapsor-try.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);

  it("recovers an empty managed child left before marker creation", async () => {
    const container = await temporaryDirectory("synapsor-try-interrupted-init-");
    const root = resolveTryStateLocation(container).root;
    await fs.mkdir(root);

    const state = await prepareTryState(container);
    try {
      expect(state.root).toBe(root);
      await expect(fs.access(path.join(root, ".synapsor-try-state.json"))).resolves.toBeUndefined();
    } finally {
      await state.release();
    }
  });

  it("rejects a parallel run while preserving the active run", async () => {
    const container = await temporaryDirectory("synapsor-try-parallel-");
    let releaseReview!: () => void;
    let reviewStarted!: () => void;
    const started = new Promise<void>((resolve) => { reviewStarted = resolve; });
    const hold = new Promise<void>((resolve) => { releaseReview = resolve; });
    const first = runTryExperience({
      root_dir: container,
      review: async () => {
        reviewStarted();
        await hold;
        return "reject";
      },
    });
    await started;

    await expect(runTryExperience({ root_dir: container, review: async () => "reject" })).rejects.toMatchObject({
      code: "TRY_STATE_BUSY",
    } satisfies Partial<TryStateError>);
    releaseReview();
    await expect(first).resolves.toMatchObject({ ok: true, proposal: { state: "rejected" } });
  }, 10_000);

  it("supports safe nested paths with spaces and Unicode", async () => {
    const parent = await temporaryDirectory("synapsor-try-portable-");
    const container = path.join(parent, "state with spaces", "reviewed-δ");
    const state = await prepareTryState(container);
    try {
      expect(state.root).toBe(path.join(container, ".synapsor-try"));
      await expect(fs.access(path.join(state.root, ".synapsor-try-state.json"))).resolves.toBeUndefined();
    } finally {
      await state.release();
    }
  });

  it("adopts only the known legacy default layout", async () => {
    const cwd = await temporaryDirectory("synapsor-try-legacy-");
    const oldCwd = process.cwd();
    process.chdir(cwd);
    try {
      const root = path.join(cwd, ".synapsor", "try");
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, "source.json"), "legacy\n", "utf8");
      const state = await prepareTryState();
      try {
        expect(state.root).toBe(root);
        await expect(fs.access(path.join(root, ".synapsor-try-state.json"))).resolves.toBeUndefined();
        await expect(fs.access(path.join(root, "source.json"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await state.release();
      }
    } finally {
      process.chdir(oldCwd);
    }
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
