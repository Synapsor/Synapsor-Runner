import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = new Set(process.argv.slice(2));
const mode = args.has("--packed") ? "packed" : "source";
const requirePnpm = args.has("--require-pnpm");
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const manifestPath = path.resolve(positional[0] ?? path.join(root, "apps/runner/package.json"));
const specManifest = JSON.parse(await fs.readFile(path.join(root, "packages/spec/package.json"), "utf8"));
const expectedSpecVersion = positional[1] ?? specManifest.version;
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

if (manifest.name !== "@synapsor/runner") {
  throw new Error(`publish manifest has unexpected package name: ${String(manifest.name)}`);
}

const dependencySections = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
];
const localProtocol = /^(?:workspace|file|link|portal):/;
const expectedSpecRange = `^${expectedSpecVersion}`;
const expectedWorkspaceSpecRange = `workspace:${expectedSpecRange}`;

if (requirePnpm) {
  const userAgent = process.env.npm_config_user_agent ?? "";
  if (!userAgent.startsWith("pnpm/")) {
    throw new Error(
      "Runner must be published with `corepack pnpm publish`; npm does not rewrite workspace dependencies safely.",
    );
  }
}

for (const section of dependencySections) {
  for (const [name, range] of Object.entries(manifest[section] ?? {})) {
    if (typeof range !== "string") {
      throw new Error(`${section}.${name} must be a string`);
    }
    const permittedSourceWorkspace =
      mode === "source" &&
      section === "dependencies" &&
      name === "@synapsor/spec" &&
      range === expectedWorkspaceSpecRange;
    if (!permittedSourceWorkspace && (localProtocol.test(range) || path.isAbsolute(range))) {
      throw new Error(`${section}.${name} contains a non-publishable local dependency: ${range}`);
    }
  }
}

const requiredSpecRange = mode === "source" ? expectedWorkspaceSpecRange : expectedSpecRange;
if (manifest.dependencies?.["@synapsor/spec"] !== requiredSpecRange) {
  throw new Error(
    `dependencies.@synapsor/spec must be ${requiredSpecRange}, got ${String(manifest.dependencies?.["@synapsor/spec"])}`,
  );
}

process.stdout.write(
  mode === "source"
    ? `Runner source manifest is pnpm-publishable: ${manifest.name}@${manifest.version} (${requiredSpecRange})\n`
    : `Runner packed manifest is registry-installable: ${manifest.name}@${manifest.version} (${requiredSpecRange})\n`,
);
