#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

function fail(message) {
  failures.push(message);
}

function listPackageJsonFiles() {
  const files = ["package.json"];
  for (const dir of ["apps", "packages"]) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const child of fs.readdirSync(abs)) {
      const pkg = path.join(dir, child, "package.json");
      if (exists(pkg)) files.push(pkg);
    }
  }
  return files;
}

const license = read("LICENSE");
if (!license.startsWith("Elastic License 2.0\n")) {
  fail("LICENSE must contain the official Elastic License 2.0 text.");
}

for (const pkgFile of listPackageJsonFiles()) {
  const pkg = JSON.parse(read(pkgFile));
  if (pkg.license !== "Elastic-2.0") {
    fail(`${pkgFile} must set license to Elastic-2.0.`);
  }
}

const readme = read("README.md");
if (!/Source-available commit-safe MCP runtime/.test(readme)) {
  fail("README first screen must describe the runner as source-available.");
}
if (!readme.includes("Elastic License 2.0 (`Elastic-2.0`)")) {
  fail("README must name Elastic License 2.0.");
}

for (const required of [
  "docs/licensing.md",
  "TRADEMARKS.md",
  "CONTRIBUTING.md",
  "NOTICE",
  "docs/dependency-license-inventory.md",
]) {
  if (!exists(required)) fail(`${required} is required for the license/content gate.`);
}

const textFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(rel);
    } else if (/\.(md|json|txt|schema|ts|mjs)$/.test(entry.name) || ["LICENSE", "NOTICE", "TRADEMARKS.md", "CONTRIBUTING.md"].includes(entry.name)) {
      textFiles.push(rel);
    }
  }
}
walk(".");

const allowedOpenSourceFiles = new Set([
  "docs/licensing.md",
  "IMPLEMENTATION_REPORT.md",
  "scripts/check-license-content.mjs",
]);
const allowedApacheFiles = new Set([
  "docs/dependency-license-inventory.md",
  "IMPLEMENTATION_REPORT.md",
  "scripts/check-license-content.mjs",
]);

for (const rel of textFiles) {
  const normalized = rel.replace(/^[.][/\\]/, "");
  const content = read(normalized);
  if (/\bopen-source\b/i.test(content) && !allowedOpenSourceFiles.has(normalized)) {
    fail(`${normalized} contains open-source wording; use source-available or clearly label history.`);
  }
  if (/(Apache-2\.0|Apache License)/.test(content) && !allowedApacheFiles.has(normalized)) {
    fail(`${normalized} contains Apache license wording outside allowed dependency/history docs.`);
  }
}

const trackedSecretNames = [".env", ".env.local", ".env.production"];
for (const name of trackedSecretNames) {
  if (exists(name)) fail(`${name} must not be tracked in the repository.`);
}

if (failures.length) {
  console.error("License/content check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("License/content check passed.");
