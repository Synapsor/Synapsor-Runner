import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCursorPlugin, cursorPluginVersion, validateCursorPlugin } from "./cursor-plugin-package.mjs";

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor cursor plugin "));
try {
  const packageRoot = path.join(temporaryRoot, "package with spaces", "synapsor");
  const built = await buildCursorPlugin({ output: packageRoot });
  await validateCursorPlugin(packageRoot, cursorPluginVersion);

  const home = path.join(temporaryRoot, "home with spaces");
  const localPlugins = path.join(home, ".cursor/plugins/local");
  const installed = path.join(localPlugins, "synapsor");
  const unrelatedPlugin = path.join(localPlugins, "existing-plugin");
  await fs.mkdir(unrelatedPlugin, { recursive: true });
  await fs.writeFile(path.join(unrelatedPlugin, "sentinel.txt"), "preserve\n", "utf8");

  const project = path.join(temporaryRoot, "application with spaces");
  const cursorConfig = path.join(project, ".cursor/mcp.json");
  await fs.mkdir(path.dirname(cursorConfig), { recursive: true });
  const unrelatedConfig = `${JSON.stringify({ mcpServers: { existing: { command: "node", args: ["existing.mjs"] } }, projectSetting: true }, null, 2)}\n`;
  await fs.writeFile(cursorConfig, unrelatedConfig, "utf8");

  await installCopiedPlugin(packageRoot, installed);
  const first = await validateCursorPlugin(installed, cursorPluginVersion);
  await installCopiedPlugin(packageRoot, installed);
  const second = await validateCursorPlugin(installed, cursorPluginVersion);
  if (JSON.stringify(first.files) !== JSON.stringify(second.files)) throw new Error("Cursor plugin reinstall was not idempotent");
  if (await fs.readFile(cursorConfig, "utf8") !== unrelatedConfig) throw new Error("Cursor plugin local install changed unrelated project MCP configuration");

  await fs.rm(installed, { recursive: true, force: true });
  if (await exists(installed)) throw new Error("Cursor plugin local uninstall did not remove its own directory");
  if (await fs.readFile(path.join(unrelatedPlugin, "sentinel.txt"), "utf8") !== "preserve\n") throw new Error("Cursor plugin uninstall changed another local plugin");
  if (await fs.readFile(cursorConfig, "utf8") !== unrelatedConfig) throw new Error("Cursor plugin uninstall changed unrelated project MCP configuration");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    version: cursorPluginVersion,
    official_format: true,
    package_digest: built.package_digest,
    files: built.files.length,
    project_path_with_spaces: true,
    copied_install_idempotent: true,
    clean_uninstall: true,
    unrelated_cursor_config_preserved: true,
    secrets_embedded: false,
    activation_authority_embedded: false,
  }, null, 2)}\n`);
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

async function installCopiedPlugin(source, destination) {
  const temporary = `${destination}.tmp-${process.pid}`;
  await fs.rm(temporary, { recursive: true, force: true });
  await fs.cp(source, temporary, { recursive: true });
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(temporary, destination);
}

async function exists(value) {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}
