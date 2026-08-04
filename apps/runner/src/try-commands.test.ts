import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tryCommand } from "./try-commands.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })));
});

describe("Try command recovery", () => {
  it("reports one path-free recovery action when Explore has no active boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-try-no-boundary-"));
    roots.push(root);

    const error = await tryCommand([
      "explore",
      "--project-root", root,
    ]).catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      code: "EXPLORE_DISABLED",
      message: "No reviewed analytics access is active. Run `synapsor-runner start` and complete the local data-access review.",
    });
    expect(String(error)).not.toContain(root);
    expect(String(error)).not.toContain("ENOENT");
  });

  it("reports the same path-free recovery for explicit and latest Protect selection", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-protect-no-boundary-"));
    roots.push(root);

    for (const selection of [["--last"], ["--from", "A1"]]) {
      const error = await tryCommand([
        "protect",
        "--project-root", root,
        ...selection,
        "--name", "analytics.test_analysis",
      ]).catch((failure: unknown) => failure);

      expect(error).toMatchObject({
        code: "EXPLORE_DISABLED",
        message: "No reviewed analytics access is active. Run `synapsor-runner start` and complete the local data-access review.",
      });
      expect(String(error)).not.toContain(root);
      expect(String(error)).not.toContain("ENOENT");
      expect(String(error)).not.toContain("exploration-boundary.active.json");
    }
  });
});
