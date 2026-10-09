import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest as digest } from "@synapsor-runner/protocol";
import { nativeFixture } from "./test-fixtures/native-read-scope.js";
import { loadBoundaryReviewContextHeld } from "./boundary-review-context.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";
import { loadHistoricalReadScopeInventoryHeld } from "./authoring-read-scope-history.js";
import { prepareBoundaryResourceReviewMutation, commitBoundaryResourceReviewMutation } from "./boundary-review-mutation.js";
import { assertReadScopeProvenance } from "./read-structured-scope.js";

describe("historical native scope provenance", () => {
  it("resolves original catalog and actual subject acknowledgments after a narrower saved Read edit", async () => {
    const f = await nativeFixture();
    try {
      const q = await f.produce(), record = q.read_scope!.record;
      const preview = await prepareBoundaryResourceReviewMutation(f.dir, { resource_id: "work.items", include: true,
        selectable_fields: [], keep_out_fields: ["label"], actor: "declared fixture operator",
        reason: "Keep labels outside customer access in this disabled revision." }, async () => f.inspection());
      await commitBoundaryResourceReviewMutation(f.dir, preview);
      const historical = await withProjectAuthorityMutation(f.dir, async permit => {
        const current = await loadBoundaryReviewContextHeld(f.dir, permit);
        expect(current.candidate.pack.resources[0]!.selectable_fields).not.toContain("label");
        return loadHistoricalReadScopeInventoryHeld({ projectRoot: f.dir, record, current, resume: f.state(),
          questions: f.state().operator_questions!, handoffs: f.state().owner_handoffs ?? [],
          generation: f.state().generation_recovery }, permit);
      });
      expect(historical.binding).toEqual(f.binding);
      expect(historical.catalog.subject_scopes).toEqual(f.inventory.catalog.subject_scopes);
      expect(() => assertReadScopeProvenance(record, { expectedBinding: historical.binding, ...historical })).not.toThrow();
      expect(f.state().operator_questions![0]).toEqual(q);
    } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
  });
  it("does not turn an invented or unavailable original catalog into ordinary staleness", async () => {
    const f = await nativeFixture();
    try {
      const q = await f.produce(), record = structuredClone(q.read_scope!.record);
      record.binding.catalog_digest = digest("unavailable original catalog");
      const { digest: _old, ...body } = record; record.digest = digest(body);
      await expect(withProjectAuthorityMutation(f.dir, async permit => loadHistoricalReadScopeInventoryHeld({
        projectRoot: f.dir, record, current: await loadBoundaryReviewContextHeld(f.dir, permit), resume: f.state(),
        questions: f.state().operator_questions!, handoffs: f.state().owner_handoffs ?? [], generation: f.state().generation_recovery,
      }, permit))).rejects.toThrow("READ_SCOPE_HISTORY_UNAVAILABLE");
      expect(f.state().operator_questions![0]).toEqual(q);
    } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
  });
});
