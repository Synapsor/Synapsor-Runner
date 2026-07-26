import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerRoot = path.join(root, "apps", "runner");
const sourceRoot = path.join(runnerRoot, "src");
const distRoot = path.join(runnerRoot, "dist");
const portableMarker = "// Generated portable declaration surface; do not edit.";
const typeFormatFlags =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.MultilineObjectLiterals;

const cliRoots = [
  ["@synapsor-runner/mcp-server", "DbRowReader", "type"],
  ["@synapsor-runner/mcp-server", "RuntimeCapabilityConfig", "type"],
  ["@synapsor-runner/mcp-server", "RuntimeConfig", "type"],
  ["@synapsor-runner/mcp-server", "RuntimeSupervisedWorkerCapabilityPolicy", "type"],
  ["@synapsor-runner/proposal-store", "ProposalStore", "type"],
  ["@synapsor-runner/proposal-store", "PolicyApprovalLimit", "type"],
  ["@synapsor-runner/proposal-store", "StoredProposal", "type"],
  ["@synapsor-runner/proposal-store", "StoredWritebackIntent", "type"],
  ["@synapsor-runner/protocol", "ExecutionReceiptV2", "type"],
  ["@synapsor-runner/protocol", "ExecutionReceiptV3", "type"],
  ["@synapsor-runner/protocol", "ExecutionReceiptV4", "type"],
  ["@synapsor-runner/protocol", "WritebackJob", "type"],
  ["@synapsor-runner/schema-inspector", "inspectDatabase", "value"],
  ["@synapsor-runner/schema-inspector", "SchemaInspection", "type"],
  ["@synapsor-runner/worker-core", "ReconciliationObservation", "type"],
  ["./local-ui.js", "WorkbenchDeploymentProfile", "type"],
];

const shadowRoots = [
  ["@synapsor-runner/proposal-store", "ShadowEffect", "type", true],
  ["@synapsor-runner/proposal-store", "ShadowOutcomeDisposition", "type", true],
  ["@synapsor-runner/proposal-store", "StoredShadowOutcome", "type", true],
];

export async function makeRunnerDeclarationsPortable() {
  const configPath = path.join(runnerRoot, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(formatDiagnostics([configFile.error]));
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    runnerRoot,
    {
      composite: false,
      declaration: true,
      declarationMap: false,
      emitDeclarationOnly: true,
      incremental: false,
      noEmit: false,
    },
    configPath,
  );
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    throw new Error(formatDiagnostics(diagnostics));
  }

  const emitted = new Map();
  const result = program.emit(
    undefined,
    (filename, data) => {
      if (filename.endsWith(".d.ts")) emitted.set(path.basename(filename), data);
    },
    undefined,
    true,
  );
  if (result.emitSkipped || result.diagnostics.length) {
    throw new Error(formatDiagnostics(result.diagnostics));
  }

  const checker = program.getTypeChecker();
  const cliSource = requiredSource(program, path.join(sourceRoot, "cli.ts"));
  const shadowSource = requiredSource(program, path.join(sourceRoot, "shadow.ts"));
  const packageNames = await workspacePackageNames();

  const cliDeclarations = declarationClosure({
    checker,
    compilerOptions: parsed.options,
    context: cliSource,
    packageNames,
    program,
    roots: cliRoots,
  });
  const shadowDeclarations = declarationClosure({
    checker,
    compilerOptions: parsed.options,
    context: shadowSource,
    packageNames,
    program,
    roots: shadowRoots,
  });

  const cli = portableEntry(emitted.get("cli.d.ts"), cliDeclarations, {
    removeLocalUiImport: true,
  });
  const shadow = portableEntry(emitted.get("shadow.d.ts"), shadowDeclarations, {
    removeProposalStoreReexport: true,
  });

  await Promise.all([
    writePortableDeclaration("cli", cli),
    writePortableDeclaration("shadow", shadow),
  ]);
}

function declarationClosure({
  checker,
  compilerOptions,
  context,
  packageNames,
  program,
  roots,
}) {
  const records = new Map();
  const names = new Map();
  const usedNames = new Map();
  const queue = [];

  for (const [moduleName, exportName, kind, exported = false] of roots) {
    const symbol = importedSymbol(checker, context, moduleName, exportName);
    enqueue(symbol, exportName, kind, exported, true);
  }

  for (let index = 0; index < queue.length; index += 1) {
    const record = queue[index];
    record.text = record.kind === "value"
      ? valueDeclaration(record)
      : typeDeclaration(record);
  }

  return queue.map((record) => record.text).join("\n");

  function enqueue(symbol, preferredName, kind, exported = false, exactName = false) {
    const target = resolveAlias(checker, symbol);
    const key = symbolKey(target);
    const prior = records.get(key);
    if (prior) {
      if (exported) prior.exported = true;
      return prior.name;
    }

    const name = allocateName(target, preferredName, exactName);
    const record = { exported, kind, name, symbol: target, text: "" };
    records.set(key, record);
    queue.push(record);
    return name;
  }

  function allocateName(symbol, preferredName, exactName) {
    const key = symbolKey(symbol);
    if (names.has(key)) return names.get(key);
    let candidate = sanitizeIdentifier(preferredName || symbol.name || "InternalType");
    const owner = usedNames.get(candidate);
    if (owner && owner !== key) {
      if (exactName) {
        throw new Error(`Portable declaration root name collision: ${candidate}`);
      }
      candidate = `${candidate}__${symbolPackageSuffix(symbol)}`;
      let suffix = 2;
      while (usedNames.has(candidate) && usedNames.get(candidate) !== key) {
        candidate = `${candidate}_${suffix}`;
        suffix += 1;
      }
    }
    names.set(key, candidate);
    usedNames.set(candidate, key);
    return candidate;
  }

  function typeDeclaration(record) {
    const declaration = record.symbol.declarations?.[0];
    if (!declaration) {
      throw new Error(`Missing declaration for internal type ${record.symbol.name}`);
    }
    const type = checker.getDeclaredTypeOfSymbol(record.symbol);
    const body = isObjectDeclaration(declaration)
      ? objectType(type, declaration)
      : aliasBody(type, declaration, record.name);
    return `${record.exported ? "export " : ""}type ${record.name} = ${body};`;
  }

  function valueDeclaration(record) {
    const declaration = record.symbol.valueDeclaration ?? record.symbol.declarations?.[0];
    if (!declaration) {
      throw new Error(`Missing declaration for internal value ${record.symbol.name}`);
    }
    const type = checker.getTypeOfSymbolAtLocation(record.symbol, declaration);
    return `declare const ${record.name}: ${portableTypeString(type, declaration)};`;
  }

  function aliasBody(type, declaration, localName) {
    const structural = {
      ...type,
      aliasSymbol: undefined,
      aliasTypeArguments: undefined,
    };
    const body = portableTypeString(structural, declaration);
    if (body !== localName) return body;
    if (type.isUnion()) {
      return type.types
        .map((member) => portableTypeString(member, declaration))
        .join(" | ");
    }
    if (type.isIntersection()) {
      return type.types
        .map((member) => portableTypeString(member, declaration))
        .join(" & ");
    }
    throw new Error(`Portable declaration expansion remained self-referential: ${localName}`);
  }

  function objectType(type, declaration) {
    const members = checker.getPropertiesOfType(type).map((property) => {
      const propertyDeclaration = property.valueDeclaration ?? property.declarations?.[0] ?? declaration;
      const propertyType = checker.getTypeOfSymbolAtLocation(property, propertyDeclaration);
      const optional = (property.flags & ts.SymbolFlags.Optional) !== 0 ? "?" : "";
      const readonly = property.declarations?.some(hasReadonlyModifier) ? "readonly " : "";
      return `${readonly}${propertyName(property.name)}${optional}: ${portableTypeString(propertyType, propertyDeclaration)};`;
    });
    const stringIndex = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    if (stringIndex) {
      members.push(`[key: string]: ${portableTypeString(stringIndex, declaration)};`);
    }
    const numberIndex = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (numberIndex) {
      members.push(`[key: number]: ${portableTypeString(numberIndex, declaration)};`);
    }
    return `{ ${members.join(" ")} }`;
  }

  function portableTypeString(type, declaration) {
    const rendered = checker.typeToString(type, context, typeFormatFlags);
    return rewriteImportTypes(rendered, declaration);
  }

  function rewriteImportTypes(rendered, declaration) {
    return rendered.replace(
      /(typeof\s+)?import\("([^"]+)"(?:,\s*\{[^)]*\})?\)\.([A-Za-z_$][\w$]*)/g,
      (match, typeOf, moduleName, exportName) => {
        const directPackageName = path.isAbsolute(moduleName)
          ? packageNameForSource(moduleName, packageNames)
          : undefined;
        if (
          directPackageName &&
          !directPackageName.startsWith("@synapsor-runner/") &&
          directPackageName !== "@synapsor/runner"
        ) {
          return `${typeOf ?? ""}import("${directPackageName}").${exportName}`;
        }
        const resolved = resolveModuleSource(
          moduleName,
          declaration.getSourceFile().fileName,
          compilerOptions,
          program,
        );
        if (!resolved) return match;
        const packageName = packageNameForSource(resolved.fileName, packageNames);
        if (!packageName?.startsWith("@synapsor-runner/") && !isRunnerSource(resolved.fileName)) {
          if (!packageName) return match;
          return `${typeOf ?? ""}import("${packageName}").${exportName}`;
        }
        const moduleSymbol = checker.getSymbolAtLocation(resolved);
        if (!moduleSymbol) {
          throw new Error(`Cannot resolve declaration module symbol: ${resolved.fileName}`);
        }
        const exportedSymbol = checker.getExportsOfModule(moduleSymbol)
          .find((candidate) => candidate.name === exportName);
        if (!exportedSymbol) {
          throw new Error(`Cannot resolve ${exportName} from ${resolved.fileName}`);
        }
        const target = resolveAlias(checker, exportedSymbol);
        const localName = enqueue(
          target,
          exportName,
          typeOf ? "value" : "type",
        );
        return `${typeOf ?? ""}${localName}`;
      },
    );
  }
}

function importedSymbol(checker, source, moduleName, exportName) {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== moduleName) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const element = bindings.elements.find((candidate) => candidate.name.text === exportName);
    if (!element) continue;
    const symbol = checker.getSymbolAtLocation(element.name);
    if (symbol) return resolveAlias(checker, symbol);
  }
  throw new Error(`Cannot find ${exportName} imported from ${moduleName} in ${source.fileName}`);
}

function resolveAlias(checker, symbol) {
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function resolveModuleSource(moduleName, containingFile, compilerOptions, program) {
  let filename;
  if (path.isAbsolute(moduleName)) {
    filename = moduleName;
  } else {
    filename = ts.resolveModuleName(
      moduleName,
      containingFile,
      compilerOptions,
      ts.sys,
    ).resolvedModule?.resolvedFileName;
  }
  if (!filename) return undefined;
  const candidates = [
    filename,
    `${filename}.d.ts`,
    `${filename}.ts`,
    path.join(filename, "index.d.ts"),
    path.join(filename, "index.ts"),
  ];
  for (const candidate of candidates) {
    const source = program.getSourceFile(candidate);
    if (source) return source;
  }
  return undefined;
}

async function workspacePackageNames() {
  const names = [];
  for (const directory of [
    path.join(root, "packages"),
    path.join(root, "apps"),
  ]) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageRoot = path.join(directory, entry.name);
      const manifestPath = path.join(packageRoot, "package.json");
      try {
        const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
        if (manifest.name) names.push([packageRoot, manifest.name]);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return names.sort((left, right) => right[0].length - left[0].length);
}

function packageNameForSource(filename, packageNames) {
  const normalized = path.resolve(filename);
  for (const [packageRoot, packageName] of packageNames) {
    if (normalized === packageRoot || normalized.startsWith(`${packageRoot}${path.sep}`)) {
      return packageName;
    }
  }
  const marker = `${path.sep}node_modules${path.sep}`;
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return undefined;
  const remainder = normalized.slice(index + marker.length).split(path.sep);
  return remainder[0]?.startsWith("@")
    ? `${remainder[0]}/${remainder[1]}`
    : remainder[0];
}

function isRunnerSource(filename) {
  const normalized = path.resolve(filename);
  return normalized.startsWith(`${sourceRoot}${path.sep}`);
}

function symbolKey(symbol) {
  const declaration = symbol.declarations?.[0] ?? symbol.valueDeclaration;
  if (!declaration) return `unknown:${symbol.name}`;
  return `${declaration.getSourceFile().fileName}:${declaration.pos}:${symbol.name}`;
}

function symbolPackageSuffix(symbol) {
  const filename = symbol.declarations?.[0]?.getSourceFile().fileName ?? "internal";
  const relative = path.relative(root, filename).split(path.sep);
  return sanitizeIdentifier(relative[1] ?? relative[0] ?? "internal");
}

function sanitizeIdentifier(value) {
  const identifier = value.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(identifier) ? identifier : `_${identifier}`;
}

function propertyName(name) {
  return /^[$A-Z_a-z][$\w]*$/.test(name) ? name : JSON.stringify(name);
}

function hasReadonlyModifier(declaration) {
  return ts.canHaveModifiers(declaration) &&
    ts.getModifiers(declaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword);
}

function isObjectDeclaration(declaration) {
  return ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration);
}

function requiredSource(program, filename) {
  const source = program.getSourceFile(filename);
  if (!source) throw new Error(`TypeScript source is missing from declaration program: ${filename}`);
  return source;
}

function portableEntry(raw, declarations, options) {
  if (!raw) throw new Error("TypeScript did not emit a required Runner declaration entry");
  let result = raw
    .replace(/^import .* from "@synapsor-runner\/[^"]+";\n/gm, "")
    .replace(/^import .* from "\.\/local-ui\.js";\n/gm, "");
  if (options.removeProposalStoreReexport) {
    result = result.replace(
      /^export type \{[^}]+\} from "@synapsor-runner\/proposal-store";\n/gm,
      "",
    );
  }
  const shebang = result.startsWith("#!")
    ? result.slice(0, result.indexOf("\n") + 1)
    : "";
  if (shebang) result = result.slice(shebang.length);
  return `${shebang}${portableMarker}\n${declarations}\n${result.trimEnd()}\n`;
}

async function writePortableDeclaration(name, declaration) {
  const declarationPath = path.join(distRoot, `${name}.d.ts`);
  const mapName = `${name}.d.ts.map`;
  const mapPath = path.join(distRoot, mapName);
  const withMap = `${declaration.trimEnd()}\n//# sourceMappingURL=${mapName}\n`;
  await Promise.all([
    fsp.writeFile(declarationPath, withMap),
    fsp.writeFile(
      mapPath,
      `${JSON.stringify({
        version: 3,
        file: `${name}.d.ts`,
        sourceRoot: "",
        sources: [],
        names: [],
        mappings: "",
      })}\n`,
    ),
  ]);
}

function formatDiagnostics(diagnostics) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (filename) => filename,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await makeRunnerDeclarationsPortable();
}
