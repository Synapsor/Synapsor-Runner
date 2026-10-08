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
    ["Read customer cases and cases.", ["service.requests"]],
    ["Read customer cases and archive.cases.", ["archive.cases", "service.requests"]],
    ["Read customer cases and archive.cases.status.", ["archive.cases", "service.requests"]],
  ] as const)("keeps only genuinely requested targets: %s", (original, required) => {
    const scope = resolveRequestedReadScope({ original, resources, definitions, statements: [] });
    expect(scope.required).toEqual(required);
    expect(scope.ambiguous).toEqual([]);
  });
  it("keeps a metadata label and an overlapping basename as unestablished alternatives", () => {
    const scope = resolveRequestedReadScope({ original: "Read customer cases.",
      resources: [{ id: "service.requests", label: "Customer cases" }, { id: "archive.cases" }], definitions: [], statements: [] });
    expect(scope.required).toEqual([]);
    expect(scope.candidates).toEqual([["service.requests", "archive.cases"]]);
  });
});

// Clause boundaries must preserve the operator's distinction between keeping
// reviewed authority and requesting additional access; neither grants access.
describe("preserved authority and explicit Read additions", () => {
  const resources = ["atelier.orders", "atelier.checks"];
  it.each([
    "Keep the same saved job and Read Boundary, private atelier.checks verification and every Action guard unchanged.",
    "Retain the saved job and Read mapping with private atelier.checks checks unchanged.",
    "Reuse the existing Read Boundary and add only a bounded spend-alert proposal.",
  ])("does not turn nominal authority into requested access: %s", text => {
    expect(requestedReadResourceIds(text, resources)).toEqual([]);
  });
  it.each([
    "Keep the same Read Boundary but include atelier.checks.",
    "Keep the saved job and Read mapping but also expose atelier.checks.",
    "Keep the same Read Boundary and show atelier.checks.",
    "Reuse the existing Read Boundary and read atelier.checks.",
  ])("retains a genuine explicit addition: %s", text => {
    expect(requestedReadResourceIds(text, resources)).toEqual(["atelier.checks"]);
  });
});


describe("bounded request evidence syntax", () => {
  const resources = [{ id: "finance.accounts" }, { id: "finance.payments" }];
  it.each([
    ["Read `finance.accounts`.", ["finance.accounts"], []],
    ["Read finance.accounts but not finance.payments.", ["finance.accounts"], ["finance.payments"]],
    ["Don’t read finance.payments.", [], ["finance.payments"]],
  ])("keeps positive and negative evidence distinct: %s", (original, required, excluded) => {
    const scope = resolveRequestedReadScope({ original: original as string, resources, definitions: [], statements: [] });
    expect(scope.required).toEqual(required);
    expect(scope.excluded).toEqual(excluded);
  });
  it("does not call an unrecognized business request complete without definitions", () => {
    const scope = resolveRequestedReadScope({ original: "Read outstanding obligations.", resources, definitions: [], statements: [] });
    expect(scope.required).toEqual([]);
    expect(scope.unresolved).toBe(true);
  });
});


describe("established scope versus candidate and conflicting evidence", () => {
  const resources = [{ id: "finance.accounts" }, { id: "finance.payments" }];
  it.each(['Read "finance.accounts".', "Read 'finance.accounts'.", "Read `finance.accounts.status`."])("keeps literal identity: %s", original => {
    expect(resolveRequestedReadScope({ original, resources, definitions: [], statements: [] }).required).toEqual(["finance.accounts"]);
  });
  it("keeps even a unique basename as candidate-only evidence", () => {
    const scope = resolveRequestedReadScope({ original: "Read accounts.", resources, definitions: [], statements: [] });
    expect(scope.required).toEqual([]);
    expect(scope.candidates).toEqual([["finance.accounts"]]);
  });
  it("does not silently remove contradictory current instructions", () => {
    const scope = resolveRequestedReadScope({ original: "Read finance.accounts.", resources, definitions: [], statements: ["Do not read finance.accounts."] });
    expect(scope.required).toEqual(["finance.accounts"]);
    expect(scope.excluded).toEqual(["finance.accounts"]);
    expect(scope.conflicts).toEqual(["finance.accounts"]);
  });
  it("preserves an unknown exact reference as unresolved rather than falling back to its basename", () => {
    const scope = resolveRequestedReadScope({ original: "Read elsewhere.accounts.", resources, definitions: [], statements: [] });
    expect(scope.required).toEqual([]);
    expect(scope.candidates).toEqual([]);
    expect(scope.unresolved).toBe(true);
  });
});


describe("unsupported positive clauses retain unresolved evidence", () => {
  it.each(["Read finance.accounts. Read outstanding obligations.", "Read finance.accounts and read outstanding obligations."])("does not mask the unsupported clause: %s", original => {
    const scope = resolveRequestedReadScope({ original, resources: [{ id: "finance.accounts" }], definitions: [], statements: [] });
    expect(scope.required).toEqual(["finance.accounts"]);
    expect(scope.unresolved).toBe(true);
  });
});
