import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { buildAutoBoundary, explorationBoundaryCandidateDigest, writeAutoBoundaryArtifacts } from "./auto-boundary.js";
import { boundaryReviewCommand, loadBoundaryReviewContext, prepareModelReadBoundaryExposureRevision, applyModelReadBoundaryExposureRevision, formatReadActivationBusinessSummary } from "./boundary-commands.js";
import type { BoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { commitExactBoundaryCandidateMutation, commitBoundaryReviewMutationBatch, prepareBoundaryReviewMutationBatch, prepareExactBoundaryCandidateMutation } from "./boundary-review-mutation.js";
import { prepareReviewedReadCurrentStatePrerequisite } from "./read-prerequisite.js";
import { prepareReadPrerequisiteRevision, readPrerequisiteRevisionLines } from "./read-prerequisite-revision.js";
import { readRevisionDiff, readBoundaryReviewSections, findReviewSection, reviewSectionLines } from "./read-boundary-review-view.js";
import { policyCoverageDraft } from "./authoring-policy-evidence.js";

describe("private Read condition disabled revisions", () => {
  it.each([false, true, undefined, "changed"] as const)("reviews saved private metadata before a new model receives it (allowed: %s)", async allowed => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-read-condition-host-egress-"));
    try {
      const inspection = fixture();
      const build = buildAutoBoundary({ inspection, sourceEnv: "DATABASE_URL", inspectedSchema: "school",
        project: { root, package_manager: "pnpm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await commitBoundaryReviewMutationBatch(root, await prepareBoundaryReviewMutationBatch(root, [
        { resource_id: "school.records", principal_key: "principal_id", actor: "synthetic-unit-reviewer", reason: "Review direct scope." },
        { resource_id: "school.admissions", exclude: true, actor: "synthetic-unit-reviewer", reason: "Private evidence only." },
      ], async () => inspection));
      const previous = await loadBoundaryReviewContext(root);
      const prerequisite = prepareReviewedReadCurrentStatePrerequisite({
        source: { schema: "school", table: "admissions" },
        subject: { tenant_column: "tenant_id", principal_column: "principal_id", unique_constraint: "admissions_subject_key" },
        current_state: { state_column: "status", positive_state: "admitted", effective_from_column: "valid_from", effective_until_column: "valid_until",
          interval: "[effective_from,effective_until)", clock: "database_utc" },
        semantic_consent: { source_description: "Registrar-maintained current admission record.", positive_state_description: "Only admitted is positive admission.", confirmed: true },
      }, inspection, previous.candidate);
      await commitExactBoundaryCandidateMutation(root, await prepareReadPrerequisiteRevision({ projectRoot: root,
        previous: previous.candidate, prerequisite, bindings: previous.bundle.mutation_bindings,
        actor: "synthetic-unit-reviewer", schemaInspector: async () => inspection }));
      const saved = await loadBoundaryReviewContext(root);
      const details = vi.fn();
      const narrator = vi.fn(async () => "What should change?");
      const mapper = vi.fn();
      const confirm = vi.fn(async (prompt: string, options?: { context?: string[] }) => {
        expect(prompt).toContain("reviewed structural context");
        expect(options?.context?.join(" ")).toContain("saved private access-check mapping");
        expect(details).toHaveBeenCalledWith("MODEL METADATA EGRESS", expect.arrayContaining([
          expect.stringContaining('"table": "admissions"'),
          expect.stringContaining('"unique_constraint": "admissions_subject_key"'),
          expect.stringContaining("Registrar-maintained current admission record."),
        ]));
        expect(narrator).not.toHaveBeenCalled();
        expect(mapper).not.toHaveBeenCalled();
        expect(options).toMatchObject({ defaultValue: false });
        if (allowed === "changed") {
          const replacement = prepareReviewedReadCurrentStatePrerequisite({
            ...prerequisite,
            semantic_consent: { ...prerequisite.semantic_consent,
              source_description: "New registrar-maintained meaning awaiting this model's permission." },
          }, inspection, saved.candidate);
          await commitExactBoundaryCandidateMutation(root, await prepareReadPrerequisiteRevision({ projectRoot: root,
            previous: saved.candidate, prerequisite: replacement, bindings: saved.bundle.mutation_bindings,
            actor: "synthetic-unit-reviewer", schemaInspector: async () => inspection }));
          return true;
        }
        return allowed;
      });
      const session: BoundaryReviewInteractiveSession = {
        chooseResource: async () => undefined, editFieldTiers: async () => undefined,
        promptText: async () => undefined, confirm, confirmActivation: async () => false,
        chooseOption: async title => title === "START BOUNDARY DRAFTING" ? "model"
          : title === "MODEL REQUEST NOT STARTED" ? "back" : undefined,
      };
      const chat: BoundaryAuthoringChat = {
        session: { ...session, presentationMode: "conversation" },
        actionPrompter: { choose: async () => undefined, text: async () => undefined,
          confirm: async () => undefined, message: async () => undefined },
        setModel: vi.fn(), setPermissionGuide: vi.fn(), runner: vi.fn(), model: vi.fn(), checkpoint: vi.fn(),
        streamRunner: async () => undefined, streamCheckpoint: async () => undefined, streamModel: async () => undefined,
        rememberDetails: details, showDetails: vi.fn(), providerStream: vi.fn(),
        progress: async (_message, operation) => operation(), close: vi.fn(),
      };
      const result = boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], async () => inspection, session, undefined, {
        startWithAgentJob: true,
        modelAuthoringSession: { provider: "anthropic", model: "new-provider-model", apiKey: "synthetic-key" },
        modelAuthoringNarrator: narrator, modelReadWorkloadGenerator: mapper, boundaryAuthoringChatFactory: () => chat,
      });
      if (allowed === "changed") await expect(result).rejects.toThrow("PRIVATE_READ_METADATA_CHANGED");
      else expect(await result).toBe(0);
      expect(confirm).toHaveBeenCalledOnce();
      // Metadata permission alone does not start generation. The operator
      // cancelled the new job prompt, so neither path opens a narrator.
      expect(narrator).not.toHaveBeenCalled();
      expect(mapper).not.toHaveBeenCalled();
      const current = (await loadBoundaryReviewContext(root)).candidate;
      if (allowed === "changed") expect(current.read_prerequisite?.semantic_consent.source_description)
        .toBe("New registrar-maintained meaning awaiting this model's permission.");
      else expect(current).toEqual(saved.candidate);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json"))).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("publishes a model privacy edit and private condition together only after dependency validation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-read-condition-model-"));
    try {
      const inspection = fixture();
      const build = buildAutoBoundary({ inspection, sourceEnv: "DATABASE_URL", inspectedSchema: "school",
        project: { root, package_manager: "pnpm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await commitBoundaryReviewMutationBatch(root, await prepareBoundaryReviewMutationBatch(root, [
        { resource_id: "school.records", principal_key: "principal_id", actor: "synthetic-unit-reviewer", reason: "Review direct scope." },
        { resource_id: "school.admissions", exclude: true, actor: "synthetic-unit-reviewer", reason: "Private evidence only." },
      ], async () => inspection));
      const context = await loadBoundaryReviewContext(root);
      expect(context.candidate.pack.resources[0]!.kept_out_fields).not.toContain("status");
      const prerequisite = prepareReviewedReadCurrentStatePrerequisite({
        source: { schema: "school", table: "admissions" },
        subject: { tenant_column: "tenant_id", principal_column: "principal_id", unique_constraint: "admissions_subject_key" },
        current_state: { state_column: "status", positive_state: "admitted", effective_from_column: "valid_from", effective_until_column: "valid_until",
          interval: "[effective_from,effective_until)", clock: "database_utc" },
        semantic_consent: { source_description: "Registrar-maintained current admission record.", positive_state_description: "Only admitted is positive admission.", confirmed: true },
      }, inspection, context.candidate);
      const revision = { changes: [{ resource: "school.records", field: "status", before: "model_and_runner" as const,
        after: "runner_only" as const, model_operations: "none" as const }], read_prerequisite: prerequisite };
      const inputs = { projectRoot: root, context, revision, schemaInspector: async () => inspection };
      await expect(prepareModelReadBoundaryExposureRevision({ ...inputs, validateCandidate: () => { throw new Error("Synthetic dependent Action mismatch"); } }))
        .rejects.toThrow("dependent Action mismatch");
      expect((await loadBoundaryReviewContext(root)).candidate).toEqual(context.candidate);
      let checked = false;
      const preview = await prepareModelReadBoundaryExposureRevision({ ...inputs, validateCandidate: candidate => {
        checked = true;
        expect(candidate.read_prerequisite).toEqual(prerequisite);
        expect(candidate.pack.resources[0]!.model_withheld_fields).toContain("status");
      } });
      expect(checked).toBe(true);
      expect((await loadBoundaryReviewContext(root)).candidate).toEqual(context.candidate);
      const result = await applyModelReadBoundaryExposureRevision({ ...inputs, preview });
      expect(result.context.candidate.read_prerequisite).toEqual(prerequisite);
      expect(result.context.candidate.pack.resources[0]!.model_withheld_fields).toContain("status");
      expect(result.context.candidate.pack.resources.some(resource => resource.id === "school.admissions")).toBe(false);
      expect(result.committed.authority_activated).toBe(false);
      expect(result.committed.source_database_changed).toBe(false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("saves a verified condition, retains it through privacy edits, and refuses implicit removal", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-read-condition-"));
    try {
      const inspection = fixture();
      const build = buildAutoBoundary({ inspection, sourceEnv: "DATABASE_URL", inspectedSchema: "school",
        project: { root, package_manager: "pnpm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const scoped = await prepareBoundaryReviewMutationBatch(root, [
        { resource_id: "school.records", principal_key: "principal_id", actor: "synthetic-unit-reviewer", reason: "Review exact direct student scope in the fixture." },
        { resource_id: "school.admissions", exclude: true, actor: "synthetic-unit-reviewer", reason: "No public admission queries." },
      ], async () => inspection);
      await commitBoundaryReviewMutationBatch(root, scoped);
      const previous = await loadBoundaryReviewContext(root);
      const prerequisite = prepareReviewedReadCurrentStatePrerequisite({
        source: { schema: "school", table: "admissions" },
        subject: { tenant_column: "tenant_id", principal_column: "principal_id", unique_constraint: "admissions_subject_key" },
        current_state: { state_column: "status", positive_state: "admitted", effective_from_column: "valid_from", effective_until_column: "valid_until",
          interval: "[effective_from,effective_until)", clock: "database_utc" },
        semantic_consent: { source_description: "Registrar-maintained current admission record.", positive_state_description: "Only admitted is positive admission.", confirmed: true },
      }, inspection, previous.candidate);
      const preview = await prepareReadPrerequisiteRevision({ projectRoot: root, previous: previous.candidate, prerequisite,
        bindings: previous.bundle.mutation_bindings, actor: "synthetic-unit-reviewer", schemaInspector: async () => inspection });
      expect(preview.candidate.pack).toEqual(previous.candidate.pack);
      expect(preview.candidate_digest).not.toBe(previous.bundle.candidate_digest);
      expect(readPrerequisiteRevisionLines(previous.candidate, preview.candidate).join(" ")).toContain("before every data query");
      const diff = readRevisionDiff(previous.candidate, preview.candidate);
      expect(diff.lines.join(" ")).toContain("Access condition:");
      expect(diff.lines.join(" ")).not.toContain("No new information becomes readable by Runner");
      expect(reviewSectionLines(diff).join(" ")).toContain("admissions_subject_key");
      expect((await loadBoundaryReviewContext(root)).candidate).toEqual(previous.candidate);
      await commitExactBoundaryCandidateMutation(root, preview);
      const saved = await loadBoundaryReviewContext(root);
      expect(saved.candidate.read_prerequisite).toEqual(prerequisite);
      const accessDetails = findReviewSection(readBoundaryReviewSections({ boundary: saved.candidate, digest: saved.bundle.candidate_digest }), "private_access_condition")!;
      expect(accessDetails.lines.join(" ")).toContain("admissions_subject_key");
      expect(accessDetails.lines.join(" ")).toContain("Registrar-maintained current admission");
      const summary = formatReadActivationBusinessSummary(saved.bundle).join(" ");
      expect(summary).toContain("before every data query");
      expect(summary).not.toContain("admissions_subject_key");
      expect(policyCoverageDraft({ read: saved.candidate, decisions: [], actions: [] }).runner_evidence.runtime_contract.read_eligibility)
        .toMatchObject({ configured_current_state_prerequisite: prerequisite, action_requirements_apply_to_reads: false });
      expect(saved.candidate.pack.resources.some(resource => resource.id === "school.admissions")).toBe(false);
      const privacy = await prepareBoundaryReviewMutationBatch(root, [{ resource_id: "school.records", withhold_from_model_fields: ["display_name"],
        actor: "synthetic-unit-reviewer", reason: "Keep display names private in this test revision." }], async () => inspection);
      expect(privacy.candidate.read_prerequisite).toEqual(prerequisite);
      await commitBoundaryReviewMutationBatch(root, privacy);
      const current = await loadBoundaryReviewContext(root);
      const removed = structuredClone(current.candidate);
      delete removed.read_prerequisite;
      await expect(prepareExactBoundaryCandidateMutation(root, { candidate: removed,
        expected_generated_boundary_digest: explorationBoundaryCandidateDigest(current.candidate),
        expected_candidate_digest: explorationBoundaryCandidateDigest(removed), expected_bindings: current.bundle.mutation_bindings,
        actor: "synthetic-unit-reviewer", reason: "Attempt accidental loss of the condition." }, async () => inspection))
        .rejects.toThrow("READ_PREREQUISITE_REVISION_REQUIRED");
      expect((await loadBoundaryReviewContext(root)).candidate).toEqual(current.candidate);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json"))).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

function fixture(): SchemaInspection {
  const tables: SchemaInspection["tables"] = ["records", "admissions"].map(name => ({
    schema: "school", name, type: "table", writable: false,
    primary_key: ["record_id"], unique_constraints: [{ name: `${name}_pkey`, columns: ["record_id"] },
      { name: `${name}_subject_key`, columns: ["tenant_id", "principal_id"] }], foreign_keys: [], indexes: [],
    columns: [column("record_id", "uuid"), column("tenant_id", "uuid"), column("principal_id", "uuid"), column("display_name", "text"),
      { ...column("status", "text"), enum_values: ["admitted", "withdrawn"] },
      column("valid_from", "timestamp with time zone"), column("valid_until", "timestamp with time zone")],
    row_level_security: true,
    row_level_security_policies: [{ name: `${name}_scope`, command: "SELECT", permissive: true, roles: ["reader"],
      using_expression: "tenant_id::text = current_setting('app.tenant') AND principal_id::text = current_setting('app.principal')" }],
    role_posture: { owner: "owner", current_role_is_owner: false, current_role_can_assume_owner: false,
      row_security_forced: true, row_security_effective_for_current_role: true,
      privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false } },
    suggestions: { tenant_columns: ["tenant_id"], conflict_columns: [], sensitive_columns: [], default_visible_columns: ["display_name", "status"] },
  }));
  tables.find(table => table.name === "admissions")!.foreign_keys = [{
    name: "admissions_record_subject_fkey", columns: ["tenant_id", "principal_id"],
    referenced_schema: "school", referenced_table: "records", referenced_columns: ["tenant_id", "principal_id"],
    delete_rule: "RESTRICT",
  }];
  return { engine: "postgres", server_version: "PostgreSQL 16", current_user: "reader", inspected_at: "2026-09-10T00:00:00.000Z",
    schemas: ["school"], warnings: [], tables,
    role_posture: { verified: true, superuser: false, bypass_rls: false, read_only: true, writable_relations: [], owned_relations: [], reasons: [] } };
}

function column(name: string, data_type: string) {
  return { name, data_type, nullable: false, generated: false, ordinal_position: 1,
    suggestions: { tenant: name === "tenant_id", sensitive: false, conflict: false, immutable: data_type === "uuid", large_or_binary: false } };
}
