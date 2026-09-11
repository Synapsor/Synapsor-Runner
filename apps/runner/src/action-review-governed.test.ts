import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "@synapsor-runner/schema-inspector";
import { onboard } from "./guided-start.js";
import { structuredBoundaryAuthoringCommand } from "./boundary-structured-authoring.js";
import { actionCommand, boundaryActivateCommand, boundaryReviewCommand, loadBoundaryReviewContext } from "./boundary-commands.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import * as actionTui from "./action-tui.js";
import type { BoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import { listActionRuleAuthorityDrafts, readActionRuleAuthorityActivation, loadActiveActionRuleAuthority,
  buildActionRuleAuthorityDraft, writeActionRuleAuthorityDraft } from "./action-rule-authority.js";
import * as readAuthoring from "./control-policy-read-authoring-project.js";
import { loadActivatedExplorationBoundaries } from "./auto-boundary.js";
import { runPostActivationAskHandoff } from "./post-activation-ask.js";
import * as clientHandoff from "./post-activation-ask.js";
import { main } from "./cli.js";
import * as semanticDeployment from "./semantic-action-deployment.js";
import { readPausedExecutionSetup } from "./semantic-execution-setup.js";
import { terminalContentWidth, wrapStyledTerminalLine } from "./terminal-layout.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { prepareBoundaryRescan, commitBoundaryRescan } from "./boundary-rescan.js";
import { revalidateSavedActionReadDependencies } from "./action-read-recovery.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("public governed Action review", () => {
  it("wires the public action command to client setup and returns without activating again", async () => {
    const root = await savedProject();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(schema, "inspectDatabase").mockResolvedValue(inspection());
    let visits = 0;
    const readSession = { chooseResource: async () => visits++ === 0 ? { action: "confirm" } : undefined,
      editFieldTiers: async () => undefined, promptText: async () => "fixture_reviewer", confirm: async () => true,
      confirmActivation: async () => true } as BoundaryReviewInteractiveSession;
    await boundaryReviewCommand(["--project-root", root, "--access"], async () => inspection(), readSession);
    const draft = (await listActionRuleAuthorityDrafts(root))[0]!;
    await semanticDeployment.activateSemanticActionRuntime({ projectRoot: root, draft, actor: "fixture_reviewer" });
    const reads = await loadActivatedExplorationBoundaries(root), action = await readActionRuleAuthorityActivation(root);
    const drafts = await listActionRuleAuthorityDrafts(root);
    const setup = vi.spyOn(clientHandoff, "continueClientSetup").mockResolvedValue(0);
    const noQuestion = vi.fn(async () => { throw new Error("No new job or authority decision is needed"); });
    let homes = 0, reviews = 0;
    const prompter: actionTui.ActionControlPrompter = {
      choose: async (title, choices) => {
        if (title === "ACTION BOUNDARY") return homes++ === 0 ? "verified_action" : "quit";
        expect(title).toBe("VERIFIED ACTION BOUNDARY");
        expect(choices.some(choice => choice.value === "client_setup")).toBe(true);
        return reviews++ === 0 ? "client_setup" : "back";
      }, text: noQuestion, confirm: noQuestion, message: async () => undefined,
    };
    const run = actionTui.runActionControlPlane;
    vi.spyOn(actionTui, "runActionControlPlane").mockImplementation(input => run({ ...input, prompter }));
    expect(await main(["action", "review", "--project-root", root])).toBe(0);
    expect(setup).toHaveBeenCalledExactlyOnceWith(root);
    expect(reviews).toBe(2); expect(noQuestion).not.toHaveBeenCalled();
    expect(await loadActivatedExplorationBoundaries(root)).toEqual(reads);
    expect(await readActionRuleAuthorityActivation(root)).toEqual(action);
    expect(await listActionRuleAuthorityDrafts(root)).toEqual(drafts);
  }, 20_000);

  it("shows an already active Read revision truthfully and preserves it when repeated activation is declined", async () => {
    const root = await savedProject("proposal_only", false);
    const writes = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let visits = 0;
    const session = { chooseResource: async () => visits++ === 0 ? { action: "confirm" } : undefined,
      editFieldTiers: async () => undefined, promptText: async () => "fixture_reviewer", confirm: async () => true,
      confirmActivation: async () => true, close: vi.fn() } as BoundaryReviewInteractiveSession;
    expect(await boundaryReviewCommand(["--project-root", root, "--access"], async () => inspection(), session)).toBe(0);
    const before = await loadActivatedExplorationBoundaries(root);
    writes.mockClear();
    expect(await boundaryActivateCommand(["--project-root", root], async () => inspection(),
      { ...session, confirm: async () => false })).toBe(0);
    const summary = writes.mock.calls.map(call => String(call[0])).join("");
    expect(summary).toMatch(/reviewed_staging\s+ACTIVE\s+1\s+Complete/u);
    expect(summary).toContain("Authority active: yes, this exact revision");
    expect(summary).not.toContain("REVIEWED - NOT ACTIVE");
    expect(summary).not.toContain("Next: synapsor-runner boundary activate");
    expect(summary).toContain("Existing active Read authority is unchanged");
    expect(summary).not.toMatch(/reviewed and inactive|Authority active: no|REVIEWED - NOT ACTIVE/u);
    expect(await loadActivatedExplorationBoundaries(root)).toEqual(before);
  }, 20_000);

  it("opens model-guided first-action setup before manual Read sign-off, without compatibility controls", async () => {
    const root = await savedProject("proposal_only", false);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const before = await loadBoundaryReviewContext(root);
    const prompts: string[] = [];
    const noLegacy = vi.fn(async () => { throw new Error("Compatibility action controls must not open"); });
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => ({ action: "actions", boundary_name: before.candidate.pack.name }),
      editFieldTiers: async () => undefined,
      promptText: async () => undefined,
      confirm: async () => false,
      chooseOption: async (title) => {
        prompts.push(title);
        if (title === "DESCRIBE A CHANGE") return "guided";
        expect(title).toBe("START BOUNDARY DRAFTING");
        return undefined;
      },
    };
    const chat: BoundaryAuthoringChat = {
      session: { ...session, presentationMode: "conversation" },
      actionPrompter: { choose: noLegacy, text: noLegacy, confirm: noLegacy, message: noLegacy },
      setModel: vi.fn(), runner: vi.fn(), model: vi.fn(), checkpoint: vi.fn(),
      streamRunner: async () => {}, streamCheckpoint: async () => {}, streamModel: async () => {},
      rememberDetails: vi.fn(), showDetails: vi.fn(), providerStream: vi.fn(),
      progress: (_message, operation) => operation(), close: vi.fn(),
    };
    expect(await boundaryReviewCommand(["--project-root", root, "--access"], async () => inspection(), session,
      undefined, { exitAfterAgentJob: true, boundaryAuthoringChatFactory: () => chat,
        runDelegationActionReview: noLegacy })).toBe(0);
    expect(prompts).toEqual(["DESCRIBE A CHANGE", "START BOUNDARY DRAFTING"]);
    expect(noLegacy).not.toHaveBeenCalled();
    expect(await listActionRuleAuthorityDrafts(root)).toEqual([]);
    await expect(loadActivatedExplorationBoundaries(root)).rejects.toThrow("No exploration boundary is active");
    expect((await loadBoundaryReviewContext(root)).bundle.candidate_digest).toBe(before.bundle.candidate_digest);
  }, 20_000);

  it("starts the first action from saved Read authority without entering legacy proposal controls", async () => {
    const root = await savedProject("proposal_only", false);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let visits = 0;
    const session = { chooseResource: async () => visits++ === 0 ? { action: "confirm" } : undefined,
      editFieldTiers: async () => undefined, promptText: async () => "fixture_reviewer", confirm: async () => true,
      confirmActivation: async () => true, close: vi.fn() } as BoundaryReviewInteractiveSession;
    expect(await boundaryReviewCommand(["--project-root", root, "--access"], async () => inspection(), session)).toBe(0);
    const before = await loadActivatedExplorationBoundaries(root);
    expect(before).toHaveLength(1);
    const review = vi.fn(async () => ({ tone: "success" as const, title: "Drafting paused", lines: [] }));
    const noLegacy = vi.fn(async () => { throw new Error("Legacy controls must not open for a fresh governed project"); });
    expect(await actionTui.runActionControlPlane({ projectRoot: root, inspection: inspection(),
      modelGuidedVerifiedActionRevision: review,
      prompter: { choose: noLegacy, text: noLegacy, confirm: noLegacy, message: noLegacy },
    })).toMatchObject({ state: "closed", activated_actions: [] });
    expect(review).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectRoot: root, boundaryName: before[0]!.pack.name }));
    expect(noLegacy).not.toHaveBeenCalled();
    expect(await loadActivatedExplorationBoundaries(root)).toEqual(before);
    expect(await listActionRuleAuthorityDrafts(root)).toEqual([]);
    await expect(fs.stat(path.join(root, ".synapsor/generation-lock.json"))).rejects.toHaveProperty("code", "ENOENT");
  }, 20_000);

  it("routes the empty Action case from Boundary access into the manual semantic editor", async () => {
    const root = await savedProject("proposal_only", false);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const prompts: string[] = [];
    const actionPrompter: actionTui.ActionControlPrompter = {
      choose: async (title) => {
        prompts.push(title);
        if (title === "MANUAL SEMANTIC ACTIONRULE") return "back";
        throw new Error(`Unexpected Action prompt: ${title}`);
      },
      text: async () => undefined,
      confirm: async () => undefined,
      message: async () => undefined,
    };
    const actionControlPlane = vi.fn(async (input: Parameters<typeof actionTui.runActionControlPlane>[0]) =>
      actionTui.runActionControlPlane({ ...input, prompter: actionPrompter, env: {} }));
    const selections = [
      { action: "confirm" as const },
      { action: "actions" as const, boundary_name: "reviewed_staging" },
      undefined,
    ];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => selections.shift(),
      editFieldTiers: async () => undefined,
      promptText: async () => "fixture_reviewer",
      chooseOption: async (title, choices) => {
        expect(title).toBe("DESCRIBE A CHANGE");
        expect(choices.map((choice) => choice.value)).toEqual(["guided", "manual", "back"]);
        return "manual";
      },
      confirm: async () => true,
      confirmActivation: async () => true,
    };

    expect(await boundaryReviewCommand(
      ["--project-root", root, "--access"],
      async () => inspection(),
      session,
      undefined,
      {
        actionProjectInspector: async () => inspection(),
        runDelegationActionReview: actionControlPlane,
      },
    )).toBe(0);

    expect(actionControlPlane).toHaveBeenCalledOnce();
    expect(actionControlPlane).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: root,
      boundaryName: "reviewed_staging",
      initialManualSemantic: true,
    }));
    expect(prompts).toEqual(["MANUAL SEMANTIC ACTIONRULE"]);
    await expect(readActionRuleAuthorityActivation(root)).resolves.toBeUndefined();
    expect(await listActionRuleAuthorityDrafts(root)).toEqual([]);
    expect(await loadActivatedExplorationBoundaries(root)).toHaveLength(1);
  }, 20_000);

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

  it("opens the manual editor for an existing disabled outcome before Read activation", async () => {
    const root = await savedProject();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const before = await listActionRuleAuthorityDrafts(root);
    const readBefore = await loadBoundaryReviewContext(root);
    const menus: string[] = [];
    let visit = 0;
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => visit++ === 0 ? { action: "actions", boundary_name: "reviewed_staging" } : undefined,
      editFieldTiers: async () => undefined, promptText: async () => undefined, confirm: async () => false,
      chooseOption: async (title, choices) => {
        expect(title).toBe("VERIFIED ACTION BOUNDARY");
        expect(choices.find(choice => choice.value === "activate")?.disabled).toBe(true);
        expect(choices.find(choice => choice.value === "manual_revision")?.disabled).not.toBe(true);
        return "manual_revision";
      },
    };
    const runManual = vi.fn(async (input: Parameters<typeof actionTui.runActionControlPlane>[0]) =>
      actionTui.runActionControlPlane({ ...input, env: {}, prompter: {
        choose: async title => { menus.push(title); expect(title).toBe("MANUAL SEMANTIC ACTIONRULE"); return "back"; },
        text: async () => undefined, confirm: async () => false, message: async () => {},
      } }));
    expect(await boundaryReviewCommand(["--project-root", root, "--access"], async () => inspection(), session, undefined,
      { runDelegationActionReview: runManual, actionProjectInspector: async () => inspection() })).toBe(0);
    expect(runManual).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ initialManualSemantic: true }));
    expect(menus).toEqual(["MANUAL SEMANTIC ACTIONRULE"]);
    expect(await listActionRuleAuthorityDrafts(root)).toEqual(before);
    expect((await loadBoundaryReviewContext(root)).bundle.candidate_digest).toBe(readBefore.bundle.candidate_digest);
    expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
    await expect(loadActivatedExplorationBoundaries(root)).rejects.toThrow("No exploration boundary is active");
  }, 20_000);

  it("shows unfinished saved work and returns to the same disabled Action review without new egress or authority", async () => {
    const root = await savedProject();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const before = await listActionRuleAuthorityDrafts(root);
    const context = await loadBoundaryReviewContext(root);
    const binding = { boundary_name: context.candidate.pack.name,
      generation_lock_fingerprint: context.candidate.generation_lock_fingerprint,
      schema_fingerprint: context.lock.schema_fingerprint, role_posture_fingerprint: context.lock.role_posture_fingerprint };
    const saved = buildBoundaryAuthoringResumeState({ binding, stage: "action_drafting",
      jobIntent: "Help with enrollment and release completed advising holds.", provider: "openai", model: "gpt-test",
      action: { intent: "Enroll in an eligible course.", intents: ["Enroll in an eligible course.", "Release a completed advising hold."],
        completed_outcomes: ["university.enroll"] } });
    await writeBoundaryAuthoringResumeState(root, saved);
    let visit = 0, review = 0;
    const noModel = vi.fn(async () => { throw new Error("No model request is allowed while viewing local saved work."); });
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => visit++ === 0 ? { action: "actions", boundary_name: binding.boundary_name } : undefined,
      editFieldTiers: async () => undefined, promptText: noModel, confirm: async () => false,
      chooseOption: async (title, choices, options) => {
        if (title === "UNFINISHED SAVED WORK") {
          expect(options?.context?.join("\n")).toContain("Release a completed advising hold.");
          expect(options?.context?.join("\n")).toContain("not removed or treated as implemented");
          return "back";
        }
        expect(title).toBe("VERIFIED ACTION BOUNDARY");
        expect(options?.context?.join("\n")).toContain("1 requested change remains unfinished");
        expect(choices.some(choice => choice.value === "details_pending_job")).toBe(true);
        expect(choices.find(choice => choice.value === "activate")?.disabled).toBe(true);
        return review++ === 0 ? "details_pending_job" : "back";
      },
    };
    expect(await boundaryReviewCommand(["--project-root", root, "--access"], async () => inspection(), session, undefined,
      { actionProjectInspector: async () => inspection() })).toBe(0);
    expect(review).toBe(2);
    expect(noModel).not.toHaveBeenCalled();
    expect(await listActionRuleAuthorityDrafts(root)).toEqual(before);
    expect((await loadBoundaryReviewContext(root)).bundle).toEqual(context.bundle);
    expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: saved });
    expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
    await expect(loadActivatedExplorationBoundaries(root)).rejects.toThrow("No exploration boundary is active");
  }, 20_000);

  it.each([true, false, "inspection_failure"] as const)("returns directly from linked Read approval to the saved actions (accepted=%s)", async accepted => {
    const root = await savedProject();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const before = await listActionRuleAuthorityDrafts(root);
    const readBefore = await loadBoundaryReviewContext(root);
    let failInspection = false;
    const confirmActivation = vi.fn(async () => { failInspection = accepted === "inspection_failure"; return accepted !== false; });
    const showReviewDetails = vi.fn(async (title: string, lines: string[]) => {
      expect(title).toBe("Read access needs attention");
      expect(lines.join("\n")).toContain("fixture connection unavailable");
    });
    let visits = 0, reviews = 0;
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => visits++ === 0 ? { action: "actions", boundary_name: "reviewed_staging" } : undefined,
      editFieldTiers: async () => undefined, promptText: async () => "fixture_reviewer",
      confirm: async () => true, confirmActivation, showReviewDetails,
      chooseOption: async (title, choices) => {
        expect(title).toBe("VERIFIED ACTION BOUNDARY");
        if (reviews++ === 0) {
          expect(choices.some(choice => choice.value === "revalidate_read")).toBe(false);
          expect(choices.some(choice => choice.value === "review_read")).toBe(true);
          return "review_read";
        }
        expect(choices.find(choice => choice.value === "activate")?.disabled).toBe(accepted !== true);
        return "back";
      },
    };
    expect(await boundaryReviewCommand(["--project-root", root, "--access"], async () => {
      if (failInspection) throw new Error("fixture connection unavailable");
      return inspection();
    }, session)).toBe(0);
    expect(reviews).toBe(2);
    expect(confirmActivation).toHaveBeenCalledOnce();
    expect(await listActionRuleAuthorityDrafts(root)).toEqual(before);
    expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
    expect((await loadBoundaryReviewContext(root)).bundle.candidate_digest).toBe(readBefore.bundle.candidate_digest);
    expect(showReviewDetails).toHaveBeenCalledTimes(accepted === "inspection_failure" ? 1 : 0);
    if (accepted === true) expect((await loadActivatedExplorationBoundaries(root))[0]!.activation.digest).toBe(readBefore.bundle.candidate_digest);
    else await expect(loadActivatedExplorationBoundaries(root)).rejects.toThrow("No exploration boundary is active");
  }, 30_000);

  it.each([true, false])("wires standalone action review to the exact Read decision without restarting setup (accepted=%s)", async accepted => {
    const root = await savedProject();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const before = await listActionRuleAuthorityDrafts(root);
    const readBefore = await loadBoundaryReviewContext(root);
    const inspector = vi.spyOn(schema, "inspectDatabase").mockResolvedValue(inspection());
    let homes = 0, reviews = 0, readDecisions = 0;
    const prompter: actionTui.ActionControlPrompter = {
      choose: async (title, choices) => {
        if (title === "ACTION BOUNDARY") return homes++ === 0 ? "verified_action" : "quit";
        if (title === "ACTIVATE READ BOUNDARY") {
          readDecisions++;
          expect(choices.some(choice => choice.value === "activate")).toBe(true);
          expect(choices.some(choice => choice.value === "revise_model")).toBe(true);
          return accepted ? "activate" : "finish";
        }
        expect(title).toBe("VERIFIED ACTION BOUNDARY");
        if (reviews++ === 0) return "review_read";
        expect(choices.find(choice => choice.value === "activate")?.disabled).toBe(!accepted);
        return "back";
      },
      text: async () => { throw new Error("Do not restart the job or request model input"); },
      confirm: async () => { throw new Error("Read decision was already made in its exact permission menu"); },
      message: async (title, lines) => { throw new Error(`${title}: ${lines.join("\n")}`); },
    };
    const run = actionTui.runActionControlPlane;
    vi.spyOn(actionTui, "runActionControlPlane").mockImplementation(input => run({ ...input, prompter }));
    expect(await actionCommand(["review", "--project-root", root], async () => inspection())).toBe(0);
    expect(reviews).toBe(2); expect(readDecisions).toBe(1);
    expect(await listActionRuleAuthorityDrafts(root)).toEqual(before);
    expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
    if (accepted) {
      expect((await loadActivatedExplorationBoundaries(root))[0]!.activation.digest).toBe(readBefore.bundle.candidate_digest);
      expect(inspector).toHaveBeenCalledWith(expect.objectContaining({ databaseUrlEnv: "GOVERNED_REVIEW_READ_URL" }));
    } else await expect(loadActivatedExplorationBoundaries(root)).rejects.toThrow("No exploration boundary is active");
  }, 30_000);

  it("does not start a model revision for a Read selection changed during linked Action review", async () => {
    const root = await savedProject();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(schema, "inspectDatabase").mockResolvedValue(inspection());
    const before = await listActionRuleAuthorityDrafts(root);
    let homes = 0, reviews = 0;
    let revisedDigest: string | undefined;
    const messages: string[] = [];
    const noQuestion = vi.fn(async () => { throw new Error("No model request or new job is allowed for a stale selection"); });
    const prompter: actionTui.ActionControlPrompter = {
      choose: async (title, choices) => {
        if (title === "ACTION BOUNDARY") return homes++ === 0 ? "verified_action" : "quit";
        if (title === "VERIFIED ACTION BOUNDARY") return reviews++ === 0 ? "review_read" : "back";
        expect(title).toBe("ACTIVATE READ BOUNDARY");
        expect(choices.some(choice => choice.value === "revise_model")).toBe(true);
        const changed = inspection();
        changed.tables[0]!.columns.find(column => column.name === "credits")!.nullable = true;
        await commitBoundaryRescan(await prepareBoundaryRescan({ projectRoot: root, inspection: changed }));
        revisedDigest = (await loadBoundaryReviewContext(root)).bundle.candidate_digest;
        return "revise_model";
      }, text: noQuestion, confirm: noQuestion,
      message: async (title, lines) => { messages.push(title, ...lines); },
    };
    const run = actionTui.runActionControlPlane;
    vi.spyOn(actionTui, "runActionControlPlane").mockImplementation(input => run({ ...input, prompter }));
    expect(await actionCommand(["review", "--project-root", root], async () => inspection())).toBe(0);
    expect(reviews).toBe(2); expect(noQuestion).not.toHaveBeenCalled();
    expect(messages.join("\n")).toContain("READ_BOUNDARY_REVISION_CHANGED");
    expect((await loadBoundaryReviewContext(root)).bundle.candidate_digest).toBe(revisedDigest);
    expect(await listActionRuleAuthorityDrafts(root)).toEqual(before);
    expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
    await expect(loadActivatedExplorationBoundaries(root)).rejects.toThrow("No exploration boundary is active");
  }, 20_000);

  it.each(["repair", "repair_disabled", "inspection_drift", "structural_change", "stale_selection", "existing_edit", "read_changed", "read_pending", "read_declined"] as const)("keeps stale Read dependencies repairable without authorizing old rules (%s)", async mode => {
    const root = await savedProject();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const activateRead = async (source: schema.SchemaInspection) => {
      let visits = 0;
      const session: BoundaryReviewInteractiveSession = { chooseResource: async () => visits++ === 0 ? { action: "confirm" } : undefined,
        editFieldTiers: async () => undefined, promptText: async () => "fixture_reviewer",
        confirm: async () => true, confirmActivation: async () => true };
      expect(await boundaryReviewCommand(["--project-root", root, "--access"], async () => source, session)).toBe(0);
    };
    await activateRead(inspection());
    const original = (await listActionRuleAuthorityDrafts(root))[0]!;
    const activated = await semanticDeployment.activateSemanticActionRuntime({ projectRoot: root, draft: original, actor: "fixture_reviewer" });
    const oldRead = await loadActivatedExplorationBoundaries(root);
    const changed = inspection();
    changed.tables[0]!.row_level_security_policies = [{ name: "dedicated_writer", command: "UPDATE", permissive: true,
      roles: ["dedicated_writer"], using_expression: "tenant_id = current_setting('app.tenant_id')::uuid" }];
    if (mode === "structural_change") changed.tables[0]!.columns.find(field => field.name === "credits")!.nullable = true;
    await commitBoundaryRescan(await prepareBoundaryRescan({ projectRoot: root, inspection: changed }));
    const pendingRead = mode === "read_pending" || mode === "read_declined";
    if (!pendingRead) await activateRead(changed);
    const newRead = await loadActivatedExplorationBoundaries(root);
    if (pendingRead) expect(newRead).toEqual(oldRead);
    else {
      expect(newRead[0]!.activation.digest).not.toBe(oldRead[0]!.activation.digest);
      await expect(loadActiveActionRuleAuthority(root)).rejects.toHaveProperty("code", "ACTION_RULE_READ_AUTHORITY_STALE");
    }
    const edited = buildActionRuleAuthorityDraft({ name: original.authority.name,
      action_boundary_name: original.authority.action_boundary.name, catalog: structuredClone(original.authority.catalog),
      rules: original.authority.rules.map(rule => ({ ...structuredClone(rule), rule: { ...structuredClone(rule.rule), ttl_seconds: 120 } })),
      approval_classes: structuredClone(original.authority.approval_classes), reviews: structuredClone(original.reviews) });
    if (mode === "repair_disabled" || mode === "existing_edit") await writeActionRuleAuthorityDraft(root, edited);
    const draftsBefore = await listActionRuleAuthorityDrafts(root);
    const configs = await Promise.all(["synapsor.runner.json", "synapsor.actions.runner.json"].map(file => fs.readFile(path.join(root, file), "utf8")));
    const source = mode === "inspection_drift" ? inspection() : changed;
    const inspect = vi.spyOn(schema, "inspectDatabase").mockResolvedValue(source);
    const repaired = mode === "repair" || mode === "repair_disabled";
    if (mode === "stale_selection") {
      await expect(revalidateSavedActionReadDependencies({ projectRoot: root, boundaryName: "reviewed_staging",
        current: { ...activated.activation, actor: "different_review" }, inspect: schema.inspectDatabase })).rejects.toThrow("selected Action revision changed");
      expect(inspect).not.toHaveBeenCalled();
    } else if (mode === "existing_edit") {
      await expect(revalidateSavedActionReadDependencies({ projectRoot: root, boundaryName: "reviewed_staging",
        current: activated.activation, inspect: schema.inspectDatabase })).rejects.toThrow("disabled replacement already exists");
      expect(inspect).not.toHaveBeenCalled();
    } else if (mode === "read_changed") {
      const snapshot = await readAuthoring.readProjectReadAuthoring(root);
      vi.spyOn(readAuthoring, "readProjectReadAuthoring").mockResolvedValueOnce(snapshot).mockResolvedValue(undefined);
      await expect(revalidateSavedActionReadDependencies({ projectRoot: root, boundaryName: "reviewed_staging",
        current: activated.activation, inspect: schema.inspectDatabase })).rejects.toThrow("Read draft changed while checking metadata");
    } else {
      const seen: string[] = [];
      let home = 0, review = 0;
      const reviewRead = vi.fn(async () => { if (mode === "read_pending") await activateRead(changed); });
      await actionTui.runActionControlPlane({ projectRoot: root, inspection: changed,
        ...(pendingRead ? { reviewLinkedRead: reviewRead } : {}), prompter: {
        choose: async (title, choices, context) => {
          seen.push(title);
          if (title === "ACTION BOUNDARY") {
            if (!pendingRead) expect(context?.join("\n")).toContain("ACCESS RECHECK REQUIRED");
            return home++ === 0 ? "verified_action" : "quit";
          }
          expect(title).toBe("VERIFIED ACTION BOUNDARY");
          if (pendingRead) {
            if (review++ === 0) {
              expect(choices.some(choice => choice.value === "revalidate_read")).toBe(false);
              expect(choices.some(choice => choice.value === "review_read")).toBe(true);
              expect(context?.join("\n")).toContain("Review the saved read access first");
              return "review_read";
            }
            expect(choices.some(choice => choice.value === "revalidate_read")).toBe(mode === "read_pending");
            return "back";
          }
          if (review++ === 0) {
            expect(choices.some(choice => choice.value === "revalidate_read")).toBe(true);
            return "revalidate_read";
          }
          if (repaired) {
            expect(choices.find(choice => choice.value === "activate")?.disabled).not.toBe(true);
            expect(context?.join("\n")).toContain("REPLACEMENT DRAFT - NOT ACTIVE");
          }
          return "back";
        },
        text: async () => { throw new Error("No repeated business question expected"); },
        confirm: async () => { throw new Error("This test grants no new Action or execution permission"); },
        message: async (title, lines) => {
          expect(["inspection_drift", "structural_change"]).toContain(mode);
          expect(title).toBe("Saved changes need review");
          expect(lines.join("\n")).toContain(mode === "inspection_drift" ? "database changed again" : "type or nullability");
        },
      } });
      expect(seen.filter(title => title === "VERIFIED ACTION BOUNDARY")).toHaveLength(2);
      if (pendingRead) {
        expect(reviewRead).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ boundaryName: "reviewed_staging" }));
        expect(inspect).not.toHaveBeenCalled();
      } else expect(inspect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ databaseUrlEnv: "GOVERNED_REVIEW_READ_URL" }));
    }
    const drafts = await listActionRuleAuthorityDrafts(root);
    if (repaired) {
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.authority.rules[0]!.read_boundary_digest).toBe(newRead[0]!.activation.digest);
      expect(drafts[0]!.authority.rules[0]!.rule).toEqual((mode === "repair_disabled" ? edited : original).authority.rules[0]!.rule);
      expect(drafts[0]!.authority.rules[0]!.effect_envelope).toEqual(original.authority.rules[0]!.effect_envelope);
      expect(drafts[0]!.authority.rules[0]!.rule.ttl_seconds).toBe(mode === "repair_disabled" ? 120 : original.authority.rules[0]!.rule.ttl_seconds);
      expect(drafts[0]!.authority.approval_classes).toEqual(original.authority.approval_classes);
      expect(drafts[0]!.reviews).toEqual(original.reviews);
    } else expect(drafts).toEqual(draftsBefore);
    expect(await readActionRuleAuthorityActivation(root)).toEqual(activated.activation);
    if (mode !== "read_declined") await expect(loadActiveActionRuleAuthority(root)).rejects.toHaveProperty("code", "ACTION_RULE_READ_AUTHORITY_STALE");
    if (mode === "read_pending") expect((await loadActivatedExplorationBoundaries(root))[0]!.activation.digest).not.toBe(oldRead[0]!.activation.digest);
    else {
      expect(await loadActivatedExplorationBoundaries(root)).toEqual(newRead);
      expect(await Promise.all(["synapsor.runner.json", "synapsor.actions.runner.json"].map(file => fs.readFile(path.join(root, file), "utf8")))).toEqual(configs);
    }
  }, 60_000);

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

async function savedProject(writeback: "proposal_only" | "supervised" = "proposal_only", includeAction = true): Promise<string> {
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
    if (!includeAction) request.actions = [];
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
