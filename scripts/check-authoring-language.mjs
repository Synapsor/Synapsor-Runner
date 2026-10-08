#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, scanRepository } from './authoring-language-guard/scan.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--report')) throw new Error('Usage: node scripts/check-authoring-language.mjs [--report path]');
const { files, candidates } = await scanRepository(root);
const allowlist = JSON.parse(await readFile(resolve(root, 'scripts/authoring-language-guard/allowlist.json'), 'utf8'));
const result = { files, ...evaluate(candidates, allowlist) };
if (args[1]) await writeFile(resolve(args[1]), JSON.stringify(result, null, 2) + '\n');
console.log(`Authoring language guard: ${files} files; ${result.candidates} syntactic candidates; ${result.reviewed} reviewed entries; ${result.errors.length} unresolved.`);
for (const error of result.errors.slice(0, 20)) console.error(`${error.kind}: ${error.file ?? ''}:${error.line ?? ''} ${error.kind === 'unreviewed_candidate' ? error.excerpt : error.fingerprint ?? ''}`);
if (result.errors.length) process.exitCode = 1;
