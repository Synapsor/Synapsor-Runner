import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { describe, expect, it, vi } from "vitest";
import runnerPackage from "../package.json" with { type: "json" };
import { mcp } from "./mcp-project.js";
import {
  detectManagedMcpClientCommand,
  installManagedMcpProject,
  installManagedMcpProjectSet,
  managedMcpProjectStatus,
  parseManagedMcpProjectClient,
  previewManagedMcpProjectInstall,
  uninstallManagedMcpProject,
  type ManagedMcpProjectClient,
} from "./managed-mcp-project.js";

const clients: Array<{
  client: ManagedMcpProjectClient;
  destination: string;
  marker: string;
  serversKey: "mcpServers" | "servers";
  markerVersion: string;
}> = [{
  client: "cursor",
  destination: ".cursor/mcp.json",
  marker: ".synapsor/cursor-project.json",
  serversKey: "mcpServers",
  markerVersion: "synapsor.cursor-project.v1",
}, {
  client: "claude-code",
  destination: ".mcp.json",
  marker: ".synapsor/claude-code-project.json",
  serversKey: "mcpServers",
  markerVersion: "synapsor.claude-code-project.v1",
}, {
  client: "vscode",
  destination: ".vscode/mcp.json",
  marker: ".synapsor/vscode-project.json",
  serversKey: "servers",
  markerVersion: "synapsor.vscode-project.v1",
}];

describe.each(clients)("managed $client MCP project lifecycle", ({
  client,
  destination,
  marker,
  serversKey,
  markerVersion,
}) => {
  it("previews, preserves existing settings, backs up, installs idempotently, and removes only its entry", async () => {
    const root = await projectFixture();
    const destinationPath = path.join(root, destination);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, JSON.stringify({
      [serversKey]: { existing: { command: "node", args: ["existing.mjs"] } },
      projectSetting: true,
    }, null, 2), "utf8");

    const preview = await previewManagedMcpProjectInstall({ client, projectRoot: root });
    expect(preview.action).toBe("install");
    expect(preview.merged).toMatchObject({
      projectSetting: true,
      [serversKey]: {
        existing: { command: "node" },
        synapsor: {
          type: "stdio",
          command: "npx",
          args: [
            "-y", `@synapsor/runner@${runnerPackage.version}`,
            "mcp", "serve", "--config", "./synapsor.runner.json", "--store", "./.synapsor/local.db",
          ],
        },
      },
    });
    expect(await fs.readFile(destinationPath, "utf8")).not.toContain("@synapsor/runner");

    const installed = await installManagedMcpProject({
      client,
      projectRoot: root,
      now: "2026-07-26T00:00:00.000Z",
    });
    expect(installed.backup).toBeDefined();
    expect((await managedMcpProjectStatus(client, root)).state).toBe("installed");
    const markerValue = JSON.parse(await fs.readFile(path.join(root, marker), "utf8"));
    expect(markerValue).toMatchObject({
      schema_version: markerVersion,
      server_name: "synapsor",
      destination,
    });
    const first = await fs.readFile(destinationPath, "utf8");
    const repeated = await installManagedMcpProject({
      client,
      projectRoot: root,
      now: "2026-07-26T00:01:00.000Z",
    });
    expect(repeated.action).toBe("unchanged");
    expect(repeated.backup).toBeUndefined();
    expect(await fs.readFile(destinationPath, "utf8")).toBe(first);

    const removed = await uninstallManagedMcpProject({
      client,
      projectRoot: root,
      now: "2026-07-26T00:02:00.000Z",
    });
    expect(removed.changed).toBe(true);
    expect(removed.backup).toBeDefined();
    const final = parse(await fs.readFile(destinationPath, "utf8"));
    expect(final[serversKey].existing.command).toBe("node");
    expect(final[serversKey].synapsor).toBeUndefined();
    expect(final.projectSetting).toBe(true);
    expect((await managedMcpProjectStatus(client, root)).state).toBe("not_installed");
  });

  it("refuses unowned, edited, external, secret-bearing, and symlinked entries", async () => {
    const unowned = await projectFixture();
    const unownedPath = path.join(unowned, destination);
    await fs.mkdir(path.dirname(unownedPath), { recursive: true });
    await fs.writeFile(unownedPath, JSON.stringify({
      [serversKey]: { synapsor: { command: "another-runner", args: [] } },
    }), "utf8");
    await expect(previewManagedMcpProjectInstall({ client, projectRoot: unowned })).rejects.toThrow(/unowned/);

    const edited = await projectFixture();
    await installManagedMcpProject({ client, projectRoot: edited });
    const editedPath = path.join(edited, destination);
    const editedValue = parse(await fs.readFile(editedPath, "utf8"));
    editedValue[serversKey].synapsor.args.push("--unexpected");
    await fs.writeFile(editedPath, JSON.stringify(editedValue), "utf8");
    expect((await managedMcpProjectStatus(client, edited)).state).toBe("tampered");
    await expect(uninstallManagedMcpProject({ client, projectRoot: edited })).rejects.toThrow(/changed after installation/);

    const external = await projectFixture();
    await expect(previewManagedMcpProjectInstall({
      client,
      projectRoot: external,
      configPath: "../outside.json",
    })).rejects.toThrow(/inside the project/);
    await expect(previewManagedMcpProjectInstall({
      client,
      projectRoot: external,
      packageSpec: "postgresql://reader:secret@example.test/db",
    })).rejects.toThrow(/never credentials/);

    const linked = await projectFixture();
    const linkedPath = path.join(linked, destination);
    const target = path.join(linked, "outside-client-config.json");
    await fs.writeFile(target, "{}", "utf8");
    await fs.mkdir(path.dirname(linkedPath), { recursive: true });
    await fs.symlink(target, linkedPath);
    await expect(previewManagedMcpProjectInstall({ client, projectRoot: linked })).rejects.toThrow(/symbolic link/);
  });
});

describe("managed MCP project client names", () => {
  it("distinguishes a detected client command from configuration-only setup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-managed-mcp-path-"));
    await fs.writeFile(path.join(root, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    expect(await detectManagedMcpClientCommand("claude-code", { PATH: root }, "linux")).toBe("claude");
    expect(await detectManagedMcpClientCommand("vscode", { PATH: root }, "linux")).toBeUndefined();
  });

  it("accepts documented names and unambiguous convenience aliases", () => {
    expect(parseManagedMcpProjectClient("cursor")).toBe("cursor");
    expect(parseManagedMcpProjectClient("claude-code")).toBe("claude-code");
    expect(parseManagedMcpProjectClient("claude")).toBe("claude-code");
    expect(parseManagedMcpProjectClient("vscode")).toBe("vscode");
    expect(parseManagedMcpProjectClient("vs-code")).toBe("vscode");
    expect(() => parseManagedMcpProjectClient("claude-desktop")).toThrow(/cursor, claude-code, or vscode/);
  });

  it("keeps all three managed entries independent in one project", async () => {
    const root = await projectFixture();
    for (const { client } of clients) {
      await installManagedMcpProject({ client, projectRoot: root });
    }
    for (const { client } of clients) {
      expect((await managedMcpProjectStatus(client, root)).state).toBe("installed");
    }
    await uninstallManagedMcpProject({ client: "claude-code", projectRoot: root });
    expect((await managedMcpProjectStatus("cursor", root)).state).toBe("installed");
    expect((await managedMcpProjectStatus("claude-code", root)).state).toBe("not_installed");
    expect((await managedMcpProjectStatus("vscode", root)).state).toBe("installed");
  });

  it("keeps Claude Code Explore and Action runtimes independently owned in one project", async () => {
    const root = await projectFixture();
    await fs.writeFile(path.join(root, "synapsor.actions.runner.json"), "{}\n", "utf8");
    const destination = path.join(root, ".mcp.json");
    await fs.writeFile(destination, JSON.stringify({
      mcpServers: {
        existing: { command: "node", args: ["existing.mjs"] },
      },
      projectSetting: true,
    }, null, 2), "utf8");

    const installedSet = await installManagedMcpProjectSet({
      client: "claude-code",
      projectRoot: root,
      now: "2026-07-26T00:00:00.000Z",
      entries: [{
        authoring: true,
        entryKind: "explore",
      }, {
        configPath: "./synapsor.actions.runner.json",
        entryKind: "actions",
      }],
    });
    expect(installedSet.backup).toBeDefined();
    expect((await fs.readdir(root)).filter((name) => name.includes(".mcp.json.bak."))).toHaveLength(1);

    const installed = parse(await fs.readFile(destination, "utf8"));
    expect(installed.mcpServers.existing.command).toBe("node");
    expect(installed.mcpServers.synapsor.args).toContain("--authoring");
    expect(installed.mcpServers["synapsor-actions"].args).toContain("./synapsor.actions.runner.json");
    expect(installed.projectSetting).toBe(true);
    expect((await managedMcpProjectStatus("claude-code", root, "explore")).state).toBe("installed");
    expect((await managedMcpProjectStatus("claude-code", root, "actions")).state).toBe("installed");
    expect(JSON.parse(await fs.readFile(
      path.join(root, ".synapsor/claude-code-project-actions.json"),
      "utf8",
    ))).toMatchObject({ server_name: "synapsor-actions" });

    await uninstallManagedMcpProject({
      client: "claude-code",
      projectRoot: root,
      entryKind: "actions",
    });
    const withoutActions = parse(await fs.readFile(destination, "utf8"));
    expect(withoutActions.mcpServers.synapsor.command).toBe("npx");
    expect(withoutActions.mcpServers["synapsor-actions"]).toBeUndefined();
    expect(withoutActions.mcpServers.existing.command).toBe("node");
    expect((await managedMcpProjectStatus("claude-code", root, "explore")).state).toBe("installed");
    expect((await managedMcpProjectStatus("claude-code", root, "actions")).state).toBe("not_installed");
  });

  it("preserves VS Code JSONC comments and trailing-comma settings", async () => {
    const root = await projectFixture();
    const destination = path.join(root, ".vscode/mcp.json");
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, `{
  // Keep this project-owned explanation.
  "inputs": [
    {
      "id": "existing-input",
      "type": "promptString",
    },
  ],
  "servers": {
    // Keep this unrelated server.
    "existing": {
      "type": "stdio",
      "command": "node",
      "args": ["existing.mjs"],
    },
  },
}
`, "utf8");

    await installManagedMcpProject({ client: "vscode", projectRoot: root });
    const installed = await fs.readFile(destination, "utf8");
    expect(installed).toContain("// Keep this project-owned explanation.");
    expect(installed).toContain("// Keep this unrelated server.");
    expect(parse(installed).servers.synapsor.command).toBe("npx");

    await uninstallManagedMcpProject({ client: "vscode", projectRoot: root });
    const removed = await fs.readFile(destination, "utf8");
    expect(removed).toContain("// Keep this project-owned explanation.");
    expect(removed).toContain("// Keep this unrelated server.");
    expect(parse(removed).servers.existing.command).toBe("node");
    expect(parse(removed).servers.synapsor).toBeUndefined();
  });
});

describe("managed MCP project command surface", () => {
  it("requires explicit authoring for the combined Read and Action install", async () => {
    const root = await projectFixture();
    await expect(mcp([
      "install", "claude-code",
      "--project", "--include-actions",
      "--project-root", root,
    ])).rejects.toThrow(/--include-actions requires --authoring/);
  });

  it("reports both independently owned entries through the public status command", async () => {
    const root = await projectFixture();
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((value) => {
      output.push(String(value));
      return true;
    });
    try {
      await expect(mcp([
        "status", "claude-code",
        "--project", "--include-actions", "--json",
        "--project-root", root,
      ])).resolves.toBe(1);
    } finally {
      write.mockRestore();
    }
    expect(JSON.parse(output.join(""))).toMatchObject({
      ok: false,
      runtimes: [
        { role: "read", entry: "synapsor", state: "not_installed" },
        { role: "action", entry: "synapsor-actions", state: "not_installed" },
      ],
    });
  });
});

async function projectFixture(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-managed-mcp-project-"));
  const root = path.join(parent, "project with spaces");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "synapsor.runner.json"), "{}\n", "utf8");
  return root;
}
