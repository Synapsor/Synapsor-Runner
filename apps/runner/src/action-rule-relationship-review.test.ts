import { describe, expect, it } from "vitest";
import { inspectActionRelationships, actionRelationshipReviewDetails } from "./action-rule-relationship-review.js";
import type { BuiltActionRuleAuthoringCatalogV1 } from "./action-rule-authoring.js";

type Relationship = BuiltActionRuleAuthoringCatalogV1["catalog"]["relationships"][number];
const edge = (from: string, to: string, name = `${from}_${to}`): Relationship => ({
  name, from_resource: `university.${from}`, to_resource: `university.${to}`, cardinality: "many_to_one", target_unique: true, nullable: false,
  field_pairs: [{ local_field: "institution_id", target_field: "institution_id" }, { local_field: `${to}_id`, target_field: `${to}_id` }],
});
// The discovery tool only reads structural resources, links and diagnostics.
function fixture(relationships: Relationship[]) {
  return {
    catalog: { resources: [...new Set(relationships.flatMap((r) => [r.from_resource, r.to_resource]))].map((name) => ({ name })), relationships },
    authoring: { digest: `sha256:${"1".repeat(64)}`, diagnostics: [] },
  } as unknown as BuiltActionRuleAuthoringCatalogV1;
}
const inspect = (built: BuiltActionRuleAuthoringCatalogV1, from: string, to: string) => inspectActionRelationships({
  built, args: { from_resource: `university.${from}`, to_resource: `university.${to}` }, reviewed: new Set(), prepare: false,
});

describe("Action relationship path discovery", () => {
  it("finds the existing registration -> student -> institution path instead of reporting missing", () => {
    const built = fixture([edge("registrations", "students"), edge("students", "institutions")]);
    const before = structuredClone(built);
    const result = inspect(built, "registrations", "institutions");
    expect(result.status).toBe("candidate_paths");
    expect(result.candidates).toEqual([]);
    expect(result.paths).toMatchObject([{ one_row_path: true, steps: [
      { relationship: "registrations_students", direction: "forward", key_pairs: edge("registrations", "students").field_pairs },
      { relationship: "students_institutions", direction: "forward" },
    ] }]);
    expect(result.path_search?.limited).toBe(false);
    expect(result.prepared_disabled).toBe(false);
    expect(result.source_rows_read).toBe(false);
    expect(result.read_exposure_changed).toBe(false);
    expect(built).toEqual(before);
    const reviewed = new Set<string>();
    for (const step of result.paths![0]!.steps) {
      const prepared = inspectActionRelationships({ built, reviewed, prepare: true,
        args: { from_resource: step.from_resource, to_resource: step.to_resource, relationship: step.relationship } });
      expect(prepared.prepared_disabled).toBe(true);
    }
    expect([...reviewed]).toEqual(["registrations_students", "students_institutions"]);
    expect(actionRelationshipReviewDetails(result).join("\n")).toContain("Path 1");
  });

  it("reports alternate prerequisite routes and many-row cardinality without claiming an exact target", () => {
    const result = inspect(fixture([
      edge("registrations", "students"), edge("prerequisites", "students"),
      edge("registrations", "sections"), edge("sections", "courses"), edge("prerequisites", "courses"),
    ]), "registrations", "prerequisites");
    expect(result.status).toBe("candidate_paths");
    expect(result.paths).toHaveLength(2);
    expect(result.paths!.every((path) => !path.one_row_path && path.steps.at(-1)!.direction === "inverse")).toBe(true);
    expect(result.next_step).toContain("business correlation");
    expect(result.prepared_disabled).toBe(false);
  });

  it("handles cycles deterministically and refuses invented path names at review", () => {
    const built = fixture([edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("c", "d")]);
    const result = inspect(built, "a", "d");
    expect(result).toEqual(inspect(built, "a", "d"));
    expect(result.paths!.every((path) => new Set([path.steps[0]!.from_resource, ...path.steps.map((step) => step.to_resource)]).size === path.steps.length + 1)).toBe(true);
    const reviewed = new Set<string>();
    expect(inspectActionRelationships({ built, reviewed, prepare: true, args: {
      from_resource: "university.a", to_resource: "university.d", relationship: "invented_shortcut",
    } }).prepared_disabled).toBe(false);
    expect(reviewed.size).toBe(0);
  });

  it("keeps discovery bounded and does not claim absence when the search is incomplete", () => {
    const edges: Relationship[] = [];
    for (let i = 0; i < 34; i++) for (let j = i + 1; j < 34; j++) edges.push(edge(`n${i}`, `n${j}`));
    const result = inspect(fixture([...edges, edge("isolated", "destination")]), "n0", "destination");
    expect(result.status).toBe("path_search_bounded");
    expect(result.path_search?.limited).toBe(true);
    expect(result.next_step).toContain("No missing-relationship conclusion");
    expect(result.paths!.length).toBeLessThanOrEqual(16);
  });

  it("does not include intermediates excluded from the reviewed catalog", () => {
    const built = fixture([edge("a", "private"), edge("private", "b")]);
    built.catalog.resources = built.catalog.resources.filter((resource) => resource.name !== "university.private");
    const result = inspect(built, "a", "b");
    expect(result.status).toBe("missing");
    expect(result.paths).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("university.private");
  });
});
