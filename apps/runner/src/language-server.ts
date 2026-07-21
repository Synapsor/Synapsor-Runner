import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CompletionItemKind,
  createConnection,
  DiagnosticSeverity,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  type CompletionItem,
  type Diagnostic,
  type Hover,
  type InitializeResult,
  type TextEdit,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { formatAgentDsl, validateAgentDsl } from "@synapsor/dsl";
import { normalizeContract } from "@synapsor/spec";
import { parseSafeActionSource, validateSafeActionCapability, type SafeActionDiagnostic } from "./safe-action.js";

type HoverEntry = { title: string; detail: string; reference: string };

const clauseDocs: Record<string, HoverEntry> = {
  "CREATE AGENT CONTEXT": { title: "CREATE AGENT CONTEXT", detail: "Declares trusted bindings used for tenant and principal authority. Models cannot set these bindings.", reference: "docs/dsl-reference.md#agent-contexts" },
  "CREATE CAPABILITY": { title: "CREATE CAPABILITY", detail: "Declares one reviewed semantic tool. The model sees only the compiled capability surface.", reference: "docs/dsl-reference.md#capabilities" },
  "CREATE WORKFLOW": { title: "CREATE WORKFLOW", detail: "Declares a portable workflow contract. Local Runner does not execute full workflow DAG semantics.", reference: "docs/dsl-reference.md#workflows" },
  "TENANT BINDING": { title: "TENANT BINDING", detail: "Selects the trusted context binding used to enforce tenant scope. It is never a model argument.", reference: "docs/security-boundary.md" },
  "PRINCIPAL BINDING": { title: "PRINCIPAL BINDING", detail: "Selects the trusted principal identity binding for audit and authorization.", reference: "docs/security-boundary.md" },
  "ALLOW READ": { title: "ALLOW READ", detail: "Allowlist of columns that may appear in model-facing results and evidence. Review it manually; schema inspection is heuristic.", reference: "docs/capability-authoring.md" },
  "ARG": { title: "ARG", detail: "Declares a model-facing argument. ENUM values are typed, finite, and enforced by every Runner transport; tenant and principal bindings never belong here.", reference: "docs/dsl-reference.md#arguments" },
  "AGGREGATE READ": { title: "AGGREGATE READ", detail: "Returns one reviewed COUNT, SUM, or AVG scalar. The table, column, tenant scope, and optional equality selection stay contract-fixed; member rows are never returned.", reference: "docs/aggregate-reads.md" },
  "MIN GROUP SIZE": { title: "MIN GROUP SIZE", detail: "Suppresses aggregate output when fewer than the reviewed number of source rows match, reducing single-record inference.", reference: "docs/aggregate-reads.md" },
  "KEEP OUT": { title: "KEEP OUT", detail: "Explicitly records columns that must never appear in model-facing output or evidence.", reference: "docs/security-boundary.md" },
  "REQUIRE EVIDENCE": { title: "REQUIRE EVIDENCE", detail: "Requires an evidence handle and query-audit record for the capability result.", reference: "docs/capability-authoring.md" },
  "PROPOSE ACTION": { title: "PROPOSE ACTION", detail: "Creates a saved proposal. It does not grant the model approval, apply, or commit authority.", reference: "docs/guarded-crud-writeback.md" },
  "SELECT WHERE": { title: "SELECT WHERE", detail: "Reviewer-fixed literal equality terms joined by AND. OR, ranges, free-form SQL, and model-controlled predicates are rejected.", reference: "docs/bounded-set-writeback.md" },
  "MAX ROWS": { title: "MAX ROWS", detail: "Hard reviewed row ceiling. Overflow fails closed; Runner never truncates into a partial write.", reference: "docs/bounded-set-writeback.md" },
  "MAX TOTAL": { title: "MAX TOTAL", detail: "Reviewed aggregate value bound for a bounded-set write.", reference: "docs/bounded-set-writeback.md" },
  "ALLOW WRITE": { title: "ALLOW WRITE", detail: "Allowlist of columns that a proposal may change. It is not model-selected.", reference: "docs/guarded-crud-writeback.md" },
  "APPROVAL ROLE": { title: "APPROVAL ROLE", detail: "Requires approval from a reviewed operator role outside the model-facing MCP surface.", reference: "docs/release-policy.md" },
  "WRITEBACK": { title: "WRITEBACK", detail: "Selects reviewed direct SQL, app-handler, cloud-worker, or no-writeback execution after approval.", reference: "docs/writeback-executors.md" },
  "AUTO APPROVE WHEN": { title: "AUTO APPROVE WHEN", detail: "Allows policy approval only within reviewed limits. It never gives the model commit authority.", reference: "docs/release-policy.md" },
  "REVERSIBLE": { title: "REVERSIBLE", detail: "Requires reviewed inverse compensation. A revert creates a new proposal and never silently rolls back.", reference: "docs/reversible-change-sets.md" },
};

const topLevelCompletions = ["CREATE AGENT CONTEXT", "CREATE CAPABILITY", "CREATE WORKFLOW"];
const contextCompletions = ["DESCRIPTION", "BIND", "TENANT BINDING", "PRINCIPAL BINDING", "END"];
const readCapabilityCompletions = [
  "DESCRIPTION", "RETURNS HINT", "USING CONTEXT", "SOURCE", "ON", "PRIMARY KEY", "TENANT KEY", "CONFLICT GUARD",
  "LOOKUP", "ARG", "ALLOW READ", "KEEP OUT", "REQUIRE EVIDENCE", "PROPOSE ACTION", "AGGREGATE READ", "END",
];
const proposalCapabilityCompletions = [
  "DESCRIPTION", "RETURNS HINT", "USING CONTEXT", "SOURCE", "ON", "PRIMARY KEY", "TENANT KEY", "CONFLICT GUARD",
  "LOOKUP", "ARG", "ALLOW READ", "KEEP OUT", "REQUIRE EVIDENCE", "PROPOSE ACTION", "SELECT WHERE", "MAX ROWS",
  "MAX TOTAL", "ALLOW WRITE", "PATCH", "BOUND", "TRANSITION", "ADVANCE VERSION", "APPROVAL ROLE", "REQUIRE APPROVALS",
  "AUTO APPROVE WHEN", "LIMIT", "REVERSIBLE", "WRITEBACK", "END",
];
const aggregateCapabilityCompletions = [
  "DESCRIPTION", "RETURNS HINT", "USING CONTEXT", "SOURCE", "ON", "PRIMARY KEY", "TENANT KEY",
  "AGGREGATE READ", "SELECT WHERE", "MIN GROUP SIZE", "REQUIRE EVIDENCE", "END",
];
const workflowCompletions = ["DESCRIPTION", "USING CONTEXT", "ALLOW CAPABILITY", "REQUIRE EVIDENCE", "APPROVAL ROLE", "REPLAY CHECKPOINT", "END"];

export function lspDiagnosticsForSource(source: string): Diagnostic[] {
  const result = validateAgentDsl(source);
  return [
    ...result.errors.map((issue) => diagnosticForIssue(source, issue, DiagnosticSeverity.Error)),
    ...result.warnings.map((issue) => diagnosticForIssue(source, issue, DiagnosticSeverity.Warning)),
  ].sort((left, right) => left.range.start.line - right.range.start.line || left.range.start.character - right.range.start.character || String(left.code).localeCompare(String(right.code)));
}

export async function lspDiagnosticsForDocument(uri: string, source: string): Promise<Diagnostic[]> {
  const filePath = localFilePath(uri);
  if (!filePath || !isSafeActionPath(filePath)) return lspDiagnosticsForSource(source);
  try {
    const capability = parseSafeActionSource(source, filePath);
    const projectRoot = path.resolve(path.dirname(filePath), "../..");
    const configPath = path.join(projectRoot, "synapsor.runner.json");
    const config = await readRegularJson(configPath, "Runner config");
    if (!Array.isArray(config.contracts) || config.contracts.length !== 1 || typeof config.contracts[0] !== "string") {
      return [safeActionProjectDiagnostic(source, "SAFE_ACTION_SINGLE_CONTRACT_REQUIRED", "Safe Action editor validation requires exactly one canonical contract reference in synapsor.runner.json.")];
    }
    const contractPath = path.resolve(path.dirname(configPath), config.contracts[0]);
    if (!isInside(projectRoot, contractPath)) return [safeActionProjectDiagnostic(source, "SAFE_ACTION_CONTRACT_OUTSIDE_PROJECT", "The active canonical contract must stay inside the project for Safe Action editor validation.")];
    const contract = normalizeContract(await readRegularJson(contractPath, "canonical contract"));
    return validateSafeActionCapability(capability, contract, config).map((diagnostic) => diagnosticForSafeAction(source, diagnostic));
  } catch (error) {
    return [diagnosticForSafeActionError(source, error)];
  }
}

export function lspCompletionsForSource(source: string, line: number): CompletionItem[] {
  const block = blockAtLine(source, line);
  const keywords = block === "context" ? contextCompletions
    : block === "capability" ? capabilityCompletionsForSource(source, line)
      : block === "workflow" ? workflowCompletions
        : topLevelCompletions;
  return keywords.map((label) => ({
    label,
    kind: CompletionItemKind.Keyword,
    detail: clauseDocs[label]?.detail ?? "Synapsor contract clause",
    documentation: clauseDocs[label] ? `${clauseDocs[label].detail}\n\n${clauseDocs[label].reference}` : undefined,
    insertText: label,
  }));
}

function capabilityCompletionsForSource(source: string, line: number): string[] {
  const lines = source.split(/\r?\n/).slice(0, line + 1);
  let start = lines.length - 1;
  while (start >= 0 && !/^\s*CREATE\s+CAPABILITY\b/i.test(lines[start] ?? "")) start -= 1;
  const block = lines.slice(Math.max(0, start)).join("\n");
  if (/^\s*AGGREGATE\s+READ\b/im.test(block)) return aggregateCapabilityCompletions;
  if (/^\s*PROPOSE\s+ACTION\b/im.test(block)) return proposalCapabilityCompletions;
  return readCapabilityCompletions;
}

export function lspHoverForSource(source: string, line: number, character: number): Hover | null {
  const text = source.split(/\r?\n/)[line] ?? "";
  const prefix = text.slice(0, Math.max(character + 1, text.length)).trim().toUpperCase();
  const entry = Object.entries(clauseDocs)
    .sort(([left], [right]) => right.length - left.length)
    .find(([clause]) => prefix.startsWith(clause) || text.toUpperCase().includes(clause))?.[1];
  if (!entry) return null;
  return { contents: { kind: "markdown", value: `**${entry.title}**\n\n${entry.detail}\n\nReference: \`${entry.reference}\`` } };
}

export function lspFormatEdits(source: string): TextEdit[] {
  const formatted = formatAgentDsl(source);
  if (formatted === source) return [];
  const lines = source.split(/\r?\n/);
  return [{
    range: {
      start: { line: 0, character: 0 },
      end: { line: Math.max(0, lines.length - 1), character: lines.at(-1)?.length ?? 0 },
    },
    newText: formatted,
  }];
}

export async function runLanguageServer(): Promise<number> {
  const connection = createConnection(ProposedFeatures.all);
  const documents = new TextDocuments(TextDocument);
  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { resolveProvider: false },
      hoverProvider: true,
      documentFormattingProvider: true,
    },
    serverInfo: { name: "Synapsor Contract Language Server" },
  };

  connection.onInitialize(() => result);
  const publish = async (document: TextDocument): Promise<void> => {
    connection.sendDiagnostics({ uri: document.uri, diagnostics: await lspDiagnosticsForDocument(document.uri, document.getText()) });
  };
  documents.onDidOpen((event) => { void publish(event.document); });
  documents.onDidChangeContent((event) => { void publish(event.document); });
  documents.onDidClose((event) => connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] }));
  connection.onCompletion((params) => {
    const document = documents.get(params.textDocument.uri);
    return document && !isSafeActionUri(document.uri) ? lspCompletionsForSource(document.getText(), params.position.line) : [];
  });
  connection.onHover((params) => {
    const document = documents.get(params.textDocument.uri);
    return document && !isSafeActionUri(document.uri) ? lspHoverForSource(document.getText(), params.position.line, params.position.character) : null;
  });
  connection.onDocumentFormatting((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];
    if (isSafeActionUri(document.uri)) return [];
    try {
      return lspFormatEdits(document.getText());
    } catch {
      return [];
    }
  });
  documents.listen(connection);
  connection.listen();
  return await new Promise<number>((resolve) => connection.onExit(() => resolve(0)));
}

function diagnosticForSafeAction(source: string, issue: SafeActionDiagnostic): Diagnostic {
  const location = safeActionPathLocation(source, issue.path);
  return {
    range: { start: location, end: { line: location.line, character: location.character + 1 } },
    severity: issue.severity === "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
    code: issue.code,
    source: "synapsor-safe-action",
    message: issue.message,
  };
}

function diagnosticForSafeActionError(source: string, error: unknown): Diagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const parenthesized = message.match(/\((\d+),(\d+)\):\s*([A-Z][A-Z0-9_]+):\s*([^\n]+)/);
  const colonLocation = message.match(/\b([A-Z][A-Z0-9_]+)\b\s+[^\n]*?:(\d+):(\d+):\s*([^\n]+)/);
  const simple = message.match(/\b([A-Z][A-Z0-9_]+)\b:\s*([^\n]+)/);
  const line = Math.max(0, Number(parenthesized?.[1] ?? colonLocation?.[2] ?? 1) - 1);
  const character = Math.max(0, Number(parenthesized?.[2] ?? colonLocation?.[3] ?? 1) - 1);
  const sourceLine = source.split(/\r?\n/)[line] ?? "";
  return {
    range: { start: { line, character: Math.min(character, sourceLine.length) }, end: { line, character: Math.min(Math.max(character + 1, 1), sourceLine.length || 1) } },
    severity: DiagnosticSeverity.Error,
    code: parenthesized?.[3] ?? colonLocation?.[1] ?? simple?.[1] ?? "SAFE_ACTION_EDITOR_VALIDATION_FAILED",
    source: "synapsor-safe-action",
    message: parenthesized?.[4] ?? colonLocation?.[4] ?? simple?.[2] ?? "Safe Action editor validation failed closed. Run action validate for complete diagnostics.",
  };
}

function safeActionProjectDiagnostic(source: string, code: string, message: string): Diagnostic {
  return diagnosticForSafeAction(source, { severity: "error", code, message });
}

function safeActionPathLocation(source: string, issuePath?: string): { line: number; character: number } {
  const segment = issuePath?.split(".").filter(Boolean).at(-1);
  if (!segment) return { line: 0, character: 0 };
  const lines = source.split(/\r?\n/);
  for (const [line, text] of lines.entries()) {
    const character = text.indexOf(segment);
    if (character >= 0) return { line, character };
  }
  return { line: 0, character: 0 };
}

async function readRegularJson(filePath: string, label: string): Promise<Record<string, unknown>> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`SAFE_ACTION_PROJECT_FILE_INVALID: ${label} must be a regular non-symlink file.`);
  const value: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`SAFE_ACTION_PROJECT_FILE_INVALID: ${label} must contain a JSON object.`);
  return value as Record<string, unknown>;
}

function localFilePath(uri: string): string | undefined {
  try {
    return uri.startsWith("file:") ? fileURLToPath(uri) : undefined;
  } catch {
    return undefined;
  }
}

function isSafeActionUri(uri: string): boolean {
  const filePath = localFilePath(uri);
  return Boolean(filePath && isSafeActionPath(filePath));
}

function isSafeActionPath(filePath: string): boolean {
  const normalized = filePath.split(path.sep).join("/");
  return normalized.endsWith(".ts") && normalized.includes("/synapsor/actions/");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function diagnosticForIssue(
  source: string,
  issue: { line: number; column: number; code: string; message: string },
  severity: DiagnosticSeverity,
): Diagnostic {
  const lines = source.split(/\r?\n/);
  const line = Math.max(0, Math.min(lines.length - 1, issue.line - 1));
  const start = Math.max(0, Math.min(lines[line]?.length ?? 0, issue.column - 1));
  return {
    range: { start: { line, character: start }, end: { line, character: Math.min(lines[line]?.length ?? start + 1, start + 1) } },
    severity,
    code: issue.code,
    source: "synapsor",
    message: issue.message,
  };
}

function blockAtLine(source: string, targetLine: number): "context" | "capability" | "workflow" | undefined {
  let current: "context" | "capability" | "workflow" | undefined;
  for (const [line, text] of source.split(/\r?\n/).entries()) {
    if (line > targetLine) break;
    if (/^\s*CREATE\s+AGENT\s+CONTEXT\b/i.test(text)) current = "context";
    else if (/^\s*CREATE\s+CAPABILITY\b/i.test(text)) current = "capability";
    else if (/^\s*CREATE\s+WORKFLOW\b/i.test(text)) current = "workflow";
    else if (/^\s*END\s*$/i.test(text)) current = undefined;
  }
  return current;
}
