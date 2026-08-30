import { describe, expect, it } from "vitest";
import { sampleInputForCapability } from "./mcp-runtime.js";

describe("MCP runtime sample inputs", () => {
  it("keeps a reviewed enum value valid even when legacy normalization marks it as a lookup arg", () => {
    const sample = sampleInputForCapability({
      name: "maintenance.propose_insert_request",
      target: { table: "maintenance_requests" },
      lookup: { id_from_arg: "priority" },
      args: {
        priority: {
          type: "string",
          required: true,
          enum: ["routine", "soon", "urgent"],
        },
        requested_hours: {
          type: "number",
          required: true,
          minimum: 0.5,
          maximum: 16,
        },
      },
    } as never);

    expect(sample).toEqual({ priority: "routine", requested_hours: 0.5 });
  });
});
