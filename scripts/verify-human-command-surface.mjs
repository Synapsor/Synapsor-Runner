#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const humanRoots = [
  "README.md",
  "apps/cloud-cli/README.md",
  "apps/runner/README.md",
  "docs",
  "examples",
  "plugins",
];
const generatedCommandSources = [
  "apps/runner/src/boundary-workbench.ts",
  "apps/runner/src/cli.ts",
  "apps/runner/src/cursor-project.ts",
  "apps/runner/src/guided-project.ts",
];
const primaryGuides = new Set([
  "README.md",
  "apps/runner/README.md",
  "docs/fresh-developer-usability.md",
  "docs/getting-started-own-database.md",
  "docs/guided-onboarding.md",
  "docs/mcp-client-setup.md",
  "docs/troubleshooting-first-run.md",
  "docs/use-your-own-database.md",
]);

for (const relative of [...walkHumanFiles(humanRoots), ...generatedCommandSources]) {
  const content = fs.readFileSync(path.join(root, relative), "utf8");
  if (/npx\s+(?:-y|--yes)\s+(?:-p|--package)\s+@synapsor\/[a-z0-9._-]+\b/i.test(content)) {
    failures.push(`${relative} uses npm package-selection ceremony instead of the package's direct npx binary.`);
  }
  if (/"(?:-y|--yes)"\s*,\s*"(?:-p|--package)"\s*,\s*"@synapsor\/[a-z0-9._-]+/i.test(content)) {
    failures.push(`${relative} generates npm package-selection ceremony for a human-facing client config.`);
  }
  if (primaryGuides.has(relative) && /@synapsor\/runner@(?:latest|\d+\.\d+\.\d+)/.test(content)) {
    failures.push(`${relative} pins a release in a primary human guide; current guidance must use @synapsor/runner.`);
  }
}

if (failures.length) {
  console.error("Human command-surface verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Human command-surface verification passed.");

function walkHumanFiles(entries) {
  const files = [];
  for (const relative of entries) {
    const absolute = path.join(root, relative);
    const stat = fs.statSync(absolute);
    if (stat.isFile()) {
      files.push(relative);
      continue;
    }
    walkDirectory(relative, files);
  }
  return files;
}

function walkDirectory(relative, files) {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      walkDirectory(child, files);
    } else if (/\.(?:md|json|toml|ts|mjs|py|yaml|yml)$/.test(entry.name) || entry.name === "Makefile") {
      files.push(child);
    }
  }
}
