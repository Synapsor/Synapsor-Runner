import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import ts from 'typescript';

export const legitimateUses = new Set([
  'redaction_secret_detection', 'exact_identifier_or_code', 'formal_grammar',
  'explicit_command', 'display_formatting',
]);
const methods = new Set(['test', 'exec', 'match', 'matchAll', 'search', 'includes',
  'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'split', 'replace', 'replaceAll',
  'toLowerCase', 'toUpperCase', 'toLocaleLowerCase', 'toLocaleUpperCase', 'normalize',
  'trim', 'trimStart', 'trimEnd', 'has', 'get', 'localeCompare']);
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
  if (ts.isObjectLiteralExpression(node) && node.properties.some(p => p.name && ts.isStringLiteralLike(p.name))) return 'literal_dictionary';
  if (ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isSwitchStatement(node) ||
      ts.isWhileStatement(node) || ts.isDoStatement(node)) return 'decision_binding';
  if (ts.isCaseClause(node) && textLiteral(node.expression)) return 'literal_case';
  return undefined;
}

// Conservatively inventories syntax requiring review; it does not claim to infer
// English meaning or prove semantic correctness. A candidate is not a violation
// until unmatched by an exact, independently reviewed legitimate-use entry.
export function scanSource(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  if (source.parseDiagnostics.length) throw new Error(`Cannot scan malformed product source: ${file}`);
  const candidates = [];
  const duplicates = new Map();
  const ownerHashes = new WeakMap();
  const printed = new WeakMap();
  const render = node => {
    if (!printed.has(node)) printed.set(node, print(node, source));
    return printed.get(node);
  };
  function visit(node, owner) {
    // Bind the full outer function/declaration, not merely a reusable regex.
    // Changing what an existing predicate controls invalidates its review.
    if (!owner && !ts.isSourceFile(node) && (ts.isStatement(node) || ts.isVariableDeclaration(node))) owner = node;
    const kind = kindOf(node);
    if (kind) {
      const expression = render(node);
      const boundOwner = owner ?? node;
      if (!ownerHashes.has(boundOwner)) ownerHashes.set(boundOwner, sha(render(boundOwner)));
      const ownerDigest = ownerHashes.get(boundOwner);
      const base = JSON.stringify([file, kind, ownerDigest, expression]);
      const occurrence = duplicates.get(base) ?? 0;
      duplicates.set(base, occurrence + 1);
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      candidates.push({ fingerprint: sha(`${base}:${occurrence}`), file,
        line: position.line + 1, column: position.character + 1, kind,
        owner_digest: ownerDigest, expression_digest: sha(expression),
        excerpt: expression.slice(0, 200), occurrence });
    }
    ts.forEachChild(node, child => visit(child, owner));
  }
  visit(source, undefined);
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
  const candidates = [];
  for (const path of files.sort()) candidates.push(...scanSource(relative(root, path).replaceAll('\\', '/'), await readFile(path, 'utf8')));
  return { files: files.length, candidates };
}
