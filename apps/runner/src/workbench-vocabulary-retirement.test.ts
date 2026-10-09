import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { renderBoundaryWorkbench } from "./boundary-workbench.js";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
import { readGuidedOnboardingState } from "./guided-project.js";
import { startLocalUiServer } from "./local-ui.js";

function renderedControls(resource: Record<string, unknown>) {
  const script = renderBoundaryWorkbench("vocabulary-csrf").match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const vocabularyStart = script.indexOf("const modelFacingFieldIds");
  const vocabularyEnd = script.indexOf("function handleSessionFailure", vocabularyStart);
  const blockerStart = script.indexOf("function focusedBoundaryBlocker()");
  const blockerEnd = script.indexOf("function renderSignoff()", blockerStart);
  expect(vocabularyStart).toBeGreaterThan(0); expect(vocabularyEnd).toBeGreaterThan(vocabularyStart);
  expect(blockerStart).toBeGreaterThan(0); expect(blockerEnd).toBeGreaterThan(blockerStart);
  const context = vm.createContext({ candidate: { pack: { resources: [resource] } },
    vocabularyMetadataProfiles: {}, vocabularyStructuralProfiles: {} });
  return vm.runInContext(`${script.slice(vocabularyStart, vocabularyEnd)}\n${script.slice(blockerStart, blockerEnd)}\n({
    blocker: focusedBoundaryBlocker, coverage:()=>modelVocabularyCoverage(candidate.pack.resources[0]),
    summary:()=>modelVocabularySummary(candidate.pack.resources[0]) });`, context) as {
      blocker(): string; coverage(): Record<string, unknown>; summary(): string };
}

describe("Workbench optional vocabulary presentation", () => {
  it.each(["legacy.t_0031", "public.orders"])("does not make unlabelled %s a vocabulary activation blocker", id => {
    const controls = renderedControls({ id, selectable_fields: ["c7"], field_enums: { c7: ["P1", "P2"] }, relationships: [] });
    expect(controls.blocker()).toBe("");
    expect(controls.coverage()).not.toHaveProperty("status");
    expect(controls.coverage()).not.toHaveProperty("blocking");
    expect(controls.summary()).toContain("optional presentation metadata");
    expect(controls.summary()).not.toMatch(/ready|activate|advised|required|opaque|coded/i);
  });

  it("preserves actual relationship blockers with and without reviewed labels", () => {
    const resource = { id: "legacy.t_0031", selectable_fields: ["c7"],
      relationships: [{ target_resource: "public.groups", unmatched_rows: "review_required" }] };
    for (const metadata of [{}, { label: "Items", field_metadata: { c7: { label: "Category" } } }]) {
      expect(renderedControls({ ...resource, ...metadata }).blocker()).toBe(
        "Choose how unmatched rows behave for legacy.t_0031 → public.groups before activation.");
    }
  });

  it("serves honest metadata profiles from this project's actual saved review", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vocabulary-ui-native-")); await fs.chmod(root, 0o700);
    const fixture = await prepareReviewedReadScope(root, { resources: ["work.t_0081"], field: "c7",
      review: { allow_reviewed_fields: ["c7"] } });
    const state = (await readGuidedOnboardingState(root))!;
    const server = await startLocalUiServer({ projectRoot: root, boundaryRoot: fixture.context.boundaryRoot,
      configPath: path.join(root, state.artifacts.runner_config), storePath: path.join(root, state.artifacts.local_store),
      token: "vocabulary-ui-token", csrfToken: "vocabulary-ui-csrf", schemaInspector: async () => fixture.inspection });
    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/boundary`, {
        headers: { "x-synapsor-ui-token": server.token } });
      const payload = await response.json();
      expect(response.status, JSON.stringify(payload)).toBe(200);
      expect(payload.vocabulary_metadata_profiles).toMatchObject({ "work.t_0081": {
        resource_vocabulary: "unspecified", field_vocabulary: { c7: "unspecified" } } });
      expect(payload).not.toHaveProperty("vocabulary_structural_profiles");
      expect(payload.candidate.pack.resources[0].selectable_fields).toContain("c7");
      expect(payload.candidate.activation).toBe("disabled_unreviewed");
    } finally { await server.close(); }
    // Keep this real saved native review for independent replay.
  });
});
