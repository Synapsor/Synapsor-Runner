import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ExplorationBoundaryDraft, ExplorationRelationship, RelationshipLinkProof } from "./auto-boundary.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import {
  assertReviewedReadRelationshipRetained,
  readRelationshipEvidenceReviewSections,
  reviewReadRelationship,
  validateReviewedReadRelationship,
} from "./read-relationship-review.js";

const link = (source = "school.offers", target = "school.registrations"): RelationshipLinkProof => ({
  constraint_name: "offers_registration_fk",
  source_resource: source,
  target_resource: target,
  source_columns: ["institution_id", "registration_id"],
  target_columns: ["institution_id", "registration_id"],
  target_uniqueness: { kind: "primary_key", name: "registrations_pkey", columns: ["institution_id", "registration_id"] },
  nullable: false,
  cardinality: "many_to_one",
  max_fan_out: 1,
});

function relationship(options: {
  id?: string;
  target?: string;
  links?: RelationshipLinkProof[];
  unmatchedRows?: ExplorationRelationship["unmatched_rows"];
} = {}): ExplorationRelationship {
  const links = options.links ?? [link(undefined, options.target ?? "school.registrations")];
  return {
    id: options.id ?? "offers_registration_fk",
    target_resource: options.target ?? "school.registrations",
    local_columns: links[0]!.source_columns,
    target_columns: links.at(-1)!.target_columns,
    counted_entity: options.target ?? "school.registrations",
    cardinality: "many_to_one",
    max_fan_out: 1,
    path_depth: links.length as 1 | 2 | 3,
    proof: { source: "database_catalog", links, digest: canonicalJsonDigest(links) },
    ...(options.unmatchedRows ? { unmatched_rows: options.unmatchedRows } : {}),
  };
}

function resource(id: string, relationships: ExplorationRelationship[] = []) {
  return {
    id, schema: "school", table: id.split(".").at(-1), relationships,
    tenant_key: "institution_id", principal_key: "student_id",
  };
}

function boundary(input: {
  current?: ExplorationRelationship[];
  generated?: ExplorationRelationship[];
  resources?: string[];
  maximumHops?: 1 | 2 | 3;
} = {}): { current: ExplorationBoundaryDraft; generated: ExplorationBoundaryDraft } {
  const resources = input.resources ?? ["school.offers", "school.registrations"];
  const build = (relationships: ExplorationRelationship[]) => ({
    activation: "disabled_unreviewed",
    budgets: { max_relationship_hops: 2, max_analysis_relationship_hops: input.maximumHops ?? 2 },
    pack: { resources: resources.map((id) => resource(id, id === "school.offers" ? relationships : [])) },
  } as unknown as ExplorationBoundaryDraft);
  return { current: build(input.current ?? []), generated: build(input.generated ?? [relationship()]) };
}

function reviewInput(
  selection: string[] = ["0"],
  fixture = boundary(),
) {
  const chooseOption = vi.fn(async () => selection.shift());
  return {
    projectRoot: "/tmp/owned-read-relationship-review",
    boundary: fixture.current,
    generatedBoundary: fixture.generated,
    fromResource: "school.offers",
    toResource: "school.registrations",
    modelLabel: "openai[gpt-5.6-terra]",
    session: { chooseOption } as unknown as BoundaryReviewInteractiveSession,
    assertCurrent: vi.fn(async () => {}),
  };
}

describe("Read relationship restoration review", () => {
  it("uses one explicit path-or-pending menu and stages one exact generated path without source values", async () => {
    const args = reviewInput();
    const before = structuredClone(args.boundary);
    const reviewed = await reviewReadRelationship(args);
    expect(reviewed).toMatchObject({
      schema_version: "synapsor.reviewed-read-relationship.v1",
      candidate_digest: expect.stringMatching(/^sha256:/u),
      resource: "school.offers",
      relationship_id: "offers_registration_fk",
      relationship_fingerprint: expect.stringMatching(/^sha256:/u),
    });
    expect(args.assertCurrent).toHaveBeenCalledTimes(2);
    expect(args.session.chooseOption).toHaveBeenCalledOnce();
    const [, , options] = vi.mocked(args.session.chooseOption!).mock.calls[0]!;
    const detailText = JSON.stringify(options?.exactDetails);
    expect(detailText).toContain("institution_id = institution_id");
    expect(detailText).toContain("registration_id = registration_id");
    expect(detailText).toContain("offers_registration_fk");
    expect(detailText).toContain("No source rows, trusted identity values");
    expect(detailText).not.toContain("acct-7");
    expect(options).toMatchObject({ initialValue: "pending", requireExplicitSelection: true });
    expect(JSON.stringify(vi.mocked(args.session.chooseOption!).mock.calls[0]![1])).toContain(
      "Review and add path 1 to the disabled draft",
    );
    expect(args.boundary).toEqual(before);
  });

  it("keeps generated links outside the requested root and target out of consent details", async () => {
    const other = relationship({ id: "offers_private_fk", target: "school.private_notes" });
    const fixture = boundary({
      generated: [relationship(), other],
      resources: ["school.offers", "school.registrations", "school.private_notes"],
    });
    const args = reviewInput(["0"], fixture);
    const reviewed = await reviewReadRelationship(args);
    expect(reviewed?.relationship_id).toBe("offers_registration_fk");
    const [, , options] = vi.mocked(args.session.chooseOption!).mock.calls[0]!;
    expect(JSON.stringify(options?.exactDetails)).not.toContain("offers_private_fk");
    expect(JSON.stringify(options?.exactDetails)).not.toContain("private_notes");
  });

  it("keeps the draft unchanged when consent is declined and does not open a path picker", async () => {
    const args = reviewInput(["pending"]);
    const before = structuredClone(args.boundary);
    await expect(reviewReadRelationship(args)).resolves.toBeUndefined();
    expect(args.session.chooseOption).toHaveBeenCalledOnce();
    expect(args.assertCurrent).toHaveBeenCalledOnce();
    expect(args.boundary).toEqual(before);
  });

  it("does not offer a generated path that needs a new intermediate resource or exceeds the reviewed hop limit", async () => {
    const first = link("school.offers", "school.students");
    const second = link("school.students", "school.registrations");
    const fixture = boundary({
      generated: [relationship({ links: [first, second] })],
      resources: ["school.offers", "school.registrations"],
      maximumHops: 1,
    });
    const args = reviewInput(["0"], fixture);
    await expect(reviewReadRelationship(args)).rejects.toThrow("READ_RELATIONSHIP_RESTORE_UNAVAILABLE");
    expect(args.session.chooseOption).not.toHaveBeenCalled();
  });

  it("does not offer an unresolved nullable generated path", async () => {
    const fixture = boundary({ generated: [relationship({ unmatchedRows: "review_required" })] });
    const args = reviewInput(["0"], fixture);
    await expect(reviewReadRelationship(args)).rejects.toThrow("READ_RELATIONSHIP_RESTORE_UNAVAILABLE");
    expect(args.session.chooseOption).not.toHaveBeenCalled();
  });

  it("validates provenance against the unchanged candidate and returns only the generated relationship", async () => {
    const fixture = boundary();
    const reviewed = await reviewReadRelationship(reviewInput(["0"], fixture));
    const restored = validateReviewedReadRelationship(reviewed!, fixture.current, fixture.generated);
    expect(restored).toEqual(fixture.generated.pack.resources[0]!.relationships[0]);
    expect(fixture.current.pack.resources[0]!.relationships).toEqual([]);

    const staged = structuredClone(fixture.current);
    staged.pack.resources[0]!.relationships.push(restored);
    assertReviewedReadRelationshipRetained(reviewed!, staged);
    expect(staged.pack.resources.map(({ tenant_key, principal_key }) => ({ tenant_key, principal_key })))
      .toEqual(fixture.current.pack.resources.map(({ tenant_key, principal_key }) => ({ tenant_key, principal_key })));
    staged.pack.resources[0]!.relationships[0]!.proof!.links[0]!.constraint_name = "changed_after_stage";
    expect(() => assertReviewedReadRelationshipRetained(reviewed!, staged))
      .toThrow("READ_RELATIONSHIP_RESTORE_NOT_RETAINED");
  });

  it("refuses a changed candidate, proof replacement, or already-restored link", async () => {
    const fixture = boundary();
    const reviewed = await reviewReadRelationship(reviewInput(["0"], fixture));
    const changedCandidate = structuredClone(fixture.current);
    changedCandidate.pack.resources[1]!.description = "ordinary privacy revision";
    expect(() => validateReviewedReadRelationship(reviewed!, changedCandidate, fixture.generated))
      .toThrow("READ_RELATIONSHIP_CANDIDATE_STALE");

    const changedProof = structuredClone(fixture.generated);
    changedProof.pack.resources[0]!.relationships[0]!.proof!.links[0]!.constraint_name = "replacement_fk";
    changedProof.pack.resources[0]!.relationships[0]!.proof!.digest = canonicalJsonDigest(
      changedProof.pack.resources[0]!.relationships[0]!.proof!.links,
    );
    expect(() => validateReviewedReadRelationship(reviewed!, fixture.current, changedProof))
      .toThrow("READ_RELATIONSHIP_PROOF_STALE");

    const alreadyRestored = structuredClone(fixture.current);
    alreadyRestored.pack.resources[0]!.relationships.push(structuredClone(
      fixture.generated.pack.resources[0]!.relationships[0]!,
    ));
    expect(() => validateReviewedReadRelationship(reviewed!, alreadyRestored, fixture.generated))
      .toThrow("READ_RELATIONSHIP_CANDIDATE_STALE");
  });

  it("rejects malformed staged records and renders every eligible exact key pair", async () => {
    const fixture = boundary();
    const relationshipSections = readRelationshipEvidenceReviewSections([{
      resource: "school.offers",
      relationship: fixture.generated.pack.resources[0]!.relationships[0]!,
      relationship_fingerprint: canonicalJsonDigest({ resource: "school.offers", relationship: fixture.generated.pack.resources[0]!.relationships[0]! }),
    }]);
    expect(relationshipSections[0]!.lines.join("\n")).toContain("institution_id = institution_id");
    expect(() => validateReviewedReadRelationship(
      {
        schema_version: "synapsor.reviewed-read-relationship.v1",
        candidate_digest: "sha256:bad",
        resource: "school.offers",
        relationship_id: "offers_registration_fk",
        relationship_fingerprint: "sha256:bad",
      } as unknown as Parameters<typeof validateReviewedReadRelationship>[0],
      fixture.current,
      fixture.generated,
    ))
      .toThrow("READ_RELATIONSHIP_PROVENANCE_INVALID");
  });
});
