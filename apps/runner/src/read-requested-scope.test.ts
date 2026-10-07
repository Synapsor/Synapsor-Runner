import { describe, expect, it } from "vitest";
import { requestedReadResourceIds, resolveRequestedReadScope } from "./read-requested-scope.js";

describe("original-request resource association", () => {
  const catalog = ["studio.accounts", "studio.payments", "archive.accounts"];
  it("keeps an explicit schema identity instead of matching another schema's table", () => {
    expect(requestedReadResourceIds("Read studio.accounts.", catalog)).toEqual(["studio.accounts"]);
  });
  it("does not convert an inline negative instruction into a required read", () => {
    expect(requestedReadResourceIds("Read studio.accounts and do not read studio.payments.", catalog)).toEqual(["studio.accounts"]);
  });
  it("does not interpret quoted example instructions as the current request", () => {
    expect(requestedReadResourceIds('The old example said "Read studio.payments." Read studio.accounts.', catalog)).toEqual(["studio.accounts"]);
  });
  it("does not silently resolve an unqualified same-name table across schemas", () => {
    expect(requestedReadResourceIds("Read accounts.", catalog)).toEqual([]);
  });
});

describe("exact whole-root negative scope", () => {
  it.each(["Do not show service.cases.", "Never show customer cases.", "Exclude customer cases.", "Customer cases are excluded."])("retains whole-root exclusion: %s", statement => {
    const scope = resolveRequestedReadScope({ original: "Read customer cases.", resources: [{ id: "service.cases" }],
      definitions: [{ resource: "service.cases", phrases: ["customer cases"] }], statements: [statement] });
    expect(scope.required).toEqual(["service.cases"]);
    expect(scope.excluded).toEqual(["service.cases"]);
  });
});
