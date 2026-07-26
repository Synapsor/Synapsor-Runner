#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

const packagePolicies = [
  {
    id: "proposal-store",
    root: "packages/proposal-store/src",
    facade: "index.ts",
    facadeLineLimit: 500,
    classify(moduleName) {
      if (moduleName === "index") return "facade";
      if (moduleName === "postgres-runtime-store" || moduleName === "sqlite-store") return "adapter";
      if (/^sqlite-(?:attention|cloud-control|core|metrics-policy|proposal|schema|shadow|worker|writeback)-methods$/.test(moduleName)) {
        return "repository";
      }
      return "foundation";
    },
    allowed: {
      facade: new Set(["adapter", "repository", "foundation"]),
      adapter: new Set(["adapter", "repository", "foundation"]),
      repository: new Set(["foundation"]),
      foundation: new Set(["foundation"]),
    },
  },
  {
    id: "mcp-server",
    root: "packages/mcp-server/src",
    facade: "index.ts",
    facadeLineLimit: 500,
    classify(moduleName) {
      if (moduleName === "index") return "facade";
      if (moduleName === "http-transport") return "transport";
      if (moduleName === "runtime-composition" || moduleName === "server-composition") return "composition";
      if ([
        "approval-policy",
        "cloud-linked",
        "generated-authority",
        "http-security",
        "local-resources",
        "proposal-builder",
        "proposal-freshness",
        "protected-read-runtime",
        "result-envelope",
        "runtime-logging",
        "runtime-observability",
        "source-runtime",
        "tool-catalog",
        "tool-dispatch",
        "trusted-context",
      ].includes(moduleName)) {
        return "service";
      }
      return "foundation";
    },
    allowed: {
      facade: new Set(["transport", "composition", "service", "foundation"]),
      transport: new Set(["composition", "service", "foundation"]),
      composition: new Set(["composition", "service", "foundation"]),
      service: new Set(["service", "foundation"]),
      foundation: new Set(["foundation"]),
    },
  },
  {
    id: "runner",
    root: "apps/runner/src",
    facade: "cli.ts",
    facadeLineLimit: 750,
    classify(moduleName) {
      return moduleName === "cli" ? "facade" : "implementation";
    },
    allowed: {
      facade: new Set(["implementation"]),
      implementation: new Set(["implementation"]),
    },
  },
];

const packageByRoot = new Map(
  packagePolicies.map((policy) => [path.resolve(root, policy.root), policy]),
);
const coreAliases = new Map([
  ["@synapsor-runner/proposal-store", "packages/proposal-store/src/index.ts"],
  ["@synapsor-runner/mcp-server", "packages/mcp-server/src/index.ts"],
  ["@synapsor/runner/authoring", "apps/runner/src/authoring.ts"],
  ["@synapsor/runner/cli", "apps/runner/src/cli.ts"],
]);

function sourceFiles(sourceRoot) {
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (
        entry.isFile()
        && entry.name.endsWith(".ts")
        && !entry.name.endsWith(".test.ts")
        && !entry.name.endsWith(".d.ts")
      ) {
        files.push(entryPath);
      }
    }
  }
  walk(sourceRoot);
  return files.sort();
}

function moduleSpecifiers(filePath) {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const source = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers = [];

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    } else if (
      ts.isImportTypeNode(node)
      && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteralLike(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return specifiers;
}

function resolveRelativeSource(importer, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const unresolved = path.resolve(path.dirname(importer), specifier);
  const withoutRuntimeExtension = unresolved.replace(/\.(?:c|m)?js$/, "");
  for (const candidate of [
    `${withoutRuntimeExtension}.ts`,
    path.join(withoutRuntimeExtension, "index.ts"),
  ]) {
    if (fs.existsSync(candidate)) return path.resolve(candidate);
  }
  return undefined;
}

function resolveCoreSource(importer, specifier) {
  const relativeTarget = resolveRelativeSource(importer, specifier);
  if (relativeTarget) return relativeTarget;
  const aliasTarget = coreAliases.get(specifier);
  return aliasTarget ? path.resolve(root, aliasTarget) : undefined;
}

function relative(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, "/");
}

function moduleName(filePath, sourceRoot) {
  return path.relative(sourceRoot, filePath).replaceAll(path.sep, "/").replace(/\.ts$/, "");
}

function isWithin(filePath, directory) {
  const relation = path.relative(directory, filePath);
  return relation === "" || (!relation.startsWith("..") && !path.isAbsolute(relation));
}

function policyForFile(filePath) {
  for (const [sourceRoot, policy] of packageByRoot) {
    if (isWithin(filePath, sourceRoot)) return policy;
  }
  return undefined;
}

const graph = new Map();
const importsByFile = new Map();

for (const policy of packagePolicies) {
  const sourceRoot = path.resolve(root, policy.root);
  const files = sourceFiles(sourceRoot);
  for (const filePath of files) {
    graph.set(filePath, new Set());
    const imports = moduleSpecifiers(filePath);
    importsByFile.set(filePath, imports);
    for (const specifier of imports) {
      const target = resolveCoreSource(filePath, specifier);
      if (!target || !graph.has(target)) continue;
      graph.get(filePath).add(target);
    }
  }
}

// Populate edges after every source node is known.
for (const [filePath, imports] of importsByFile) {
  for (const specifier of imports) {
    const target = resolveCoreSource(filePath, specifier);
    if (target && graph.has(target)) graph.get(filePath).add(target);
  }
}

for (const policy of packagePolicies) {
  const sourceRoot = path.resolve(root, policy.root);
  const facadePath = path.join(sourceRoot, policy.facade);
  const lineCount = fs.readFileSync(facadePath, "utf8").split(/\r?\n/).length;
  if (lineCount > policy.facadeLineLimit) {
    failures.push(
      `${relative(facadePath)} has ${lineCount} physical lines; limit is ${policy.facadeLineLimit}.`,
    );
  }

  for (const [source, targets] of graph) {
    if (!isWithin(source, sourceRoot)) continue;
    for (const target of targets) {
      const targetPolicy = policyForFile(target);
      if (targetPolicy && packagePolicies.indexOf(policy) < packagePolicies.indexOf(targetPolicy)) {
        failures.push(
          `${relative(source)} violates package direction by importing ${relative(target)}.`,
        );
      }
      if (!isWithin(target, sourceRoot)) continue;
      if (source !== facadePath && target === facadePath) {
        failures.push(`${relative(source)} imports inward through compatibility facade ${relative(target)}.`);
        continue;
      }
      const sourceZone = policy.classify(moduleName(source, sourceRoot));
      const targetZone = policy.classify(moduleName(target, sourceRoot));
      if (!policy.allowed[sourceZone]?.has(targetZone)) {
        failures.push(
          `${relative(source)} (${sourceZone}) may not import ${relative(target)} (${targetZone}).`,
        );
      }
    }
  }
}

for (const [filePath, imports] of importsByFile) {
  const policy = policyForFile(filePath);
  if (!policy) continue;
  for (const specifier of imports) {
    if (
      policy.id === "proposal-store"
      && (
        specifier === "@synapsor-runner/mcp-server"
        || specifier === "@synapsor/runner"
        || specifier.startsWith("@synapsor/runner/")
      )
    ) {
      failures.push(`${relative(filePath)} violates package direction by importing ${specifier}.`);
    }
    if (
      policy.id === "mcp-server"
      && (specifier === "@synapsor/runner" || specifier.startsWith("@synapsor/runner/"))
    ) {
      failures.push(`${relative(filePath)} violates package direction by importing ${specifier}.`);
    }
    if (
      policy.id === "runner"
      && filePath !== path.resolve(root, policy.root, policy.facade)
      && specifier === "@synapsor/runner/cli"
    ) {
      failures.push(`${relative(filePath)} imports inward through the published CLI facade.`);
    }
  }
}

const visiting = new Set();
const visited = new Set();
const stack = [];

function visitForCycles(node) {
  if (visited.has(node)) return;
  if (visiting.has(node)) {
    const start = stack.indexOf(node);
    const cycle = [...stack.slice(start), node].map(relative).join(" -> ");
    failures.push(`trusted-core import cycle: ${cycle}`);
    return;
  }
  visiting.add(node);
  stack.push(node);
  for (const target of graph.get(node) ?? []) visitForCycles(target);
  stack.pop();
  visiting.delete(node);
  visited.add(node);
}

for (const node of graph.keys()) visitForCycles(node);

if (failures.length > 0) {
  process.stderr.write("Trusted-core dependency check failed:\n");
  for (const failure of [...new Set(failures)].sort()) {
    process.stderr.write(`- ${failure}\n`);
  }
  process.exit(1);
}

const edgeCount = [...graph.values()].reduce((sum, targets) => sum + targets.size, 0);
process.stdout.write(
  `Trusted-core dependency check passed (${graph.size} modules, ${edgeCount} internal edges).\n`,
);
