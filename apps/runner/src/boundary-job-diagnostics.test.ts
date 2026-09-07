import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { planningResponseDiagnostic, saveBoundaryJobPlanningDiagnostic, type BoundaryJobPlanningDiagnostic } from "./boundary-job-diagnostics.js";

it.each(["responses", "anthropic", "chat"])("records bounded structural %s evidence without response values", (provider) => {
  const input = { status: "planned", private_secret_key_name: "do-not-log-me" };
  const body = provider === "responses" ? { status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "function_call", name: "runner__plan_boundary_job", arguments: JSON.stringify(input) }] }
    : provider === "anthropic" ? { stop_reason: "max_tokens", content: [{ type: "tool_use", name: "runner__plan_boundary_job", input }] }
    : { choices: [{ finish_reason: "length", message: { tool_calls: [{ function: { name: "runner__plan_boundary_job", arguments: JSON.stringify(input) } }] } }] };
  const result = planningResponseDiagnostic({ status: 200, body });
  expect(result).toMatchObject({ tool_calls: 1, expected_tool_calls: 1, field_names: ["<unexpected-key>", "status"] });
  expect(result.argument_bytes).toBeGreaterThan(0);
  expect(JSON.stringify(result)).not.toMatch(/private_secret|do-not-log/);
});

it("keeps separate private failure and retry records with a bounded history", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "planning-diagnostic-"));
  try {
    const diagnostic: BoundaryJobPlanningDiagnostic = { version: 1, expected_tool: "runner.plan_boundary_job", context_digest: `sha256:${"a".repeat(64)}`,
      attempts: [{ attempt: 1, phase: "initial", category: "tool_selection", code: "ASK_REQUIRED_TOOL_NOT_CALLED", message: "Missing planning tool." }],
      model_requests: 1, duration_ms: 10, authority_changed: false, source_database_changed: false };
    await saveBoundaryJobPlanningDiagnostic(root, diagnostic);
    const directory = path.join(root, ".synapsor/boundary-authoring/diagnostics");
    const first = (await fs.readdir(directory))[0]!;
    await saveBoundaryJobPlanningDiagnostic(root, { ...diagnostic, duration_ms: 20 });
    expect(await fs.readdir(directory)).toHaveLength(2);
    expect(JSON.parse(await fs.readFile(path.join(directory, first), "utf8"))).toEqual(diagnostic);
    expect((await fs.stat(path.join(directory, first))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    for (let index = 0; index < 18; index++) await saveBoundaryJobPlanningDiagnostic(root, diagnostic);
    expect(await fs.readdir(directory)).toHaveLength(16);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
