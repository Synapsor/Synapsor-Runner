import { stripVTControlCharacters } from "node:util";
import { redactCliErrorMessage } from "./cli-logging.js";

export type ReadWorkloadDiagnostic = {
  attempt: number;
  phase: "initial" | "correction" | "follow-up";
  category: "required_tool" | "provider_response" | "provider_request" | "validation";
  code: string;
  reasons: string[];
};

export function safeReadWorkloadDiagnostic(value: ReadWorkloadDiagnostic): ReadWorkloadDiagnostic {
  return {
    ...value,
    code: /^[A-Z][A-Z0-9_]{1,79}$/.test(value.code) ? value.code : "READ_WORKLOAD_BLOCKED",
    reasons: value.reasons.slice(0, 6).map((reason) => redactCliErrorMessage(stripVTControlCharacters(reason))
      .replace(/\b(?:https?|postgres(?:ql)?|mysql):\/\/\S+/gi, "<URL redacted>")
      .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "<redacted>")
      .replace(/\b(?:SELECT|INSERT INTO|UPDATE|DELETE FROM)\s[\s\S]*/g, "<SQL omitted>")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .slice(0, 700)),
  };
}

export function readWorkloadDiagnosticLines(diagnostics: ReadWorkloadDiagnostic[]): string[] {
  return diagnostics.slice(0, 6).flatMap((diagnostic) => {
    const safe = safeReadWorkloadDiagnostic(diagnostic);
    const category = safe.category === "validation" ? "Submitted tool rejected by Runner"
      : safe.category === "provider_response" ? "Malformed provider response or tool arguments"
        : safe.category === "provider_request" ? "Provider request failed"
        : "Required tool missing or incorrect";
    return [
      `Attempt ${safe.attempt} (${safe.phase}): ${category} [${safe.code}]`,
      ...safe.reasons.map((reason) => `  ${reason}`),
    ];
  });
}

export class ReadWorkloadDraftError extends Error {
  readonly diagnostics: ReadWorkloadDiagnostic[];

  constructor(diagnostics: ReadWorkloadDiagnostic[]) {
    const safe = diagnostics.slice(0, 6).map(safeReadWorkloadDiagnostic);
    super(`READ_WORKLOAD_DRAFT_FAILED: ${readWorkloadDiagnosticLines(safe).join("\n")}`);
    this.name = "ReadWorkloadDraftError";
    this.diagnostics = safe;
  }
}
