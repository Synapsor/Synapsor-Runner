import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "@synapsor-runner/schema-inspector";
import { onboard } from "./guided-start.js";
import { structuredBoundaryAuthoringCommand } from "./boundary-structured-authoring.js";
import { actionCommand, boundaryReviewCommand, loadBoundaryReviewContext } from "./boundary-commands.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import * as actionTui from "./action-tui.js";
import { listActionRuleAuthorityDrafts, readActionRuleAuthorityActivation } from "./action-rule-authority.js";
import { loadActivatedExplorationBoundaries } from "./auto-boundary.js";
import { runPostActivationAskHandoff } from "./post-activation-ask.js";
import * as semanticDeployment from "./semantic-action-deployment.js";
import { readPausedExecutionSetup } from "./semantic-execution-setup.js";
import { terminalContentWidth, wrapStyledTerminalLine } from "./terminal-layout.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("public governed Action review", () => {
  it("uses the governed Read URL then the separately configured writer without consulting a legacy lock", async () => {
    const root = await savedProject();
    const configPath = path.join(root, "synapsor.runner.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    config.sources.local_postgres.write_url_env = "GOVERNED_REVIEW_WRITER_URL";
    await fs.writeFile(configPath, JSON.stringify(config));
    const legacyPath = path.join(root, ".synapsor/generation-lock.json");
    await fs.writeFile(legacyPath, JSON.stringify({ engine: "mysql", source_env: "UNREVIEWED_EXPORT_URL", inspected_schema: "wrong_schema" }));
    const reader = inspection(), writer = inspection();
    writer.current_user = "writer"; writer.role_posture!.read_only = false;
    writer.role_posture!.writable_relations = ["university.registrations"];
    writer.tables[0]!.role_posture!.privileges.update = true;
    const inspect = vi.spyOn(schema, "inspectDatabase").mockImplementation(async (input) =>
      input.databaseUrlEnv === "GOVERNED_REVIEW_READ_URL" ? reader : writer);
    const drafts = await listActionRuleAuthorityDrafts(root);
    const result = await actionTui.inspectActionProject(root, { GOVERNED_REVIEW_READ_URL: "read-not-used", GOVERNED_REVIEW_WRITER_URL: "write-not-used" });
    expect(inspect.mock.calls.map(([input]) => [input.engine, input.databaseUrlEnv, input.schema])).toEqual([
      ["postgres", "GOVERNED_REVIEW_READ_URL", "university"], ["postgres", "GOVERNED_REVIEW_WRITER_URL", "university"],
    ]);
    expect(result.current_user).toBe("writer");
    expect(result.tables[0]!.columns).toEqual(reader.tables[0]!.columns);
    expect(result.tables[0]!.role_posture!.privileges.update).toBe(true);
    expect(await listActionRuleAuthorityDrafts(root)).toEqual(drafts);
    expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
    expect(JSON.parse(await fs.readFile(legacyPath, "utf8")).source_env).toBe("UNREVIEWED_EXPORT_URL");
  });

  it("does not fall back to a legacy lock when the governed repository is unavailable", async () => {
    const root = await savedProject();
    await fs.writeFile(path.join(root, ".synapsor/generation-lock.json"), JSON.stringify({
      engine: "postgres", source_env: "UNREVIEWED_EXPORT_URL", inspected_schema: "university",
    }));
    await fs.rm(path.join(root, ".synapsor/local.db"));
    const inspect = vi.spyOn(schema, "inspectDatabase").mockResolvedValue(inspection());
    await expect(actionTui.inspectActionProject(root)).rejects.toHaveProperty("code", "POLICY_REPOSITORY_UNAVAILABLE");
    expect(inspect).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(root, ".synapsor/local.db"))).rejects.toHaveProperty("code", "ENOENT");
  });

  it.each([
    ["action review", 52], ["action review", 80], ["action review", 120], ["Read activation then Q", 80],
  ] as const)("reaches the saved verified draft through %s at %i columns without a legacy generation lock or new model job", async (entry, columns) => {
    const root = await savedProject();
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((value) => { output.push(String(value)); return true; });
    const inspect = vi.spyOn(schema, "inspectDatabase").mockResolvedValue(inspection());
    const noModel = vi.fn(async () => { throw new Error("No model or new job is permitted"); });
    const savedDrafts = await listActionRuleAuthorityDrafts(root);
    expect(savedDrafts).toHaveLength(1);
    let configBefore: string | undefined;
    const realControlPlane = actionTui.runActionControlPlane;
    const screens: string[] = [];
    let exactDetails: string[] = [];
    let detailFrames = "";
    const terminal = fakeTerminal(columns, 12);
    const terminalPrompter = actionTui.createTerminalActionPrompter(terminal.input, terminal.output);
    let visitedHome = false, visitedDetails = false;
    const prompter: actionTui.ActionControlPrompter = {
      terminalColumns: columns,
      choose: async (title, choices, context) => {
        screens.push(title);
        if (choices.some((choice) => choice.value === "verified_action")) {
          expect(choices.find((choice) => choice.value === "verified_action")?.label).toContain("Verified Action Boundary");
          if (visitedHome) return "quit";
          visitedHome = true; return "verified_action";
        }
        if (title === "EXACT VERIFIED ACTION DETAILS") {
          exactDetails = context ?? [];
          detailFrames = (await pageTerminalDetails(terminal, terminalPrompter, title, exactDetails, "Back to Action Boundary")).frames;
          return "back";
        }
        expect(title).toBe("VERIFIED ACTION BOUNDARY");
        expect(choices.find((choice) => choice.value === "activate")?.disabled).toBe(false);
        if (visitedDetails) return "back";
        visitedDetails = true; return "details_draft";
      },
      text: noModel, confirm: noModel, message: async () => undefined,
    };
    const controlPlane = vi.spyOn(actionTui, "runActionControlPlane").mockImplementation((input) => realControlPlane({ ...input, prompter }));
    const runAsk = vi.fn(async () => 0), runBoundaryReview = vi.fn(async () => 0);
    const chooseRoute = vi.fn(async (initial: string, choices?: readonly { id: string; label: string }[]) => {
      expect(initial).toBe("review-outcomes");
      expect(choices).toContainEqual(expect.objectContaining({ id: "review-outcomes", label: "Review saved verified outcomes" }));
      expect(choices?.some((choice: { id: string }) => choice.id === "create-outcome")).toBe(false);
      return "review-outcomes" as const;
    });
    let visits = 0;
    const session = { chooseResource: async () => visits++ === 0 ? { action: "confirm" } : undefined,
      editFieldTiers: noModel, promptText: async () => "fixture_reviewer", confirm: async () => true,
      confirmActivation: async () => true, close: vi.fn() } as BoundaryReviewInteractiveSession;
    expect(await boundaryReviewCommand(["--project-root", root, "--access"], async () => inspection(), session,
      entry === "Read activation then Q" ? async () => {
        configBefore = await fs.readFile(path.join(root, "synapsor.runner.json"), "utf8");
        return runPostActivationAskHandoff({ projectRoot: root, autoStartConfiguredProvider: true }, {
          env: { OPENAI_API_KEY: "not-used" }, chooseRoute, runAsk, runBoundaryReview,
          stdout: { write: (value) => { output.push(String(value)); return true; } }, stderr: { write: () => true },
        });
      } : undefined)).toBe(0);
    const activeReads = await loadActivatedExplorationBoundaries(root);
    expect(activeReads).toHaveLength(1);
    const reviewed = await loadBoundaryReviewContext(root);
    if (entry === "action review") {
      configBefore = await fs.readFile(path.join(root, "synapsor.runner.json"), "utf8");
      expect(await actionCommand(["review", "--project-root", root])).toBe(0);
    }
    else {
      expect(chooseRoute).toHaveBeenCalledOnce();
      expect(output.join("")).toContain("Saved verified Action draft");
      expect(output.join("")).not.toContain("Adding verified change outcomes is optional");
    }
    expect(controlPlane).toHaveBeenCalledOnce();
    expect(screens).toContain("EXACT VERIFIED ACTION DETAILS");
    expect(exactDetails.join("\n")).toContain("university.enroll");
    const table = exactDetails.filter((line) => /^[+|]/u.test(line));
    expect(table.length).toBeGreaterThan(4);
    expect(table.every((line) => line.length === columns - 6)).toBe(true);
    expect(table.join("\n")).toContain("12 credits");
    expect(table.join("\n")).toContain("18 credits");
    const renderedRows = stripAnsi(detailFrames).split(/\r?\n/u).map((line) => line.trim());
    for (const line of table) expect(renderedRows).toContain(line);
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ engine: "postgres", databaseUrlEnv: "GOVERNED_REVIEW_READ_URL", schema: "university" }));
    expect(noModel).not.toHaveBeenCalled(); expect(runAsk).not.toHaveBeenCalled(); expect(runBoundaryReview).not.toHaveBeenCalled();
    expect(await listActionRuleAuthorityDrafts(root)).toEqual(savedDrafts);
    expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
    expect(await loadActivatedExplorationBoundaries(root)).toEqual(activeReads);
    expect((await loadBoundaryReviewContext(root)).bundle.candidate_digest).toBe(reviewed.bundle.candidate_digest);
    expect(await fs.readFile(path.join(root, "synapsor.runner.json"), "utf8")).toBe(configBefore);
    await expect(fs.stat(path.join(root, ".synapsor/generation-lock.json"))).rejects.toHaveProperty("code", "ENOENT");
    await expect(fs.stat(path.join(root, "synapsor.actions.runner.json"))).rejects.toHaveProperty("code", "ENOENT");
  });

  it("pages exact writer requirements and the exported handoff through public Action review without changing pending authority", async () => {
    const root = await savedProject("supervised");
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const inspect = vi.spyOn(schema, "inspectDatabase").mockResolvedValue(inspection());
    let readVisits = 0;
    const readSession = { chooseResource: async () => readVisits++ === 0 ? { action: "confirm" } : undefined,
      editFieldTiers: async () => { throw new Error("The saved Read draft must not be edited"); },
      promptText: async () => "fixture_reviewer", confirm: async () => true,
      confirmActivation: async () => true, close: vi.fn() } as BoundaryReviewInteractiveSession;
    expect(await boundaryReviewCommand(["--project-root", root, "--access"], async () => inspection(), readSession)).toBe(0);
    const realControlPlane = actionTui.runActionControlPlane;
    let mode: "activate" | "recover" = "activate", homeVisits = 0;
    const recoveryChoices = ["details", "export", "details", "pause"];
    const displayed: Array<{ title: string; lines: string[]; back?: string; frames: string; settledBeforeDismiss: boolean }> = [];
    const terminal = fakeTerminal(80, 12);
    const terminalPrompter = actionTui.createTerminalActionPrompter(terminal.input, terminal.output);
    const confirm = vi.fn(async (label: string) => {
      expect(mode).toBe("activate");
      expect(label).toContain("Activate verified Action Boundary");
      return true;
    });
    const noText = vi.fn(async () => { throw new Error("No model, new job, or credential entry is permitted"); });
    const prompter: actionTui.ActionControlPrompter = {
      get terminalColumns() { return terminalPrompter.terminalColumns; },
      choose: async (title, choices, context) => {
        if (choices.some((choice) => choice.value === "verified_action")) return homeVisits++ === 0 ? "verified_action" : "quit";
        if (title === "VERIFIED ACTION BOUNDARY") return mode === "activate" ? "activate" : "enable_execution:university.enroll";
        if (title === "Check your write connection") return "check";
        expect(title).toBe("Execution needs a deployment fix");
        expect(context?.join("\n")).toContain("Private row-lock permissions are missing");
        expect(context?.join("\n")).toContain("SEMANTIC_ACTION_WRITER_POSTURE_INVALID");
        const choice = recoveryChoices.shift();
        expect(choices.some((item) => item.value === choice && !item.disabled)).toBe(true);
        return choice;
      },
      text: noText, confirm,
      message: async (title, lines, back) => {
        if (title !== "Writer requirements" && title !== "Dedicated writer handoff saved") return;
        displayed.push({ title, lines: [...lines], back, ...await pageTerminalDetails(terminal, terminalPrompter, title, lines, back) });
      },
    };
    vi.spyOn(actionTui, "runActionControlPlane").mockImplementation((input) => realControlPlane({ ...input, prompter }));
    expect(await actionCommand(["review", "--project-root", root])).toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
    mode = "recover"; homeVisits = 0; confirm.mockClear();
    vi.stubEnv("SYNAPSOR_DATABASE_WRITE_URL", "postgresql://fixture.invalid/writer-not-used");
    const active = await readActionRuleAuthorityActivation(root);
    expect(active).toBeDefined();
    const reads = await loadActivatedExplorationBoundaries(root);
    const drafts = await listActionRuleAuthorityDrafts(root);
    const candidate = (await loadBoundaryReviewContext(root)).bundle.candidate_digest;
    const configPaths = ["synapsor.runner.json", "synapsor.actions.runner.json"];
    const configs = await Promise.all(configPaths.map((file) => fs.readFile(path.join(root, file), "utf8")));
    const execution = await semanticDeployment.readSemanticSupervisedExecutionState({ projectRoot: root });
    const preview = vi.spyOn(semanticDeployment, "previewSemanticSupervisedExecution");
    const enable = vi.spyOn(semanticDeployment, "enableSemanticSupervisedExecution");
    expect(await actionCommand(["review", "--project-root", root])).toBe(0);
    expect(recoveryChoices).toEqual([]);
    expect(displayed.map((page) => page.title)).toEqual(["Writer requirements", "Dedicated writer handoff saved", "Writer requirements"]);
    expect(displayed.every((page) => page.back === "Return to pending review")).toBe(true);
    for (const page of displayed) {
      expect(page.settledBeforeDismiss).toBe(false);
      const visible = stripAnsi(page.frames).replace(/\s+/gu, " ");
      expect(visible).toContain("PgUp/PgDn");
      expect(visible).toContain("Return to pending review");
      for (const line of page.lines.filter(Boolean)) {
        for (const row of wrapStyledTerminalLine(`  ${line}`, terminalContentWidth(80))) {
          expect(visible).toContain(row.trim().replace(/\s+/gu, " "));
        }
      }
    }
    const requirements = displayed[0]!.lines.join("\n");
    expect(requirements).toContain("writer_row_lock_privilege_missing");
    expect(requirements).toContain("UPDATE (registration_id) for row locking");
    expect(requirements).toContain("Required: SELECT; UPDATE (status, version)");
    expect(requirements).toContain("Enabling execution remains a separate confirmation");
    const handoff = displayed[1]!.lines[0]!.slice("Administrator handoff: ".length);
    expect(await fs.readdir(handoff)).toEqual(["README.md", "grants.sql", "requirements.json"]);
    const plan = JSON.parse(await fs.readFile(path.join(handoff, "requirements.json"), "utf8"));
    expect(plan.action_digest).toBe(active!.authority.action_boundary.digest);
    expect(plan.outcome).toBe("university.enroll");
    expect(plan.relations[0]).toMatchObject({ relation: "university.registrations", lock_column: "registration_id", update_columns: ["status", "version"] });
    expect(displayed[2]!.lines).toEqual([...displayed[0]!.lines, "", ...displayed[1]!.lines]);
    const paused = await readPausedExecutionSetup(root, active!.authority.action_boundary.digest);
    expect(paused?.problem.details).toEqual(displayed[2]!.lines);
    expect(preview).toHaveBeenCalledOnce(); expect(enable).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled(); expect(noText).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ databaseUrlEnv: "SYNAPSOR_DATABASE_WRITE_URL" }));
    expect(JSON.stringify(displayed)).not.toContain("postgresql://");
    expect(await readActionRuleAuthorityActivation(root)).toEqual(active);
    expect(await loadActivatedExplorationBoundaries(root)).toEqual(reads);
    expect(await listActionRuleAuthorityDrafts(root)).toEqual(drafts);
    expect((await loadBoundaryReviewContext(root)).bundle.candidate_digest).toBe(candidate);
    expect(await Promise.all(configPaths.map((file) => fs.readFile(path.join(root, file), "utf8")))).toEqual(configs);
    expect(await semanticDeployment.readSemanticSupervisedExecutionState({ projectRoot: root })).toEqual(execution);
  });

  it("reports the live terminal width to review adapters", () => {
    const terminal = fakeTerminal(80, 12);
    const prompter = actionTui.createTerminalActionPrompter(terminal.input, terminal.output);
    expect(prompter.terminalColumns).toBe(80);
    terminal.output.columns = 52;
    expect(prompter.terminalColumns).toBe(52);
    terminal.output.columns = 120;
    expect(prompter.terminalColumns).toBe(120);
  });
});

async function savedProject(writeback: "proposal_only" | "supervised" = "proposal_only"): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-governed-action-review-")); roots.push(root);
  vi.stubEnv("GOVERNED_REVIEW_READ_URL", "postgresql://fixture.invalid/not-used");
  vi.stubEnv("SYNAPSOR_DATABASE_WRITE_URL", undefined);
  vi.stubEnv("OPENAI_API_KEY", undefined); vi.stubEnv("ANTHROPIC_API_KEY", undefined);
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    expect(await onboard(["db", "--project-root", root, "--from-env", "GOVERNED_REVIEW_READ_URL", "--schema", "university", "--json"],
      { interactive: false, schemaInspector: async () => inspection() })).toBe(0);
    expect(await structuredBoundaryAuthoringCommand(["--project-root", root, "--export-draft", "draft.json", "--json"], async () => inspection()),
      output.mock.calls.map(([chunk]) => String(chunk)).join("")).toBe(0);
    const request = JSON.parse(await fs.readFile(path.join(root, "draft.json"), "utf8"));
    request.read.resources = [{ resource_id: "university.registrations", include: true, tenant_key: "tenant_id", principal_key: "principal_id",
      row_identity: "registration_id", selectable_fields: ["registration_id", "status", "credits", "version"],
      withhold_from_model_fields: ["registration_id", "version", "credits"], private_model_fields: ["registration_id", "version", "credits"] }];
    const text = (value: string) => ({ kind: "literal", value, value_type: { kind: "string", max_length: 32, comparison: "exact" } });
    request.actions = [{ schema_version: "synapsor.action-rule-model-draft.v1", name: "university.enroll", outcome: "university.enroll",
      verification: { name: "university.enrollment_check", resources: [{ binding: "registration", resource: "university.registrations",
        source: { kind: "subject_ref" }, fields: ["credits"] }] },
      effect: { name: "university.enrollment_effect", operation: "update", target_resource: "university.registrations", target_binding: "registration",
        allowed_fields: [{ name: "status", values: ["enrolled"] }], set: { status: text("enrolled") }, writeback },
      require: { kind: "compare", operator: "lte", left: { kind: "field", binding: "registration", field: "credits" },
        right: { kind: "literal", value: 16, value_type: { kind: "integer" } } }, derive: {},
      approval: { class_name: "university.registrar", mode: "human", required_role: "registrar", required_approvals: 1, shared_limits: [] }, ttl_seconds: 300,
      review: { when: "Reviewed credits do not exceed 16", then: "Propose enrollment", refused: ["Credit limit exceeded"],
        human_review: "A registrar reviews each valid request", examples: [{ kind: "eligible", scenario: "12 credits", result: "Create proposal" },
          { kind: "ineligible", scenario: "18 credits", result: "Refuse" }] } }];
    await fs.writeFile(path.join(root, "draft.json"), JSON.stringify(request));
    expect(await structuredBoundaryAuthoringCommand(["--project-root", root, "--draft", "draft.json", "--json"], async () => inspection()),
      output.mock.calls.map(([chunk]) => String(chunk)).join("")).toBe(0);
    return root;
  } finally { output.mockRestore(); }
}

function fakeTerminal(columns: number, rows: number) {
  const input = new PassThrough() as PassThrough & ReadStream;
  input.isTTY = true; input.isRaw = false;
  input.setRawMode = (raw) => { input.isRaw = raw; return input; };
  const output = new PassThrough() as PassThrough & WriteStream;
  Object.assign(output, { isTTY: true, columns, rows });
  return { input, output };
}

async function pageTerminalDetails(terminal: ReturnType<typeof fakeTerminal>, prompter: actionTui.ActionControlPrompter,
  title: string, lines: string[], back?: string) {
  const pending = prompter.message(title, lines, back);
  let settled = false;
  void pending.then(() => { settled = true; });
  await nextTurn();
  let previousFrame = terminal.output.read()?.toString() ?? "";
  let frames = previousFrame;
  for (let page = 0; page < lines.length * 3; page++) {
    terminal.input.emit("keypress", "", { name: "pagedown", sequence: "\u001b[6~" });
    await nextTurn();
    const frame = terminal.output.read()?.toString() ?? "";
    frames += frame;
    if (frame === previousFrame) break;
    previousFrame = frame;
  }
  const settledBeforeDismiss = settled;
  terminal.input.emit("keypress", "", { name: "escape", sequence: "\u001b" });
  await pending;
  expect(terminal.input.isRaw).toBe(false);
  return { frames, settledBeforeDismiss };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "");

function inspection(): schema.SchemaInspection {
  const names = ["registration_id", "tenant_id", "principal_id", "status", "credits", "version"];
  return { engine: "postgres", server_version: "PostgreSQL 16", current_user: "reader", inspected_at: "2026-09-08T00:00:00.000Z",
    schemas: ["university"], warnings: [], role_posture: { verified: true, superuser: false, bypass_rls: false, read_only: true,
      writable_relations: [], owned_relations: [], reasons: [] }, tables: [{ schema: "university", name: "registrations", type: "table", writable: true,
      columns: names.map((name, ordinal_position) => ({ name, data_type: ["credits", "version"].includes(name) ? "integer" : "text",
        ordinal_position, nullable: false, generated: false, suggestions: { tenant: name === "tenant_id", conflict: name === "version",
          sensitive: false, immutable: name.endsWith("_id"), large_or_binary: false } })),
      primary_key: ["registration_id"], unique_constraints: [{ name: "registrations_pkey", columns: ["registration_id"] }],
      check_constraints: [], foreign_keys: [], row_level_security: false, indexes: [], role_posture: { owner: "owner",
        current_role_is_owner: false, current_role_can_assume_owner: false,
        privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false },
        row_security_forced: false, row_security_effective_for_current_role: false },
      suggestions: { tenant_columns: ["tenant_id"], conflict_columns: ["version"], sensitive_columns: [], default_visible_columns: ["status"] } }],
  };
}
