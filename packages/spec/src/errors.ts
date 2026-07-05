import type { ValidationIssue } from "./types.js";

export class SynapsorSpecValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(`Invalid Synapsor contract:\n${issues.map((issue) => `${issue.path} ${issue.code}: ${issue.message}`).join("\n")}`);
    this.name = "SynapsorSpecValidationError";
  }
}
