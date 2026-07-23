import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(
  root,
  "fixtures",
  "compatibility",
  "published-1.5.4",
  "manifest.json",
);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

const spec = await import(pathToFileURL(path.join(root, "packages", "spec", "dist", "index.js")));
const dsl = await import(pathToFileURL(path.join(root, "packages", "dsl", "dist", "index.js")));

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertLegacyShape(contract, label) {
  for (const capability of contract.capabilities ?? []) {
    if (Object.prototype.hasOwnProperty.call(capability, "protected_read")) {
      throw new Error(`${label}: legacy capability gained protected_read`);
    }
  }
}

for (const fixture of manifest.contracts) {
  const sourcePath = path.join(root, fixture.path);
  const source = fs.readFileSync(sourcePath, "utf8");
  assertEqual(sha256(source), fixture.source_sha256, `${fixture.path} source`);

  const normalized = spec.normalizeContract(JSON.parse(source));
  assertLegacyShape(normalized, fixture.path);
  assertEqual(
    sha256(JSON.stringify(normalized)),
    fixture.canonical_sha256,
    `${fixture.path} canonical contract`,
  );
}

for (const fixture of manifest.dsl_sources) {
  const sourcePath = path.join(root, fixture.path);
  const source = fs.readFileSync(sourcePath, "utf8");
  assertEqual(sha256(source), fixture.source_sha256, `${fixture.path} source`);

  const normalized = spec.normalizeContract(dsl.compileAgentDsl(source));
  assertLegacyShape(normalized, fixture.path);
  assertEqual(
    sha256(JSON.stringify(normalized)),
    fixture.canonical_sha256,
    `${fixture.path} compiled canonical contract`,
  );
}

const packageSummary = Object.entries(manifest.published_packages)
  .map(([name, value]) => `${name}@${value.version}`)
  .join(", ");
console.log(
  `Published compatibility verified: ${manifest.contracts.length} contracts, ` +
    `${manifest.dsl_sources.length} DSL sources (${packageSummary}).`,
);
