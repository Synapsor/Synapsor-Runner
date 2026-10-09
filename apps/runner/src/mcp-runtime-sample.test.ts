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


describe("B64 schema-only sample arguments", () => {
  it.each(["billing.invoice", "support.ticket", "account.customer", "orders.change"])("does not infer identities or review facts from %s", name => {
    const capability = { name, target: { table: name }, lookup: { id_from_arg: "id" }, args: {
      id: { type: "string" }, reason: { type: "string" }, resolution: { type: "string" }, status: { type: "string" },
      amount: { type: "number", minimum: 7, maximum: 9 }, approved: { type: "boolean" },
      items: { type: "object_array", fields: { reason: { type: "string" }, status: { type: "string" } } },
    } };
    expect(sampleInputForCapability(capability as never)).toEqual({ id: "sample", reason: "sample", resolution: "sample", status: "sample", amount: 7, approved: false,
      items: [{ reason: "sample", status: "sample" }] });
  });
});
