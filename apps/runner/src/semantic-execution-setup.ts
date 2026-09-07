import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SupervisedWriterPostureAssessment } from "./worker-policy.js";
import { redactCliErrorMessage } from "./cli-logging.js";

export type ExecutionSetupProblem = { code: string; summary: string; details: string[] };

const safeDiagnosticLine = (line: string) => redactCliErrorMessage(line)
  .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/gu, " ");
const safeProblem = (problem: ExecutionSetupProblem): ExecutionSetupProblem => ({
  code: safeDiagnosticLine(problem.code), summary: safeDiagnosticLine(problem.summary),
  details: problem.details.map(safeDiagnosticLine),
});

export class SemanticWriterPostureError extends Error {
  readonly code = "SEMANTIC_ACTION_WRITER_POSTURE_INVALID";
  readonly problem: ExecutionSetupProblem;
  constructor(assessment: SupervisedWriterPostureAssessment, writerEnv: string) {
    const missing = assessment.relation_issues?.filter((issue) => issue.issue === "missing") ?? [];
    const extra = assessment.relation_issues?.filter((issue) => issue.issue !== "missing") ?? [];
    const summary = `The configured writer does not match this action: ${missing.length && extra.length ? "missing and extra access detected"
      : missing.length ? "required access is missing" : extra.length ? "extra access detected" : "role safety checks failed"}. Automatic updates remain off.`;
    super(`SEMANTIC_ACTION_WRITER_POSTURE_INVALID: ${summary}`);
    this.problem = { code: this.code, summary, details: [
      `Code: ${this.code}`, `Checked connection: ${writerEnv} (value hidden)`,
      `Checks: ${assessment.reasons.join(", ")}`, "", "MISSING ACCESS",
      ...(missing.length ? missing.map((issue) => `${issue.relation}: ${issue.privileges.join("; ")}`) : ["None detected."]),
      "", "EXTRA ACCESS",
      ...(extra.length ? extra.map((issue) => `${issue.relation}: ${issue.privileges.join("; ")}`) : ["None detected."]),
      "", "EXACT ADMINISTRATOR HANDOFF",
      "Use a dedicated, non-owner, non-superuser writer without RLS bypass. Do not revoke a shared role's access needed by other workflows.",
      ...(assessment.required_relations ?? []).flatMap((item) => [
        item.relation,
        `  Required: ${item.privileges.map((privilege) => privilege === "update" && item.update_columns.length
          ? `UPDATE (${item.update_columns.join(", ")})` : privilege.toUpperCase()).join("; ")}`,
        ...(item.lock_column ? [`  Private row locking: ${item.update_columns.length ? "the required UPDATE columns above suffice" : `UPDATE (${item.lock_column}) is required`}; an applicable permissive UPDATE/ALL policy is also needed when RLS is enabled.`] : []),
        ...(item.rls_required ? ["  Preserve the reviewed authenticated tenant/principal RLS; do not replace it with unrestricted access."] : []),
      ]),
      "Receipt and event tables are required only if listed above by the selected completion path. Runner-ledger receipts do not require a source receipt table.",
      "An administrator must review and provision this role. Runner does not execute grants, revoke privileges, or change RLS.",
      "Then select the configured connection and recheck. Enabling execution remains a separate confirmation; no request has executed.",
    ].map(safeDiagnosticLine) };
  }
}

export function executionSetupProblem(error: unknown): ExecutionSetupProblem {
  if (error instanceof SemanticWriterPostureError) return error.problem;
  const message = redactCliErrorMessage(error instanceof Error ? error.message : String(error));
  const code = message.match(/^([A-Z][A-Z0-9_]{2,79}):/u)?.[1] ?? "EXECUTION_SETUP_CHECK_FAILED";
  const summary = code === "SEMANTIC_ACTION_WRITER_URL_MISSING"
    ? "The separate write connection is not configured. Set its environment variable, then recheck."
    : code === "SEMANTIC_ACTION_WRITER_POSTURE_INVALID"
      ? "The configured writer failed its permission checks. Inspect the saved requirements before rechecking."
      : `Execution verification could not finish (${code}). Inspect the diagnostic before retrying.`;
  return safeProblem({ code, summary, details: [`Code: ${code}`, ...message.split(/\r?\n/u), "Read and proposal authority are unchanged. Automatic updates remain off."] });
}

const savedSchema = z.object({ version: z.literal(1), action_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  outcome: z.string().max(256), paused_at: z.string().datetime(),
  problem: z.object({ code: z.string().max(80), summary: z.string().max(2000), details: z.array(z.string().max(20000)).max(10000) }).strict(),
}).strict();
export type SavedExecutionSetup = z.infer<typeof savedSchema>;
const savedPath = (root: string) => path.join(root, ".synapsor", "execution-setup-paused.json");

/** Diagnostic checkpoint only: never read by approval or execution authorization. */
export async function savePausedExecutionSetup(root: string, value: Omit<SavedExecutionSetup, "version" | "paused_at">): Promise<void> {
  const record = savedSchema.parse({ ...value, problem: safeProblem(value.problem), version: 1, paused_at: new Date().toISOString() });
  const serialized = JSON.stringify(record, null, 2);
  if (Buffer.byteLength(serialized) > 2_000_000) throw new Error("EXECUTION_SETUP_RECORD_TOO_LARGE");
  const target = savedPath(root), temporary = `${target}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try { await fs.writeFile(temporary, serialized, { mode: 0o600, flag: "wx" }); await fs.rename(temporary, target); }
  finally { await fs.rm(temporary, { force: true }); }
}
export async function readPausedExecutionSetup(root: string, actionDigest: string): Promise<SavedExecutionSetup | undefined> {
  try {
    const handle = await fs.open(savedPath(root), "r");
    let file: string;
    try {
      const buffer = Buffer.alloc(2_000_001);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > 2_000_000) throw new Error("EXECUTION_SETUP_RECORD_TOO_LARGE");
      file = buffer.subarray(0, size).toString("utf8");
    } finally { await handle.close(); }
    const record = savedSchema.parse(JSON.parse(file));
    return record.action_digest === actionDigest ? { ...record, problem: safeProblem(record.problem) } : undefined;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export async function clearPausedExecutionSetup(root: string, actionDigest: string, outcome: string): Promise<void> {
  const saved = await readPausedExecutionSetup(root, actionDigest);
  if (saved?.outcome === outcome) await fs.rm(savedPath(root), { force: true });
}
