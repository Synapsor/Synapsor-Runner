import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { newPolicySourceSession, policyTextSnapshot } from "./authoring-policy-source.js";
import { structuredDraftSuccessorSourceMatches, type StructuredDraftSuccessorInventory } from "./boundary-draft-successor.js";
import { ownedProgramDraft } from "./test-fixtures/owned-authoring-program.js";

function inventory(): StructuredDraftSuccessorInventory {
  const source = policyTextSnapshot(Buffer.from("Every proposal needs one human parcel reviewer."), "rules.txt");
  const { name, text, digest, version } = source;
  const proposal = { actions: [ownedProgramDraft(1)], read_resources: [], intents: [], sources: [{ name, text, digest, version }] };
  const core = { schema_version: "synapsor.structured-draft-successor.v1" as const, declaration_digest: canonicalJsonDigest(proposal),
    destination: { repository_id: "owned-current-repository", deployment_id: "owned-current-deployment", project_id: "owned-current-project",
      boundary_name: "owned-parcels", schema_fingerprint: canonicalJsonDigest("owned-schema"), role_posture_fingerprint: canonicalJsonDigest("owned-role") },
    read_candidate_digest: canonicalJsonDigest("owned-current-read"), ...proposal };
  return { ...core, inventory_digest: canonicalJsonDigest(core) };
}

describe("successor Source attachment applicability", () => {
  it("does not match an inert historical version after a changed Source becomes active", () => {
    const saved = inventory(), source = saved.sources[0]!, current = newPolicySourceSession();
    current.snapshots = [policyTextSnapshot(Buffer.from(source.text), source.name, 1),
      policyTextSnapshot(Buffer.from("Changed policy needs two human parcel reviewers."), source.name, 2)];
    current.active = 2;
    expect(structuredDraftSuccessorSourceMatches(saved, current)).toEqual([{ name: source.name, digest: source.digest, attached_current: false }]);
    expect(current.snapshots).toHaveLength(2); // history remains inert and intact
  });

  it("matches an explicitly active fresh exact Source and requires an active selection", () => {
    const saved = inventory(), source = saved.sources[0]!, current = newPolicySourceSession();
    current.snapshots = [policyTextSnapshot(Buffer.from("Unrelated retained historical policy."), source.name, 1),
      policyTextSnapshot(Buffer.from(source.text), source.name, 7)];
    current.active = 7;
    expect(structuredDraftSuccessorSourceMatches(saved, current)).toEqual([{ name: source.name, digest: source.digest, attached_current: true }]);
    current.active = undefined;
    expect(structuredDraftSuccessorSourceMatches(saved, current)).toEqual([{ name: source.name, digest: source.digest, attached_current: false }]);
  });
});
