import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AskError, type AskProviderDependencies } from "./model-ask.js";
import { redactCliErrorMessage } from "./cli-logging.js";
import { PLANNING_FIELDS, planningFieldShape } from "./boundary-job-operation-contract.js";

export type PlanningAttemptDiagnostic = {
  attempt: number; phase: "initial" | "correction";
  category: "accepted" | "contract_validation" | "tool_selection" | "response_parse" | "incomplete_response" | "provider_request";
  code: string; message: string;
  response?: { http_status: number; status: string; stop_reason: string; incomplete_reason: string;
    tool_calls: number; expected_tool_calls: number; argument_bytes: number; field_names: string[]; field_shapes?: string[] };
};
export type BoundaryJobPlanningDiagnostic = {
  version: 1; expected_tool: "runner.plan_boundary_job"; context_digest: string; source_digest?: string;
  attempts: PlanningAttemptDiagnostic[]; model_requests: number; duration_ms: number;
  authority_changed: false; source_database_changed: false;
};

export class BoundaryJobPlanningError extends Error {
  constructor(public readonly diagnostic: BoundaryJobPlanningDiagnostic) {
    super(`BOUNDARY_JOB_PLAN_INVALID: ${diagnostic.attempts.at(-1)?.message ?? "No valid plan was submitted."}`);
    this.name = "BoundaryJobPlanningError";
  }
}

const fields = new Set<string>(PLANNING_FIELDS);
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const known = (value: unknown, options: string[]) => typeof value === "string" && options.includes(value) ? value : "unavailable_or_other";

/** Structural metadata only: never retain argument values, raw messages,
 * arbitrary tool names, headers, URLs or provider error bodies. */
export function planningResponseDiagnostic(response: Awaited<ReturnType<NonNullable<AskProviderDependencies["requestJson"]>>>): NonNullable<PlanningAttemptDiagnostic["response"]> {
  const body = response.body;
  const choice = object(Array.isArray(body.choices) ? body.choices[0] : undefined);
  const chat = object(choice.message);
  const calls = [
    ...(Array.isArray(body.output) ? body.output.filter((entry) => object(entry).type === "function_call").map(object) : []),
    ...(Array.isArray(body.content) ? body.content.filter((entry) => object(entry).type === "tool_use").map(object) : []),
    ...(Array.isArray(chat.tool_calls) ? chat.tool_calls.map((entry) => object(object(entry).function)) : []),
  ];
  const keys = new Set<string>();
  const shapes = new Set<string>();
  let argumentBytes = 0;
  for (const call of calls.slice(0, 16)) {
    const args = call.arguments ?? call.input;
    argumentBytes += Buffer.byteLength(typeof args === "string" ? args : JSON.stringify(args ?? null));
    let parsed = args;
    if (typeof args === "string") { try { parsed = JSON.parse(args); } catch { parsed = undefined; } }
    for (const [key, value] of Object.entries(object(parsed))) {
      keys.add(fields.has(key) ? key : "<unexpected-key>");
      shapes.add(planningFieldShape(key, value));
    }
  }
  return { http_status: response.status, status: known(body.status, ["completed", "incomplete", "failed", "cancelled"]),
    stop_reason: known(body.stop_reason ?? choice.finish_reason, ["tool_use", "end_turn", "max_tokens", "length", "stop", "tool_calls", "refusal", "content_filter"]),
    incomplete_reason: known(object(body.incomplete_details).reason, ["max_output_tokens", "content_filter"]),
    tool_calls: calls.length, expected_tool_calls: calls.filter((call) => call.name === "runner__plan_boundary_job").length,
    argument_bytes: argumentBytes, field_names: [...keys].sort(), field_shapes: [...shapes].sort().slice(0, 24) };
}

export function planningErrorDiagnostic(error: unknown): Pick<PlanningAttemptDiagnostic, "category" | "code" | "message"> {
  if (error instanceof AskError) {
    return { category: error.code === "ASK_REQUIRED_TOOL_NOT_CALLED" ? "tool_selection"
      : error.code === "ASK_PROVIDER_RESPONSE_INCOMPLETE" ? "incomplete_response"
      : ["ASK_PROVIDER_RESPONSE_INVALID", "ASK_TOOL_ARGUMENTS_INVALID"].includes(error.code) ? "response_parse" : "provider_request",
      code: error.code, message: redactCliErrorMessage(error.message).slice(0, 700) };
  }
  return { category: "contract_validation", code: "PLANNING_CONTRACT_INVALID",
    message: redactCliErrorMessage(error instanceof Error ? error.message : "Invalid planning contract.").slice(0, 700) };
}

export function planningDiagnosticLines(diagnostic: BoundaryJobPlanningDiagnostic): string[] {
  return [`Expected tool: ${diagnostic.expected_tool}. Model requests: ${diagnostic.model_requests}.`,
    ...diagnostic.attempts.flatMap((attempt) => [
      `${attempt.phase}: ${attempt.code} (${attempt.category}). ${attempt.message}`,
      ...(attempt.response ? [`Response: HTTP ${attempt.response.http_status}; ${attempt.response.status}; stop ${attempt.response.stop_reason}; incomplete ${attempt.response.incomplete_reason}.`,
        `Tool calls: ${attempt.response.tool_calls}; expected: ${attempt.response.expected_tool_calls}; argument bytes: ${attempt.response.argument_bytes}; received fields: ${attempt.response.field_names.join(", ") || "none"}.`,
        ...(attempt.response.field_shapes ? [`Received shape (not a list of errors): ${attempt.response.field_shapes.join("; ")}.`] : [])] : []),
    ]), "The same approved context is retained for correction. No raw response or credential values are recorded."];
}

export async function saveBoundaryJobPlanningDiagnostic(root: string, diagnostic: BoundaryJobPlanningDiagnostic): Promise<void> {
  const directory = path.join(root, ".synapsor", "boundary-authoring", "diagnostics");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const target = path.join(directory, `planning-${randomUUID()}.json`);
  await fs.writeFile(target, JSON.stringify(diagnostic), { mode: 0o600, flag: "wx" });
  // Keep a small bounded attempt history, so a manual retry does not erase
  // the failed attempt needed for diagnosis.
  const entries = (await fs.readdir(directory)).filter((entry) => /^planning-[a-f0-9-]{36}\.json$/u.test(entry));
  const stats = await Promise.all(entries.map(async (name) => ({ name, mtime: (await fs.stat(path.join(directory, name))).mtimeMs })));
  stats.sort((a, b) => b.mtime - a.mtime);
  for (const entry of stats.slice(16)) await fs.unlink(path.join(directory, entry.name));
}
