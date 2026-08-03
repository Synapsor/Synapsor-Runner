#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const statusOnly = args.includes("--status");
const packageIndex = args.indexOf("--package");
const requestedPackage = packageIndex >= 0 ? args[packageIndex + 1] : undefined;
const publicPackages = [
  { name: "@synapsor/spec", directory: path.join(root, "packages/spec") },
  { name: "@synapsor/dsl", directory: path.join(root, "packages/dsl") },
];
const selected = requestedPackage
  ? publicPackages.filter((entry) => entry.name === requestedPackage)
  : publicPackages;

if (selected.length === 0) {
  throw new Error(`unknown public package ${JSON.stringify(requestedPackage)}`);
}

const statuses = [];
for (const entry of selected) {
  statuses.push(checkPackage(entry));
}

if (statusOnly) {
  if (statuses.length !== 1) {
    throw new Error("--status requires exactly one --package");
  }
  process.stdout.write(`${statuses[0].status}\n`);
  process.exit(0);
}

const collisions = statuses.filter((entry) => entry.status === "changed");
if (collisions.length > 0) {
  process.stderr.write("Public package version collision detected:\n");
  for (const collision of collisions) {
    process.stderr.write(
      `- ${collision.name}@${collision.version} differs from the immutable npm artifact: ${collision.differences.join(", ")}\n`,
    );
  }
  process.stderr.write(
    "Choose and prepare new public package versions before releasing Runner; npm cannot replace an existing version.\n",
  );
  process.exit(1);
}

for (const status of statuses) {
  process.stdout.write(
    status.status === "identical"
      ? `${status.name}@${status.version} matches npm byte-for-byte by packed file content.\n`
      : `${status.name}@${status.version} is not published yet; local pre-release packing is required.\n`,
  );
}

function checkPackage(entry) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(entry.directory, "package.json"), "utf8"),
  );
  const version = String(manifest.version);
  const published = run(
    "npm",
    ["view", `${entry.name}@${version}`, "version"],
    root,
    true,
  );
  if (published.status !== 0 || published.stdout.trim() !== version) {
    return { ...entry, version, status: "unpublished", differences: [] };
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-public-version-"));
  try {
    const localPack = path.join(temp, "local-pack");
    const registryPack = path.join(temp, "registry-pack");
    const localExtract = path.join(temp, "local");
    const registryExtract = path.join(temp, "registry");
    for (const directory of [localPack, registryPack, localExtract, registryExtract]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    run(
      "corepack",
      ["pnpm", "--dir", entry.directory, "pack", "--pack-destination", localPack],
      root,
    );
    run(
      "npm",
      ["pack", `${entry.name}@${version}`, "--pack-destination", registryPack, "--silent"],
      root,
    );
    const localTarball = onlyTarball(localPack);
    const registryTarball = onlyTarball(registryPack);
    run("tar", ["-xzf", localTarball, "-C", localExtract], root);
    run("tar", ["-xzf", registryTarball, "-C", registryExtract], root);
    const localFiles = contentManifest(path.join(localExtract, "package"));
    const registryFiles = contentManifest(path.join(registryExtract, "package"));
    const differences = manifestDifferences(localFiles, registryFiles);
    return {
      ...entry,
      version,
      status: differences.length === 0 ? "identical" : "changed",
      differences: differences.slice(0, 12),
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function onlyTarball(directory) {
  const tarballs = fs.readdirSync(directory)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => path.join(directory, name));
  if (tarballs.length !== 1) {
    throw new Error(`expected one tarball in ${directory}, found ${tarballs.length}`);
  }
  return tarballs[0];
}

function contentManifest(directory) {
  const result = new Map();
  visit(directory, "");
  return result;

  function visit(absolute, relative) {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const childAbsolute = path.join(absolute, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(childAbsolute, childRelative);
      } else if (entry.isFile()) {
        result.set(
          childRelative,
          crypto.createHash("sha256").update(fs.readFileSync(childAbsolute)).digest("hex"),
        );
      } else if (entry.isSymbolicLink()) {
        result.set(childRelative, `symlink:${fs.readlinkSync(childAbsolute)}`);
      }
    }
  }
}

function manifestDifferences(left, right) {
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  return names.filter((name) => left.get(name) !== right.get(name));
}

function run(command, commandArgs, cwd, allowFailure = false) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result;
}
