import { describe, expect, it } from "vitest";
import { savedActionRecoveryOutcomes } from "./boundary-authoring-saved-actions.js";

const current = `sha256:${"a".repeat(64)}` as const;
const older = `sha256:${"b".repeat(64)}` as const;
const inventory = () => new Map<string, `sha256:${string}`>([
  ["depot.return_item", current], ["depot.complete_inspection", current],
]);

describe("same-job saved Action recovery inventory", () => {
  it.each(["all current", "all stale", "mixed"])("includes both outcomes regardless of dependency freshness (%s)", shape => {
    const dependencies = inventory();
    if (shape !== "all current") dependencies.set("depot.return_item", older);
    if (shape === "all stale") dependencies.set("depot.complete_inspection", older);
    expect(savedActionRecoveryOutcomes({ boundaryName: "depot_review", resumeBoundaryName: "depot_review",
      preferredSavedOutcomes: [...dependencies.keys()],
      readDigestByOutcome: dependencies })).toEqual(["depot.return_item", "depot.complete_inspection"]);
  });

  it.each([undefined, "another_review", ""])("does not recover another or missing job binding (%s)", resumeBoundaryName => {
    expect(savedActionRecoveryOutcomes({ boundaryName: "depot_review", resumeBoundaryName,
      preferredSavedOutcomes: [...inventory().keys()],
      readDigestByOutcome: inventory() })).toEqual([]);
  });

  it("does not treat two empty names as a bound job", () => {
    expect(savedActionRecoveryOutcomes({ boundaryName: "", resumeBoundaryName: "", preferredSavedOutcomes: [...inventory().keys()], readDigestByOutcome: inventory() })).toEqual([]);
  });

  it.each([undefined, new Map<string, `sha256:${string}`>()])("does not invent missing saved authorities (%s)", readDigestByOutcome => {
    expect(savedActionRecoveryOutcomes({ boundaryName: "depot_review", resumeBoundaryName: "depot_review", readDigestByOutcome })).toEqual([]);
  });

  it("preserves the host's preferred revision and inventory order without changing any digest", () => {
    const dependencies = inventory();
    dependencies.set("depot.return_item", older);
    const before = [...dependencies];
    const result = savedActionRecoveryOutcomes({ boundaryName: "depot_review", resumeBoundaryName: "depot_review",
      preferredSavedOutcomes: [...dependencies.keys()],
      readDigestByOutcome: dependencies });
    expect([...dependencies]).toEqual(before);
    expect(result).toEqual(before.map(([outcome]) => outcome));
    result.pop();
    expect([...dependencies]).toEqual(before);
    expect(savedActionRecoveryOutcomes({ boundaryName: "depot_review", resumeBoundaryName: "depot_review",
      preferredSavedOutcomes: [...dependencies.keys()],
      readDigestByOutcome: dependencies })).toHaveLength(2);
  });

  it("uses no outcome, schema, resource or domain-name inference", () => {
    expect(savedActionRecoveryOutcomes({ boundaryName: "opaque_scope", resumeBoundaryName: "opaque_scope",
      preferredSavedOutcomes: ["x.a", "y.z"],
      readDigestByOutcome: new Map([["x.a", current], ["y.z", older]]) })).toEqual(["x.a", "y.z"]);
  });

  it("does not resurrect serving outcomes omitted by the preferred disabled draft", () => {
    expect(savedActionRecoveryOutcomes({ boundaryName: "depot_review", resumeBoundaryName: "depot_review",
      preferredSavedOutcomes: ["depot.return_item"], readDigestByOutcome: inventory() })).toEqual(["depot.return_item"]);
  });

  it("does not fall back to the serving inventory when the saved draft has no outcomes", () => {
    expect(savedActionRecoveryOutcomes({ boundaryName: "depot_review", resumeBoundaryName: "depot_review",
      preferredSavedOutcomes: [], readDigestByOutcome: inventory() })).toEqual([]);
  });

  it("deduplicates preferred outcome references without changing their order", () => {
    expect(savedActionRecoveryOutcomes({ boundaryName: "depot_review", resumeBoundaryName: "depot_review",
      preferredSavedOutcomes: ["depot.complete_inspection", "depot.return_item", "depot.complete_inspection"],
      readDigestByOutcome: inventory() })).toEqual(["depot.complete_inspection", "depot.return_item"]);
  });

  it("fails closed when a preferred outcome has no exact inventoried dependency", () => {
    expect(() => savedActionRecoveryOutcomes({ boundaryName: "depot_review", resumeBoundaryName: "depot_review",
      preferredSavedOutcomes: ["depot.unknown"], readDigestByOutcome: inventory() })).toThrow("ACTION_RULE_RECOVERY_INVENTORY_INCOMPLETE");
  });
});
