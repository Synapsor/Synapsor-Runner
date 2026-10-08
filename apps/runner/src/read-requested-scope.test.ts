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

describe("attributed business phrase versus generic homonyms", () => {
  const resources = [{ id: "service.requests" }, { id: "archive.cases" }, { id: "audit.cases" }];
  const definitions = [{ resource: "service.requests", phrases: ["customer cases"] }];
  it("uses the exact attributed target outside unrelated basename collisions", () => {
    const scope = resolveRequestedReadScope({ original: "Read customer cases.", resources, definitions, statements: [] });
    expect(scope.required).toEqual(["service.requests"]);
    expect(scope.ambiguous).toEqual([]);
  });
  it("keeps a separately requested bare basename unresolved", () => {
    const scope = resolveRequestedReadScope({ original: "Read customer cases and cases.", resources, definitions, statements: [] });
    expect(scope.required).toEqual(["service.requests"]);
    expect(scope.ambiguous).toEqual([["archive.cases", "audit.cases"]]);
  });
  it("keeps explicitly requested qualified identities bound", () => {
    const scope = resolveRequestedReadScope({ original: "Read customer cases and archive.cases.", resources, definitions, statements: [] });
    expect(scope.required).toEqual(["archive.cases", "service.requests"]);
  });
  it("does not resolve conflicting attributable definitions", () => {
    const scope = resolveRequestedReadScope({ original: "Read customer cases.", resources,
      definitions: [...definitions, { resource: "audit.cases", phrases: ["customer cases"] }], statements: [] });
    expect(scope.required).not.toContain("service.requests");
    expect(scope.ambiguous).toContainEqual(["service.requests", "audit.cases"]);
  });
});

describe("attributed business phrase versus one implicit basename", () => {
  const resources = [{ id: "service.requests" }, { id: "archive.cases" }];
  const definitions = [{ resource: "service.requests", phrases: ["customer cases"] }];
  it.each([
    ["Read customer cases.", ["service.requests"]],
    ["Read customer cases and cases.", ["archive.cases", "service.requests"]],
    ["Read customer cases and archive.cases.", ["archive.cases", "service.requests"]],
    ["Read customer cases and archive.cases.status.", ["archive.cases", "service.requests"]],
  ] as const)("keeps only genuinely requested targets: %s", (original, required) => {
    const scope = resolveRequestedReadScope({ original, resources, definitions, statements: [] });
    expect(scope.required).toEqual(required);
    expect(scope.ambiguous).toEqual([]);
  });
  it("does not let a metadata label suppress the implicit basename requirement", () => {
    const scope = resolveRequestedReadScope({ original: "Read customer cases.",
      resources: [{ id: "service.requests", label: "Customer cases" }, { id: "archive.cases" }], definitions: [], statements: [] });
    expect(scope.required).toEqual(["archive.cases"]);
  });
});

// Clause boundaries must preserve the operator's distinction between keeping
// reviewed authority and requesting additional access; neither grants access.
describe("preserved authority and explicit Read additions", () => {
  const resources = ["atelier.orders", "atelier.checks"];
  it.each([
    "Keep the same saved job and Read Boundary, private atelier.checks verification and every Action guard unchanged.",
    "Retain the saved job and Read mapping with private atelier.checks checks unchanged.",
  ])("does not turn nominal authority into requested access: %s", text => {
    expect(requestedReadResourceIds(text, resources)).toEqual([]);
  });
  it.each([
    "Keep the same Read Boundary but include atelier.checks.",
    "Keep the saved job and Read mapping but also expose atelier.checks.",
    "Keep the same Read Boundary and show atelier.checks.",
  ])("retains a genuine explicit addition: %s", text => {
    expect(requestedReadResourceIds(text, resources)).toEqual(["atelier.checks"]);
  });
});
