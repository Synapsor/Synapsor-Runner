import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

export const legitimateUses = new Set([
  'redaction_secret_detection', 'exact_identifier_or_code', 'formal_grammar',
  'explicit_command', 'display_formatting',
]);
const methods = new Set(['test', 'exec', 'match', 'matchAll', 'search', 'includes',
  'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'split', 'replace', 'replaceAll',
  'toLowerCase', 'toUpperCase', 'toLocaleLowerCase', 'toLocaleUpperCase', 'normalize',
  'trim', 'trimStart', 'trimEnd', 'has', 'get', 'set', 'add', 'delete', 'localeCompare']);
const sha = value => createHash('sha256').update(value).digest('hex');
const printer = ts.createPrinter({ removeComments: true });
const print = (node, source) => printer.printNode(ts.EmitHint.Unspecified, node, source);
const textLiteral = node => ts.isStringLiteralLike(node) || ts.isTemplateExpression(node);

function kindOf(node) {
  if (ts.isRegularExpressionLiteral(node)) return 'regex';
  if ((ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      ts.isIdentifier(node.expression) && node.expression.text === 'RegExp') return 'dynamic_regex';
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isElementAccessExpression(callee)) return 'computed_call';
    if (ts.isPropertyAccessExpression(callee) && methods.has(callee.name.text)) return 'text_or_membership_operation';
  }
  if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.LessThanToken,
    ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanEqualsToken].includes(node.operatorToken.kind) &&
    (textLiteral(node.left) || textLiteral(node.right))) return 'literal_comparison';
  if (ts.isArrayLiteralExpression(node) && node.elements.some(textLiteral)) return 'literal_vocabulary';
  if (ts.isElementAccessExpression(node)) return 'indexed_lookup';
  if (ts.isCaseClause(node) && textLiteral(node.expression)) return 'literal_case';
  return undefined;
}

// Conservatively inventories syntax requiring review; it does not claim to infer
// English meaning or prove semantic correctness. A candidate is not a violation
// until unmatched by an exact, independently reviewed legitimate-use entry.
export function scanSource(file, text) {
  return scanSources(new Map([[file, text]]));
}

/** Resolve actual local symbols/import aliases to bind lexical predicates to
 * their consumers. Ordinary branches are not independently language candidates.
 * Consumer closure adds a reviewed declaration only when it depends on one. */
export function scanSources(texts) {
  const sources = new Map();
  const names = new Map();
  for (const [file, text] of texts) {
    const absolute = resolve('/', file);
    const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true,
      /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    if (source.parseDiagnostics.length) throw new Error(`Cannot scan malformed product source: ${file}`);
    sources.set(absolute, source); names.set(absolute, file);
  }
  const options = { noLib: true, allowJs: true, target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
  const resolveModule = (specifier, containing) => {
    const base = specifier.startsWith('.') ? resolve(dirname(containing), specifier)
      : /^@synapsor(?:-runner)?\//.test(specifier)
        ? resolve('/packages', specifier.split('/')[1], 'src/index') : undefined;
    if (!base) return undefined;
    const stem = base.replace(/\.[cm]?js$/, '');
    const found = [base, stem + '.ts', stem + '.mts', stem + '.js', stem + '.mjs', resolve(base, 'index.ts')]
      .find(path => sources.has(path));
    return found ? { resolvedFileName: found, extension: /\.[cm]?js$/.test(found) ? ts.Extension.Js : ts.Extension.Ts } : undefined;
  };
  const host = {
    getSourceFile: name => sources.get(name), getDefaultLibFileName: () => '',
    writeFile: () => {}, getCurrentDirectory: () => '/', getDirectories: () => [],
    fileExists: name => sources.has(name), readFile: name => sources.get(name)?.text,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n', resolveModuleNames: (modules, containing) => modules.map(name => resolveModule(name, containing)),
  };
  const checker = ts.createProgram([...sources.keys()], options, host).getTypeChecker();
  const outer = node => {
    let current = node;
    while (current.parent && !ts.isSourceFile(current.parent)) current = current.parent;
    return ts.isSourceFile(current) ? undefined : current;
  };
  const printed = new WeakMap();
  const render = node => {
    if (!printed.has(node)) printed.set(node, print(node, node.getSourceFile()));
    return printed.get(node);
  };
  const ownerHashes = new WeakMap();
  const candidates = [], duplicates = new Map(), lexicalOwners = new Set(), consumers = new Map(), lookupOwners = new Set();
  const add = (node, kind) => {
    const source = node.getSourceFile(), file = names.get(source.fileName), owner = outer(node) ?? node;
    const expression = render(node);
    if (!ownerHashes.has(owner)) ownerHashes.set(owner, sha(render(owner)));
    const ownerDigest = ownerHashes.get(owner);
    const base = JSON.stringify([file, kind, ownerDigest, expression]);
    const occurrence = duplicates.get(base) ?? 0;
    duplicates.set(base, occurrence + 1);
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    candidates.push({ fingerprint: sha(`${base}:${occurrence}`), file,
      line: position.line + 1, column: position.character + 1, kind,
      owner_digest: ownerDigest, expression_digest: sha(expression), excerpt: expression.slice(0, 200), occurrence });
  };
  for (const source of sources.values()) {
    function visit(node) {
      const owner = outer(node);
      let kind = kindOf(node);
      if (kind === 'indexed_lookup') {
        // Numeric array positions are not word vocabularies. A free-text or
        // unknown lookup is reviewed with its actual dictionary declaration.
        const indexType = checker.getTypeAtLocation(node.argumentExpression);
        if (indexType.flags & ts.TypeFlags.NumberLike) kind = undefined;
        else {
          let target = checker.getSymbolAtLocation(node.expression);
          if (target && target.flags & ts.SymbolFlags.Alias) target = checker.getAliasedSymbol(target);
          for (const declaration of target?.declarations ?? []) {
            if (!names.has(declaration.getSourceFile().fileName)) continue;
            const dictionary = outer(declaration);
            if (dictionary) lookupOwners.add(dictionary);
          }
        }
      }
      if (kind === 'text_or_membership_operation' && ts.isPropertyAccessExpression(node.expression)) {
        // A collection/regex receiver is part of the interpreted vocabulary,
        // including mutations performed in a separate declaration.
        const collectReceiver = expression => {
          let symbol = checker.getSymbolAtLocation(expression);
          if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
          for (const declaration of symbol?.declarations ?? []) {
            if (!names.has(declaration.getSourceFile().fileName)) continue;
            const receiver = outer(declaration);
            if (receiver) lookupOwners.add(receiver);
          }
          ts.forEachChild(expression, collectReceiver);
        };
        collectReceiver(node.expression.expression);
      }
      if (kind) { add(node, kind); lexicalOwners.add(owner); }
      if (owner && ts.isIdentifier(node)) {
        let symbol = checker.getSymbolAtLocation(node);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        for (const declaration of symbol?.declarations ?? []) {
          if (!names.has(declaration.getSourceFile().fileName)) continue;
          const target = outer(declaration);
          if (target && target !== owner) {
            if (!consumers.has(target)) consumers.set(target, new Set());
            consumers.get(target).add(owner);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  for (const owner of lookupOwners) { add(owner, 'lookup_vocabulary'); lexicalOwners.add(owner); }
  const queue = [...lexicalOwners].filter(Boolean), reached = new Set(queue), dependent = new Set();
  for (let index = 0; index < queue.length; index++) {
    for (const consumer of consumers.get(queue[index]) ?? []) {
      dependent.add(consumer);
      if (!reached.has(consumer)) { reached.add(consumer); queue.push(consumer); }
    }
  }
  for (const owner of dependent) add(owner, 'predicate_consumer');
  return candidates;
}

export function evaluate(candidates, allowlist) {
  const errors = [];
  const entries = new Map();
  if (allowlist.version !== 1 || !Array.isArray(allowlist.entries)) throw new Error('Invalid language guard allowlist');
  for (const entry of allowlist.entries) {
    if (!/^[0-9a-f]{64}$/.test(entry.fingerprint ?? '') || !legitimateUses.has(entry.category) ||
        !entry.reason?.trim() || !entry.review?.reviewer?.trim() || !entry.review?.evidence?.trim() ||
        entry.review?.verdict !== 'accepted' || !entry.file || !entry.annotation_id) {
      errors.push({ kind: 'invalid_allowance', entry }); continue;
    }
    if (entries.has(entry.fingerprint)) errors.push({ kind: 'duplicate_allowance', fingerprint: entry.fingerprint });
    entries.set(entry.fingerprint, entry);
  }
  const current = new Set();
  for (const candidate of candidates) {
    current.add(candidate.fingerprint);
    const entry = entries.get(candidate.fingerprint);
    if (!entry || entry.file !== candidate.file) errors.push({ ...candidate, syntax_kind: candidate.kind, kind: 'unreviewed_candidate' });
  }
  for (const entry of entries.values()) if (!current.has(entry.fingerprint)) errors.push({ kind: 'stale_allowance', ...entry });
  return { candidates: candidates.length, reviewed: entries.size, errors };
}

export async function scanRepository(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'test-fixtures', '__tests__', '__fixtures__', 'fixtures'].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      // Symlinks cannot introduce an unexamined source tree.
      if (entry.isSymbolicLink()) throw new Error(`Unexpected source symlink: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec|d)\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
    }
  }
  await walk(resolve(root, 'apps/runner/src'));
  for (const entry of await readdir(resolve(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = resolve(root, 'packages', entry.name, 'src');
    try { await walk(src); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const texts = new Map();
  for (const path of files.sort()) texts.set(relative(root, path).replaceAll('\\', '/'), await readFile(path, 'utf8'));
  return { files: files.length, candidates: scanSources(texts) };
}
