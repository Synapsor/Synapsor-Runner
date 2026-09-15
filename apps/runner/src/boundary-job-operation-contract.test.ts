import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { planModelBoundaryJob } from "./boundary-job-model.js";
import { BoundaryJobPlanningError, planningDiagnosticLines } from "./boundary-job-diagnostics.js";

const captured = JSON.parse(await fs.readFile(new URL("./fixtures/review-operation-sol-capture.json", import.meta.url), "utf8"));
// These are labelled derived controls, not replacements for the raw capture.
const review = () => ({ status: "planned", operation: "review_rules", read_mode: "reuse", action_mode: "reuse", summary: "Review the existing candidate without changing it." });
function response(args: unknown) {
  const body = structuredClone(captured.response);
  body.output.find((item: any) => item.type === "function_call").arguments = JSON.stringify(args);
  return body;
}
async function run(replies: unknown[], model = "gpt-5.6-sol") {
  const requests: any[] = [];
  let error: unknown, result: unknown;
  const before = JSON.stringify(captured);
  try {
    result = await planModelBoundaryJob({ currentState: captured.currentState, jobIntent: captured.jobIntent,
      availableResourceIds: captured.availableResourceIds, egressAcknowledged: true,
      session: { provider: "openai", model, apiKey: "test-only", dependencies: { requestJson: async request => {
        requests.push(request.body); return { status: 200, body: replies[Math.min(requests.length - 1, replies.length - 1)] as any };
      } } } });
  } catch (caught) { error = caught; }
  expect(JSON.stringify(captured)).toBe(before);
  return { requests, error, result };
}

describe("closed review operation contract through the real transport and parser", () => {
  it("retains refusal of the exact captured redundant outcome, with a precise bounded correction", async () => {
    const observed = await run([captured.response, response(review())]);
    expect(observed.requests).toHaveLength(2);
    expect(observed.result).toMatchObject({ state: "planned", operation: "review_rules", correction_used: true, authority_granted: false });
    expect(JSON.stringify(observed.requests[1])).toContain("/action_outcome: nonempty string");
    expect(JSON.stringify(observed.requests[1])).toContain("do not discard its change");
    expect(observed.result).not.toHaveProperty("action_outcome"); // supplied only by the derived second response
  });
  it.each(["gpt-5.6-terra", "gpt-5.6-sol"])("emits one closed review branch through the same adapter for %s", async model => {
    const observed = await run([response(review())], model);
    expect(observed.error).toBeUndefined(); expect(observed.requests).toHaveLength(1);
    const request = observed.requests[0], tool = request.tools.find((t: any) => t.name === "runner__plan_boundary_job");
    const branches = tool.parameters.oneOf, selected = branches.filter((b: any) => b.properties.operation);
    expect(selected).toHaveLength(1);
    expect(selected[0].required).toEqual(["status", "operation", "read_mode", "action_mode", "summary"]);
    expect(Object.keys(selected[0].properties).sort()).toEqual(["action_mode", "intended_client", "operation", "read_mode", "status", "summary"]);
    expect(selected[0].additionalProperties).toBe(false);
    expect(branches.filter((b: any) => b.properties.action_outcome).every((b: any) => !b.properties.operation)).toBe(true);
    expect(request.tool_choice).toEqual({ type: "function", name: "runner__plan_boundary_job" });
    expect(request.parallel_tool_calls).toBe(false);
  });
  it.each([null, "", "meaningful requested edit", 7, {}, []])("refuses extra fields including neutral placeholders: %j", async value => {
    const observed = await run([response({ ...review(), action_intent: value })]);
    expect(observed.error).toBeInstanceOf(BoundaryJobPlanningError);
    expect(String(observed.error)).toContain("/action_intent:");
    expect(observed.requests).toHaveLength(2); // one correction only
    expect(observed.result).toBeUndefined();
  });
  it("does not leak an arbitrary property name or private value into the safe diagnostic", async () => {
    const secret = "private_key_name_12345";
    const observed = await run([response({ ...review(), [secret]: "private-value-98765" })]);
    const error = observed.error as BoundaryJobPlanningError;
    const lines = planningDiagnosticLines(error.diagnostic).join("\n");
    expect(lines).toContain("/<unexpected-key>: nonempty string");
    expect(lines).toContain("operation"); expect(lines).not.toContain(secret); expect(lines).not.toContain("private-value-98765");
    expect(lines).toContain("not a list of errors");
  });
  it("keeps an explicit edit outside review and an ambiguous mixed request in clarification", async () => {
    const edit = structuredClone(captured.arguments); delete edit.operation;
    const edited = await run([response(edit)]);
    expect(edited.error).toBeUndefined(); expect(edited.result).toHaveProperty("action_outcome", captured.arguments.action_outcome);
    expect(edited.result).not.toHaveProperty("operation");
    const mixed = await run([response({ status: "clarification", question: "Should I review the saved program first, or prepare the requested business change?" })]);
    expect(mixed.error).toBeUndefined(); expect(mixed.result).toMatchObject({ state: "clarification", authority_granted: false });
    const bad = await run([response({ ...review(), read_mode: "revise" })]);
    expect(String(bad.error)).toContain("/read_mode: nonempty string; expected reuse or none");
  });
});
