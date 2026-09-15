import { planModelBoundaryJob } from "./boundary-job-model.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { activateExplorationBoundary, buildAutoBoundary, explorationBoundaryCandidateDigest, loadActivatedExplorationBoundaries,
  loadActivatedExplorationBoundary, writeAutoBoundaryArtifacts } from "./auto-boundary.js";
import { boundaryDeleteCommand, boundaryReviewCommand, loadBoundaryReviewContext, boundaryAuthoringResumeBinding } from "./boundary-commands.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { listActionRuleAuthorityDrafts, readActionRuleAuthorityActivation } from "./action-rule-authority.js";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import {
  saveInstantBoundaryEditBaseline,
  saveInstantBoundaryReviewBaseline,
} from "./boundary-review-persistence.js";
import { boundaryCommand, onboard, reviewUnresolvedOrganizationScope, start, type GuidedStartDependencies } from "./guided-start.js";
import * as runtimeCommands from "./runtime-commands.js";
import { initializeGuidedProject } from "./guided-project.js";
import { readProjectReadAuthoring } from "./control-policy-read-authoring-project.js";
import { detectProjectContext } from "./project-detection.js";
import { ControlPolicyRepository } from "@synapsor-runner/proposal-store";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { newPolicySourceSession, policyTextSnapshot, savePolicySources } from "./authoring-policy-source.js";
import {
  activateInstantCliBoundary,
  type InstantCliBoundaryActivationResult,
} from "./instant-cli-boundary.js";

const suiteCwd = process.cwd();

describe("guided start surfaces", () => {
  it("public status preserves the saved policy blocker instead of recommending activation from field signoffs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-status-policy-"));
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await onboard(["db", "--project-root", root, "--from-env", "DATABASE_URL", "--json"],
        { interactive: false, schemaInspector: async () => inspection() });
      let context = await loadBoundaryReviewContext(root);
      await saveInstantBoundaryReviewBaseline({ projectRoot: root, draft: context.draft, candidate: context.candidate,
        actor: "test-operator", expectedAuthoring: context.bundle.mutation_bindings.authoring });
      context = await loadBoundaryReviewContext(root);
      expect(context.bundle.outstanding_decision_ids).toEqual([]);
      const sources = newPolicySourceSession();
      const source = policyTextSnapshot(Buffer.from("Use database-origin UTC for release eligibility."), "rules.txt");
      sources.snapshots = [source]; sources.active = 1;
      sources.coverage_authority_digest = canonicalJsonDigest({ read: context.bundle.candidate_digest, action: null });
      sources.coverage = { source_digest: source.digest, draft_digest: canonicalJsonDigest({ test: "saved interpretation" }), passages: [{
        start: 1, end: 1, disposition: "conflict", responsibility: "runner", issue_kind: "unsupported_requirement",
        topic: "Database-origin UTC", interpretation: "Runner evaluation time does not establish database-server time.",
        draft_paths: [], next_step: "Keep the original requirement and saved draft pending support.",
      }] };
      await savePolicySources(root, sources);
      await writeBoundaryAuthoringResumeState(root, buildBoundaryAuthoringResumeState({
        binding: boundaryAuthoringResumeBinding(context.bundle), stage: "authority_review", jobIntent: "Release eligible records.",
        provider: "openai", model: "gpt-5.6-terra", policySourceSession: sources.id,
      }));
      output.mockClear();
      await expect(boundaryCommand(["status", "--project-root", root, "--json"])).resolves.toBe(0);
      const status = JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(""));
      expect(status.activation).toBe("disabled_unreviewed");
      expect(status.policy_review).toMatchObject({ ready: false });
      expect(status.policy_review.summary.join(" ")).toContain("Database-origin UTC");
      expect(status.next_action).toMatch(/resume.*policy|policy.*review/i);
      expect(status.next_action).not.toMatch(/^Activate/);
      output.mockClear();
      await boundaryCommand(["status", "--project-root", root]);
      expect(output.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("Database-origin UTC");
      await expect(loadActivatedExplorationBoundaries(root)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await loadBoundaryReviewContext(root)).bundle.candidate_digest).toBe(context.bundle.candidate_digest);
      const originalSources = structuredClone(sources);
      for (const variant of ["provider_unavailable", "changed_read", "changed_source", "pending_edit", "unfinished_action", "checked"]) {
        const changed = structuredClone(originalSources);
        if (variant !== "provider_unavailable") changed.coverage!.passages = [{ start: 1, end: 1, disposition: "implemented",
          interpretation: "Test-only saved successful interpretation.", draft_paths: [] }];
        else delete changed.coverage;
        if (variant === "changed_read") changed.coverage_authority_digest = canonicalJsonDigest({ different: true });
        if (variant === "changed_source") { changed.snapshots.push(policyTextSnapshot(Buffer.from("A new restriction."), "rules.txt", 2)); changed.active = 2; }
        await savePolicySources(root, changed);
        await writeBoundaryAuthoringResumeState(root, buildBoundaryAuthoringResumeState({
          binding: boundaryAuthoringResumeBinding(context.bundle), stage: variant === "unfinished_action" ? "action_drafting" : "authority_review",
          jobIntent: "Release eligible records.", provider: "openai", model: "gpt-5.6-terra", policySourceSession: changed.id,
          ...(variant === "pending_edit" ? { pendingReadRevision: "Keep the private release check unavailable to model analysis." } : {}),
        }));
        output.mockClear();
        await boundaryCommand(["status", "--project-root", root, "--json"]);
        const current = JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(""));
        expect(current.policy_review.ready, variant).toBe(variant === "checked");
        expect(current.activation, variant).toBe("disabled_unreviewed");
        expect(current.next_action, variant).not.toMatch(/^Activate/);
        if (variant === "checked") expect(current.next_action).toContain("exact saved review");
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  afterEach(() => {
    process.chdir(suiteCwd);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const entry = (command: string, args: string[], dependencies: GuidedStartDependencies) => command === "start"
    ? start(args, dependencies) : onboard(["db", ...args], dependencies);

  it.each(["start", "onboard"])("%s threads the selected timeout into actual authoring transport and its correction", async command => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "authoring-timeout-handoff-"));
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const observed: number[] = [];
    const runBoundaryReview = async () => {
      let calls = 0;
      await planModelBoundaryJob({
        session: { provider: "openai", model: "fixture-model", apiKey: "fixture-key", dependencies: {
          requestJson: async request => {
            observed.push(request.timeoutMs!);
            return { status: 200, body: { output: [{ type: "function_call", call_id: `call_${++calls}`,
              name: "runner__plan_boundary_job", arguments: JSON.stringify(calls === 1 ? {} : {
                status: "planned", operation: "review_rules", read_mode: "reuse", action_mode: "none", summary: "Review current rules." }) }] } };
          },
        } },
        jobIntent: "Review current rules without changing them.", egressAcknowledged: true,
        currentState: { read: { boundary_name: "fixture", authority: "disabled", fully_reviewed: true,
          resource_ids: ["public.orders"], exact_reusable_revision_count: 1 }, actions: [],
          control_plane: { trusted_scope: "runner_injected", approval_history: "runner_proposal_ledger",
            model_may_supply_scope_values: false, model_may_supply_approval_history: false } },
      });
      return 0;
    };
    try {
      const schemaInspector = vi.fn(async () => inspection());
      for (const seconds of [300, undefined, 600, 1]) {
        observed.length = 0;
        await expect(entry(command, ["--project-root", root, "--from-env", "DATABASE_URL", "--cli",
          ...(seconds === undefined ? [] : ["--timeout", String(seconds)])],
          { interactive: true, schemaInspector, runBoundaryReview })).resolves.toBe(0);
        expect(observed).toEqual([(seconds ?? 120) * 1000, (seconds ?? 120) * 1000]);
      }
      expect(schemaInspector).toHaveBeenCalledOnce(); // subsequent starts use the saved metadata
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(["start", "onboard"])("%s defaults to current job-first terminal review without opening Workbench", async (command) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-current-terminal-"));
    const schemaInspector = vi.fn(async () => inspection()), runBoundaryReview = vi.fn(async () => 0), openWorkbench = vi.fn(async () => 0);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await expect(entry(command, ["--project-root", root, "--from-env", "DATABASE_URL"],
        { interactive: true, schemaInspector, runBoundaryReview, openWorkbench })).resolves.toBe(0);
      expect(runBoundaryReview).toHaveBeenCalledWith(["--project-root", root, "--access", "--job-first"], schemaInspector, expect.any(Function));
      expect(openWorkbench).not.toHaveBeenCalled();
      await expect(fs.stat(path.join(root, ".synapsor/exploration-boundary.active.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(["start", "onboard"])("%s initializes the current disabled metadata without a TTY, model API or legacy selectors", async (command) => {
    for (const flags of [[], ["--json"], ["--yes", "--json"]]) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-current-headless-"));
      const schemaInspector = vi.fn(async () => inspection()), runBoundaryReview = vi.fn(async () => 0), openWorkbench = vi.fn(async () => 0);
      vi.stubEnv("OPENAI_API_KEY", undefined); vi.stubEnv("ANTHROPIC_API_KEY", undefined);
      const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      try {
        await expect(entry(command, ["--project-root", root, "--from-env", "DATABASE_URL", ...flags],
          { interactive: false, schemaInspector, runBoundaryReview, openWorkbench })).resolves.toBe(0);
        expect(schemaInspector).toHaveBeenCalledOnce();
        expect(runBoundaryReview).not.toHaveBeenCalled(); expect(openWorkbench).not.toHaveBeenCalled();
        const context = await loadBoundaryReviewContext(root);
        expect(context.draft.pack.resources.map((resource) => resource.id)).toContain("public.service_visits");
        const text = output.mock.calls.map(([chunk]) => String(chunk)).join("");
        expect(text).toContain("--export-draft"); expect(text).toContain("--draft"); expect(text).toContain("--dry-run");
        expect(text).not.toMatch(/choose one table|--table|--answers|legacy capability compatibility/u);
        if (flags.includes("--json")) expect(JSON.parse(text)).toMatchObject({
          ok: true, activation: "disabled_unreviewed", source_database_changed: false, active_authority_changed: false,
          next_steps: { export_draft: expect.stringContaining("--export-draft"), submit_disabled_draft: expect.stringContaining("--draft") },
        });
        await expect(fs.stat(path.join(root, ".synapsor/exploration-boundary.active.json"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally { output.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
    }
  });

  it.each(["start", "onboard"])("%s dispatches explicit structured drafts directly without inspection or a model", async (command) => {
    const runStructuredBoundaryAuthoring = vi.fn(async () => 0), schemaInspector = vi.fn();
    for (const operation of [["--export-draft", "review.json"], ["--draft", "review.json", "--dry-run"], ["--draft", "review.json"]]) {
      const args = ["--project-root", "/not-read-by-router", ...operation, "--json"];
      await expect(entry(command, args, { interactive: false, schemaInspector, runStructuredBoundaryAuthoring })).resolves.toBe(0);
      expect(runStructuredBoundaryAuthoring).toHaveBeenLastCalledWith(args, schemaInspector);
    }
    expect(schemaInspector).not.toHaveBeenCalled();
  });

  it.each(["start", "onboard"])("%s resumes interrupted fresh bootstrap through the same public entry", async (command) => {
    for (const phase of ["checkpoint", "import"] as const) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-current-bootstrap-resume-"));
      const schemaInspector = vi.fn(async () => inspection());
      const runBoundaryReview = vi.fn<NonNullable<GuidedStartDependencies["runBoundaryReview"]>>(async () => 0);
      vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const checkpointPath = path.join(root, ".synapsor/fresh-governed-authoring.json");
      const rename = fs.rename.bind(fs);
      const failure = phase === "import"
        ? vi.spyOn(ControlPolicyRepository.prototype, "importDeployment").mockRejectedValueOnce(new Error("interrupted bootstrap import"))
        : vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (args[1] === checkpointPath) throw new Error("interrupted bootstrap checkpoint");
          return rename(...args);
        });
      try {
        await expect(entry(command, ["--project-root", root, "--from-env", "DATABASE_URL", "--json"],
          { interactive: false, schemaInspector })).rejects.toThrow("interrupted bootstrap");
        failure.mockRestore();
        const config = await fs.readFile(path.join(root, "synapsor.runner.json"), "utf8");
        const checkpoint = phase === "import" ? await fs.readFile(checkpointPath, "utf8") : undefined;
        if (phase === "import") await expect(readProjectReadAuthoring(root)).rejects.toHaveProperty("code", "POLICY_MIGRATION_PENDING");
        await expect(entry(command, ["--project-root", root, "--from-env", "DATABASE_URL", "--cli"],
          { interactive: true, schemaInspector, runBoundaryReview })).resolves.toBe(0);
        expect(runBoundaryReview).toHaveBeenCalledOnce();
        expect(runBoundaryReview.mock.calls[0]![0]).not.toContain("--rescan");
        expect(schemaInspector).toHaveBeenCalledTimes(phase === "import" ? 1 : 2);
        expect(await fs.readFile(path.join(root, "synapsor.runner.json"), "utf8")).toBe(config);
        if (checkpoint) expect(await fs.readFile(checkpointPath, "utf8")).toBe(checkpoint);
        const authoring = await readProjectReadAuthoring(root);
        expect(authoring?.selected?.progress.confirmed_decisions).toEqual([]);
        await expect(loadActivatedExplorationBoundaries(root)).rejects.toHaveProperty("code", "ENOENT");
        expect(await listActionRuleAuthorityDrafts(root)).toEqual([]);
        await expect(fs.stat(path.join(root, "synapsor/generated"))).rejects.toHaveProperty("code", "ENOENT");
      } finally { failure.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
    }
  });

  it.each(["start", "onboard"])("%s rejects old selectors before inspection or artifact mutation", async (command) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-current-selector-refusal-"));
    const schemaInspector = vi.fn();
    await fs.writeFile(path.join(root, "answers.json"), "preserved");
    try {
      for (const selector of ["--table", "--answers", "--spec", "--mode", "--table=public.orders", "-o"]) {
        await expect(entry(command, ["--project-root", root, "--from-env", "DATABASE_URL", selector, "old-selection"],
          { interactive: false, schemaInspector })).rejects.toThrow(/--legacy-capabilities/);
      }
      expect(schemaInspector).not.toHaveBeenCalled();
      expect(await fs.readdir(root)).toEqual(["answers.json"]);
      expect(await fs.readFile(path.join(root, "answers.json"), "utf8")).toBe("preserved");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(["start", "onboard"])("%s exports, validates and submits a real fresh disabled Read draft through the structured service", async (command) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-current-structured-route-"));
    const schemaInspector = vi.fn(async () => inspection());
    const dependencies = { interactive: false, schemaInspector };
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const result = () => JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(""));
    vi.stubEnv("OPENAI_API_KEY", undefined); vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    try {
      await entry(command, ["--project-root", root, "--from-env", "DATABASE_URL", "--json"], dependencies);
      const before = (await loadBoundaryReviewContext(root)).bundle.bundle_digest;
      output.mockClear();
      const draftPath = path.join(root, "boundary-authoring.json");
      await expect(entry(command, ["--project-root", root, "--export-draft", draftPath, "--json"], dependencies)).resolves.toBe(0);
      expect(result()).toMatchObject({ ok: true, state: "exported", source_database_changed: false });
      const draft = JSON.parse(await fs.readFile(draftPath, "utf8"));
      expect(draft.schema_version).toBe("synapsor.boundary-draft-input.v1");
      expect(draft.review_bundle_digest).toBe(before);
      draft.read.resources = [{ resource_id: "public.service_visits", withhold_from_model_fields: ["status"] }];
      draft.actions = [];
      await fs.writeFile(draftPath, JSON.stringify(draft));
      output.mockClear();
      await expect(entry(command, ["--project-root", root, "--draft", draftPath, "--dry-run", "--json"], dependencies)).resolves.toBe(0);
      expect(result()).toMatchObject({ ok: true, state: "validated_disabled_preview", source_database_changed: false });
      expect((await loadBoundaryReviewContext(root)).bundle.bundle_digest).toBe(before);
      output.mockClear();
      await expect(entry(command, ["--project-root", root, "--draft", draftPath, "--json"], dependencies)).resolves.toBe(0);
      expect(result()).toMatchObject({ ok: true, state: "saved_disabled", source_database_changed: false });
      const context = await loadBoundaryReviewContext(root);
      expect(context.candidate.pack.resources.find((resource) => resource.id === "public.service_visits")?.model_withheld_fields).toContain("status");
      await expect(fs.stat(path.join(root, ".synapsor/exploration-boundary.active.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(["start", "onboard"])("%s retains explicitly selected legacy answers compatibility", async (command) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-explicit-legacy-"));
    const answers = path.join(root, "answers.json");
    await fs.writeFile(answers, JSON.stringify({ engine: "postgres", read_url_env: "DATABASE_URL", schema: "public", table: "invoices",
      primary_key: "id", tenant_column: "tenant_id", visible_columns: ["id", "status"], mode: "read_only" }));
    const before = await fs.readFile(answers, "utf8"), output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await expect(entry(command, ["--legacy-capabilities", "--answers", answers, "--yes", "--dry-run", "--no-open"], { interactive: false })).resolves.toBe(0);
      expect(output.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("legacy capability compatibility");
      expect(await fs.readFile(answers, "utf8")).toBe(before);
      expect(await fs.readdir(root)).toEqual(["answers.json"]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("opens a structured saved semantic Action through current review without a new job or provider", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-structured-manual-review-"));
    const metadata = inspection();
    const table = metadata.tables[0]!;
    table.columns.push({ ...table.columns[2]!, name: "version", data_type: "integer", ordinal_position: 5,
      suggestions: { ...table.columns[2]!.suggestions, conflict: true } });
    table.suggestions.conflict_columns = ["version"];
    const schemaInspector = vi.fn(async () => metadata);
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.stubEnv("OPENAI_API_KEY", undefined); vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    const noModel = vi.fn(async () => { throw new Error("Saved review must not call a model or start a new job"); });
    try {
      await start(["--project-root", root, "--from-env", "DATABASE_URL", "--json"], { interactive: false, schemaInspector });
      const draftPath = path.join(root, "boundary-authoring.json");
      await start(["--project-root", root, "--export-draft", draftPath, "--json"], { schemaInspector });
      const input = JSON.parse(await fs.readFile(draftPath, "utf8"));
      input.read.resources = [{ resource_id: "public.service_visits", include: true, withhold_from_model_fields: ["status", "version"] }];
      const literal = (value: string) => ({ kind: "literal", value,
        value_type: { kind: "string", max_length: 32, comparison: "exact" } });
      input.actions = [{
        schema_version: "synapsor.action-rule-model-draft.v1", name: "visits.cancel", outcome: "visits.cancel",
        verification: { name: "visits.cancel_verification", resources: [{ binding: "visit", resource: "public.service_visits",
          source: { kind: "subject_ref" }, fields: ["status"] }] },
        effect: { name: "visits.cancel_effect", operation: "update", target_resource: "public.service_visits", target_binding: "visit",
          allowed_fields: [{ name: "status", values: ["cancelled"] }], set: { status: literal("cancelled") }, writeback: "proposal_only" },
        require: { kind: "compare", operator: "eq", left: { kind: "field", binding: "visit", field: "status" }, right: literal("scheduled") },
        derive: {}, approval: { class_name: "visits.human", mode: "human", required_role: "visit_reviewer", required_approvals: 1, shared_limits: [] },
        ttl_seconds: 300,
        review: { when: "The visit is scheduled.", then: "Propose cancellation of the visit.", refused: ["The visit is not scheduled."],
          human_review: "Every eligible proposal requires one visit reviewer.",
          examples: [{ kind: "eligible", scenario: "Scheduled visit", result: "Propose cancellation" },
            { kind: "ineligible", scenario: "Cancelled visit", result: "Refuse" }] },
      }];
      await fs.writeFile(draftPath, JSON.stringify(input));
      output.mockClear();
      const submitted = await start(["--project-root", root, "--draft", draftPath, "--json"], { schemaInspector });
      const receipt = JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(""));
      expect(receipt).toMatchObject({ ok: true, state: "saved_disabled", next_steps: {
        review_read: `synapsor-runner boundary review --project-root '${root}' --access`,
        review_actions: `synapsor-runner action review --project-root '${root}'`,
      } });
      expect(submitted).toBe(0);
      const before = await listActionRuleAuthorityDrafts(root);
      expect(before).toHaveLength(1);
      const context = await loadBoundaryReviewContext(root);
      const screens: string[] = [];
      const chooseResource = vi.fn<BoundaryReviewInteractiveSession["chooseResource"]>()
        .mockResolvedValueOnce({ action: "actions", boundary_name: context.candidate.pack.name })
        .mockResolvedValue(undefined);
      const chooseOption = vi.fn<NonNullable<BoundaryReviewInteractiveSession["chooseOption"]>>(async (title, choices, options) => {
        screens.push(title);
        if (title === "EXACT VERIFIED ACTION DETAILS") {
          expect(options?.context?.join("\n")).toContain("visits.cancel");
          return "back";
        }
        expect(title).toBe("VERIFIED ACTION BOUNDARY");
        expect(choices.find((choice) => choice.value === "activate")?.disabled).toBe(true);
        return screens.filter((screen) => screen === title).length === 1 ? "details_draft" : "back";
      });
      const session = { chooseResource, chooseOption, confirm: noModel, promptText: noModel,
        editFieldTiers: noModel, close: vi.fn() } as unknown as BoundaryReviewInteractiveSession;
      const runBoundaryReview = vi.fn(async (args: string[]) => boundaryReviewCommand(args, schemaInspector, session, undefined,
        { modelReadWorkloadGenerator: noModel, modelBoundaryJobPlanner: noModel, modelActionRuleGenerator: noModel }));
      await expect(start(["--project-root", root, "--from-env", "DATABASE_URL", "--cli"],
        { interactive: true, schemaInspector, runBoundaryReview })).resolves.toBe(0);
      expect(runBoundaryReview).toHaveBeenCalledWith(["--project-root", root, "--access"], schemaInspector, expect.any(Function));
      expect(screens).toContain("EXACT VERIFIED ACTION DETAILS");
      expect(noModel).not.toHaveBeenCalled();
      expect(await listActionRuleAuthorityDrafts(root)).toEqual(before);
      expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
      expect((await loadBoundaryReviewContext(root)).bundle.candidate_digest).toBe(context.bundle.candidate_digest);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("preserves explicit worker/config routing and never treats bare start as a worker", async () => {
    const worker = vi.spyOn(runtimeCommands, "startWorker").mockResolvedValue(0);
    const args = ["--once", "--config", "worker.json", "--store", "worker.db"];
    await expect(start(args, { interactive: false })).resolves.toBe(0);
    expect(worker).toHaveBeenCalledWith(args);
    worker.mockClear();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-bare-current-start-"));
    process.chdir(root); vi.stubEnv("DATABASE_URL", undefined);
    try {
      await expect(start([], { interactive: false })).rejects.toThrow(/Current Boundary setup requires/);
      expect(worker).not.toHaveBeenCalled();
      await fs.writeFile(path.join(root, "synapsor.runner.json"), "preserved manual config");
      await expect(start([], { interactive: true })).rejects.toThrow(/Existing manual capability artifacts were preserved/);
      expect(await fs.readFile(path.join(root, "synapsor.runner.json"), "utf8")).toBe("preserved manual config");
    } finally { process.chdir(suiteCwd); await fs.rm(root, { recursive: true, force: true }); }
  });
  it.each(["start", "boundary"])("keeps %s publication and rollback inside one writer operation", async (command) => {
    for (const fail of [false, true]) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-publication-"));
      const sentinel = path.join(root, ".synapsor/later-writer"), config = path.join(root, "synapsor.runner.json");
      let reached!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => { reached = resolve; });
      const resume = new Promise<void>((resolve) => { release = resolve; });
      let competitorEntered = false, pendingAtRollback = false;
      const copy = fs.copyFile.bind(fs), remove = fs.rm.bind(fs);
      const copies = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
        if (args[1] === path.join(root, ".synapsor/guided-onboarding.json")) {
          reached(); await resume;
          if (fail) throw new Error("injected initial configuration publication failure");
        }
        return copy(...args);
      });
      const removals = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        if (args[0] === config) {
          await delay(80);
          pendingAtRollback = !competitorEntered;
        }
        return remove(...args);
      });
      vi.spyOn(process.stdout, "write").mockReturnValue(true);
      process.chdir(root);
      const setup = (command === "start"
        ? start(["--from-env", "DATABASE_URL", "--no-open"], { interactive: false, schemaInspector: async () => inspection() })
        : boundaryCommand(["draft", "--project-root", root, "--from-env", "DATABASE_URL", "--json"], async () => inspection()))
        .then(() => ({ saved: true }), (error: unknown) => ({ error }));
      let competitor: Promise<void> | undefined;
      try {
        await entered;
        competitor = withProjectAuthorityMutation(root, async () => {
          competitorEntered = true;
          if (fail) await expect(fs.stat(config)).rejects.toHaveProperty("code", "ENOENT");
          else expect((await fs.stat(config)).isFile()).toBe(true);
          await fs.writeFile(sentinel, "preserved");
        });
        await delay(80);
        const pendingAtPublication = !competitorEntered;
        release();
        const result = await setup;
        await competitor;
        expect(pendingAtPublication).toBe(true);
        if (fail) { expect(result).toHaveProperty("error"); expect(pendingAtRollback).toBe(true); }
        else expect(result).toEqual({ saved: true });
        expect(await fs.readFile(sentinel, "utf8")).toBe("preserved");
        await expect(fs.stat(path.join(root, "synapsor/generated"))).rejects.toHaveProperty("code", "ENOENT");
        expect((await fs.stat(path.join(root, ".synapsor/authority-write-lock.sqlite"))).isFile()).toBe(true);
      } finally {
        release(); await setup; await competitor;
        copies.mockRestore(); removals.mockRestore();
        process.chdir(suiteCwd); await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  it.each([false, true])("reopens the saved guided job despite existing review progress or active Read (%s)", async (active) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-saved-job-"));
    const schemaInspector = vi.fn(async () => inspection());
    const runBoundaryReview = vi.fn(async () => 0), handoff = vi.fn(async () => 0);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    process.chdir(root);
    try {
      await start(["--from-env", "DATABASE_URL", "--no-open"], { interactive: false, schemaInspector });
      const context = await loadBoundaryReviewContext(root);
      await saveInstantBoundaryEditBaseline({ projectRoot: root, draft: context.draft, candidate: context.candidate,
        expectedAuthoring: context.bundle.mutation_bindings.authoring, actor: "test-operator" });
      if (active) await activateTestRead(root);
      const current = await loadBoundaryReviewContext(root);
      const state = buildBoundaryAuthoringResumeState({ binding: boundaryAuthoringResumeBinding(current.bundle),
        stage: "authority_review", jobIntent: "Review service visits and propose rescheduling.", provider: "openai", model: "gpt-5.6-terra" });
      await writeBoundaryAuthoringResumeState(root, state);
      const progressBefore = current.progress;
      await start(["--from-env", "DATABASE_URL", "--cli"], { interactive: true, schemaInspector, runBoundaryReview, runPostActivationHandoff: handoff });
      expect(runBoundaryReview).toHaveBeenCalledWith(["--project-root", root, "--access", "--job-first"], schemaInspector, expect.any(Function));
      expect(handoff).not.toHaveBeenCalled();
      expect(schemaInspector).toHaveBeenCalledOnce();
      expect((await loadBoundaryReviewContext(root)).progress).toEqual(progressBefore);
    } finally { process.chdir(suiteCwd); await fs.rm(root, { recursive: true, force: true }); }
  });

  it("offers explicit single-organization scope before saving a fresh unscoped database", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-scope-choice-"));
    process.chdir(root);
    const review = vi.fn(async () => {
      await expect(fs.stat(path.join(root, "synapsor.runner.json"))).rejects.toMatchObject({ code: "ENOENT" });
      return { mode: "single_organization" as const, organizationId: "university-operations" };
    });
    try {
      await start(["--from-env", "DATABASE_URL", "--cli"], {
        interactive: true, schemaInspector: async () => singleOrganizationInspection(),
        reviewUnresolvedOrganizationScope: review, runBoundaryReview: async () => 0,
      });
      expect(review).toHaveBeenCalledOnce();
      const draft = (await loadBoundaryReviewContext(root)).draft;
      expect(draft.organization_scope).toMatchObject({ organization_id: "university-operations" });
      expect(draft.activation).toBe("disabled_unreviewed");
    } finally { process.chdir(suiteCwd); await fs.rm(root, { recursive: true, force: true }); }
  });

  it("keeps a changed-schema rescan in the guided job without reusing a client checkpoint", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-guided-rescan-"));
    const schemaInspector = vi.fn(async () => inspection());
    const review = vi.fn(async () => 0), handoff = vi.fn(async () => 0);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    process.chdir(root);
    try {
      await start(["--from-env", "DATABASE_URL", "--no-open"], { interactive: false, schemaInspector });
      const context = await loadBoundaryReviewContext(root);
      const state = buildBoundaryAuthoringResumeState({ binding: boundaryAuthoringResumeBinding(context.bundle),
        stage: "authority_review", jobIntent: "Review service visits and propose rescheduling.", provider: "openai", model: "gpt-5.6-terra" });
      await writeBoundaryAuthoringResumeState(root, state);
      const changed = inspection();
      changed.tables[0]!.columns[0]!.nullable = !changed.tables[0]!.columns[0]!.nullable;
      schemaInspector.mockResolvedValue(changed);
      await start(["--from-env", "DATABASE_URL", "--cli", "--rescan"], {
        interactive: true, schemaInspector, runBoundaryReview: review, runPostActivationHandoff: handoff,
      });
      expect(review).toHaveBeenCalledWith(["--project-root", root, "--access", "--job-first"], schemaInspector, expect.any(Function));
      expect(handoff).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"), "utf8"))).toEqual(state);
    } finally { process.chdir(suiteCwd); await fs.rm(root, { recursive: true, force: true }); }
  });

  it("cancels an unresolved scope decision without saving draft artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-scope-cancel-"));
    process.chdir(root);
    const review = vi.fn(async () => undefined);
    const continuation = vi.fn(async () => 0);
    try {
      await start(["--from-env", "DATABASE_URL", "--cli"], {
        interactive: true, schemaInspector: async () => singleOrganizationInspection(),
        reviewUnresolvedOrganizationScope: review, runBoundaryReview: continuation,
      });
      expect(review).toHaveBeenCalledOnce();
      expect(continuation).not.toHaveBeenCalled();
      await expect(fs.stat(path.join(root, "synapsor.runner.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(root, "synapsor/generated"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { process.chdir(suiteCwd); await fs.rm(root, { recursive: true, force: true }); }
  });

  it("does not infer whole-organization permission and validates its audit label", async () => {
    const chooseOption = vi.fn(async (_title: string, _choices: unknown[], _options?: { initialValue?: string }) => "tenant");
    const promptText = vi.fn().mockResolvedValueOnce("").mockResolvedValueOnce("bad label").mockResolvedValueOnce("university");
    await expect(reviewUnresolvedOrganizationScope({ chooseOption, promptText })).resolves.toEqual({ mode: "tenant" });
    expect(promptText).not.toHaveBeenCalled();
    expect(chooseOption.mock.calls[0]?.[2]).toMatchObject({ initialValue: "tenant" });
    chooseOption.mockResolvedValueOnce("single_organization");
    await expect(reviewUnresolvedOrganizationScope({ chooseOption, promptText })).resolves.toEqual({ mode: "single_organization", organizationId: "university" });
    expect(promptText).toHaveBeenCalledTimes(3);
  });

  it("refuses an elevated source role before creating guided authority", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-role-unsafe-"));
    const unsafe = inspection();
    unsafe.current_user = "postgres";
    unsafe.role_posture = {
      verified: true,
      superuser: true,
      bypass_rls: true,
      read_only: false,
      writable_relations: ["public.service_visits"],
      owned_relations: ["public.service_visits"],
      reasons: [],
    };
    process.chdir(projectRoot);
    try {
      await expect(start(
        ["--from-env", "DATABASE_URL", "--no-open"],
        { interactive: false, schemaInspector: async () => unsafe },
      )).rejects.toMatchObject({
        code: "DATABASE_ROLE_UNSAFE",
        message: expect.stringMatching(/PostgreSQL superuser[\s\S]*BYPASSRLS[\s\S]*State preserved/is),
      });
      await expect(fs.stat(path.join(projectRoot, "synapsor.runner.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(projectRoot, "synapsor/generated/exploration-boundary.draft.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.chdir(suiteCwd);
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("runs fresh Auto Boundary onboarding continuously in the CLI register", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-cli-"));
    const schemaInspector = vi.fn(async () => inspection());
    const runBoundaryReview = vi.fn(async () => 0);
    const runInstantCliBoundary = vi.fn(async (): Promise<InstantCliBoundaryActivationResult> => ({
      accepted: true,
      active: {
        pack: { name: "reviewed_development", resources: [] },
        activation: { digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      } as never,
      askSelection: {
        route: "openai",
        model: "gpt-5-mini",
      },
    }));
    const runPostActivationHandoff = vi.fn(async () => 0);
    const openWorkbench = vi.fn(async () => 0);
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    process.chdir(projectRoot);

    try {
      await expect(start(
        [
          "--from-env", "DATABASE_URL", "--cli",
          "--timeout", "180",
          "--session-token-budget", "350000",
          "--max-output-tokens", "2048",
        ],
        {
          interactive: true,
          schemaInspector,
          runInstantCliBoundary,
          runBoundaryReview,
          runPostActivationHandoff,
          openWorkbench,
        },
      )).resolves.toBe(0);

      expect(schemaInspector).toHaveBeenCalledOnce();
      expect(runInstantCliBoundary).toHaveBeenCalledOnce();
      expect(runBoundaryReview).not.toHaveBeenCalled();
      expect(runPostActivationHandoff).toHaveBeenCalledWith({
        projectRoot,
        requestTimeoutSeconds: 180,
        sessionTokenBudget: 350_000,
        maxOutputTokens: 2_048,
        selection: {
          route: "openai",
          model: "gpt-5-mini",
        },
        consentOnFirstQuestion: true,
      });
      expect(openWorkbench).not.toHaveBeenCalled();
      expect(output).toContain("✓ Connected");
      expect(output).toContain("✓ Inspected 1 tables (metadata only; no rows read)");
      expect(output).not.toContain("Detected project context");
      expect(output).not.toContain("Safe starting boundary");
      expect(output).not.toContain("Next: Review this exact boundary in Workbench.");
      await expect(fs.access(path.join(projectRoot, "synapsor.runner.json"))).resolves.toBeUndefined();
      await expect(fs.access(path.join(projectRoot, ".synapsor/local.db"))).resolves.toBeUndefined();
      expect((await loadBoundaryReviewContext(projectRoot)).draft.activation).toBe("disabled_unreviewed");
      await expect(fs.access(path.join(projectRoot, "synapsor/generated"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.chdir(suiteCwd);
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("opens the shipped fresh CLI at one-job Read and Action Boundary setup", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-cli-job-first-"));
    const schemaInspector = vi.fn(async () => inspection());
    const runBoundaryReview = vi.fn(async () => 0);
    const runPostActivationHandoff = vi.fn(async () => 0);
    process.chdir(projectRoot);

    try {
      await expect(start(
        ["--from-env", "DATABASE_URL", "--cli"],
        {
          interactive: true,
          schemaInspector,
          runBoundaryReview,
          runPostActivationHandoff,
          openWorkbench: vi.fn(async () => 0),
        },
      )).resolves.toBe(0);

      expect(runBoundaryReview).toHaveBeenCalledOnce();
      expect(runBoundaryReview).toHaveBeenCalledWith(
        ["--project-root", projectRoot, "--access", "--job-first"],
        schemaInspector,
        expect.any(Function),
      );
      expect(runPostActivationHandoff).not.toHaveBeenCalled();
      await expect(fs.access(path.join(
        projectRoot,
        ".synapsor/exploration-boundary.active.json",
      ))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.chdir(suiteCwd);
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("opens Workbench with a config-aligned startable MySQL authoring baseline", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-mysql-workbench-"));
    const openWorkbench = vi.fn(async () => 0);
    process.chdir(projectRoot);

    try {
      await expect(start(
        ["--from-env", "DATABASE_URL", "--open-ui"],
        {
          interactive: true,
          schemaInspector: async () => mysqlInspection(),
          openWorkbench,
        },
      )).resolves.toBe(0);

      expect(openWorkbench).toHaveBeenCalledOnce();
      const config = JSON.parse(await fs.readFile(
        path.join(projectRoot, "synapsor.runner.json"),
        "utf8",
      ));
      const baseline = (await loadBoundaryReviewContext(projectRoot)).draft;
      expect(config.trusted_context).toMatchObject({
        provider: "environment",
        tenant_binding: "tenant_id",
      });
      expect(baseline.pack.resources).toEqual([
        expect.objectContaining({
          id: "clinicdb.service_visits",
          tenant_key: "tenant_id",
        }),
      ]);
    } finally {
      process.chdir(suiteCwd);
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("resumes an active CLI project at provider selection without rescanning", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-cli-resume-"));
    const schemaInspector = vi.fn(async () => inspection());
    const runBoundaryReview = vi.fn(async () => 0);
    const runInstantCliBoundary = vi.fn(async (): Promise<InstantCliBoundaryActivationResult> => ({
      accepted: false,
      reason: "operator_requested_detailed_review",
    }));
    const runPostActivationHandoff = vi.fn(async () => 0);
    process.chdir(projectRoot);

    try {
      await start(
        ["--from-env", "DATABASE_URL", "--cli"],
        {
          interactive: true,
          schemaInspector,
          runInstantCliBoundary,
          runBoundaryReview,
          runPostActivationHandoff,
          openWorkbench: vi.fn(async () => 0),
        },
      );
      await activateTestRead(projectRoot);
      runBoundaryReview.mockClear();

      await expect(start(
        ["--from-env", "DATABASE_URL", "--cli"],
        {
          interactive: true,
          schemaInspector,
          runInstantCliBoundary,
          runBoundaryReview,
          runPostActivationHandoff,
          openWorkbench: vi.fn(async () => 0),
        },
      )).resolves.toBe(0);

      expect(schemaInspector).toHaveBeenCalledOnce();
      expect(runBoundaryReview).not.toHaveBeenCalled();
      expect(runPostActivationHandoff).toHaveBeenCalledWith({ projectRoot });
    } finally {
      process.chdir(suiteCwd);
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("resumes and rescans a CLI-managed boundary project without a guided marker", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-managed-resume-"));
    const schemaInspector = vi.fn(async () => inspection());
    const runBoundaryReview = vi.fn(async () => 0);
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    process.chdir(projectRoot);

    try {
      await start(
        ["--from-env", "DATABASE_URL", "--no-open"],
        { interactive: false, schemaInspector },
      );
      await fs.rm(path.join(projectRoot, ".synapsor/guided-onboarding.json"));

      await expect(start(
        ["--from-env", "DATABASE_URL", "--cli"],
        {
          interactive: true,
          schemaInspector,
          runBoundaryReview,
          runPostActivationHandoff: vi.fn(async () => 0),
        },
      )).resolves.toBe(0);
      expect(schemaInspector).toHaveBeenCalledTimes(1);
      expect(runBoundaryReview).toHaveBeenLastCalledWith(
        ["--project-root", projectRoot, "--access", "--job-first"],
        schemaInspector,
        expect.any(Function),
      );
      expect(output).toContain("Existing Runner-managed boundary project found.");
      expect(output).toContain("Saved Read candidate: 1 table(s) in revision 1");
      expect(output).toContain("A new model conversation receives the current saved Read and Action state; the prior provider transcript is not retained.");

      runBoundaryReview.mockClear();
      await expect(start(
        ["--from-env", "DATABASE_URL", "--cli", "--rescan"],
        {
          interactive: true,
          schemaInspector,
          runBoundaryReview,
          runPostActivationHandoff: vi.fn(async () => 0),
        },
      )).resolves.toBe(0);
      expect(schemaInspector).toHaveBeenCalledTimes(2);
      expect(runBoundaryReview).toHaveBeenCalledOnce();
      expect(runBoundaryReview).toHaveBeenLastCalledWith(
        ["--project-root", projectRoot, "--access", "--job-first"],
        schemaInspector,
        expect.any(Function),
      );
      await expect(fs.access(path.join(projectRoot, ".synapsor/guided-onboarding.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.chdir(suiteCwd);
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("requires an explicit reset to discard the only disabled boundary review", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-managed-reset-"));
    process.chdir(projectRoot);

    try {
      await start(
        ["--from-env", "DATABASE_URL", "--no-open"],
        { interactive: false, schemaInspector: async () => inspection() },
      );
      const draft = (await loadBoundaryReviewContext(projectRoot)).draft;

      await expect(boundaryDeleteCommand([
        draft.pack.name,
        "--project-root", projectRoot,
        "--yes",
      ])).rejects.toThrow(/--discard-curated-review --yes/i);

      await expect(boundaryDeleteCommand([
        draft.pack.name,
        "--project-root", projectRoot,
        "--discard-curated-review",
        "--yes",
      ])).resolves.toBe(0);
      await expect(fs.access(path.join(projectRoot, "synapsor.runner.json"))).resolves.toBeUndefined();
      await expect(fs.access(path.join(projectRoot, ".synapsor/local.db"))).resolves.toBeUndefined();
      await expect(fs.access(path.join(projectRoot, "synapsor/generated")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(path.join(projectRoot, ".synapsor/generation-lock.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      const emptyAuthoring = await readProjectReadAuthoring(projectRoot);
      expect(emptyAuthoring?.authoring.entries).toEqual([]);
      expect(emptyAuthoring?.authoring.selected_boundary_id).toBeNull();
      await expect(loadActivatedExplorationBoundaries(projectRoot)).rejects.toHaveProperty("code", "ENOENT");
    } finally {
      process.chdir(suiteCwd);
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("preserves an explicit single-organization posture across a guided rescan", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-single-org-rescan-"));
    const schemaInspector = vi.fn(async () => singleOrganizationInspection());
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    process.chdir(projectRoot);

    try {
      await expect(start(
        [
          "--from-env", "DATABASE_URL",
          "--single-tenant",
          "--organization-id", "internal-finance",
          "--no-open",
        ],
        { interactive: true, schemaInspector },
      )).resolves.toBe(0);
      await expect(start(
        ["--from-env", "DATABASE_URL", "--rescan", "--no-open"],
        { interactive: true, schemaInspector },
      )).resolves.toBe(0);

      const draft = (await loadBoundaryReviewContext(projectRoot)).draft;
      expect(schemaInspector).toHaveBeenCalledTimes(2);
      expect(draft.organization_scope?.organization_id).toBe("internal-finance");
      expect(draft.pack.resources.every((resource) =>
        resource.tenant_key === undefined && resource.tenant_scope === undefined)).toBe(true);
      expect(output).toContain("whole reviewed organization (internal-finance); no tenant filter");
      expect(output).not.toContain("scoped by    tenant from your application");
    } finally {
      process.chdir(suiteCwd);
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("labels single-organization authority honestly on the first interactive review", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-single-org-review-"));
    const schemaInspector = vi.fn(async () => singleOrganizationInspection());
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    process.chdir(projectRoot);

    try {
      await expect(legacyQuickStart(
        [
          "--from-env", "DATABASE_URL",
          "--cli",
          "--single-tenant",
          "--organization-id", "internal-finance",
        ],
        {
          interactive: true,
          schemaInspector,
          runInstantCliBoundary: (input) => activateInstantCliBoundary({
            ...input,
            env: { ...process.env, SYNAPSOR_TENANT_ID: undefined },
            session: { promptText: async () => undefined },
          }),
          runBoundaryReview: vi.fn(async () => 0),
          runPostActivationHandoff: vi.fn(async () => 0),
          openWorkbench: vi.fn(async () => 0),
        },
      )).resolves.toBe(0);

      expect(output).toContain(
        "read-only · whole reviewed organization (internal-finance); no tenant filter",
      );
      expect(output).not.toContain("read-only · tenant from operator environment");
    } finally {
      process.chdir(suiteCwd);
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("opens the detailed table, column, and path editor from Quick Start with E", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-cli-detail-"));
    const schemaInspector = vi.fn(async () => inspection());
    const runBoundaryReview = vi.fn(async () => 0);
    const runPostActivationHandoff = vi.fn(async () => 0);
    const promptText = vi.fn(async () => "e");
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    process.chdir(projectRoot);

    try {
      await expect(legacyQuickStart(
        ["--from-env", "DATABASE_URL", "--cli"],
        {
          interactive: true,
          schemaInspector,
          runInstantCliBoundary: (input) => activateInstantCliBoundary({
            ...input,
            env: {
              ...process.env,
              SYNAPSOR_TENANT_ID: "tenant-1",
              USER: "developer@example.test",
            },
            session: { promptText },
          }),
          runBoundaryReview,
          runPostActivationHandoff,
          openWorkbench: vi.fn(async () => 0),
        },
      )).resolves.toBe(0);

      expect(runBoundaryReview).toHaveBeenCalledWith(
        ["--project-root", projectRoot, "--access"],
        schemaInspector,
        expect.any(Function),
      );
      expect(runPostActivationHandoff).not.toHaveBeenCalled();
      expect(promptText).toHaveBeenCalledWith(
        "ENTER Start asking   E Change access   M Change model\nChoice [Enter]: ",
        expect.objectContaining({
          context: expect.arrayContaining([
            "YOUR FIRST SAFE QUESTION",
            expect.stringContaining("Runner inspected 1 database object and prepared one conservative, connected starter boundary"),
            expect.stringContaining("Suggested from this boundary:"),
            expect.stringContaining("The model cannot review, activate, or widen access."),
          ]),
        }),
      );
      expect(output).toContain(
        "Opening the focused access editor with this connected boundary as the baseline.",
      );
      const progress = (await loadBoundaryReviewContext(projectRoot)).progress!;
      expect(progress.candidate.pack.resources.map((resource) => resource.id))
        .toEqual(["public.service_visits"]);
      expect(progress.confirmed_decisions).toEqual([]);
    } finally {
      process.chdir(suiteCwd);
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("requires an explicit provider choice before activating and starting Ask", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-cli-instant-"));
    const schemaInspector = vi.fn(async () => inspection());
    const promptText = vi.fn(async () => "");
    const chooseAskSelection = vi.fn(async () => ({
      route: "anthropic" as const,
      model: "claude-owner-selected",
    }));
    const runPostActivationHandoff = vi.fn(async () => 0);
    const promptContexts: string[][] = [];
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    process.chdir(projectRoot);

    try {
      await expect(legacyQuickStart(
        ["--from-env", "DATABASE_URL", "--cli"],
        {
          interactive: true,
          schemaInspector,
          runInstantCliBoundary: (input) => activateInstantCliBoundary({
            ...input,
            env: {
              ...process.env,
              SYNAPSOR_TENANT_ID: undefined,
              USER: "developer@example.test",
            },
            resolveTrustedScopeFn: vi.fn(async () => ({
              tenant: "tenant-from-database-role",
              principal: "",
              tenant_source: "postgres_role_setting" as const,
              tenant_binding: "app.tenant_id",
              principal_source: "not_required" as const,
            })),
            session: {
              promptText,
            },
            chooseAskSelection,
          }),
          runBoundaryReview: vi.fn(async () => {
            throw new Error("Detailed review should not open after Quick Start is accepted.");
          }),
          runPostActivationHandoff,
          openWorkbench: vi.fn(async () => 0),
        },
      )).resolves.toBe(0);

      expect(schemaInspector).toHaveBeenCalledTimes(2);
      expect(promptText).toHaveBeenCalledWith(
        "ENTER Start asking   E Change access   M Change model\nChoice [Enter]: ",
        expect.objectContaining({
          context: expect.arrayContaining([
            "YOUR FIRST SAFE QUESTION",
            expect.stringContaining("TABLES       Service Visits"),
            expect.stringContaining("MODEL        Choose OpenAI, Anthropic, a local model, or an MCP client"),
          ]),
        }),
      );
      expect(chooseAskSelection).toHaveBeenCalledOnce();
      expect(chooseAskSelection).toHaveBeenCalledWith(undefined);
      expect(runPostActivationHandoff).toHaveBeenCalledWith({
        projectRoot,
        selection: {
          route: "anthropic",
          model: "claude-owner-selected",
        },
        consentOnFirstQuestion: true,
      });
      expect(output).toContain("YOUR FIRST SAFE QUESTION");
      expect(output).toContain(
        "Runner inspected 1 database object and prepared one conservative, connected starter boundary",
      );
      expect(output).toContain("TABLES       Service Visits");
      expect(output).toContain("Suggested from this boundary:");
      expect(output).toContain(
        "MODEL        Choose OpenAI, Anthropic, a local model, or an MCP client",
      );
      expect(output).toContain("Model Anthropic / claude-owner-selected");
      expect(output).not.toContain("MODEL        OpenAI / gpt-5-mini");
      expect(output).toContain("read-only · tenant fixed by read-only login");
      expect(output).toContain("Use /access later to add tables or boundaries without restarting this model session.");
      expect(output).toContain("✓ Ready");
      expect(output).not.toContain("FIRST SAFE READ");
      expect(output).not.toContain("Safe starting boundary");
      expect(output).not.toContain("Detected project context");
      expect(output).not.toContain("BOUNDARY   reviewed_staging");

      const active = (await loadActivatedExplorationBoundary(projectRoot))!;
      expect(active.deployment_profile).toBe("development");
      expect(active.pack.resources).toHaveLength(1);
      expect(active.activation.mode).toBe("instant_development");
      expect(active.activation.confirmation_gesture).toBe("activate_for_model");
      expect(active.activation.reviewed_decisions.length).toBeGreaterThan(0);
      expect(active.activation.reviewed_decisions.every((item) => item.confirmed)).toBe(true);
      const progress = (await loadBoundaryReviewContext(projectRoot)).progress!;
      expect(progress.candidate.pack.resources.map((resource) => resource.id))
        .toEqual(["public.service_visits"]);
      expect(progress.confirmed_decisions).toHaveLength(progress.confirmations.length);
      expect(progress.confirmed_decisions.length).toBeGreaterThan(0);
    } finally {
      process.chdir(suiteCwd);
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("regenerates a stale Quick Start draft in place and still requires a separate activation gesture", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-cli-stale-"));
    const original = inspection();
    const current = structuredClone(original);
    current.tables[0]!.role_posture!.owner = "replacement_owner";
    let inspections = 0;
    const schemaInspector = vi.fn(async () => {
      inspections += 1;
      return inspections === 1 ? original : current;
    });
    const prompts: string[] = [];
    const actions = ["", "r", ""];
    let inactiveAtRegeneration = false;
    let inactiveAtSecondReview = false;
    const promptText = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      const activeExists = await loadActivatedExplorationBoundaries(projectRoot).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      if (prompt.includes("Regenerate against current posture")) {
        inactiveAtRegeneration = !activeExists;
      } else if (prompts.filter((item) => item.includes("Start asking")).length === 2) {
        inactiveAtSecondReview = !activeExists;
      }
      return actions.shift() ?? "";
    });
    const runPostActivationHandoff = vi.fn(async () => 0);
    const chooseAskSelection = vi.fn(async () => ({
      route: "openai-compatible" as const,
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen2.5:7b",
    }));
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    process.chdir(projectRoot);

    try {
      await expect(legacyQuickStart(
        ["--from-env", "DATABASE_URL", "--cli"],
        {
          interactive: true,
          schemaInspector,
          runInstantCliBoundary: (input) => activateInstantCliBoundary({
            ...input,
            env: { ...process.env, USER: "developer@example.test" },
            resolveTrustedScopeFn: vi.fn(async () => ({
              tenant: "tenant-from-database-role",
              principal: "",
              tenant_source: "postgres_role_setting" as const,
              tenant_binding: "app.tenant_id",
              principal_source: "not_required" as const,
            })),
            session: { promptText },
            chooseAskSelection,
          }),
          runBoundaryReview: vi.fn(async () => {
            throw new Error("Detailed review should not open after inline regeneration.");
          }),
          runPostActivationHandoff,
          openWorkbench: vi.fn(async () => 0),
        },
      )).resolves.toBe(0);

      expect(schemaInspector).toHaveBeenCalledTimes(3);
      expect(prompts.filter((prompt) => prompt.includes("Start asking"))).toHaveLength(2);
      expect(prompts).toContain(
        "R Regenerate against current posture   Q Pause\nChoice [R]: ",
      );
      expect(inactiveAtRegeneration).toBe(true);
      expect(inactiveAtSecondReview).toBe(true);
      expect(output).toContain("DATABASE POSTURE CHANGED");
      expect(output).toContain("database role, grants, ownership, or RLS posture changed");
      expect(output).toContain("✓ Regenerated disabled boundary against the current posture.");
      expect(output).toContain(
        "No authority is active. Review the new boundary, then press Enter separately to activate it.",
      );
      expect(runPostActivationHandoff).toHaveBeenCalledOnce();
      expect(chooseAskSelection).toHaveBeenCalledOnce();

      const active = (await loadActivatedExplorationBoundary(projectRoot))!;
      const lock = (await loadBoundaryReviewContext(projectRoot)).lock;
      expect(active.role_posture_fingerprint).toBe(lock.role_posture_fingerprint);
      expect(active.activation.mode).toBe("instant_development");
    } finally {
      process.chdir(suiteCwd);
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("changes the provider and exact model inside the same Quick Start review surface", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-cli-model-"));
    const schemaInspector = vi.fn(async () => inspection());
    const actions = ["m", ""];
    const chooseAskSelection = vi.fn(async () => ({
      route: "anthropic" as const,
      model: "claude-owner-selected",
    }));
    const runPostActivationHandoff = vi.fn(async () => 0);
    const promptContexts: string[][] = [];
    process.chdir(projectRoot);

    try {
      await expect(legacyQuickStart(
        ["--from-env", "DATABASE_URL", "--cli"],
        {
          interactive: true,
          schemaInspector,
          runInstantCliBoundary: (input) => activateInstantCliBoundary({
            ...input,
            env: {
              ...process.env,
              SYNAPSOR_TENANT_ID: "tenant-1",
              OPENAI_API_KEY: "configured",
              USER: "developer@example.test",
            },
            session: {
              promptText: async (_prompt, options) => {
                promptContexts.push(options?.context ?? []);
                return actions.shift() ?? "";
              },
            },
            chooseAskSelection,
          }),
          runBoundaryReview: vi.fn(async () => {
            throw new Error("Detailed review should not open after Quick Start is accepted.");
          }),
          runPostActivationHandoff,
          openWorkbench: vi.fn(async () => 0),
        },
      )).resolves.toBe(0);

      expect(chooseAskSelection).toHaveBeenCalledWith(undefined);
      expect(promptContexts[1]?.join("\n")).toContain("MODEL        Anthropic / claude-owner-selected");
      expect(promptContexts[1]?.join("\n")).toContain("Press Enter to start, or M to change it again.");
      expect(runPostActivationHandoff).toHaveBeenCalledWith({
        projectRoot,
        selection: {
          route: "anthropic",
          model: "claude-owner-selected",
        },
        consentOnFirstQuestion: true,
      });
    } finally {
      process.chdir(suiteCwd);
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("returns from model selection to Quick Start without losing the prior selection", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-cli-model-back-"));
    const schemaInspector = vi.fn(async () => inspection());
    const actions = ["m", "m", ""];
    const chooseAskSelection = vi.fn()
      .mockResolvedValueOnce({
        route: "anthropic" as const,
        model: "claude-owner-selected",
      })
      .mockResolvedValueOnce(undefined);
    const runPostActivationHandoff = vi.fn(async () => 0);
    const promptContexts: string[][] = [];
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    process.chdir(projectRoot);

    try {
      await expect(legacyQuickStart(
        ["--from-env", "DATABASE_URL", "--cli"],
        {
          interactive: true,
          schemaInspector,
          runInstantCliBoundary: (input) => activateInstantCliBoundary({
            ...input,
            env: {
              ...process.env,
              SYNAPSOR_TENANT_ID: "tenant-1",
              USER: "developer@example.test",
            },
            session: {
              promptText: async (_prompt, options) => {
                promptContexts.push(options?.context ?? []);
                return actions.shift() ?? "";
              },
            },
            chooseAskSelection,
          }),
          runBoundaryReview: vi.fn(async () => {
            throw new Error("Escape from model selection must return to Quick Start.");
          }),
          runPostActivationHandoff,
          openWorkbench: vi.fn(async () => 0),
        },
      )).resolves.toBe(0);

      expect(chooseAskSelection).toHaveBeenNthCalledWith(1, undefined);
      expect(chooseAskSelection).toHaveBeenNthCalledWith(2, {
        route: "anthropic",
        model: "claude-owner-selected",
      });
      expect(output).toContain("Model selection cancelled. Your previous model is unchanged.");
      expect(promptContexts[2]?.join("\n")).toContain(
        "Model selection cancelled. Your previous model is unchanged.",
      );
      expect(runPostActivationHandoff).toHaveBeenCalledWith({
        projectRoot,
        selection: { route: "anthropic", model: "claude-owner-selected" },
        consentOnFirstQuestion: true,
      });
    } finally {
      process.chdir(suiteCwd);
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("pauses Quick Start on Escape without opening detailed review or activating", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-cli-back-"));
    const schemaInspector = vi.fn(async () => inspection());
    const runBoundaryReview = vi.fn(async () => 0);
    const runPostActivationHandoff = vi.fn(async () => 0);
    process.chdir(projectRoot);

    try {
      await expect(legacyQuickStart(
        ["--from-env", "DATABASE_URL", "--cli"],
        {
          interactive: true,
          schemaInspector,
          runInstantCliBoundary: (input) => activateInstantCliBoundary({
            ...input,
            env: { ...process.env, SYNAPSOR_TENANT_ID: "tenant-1" },
            session: { promptText: async () => undefined },
          }),
          runBoundaryReview,
          runPostActivationHandoff,
          openWorkbench: vi.fn(async () => 0),
        },
      )).resolves.toBe(0);
      expect(runBoundaryReview).not.toHaveBeenCalled();
      expect(runPostActivationHandoff).not.toHaveBeenCalled();
      await expect(fs.access(path.join(
        projectRoot,
        ".synapsor/exploration-boundary.active.json",
      ))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.chdir(suiteCwd);
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("opens metadata-only Boundary authoring without concrete tenant or principal values", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-cli-binding-"));
    const schemaInspector = vi.fn(async () => inspection());
    const runBoundaryReview = vi.fn(async () => 0);
    const runPostActivationHandoff = vi.fn(async () => 0);
    const validateTrustedScopeDefinition = vi.fn();
    const previousTenant = process.env.SYNAPSOR_TENANT_ID;
    const previousPrincipal = process.env.SYNAPSOR_PRINCIPAL;
    delete process.env.SYNAPSOR_TENANT_ID;
    delete process.env.SYNAPSOR_PRINCIPAL;
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    process.chdir(projectRoot);

    try {
      await expect(start(
        ["--from-env", "DATABASE_URL", "--cli"],
        {
          interactive: true,
          schemaInspector,
          validateTrustedScopeDefinition,
          runBoundaryReview,
          runPostActivationHandoff,
          openWorkbench: vi.fn(async () => 0),
        },
      )).resolves.toBe(0);

      expect(validateTrustedScopeDefinition).toHaveBeenCalledOnce();
      expect(runBoundaryReview).toHaveBeenCalledWith(
        ["--project-root", projectRoot, "--access", "--job-first"],
        schemaInspector,
        expect.any(Function),
      );
      expect(runPostActivationHandoff).not.toHaveBeenCalled();
      expect(output).toContain("✓ Connected");
      const draft = JSON.stringify((await loadBoundaryReviewContext(projectRoot)).draft, null, 2);
      expect(draft).toContain('"tenant_env": "SYNAPSOR_TENANT_ID"');
      expect(draft).toContain('"principal_env": "SYNAPSOR_PRINCIPAL"');
      expect(draft).not.toContain("tenant-concrete-value");
      expect(draft).not.toContain("principal-concrete-value");
      await expect(fs.access(path.join(
        projectRoot,
        ".synapsor/exploration-boundary.active.json",
      ))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousTenant === undefined) delete process.env.SYNAPSOR_TENANT_ID;
      else process.env.SYNAPSOR_TENANT_ID = previousTenant;
      if (previousPrincipal === undefined) delete process.env.SYNAPSOR_PRINCIPAL;
      else process.env.SYNAPSOR_PRINCIPAL = previousPrincipal;
      process.chdir(suiteCwd);
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("uses terminal-native hierarchy for the compact Quick Start decision", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-cli-style-"));
    const chunks: string[] = [];
    const built = buildAutoBoundary({
      inspection: inspection(),
      project: {
        root: projectRoot,
        frameworks: [],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
    });
    const styledEnv: NodeJS.ProcessEnv = {
      ...process.env,
      USER: "developer@example.test",
    };
    delete styledEnv.NO_COLOR;
    let visiblePromptContext: string[] | undefined;
    process.chdir(projectRoot);

    try {
      await writeAutoBoundaryArtifacts({ projectRoot, build: built });
      const result = await activateInstantCliBoundary({
        projectRoot,
        draft: built.exploration_boundary,
        lock: built.lock,
        schemaInspector: async () => inspection(),
        initialInspection: inspection(),
        resolveTrustedScopeFn: vi.fn(async () => ({
          tenant: "tenant-from-database-role",
          principal: "",
          tenant_source: "postgres_role_setting" as const,
          tenant_binding: "app.tenant_id",
          principal_source: "not_required" as const,
        })),
        env: styledEnv,
        stdout: {
          isTTY: true,
          write(chunk: string | Uint8Array) {
            chunks.push(String(chunk));
            return true;
          },
        } as never,
        session: {
          promptText: async (_prompt, options) => {
            visiblePromptContext = options?.context;
            return "e";
          },
        },
      });

      expect(result).toEqual({
        accepted: false,
        reason: "operator_requested_detailed_review",
      });
      const visibleFrame = visiblePromptContext?.join("\n") ?? "";
      expect(visibleFrame).toContain("YOUR FIRST SAFE QUESTION");
      expect(visibleFrame).toContain("Service Visits");
      expect(visibleFrame).toContain("3 fields across 1 table");
      expect(visibleFrame).toContain("1 field");
      expect(visibleFrame).toMatch(/\u001b\[[0-9;]+mYOUR FIRST SAFE QUESTION/u);
      expect(chunks.join("")).not.toContain("YOUR FIRST SAFE QUESTION");
    } finally {
      process.chdir(suiteCwd);
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("keeps --no-open noninteractive and rejects conflicting CLI surface flags", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-start-no-open-"));
    const runBoundaryReview = vi.fn(async () => 0);
    const openWorkbench = vi.fn(async () => 0);
    process.chdir(projectRoot);

    try {
      await expect(start(
        ["--from-env", "DATABASE_URL", "--no-open"],
        {
          interactive: false,
          schemaInspector: async () => inspection(),
          runBoundaryReview,
          openWorkbench,
        },
      )).resolves.toBe(0);
      expect(runBoundaryReview).not.toHaveBeenCalled();
      expect(openWorkbench).not.toHaveBeenCalled();

      await expect(start(
        ["--from-env", "DATABASE_URL", "--rescan", "--no-open"],
        {
          interactive: false,
          schemaInspector: async () => inspection(),
          runBoundaryReview,
          openWorkbench,
        },
      )).resolves.toBe(0);
      expect(runBoundaryReview).not.toHaveBeenCalled();
      expect(openWorkbench).not.toHaveBeenCalled();

      await expect(start(
        ["--from-env", "DATABASE_URL", "--cli", "--no-open"],
        { interactive: true },
      )).rejects.toThrow(/cannot be combined/i);
      await expect(start(
        ["--from-env", "DATABASE_URL", "--cli"],
        { interactive: false },
      )).rejects.toThrow(/interactive terminal/i);
      await expect(start(
        ["--from-env", "DATABASE_URL", "--timeout", "120"],
        { interactive: false },
      )).rejects.toThrow(/requires --cli/i);
    } finally {
      process.chdir(suiteCwd);
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
});

async function legacyQuickStart(args: string[], dependencies: GuidedStartDependencies) {
  const projectRoot = process.cwd();
  const singleOrganization = args.includes("--single-tenant");
  const build = buildAutoBoundary({ inspection: singleOrganization ? singleOrganizationInspection() : inspection(),
    project: await detectProjectContext(projectRoot),
    sourceEnv: "DATABASE_URL",
    configuredTrustedContext: { schema_version: "synapsor.configured-trusted-context-authority.v1", provider: "environment",
      ...(singleOrganization ? {} : { tenant_binding: "tenant_id" }), tenant_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL" },
    ...(singleOrganization ? { singleOrganization: { organizationId: args[args.indexOf("--organization-id") + 1]! } } : {}),
  });
  await writeAutoBoundaryArtifacts({ projectRoot, build });
  await initializeGuidedProject({ projectRoot, build, runnerVersion: "1.8.0", instantOnboarding: true });
  const result = await start(args, dependencies);
  await expect(fs.stat(path.join(projectRoot, ".synapsor/control-policy/migration.json"))).rejects.toHaveProperty("code", "ENOENT");
  return result;
}

async function activateTestRead(projectRoot: string) {
  const context = await loadBoundaryReviewContext(projectRoot);
  const saved = await saveInstantBoundaryReviewBaseline({ projectRoot, draft: context.draft, candidate: context.candidate,
    actor: "test-operator", expectedAuthoring: context.bundle.mutation_bindings.authoring });
  const digest = explorationBoundaryCandidateDigest(context.candidate);
  return activateExplorationBoundary({ projectRoot, candidate: context.candidate, reviewDraft: context.draft,
    generationLock: context.lock, expectedAuthoring: saved.authoring, expectedDigest: digest,
    actor: "test-operator", confirmation: `ACTIVATE ${digest}`, confirmedDecisions: context.candidate.unresolved_decisions,
    currentInspection: inspection() });
}

function inspection(): SchemaInspection {
  const column = (name: string, dataType: string, tenant = false) => ({
    name,
    data_type: dataType,
    nullable: false,
    generated: false,
    ordinal_position: 1,
    suggestions: {
      tenant,
      conflict: false,
      sensitive: false,
      immutable: name === "id" || tenant,
      large_or_binary: false,
    },
  });
  return {
    engine: "postgres",
    server_version: "PostgreSQL 16",
    current_user: "app_reader",
    inspected_at: "2026-07-30T12:00:00.000Z",
    schemas: ["public"],
    warnings: [],
    role_posture: {
      verified: true,
      superuser: false,
      bypass_rls: false,
      read_only: true,
      writable_relations: [],
      owned_relations: [],
      reasons: [],
    },
    tables: [{
      schema: "public",
      name: "service_visits",
      type: "table",
      writable: true,
      columns: [
        column("id", "uuid"),
        column("tenant_id", "uuid", true),
        column("status", "text"),
        column("scheduled_at", "timestamp"),
      ],
      primary_key: ["id"],
      unique_constraints: [{ name: "service_visits_pkey", columns: ["id"] }],
      foreign_keys: [],
      indexes: [{ name: "service_visits_pkey", columns: ["id"], unique: true }],
      row_level_security: true,
      row_level_security_policies: [{
        name: "tenant_read",
        command: "SELECT",
        permissive: true,
        roles: ["app_reader"],
        using_expression: "(tenant_id = current_setting('app.tenant_id')::uuid)",
      }],
      role_posture: {
        owner: "app_owner",
        current_role_is_owner: false,
        current_role_can_assume_owner: false,
        privileges: {
          select: true,
          insert: false,
          update: false,
          delete: false,
          truncate: false,
          references: false,
          trigger: false,
        },
        row_security_forced: false,
        row_security_effective_for_current_role: true,
      },
      suggestions: {
        tenant_columns: ["tenant_id"],
        conflict_columns: [],
        sensitive_columns: [],
        default_visible_columns: ["id", "tenant_id", "status", "scheduled_at"],
      },
    }],
  };
}

function singleOrganizationInspection(): SchemaInspection {
  const result = inspection();
  const table = result.tables[0]!;
  table.columns = table.columns.filter((column) => column.name !== "tenant_id");
  table.suggestions.tenant_columns = [];
  table.suggestions.default_visible_columns = table.suggestions.default_visible_columns
    .filter((column) => column !== "tenant_id");
  table.row_level_security = false;
  table.row_level_security_policies = [];
  table.role_posture!.row_security_forced = false;
  table.role_posture!.row_security_effective_for_current_role = false;
  return result;
}

function mysqlInspection(): SchemaInspection {
  const result = inspection();
  result.engine = "mysql";
  result.server_version = "MySQL 8.4";
  result.schemas = ["clinicdb"];
  const table = result.tables[0]!;
  table.schema = "clinicdb";
  table.row_level_security = false;
  table.row_level_security_policies = [];
  table.role_posture!.row_security_forced = false;
  table.role_posture!.row_security_effective_for_current_role = false;
  return result;
}
