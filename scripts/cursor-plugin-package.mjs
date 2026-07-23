import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const cursorPluginSource = path.join(repositoryRoot, "plugins/cursor/synapsor");
export const cursorPluginOutput = path.join(repositoryRoot, "dist/cursor-plugin/synapsor");
export const cursorPluginVersion = "1.6.1";

const allowedManifestKeys = new Set([
  "name", "version", "description", "author", "homepage", "repository",
  "license", "keywords", "logo", "rules", "skills", "commands", "mcpServers",
]);

export async function validateCursorPlugin(directory = cursorPluginSource, expectedVersion = cursorPluginVersion) {
  const root = path.resolve(directory);
  const files = await walkRegularFiles(root);
  const requiredFiles = [
    ".cursor-plugin/plugin.json",
    "mcp.json",
    "commands/synapsor-protect.md",
    "skills/synapsor-safe-action/SKILL.md",
    "rules/synapsor-safe-action.mdc",
    "assets/logo.svg",
    "README.md",
  ];
  for (const required of requiredFiles) {
    if (!files.some((item) => item.relative === required)) throw new Error(`Cursor plugin is missing ${required}`);
  }

  const manifest = await readJson(path.join(root, ".cursor-plugin/plugin.json"));
  for (const key of Object.keys(manifest)) {
    if (!allowedManifestKeys.has(key)) throw new Error(`Cursor plugin manifest contains unsupported field: ${key}`);
  }
  if (manifest.name !== "synapsor") throw new Error("Cursor plugin manifest name must be synapsor");
  if (manifest.version !== expectedVersion) throw new Error(`Cursor plugin version must be ${expectedVersion}`);
  if (manifest.license !== "Apache-2.0") throw new Error("Cursor plugin must retain Apache-2.0 licensing");
  if (!isRecord(manifest.author) || manifest.author.name !== "Synapsor") throw new Error("Cursor plugin author is invalid");
  for (const key of ["logo", "rules", "skills", "commands", "mcpServers"]) {
    validateRelativeManifestPath(manifest[key], key);
  }

  const mcp = await readJson(path.join(root, "mcp.json"));
  if (!isRecord(mcp.mcpServers) || Object.keys(mcp.mcpServers).join(",") !== "synapsor") {
    throw new Error("Cursor plugin must expose exactly one MCP server named synapsor");
  }
  const server = mcp.mcpServers.synapsor;
  if (!isRecord(server)) throw new Error("Cursor plugin synapsor MCP entry must be an object");
  if (server.type !== "stdio" || server.command !== "npx") throw new Error("Cursor plugin must use the reviewed local stdio Runner entry");
  if ("env" in server || "envFile" in server || "url" in server || "headers" in server || "auth" in server) {
    throw new Error("Cursor plugin MCP entry must not embed environment values, remote endpoints, headers, or auth");
  }
  const expectedArgs = [
    "-y", "-p", `@synapsor/runner@${expectedVersion}`, "synapsor-runner", "mcp", "serve",
    "--config", "${workspaceFolder}/synapsor.runner.json",
    "--store", "${workspaceFolder}/.synapsor/local.db",
  ];
  if (!Array.isArray(server.args) || JSON.stringify(server.args) !== JSON.stringify(expectedArgs)) {
    throw new Error("Cursor plugin MCP args must be version-pinned, project-scoped, and serve-only");
  }

  const command = await fs.readFile(path.join(root, "commands/synapsor-protect.md"), "utf8");
  assertFrontmatter(command, "synapsor-protect", "Cursor command");
  for (const required of [
    `@synapsor/runner@${expectedVersion}`,
    "synapsor-runner start --action",
    "synapsor-runner action validate",
    "synapsor/SAFE_ACTION_AGENT.md",
    "There is intentionally no `action activate` CLI or MCP",
  ]) {
    if (!command.includes(required)) throw new Error(`Cursor command is missing required boundary text: ${required}`);
  }
  const skill = await fs.readFile(path.join(root, "skills/synapsor-safe-action/SKILL.md"), "utf8");
  assertFrontmatter(skill, "synapsor-safe-action", "Cursor skill");
  const rule = await fs.readFile(path.join(root, "rules/synapsor-safe-action.mdc"), "utf8");
  if (!rule.startsWith("---\n") || !rule.includes("synapsor/actions/**/*.ts") || !rule.includes("alwaysApply: false")) {
    throw new Error("Cursor rule must be scoped to Safe Action source files");
  }

  for (const file of files) {
    if (!/\.(?:json|md|mdc|svg)$/i.test(file.relative)) throw new Error(`Cursor plugin contains unsupported file type: ${file.relative}`);
    const text = await fs.readFile(file.absolute, "utf8");
    assertNoSensitiveMaterial(text, file.relative);
  }
  if (files.some((item) => item.relative.startsWith("hooks/"))) throw new Error("Cursor plugin must not install automatic hooks");

  return {
    ok: true,
    version: expectedVersion,
    source: root,
    files: await inventory(files),
    mcp_tools_authority: "semantic Runner tools only; no approval/apply/activation/commit/revert tool",
  };
}

export async function buildCursorPlugin(options = {}) {
  const source = path.resolve(options.source ?? cursorPluginSource);
  const output = path.resolve(options.output ?? cursorPluginOutput);
  const validation = await validateCursorPlugin(source, options.version ?? cursorPluginVersion);
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.cp(source, output, { recursive: true, dereference: false, errorOnExist: false });
  const copied = await validateCursorPlugin(output, options.version ?? cursorPluginVersion);
  if (JSON.stringify(validation.files) !== JSON.stringify(copied.files)) throw new Error("Cursor plugin package inventory changed during copy");
  const packageDigest = digest(JSON.stringify(copied.files));
  const packageManifest = `${output}.package.json`;
  await fs.writeFile(packageManifest, `${JSON.stringify({
    schema_version: "synapsor.cursor-plugin-package.v1",
    plugin: "synapsor",
    version: copied.version,
    digest: packageDigest,
    files: copied.files,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { ...copied, output, package_manifest: packageManifest, package_digest: packageDigest };
}

async function walkRegularFiles(root) {
  const result = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`Cursor plugin source must not contain symlinks: ${relative}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push({ absolute, relative });
      else throw new Error(`Cursor plugin source contains unsupported filesystem entry: ${relative}`);
    }
  }
  await visit(root);
  return result;
}

async function inventory(files) {
  const output = [];
  for (const file of files) {
    const content = await fs.readFile(file.absolute);
    output.push({ path: file.relative, bytes: content.byteLength, sha256: crypto.createHash("sha256").update(content).digest("hex") });
  }
  return output;
}

async function readJson(filePath) {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${filePath} must contain a JSON object`);
  return parsed;
}

function validateRelativeManifestPath(value, label) {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.some((item) => typeof item !== "string" || !item || path.isAbsolute(item) || item.split(/[\\/]/).includes(".."))) {
    throw new Error(`Cursor plugin manifest ${label} must use contained relative paths`);
  }
}

function assertFrontmatter(source, expectedName, label) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match || !new RegExp(`^name:\\s*${expectedName}\\s*$`, "m").test(match[1])) {
    throw new Error(`${label} must declare name ${expectedName} in YAML frontmatter`);
  }
  if (!/^description:\s*\S.+$/m.test(match[1])) throw new Error(`${label} must declare a description`);
}

function assertNoSensitiveMaterial(source, relativePath) {
  const forbidden = [
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
    [/(?:postgres(?:ql)?|mysql):\/\/(?!\$\{)[^\s<]+/i, "database URL"],
    [/(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][^"'$<{\s][^"']*["']/i, "credential value"],
    [/(?:^|[\s`"'])\/home\/[^\s`"']+/m, "local home path"],
    [/[A-Za-z]:\\Users\\[^\s`"']+/i, "local Windows user path"],
  ];
  for (const [pattern, label] of forbidden) {
    if (pattern.test(source)) throw new Error(`Cursor plugin ${relativePath} contains forbidden ${label}`);
  }
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
