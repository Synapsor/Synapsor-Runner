import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withDisposableActionPreviewLedger } from "./action-preview-ledger.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("disabled Safe Action rehearsal ledger", () => {
  it("never uses or changes the durable ledger and removes SQLite sidecars", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-action-preview-ledger-"));
    roots.push(root);
    const durableStore = path.join(root, ".synapsor", "local.db");
    await fs.mkdir(path.dirname(durableStore), { recursive: true });
    await fs.writeFile(durableStore, "durable-ledger-sentinel");
    let previewStore = "";

    const result = await withDisposableActionPreviewLedger({
      projectRoot: root,
      run: async (storePath) => {
        previewStore = storePath;
        expect(storePath).not.toBe(durableStore);
        expect(storePath).toContain(`${path.sep}action-preview-ledgers${path.sep}`);
        await Promise.all([
          fs.writeFile(storePath, "preview"),
          fs.writeFile(`${storePath}-wal`, "wal"),
          fs.writeFile(`${storePath}-shm`, "shm"),
        ]);
        return "rehearsed";
      },
    });

    expect(result).toBe("rehearsed");
    expect(await fs.readFile(durableStore, "utf8")).toBe("durable-ledger-sentinel");
    await expect(fs.access(previewStore)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(`${previewStore}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(`${previewStore}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes rehearsal files when the preview fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-action-preview-ledger-"));
    roots.push(root);
    let previewStore = "";
    await expect(withDisposableActionPreviewLedger({
      projectRoot: root,
      run: async (storePath) => {
        previewStore = storePath;
        await fs.writeFile(storePath, "preview");
        throw new Error("preview refused");
      },
    })).rejects.toThrow(/preview refused/);
    await expect(fs.access(previewStore)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
