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
if (!license.startsWith("Apache License\n                           Version 2.0, January 2004\n")) {
  fail("LICENSE must contain the canonical Apache License 2.0 text.");
}

for (const pkgFile of listPackageJsonFiles()) {
  const pkg = JSON.parse(read(pkgFile));
  if (pkg.license !== "Apache-2.0") {
    fail(`${pkgFile} must set license to Apache-2.0.`);
  }
}

const readme = read("README.md");
const readmeFirstScreen = readme.split("## The Five-Line Model", 1)[0];
if (!/\bopen-source\b/i.test(readmeFirstScreen)) {
  fail("README first screen must describe the runner as open source.");
}
if (!readme.includes("Apache License 2.0 (`Apache-2.0`)")) {
  fail("README must name Apache License 2.0.");
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
  "scripts/check-license-content.mjs",
]);
const stalePattern = new RegExp([
  "Elastic-2\\.0",
  "Elastic" + " License",
  "source" + "-available",
  "source" + " available",
].join("|"), "i");

for (const rel of textFiles) {
  const normalized = rel.replace(/^[.][/\\]/, "");
  const content = read(normalized);
  if (stalePattern.test(content)) {
    fail(`${normalized} contains stale non-Apache licensing wording.`);
  }
  if (/\bopen-source\b/i.test(content) && !allowedOpenSourceFiles.has(normalized)) {
    // Hyphenated "open-source" is allowed in docs, README, and package metadata
    // after the Apache-2.0 migration. Keep this branch to make the policy
    // explicit and avoid future accidental reintroduction of older checks.
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
