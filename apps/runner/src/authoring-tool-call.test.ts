import { describe, expect, it, vi } from "vitest";
import { AskError } from "./model-ask.js";
import { runRequiredAuthoringToolCall } from "./authoring-tool-call.js";
import { ReadWorkloadDraftError, readWorkloadDiagnosticLines } from "./read-workload-diagnostics.js";

describe("required authoring tool correction", () => {
  it.each(["ASK_REQUIRED_TOOL_NOT_CALLED", "ASK_PROVIDER_RESPONSE_INVALID", "ASK_TOOL_ARGUMENTS_INVALID"])("repairs %s once without hiding the second failure", async (code) => {
    const first = new AskError(code, "first failure");
    const second = new AskError("ASK_TOOL_ARGUMENTS_INVALID", "second failure");
    const run = vi.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(second);
    const onCorrection = vi.fn();
    await expect(runRequiredAuthoringToolCall({ run, onCorrection, question: "job", toolName: "runner.submit_read_workloads" })).rejects.toBe(second);
    expect(run).toHaveBeenCalledTimes(2);
    expect(onCorrection).toHaveBeenCalledOnce();
    expect(run.mock.calls[1]?.[0]).not.toContain("returned prose");
  });

  it("does not retry authentication, cancellation, or unexpected runtime failures", async () => {
    for (const error of [new AskError("ASK_PROVIDER_AUTH_FAILED", "No credential"), new DOMException("Aborted", "AbortError"), new Error("Unexpected error")]) {
      const run = vi.fn().mockRejectedValue(error);
      await expect(runRequiredAuthoringToolCall({ run, question: "job", toolName: "runner.submit_read_workloads" })).rejects.toBe(error);
      expect(run).toHaveBeenCalledOnce();
    }
  });

  it("keeps operator diagnostics bounded and redacts credentials, endpoints, SQL, and terminal controls", () => {
    const error = new ReadWorkloadDraftError([{
      attempt: 1, phase: "initial", category: "validation", code: "READ_WORKLOAD_ID_INVALID",
      reasons: [
        "\u001b[31mREAD_WORKLOAD_ID_INVALID: id must be lower-case\u001b[0m",
        "password=secret-value api_key=private-value Bearer bearer-value sk-abcdefghijklmnop",
        "postgresql://user:pass@host/db https://private.example/token",
        "SELECT secret_column FROM private_rows",
        "x".repeat(2000),
      ],
    }]);
    const output = readWorkloadDiagnosticLines(error.diagnostics).join("\n");
    expect(output).toContain("READ_WORKLOAD_ID_INVALID: id must be lower-case");
    for (const secret of ["secret-value", "private-value", "bearer-value", "abcdefghijklmnop", "private.example", "user:pass", "secret_column", "\u001b"])
      expect(output).not.toContain(secret);
    expect(error.diagnostics[0]?.reasons.every((reason) => reason.length <= 700)).toBe(true);
  });
});
