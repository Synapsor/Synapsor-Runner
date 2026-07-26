import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSynapsorProject } from "./project-resolution.js";

describe("Synapsor project resolution", () => {
  it("discovers the nearest guided project and resolves only discovered storage against it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-project-resolution-"));
    try {
      const nested = path.join(root, "apps/web/src");
      await fs.mkdir(path.join(root, ".git"));
      await fs.mkdir(path.join(root, ".synapsor"), { recursive: true });
      await fs.mkdir(nested, { recursive: true });
      await fs.writeFile(path.join(root, "synapsor.runner.json"), JSON.stringify({
        version: 1,
        mode: "read_only",
        storage: { sqlite_path: "./state/local.db" },
      }));

      await expect(resolveSynapsorProject(nested, {})).resolves.toEqual({
        source: "discovered",
        project_root: root,
        config_path: path.join(root, "synapsor.runner.json"),
        store_path: path.join(root, "state/local.db"),
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses documented environment paths without reinterpreting relative values", async () => {
    await expect(resolveSynapsorProject("/tmp", {
      SYNAPSOR_RUNNER_CONFIG: "./custom/runner.json",
      SYNAPSOR_LOCAL_STORE: "./custom/local.db",
    })).resolves.toEqual({
      source: "environment",
      config_path: "./custom/runner.json",
      store_path: "./custom/local.db",
    });
  });

  it("discovers the conventional synapsor/synapsor.runner.json from a nested working directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-project-nested-config-"));
    try {
      const nested = path.join(root, "apps/web/src");
      await fs.mkdir(path.join(root, ".git"));
      await fs.mkdir(path.join(root, "synapsor"), { recursive: true });
      await fs.mkdir(nested, { recursive: true });
      await fs.writeFile(path.join(root, "synapsor/synapsor.runner.json"), JSON.stringify({
        version: 1,
        mode: "read_only",
        storage: { sqlite_path: "./state/local.db" },
      }));

      await expect(resolveSynapsorProject(nested, {})).resolves.toEqual({
        source: "discovered",
        project_root: root,
        config_path: path.join(root, "synapsor/synapsor.runner.json"),
        store_path: path.join(root, "synapsor/state/local.db"),
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when root and nested conventional configs are both present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-project-config-collision-"));
    try {
      await fs.mkdir(path.join(root, ".git"));
      await fs.mkdir(path.join(root, "synapsor"));
      await fs.writeFile(path.join(root, "synapsor.runner.json"), "{}\n");
      await fs.writeFile(path.join(root, "synapsor/synapsor.runner.json"), "{}\n");

      await expect(resolveSynapsorProject(root, {})).rejects.toThrow(
        /Multiple Synapsor projects are valid[\s\S]*Pass --config <path>/i,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not walk above a repository boundary", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-project-boundary-"));
    try {
      const repository = path.join(parent, "repo");
      const nested = path.join(repository, "src/deep");
      await fs.mkdir(path.join(repository, ".git"), { recursive: true });
      await fs.mkdir(nested, { recursive: true });
      await fs.writeFile(path.join(parent, "synapsor.runner.json"), "{}\n");
      await expect(resolveSynapsorProject(nested, {})).resolves.toBeUndefined();
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("refuses conflicting config environment variables", async () => {
    await expect(resolveSynapsorProject("/tmp", {
      SYNAPSOR_RUNNER_CONFIG: "./one.json",
      SYNAPSOR_MCP_CONFIG: "./two.json",
    })).rejects.toThrow(/point to different Runner configs/i);
  });

  it("rejects a guided marker whose config escapes the project root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-project-escape-"));
    try {
      await fs.mkdir(path.join(root, ".git"));
      await fs.mkdir(path.join(root, ".synapsor"));
      await fs.writeFile(path.join(root, ".synapsor/guided-onboarding.json"), JSON.stringify({
        artifacts: { runner_config: "../outside.json" },
      }));
      await expect(resolveSynapsorProject(root, {})).rejects.toThrow(/escapes its project root/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
