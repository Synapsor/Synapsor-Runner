import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { copyReleaseAsset } from "./copy-release-asset.mjs";

describe("release assets exclude local Runner state before copying", () => {
  it("omits root and nested runtime stores while retaining example assets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-release-copy-"));
    const source = path.join(root, "source"), destination = path.join(root, "package");
    try {
      for (const directory of [".synapsor", "nested/.synapsor", "nested/.synapsor.example"]) {
        await fs.mkdir(path.join(source, directory), { recursive: true });
        await fs.writeFile(path.join(source, directory, "state.json"), "fixture data");
      }
      await fs.writeFile(path.join(source, "README.md"), "Example instructions");
      await copyReleaseAsset(source, destination);
      expect(await fs.readdir(destination)).toEqual(["README.md", "nested"]);
      expect(await fs.readdir(path.join(destination, "nested"))).toEqual([".synapsor.example"]);
      expect(await fs.readFile(path.join(destination, "README.md"), "utf8")).toBe("Example instructions");
      expect(await fs.readFile(path.join(source, ".synapsor/state.json"), "utf8")).toBe("fixture data");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("does not enter an unreadable generated store or modify its permissions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-release-unreadable-"));
    const source = path.join(root, "source"), destination = path.join(root, "package");
    const store = path.join(source, ".synapsor");
    try {
      await fs.mkdir(store, { recursive: true });
      await fs.writeFile(path.join(store, "runtime-admission.sqlite"), "private runtime fixture");
      await fs.chmod(store, 0o000);
      await expect(copyReleaseAsset(source, destination)).resolves.toBeUndefined();
      expect(await fs.readdir(destination)).toEqual([]);
      if (process.platform !== "win32") expect((await fs.stat(store)).mode & 0o777).toBe(0);
    } finally {
      await fs.chmod(store, 0o700).catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves direct-file release copying", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-release-file-"));
    try {
      const source = path.join(root, "schema.json"), destination = path.join(root, "copied.json");
      await fs.writeFile(source, '{"type":"object"}');
      await copyReleaseAsset(source, destination);
      expect(await fs.readFile(destination, "utf8")).toBe('{"type":"object"}');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
