import { describe, expect, it } from "vitest";
import { policyCommand } from "./contract-commands.js";

describe("public policy approver routing", () => {
  it("reaches the approver command's own argument guard", async () => {
    await expect(policyCommand(["approver", "--unsupported"]))
      .rejects.toThrow("Unknown option for policy approver: --unsupported");
  });
  it("reaches the scoped APPLY command's own argument guard", async () => {
    await expect(policyCommand(["apply-operator", "--unsupported"]))
      .rejects.toThrow("Unknown option for policy apply-operator: --unsupported");
  });
});
