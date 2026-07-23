import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cursorProjectStatus, installCursorProject, previewCursorProjectInstall, uninstallCursorProject } from "./cursor-project.js";
import runnerPackage from "../package.json" with { type: "json" };

describe("Cursor project MCP lifecycle", () => {
  it("previews, merges, backs up, installs idempotently, and uninstalls only its entry", async () => {
    const root = await projectFixture();
    await fs.mkdir(path.join(root, ".cursor"), { recursive: true });
    await fs.writeFile(path.join(root, ".cursor/mcp.json"), JSON.stringify({
      mcpServers: { existing: { command: "node", args: ["existing.mjs"] } },
      projectSetting: true,
    }), "utf8");

    const preview = await previewCursorProjectInstall({ projectRoot: root });
    expect(preview.action).toBe("install");
    expect(preview.merged).toMatchObject({
      projectSetting: true,
      mcpServers: {
        existing: { command: "node" },
        synapsor: {
          type: "stdio",
          command: "npx",
          args: ["-y", "-p", `@synapsor/runner@${runnerPackage.version}`, "synapsor-runner", "mcp", "serve", "--config", "./synapsor.runner.json", "--store", "./.synapsor/local.db"],
        },
      },
    });
    expect(await fs.readFile(path.join(root, ".cursor/mcp.json"), "utf8")).not.toContain("synapsor-runner");

    const installed = await installCursorProject({ projectRoot: root, now: "2026-07-20T00:00:00.000Z" });
    expect(installed.backup).toBeDefined();
    expect((await cursorProjectStatus(root)).state).toBe("installed");
    const first = await fs.readFile(path.join(root, ".cursor/mcp.json"), "utf8");
    const repeat = await installCursorProject({ projectRoot: root, now: "2026-07-20T00:01:00.000Z" });
    expect(repeat.action).toBe("unchanged");
    expect(repeat.backup).toBeUndefined();
    expect(await fs.readFile(path.join(root, ".cursor/mcp.json"), "utf8")).toBe(first);

    const removed = await uninstallCursorProject({ projectRoot: root, now: "2026-07-20T00:02:00.000Z" });
    expect(removed.changed).toBe(true);
    const final = JSON.parse(await fs.readFile(path.join(root, ".cursor/mcp.json"), "utf8"));
    expect(final.mcpServers.existing.command).toBe("node");
    expect(final.mcpServers.synapsor).toBeUndefined();
    expect(final.projectSetting).toBe(true);
    expect((await cursorProjectStatus(root)).state).toBe("not_installed");

    await fs.rm(path.join(root, "synapsor.runner.json"));
    expect((await cursorProjectStatus(root)).state).toBe("not_installed");
  });

  it("refuses unowned, edited, external, and symlinked project files", async () => {
    const unowned = await projectFixture();
    await fs.mkdir(path.join(unowned, ".cursor"), { recursive: true });
    await fs.writeFile(path.join(unowned, ".cursor/mcp.json"), JSON.stringify({
      mcpServers: { synapsor: { command: "another-runner", args: [] } },
    }), "utf8");
    await expect(previewCursorProjectInstall({ projectRoot: unowned })).rejects.toThrow(/unowned/);

    const edited = await projectFixture();
    await installCursorProject({ projectRoot: edited });
    const cursorPath = path.join(edited, ".cursor/mcp.json");
    const value = JSON.parse(await fs.readFile(cursorPath, "utf8"));
    value.mcpServers.synapsor.args.push("--unexpected");
    await fs.writeFile(cursorPath, JSON.stringify(value), "utf8");
    expect((await cursorProjectStatus(edited)).state).toBe("tampered");
    await expect(uninstallCursorProject({ projectRoot: edited })).rejects.toThrow(/changed after installation/);

    const external = await projectFixture();
    await expect(previewCursorProjectInstall({ projectRoot: external, configPath: "../outside.json" })).rejects.toThrow(/inside the project/);

    const linked = await projectFixture();
    const target = path.join(linked, "cursor-target.json");
    await fs.writeFile(target, "{}", "utf8");
    await fs.mkdir(path.join(linked, ".cursor"), { recursive: true });
    await fs.symlink(target, path.join(linked, ".cursor/mcp.json"));
    await expect(previewCursorProjectInstall({ projectRoot: linked })).rejects.toThrow(/symbolic link/);

    const linkedDirectory = await projectFixture();
    const cursorTarget = path.join(linkedDirectory, "cursor-target");
    await fs.mkdir(cursorTarget);
    await fs.symlink(cursorTarget, path.join(linkedDirectory, ".cursor"));
    await expect(previewCursorProjectInstall({ projectRoot: linkedDirectory })).rejects.toThrow(/symbolic link/);

    const custom = await projectFixture("custom.runner.json");
    await installCursorProject({ projectRoot: custom, configPath: "./custom.runner.json" });
    await fs.rm(path.join(custom, "custom.runner.json"));
    expect((await cursorProjectStatus(custom)).paths.configArgument).toBe("./custom.runner.json");
    await expect(uninstallCursorProject({ projectRoot: custom })).resolves.toMatchObject({ changed: true });
  });

  it("keeps workspace paths with spaces as single Cursor arguments and accepts an intentional package pin", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor cursor spaces "));
    const root = path.join(parent, "application with spaces");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "synapsor.runner.json"), "{}\n", "utf8");

    const installed = await installCursorProject({
      projectRoot: root,
      packageSpec: "@synapsor/runner@1.6.0",
      now: "2026-07-20T00:00:00.000Z",
    });
    expect(installed.entry).toEqual({
      type: "stdio",
      command: "npx",
      args: [
        "-y", "-p", "@synapsor/runner@1.6.0", "synapsor-runner", "mcp", "serve",
        "--config", "./synapsor.runner.json", "--store", "./.synapsor/local.db",
      ],
    });
    expect((await cursorProjectStatus(root)).state).toBe("installed");
    await expect(uninstallCursorProject({ projectRoot: root })).resolves.toMatchObject({ changed: true });
  });

  it("installs authoring-only Cursor wiring without requiring a runtime config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cursor-authoring-"));
    const preview = await previewCursorProjectInstall({ projectRoot: root, authoring: true });
    expect(preview.entry).toEqual({
      type: "stdio",
      command: "npx",
      args: [
        "-y",
        "-p",
        `@synapsor/runner@${runnerPackage.version}`,
        "synapsor-runner",
        "mcp",
        "serve",
        "--authoring",
        "--project-root",
        ".",
      ],
    });
    await installCursorProject({ projectRoot: root, authoring: true });
    const status = await cursorProjectStatus(root);
    expect(status.state).toBe("installed");
    expect(status.entry?.args).toContain("--authoring");
    await expect(uninstallCursorProject({ projectRoot: root })).resolves.toMatchObject({ changed: true });
  });
});

async function projectFixture(configName = "synapsor.runner.json"): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cursor-project-"));
  await fs.writeFile(path.join(root, configName), "{}\n", "utf8");
  return root;
}
