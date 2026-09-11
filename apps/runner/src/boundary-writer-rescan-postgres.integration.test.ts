import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { inspectDatabase, schemaFingerprintForInspection as schemaFingerprint, rolePostureFingerprint } from "@synapsor-runner/schema-inspector";
import { activateExplorationBoundary, buildAutoBoundary, compareGenerationLock, loadActivatedExplorationBoundaries,
  reviewExplorationBoundaryCandidate, writeAutoBoundaryArtifacts } from "./auto-boundary.js";
import { boundaryCommand } from "./guided-start.js";
import { boundaryReviewCommand, loadBoundaryReviewContext } from "./boundary-commands.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import type { BoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import { createBoundaryReviewProgress } from "./boundary-review-domain.js";
import { saveBoundaryReviewProgress } from "./boundary-review-persistence.js";
import { buildActionRuleAuthoringCatalog } from "./action-rule-authoring.js";
import { compileActionRuleModelDraft, type ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { buildActionRuleAuthorityDraft, readActionRuleAuthorityDraft, readActionRuleAuthorityActivation,
  writeActionRuleAuthorityDraft } from "./action-rule-authority.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState,
  writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { inspectDraftSemanticWriter } from "./semantic-action-deployment.js";
import { exportWriterProvisioning } from "./writer-provisioning.js";

// Own container and empty existing test schema; metadata authoring, not runtime qualification.
describe.skipIf(process.env.SYNAPSOR_TEST_BOUNDARY_WRITER_RESCAN_LIVE !== "1")("owned PostgreSQL writer metadata rescan", () => {
  it("revalidates private disabled Action dependencies after separately reviewed grants and RLS without changing active Read", async () => {
    const name = `synapsor-gate1-rescan-${randomUUID().slice(0, 8)}`;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-gate1-rescan-"));
    const readEnv = "SYNAPSOR_GATE1_RESCAN_READ_URL";
    const previousEnv = process.env[readEnv];
    let started = false, admin: Pool | undefined;
    try {
      execFileSync("docker", ["run", "--rm", "-d", "--name", name, "--label", "synapsor.test=gate1-writer-rescan",
        "-e", "POSTGRES_PASSWORD=fixture", "-e", "POSTGRES_DB=maintenance", "-p", "127.0.0.1::5432", "postgres:17"], { stdio: "pipe" });
      started = true;
      const port = Number(execFileSync("docker", ["port", name, "5432/tcp"], { encoding: "utf8" }).trim().split(":").at(-1));
      admin = new Pool({ host: "127.0.0.1", port, database: "maintenance", user: "postgres", password: "fixture", connectionTimeoutMillis: 1000 });
      for (let attempt = 0; ; attempt++) {
        try { await admin.query("SELECT 1"); break; }
        catch (error) { if (attempt === 60) throw error; await sleep(250); }
      }
      await admin.query(`CREATE ROLE app_reader LOGIN PASSWORD 'fixture' NOSUPERUSER NOINHERIT NOBYPASSRLS;
        CREATE TYPE public.visit_status AS ENUM ('scheduled', 'completed');
        CREATE TYPE public.request_kind AS ENUM ('inspection_followup', 'repair');
        CREATE TABLE public.service_visits (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
          principal_id uuid NOT NULL, status public.visit_status NOT NULL, scheduled_at timestamptz NOT NULL,
          UNIQUE (tenant_id, principal_id, id));
        CREATE TABLE public.visit_facts (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, principal_id uuid NOT NULL,
          status public.visit_status NOT NULL,
          CONSTRAINT visit_facts_visit_fk FOREIGN KEY (tenant_id, principal_id, id)
            REFERENCES public.service_visits (tenant_id, principal_id, id));
        CREATE TABLE public.maintenance_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
          principal_id uuid NOT NULL, request_kind public.request_kind NOT NULL, estimated_hours integer NOT NULL CHECK (estimated_hours BETWEEN 1 AND 8));
        GRANT USAGE ON SCHEMA public TO app_reader;
        GRANT SELECT ON public.service_visits, public.visit_facts, public.maintenance_requests TO app_reader;`);
      for (const table of ["service_visits", "visit_facts", "maintenance_requests"]) {
        await admin.query(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;
          ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY;
          CREATE POLICY reader_scope ON public.${table} FOR SELECT TO app_reader USING
            (tenant_id = current_setting('app.tenant_id', true)::uuid AND principal_id = current_setting('app.principal_id', true)::uuid);`);
      }
      process.env[readEnv] = `postgresql://app_reader:fixture@127.0.0.1:${port}/maintenance`;
      const inspect = () => inspectDatabase({ engine: "postgres", databaseUrlEnv: readEnv, schema: "public" });
      const initial = await inspect();
      expect(initial.current_user).toBe("app_reader");
      expect(initial.role_posture).toMatchObject({ read_only: true, bypass_rls: false, superuser: false });
      const build = buildAutoBoundary({ inspection: initial, project: { root, package_manager: "npm", frameworks: ["node"],
        schema_inputs: [], database_env_names: [readEnv] }, sourceEnv: readEnv, inspectedSchema: "public" });
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const initialContext = await loadBoundaryReviewContext(root);
      const completeCatalog = buildActionRuleAuthoringCatalog({ boundary: initialContext.candidate, inspection: initial });
      const candidate = structuredClone(initialContext.candidate);
      candidate.pack.resources = candidate.pack.resources.filter(resource => resource.id !== "public.visit_facts");
      const reviewed = reviewExplorationBoundaryCandidate(initialContext.draft, candidate);
      await saveBoundaryReviewProgress(root, createBoundaryReviewProgress({ draft: initialContext.draft, candidate: reviewed.candidate,
        confirmedDecisions: reviewed.candidate.unresolved_decisions, actor: "test-reviewer", reason: "Keep visit facts private for verification.",
        revision: (initialContext.progress?.revision ?? 0) + 1 }));
      const context = await loadBoundaryReviewContext(root);
      const catalog = buildActionRuleAuthoringCatalog({ boundary: context.candidate, inspection: initial, retainedCatalog: completeCatalog.catalog });
      const type = (resource: string, field: string) => structuredClone(catalog.catalog.resources.find(entry => entry.name === resource)!.fields.find(entry => entry.name === field)!.type);
      const outcome = "maintenance.create_inspection_followup";
      const draft: ActionRuleModelDraftV1 = {
        schema_version: "synapsor.action-rule-model-draft.v1", name: outcome, outcome,
        verification: { name: `${outcome}.verification`, resources: [
          { binding: "visit", resource: "public.service_visits", source: { kind: "subject_ref" }, fields: ["status"] },
          { binding: "facts", resource: "public.visit_facts", source: { kind: "relationship", from_binding: "visit",
            relationship: "visit_facts_visit_fk", direction: "inverse" }, fields: ["status"], max_rows: 1 },
        ] },
        effect: { name: `${outcome}.effect`, operation: "insert", target_resource: "public.maintenance_requests",
          allowed_fields: [{ name: "request_kind", values: ["inspection_followup"] }, { name: "estimated_hours", minimum: 1, maximum: 8 }],
          set: { request_kind: { kind: "literal", value: "inspection_followup", value_type: type("public.maintenance_requests", "request_kind") },
            estimated_hours: { kind: "literal", value: 2, value_type: type("public.maintenance_requests", "estimated_hours") } }, writeback: "supervised" },
        require: { kind: "all", expressions: [
          { kind: "compare", operator: "eq", left: { kind: "field", binding: "visit", field: "status" },
            right: { kind: "literal", value: "scheduled", value_type: type("public.service_visits", "status") } },
          { kind: "exists", binding: "facts", where: { kind: "compare", operator: "eq", left: { kind: "field", binding: "facts", field: "status" },
            right: { kind: "literal", value: "scheduled", value_type: type("public.visit_facts", "status") } } },
        ] },
        derive: {}, approval: { class_name: `${outcome}.approval`, mode: "human", required_role: "maintenance_reviewer", required_approvals: 1, shared_limits: [] },
        ttl_seconds: 300, review: { when: "The visit and its private fact are scheduled.", then: "Propose one two-hour inspection follow-up.",
          refused: ["Either record is not scheduled."], human_review: "One maintenance reviewer approves.",
          examples: [{ kind: "eligible", scenario: "Both records scheduled", result: "Propose" }, { kind: "ineligible", scenario: "Visit completed", result: "Refuse" }] },
      };
      const compiled = compileActionRuleModelDraft({ draft, builtCatalog: catalog, readBoundary: context.candidate, readBoundaryDigest: context.bundle.candidate_digest });
      const saved = buildActionRuleAuthorityDraft({ name: "reviewed_staging_rules", action_boundary_name: "reviewed_staging_actions",
        catalog: compiled.loaded.authority.catalog, rules: compiled.loaded.authority.rules,
        approval_classes: compiled.loaded.authority.approval_classes, reviews: [{ outcome, ...compiled.review }] });
      await writeActionRuleAuthorityDraft(root, saved);
      await activateExplorationBoundary({ projectRoot: root, candidate: context.candidate, expectedDigest: context.bundle.candidate_digest,
        actor: "test-reviewer", confirmation: `ACTIVATE ${context.bundle.candidate_digest}`,
        confirmedDecisions: context.candidate.unresolved_decisions, currentInspection: initial });
      const active = await loadActivatedExplorationBoundaries(root);
      const unfinished = { intent: "Prepare a separate repair only after the owner supplies its approval limit.", strategy: "rule_derived" as const };
      const conversation = [{ question: "What are visit facts?", answer: "Private supporting facts for the same tenant, principal and visit.", kind: "clarification" as const }];
      await writeBoundaryAuthoringResumeState(root, buildBoundaryAuthoringResumeState({
        binding: { boundary_name: context.candidate.pack.name, generation_lock_fingerprint: context.candidate.generation_lock_fingerprint,
          schema_fingerprint: context.lock.schema_fingerprint, role_posture_fingerprint: context.lock.role_posture_fingerprint },
        stage: "authority_review", jobIntent: "Keep the prepared visit outcome and the unfinished repair decision.",
        provider: "openai", model: "gpt-test", action: unfinished, conversation,
      }));
      const checked = await inspectDraftSemanticWriter({ draft: saved,
        reads: active.map(read => ({ pack: read.pack, digest: read.activation.digest })), engine: "postgres",
        readUrlEnv: readEnv, writeUrlEnv: "SYNAPSOR_GATE1_RESCAN_WRITE_URL", requirementsOnly: true });
      expect(checked?.writer_status).toBe("not_checked");
      if (!checked?.plan) throw new Error("Expected metadata-only writer handoff");
      const handoff = await exportWriterProvisioning(root, checked.plan);
      const evidence = process.env.SYNAPSOR_TEST_EVIDENCE_DIR;
      if (evidence) for (const file of await fs.readdir(handoff)) {
        await fs.copyFile(path.join(handoff, file), path.join(evidence, `gate1-rescan-${file}`));
      }
      const grants = await fs.readFile(path.join(handoff, "grants.sql"), "utf8");
      expect(await fs.readdir(handoff), await fs.readFile(path.join(handoff, "README.md"), "utf8")).toContain("scoped-policies.sql");
      const policies = await fs.readFile(path.join(handoff, "scoped-policies.sql"), "utf8");
      expect(checked.plan.relations.map(relation => relation.relation).sort()).toEqual(["public.maintenance_requests", "public.service_visits", "public.visit_facts"]);
      expect(grants).toContain('GRANT INSERT ON TABLE "public"."maintenance_requests"');
      expect(grants).toContain('GRANT UPDATE ("id") ON TABLE "public"."visit_facts"');
      expect(grants).not.toMatch(/GRANT UPDATE ON|GRANT DELETE|GRANT ALL|ALTER TABLE/);
      expect(policies).toContain("app.tenant_id"); expect(policies).toContain("app.principal_id");
      expect(policies).not.toMatch(/DROP POLICY|DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY/);
      const beforeAdmin = await inspect();
      expect(schemaFingerprint(beforeAdmin)).toBe(schemaFingerprint(initial));
      expect(await readActionRuleAuthorityDraft(root, saved.authority.name)).toEqual(saved);
      // Explicit test administrator review above. Only this new empty container is targeted.
      for (const sql of [grants, policies]) execFileSync("docker", ["exec", "-i", name, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "maintenance"], { input: sql, stdio: ["pipe", "pipe", "pipe"] });
      const afterAdmin = await inspect();
      expect(schemaFingerprint(afterAdmin)).not.toBe(schemaFingerprint(initial));
      expect(compareGenerationLock(context.lock, afterAdmin).current).toBe(false);
      expect(afterAdmin.current_user).toBe("app_reader");
      expect(afterAdmin.role_posture).toMatchObject({ read_only: true, writable_relations: [] });
      for (const table of afterAdmin.tables) {
        expect(table.row_level_security).toBe(true);
        expect(table.role_posture?.row_security_forced).toBe(true);
        expect(table.row_level_security_policies).toEqual(expect.arrayContaining(initial.tables.find(entry => entry.name === table.name)!.row_level_security_policies!));
        expect(table.row_level_security_policies?.some(policy => policy.roles.includes(checked.plan!.suggested_role))).toBe(true);
      }
      await expect(boundaryCommand(["rescan", "--from-env", readEnv, "--project-root", root])).resolves.toBe(0);
      const rescanned = await loadBoundaryReviewContext(root);
      expect(compareGenerationLock(rescanned.lock, afterAdmin).current).toBe(true);
      expect(rescanned.lock.schema_fingerprint).toBe(schemaFingerprint(afterAdmin));
      expect(rescanned.lock.role_posture_fingerprint).toBe(rolePostureFingerprint(afterAdmin));
      expect(rescanned.candidate.generation_lock_fingerprint).not.toBe(context.candidate.generation_lock_fingerprint);
      expect(rescanned.candidate.pack.resources.some(resource => resource.id === "public.visit_facts")).toBe(false);
      expect(await loadActivatedExplorationBoundaries(root)).toEqual(active);
      expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
      const details: unknown[] = [];
      const session: BoundaryReviewInteractiveSession = {
        chooseResource: async () => undefined, editFieldTiers: async () => undefined, present: vi.fn(),
        confirm: async () => true, confirmActivation: vi.fn(async () => false), confirmReviewedDisabled: async () => true,
        promptText: async prompt => { throw new Error(`Unexpected repeated business question: ${prompt}`); },
        chooseOption: async title => {
          if (title === "START BOUNDARY DRAFTING") return "resume";
          if (["ACTIVATE READ BOUNDARY", "FINISH BOUNDARY REVIEW", "REPLACE ACTIVE READ BOUNDARY"].includes(title)) return "finish";
          throw new Error(`Unexpected rescan navigation: ${title}; ${JSON.stringify(details)}`);
        },
      };
      const noModel = vi.fn(async () => { throw new Error("Saved outcome must not be redrafted; the separate decision remains unanswered."); });
      const run = () => boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], inspectDatabase, session, undefined, {
        startWithAgentJob: true, modelAuthoringSession: { provider: "openai", model: "gpt-test", apiKey: "session-secret" },
        modelBoundaryJobPlanner: noModel, modelActionRuleGenerator: noModel, modelReadWorkloadGenerator: noModel,
        modelAuthoringNarrator: async () => "Review current source evidence; the separate approval limit remains unanswered.",
        actionProjectInspector: inspect, boundaryAuthoringChatFactory: () => metadataChat(session, details),
      });
      await expect(run()).resolves.toBe(0);
      await expect(run()).resolves.toBe(0);
      const finalContext = await loadBoundaryReviewContext(root);
      const final = (await readActionRuleAuthorityDraft(root, saved.authority.name))!;
      expect(final.authority.rules[0]!.rule).toEqual(saved.authority.rules[0]!.rule);
      expect(final.authority.rules[0]!.effect_envelope).toEqual(saved.authority.rules[0]!.effect_envelope);
      expect(final.authority.approval_classes).toEqual(saved.authority.approval_classes);
      expect(final.authority.rules[0]!.read_boundary_digest).toBe(finalContext.bundle.candidate_digest);
      expect(final.authority.rules[0]!.verification_boundary).toEqual({ ...saved.authority.rules[0]!.verification_boundary,
        generation_lock_fingerprint: finalContext.candidate.generation_lock_fingerprint });
      expect(finalContext.candidate.pack.resources.some(resource => resource.id === "public.visit_facts")).toBe(false);
      const currentCatalog = buildActionRuleAuthoringCatalog({ boundary: finalContext.candidate, inspection: afterAdmin,
        retainedCatalog: final.authority.catalog });
      const privateFacts = currentCatalog.authoring.resources.find(resource => resource.name === "public.visit_facts")!;
      expect(privateFacts.fields).toEqual(expect.arrayContaining([expect.objectContaining({ name: "status",
        nullable: false, role: "runner_verification_only", enum_source: "schema" })]));
      expect(privateFacts.fields.some(field => field.role === "model_visible")).toBe(false);
      expect(currentCatalog.catalog.relationships.find(relationship => relationship.name === "visit_facts_visit_fk"))
        .toMatchObject({ nullable: false, target_unique: true, field_pairs: [
          { local_field: "tenant_id", target_field: "tenant_id" }, { local_field: "principal_id", target_field: "principal_id" },
          { local_field: "id", target_field: "id" },
        ] });
      const resumed = await readBoundaryAuthoringResumeState(root, { boundary_name: finalContext.candidate.pack.name,
        generation_lock_fingerprint: finalContext.candidate.generation_lock_fingerprint,
        schema_fingerprint: finalContext.lock.schema_fingerprint, role_posture_fingerprint: finalContext.lock.role_posture_fingerprint });
      expect(resumed).toMatchObject({ status: "ready", value: { action: unfinished, conversation: expect.arrayContaining(conversation) } });
      expect(noModel).not.toHaveBeenCalled();
      expect(session.confirmActivation).not.toHaveBeenCalled();
      expect(await loadActivatedExplorationBoundaries(root)).toEqual(active);
      expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
      process.stdout.write(JSON.stringify({ owned_container: name, metadata_only: true, business_rows_created: 0,
        grants_digest: canonicalJsonDigest(grants), policies_digest: canonicalJsonDigest(policies),
        before_schema: schemaFingerprint(initial), after_schema: schemaFingerprint(afterAdmin),
        saved_action: saved.digest, revalidated_action: final.digest, active_read_unchanged: true }) + "\n");
    } finally {
      if (previousEnv === undefined) delete process.env[readEnv]; else process.env[readEnv] = previousEnv;
      await admin?.end();
      if (started) execFileSync("docker", ["stop", "-t", "5", name], { stdio: "pipe" });
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});

function metadataChat(session: BoundaryReviewInteractiveSession, details: unknown[]): BoundaryAuthoringChat {
  return {
    session: { ...session, presentationMode: "conversation", chooseOption: async (title, options, config) =>
      title === "CLIENT FOR THIS JOB" ? "later" : session.chooseOption?.(title, options, config) },
    actionPrompter: { choose: async () => undefined, text: async () => undefined, confirm: async () => undefined, message: async () => undefined },
    setModel: vi.fn(), setPermissionGuide: vi.fn(), runner: vi.fn(), model: vi.fn(), checkpoint: vi.fn(),
    streamRunner: async () => undefined, streamCheckpoint: async () => undefined, streamModel: async () => undefined,
    rememberDetails: (title, lines) => { details.push({ title, lines }); }, showDetails: vi.fn(), providerStream: vi.fn(),
    progress: async (_message, operation) => operation(), close: vi.fn(),
  };
}
