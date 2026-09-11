import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { CATALOG_LIMITS, catalogResponseBytes } from "@synapsor-runner/mcp-server";
import { describe, expect, it } from "vitest";
import {
  buildAutoBoundary,
  describeExplorationBoundaryMetadata,
  explorationBoundaryCandidateDigest,
  reviewExplorationBoundaryCandidate,
  writeAutoBoundaryArtifacts,
  type ActivatedExplorationBoundary,
  type ExplorationBoundaryDraft,
} from "./auto-boundary.js";
import { commitBoundaryResourceReviewMutation, loadBoundaryResourceReviewCatalog, prepareBoundaryResourceReviewMutation, prepareBoundaryReviewMutationBatch } from "./boundary-review-mutation.js";
import { generateModelReadBoundaryRevision } from "./read-boundary-revision-model.js";
import { applyModelReadBoundaryExposureRevision, loadBoundaryReviewContext, prepareModelReadBoundaryExposureRevision } from "./boundary-commands.js";
import { reviewReadRelationship } from "./read-relationship-review.js";
import { buildActionRuleAuthoringCatalog } from "./action-rule-authoring.js";
import { rebindActionCatalogForReadPolicyRevision } from "./action-rule-read-revision.js";
import { policyCoverageDraft } from "./authoring-policy-evidence.js";
import { hasReviewedCustomerReadEntry, reviewedReadEntryPaths } from "./read-relationship-access.js";
import { refreshIncompleteReadMappingRelationships } from "./job-mapping-catalog.js";
import { rebaseSavedBoundaryForRescan } from "./boundary-library.js";
import { projectDescribeDataForModel } from "./read-catalog-presentation.js";
import { restrictPrivateFieldAnalysis } from "./read-field-privacy.js";
import { analyzeReadWorkloadSet, READ_WORKLOAD_SET_VERSION } from "./read-workload-assist.js";
import {
  assertPreparedExplorePlanAuthority,
  compileExplorePlan,
  modelWithheldExploreOutputColumns,
  projectScopedExploreResultForModel,
  validateExplorePlan,
} from "./scoped-explore.js";

const ROOT = "university.registration_cases";
const SECTION = "university.class_sections";
const COURSE = "university.courses";
const SECTION_LINK = "registration_section";
const COURSE_LINK = "registration_section__section_course";
const context = { tenant: "private-institution", principal: "private-student" };

describe("Composite Read independent safety regressions", () => {
  it("restores one host-reviewed composite path through chat without restoring other access", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-reviewed-path-restore-"));
    try {
      const inspection = studentInspection(), build = fixture(inspection, root);
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const remove = await prepareBoundaryResourceReviewMutation(root, { resource_id: ROOT,
        relationship_ids: [], actor: "synthetic-reviewer", reason: "Remove related access for this fixture." }, async () => inspection);
      await commitBoundaryResourceReviewMutation(root, remove);
      const current = await loadBoundaryReviewContext(root);
      const before = structuredClone(current.candidate);
      let calls = 0, reviews = 0;
      const revision = await generateModelReadBoundaryRevision({ instruction: "Restore only the exact section related to my registration. Preserve the other restrictions.",
        provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: current.candidate, egressAcknowledged: true,
        reviewRelationship: async request => reviewReadRelationship({ projectRoot: root, boundary: current.candidate,
          generatedBoundary: current.draft, fromResource: request.from_resource, toResource: request.to_resource,
          modelLabel: "test provider", assertCurrent: async () => {
            expect((await loadBoundaryReviewContext(root)).bundle.candidate_digest).toBe(current.bundle.candidate_digest);
          }, session: { promptText: async () => undefined, confirm: async () => false,
            chooseResource: async () => undefined, editFieldTiers: async () => undefined,
            chooseOption: async (_title, choices, options) => {
              reviews++;
              expect(JSON.stringify(options?.exactDetails)).toContain("institution_id");
              return choices.find(choice => choice.value !== "pending")!.value;
            } },
        }), dependencies: { requestJson: async () => ({ status: 200, body: { output: [{ type: "function_call",
          call_id: `restore_${++calls}`, name: "runner__submit_read_boundary_revision", arguments: JSON.stringify(calls === 1
            ? { relationship_review_request: { from_resource: ROOT, to_resource: SECTION, reason: "Restore the existing scoped association." } }
            : { resource_changes: [] }),
        }] } }) },
      });
      expect(reviews).toBe(1);
      expect(revision.policy_changes).toEqual([{ resource: ROOT, settings: { relationship_ids: [SECTION_LINK] } }]);
      const args = { projectRoot: root, context: current, schemaInspector: async () => inspection };
      const { reviewed_relationship, ...withoutReview } = revision;
      await expect(prepareModelReadBoundaryExposureRevision({ ...args, revision: withoutReview }))
        .rejects.toThrow("relationship_ids contains an identifier outside the reviewed catalog");
      await expect(prepareModelReadBoundaryExposureRevision({ ...args, revision: { ...revision,
        reviewed_relationship: { ...reviewed_relationship!, candidate_digest: `sha256:${"0".repeat(64)}` },
      } })).rejects.toThrow("READ_RELATIONSHIP_CANDIDATE_STALE");
      const preview = await prepareModelReadBoundaryExposureRevision({ ...args, revision });
      const selected = resource(build.exploration_boundary, ROOT).relationships.find(link => link.id === SECTION_LINK)!;
      expect(resource(preview.candidate, ROOT).relationships).toEqual([selected]);
      expect(selected.proof!.links[0]!.source_columns.length).toBe(2);
      for (const entry of preview.candidate.pack.resources) {
        const { relationships: _links, ...policy } = entry;
        const { relationships: _previous, ...previousPolicy } = resource(before, entry.id);
        expect(policy).toEqual(previousPolicy);
      }
      expect(preview.candidate.trusted_context).toEqual(before.trusted_context);
      expect(preview.candidate.budgets).toEqual(before.budgets);
      expect((await loadBoundaryReviewContext(root)).candidate).toEqual(before);
      const saved = await applyModelReadBoundaryExposureRevision({ ...args, revision, preview });
      expect(resource(saved.context.candidate, ROOT).relationships).toEqual([selected]);
      expect(saved.committed.authority_activated).toBe(false);
      expect(saved.committed.source_database_changed).toBe(false);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json"))).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(["none", "before", "after"] as const)("removes an entire Read resource through chat with a budget edit %s, preserving private Action facts", async budgetOrder => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-resource-exclusion-"));
    try {
      const inspection = studentInspection(), build = fixture(inspection, root);
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const before = await loadBoundaryResourceReviewCatalog(root);
      const privateCatalog = buildActionRuleAuthoringCatalog({ boundary: before.candidate, inspection }).catalog;
      const revision = await generateModelReadBoundaryRevision({
        instruction: "Keep the course catalog entirely unavailable for customer Read access. Preserve private verification.",
        provider: "openai", model: "gpt-test", apiKey: "test-key", egressAcknowledged: true,
        boundary: before.candidate, dependencies: { requestJson: async () => ({ status: 200, body: { output: [{
          type: "function_call", call_id: "remove_course_read", name: "runner__submit_read_boundary_revision",
          arguments: JSON.stringify({ resource_changes: [
            ...(budgetOrder === "before" ? [{ resource: ROOT, settings: { max_queries_per_session: 10 } }] : []),
            { resource: COURSE, settings: { exclude: true } },
            ...(budgetOrder === "after" ? [{ resource: ROOT, settings: { max_queries_per_session: 10 } }] : []),
          ] }),
        }] } }) },
      });
      const preview = await prepareModelReadBoundaryExposureRevision({ projectRoot: root,
        context: await loadBoundaryReviewContext(root), revision, schemaInspector: async () => inspection });
      expect(preview.candidate.pack.resources.some(item => item.id === COURSE)).toBe(false);
      expect(preview.candidate.budgets.max_queries_per_session).toBe(budgetOrder === "none"
        ? before.candidate.budgets.max_queries_per_session : 10);
      expect(preview.candidate.pack.resources.flatMap(item => item.relationships).some(link => link.target_resource === COURSE)).toBe(false);
      expect(() => validateExplorePlan({ kind: "rows", resource: COURSE, select: ["name"] }, facade(preview.candidate))).toThrow();
      expect(() => validateExplorePlan({ kind: "aggregate", resource: COURSE, measures: [{ op: "count", alias: "total" }] }, facade(preview.candidate))).toThrow();
      expect(() => validateExplorePlan(displayPlan(), facade(preview.candidate))).toThrow();
      const retainedCatalog = rebindActionCatalogForReadPolicyRevision({ catalog: privateCatalog, previousLock: build.lock,
        nextLock: preview.build.lock, nextBoundary: preview.candidate });
      const after = buildActionRuleAuthoringCatalog({ boundary: preview.candidate, inspection, retainedCatalog }).catalog;
      expect(after.resources).toEqual(privateCatalog.resources);
      expect(after.relationships).toEqual(privateCatalog.relationships);
      await expect(prepareModelReadBoundaryExposureRevision({ projectRoot: root,
        context: await loadBoundaryReviewContext(root), schemaInspector: async () => inspection,
        revision: { ...revision, changes: [{ resource: COURSE, field: "name", before: "model_and_runner", after: "runner_only" }] },
      })).rejects.toThrow("without field-exposure edits for the same resource");
      expect((await loadBoundaryResourceReviewCatalog(root)).candidate).toEqual(before.candidate);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json"))).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("translates related-only policy through the model tool and retains fields, paths and customer scope", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-related-policy-"));
    try {
      const inspection = studentInspection(), build = fixture(inspection, root);
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const before = await loadBoundaryResourceReviewCatalog(root);
      const revision = await generateModelReadBoundaryRevision({
        instruction: "Show course and section details only through this student's permitted registration records. Keep useful fields and private verification unchanged.",
        privacyOnly: true, provider: "openai", model: "gpt-test", apiKey: "test-key", egressAcknowledged: true,
        boundary: before.candidate, dependencies: { requestJson: async (request) => {
          expect(JSON.stringify(request.body)).toContain("reviewed_entry_paths");
          return { status: 200, body: { output: [{ type: "function_call", call_id: "related_scope",
            name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ resource_changes: [SECTION, COURSE].map((resource) =>
              ({ resource, settings: { relationship_only: true } })) }) }] } };
        } },
      });
      const preview = await prepareBoundaryReviewMutationBatch(root, revision.policy_changes!.map((change) => ({
        resource_id: change.resource, ...change.settings, actor: "synthetic-reviewer", reason: "Apply the supplied own-registration policy.",
      })), async () => inspection);
      expect(preview.semantic_diff).toEqual(expect.arrayContaining([expect.objectContaining({
        resource_id: COURSE, independent_access_change: { before: true, after: false },
      })]));
      for (const id of [SECTION, COURSE]) {
        expect(resource(preview.candidate, id)).toEqual({ ...resource(before.candidate, id), relationship_only: true });
        expect(hasReviewedCustomerReadEntry(preview.candidate, id)).toBe(true);
        expect(() => validateExplorePlan({ kind: "rows", resource: id, select: ["name"] }, facade(preview.candidate)))
          .toThrow(/only through reviewed relationships/);
      }
      expect(resource(preview.candidate, ROOT)).toEqual(resource(before.candidate, ROOT));
      expect(() => validateExplorePlan(displayPlan(), facade(preview.candidate))).not.toThrow();
      expect((await loadBoundaryResourceReviewCatalog(root)).candidate).toEqual(before.candidate);
      const evidence = policyCoverageDraft({ read: preview.candidate, actions: [], decisions: [] }).runner_evidence;
      expect(evidence.read_access[COURSE]).toMatchObject({ independently_queryable: false, customer_scoped_access: true });
      expect(evidence.runtime_contract.deployment_prerequisites.authenticated_identity.reviewed_customer_scope).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("refuses related-only narrowing with no usable root path and cannot restore independent access", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-related-missing-"));
    try {
      const inspection = studentInspection(), build = fixture(inspection, root);
      for (const item of build.exploration_boundary.pack.resources) item.relationships = [];
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const before = await loadBoundaryResourceReviewCatalog(root);
      const request = { resource_id: COURSE, relationship_only: true as const, actor: "synthetic-reviewer", reason: "Restrict course access." };
      await expect(prepareBoundaryResourceReviewMutation(root, request, async () => inspection)).rejects.toThrow("no usable reviewed path");
      await expect(prepareBoundaryResourceReviewMutation(root, { ...request, relationship_only: false } as never, async () => inspection))
        .rejects.toThrow("restoring it requires a separate scope review");
      expect((await loadBoundaryResourceReviewCatalog(root)).candidate).toEqual(before.candidate);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(["mock", ...(process.env.SYNAPSOR_TEST_READ_REVISION_LIVE === "1" ? ["terra"] : [])])(
    "narrows course access to registrations, not offers, without removing private Action verification (%s)", async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-read-entry-narrowing-"));
    try {
      const inspection = studentInspection();
      const offers = structuredClone(inspection.tables[0]!);
      offers.name = "waitlist_offers";
      offers.foreign_keys[0]!.name = "offer_section";
      offers.unique_constraints = offers.unique_constraints.map(key => ({ ...key, name: `offer_${key.name}` }));
      inspection.tables.push(offers);
      const build = fixture(inspection, root);
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const offerId = "university.waitlist_offers";
      const include = await prepareBoundaryResourceReviewMutation(root, { resource_id: offerId, include: true,
        actor: "synthetic-reviewer", reason: "Include the student's offers in the initial disabled fixture." }, async () => inspection);
      await commitBoundaryResourceReviewMutation(root, include);
      const before = await loadBoundaryResourceReviewCatalog(root);
      const privateCatalog = buildActionRuleAuthoringCatalog({ boundary: before.candidate, inspection }).catalog;
      expect(reviewedReadEntryPaths(before.candidate, COURSE).map(item => item.root_resource)).toContain(offerId);
      const changes = [
        { resource: offerId, settings: { relationship_ids: [] } },
        ...[SECTION, COURSE].map(resource => ({ resource, settings: { relationship_only: true as const } })),
      ];
      const revision = await generateModelReadBoundaryRevision({
        instruction: "Show courses and sections only through my registrations, not through waitlist offers. Keep my offers readable and private verification unchanged.",
        provider: "openai", model: mode === "terra" ? "gpt-5.6-terra" : "gpt-test",
        ...(mode === "mock" ? { apiKey: "test-key" } : {}), egressAcknowledged: true,
        boundary: before.candidate, ...(mode === "mock" ? { dependencies: { requestJson: async request => {
          const prompt = JSON.stringify(request.body);
          expect(prompt).toContain("reviewed_relationships");
          expect(prompt).toContain("offer_section__section_course");
          expect(prompt).toContain("also narrow settings.relationship_ids on each unwanted ROOT resource");
          return { status: 200, body: { output: [{
            type: "function_call", call_id: "narrow_entry_roots", name: "runner__submit_read_boundary_revision",
            arguments: JSON.stringify({ resource_changes: changes }),
          }] } };
        } } } : {}),
      });
      const preview = await prepareBoundaryReviewMutationBatch(root, revision.policy_changes!.map(change => ({
        resource_id: change.resource, ...change.settings, actor: "synthetic-reviewer", reason: "Limit related details to own registrations.",
      })), async () => inspection);
      expect(resource(preview.candidate, offerId)).toEqual({ ...resource(before.candidate, offerId), relationships: [] });
      expect(resource(preview.candidate, ROOT)).toEqual(resource(before.candidate, ROOT));
      for (const id of [SECTION, COURSE]) {
        expect(reviewedReadEntryPaths(preview.candidate, id).map(item => item.root_resource)).toEqual([ROOT]);
        expect(() => validateExplorePlan({ kind: "rows", resource: id, select: ["name"] }, facade(preview.candidate))).toThrow(/only through reviewed relationships/);
      }
      expect(() => validateExplorePlan(displayPlan(), facade(preview.candidate))).not.toThrow();
      expect(() => validateExplorePlan({ kind: "rows", resource: offerId, select: ["name"] }, facade(preview.candidate))).not.toThrow();
      expect(() => validateExplorePlan({ kind: "rows", resource: offerId, select: ["name"],
        related: [{ relationship: "offer_section", select: ["name"] }] }, facade(preview.candidate))).toThrow();
      const retainedCatalog = rebindActionCatalogForReadPolicyRevision({ catalog: privateCatalog, previousLock: build.lock,
        nextLock: preview.build.lock, nextBoundary: preview.candidate });
      const privateAfter = buildActionRuleAuthoringCatalog({ boundary: preview.candidate, inspection, retainedCatalog }).catalog;
      expect(privateAfter.resources).toEqual(privateCatalog.resources);
      expect(privateAfter.relationships).toEqual(privateCatalog.relationships);
      expect((await loadBoundaryResourceReviewCatalog(root)).candidate).toEqual(before.candidate);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json"))).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 120_000);

  it("retains private tenant tuples and scopes every hop without selecting join keys", () => {
    const { exploration_boundary: draft } = fixture();
    const boundary = facade(draft);
    const plan = validateExplorePlan(displayPlan(), boundary);
    for (const engine of ["postgres", "mysql"] as const) {
      const [query] = compileExplorePlan(plan, boundary, context, engine);
      const sql = query!.sql.replaceAll('"', "`");
      expect(sql).toContain("t0.`institution_id` = t1.`institution_id` AND t0.`section_id` = t1.`id`");
      expect(sql).toContain("t1.`institution_id` = t2.`institution_id` AND t1.`course_id` = t2.`id`");
      for (const alias of ["t0", "t1", "t2"]) expect(sql).toContain(`${alias}.\`institution_id\` =`);
      expect(query!.params.filter(value => value === context.tenant)).toHaveLength(3);
      expect(sql).toContain("t0.`student_id` =");
      expect(query!.params).toContain(context.principal);
      expect(sql.split(" FROM ")[0]).not.toMatch(/institution_id|student_id|section_id|course_id/);
      expect(query!.resources.map(resource => resource.id).sort()).toEqual([ROOT, SECTION, COURSE].sort());
    }
  });

  it.each(["source", "target"])("does not exempt a private non-tenant tuple component (%s)", side => {
    const inspection = studentInspection();
    const root = inspection.tables.find(item => item.name === "registration_cases")!;
    const target = inspection.tables.find(item => item.name === "class_sections")!;
    if (side === "source") {
      root.foreign_keys[0]!.columns[1] = "secret_note";
      target.columns.find(field => field.name === "id")!.data_type = "text";
    }
    else {
      root.foreign_keys[0]!.referenced_columns[1] = "secret_note";
      root.columns.find(field => field.name === "section_id")!.data_type = "text";
      target.unique_constraints.push({ name: "private_tuple_key", columns: ["institution_id", "secret_note"] });
    }
    const build = fixture(inspection);
    expect(resource(build.exploration_boundary, side === "source" ? ROOT : SECTION).kept_out_fields).toContain("secret_note");
    expect(resource(build.exploration_boundary, ROOT).relationships.map(item => item.id)).not.toContain(SECTION_LINK);
  });

  it("keeps target privacy separate from identically named root fields and hides equality", () => {
    const { exploration_boundary: draft } = fixture();
    resource(draft, SECTION).model_withheld_fields = ["name"];
    restrictPrivateFieldAnalysis(draft, SECTION, ["name"]);
    const boundary = facade(draft);
    const raw = { ...displayPlan(), select: ["name"] };
    const plan = validateExplorePlan(raw, boundary);
    expect(modelWithheldExploreOutputColumns(plan, boundary)).toEqual([`${SECTION_LINK}.name`]);
    const data = [0, 1].map(() => ({ name: "Public registration label", [`${SECTION_LINK}.name`]: "Private advising label",
      [`${COURSE_LINK}.name`]: "Public course title" }));
    const projected = projectScopedExploreResultForModel({ tool: "app.explore_data", arguments: { plan: raw },
      result: { ok: true, data }, boundary });
    expect(projected.withheld).toBe(true);
    const rows = projected.value.data as Array<Record<string, unknown>>;
    expect(rows[0]!.name).toBe(data[0]!.name);
    expect(rows[0]![`${COURSE_LINK}.name`]).toBe("Public course title");
    expect(rows[0]![`${SECTION_LINK}.name`]).not.toBe(rows[1]![`${SECTION_LINK}.name`]);
    expect(JSON.stringify(projected.value)).not.toContain("Private advising label");
    expect(data[0]![`${SECTION_LINK}.name`]).toBe("Private advising label");
    expect(() => validateExplorePlan({ ...raw, where: [{ relationship: SECTION_LINK, field: "name", op: "eq", value: "secret" }] }, boundary))
      .toThrow(/not reviewed/);
  });

  it.each([SECTION_LINK, COURSE_LINK])("refuses kept-out and trusted-scope output on %s", relationship => {
    const boundary = facade(fixture().exploration_boundary);
    for (const field of ["institution_id", "secret_note"]) {
      expect(() => validateExplorePlan({ ...displayPlan(), related: [{ relationship, select: [field] }] }, boundary))
        .toThrow(/not reviewed/);
    }
  });

  it("avoids collisions between selected root fields and generated SQL aliases", () => {
    const { exploration_boundary: draft } = fixture();
    const root = resource(draft, ROOT);
    const collisions = ["__synapsor_related_0_0", "__synapsor_related_0_0_", "__synapsor_subject_primary_key"];
    for (const field of collisions) { root.field_types[field] = "text"; root.selectable_fields.push(field); }
    const boundary = facade(draft);
    const plan = validateExplorePlan({ ...displayPlan(), select: collisions }, boundary);
    const [query] = compileExplorePlan(plan, boundary, context, "postgres");
    const aliases = [...query!.sql.split(" FROM ")[0]!.matchAll(/ AS "([^"]+)"/g)].map(match => match[1]);
    expect(new Set(aliases).size).toBe(aliases.length);
    expect(aliases).toContain("__synapsor_related_0_0__");
  });

  it("rejects ambiguous public output keys instead of overwriting root values", () => {
    const { exploration_boundary: draft } = fixture();
    const root = resource(draft, ROOT);
    const collision = `${SECTION_LINK}.name`;
    root.field_types[collision] = "text";
    root.selectable_fields.push(collision);
    expect(() => validateExplorePlan({ ...displayPlan(), select: [collision] }, facade(draft)))
      .toThrow(/output names must be unique/);
  });

  it("quotes complex target and field names independently of public output keys", () => {
    const inspection = studentInspection();
    const course = inspection.tables.find(table => table.name === "courses")!;
    const section = inspection.tables.find(table => table.name === "class_sections")!;
    course.schema = "University Archive";
    course.name = 'Course "Catalog"';
    const fields = ['course.title', 'quote"field', "back`tick", "Course title ".repeat(5).trim()];
    course.columns.push(...fields.map(field => column(field)));
    course.suggestions.default_visible_columns.push(...fields);
    section.foreign_keys[0]!.referenced_schema = course.schema;
    section.foreign_keys[0]!.referenced_table = course.name;
    const boundary = facade(fixture(inspection).exploration_boundary);
    const plan = validateExplorePlan({ ...displayPlan(), related: [{ relationship: COURSE_LINK, select: fields }] }, boundary);
    for (const engine of ["postgres", "mysql"] as const) {
      const [query] = compileExplorePlan(plan, boundary, context, engine);
      const quote = (value: string) => engine === "postgres" ? `"${value.replaceAll('"', '""')}"` : `\`${value.replaceAll("`", "``")}\``;
      expect(query!.sql).toContain(`${quote(course.schema)}.${quote(course.name)}`);
      for (const field of fields) expect(query!.sql).toContain(`.${quote(field)} AS`);
      const aliases = [...query!.sql.matchAll(/__synapsor_related_\d+_\d+/g)].map(match => match[0]);
      expect(aliases).toHaveLength(fields.length);
      expect(Math.max(...aliases.map(alias => alias.length))).toBeLessThan(63);
    }
  });

  it("binds join-only restrictions into the digest and rejects their removal in narrowing", () => {
    const { candidate } = narrowedFixture();
    const widened = structuredClone(candidate);
    delete resource(widened, COURSE).relationship_only;
    expect(explorationBoundaryCandidateDigest(widened)).not.toBe(explorationBoundaryCandidateDigest(candidate));
    expect(() => reviewExplorationBoundaryCandidate(candidate, widened)).toThrow(/independent query access/);
    for (const id of [SECTION, COURSE]) {
      expect(resource(candidate, id).relationship_only).toBe(true);
      for (const request of [{ kind: "rows", resource: id, select: ["name"] },
        { kind: "aggregate", resource: id, measures: [{ function: "count" }] }]) {
        expect(() => validateExplorePlan(request, facade(candidate))).toThrow(/only through reviewed relationships/);
      }
    }
  });

  it("narrows related return atoms to the correct resource and preserves the display plan", () => {
    const { analysis, candidate } = narrowedFixture();
    expect(analysis.authority_atoms).toEqual(expect.arrayContaining([
      expect.objectContaining({ root_resource: ROOT, resource: SECTION, operation: "return", relationship: SECTION_LINK, field: "name" }),
      expect.objectContaining({ root_resource: ROOT, resource: COURSE, operation: "return", relationship: COURSE_LINK, field: "name" }),
    ]));
    expect(analysis.authority_atoms.filter(atom => atom.operation === "resource").map(atom => atom.resource)).toEqual([ROOT]);
    expect(resource(candidate, SECTION).selectable_fields).toEqual(["name"]);
    expect(resource(candidate, COURSE).selectable_fields).toEqual(["name"]);
    expect(() => validateExplorePlan(displayPlan(), facade(candidate))).not.toThrow();
  });

  it("counts related fields toward the default response-cell budget and rejects duplicate paths", () => {
    const { exploration_boundary: draft } = fixture();
    draft.budgets.max_response_cells = 7;
    const boundary = facade(draft);
    expect(validateExplorePlan(displayPlan(), boundary)).toHaveProperty("limit", 2);
    expect(() => validateExplorePlan({ ...displayPlan(), related: [displayPlan().related[0], displayPlan().related[0]] }, boundary))
      .toThrow(/relationships must be unique/);
  });

  it("enforces twenty total fields and three related paths", () => {
    const { exploration_boundary: draft } = fixture();
    const target = resource(draft, COURSE);
    const fields = Array.from({ length: 20 }, (_, index) => `display_${index}`);
    for (const field of fields) { target.field_types[field] = "text"; target.selectable_fields.push(field); }
    const boundary = facade(draft);
    expect(() => validateExplorePlan({ ...displayPlan(), related: [{ relationship: COURSE_LINK, select: fields }] }, boundary)).toThrow(/20 reviewed fields in total/);
    expect(() => validateExplorePlan({ ...displayPlan(), related: [{ relationship: COURSE_LINK, select: fields.slice(0, 19) }] }, boundary)).not.toThrow();
    expect(() => validateExplorePlan({ ...displayPlan(), related: Array.from({ length: 4 }, () => displayPlan().related[0]) }, boundary)).toThrow(/related/);
  });

  it.each(["foreign_key", "uniqueness", "target_type", "target_rls", "intermediate_type"])(
    "rejects %s drift on a related-only row path", drift => {
      const inspection = studentInspection();
      const build = fixture(inspection);
      const boundary = facade(build.exploration_boundary);
      const raw = { ...displayPlan(), related: [{ relationship: COURSE_LINK, select: ["name"] }] };
      const plan = validateExplorePlan(raw, boundary);
      expect(() => assertPreparedExplorePlanAuthority(plan, { boundary, lock: build.lock, inspection })).not.toThrow();
      const changed = structuredClone(inspection);
      const target = changed.tables.find(table => table.name === "courses")!;
      const middle = changed.tables.find(table => table.name === "class_sections")!;
      if (drift === "foreign_key") middle.foreign_keys = [];
      if (drift === "uniqueness") target.unique_constraints = target.unique_constraints.filter(key => key.columns.length === 1);
      if (drift === "target_type") target.columns.find(field => field.name === "name")!.data_type = "integer";
      if (drift === "target_rls") target.row_level_security_policies![0]!.using_expression = "true";
      if (drift === "intermediate_type") middle.columns.find(field => field.name === "course_id")!.data_type = "text";
      const aggregate = validateExplorePlan({ kind: "aggregate", resource: ROOT, measures: [{ function: "count" }],
        dimensions: [{ relationship: COURSE_LINK, field: "name" }] }, boundary);
      expect(() => assertPreparedExplorePlanAuthority(aggregate, { boundary, lock: build.lock, inspection: changed })).toThrow(/stale|changed/);
      expect(() => assertPreparedExplorePlanAuthority(plan, { boundary, lock: build.lock, inspection: changed }))
        .toThrow(/stale|changed/);
    },
  );

  it("rejects target drift when a row relationship is used only in a filter", () => {
    const inspection = studentInspection();
    const build = fixture(inspection);
    const boundary = facade(build.exploration_boundary);
    const plan = validateExplorePlan({ kind: "rows", resource: ROOT, select: ["name"],
      where: [{ relationship: COURSE_LINK, field: "name", op: "eq", value: "Calculus" }] }, boundary);
    const changed = structuredClone(inspection);
    changed.tables.find(table => table.name === "courses")!.row_level_security_policies![0]!.using_expression = "true";
    expect(() => assertPreparedExplorePlanAuthority(plan, { boundary, lock: build.lock, inspection: changed })).toThrow(/stale|changed/);
  });

  it.each(["postgres", "mysql"] as const)("preserves target value allowlists while narrowing related row-return authority (%s)", engine => {
    const build = fixture();
    resource(build.exploration_boundary, COURSE).field_enums.name = ["Published course"];
    const before = facade(build.exploration_boundary);
    const [beforeQuery] = compileExplorePlan(validateExplorePlan(displayPlan(), before), before, context, engine);
    expect(beforeQuery!.params).toContain("Published course");
    const { candidate } = narrowedFixture(build);
    const after = facade(candidate);
    const [afterQuery] = compileExplorePlan(validateExplorePlan(displayPlan(), after), after, context, engine);
    expect.soft(resource(candidate, COURSE).field_enums.name).toEqual(["Published course"]);
    expect(afterQuery!.params).toContain("Published course");
    expect(afterQuery!.reviewed_value_controls).toContainEqual({
      kind: "exclude_unreviewed_rows", resource: COURSE, field: "name",
    });
  });

  it("does not make private target values model-visible during a narrowing review", () => {
    const draft = fixture().exploration_boundary;
    resource(draft, COURSE).model_withheld_fields = ["name"];
    restrictPrivateFieldAnalysis(draft, COURSE, ["name"]);
    const widened = structuredClone(draft);
    delete resource(widened, COURSE).model_withheld_fields;
    expect(() => reviewExplorationBoundaryCandidate(draft, widened)).toThrow();
  });

  it("preserves relationship_only when rebasing a saved boundary after rescan", () => {
    const build = fixture();
    const { candidate } = narrowedFixture(build);
    const rebased = rebaseSavedBoundaryForRescan({ generatedDraft: build.exploration_boundary,
      previousCandidate: candidate, boundaryName: candidate.pack.name, inspection: studentInspection() });
    for (const id of [SECTION, COURSE]) {
      expect.soft(resource(rebased, id).relationship_only, id).toBe(true);
      expect.soft(() => validateExplorePlan({ kind: "rows", resource: id, select: ["name"] }, facade(rebased)), id)
        .toThrow(/only through reviewed relationships/);
    }
  });

  it("preserves relationship_only across an unrelated ordinary review mutation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-composite-safety-"));
    try {
      const inspection = studentInspection();
      const build = fixture(inspection, root);
      const candidate = structuredClone(build.exploration_boundary);
      for (const id of [SECTION, COURSE]) resource(candidate, id).relationship_only = true;
      expect(() => reviewExplorationBoundaryCandidate(build.exploration_boundary, candidate)).not.toThrow();
      build.exploration_boundary = candidate;
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const preview = await prepareBoundaryResourceReviewMutation(root, { resource_id: ROOT,
        selectable_fields: [...resource(candidate, ROOT).selectable_fields], actor: "synthetic-reviewer",
        reason: "Retain the existing root display fields." }, async () => inspection);
      for (const id of [SECTION, COURSE]) {
        expect.soft(resource(preview.candidate, id).relationship_only, id).toBe(true);
        expect.soft(() => validateExplorePlan({ kind: "rows", resource: id, select: ["name"] }, facade(preview.candidate)), id)
          .toThrow(/only through reviewed relationships/);
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("preserves relationship_only on the resource being edited", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-composite-safety-"));
    try {
      const inspection = studentInspection();
      const build = fixture(inspection, root);
      resource(build.exploration_boundary, COURSE).relationship_only = true;
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const preview = await prepareBoundaryResourceReviewMutation(root, { resource_id: COURSE,
        selectable_fields: ["name"], actor: "synthetic-reviewer", reason: "Keep only the course display name." },
      async () => inspection);
      expect(resource(preview.candidate, COURSE)).toMatchObject({ relationship_only: true, selectable_fields: ["name"] });
      expect(() => validateExplorePlan(displayPlan(), facade(preview.candidate))).not.toThrow();
      expect(() => validateExplorePlan({ kind: "rows", resource: COURSE, select: ["name"] }, facade(preview.candidate)))
        .toThrow(/only through reviewed relationships/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("refreshes an older unfinished catalog without losing privacy or repeatedly changing the draft", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-composite-resume-"));
    try {
      const inspection = studentInspection();
      const build = fixture(inspection, root);
      for (const item of build.exploration_boundary.pack.resources) item.relationships = [];
      resource(build.exploration_boundary, COURSE).model_withheld_fields = ["name"];
      restrictPrivateFieldAnalysis(build.exploration_boundary, COURSE, ["name"]);
      resource(build.exploration_boundary, SECTION).relationship_only = true;
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const before = await loadBoundaryResourceReviewCatalog(root);
      expect(await refreshIncompleteReadMappingRelationships({ projectRoot: root, schemaInspector: async () => inspection }))
        .toEqual(expect.arrayContaining([`${ROOT}:${SECTION_LINK}`, `${ROOT}:${COURSE_LINK}`]));
      const after = await loadBoundaryResourceReviewCatalog(root);
      for (const item of after.candidate.pack.resources) {
        const withoutLinks = ({ relationships: _relationships, ...rest }: typeof item) => rest;
        expect(withoutLinks(item)).toEqual(withoutLinks(resource(before.candidate, item.id)));
      }
      expect(after.candidate.trusted_context).toEqual(before.candidate.trusted_context);
      expect(after.candidate.budgets).toEqual(before.candidate.budgets);
      expect(await refreshIncompleteReadMappingRelationships({ projectRoot: root, schemaInspector: async () => inspection })).toEqual([]);
      expect((await loadBoundaryResourceReviewCatalog(root)).bindings).toEqual(after.bindings);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("does not restore links a reviewer removed from a composite-capable catalog", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-composite-resume-curated-"));
    try {
      const inspection = studentInspection();
      await writeAutoBoundaryArtifacts({ projectRoot: root, build: fixture(inspection, root) });
      const preview = await prepareBoundaryResourceReviewMutation(root, { resource_id: ROOT,
        relationship_ids: [], actor: "synthetic-reviewer", reason: "Keep only direct registration fields." }, async () => inspection);
      await commitBoundaryResourceReviewMutation(root, preview);
      const before = await loadBoundaryResourceReviewCatalog(root);
      expect(resource(before.candidate, ROOT).relationships).toEqual([]);
      expect(await refreshIncompleteReadMappingRelationships({ projectRoot: root, schemaInspector: async () => inspection })).toEqual([]);
      expect((await loadBoundaryResourceReviewCatalog(root)).candidate).toEqual(before.candidate);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe("Composite Read lossless discovery", () => {
  it.each(["exclude", "keep_null"] as const)("fits complete nullable %s discovery without losing target grammar", choice => {
    const { raw, projected } = discoveryContract(choice);
    const baseline = projectDescribeDataForModel(raw, true, "exact");
    const before = (baseline.resources as Array<Record<string, unknown>>)[0]!;
    const after = (projected.resources as Array<Record<string, unknown>>)[0]!;
    expect(CATALOG_LIMITS.responseBytes).toBe(16 * 1024);
    expect(after.field_defaults).toEqual({ semantic_status: "descriptive_identifier" });
    expect(after.field_contract).toContain("field_defaults apply to root and relationship fields; explicit field values override defaults.");
    const relationships = (after.relationships as Array<Record<string, unknown>>);
    expect(relationships).toHaveLength(4);
    expect(relationships.filter(link => link.activation === "review_required")).toHaveLength(1);
    const pairs = [[before, after], ...(before.relationships as Array<Record<string, unknown>>).map((link, index) =>
      [link, relationships[index]!])] as Array<Array<Record<string, unknown>>>;
    for (const [original, compact] of pairs) {
      for (const key of ["id", "relationship_only", "selectable_fields", "filter_operators", "sortable_fields", "groupable_fields",
        "aggregate_measure_functions", "presence_measure_fields", "presence_measure_functions", "count_distinct_fields",
        "time_bucket_fields", "relative_time_window_fields", "field_enums", "model_withheld_fields", "related_rows",
        "derived_measures", "numeric_bands", "auto_bands", "minimum_cohort_size", "maximum_rows", "maximum_groups", "kept_out_field_count",
        "activation", "operator_review_required", "path", "path_depth", "cardinality", "counted_entity", "nullable", "unmatched_rows"]) {
        expect(compact![key], `${original!.id}.${key}`).toEqual(original![key]);
      }
      const comparable = (field: Record<string, unknown>) => {
        const { operations: _operations, plan_reference: _reference, allowed_values: _values, ...rest } = field;
        return rest;
      };
      const defaults = { ...((after.field_defaults ?? {}) as Record<string, unknown>),
        ...((compact!.field_defaults ?? {}) as Record<string, unknown>) };
      expect((compact!.fields as Array<Record<string, unknown>>).map(field => comparable({ ...defaults, ...field })))
        .toEqual((original!.fields as Array<Record<string, unknown>>).map(comparable));
    }
    expect(Buffer.byteLength(JSON.stringify(after))).toBeLessThanOrEqual(CATALOG_LIMITS.detailBytes);
    expect(catalogResponseBytes(projected, "compact")).toBeLessThanOrEqual(CATALOG_LIMITS.responseBytes);
  });

  it("does not turn missing or future target-field semantics into a permissive default", () => {
    const { raw } = discoveryContract("exclude");
    const root = (raw.resources as Array<Record<string, unknown>>)[0]!;
    const links = root.relationships as Array<Record<string, unknown>>;
    const fields = links[0]!.fields as Array<Record<string, unknown>>;
    delete fields[0]!.semantic_status;
    fields[1]!.semantic_status = "future_policy_review_required";
    fields[1]!.operations = { ...(fields[1]!.operations as Record<string, unknown>), future_operation: { maximum: 7 } };
    const output = projectDescribeDataForModel({ ...raw, catalog_version: "synapsor.scoped-catalog.v2" }, true, "exact");
    const projectedRoot = (output.resources as Array<Record<string, unknown>>)[0]!;
    const projectedLink = (projectedRoot.relationships as Array<Record<string, unknown>>)[0]!;
    const projectedFields = projectedLink.fields as Array<Record<string, unknown>>;
    const defaults = (projectedRoot.field_defaults ?? {}) as Record<string, unknown>;
    expect({ ...defaults, ...projectedFields[0] }).not.toHaveProperty("semantic_status");
    expect({ ...defaults, ...projectedFields[1] }).toMatchObject({ semantic_status: "future_policy_review_required",
      operations: { future_operation: { maximum: 7 } } });
  });
});

function discoveryContract(choice: "exclude" | "keep_null") {
  const inspection = studentInspection();
  const template = inspection.tables[2]!;
  const definitions = [
    { name: "sales_facts", links: [["store_id", "stores"], ["product_id", "products"]] },
    { name: "stores", links: [] },
    { name: "products", links: [["category_id", "categories"]] },
    { name: "categories", links: [["department_id", "departments"]] },
    { name: "departments", links: [] },
  ];
  inspection.schemas = ["public"];
  inspection.tables = definitions.map(({ name, links }) => ({
    ...structuredClone(template), schema: "public", name,
    columns: [column("id", "uuid"), column("tenant_id", "uuid", true), column("name"),
      ...links.map(([field]) => column(field!, "uuid"))],
    unique_constraints: [{ name: `${name}_pkey`, columns: ["id"] }],
    indexes: [{ name: `${name}_pkey`, columns: ["id"], unique: true }],
    foreign_keys: links.map(([field, target]) => ({ name: `${name}_${field}_fkey`, columns: [field!],
      referenced_schema: "public", referenced_table: target!, referenced_columns: ["id"], delete_rule: "RESTRICT" })),
    row_level_security_policies: [{ name: `${name}_tenant_read`, command: "SELECT", permissive: true, roles: ["app_reader"],
      using_expression: "(tenant_id = current_setting('app.tenant_id')::uuid)" }],
    suggestions: { tenant_columns: ["tenant_id"], conflict_columns: [], sensitive_columns: [],
      default_visible_columns: ["id", "tenant_id", "name", ...links.map(([field]) => field!)] },
  }));
  const facts = inspection.tables[0]!;
  facts.columns.find(field => field.name === "product_id")!.nullable = true;
  facts.columns.push(column("net_revenue_cents", "integer"), column("sold_at", "timestamp with time zone"));
  facts.suggestions.default_visible_columns.push("net_revenue_cents", "sold_at");
  const build = fixture(inspection);
  const proposed = structuredClone(build.exploration_boundary);
  for (const entry of proposed.pack.resources) for (const relationship of entry.relationships) {
    if (relationship.unmatched_rows === "review_required") relationship.unmatched_rows = choice;
  }
  const { candidate, digest } = reviewExplorationBoundaryCandidate(build.exploration_boundary, proposed);
  const raw = describeExplorationBoundaryMetadata(candidate, [resource(candidate, "public.sales_facts")], build.exploration_boundary);
  const complete = { ...raw, boundary_digest: digest, boundary_name: candidate.pack.name, active_boundary_set_digest: digest,
    resources: (raw.resources as Array<Record<string, unknown>>).map(entry => ({ ...entry, boundary_name: candidate.pack.name })),
    catalog_version: "synapsor.scoped-catalog.v2", discovery: { mode: "detail", eligibility: "not_checked",
      next_step: "Search or browse a shortlist, request exact details, then use the selected contract. Discovery grants no authority." },
    source_database_changed: false };
  return { raw, projected: projectDescribeDataForModel(complete, true, "exact") };
}

function displayPlan() {
  return { kind: "rows", resource: ROOT, select: ["name"], related: [
    { relationship: SECTION_LINK, select: ["name"] }, { relationship: COURSE_LINK, select: ["name"] },
  ] };
}

function narrowedFixture(build = fixture()) {
  const analysis = analyzeReadWorkloadSet({ generatedBoundary: build.exploration_boundary, workload: {
    schema_version: READ_WORKLOAD_SET_VERSION, name: "student_display", source: { kind: "operator_exact_plan" },
    allowed: [{ id: "registration_display", description: "Return my registration, section and course display details.", plan: displayPlan() }],
    forbidden: [{ id: "all_courses", description: "No unrelated course roots.", plan: { kind: "rows", resource: COURSE, select: ["name"] } }],
  } });
  expect(analysis.blockers).toEqual([]);
  expect(analysis.candidate).toBeDefined();
  return { analysis, candidate: analysis.candidate! };
}

function resource(draft: ExplorationBoundaryDraft, id: string) {
  const found = draft.pack.resources.find(item => item.id === id);
  if (!found) throw new Error(`Synthetic resource missing: ${id}`);
  return found;
}

// In-memory unit-test facade only; never persisted or passed to activation helpers.
function facade(draft: ExplorationBoundaryDraft): ActivatedExplorationBoundary {
  const { unresolved_decisions: _decisions, ...rest } = draft;
  return { ...rest, activation: { state: "active", actor: "synthetic-unit-test", activated_at: "2026-09-09T00:00:00.000Z",
    digest: explorationBoundaryCandidateDigest(draft), generation_lock_fingerprint: draft.generation_lock_fingerprint, reviewed_decisions: [] } };
}

function fixture(inspection = studentInspection(), root = "/tmp/synapsor-composite-read-in-memory") {
  return buildAutoBoundary({ inspection, sourceEnv: "DATABASE_URL", inspectedSchema: inspection.schemas[0],
    project: { root, package_manager: "pnpm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
}

function studentInspection(): SchemaInspection {
  const tables: SchemaInspection["tables"] = ["registration_cases", "class_sections", "courses"].map(name => ({
    schema: "university", name, type: "table", writable: false,
    columns: [column("id", "uuid"), column("institution_id", "uuid", true), column("name"), column("secret_note", "text", false, true)],
    primary_key: ["id"], unique_constraints: [{ name: `${name}_pkey`, columns: ["id"] },
      { name: `${name}_institution_id_key`, columns: ["institution_id", "id"] }],
    foreign_keys: [], indexes: [], row_level_security: true,
    row_level_security_policies: [{ name: "tenant_read", command: "SELECT", permissive: true, roles: ["app_reader"],
      using_expression: "institution_id = current_setting('app.tenant_id')::uuid" }],
    role_posture: { owner: "app_owner", current_role_is_owner: false, current_role_can_assume_owner: false,
      row_security_forced: true, row_security_effective_for_current_role: true,
      privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false } },
    suggestions: { tenant_columns: ["institution_id"], conflict_columns: [], sensitive_columns: ["secret_note"],
      default_visible_columns: ["id", "institution_id", "name"] },
  }));
  for (const [index, field, target, constraint] of [[0, "section_id", "class_sections", SECTION_LINK],
    [1, "course_id", "courses", "section_course"]] as const) {
    tables[index]!.columns.push(column(field, "uuid"));
    tables[index]!.suggestions.default_visible_columns.push(field);
    tables[index]!.foreign_keys.push({ name: constraint, columns: ["institution_id", field], referenced_schema: "university",
      referenced_table: target, referenced_columns: ["institution_id", "id"], delete_rule: "RESTRICT" });
  }
  tables[0]!.columns.push(column("student_id", "uuid"));
  tables[0]!.suggestions.default_visible_columns.push("student_id");
  tables[0]!.row_level_security_policies![0]!.using_expression += " AND student_id = current_setting('app.principal_id')::uuid";
  return { engine: "postgres", server_version: "PostgreSQL 16", current_user: "app_reader", inspected_at: "2026-09-09T00:00:00.000Z",
    schemas: ["university"], warnings: [], tables,
    role_posture: { verified: true, superuser: false, bypass_rls: false, read_only: true, writable_relations: [], owned_relations: [], reasons: [] } };
}

function column(name: string, data_type = "text", tenant = false, sensitive = false) {
  return { name, data_type, nullable: false, generated: false, ordinal_position: 1,
    suggestions: { tenant, sensitive, conflict: false, immutable: data_type === "uuid", large_or_binary: false } };
}
