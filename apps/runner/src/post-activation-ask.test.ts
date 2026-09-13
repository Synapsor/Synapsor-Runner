import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { createOptionalReadActionRuleRuntimeServices } from "./semantic-action-runtime.js";
import { inspectMcpToolBoundary, readLocalExploreRuntimeConfig } from "./mcp-runtime.js";
import {
  choosePostActivationAskSelection,
  defaultPostActivationAskSelection,
  formatHttpMcpHandoff,
  formatMcpClientHandoff,
  formatPostActivationAskSelection,
  formatPostActivationRouteLine,
  hasActiveActionRuntime,
  mcpClientPickerTransition,
  preferredRoute,
  runPostActivationAskHandoff,
  readPostActivationReadiness,
  savedSetupReceipt,
  reviewPausedExecutionSetup,
  soleConfiguredHostedRoute,
  type PostActivationAskRoute,
} from "./post-activation-ask.js";
import { ProviderCredentialInputCancelledError } from "./secret-input.js";
import * as managedLauncher from "./managed-mcp-project.js";

describe("post-activation Ask handoff", () => {
  it("keeps an explicit client-setup entry focused on clients even with a configured model", async () => {
    const chooseRoute = vi.fn(async () => "later" as const), ask = vi.fn(async () => 0);
    const install = vi.fn(async () => 0), worker = vi.fn(async () => 0);
    expect(await runPostActivationAskHandoff({ projectRoot: "/tmp/not-created-project", initialRoute: "mcp-client",
      autoStartConfiguredProvider: false }, {
      env: { OPENAI_API_KEY: "private-unused-fixture-key" }, chooseRoute, runAsk: ask, runMcpInstall: install, runWorker: worker,
      readActionDrafts: async () => [],
      readReadiness: async () => ({ read: "active", legacy_actions: "inactive", worker: "not_checked", semantic_actions: "active",
        semantic_outcomes: [{ outcome: "university.accept_offer", approval_mode: "policy", execution_enabled: false }] }),
      stdout: { write: () => true }, stderr: { write: () => true },
    })).toBe(0);
    expect(chooseRoute).toHaveBeenCalledExactlyOnceWith("mcp-client", expect.any(Array));
    expect(ask).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled(); expect(worker).not.toHaveBeenCalled();
  });

  it("selects named client launch configuration without replacing the default or running a model", async () => {
    const reference = `reviewed.${"a".repeat(64)}`;
    const install = vi.fn(async () => 0), load = vi.fn(async () => ({ FIXTURE_TENANT: "private-value" }));
    const check = vi.fn(async () => ({ ok: true, messages: [] })), ask = vi.fn(), worker = vi.fn();
    const writes: string[] = [];
    expect(await runPostActivationAskHandoff({ projectRoot: "/tmp/named-handoff", includeActions: true,
      selection: { route: "mcp-client", client: "claude-code" } }, {
      env: {}, readRuntimeIdentity: async () => "local_environment",
      reviewLocalClient: async () => ({ kind: "named", reference }),
      readRuntimeBindings: async () => [{ role: "tenant", environment: "FIXTURE_TENANT" }],
      runMcpInstall: install, loadLocalTestIdentity: load, checkClientLaunch: check, confirmLaunchCheck: async () => true,
      readExecutionState: async () => ({ enabled: false, config_path: "synapsor.actions.runner.json", policies: [] }),
      runAsk: ask, runWorker: worker, stdout: { write: value => { writes.push(String(value)); return true; } }, stderr: { write: () => true },
    })).toBe(0);
    expect(install).toHaveBeenCalledExactlyOnceWith(["install", "claude-code", "--project", "--authoring", "--project-root", "/tmp/named-handoff", "--local-client", reference]);
    expect(load).toHaveBeenCalledExactlyOnceWith({ projectRoot: "/tmp/named-handoff", runtimePath: `.synapsor/local-test-runtime.${reference}.json` });
    expect(check).toHaveBeenCalledExactlyOnceWith("/tmp/named-handoff", "claude-code", reference);
    expect(ask).not.toHaveBeenCalled(); expect(worker).not.toHaveBeenCalled();
    expect(writes.join("")).not.toContain("private-value");
  });

  it("leaves installation untouched when named identity review is cancelled", async () => {
    const install = vi.fn(), ask = vi.fn(), check = vi.fn();
    expect(await runPostActivationAskHandoff({ projectRoot: "/tmp/named-declined", selection: { route: "mcp-client", client: "claude-code" } }, {
      env: {}, readRuntimeIdentity: async () => "local_environment", reviewLocalClient: async () => ({ kind: "cancelled" }),
      runMcpInstall: install, runAsk: ask, checkClientLaunch: check,
      stdout: { write: () => true }, stderr: { write: () => true },
    })).toBe(0);
    expect(install).not.toHaveBeenCalled(); expect(ask).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled();
  });

  it("describes automatic policy fallback separately from human-only outcomes and omits inactive legacy actions", async () => {
    const writes: string[] = [];
    await expect(runPostActivationAskHandoff({ projectRoot: "/tmp/not-created-project", selection: { route: "later" } }, {
      env: {}, readActionDrafts: async () => [],
      readReadiness: async () => ({ read: "active", legacy_actions: "inactive", worker: "not_checked", semantic_actions: "active",
        semantic_outcomes: [
          { outcome: "telecom.subscription.plan_change", approval_mode: "policy", execution_enabled: true },
          { outcome: "telecom.subscription.exception", approval_mode: "human", execution_enabled: false },
        ],
      }),
      stdout: { write: (value) => { writes.push(String(value)); return true; } }, stderr: { write: () => true },
    })).resolves.toBe(0);
    const output = writes.join("");
    expect(output).toContain("Read: active. Verified outcomes: active.");
    expect(output).not.toContain("Legacy named actions: inactive");
    expect(output).toContain("Approval: 1 automatic policy with human fallback, 1 human-only outcome. Execution enabled: 1/2 outcomes.");
    expect(output).not.toContain("0 human review");
  });

  it.each(["current", "read_only", "stale", "later", "used", "explicit"] as const)("continues the intended client once without changing authority (%s)", async (mode) => {
    const boundary = await import("./boundary-commands.js");
    const resume = await import("./boundary-authoring-resume.js");
    const readiness = await import("./authoring-client-readiness.js");
    const saved = { stage: "client_setup", intended_client: mode === "later" ? "later" : "claude-code" };
    const before = structuredClone(saved);
    const mocks = [
      vi.spyOn(boundary, "loadBoundaryReviewContext").mockResolvedValue({ bundle: {} } as never),
      vi.spyOn(boundary, "boundaryAuthoringResumeBinding").mockReturnValue({} as never),
      vi.spyOn(resume, "readBoundaryAuthoringResumeState").mockResolvedValue({ status: "ready", value: saved } as never),
      vi.spyOn(readiness, "clientHandoffMatchesActiveAuthority").mockResolvedValue(mode !== "stale"),
      vi.spyOn(readiness, "pendingClientResponsibilities").mockResolvedValue(["Accurate request status", "Test a pending request and a completed receipt in Claude Code."]),
    ];
    const install = vi.fn(async (_args: string[]) => 0), chooseRoute = vi.fn(async () => "later" as const);
    const chooseClient = vi.fn(), ask = vi.fn(), worker = vi.fn();
    const writes: string[] = [];
    try {
      expect(await runPostActivationAskHandoff({ projectRoot: "/tmp/not-created-project", autoStartConfiguredProvider: false,
        ...(mode === "used" ? { usedIntendedClient: true } : {}),
        ...(mode === "explicit" ? { selection: { route: "later" as const } } : {}),
      }, {
        env: { OPENAI_API_KEY: "private-test-key" },
        readReadiness: async () => ({ read: "active", semantic_actions: mode === "read_only" ? "inactive" : "active",
          legacy_actions: "inactive", worker: "not_checked", semantic_outcomes: mode === "read_only" ? [] : [{ outcome: "stock.correct_quantity", approval_mode: "human", execution_enabled: false }] }),
        readActionDrafts: async () => [], hasActiveActions: async () => mode !== "read_only",
        readRuntimeIdentity: async () => "local_environment", readRuntimeBindings: async () => [],
        runMcpInstall: install, chooseRoute, chooseMcpClient: chooseClient, runAsk: ask, runWorker: worker,
        confirmLaunchCheck: async () => false,
        stdout: { write: (value) => { writes.push(String(value)); return true; } }, stderr: { write: () => true },
      })).toBe(0);
      const selected = mode === "current" || mode === "read_only";
      expect(install).toHaveBeenCalledTimes(selected ? 1 : 0);
      expect(chooseRoute).toHaveBeenCalledTimes(selected || mode === "explicit" ? 0 : 1);
      if (selected) {
        expect(install.mock.calls[0]?.[0]).toEqual(["install", "claude-code", "--project", "--authoring", "--project-root", "/tmp/not-created-project",
          ...(mode === "read_only" ? [] : ["--include-actions"])]);
        expect(writes.join("")).toContain("Test a pending request and a completed receipt in Claude Code.");
        expect(writes.join("")).toContain("configured; launch not checked");
      }
      expect(chooseClient).not.toHaveBeenCalled();
      expect(ask).not.toHaveBeenCalled();
      expect(worker).not.toHaveBeenCalled();
      expect(saved).toEqual(before);
    } finally { for (const mock of mocks) mock.mockRestore(); }
  });

  it.each([false, true])("reopens every pending active outcome after bundle activation, including after the first writer is re-enabled (%s)", async (firstEnabled) => {
    const boundary = await import("./boundary-commands.js");
    const resume = await import("./boundary-authoring-resume.js");
    const readiness = await import("./authoring-client-readiness.js");
    const authority = await import("./action-rule-authority.js");
    const deployment = await import("./semantic-action-deployment.js");
    const reviews = await import("./verified-action-review.js");
    const reads = await import("./auto-boundary.js");
    const picker = await import("./boundary-cli-picker.js");
    const outcomes = ["stock.correct_quantity", "stock.set_reorder_point", "stock.archive"];
    const active = { authority: { action_boundary: { digest: "current" }, rules: outcomes.map((outcome) => ({ rule: { outcome },
      effect_envelope: { writeback: { mode: "direct_sql", supervised_worker: "allowed" } } })) } };
    const execution = { enabled: true, config_path: "synapsor.actions.runner.json", policies: firstEnabled
      ? [{ outcome: outcomes[0], action_boundary_digest: "current" }]
      : outcomes.slice(0, 2).map((outcome) => ({ outcome, action_boundary_digest: "previous" })) };
    const before = structuredClone(execution);
    const reviewed: string[] = [];
    const mocks = [
      vi.spyOn(picker, "createBoundaryReviewInteractiveSession").mockReturnValue({} as never),
      vi.spyOn(boundary, "loadBoundaryReviewContext").mockResolvedValue({ bundle: {} } as never),
      vi.spyOn(boundary, "boundaryAuthoringResumeBinding").mockReturnValue({} as never),
      vi.spyOn(resume, "readBoundaryAuthoringResumeState").mockResolvedValue({ status: "ready", value: {
        stage: "client_setup", client_handoff: { action_digest: "current" },
      } } as never),
      vi.spyOn(readiness, "clientHandoffMatchesActiveAuthority").mockResolvedValue(true),
      vi.spyOn(readiness, "pendingClientResponsibilities").mockResolvedValue([]),
      vi.spyOn(authority, "loadActiveActionRuleAuthority").mockResolvedValue(active as never),
      vi.spyOn(reads, "loadActivatedExplorationBoundaries").mockResolvedValue([]),
      vi.spyOn(deployment, "readSemanticSupervisedExecutionState").mockResolvedValue(execution as never),
      vi.spyOn(reviews, "reviewSemanticSupervisedExecution").mockImplementation(async ({ outcome }) => {
        reviewed.push(outcome);
        return { title: "Execution deferred", tone: "warning", lines: ["No execution was enabled."] };
      }),
    ];
    try {
      expect(await runPostActivationAskHandoff({ projectRoot: "/tmp/not-created-project", selection: { route: "execution-setup" } }, {
        env: {}, readActionDrafts: async () => [],
        readReadiness: async () => ({ read: "active", semantic_actions: "active", legacy_actions: "inactive", worker: "not_checked",
          semantic_outcomes: outcomes.map((outcome) => ({ outcome, approval_mode: "human", execution_enabled: firstEnabled && outcome === outcomes[0] })) }),
        chooseRoute: async () => "later", stdout: { write: () => true }, stderr: { write: () => true },
      })).toBe(0);
      expect(reviewed).toEqual(firstEnabled ? outcomes.slice(1) : outcomes);
      expect(execution).toEqual(before);
    } finally { for (const mock of mocks) mock.mockRestore(); }
  });

  it.each(["matched", "matched_no_drafts", "installed_edit", "explicit_review", "mismatched", "stale", "authority_review", "first_outcome", "matching_failed"] as const)(
    "uses only an exact current-job client checkpoint to make retained drafts optional (%s)", async (mode) => {
      const boundary = await import("./boundary-commands.js");
      const resume = await import("./boundary-authoring-resume.js");
      const readiness = await import("./authoring-client-readiness.js");
      const authority = await import("./action-rule-authority.js");
      const writes: string[] = [];
      const matched = ["matched", "matched_no_drafts", "installed_edit", "explicit_review"].includes(mode);
      const drafts = mode === "matched_no_drafts" ? [] : [
        { state: "disabled", authority: { name: "prepared_quantity" } },
        { state: "disabled", authority: { name: "prepared_reorder" } },
      ];
      const beforeDrafts = structuredClone(drafts);
      const outcomes = ["warehouse.correct_quantity", "warehouse.set_reorder_point"];
      const digest = `sha256:${"a".repeat(64)}` as const;
      const saved = { stage: mode === "authority_review" ? "authority_review" : "client_setup",
        ...(mode === "installed_edit" ? { intended_client: "claude-code" } : {}),
        client_handoff: { action_digest: digest }, action: { completed_outcomes: outcomes } };
      const beforeSaved = structuredClone(saved);
      const mocks = [
        vi.spyOn(boundary, "loadBoundaryReviewContext").mockResolvedValue({ bundle: {} } as never),
        vi.spyOn(boundary, "boundaryAuthoringResumeBinding").mockReturnValue({} as never),
        vi.spyOn(resume, "readBoundaryAuthoringResumeState").mockResolvedValue({
          status: mode === "stale" ? "stale" : "ready", value: saved,
        } as never),
        vi.spyOn(readiness, "clientHandoffMatchesActiveAuthority").mockImplementation(async () => {
          if (mode === "matching_failed") throw new Error("Current authority unavailable");
          return mode !== "mismatched";
        }),
        vi.spyOn(readiness, "pendingClientResponsibilities").mockResolvedValue([]),
        vi.spyOn(authority, "loadActiveActionRuleAuthority").mockResolvedValue({ authority: {
          action_boundary: { digest }, rules: outcomes.map((outcome) => ({ rule: { outcome },
            effect_envelope: { writeback: { mode: "direct_sql", supervised_worker: "allowed" } } })),
        } } as never),
      ];
      const runAsk = vi.fn(async () => 0), install = vi.fn(async () => 0), review = vi.fn(async () => 0);
      const runWorker = vi.fn(async () => 0), author = vi.fn(async () => 0);
      const chooseRoute = vi.fn(async (initial: PostActivationAskRoute, options?: readonly { id: string }[]) => {
        expect(initial).toBe(matched ? "mcp-client" : "review-outcomes");
        expect(options?.some((option) => option.id === "review-outcomes")).toBe(drafts.length > 0);
        return mode === "installed_edit" ? "edit-rules" : initial;
      });
      try {
        expect(await runPostActivationAskHandoff({ projectRoot: "/tmp/not-created-project", autoStartConfiguredProvider: true,
          ...(mode === "explicit_review" ? { selection: { route: "review-outcomes" as const } } : {}),
        }, {
          env: { OPENAI_API_KEY: "private-provider-key" },
          readReadiness: async () => ({ read: "active", legacy_actions: "inactive", worker: "not_checked",
            semantic_actions: mode === "first_outcome" ? "inactive" : "active",
            semantic_outcomes: mode === "first_outcome" ? [] : outcomes.map((outcome) => ({
              outcome, approval_mode: "policy", execution_enabled: true,
            })),
          }),
          readActionDrafts: async () => drafts as never,
          readClientInstallation: async () => ({ state: "installed" }) as never,
          readExecutionState: async () => ({ enabled: true, config_path: "synapsor.actions.runner.json", policies: outcomes.map((outcome) => ({
            outcome, action_boundary_digest: digest, write_url_env: "WRITER_URL", mode: "supervised_worker",
            concurrency: 1, queue_limit: 100, lease_seconds: 300, max_attempts: 5,
            proposal_ttl_seconds: 3600, rate_limit: { executions: 10, window_seconds: 60 },
          })) }),
          hasActiveActions: async () => true, readRuntimeIdentity: async () => "local_environment", readRuntimeBindings: async () => [],
          chooseRoute, chooseMcpClient: async () => "claude-code", confirmLaunchCheck: async () => false,
          runAsk, runMcpInstall: install, runActionReview: review, runBoundaryReview: author, runWorker,
          stdout: { write: (value) => { writes.push(String(value)); return true; } }, stderr: { write: () => true },
        })).toBe(0);
        expect(chooseRoute).toHaveBeenCalledTimes(mode === "explicit_review" ? 0 : 1);
        expect(install).toHaveBeenCalledTimes(matched && mode !== "explicit_review" && mode !== "installed_edit" ? 1 : 0);
        expect(review).toHaveBeenCalledTimes(!matched || mode === "explicit_review" ? 1 : 0);
        expect(runAsk).not.toHaveBeenCalled();
        if (mode === "installed_edit") expect(author).toHaveBeenCalledExactlyOnceWith(["--project-root", "/tmp/not-created-project", "--access", "--job-first"]);
        else expect(author).not.toHaveBeenCalled();
        expect(runWorker).not.toHaveBeenCalled();
        if (matched && drafts.length) {
          expect(writes.join("")).toContain("available for optional review");
          expect(writes.join("")).not.toContain("disabled and awaiting separate review");
        } else if (!matched) expect(writes.join("")).toContain("disabled and awaiting separate review");
        expect(drafts).toEqual(beforeDrafts);
        expect(saved).toEqual(beforeSaved);
        expect(writes.join("")).not.toContain("private-provider-key");
      } finally { for (const mock of mocks) mock.mockRestore(); }
    },
  );

  it.each(["review-outcomes", "openai", "later"] as const)("keeps a saved disabled Action pending review while respecting the %s choice", async (route) => {
    const output: string[] = [];
    const runActionReview = vi.fn(async () => 0), runAsk = vi.fn(async () => 0), runBoundaryReview = vi.fn(async () => 0);
    const chooseRoute = vi.fn(async (initial: string, choices?: readonly { id: string }[]) => {
      expect(initial).toBe("review-outcomes");
      expect(choices?.map((choice) => choice.id)).toContain("review-outcomes");
      expect(choices?.map((choice) => choice.id)).not.toContain("create-outcome");
      return route;
    });
    expect(await runPostActivationAskHandoff({ projectRoot: "/tmp/not-created-project", autoStartConfiguredProvider: true }, {
      env: { OPENAI_API_KEY: "not-used" }, readReadiness: async () => ({ read: "active", legacy_actions: "inactive",
        semantic_actions: "inactive", semantic_outcomes: [], worker: "not_checked" }),
      readActionDrafts: async () => [{ state: "disabled" }] as never,
      chooseRoute, promptWithDefault: async (_label, value) => value, runActionReview, runAsk, runBoundaryReview,
      stdout: { write: (value) => { output.push(String(value)); return true; } }, stderr: { write: () => true },
    })).toBe(0);
    expect(chooseRoute).toHaveBeenCalledOnce();
    expect(runActionReview).toHaveBeenCalledTimes(route === "review-outcomes" ? 1 : 0);
    if (route === "review-outcomes") expect(runActionReview).toHaveBeenCalledExactlyOnceWith(["review", "--project-root", "/tmp/not-created-project"]);
    expect(runAsk).toHaveBeenCalledTimes(route === "openai" ? 1 : 0);
    expect(runBoundaryReview).not.toHaveBeenCalled();
    expect(output.join("")).toContain("Saved verified Action draft: 1, disabled and awaiting separate review");
    expect(output.join("")).not.toContain("Adding verified change outcomes is optional");
    expect(formatPostActivationAskSelection({ route: "review-outcomes" })).toBe("Review saved verified outcomes");
  });

  it("reports that a prior supervised policy was not carried across a replacement Action digest", async () => {
    const boundary = await import("./boundary-commands.js");
    const resume = await import("./boundary-authoring-resume.js");
    const authority = await import("./action-rule-authority.js");
    const readiness = await import("./authoring-client-readiness.js");
    const activeDigest = `sha256:${"b".repeat(64)}` as const;
    const oldDigest = `sha256:${"a".repeat(64)}` as const;
    const output: string[] = [];
    const mocks = [
      vi.spyOn(boundary, "loadBoundaryReviewContext").mockResolvedValue({ bundle: {} } as never),
      vi.spyOn(boundary, "boundaryAuthoringResumeBinding").mockReturnValue({} as never),
      vi.spyOn(resume, "readBoundaryAuthoringResumeState").mockResolvedValue({ status: "ready", value: {
        stage: "client_setup", client_handoff: { action_digest: activeDigest },
      } } as never),
      vi.spyOn(readiness, "clientHandoffMatchesActiveAuthority").mockResolvedValue(true),
      vi.spyOn(readiness, "pendingClientResponsibilities").mockResolvedValue([]),
      vi.spyOn(authority, "loadActiveActionRuleAuthority").mockResolvedValue({ authority: {
        action_boundary: { digest: activeDigest }, rules: ["warehouse.correct_quantity", "warehouse.archive"].map((outcome) => ({ rule: { outcome },
          effect_envelope: { writeback: { mode: "direct_sql", supervised_worker: "allowed" } } })),
      } } as never),
    ];
    try {
      await expect(runPostActivationAskHandoff({ projectRoot: "/tmp/not-created-project", selection: { route: "later" } }, {
        readReadiness: async () => ({ read: "active", legacy_actions: "inactive", semantic_actions: "active",
          semantic_outcomes: [{ outcome: "warehouse.correct_quantity", approval_mode: "human", execution_enabled: false }], worker: "not_checked" }),
        readActionDrafts: async () => [],
        readExecutionState: async () => ({ enabled: true, config_path: "synapsor.actions.runner.json", policies: [{
          outcome: "warehouse.correct_quantity", action_boundary_digest: oldDigest, mode: "supervised_worker",
          write_url_env: "WRITER_URL", concurrency: 1, queue_limit: 100, lease_seconds: 300, max_attempts: 5,
          proposal_ttl_seconds: 3600, rate_limit: { executions: 10, window_seconds: 60 },
        }] }),
        stdout: { write: (value) => { output.push(String(value)); return true; } }, stderr: { write: () => true },
      })).resolves.toBe(0);
      expect(output.join("")).toContain("need execution review for the current complete Action Boundary digest");
      expect(output.join("")).toContain("Prior supervised execution was not carried forward for: warehouse.correct_quantity.");
      expect(output.join("")).toContain("Execution is not configured for this revision: warehouse.archive.");
      expect(output.join("")).not.toContain("existing execution settings are unchanged");
    } finally { for (const mock of mocks) mock.mockRestore(); }
  });

  it.each(["create-outcome", "mcp-client", "openai", "later"] as const)("keeps a mixed-state Read-only project usable through %s without substituting legacy actions", async (route) => {
    const root = await mixedStateProject();
    const paths = ["synapsor.actions.runner.json", ".synapsor/exploration-boundaries.active.json", ".synapsor/boundary-authoring-resume.json"];
    const before = await Promise.all(paths.map((file) => fs.readFile(path.join(root, file), "utf8")));
    const writes: string[] = [];
    const runAsk = vi.fn(async () => 0), runBoundaryReview = vi.fn(async () => 0), runMcpInstall = vi.fn(async () => 0);
    const chooseRoute = vi.fn(async (initial: string, options?: readonly { id: string; label: string }[]) => {
      expect(initial).toBe("create-outcome");
      expect(options).toContainEqual(expect.objectContaining({ id: "create-outcome", label: "Create the first verified outcome" }));
      return route;
    });
    const legacy = await import("./guided-action.js");
    const legacyStatus = vi.spyOn(legacy, "guidedActionStatus").mockResolvedValue({
      action_boundary: { active: { authority: { capabilities: [{ capability: "legacy.propose" }] } } },
    } as never);
    try {
      expect(await readPostActivationReadiness(root)).toEqual({ read: "active", legacy_actions: "active",
        semantic_actions: "inactive", semantic_outcomes: [], worker: "not_checked" });
      expect(await hasActiveActionRuntime(root)).toBe(false);
      expect(await runPostActivationAskHandoff({ projectRoot: root, autoStartConfiguredProvider: true,
        includeActions: true }, {
        env: { OPENAI_API_KEY: "private-provider-key" }, chooseRoute,
        chooseMcpClient: async () => "claude-code", promptWithDefault: async (_label, value) => value,
        runAsk, runBoundaryReview, runMcpInstall, confirmLaunchCheck: async () => false,
        stdout: { write: (value) => { writes.push(String(value)); return true; } },
        stderr: { write: (value) => { writes.push(String(value)); return true; } },
      })).toBe(0);
      expect(chooseRoute).toHaveBeenCalledOnce();
      expect(runAsk).toHaveBeenCalledTimes(route === "openai" ? 1 : 0);
      expect(runBoundaryReview).toHaveBeenCalledTimes(route === "create-outcome" ? 1 : 0);
      if (route === "create-outcome") expect(runBoundaryReview).toHaveBeenCalledExactlyOnceWith([
        "--project-root", root, "--access", "--job-first",
      ]);
      expect(runMcpInstall).toHaveBeenCalledTimes(route === "mcp-client" ? 1 : 0);
      if (route === "mcp-client") expect(runMcpInstall).toHaveBeenCalledExactlyOnceWith([
        "install", "claude-code", "--project", "--authoring", "--project-root", root,
      ]);
      expect(writes.join("")).toContain("Read: active. Verified outcomes: OFF. Legacy named actions: active.");
      expect(writes.join("")).toContain("Read-only use remains available");
      expect(writes.join("")).not.toContain("private-provider-key");
      expect(writes.join("")).not.toContain("Action connection needs review");
      expect(await Promise.all(paths.map((file) => fs.readFile(path.join(root, file), "utf8")))).toEqual(before);
      await expect(fs.stat(path.join(root, ".synapsor/action-rules/active.json"))).rejects.toHaveProperty("code", "ENOENT");
    } finally { legacyStatus.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
  });

  it("keeps an explicit Read-only Ask selection even when no verified outcome is active", async () => {
    const root = await mixedStateProject();
    const runAsk = vi.fn(async () => 0), chooseRoute = vi.fn(async () => "later" as const);
    try {
      expect(await runPostActivationAskHandoff({ projectRoot: root, selection: { route: "openai", model: "selected-model" } }, {
        env: {}, runAsk, chooseRoute, stdout: { write: () => true }, stderr: { write: () => true },
      })).toBe(0);
      expect(chooseRoute).not.toHaveBeenCalled();
      expect(runAsk).toHaveBeenCalledExactlyOnceWith(["--project-root", root, "--provider", "openai", "--model", "selected-model"]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("does not turn a configured Read-only job into mandatory Action authoring", async () => {
    const root = await mixedStateProject();
    const runAsk = vi.fn(async () => 0), chooseRoute = vi.fn(), runBoundaryReview = vi.fn();
    try {
      expect(await runPostActivationAskHandoff({ projectRoot: root, autoStartConfiguredProvider: true }, {
        env: { OPENAI_API_KEY: "private-provider-key" }, runAsk, chooseRoute, runBoundaryReview,
        stdout: { write: () => true }, stderr: { write: () => true },
      })).toBe(0);
      expect(runAsk).toHaveBeenCalledOnce();
      expect(chooseRoute).not.toHaveBeenCalled();
      expect(runBoundaryReview).not.toHaveBeenCalled();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("keeps the actual four-tool runtime available while absent semantic Actions refuse without facts or proposals", async () => {
    const root = await mixedStateProject();
    const store = new ProposalStore(":memory:");
    const factSessionFactory = vi.fn(async () => { throw new Error("No source connection is permitted"); });
    const configPath = path.join(root, "synapsor.actions.runner.json");
    const before = await fs.readFile(configPath, "utf8");
    try {
      const config = await readLocalExploreRuntimeConfig(root);
      expect(config?.action_rules?.project_root).toBe(root);
      const tools = await inspectMcpToolBoundary(["--config", configPath, "--store", ":memory:"]);
      expect(tools.names).toEqual(["app.describe_data", "app.explore_data", "app.describe_actions", "app.request_change"]);
      const runtime = await createOptionalReadActionRuleRuntimeServices({ projectRoot: root, config: config!, store,
        env: {}, key: Buffer.alloc(32, 1), factSessionFactory });
      expect(runtime).toBeDefined();
      expect(await runtime!.semanticActions.callTool("app.describe_actions", {})).toMatchObject({
        ok: true, actions: [], availability: "operator_review_required", source_database_changed: false,
      });
      await expect(runtime!.semanticActions.callTool("app.request_change", { outcome: "university.register",
        subject_refs: { course: `obj_${"a".repeat(32)}` } })).rejects.toHaveProperty("code", "SEMANTIC_ACTION_UNAVAILABLE");
      expect(factSessionFactory).not.toHaveBeenCalled();
      expect(await fs.readFile(configPath, "utf8")).toBe(before);
      await expect(fs.stat(path.join(root, ".synapsor/action-rules/active.json"))).rejects.toHaveProperty("code", "ENOENT");
    } finally { store.close(); await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(["{", "{}"])("refuses malformed active semantic authority without opening Ask, authoring or a client (%s)", async (contents) => {
    const root = await mixedStateProject();
    const activePath = path.join(root, ".synapsor/action-rules/active.json");
    await fs.mkdir(path.dirname(activePath), { recursive: true }); await fs.writeFile(activePath, contents);
    const runAsk = vi.fn(), runBoundaryReview = vi.fn(), runMcpInstall = vi.fn(), chooseRoute = vi.fn();
    const writes: string[] = [];
    try {
      await expect(readPostActivationReadiness(root)).rejects.toThrow();
      expect(await runPostActivationAskHandoff({ projectRoot: root, autoStartConfiguredProvider: true }, {
        env: { OPENAI_API_KEY: "private-provider-key" }, runAsk, runBoundaryReview, runMcpInstall, chooseRoute,
        stdout: { write: () => true }, stderr: { write: (value) => { writes.push(String(value)); return true; } },
      })).toBe(1);
      for (const call of [runAsk, runBoundaryReview, runMcpInstall, chooseRoute]) expect(call).not.toHaveBeenCalled();
      expect(writes.join("")).toContain("Saved authority needs review");
      expect(await fs.readFile(activePath, "utf8")).toBe(contents);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each([false, true])("does not repeat unchanged execution status when returning from setup (changed=%s)", async (changed) => {
    const boundary = await import("./boundary-commands.js");
    const resume = await import("./boundary-authoring-resume.js");
    const readiness = await import("./authoring-client-readiness.js");
    const authority = await import("./action-rule-authority.js");
    const output: string[] = [];
    const outcomes = ["stock.correct_quantity", "stock.set_reorder_point", "stock.archive"];
    let revision = "first", selectionCount = 0;
    const mocks = [
      vi.spyOn(boundary, "loadBoundaryReviewContext").mockResolvedValue({ bundle: {} } as never),
      vi.spyOn(boundary, "boundaryAuthoringResumeBinding").mockReturnValue({} as never),
      vi.spyOn(resume, "readBoundaryAuthoringResumeState").mockResolvedValue({ status: "ready", value: {
        stage: "client_setup", client_handoff: { action_digest: "reviewed" },
      } } as never),
      vi.spyOn(readiness, "clientHandoffMatchesActiveAuthority").mockResolvedValue(true),
      vi.spyOn(readiness, "pendingClientResponsibilities").mockResolvedValue([]),
      vi.spyOn(authority, "loadActiveActionRuleAuthority").mockImplementation(async () => ({ authority: {
        action_boundary: { digest: revision }, rules: outcomes.map((outcome) => ({ rule: { outcome },
          effect_envelope: { writeback: { mode: "direct_sql", supervised_worker: "allowed" } } })),
      } }) as never),
    ];
    try {
      const code = await runPostActivationAskHandoff({ projectRoot: "/tmp/not-created-project" }, {
        env: {}, readExecutionState: async () => ({ enabled: false, policies: [], config_path: "unused" }),
        chooseRoute: async () => selectionCount++ === 0 ? "execution-setup" : "later",
        runExecutionReview: async () => { if (changed) revision = "second"; },
        stdout: { write: (value) => { output.push(String(value)); return true; } }, stderr: { write: () => true },
      });
      expect(code).toBe(0);
      expect(output.join("").match(/Read and change requests are active\./gu)).toHaveLength(changed ? 2 : 1);
      for (const outcome of outcomes) expect(output.join("")).toContain(outcome);
      expect(output.join("")).toContain("execution review for the current complete Action Boundary digest");
      expect(output.join("")).not.toContain("Prior supervised execution");
      expect(output.join("")).not.toContain("existing execution settings are unchanged");
      expect(selectionCount).toBe(2);
    } finally { for (const mock of mocks) mock.mockRestore(); }
  });

  it.each(["success", "failure"])("keeps optional owner setup separate from ordinary client and source authority (%s)", async (result) => {
    const output: string[] = [];
    const runOwnerRuleSetup = vi.fn(async () => { if (result === "failure") throw new Error("Owner sign-in needs configuration"); });
    const runBoundaryReview = vi.fn(), runAsk = vi.fn(), runMcpInstall = vi.fn();
    const chooseRoute = vi.fn(async () => "later" as const);
    expect(await choosePostActivationAskSelection({ chooseRoute: async () => "owner-rules" })).toEqual({ route: "owner-rules" });
    expect(await runPostActivationAskHandoff({ projectRoot: "/tmp/not-created-project", selection: { route: "owner-rules" } }, {
      env: {}, runOwnerRuleSetup, runBoundaryReview, runAsk, runMcpInstall, chooseRoute,
      stdout: { write: (value) => { output.push(String(value)); return true; } }, stderr: { write: () => true },
    })).toBe(0);
    expect(runOwnerRuleSetup).toHaveBeenCalledExactlyOnceWith("/tmp/not-created-project");
    expect(chooseRoute).toHaveBeenCalledOnce();
    expect(runBoundaryReview).not.toHaveBeenCalled();
    expect(runAsk).not.toHaveBeenCalled();
    expect(runMcpInstall).not.toHaveBeenCalled();
    if (result === "failure") expect(output.join("")).toContain("Client setup remains available");
  });
  it.each(["success", "failure"])("continues execution setup without redrafting or losing client choices (%s)", async (result) => {
    const output: string[] = [];
    const runExecutionReview = vi.fn(async () => { if (result === "failure") throw new Error("Execution config needs repair"); });
    const runBoundaryReview = vi.fn(async () => 0), runAsk = vi.fn(async () => 0), runMcpInstall = vi.fn(async () => 0);
    const chooseRoute = vi.fn(async () => "later" as const);
    expect(await choosePostActivationAskSelection({ chooseRoute: async (initial) => {
      expect(initial).toBe("execution-setup"); return initial;
    } }, "execution-setup")).toEqual({ route: "execution-setup" });
    expect(await runPostActivationAskHandoff({ projectRoot: "/tmp/not-created-project", selection: { route: "execution-setup" } }, {
      env: {}, runExecutionReview, runBoundaryReview, runAsk, runMcpInstall, chooseRoute,
      stdout: { write: (value) => { output.push(String(value)); return true; } }, stderr: { write: () => true },
    })).toBe(0);
    expect(runExecutionReview).toHaveBeenCalledExactlyOnceWith("/tmp/not-created-project");
    expect(chooseRoute).toHaveBeenCalledOnce();
    expect(runBoundaryReview).not.toHaveBeenCalled();
    expect(runAsk).not.toHaveBeenCalled();
    expect(runMcpInstall).not.toHaveBeenCalled();
    if (result === "failure") expect(output.join("")).toContain("without redrafting");
  });

  it.each(["edit-rules", "manual-editor"] as const)("reopens %s without runtime identity, Analytics or client reconfiguration", async (route) => {
    const runBoundaryReview = vi.fn(async () => 0);
    const runAsk = vi.fn(async () => 0);
    const runMcpInstall = vi.fn(async () => 0);
    const promptWithDefault = vi.fn(async () => { throw new Error("No runtime model selection needed"); });
    expect(await choosePostActivationAskSelection({ chooseRoute: async () => route, promptWithDefault, env: {} }))
      .toEqual({ route });
    expect(await runPostActivationAskHandoff({ projectRoot: "/tmp/not-created-project", selection: { route } }, {
      env: {}, runBoundaryReview, runAsk, runMcpInstall,
      stdout: { write: () => true }, stderr: { write: () => true },
    })).toBe(0);
    expect(runBoundaryReview).toHaveBeenCalledWith(["--project-root", "/tmp/not-created-project", "--access",
      ...(route === "edit-rules" ? ["--job-first"] : [])]);
    expect(runAsk).not.toHaveBeenCalled();
    expect(runMcpInstall).not.toHaveBeenCalled();
    expect(promptWithDefault).not.toHaveBeenCalled();
  });

  it.each(["decline", "cancel", "pass", "fail", "exception"])("checks client launch only with permission and reports actual status (%s)", async (mode) => {
    const writes: string[] = [];
    const failed = mode === "fail" || mode === "exception";
    const approved = mode !== "decline" && mode !== "cancel";
    const runMcpInstall = vi.fn(async () => 0), runAsk = vi.fn(), runBoundaryReview = vi.fn(), runWorker = vi.fn();
    const checkClientLaunch = vi.fn(async () => {
      if (mode === "exception") throw new Error("npm error code ETARGET password=never-display-this");
      return { ok: mode === "pass", messages: ["Unexpected tools: postgres://user:never-display-this@host/db"] };
    });
    const code = await runPostActivationAskHandoff({ projectRoot: "/tmp/not-created project", includeActions: false,
      selection: { route: "mcp-client", client: "claude-code" } }, {
      env: {}, readRuntimeIdentity: async () => "unavailable", readRuntimeBindings: async () => [],
      runMcpInstall, runAsk, runBoundaryReview, runWorker,
      confirmLaunchCheck: async () => mode === "cancel" ? undefined : approved, checkClientLaunch,
      stdout: { write: (value) => { writes.push(String(value)); return true; } },
    });
    expect(code).toBe(failed ? 1 : 0);
    expect(runMcpInstall).toHaveBeenCalledExactlyOnceWith([
      "install", "claude-code", "--project", "--authoring", "--project-root", "/tmp/not-created project",
    ]);
    expect(checkClientLaunch).toHaveBeenCalledTimes(approved ? 1 : 0);
    if (approved) expect(checkClientLaunch).toHaveBeenCalledWith("/tmp/not-created project", "claude-code");
    expect(runAsk).not.toHaveBeenCalled();
    expect(runBoundaryReview).not.toHaveBeenCalled();
    expect(runWorker).not.toHaveBeenCalled();
    expect(writes.join("")).toContain(mode === "pass" ? "verified MCP handshake and tool catalog; test connection closed"
      : !approved ? "configured; launch not checked" : "saved; NOT CONNECTED; connection check failed");
    if (failed) {
      expect(writes.join("")).toContain("CLIENT CONFIGURATION SAVED; NOT CONNECTED");
      expect(writes.join("")).toContain("Read, Action and execution permissions are unchanged");
      expect(writes.join("")).toContain("mcp status claude-code --project --project-root '/tmp/not-created project' --check-launch");
      expect(writes.join("")).not.toMatch(/launches Runner|Launch the client|LOCAL STDIO MCP CONFIGURED|mcp install|--yes|--include-actions/);
    } else {
      expect(writes.join("")).toContain("LOCAL STDIO MCP CONFIGURED");
      expect(writes.join("")).not.toContain("NOT CONNECTED");
    }
    if (mode === "exception") expect(writes.join("")).toContain("ETARGET: The configured package version is unavailable");
    expect(writes.join("")).not.toContain("never-display-this");
    expect(writes.join("")).not.toContain("LOCAL STDIO MCP READY");
  });

  it.each([
    { throws: false, consent: false, workerCode: 0 },
    { throws: true, consent: undefined, workerCode: 0 },
    { throws: false, consent: true, workerCode: 0 },
    { throws: true, consent: true, workerCode: 0 },
    { throws: false, consent: true, workerCode: 7 },
  ])("keeps a failed client check failed after a separate worker choice (%j)", async ({ throws, consent, workerCode }) => {
    const writes: string[] = [];
    const runMcpInstall = vi.fn(async () => 0), runAsk = vi.fn(), runBoundaryReview = vi.fn();
    const runWorker = vi.fn(async () => workerCode), confirmWorkerStart = vi.fn(async (_context: string[]) => consent);
    const checkClientLaunch = vi.fn(async () => {
      if (throws) throw new Error("POLICY_EXECUTION_BINDING_CHANGED private-details");
      return { ok: false, messages: [] };
    });
    const code = await runPostActivationAskHandoff({ projectRoot: "/tmp/not-created-project", includeActions: true,
      selection: { route: "mcp-client", client: "cursor" } }, {
      env: { WRITER_URL: "private-writer" }, readRuntimeIdentity: async () => "local_environment",
      readRuntimeBindings: async () => [], runMcpInstall, runAsk, runBoundaryReview,
      confirmLaunchCheck: async () => true, checkClientLaunch, confirmWorkerStart, runWorker,
      readExecutionState: async () => ({ enabled: true, config_path: "synapsor.actions.runner.json", policies: [{
        outcome: "stockroom.correct_quantity", write_url_env: "WRITER_URL", action_boundary_digest: `sha256:${"a".repeat(64)}`,
        mode: "supervised_worker", concurrency: 1, queue_limit: 100, lease_seconds: 300, max_attempts: 5,
        proposal_ttl_seconds: 3600, rate_limit: { executions: 10, window_seconds: 60 },
      }] }),
      stdout: { write: (value) => { writes.push(String(value)); return true; } },
    });
    expect(code).toBe(consent && workerCode !== 0 ? workerCode : 1);
    expect(runMcpInstall).toHaveBeenCalledOnce();
    expect(checkClientLaunch).toHaveBeenCalledOnce();
    expect(confirmWorkerStart).toHaveBeenCalledOnce();
    const context = confirmWorkerStart.mock.calls[0]![0] as string[];
    expect(context.join("\n")).toContain("already-approved requests independently");
    expect(context.join("\n")).toContain("does not repair or verify the client connection");
    expect(context.join("\n")).not.toContain("Open the MCP client");
    expect(runWorker).toHaveBeenCalledTimes(consent ? 1 : 0);
    if (consent) expect(runWorker).toHaveBeenCalledExactlyOnceWith([
      "run", "--supervised", "--yes", "--config", "/tmp/not-created-project/synapsor.actions.runner.json",
    ]);
    expect(runAsk).not.toHaveBeenCalled();
    expect(runBoundaryReview).not.toHaveBeenCalled();
    expect(writes.join("")).toContain("mcp status cursor --project --project-root /tmp/not-created-project --check-launch --include-actions");
    expect(writes.join("")).not.toMatch(/launches Runner|LOCAL STDIO MCP CONFIGURED|private-details|private-writer|mcp install/);
    if (throws) expect(writes.join("")).toContain("POLICY_EXECUTION_BINDING_CHANGED");
  });

  it("routes production authority to the authenticated HTTP handoff without installing local stdio", async () => {
    const output: string[] = [];
    const runMcpInstall = vi.fn(async () => 0);
    await expect(runPostActivationAskHandoff({
      projectRoot: "/tmp/reviewed-production-project",
      selection: { route: "mcp-client", client: "claude-code" },
    }, {
      readRuntimeIdentity: async () => "production_authentication",
      runMcpInstall,
      stdout: { write: (value) => { output.push(String(value)); return true; } },
    })).resolves.toBe(0);
    expect(runMcpInstall).not.toHaveBeenCalled();
    expect(output.join("")).toContain("Local stdio MCP was not installed");
    expect(output.join("")).toContain("Production HTTP MCP");
  });

  it.each(["missing_writer", "decline", "start", "worker_failure", "configuration_failure"])("keeps worker lifecycle explicit after client configuration (%s)", async (mode) => {
    const writes: string[] = [];
    const confirmWorkerStart = vi.fn(async () => mode === "start" || mode === "worker_failure");
    const runWorker = vi.fn(async () => { if (mode === "worker_failure") throw new Error("Writer posture refused"); return 0; });
    await expect(runPostActivationAskHandoff({ projectRoot: "/tmp/not-created-project", includeActions: true,
      selection: { route: "mcp-client", client: "claude-code" } }, {
      env: mode === "missing_writer" ? {} : { WRITER_URL: "never-display-this" },
      readRuntimeBindings: async () => [],
      runMcpInstall: async () => 0, confirmLaunchCheck: async () => false, confirmWorkerStart, runWorker,
      readExecutionState: async () => { if (mode === "configuration_failure") throw new Error("Execution configuration invalid"); return { enabled: true, config_path: "synapsor.actions.runner.json", policies: [
        { outcome: "courses.enroll", write_url_env: "WRITER_URL", action_boundary_digest: `sha256:${"a".repeat(64)}`,
          mode: "supervised_worker", concurrency: 1, queue_limit: 100, lease_seconds: 300, max_attempts: 5,
          proposal_ttl_seconds: 3600, rate_limit: { executions: 10, window_seconds: 60 } },
      ] }; },
      stdout: { write: (value) => { writes.push(String(value)); return true; } },
      stderr: { write: (value) => { writes.push(String(value)); return true; } },
    })).resolves.toBe(mode.endsWith("failure") ? 1 : 0);
    expect(runWorker).toHaveBeenCalledTimes(mode === "start" || mode === "worker_failure" ? 1 : 0);
    expect(confirmWorkerStart).toHaveBeenCalledTimes(mode === "missing_writer" || mode === "configuration_failure" ? 0 : 1);
    if (mode === "start") expect(runWorker).toHaveBeenCalledWith(["run", "--supervised", "--yes", "--config", "/tmp/not-created-project/synapsor.actions.runner.json"]);
    expect(writes.join("")).toContain(mode.endsWith("failure") ? "Client configuration is saved. Execution setup could not finish" : mode === "missing_writer" ? "provide the reviewed writer environment WRITER_URL"
      : mode === "start" ? "This worker has stopped" : "Worker not started by setup");
    expect(writes.join("")).not.toContain("never-display-this");
    if (mode === "worker_failure") expect(writes.join("")).toContain(
      "Worker command (not run): synapsor-runner worker run --supervised --yes --config /tmp/not-created-project/synapsor.actions.runner.json",
    );
    if (mode === "configuration_failure") expect(writes.join("")).not.toContain("worker run");
  });
  it.each(["missing", "configured", "unavailable"] as const)("checks local execution identity before offering worker start (%s)", async (mode) => {
    const configured = mode === "configured";
    const writes: string[] = [];
    const start = vi.fn(async () => false);
    const run = vi.fn(async () => 0);
    expect(await runPostActivationAskHandoff({ projectRoot: "/tmp/not-created-project", includeActions: true,
      selection: { route: "mcp-client", client: "claude-code" } }, {
      env: { WRITER_URL: "secret-writer", ...(configured ? { ACCOUNT_ENV: "private-account", USER_ENV: "private-user" } : {}) },
      readRuntimeIdentity: async () => "local_environment",
      runMcpInstall: async () => 0, confirmLaunchCheck: async () => true,
      checkClientLaunch: async () => ({ ok: true, messages: [] }),
      readRuntimeBindings: async () => { if (mode === "unavailable") throw new Error("Unavailable"); return [{ role: "tenant", environment: "ACCOUNT_ENV" }, { role: "principal", environment: "USER_ENV" }]; },
      confirmWorkerStart: start, runWorker: run,
      readExecutionState: async () => ({ enabled: true, config_path: "synapsor.actions.runner.json", policies: [{
        outcome: "courses.enroll", write_url_env: "WRITER_URL", action_boundary_digest: `sha256:${"a".repeat(64)}`,
        mode: "supervised_worker", concurrency: 1, queue_limit: 100, lease_seconds: 300, max_attempts: 5,
        proposal_ttl_seconds: 3600, rate_limit: { executions: 10, window_seconds: 60 },
      }] }),
      stdout: { write: (value) => { writes.push(String(value)); return true; } },
    })).toBe(0);
    expect(start).toHaveBeenCalledTimes(configured ? 1 : 0);
    if (configured) expect(start).toHaveBeenCalledWith(expect.arrayContaining([
      "Client connection: verified MCP handshake and tool catalog; test connection closed.",
    ]));
    else expect(writes.join("")).toContain(mode === "unavailable" ? "Worker not started: the reviewed identity requirements could not be loaded"
      : "Worker not started: this local execution mode also requires trusted identity in ACCOUNT_ENV, USER_ENV");
    expect(run).not.toHaveBeenCalled();
    const output = writes.join("");
    expect(output).not.toMatch(/secret-writer|private-account|private-user|worker is running|customer use ready/i);
    const executionStatus = "Client mode: execution configured; worker not started by setup; worker health not checked.";
    expect(output).toContain(executionStatus);
    expect(output.split("Client mode:")).toHaveLength(2);
    expect(output.indexOf(executionStatus)).toBeLessThan(output.indexOf("  cd "));
    if (mode === "missing") {
      expect(output).toContain("LOCAL STDIO MCP CONFIGURED; NOT READY FOR CUSTOMER USE");
      expect(output).toContain("Local test identity still needed: ACCOUNT_ENV, USER_ENV.");
      expect(output).toContain("Return to the local-test identity review");
      expect(output).not.toContain("  export ");
      expect(output.indexOf(executionStatus)).toBeLessThan(output.indexOf("Local test identity still needed:"));
      expect(output.split("Runner never accepts identity values from MCP tool arguments or a model")).toHaveLength(2);
      expect(output).not.toContain("Use trusted test identities locally;");
    } else {
      expect(output).toContain("LOCAL STDIO MCP CONFIGURED; CUSTOMER USE NOT VERIFIED");
      expect(output).not.toContain("  export ");
    }
  });

  it("keeps installed local MCP setup pending when the operator declines the guided test identity", async () => {
    const writes: string[] = [];
    const install = vi.fn(async () => 0);
    const collect = vi.fn(async () => undefined);
    const start = vi.fn(async () => true);
    const worker = vi.fn(async () => 0);
    await expect(runPostActivationAskHandoff({ projectRoot: "/tmp/local-identity-declined", includeActions: true,
      selection: { route: "mcp-client", client: "claude-code" } }, {
      env: { WRITER_URL: "private-writer" }, readRuntimeIdentity: async () => "local_environment",
      readRuntimeBindings: async () => [{ role: "tenant", environment: "FIXTURE_TENANT" }, { role: "principal", environment: "FIXTURE_PERSON" }],
      collectLocalTestIdentity: collect, runMcpInstall: install, confirmLaunchCheck: async () => false,
      confirmWorkerStart: start, runWorker: worker,
      readExecutionState: async () => ({ enabled: true, config_path: "synapsor.actions.runner.json", policies: [{
        outcome: "telecom.change_plan", write_url_env: "WRITER_URL", action_boundary_digest: `sha256:${"a".repeat(64)}`,
        mode: "supervised_worker", concurrency: 1, queue_limit: 100, lease_seconds: 300, max_attempts: 5,
        proposal_ttl_seconds: 3600, rate_limit: { executions: 10, window_seconds: 60 },
      }] }),
      stdout: { write: (value) => { writes.push(String(value)); return true; } },
    })).resolves.toBe(0);
    expect(install).toHaveBeenCalledOnce();
    expect(collect).toHaveBeenCalledExactlyOnceWith({
      projectRoot: "/tmp/local-identity-declined", client: "claude-code",
      bindings: [{ role: "tenant", environment: "FIXTURE_TENANT" }, { role: "principal", environment: "FIXTURE_PERSON" }],
    });
    expect(start).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
    expect(writes.join("")).toContain("Local test identity setup was skipped");
    expect(writes.join("")).toContain("LOCAL STDIO MCP CONFIGURED; NOT READY FOR CUSTOMER USE");
    expect(writes.join("")).not.toContain("private-writer");
  });

  it("reuses an exact saved local test identity without prompting again", async () => {
    const writes: string[] = [];
    const collect = vi.fn(async () => ({ FIXTURE_TENANT: "unexpected", FIXTURE_PERSON: "unexpected" }));
    await expect(runPostActivationAskHandoff({ projectRoot: "/tmp/local-identity-reused", selection: { route: "mcp-client", client: "claude-code" } }, {
      env: {}, readRuntimeIdentity: async () => "local_environment",
      readRuntimeBindings: async () => [{ role: "tenant", environment: "FIXTURE_TENANT" }, { role: "principal", environment: "FIXTURE_PERSON" }],
      loadLocalTestIdentity: async () => ({ FIXTURE_TENANT: "fixture-tenant", FIXTURE_PERSON: "fixture-person" }),
      collectLocalTestIdentity: collect, runMcpInstall: async () => 0, confirmLaunchCheck: async () => false,
      stdout: { write: (value) => { writes.push(String(value)); return true; } }, stderr: { write: () => true },
    })).resolves.toBe(0);
    expect(collect).not.toHaveBeenCalled();
    const output = writes.join("");
    expect(output).toContain("Reviewed local test runtime already matches the current boundary");
    expect(output).toContain("LOCAL TEST RUNTIME CONFIGURED");
    expect(output).not.toContain("fixture-tenant");
    expect(output).not.toContain("fixture-person");
  });

  it("saves an accepted local test identity for the managed client and separately confirmed foreground worker", async () => {
    const writes: string[] = [];
    const collect = vi.fn(async () => ({ FIXTURE_TENANT: "fixture-tenant", FIXTURE_PERSON: "fixture-person" }));
    const save = vi.fn(async (input: { bindings: Array<{ role: "tenant" | "principal"; environment: string }>; values: Record<string, string> }) => ({
      path: "/tmp/local-identity-accepted/.synapsor/local-test-runtime.json",
      bindings: input.bindings,
    }));
    const check = vi.fn(async () => {
      expect(process.env.FIXTURE_TENANT).toBeUndefined();
      expect(process.env.FIXTURE_PERSON).toBeUndefined();
      return { ok: true, messages: [] };
    });
    const worker = vi.fn(async () => {
      expect(process.env.FIXTURE_TENANT).toBeUndefined();
      expect(process.env.FIXTURE_PERSON).toBeUndefined();
      return 0;
    });
    await expect(runPostActivationAskHandoff({ projectRoot: "/tmp/local-identity-accepted", includeActions: true,
      selection: { route: "mcp-client", client: "claude-code" } }, {
      env: { WRITER_URL: "private-writer" }, readRuntimeIdentity: async () => "local_environment",
      readRuntimeBindings: async () => [{ role: "tenant", environment: "FIXTURE_TENANT" }, { role: "principal", environment: "FIXTURE_PERSON" }],
      collectLocalTestIdentity: collect, saveLocalTestIdentity: save, runMcpInstall: async () => 0, confirmLaunchCheck: async () => true, checkClientLaunch: check,
      confirmWorkerStart: async () => true, runWorker: worker,
      readExecutionState: async () => ({ enabled: true, config_path: "synapsor.actions.runner.json", policies: [{
        outcome: "telecom.change_plan", write_url_env: "WRITER_URL", action_boundary_digest: `sha256:${"a".repeat(64)}`,
        mode: "supervised_worker", concurrency: 1, queue_limit: 100, lease_seconds: 300, max_attempts: 5,
        proposal_ttl_seconds: 3600, rate_limit: { executions: 10, window_seconds: 60 },
      }] }),
      stdout: { write: (value) => { writes.push(String(value)); return true; } },
    })).resolves.toBe(0);
    expect(collect).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledExactlyOnceWith({
      projectRoot: "/tmp/local-identity-accepted",
      bindings: [{ role: "tenant", environment: "FIXTURE_TENANT" }, { role: "principal", environment: "FIXTURE_PERSON" }],
      values: { FIXTURE_TENANT: "fixture-tenant", FIXTURE_PERSON: "fixture-person" },
    });
    expect(check).toHaveBeenCalledExactlyOnceWith("/tmp/local-identity-accepted", "claude-code");
    expect(worker).toHaveBeenCalledOnce();
    const output = writes.join("");
    expect(output).toContain("LOCAL TEST RUNTIME CONFIGURED");
    expect(output).toContain("This worker has stopped");
    expect(output).not.toContain("fixture-tenant");
    expect(output).not.toContain("fixture-person");
    expect(output).not.toContain("private-writer");
  });

  it.each(["missing_writer", "missing_identity", "unavailable_identity", "decline"] as const)(
    "prints the exact saved worker command even when setup cannot start it (%s)", async (mode) => {
      const writes: string[] = [];
      const start = vi.fn(async () => false), run = vi.fn(async () => 0);
      const install = vi.fn(async () => 0), check = vi.fn(async () => ({ ok: true, messages: [] }));
      const code = await runPostActivationAskHandoff({ projectRoot: "/tmp/not-created project", includeActions: true,
        selection: { route: "mcp-client", client: "claude-code" } }, {
        env: { ...(mode !== "missing_writer" ? { WRITER_URL: "private-writer-value" } : {}),
          ...(mode !== "missing_identity" ? { ACCOUNT_ENV: "private-account-value", USER_ENV: "private-user-value" } : {}) },
        readRuntimeIdentity: async () => "local_environment",
        readRuntimeBindings: async () => {
          if (mode === "unavailable_identity") throw new Error("Reviewed identity unavailable");
          return [{ role: "tenant", environment: "ACCOUNT_ENV" }, { role: "principal", environment: "USER_ENV" }];
        },
        runMcpInstall: install, confirmLaunchCheck: async () => true, checkClientLaunch: check,
        confirmWorkerStart: start, runWorker: run,
        readExecutionState: async () => ({ enabled: true, config_path: "./approved execution.json", policies: [{
          outcome: "warehouse.correct_quantity", write_url_env: "WRITER_URL", action_boundary_digest: `sha256:${"a".repeat(64)}`,
          mode: "supervised_worker", concurrency: 1, queue_limit: 100, lease_seconds: 300, max_attempts: 5,
          proposal_ttl_seconds: 3600, rate_limit: { executions: 10, window_seconds: 60 },
        }] }),
        stdout: { write: (value) => { writes.push(String(value)); return true; } },
      });
      expect(code).toBe(0);
      expect(install).toHaveBeenCalledOnce();
      expect(check).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledTimes(mode === "decline" ? 1 : 0);
      expect(run).not.toHaveBeenCalled();
      const output = writes.join("");
      expect(output).toContain("Worker command (not run): synapsor-runner worker run --supervised --yes --config '/tmp/not-created project/approved execution.json'");
      expect(output).toContain("Worker not started");
      expect(output).not.toMatch(/Starting the reviewed worker|worker is running|private-writer-value|private-account-value|private-user-value/);
      if (mode === "missing_writer") expect(output.indexOf("Worker command (not run):")).toBeGreaterThan(output.indexOf("provide the reviewed writer environment WRITER_URL"));
      if (mode === "missing_identity") expect(output.indexOf("Worker command (not run):")).toBeGreaterThan(output.indexOf("requires trusted identity in ACCOUNT_ENV, USER_ENV"));
    },
  );

  it("does not advertise a worker command when saved execution is disabled", async () => {
    const writes: string[] = [];
    const start = vi.fn(async () => true), run = vi.fn(async () => 0);
    expect(await runPostActivationAskHandoff({ projectRoot: "/tmp/not-created-project", includeActions: true,
      selection: { route: "mcp-client", client: "claude-code" } }, {
      env: {}, readRuntimeIdentity: async () => "local_environment", readRuntimeBindings: async () => [],
      runMcpInstall: async () => 0, confirmLaunchCheck: async () => false,
      confirmWorkerStart: start, runWorker: run,
      readExecutionState: async () => ({ enabled: false, config_path: "unreviewed.json", policies: [] }),
      stdout: { write: (value) => { writes.push(String(value)); return true; } },
    })).toBe(0);
    expect(start).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(writes.join("")).toContain("proposal-only; automatic database updates are off");
    expect(writes.join("").indexOf("proposal-only;")).toBeLessThan(writes.join("").indexOf("  cd "));
    expect(writes.join("")).not.toContain("execution configured");
    expect(writes.join("")).not.toContain("worker run");
  });

  it.each([
    { identities: ["quantity_worker", "reorder_worker"], consent: false },
    { identities: ["quantity_worker", "reorder_worker"], consent: true },
    { identities: ["semantic_action_worker", "semantic_action_worker"], consent: false },
    { identities: ["semantic_action_worker", "semantic_action_worker"], consent: true },
    { identities: [undefined, undefined], consent: false },
    { identities: [undefined, undefined], consent: true },
    { identities: [undefined, "reorder_worker"], consent: false },
    { identities: [undefined, "reorder_worker"], consent: true },
  ])("matches worker handoff commands to every saved identity without an ambiguous automatic launch (%j)", async ({ identities, consent }) => {
    const writes: string[] = [];
    const start = vi.fn(async () => consent), run = vi.fn(async () => 0);
    const outcomes = ["warehouse.correct_quantity", "warehouse.set_reorder_point"];
    const policies = outcomes.map((outcome, index) => ({ outcome, write_url_env: "WRITER_URL",
      action_boundary_digest: `sha256:${"a".repeat(64)}` as const, mode: "supervised_worker" as const,
      concurrency: 1, queue_limit: 100, lease_seconds: 300, max_attempts: 5, proposal_ttl_seconds: 3600,
      rate_limit: { executions: 10, window_seconds: 60 },
      ...(identities[index] ? { worker_identity: identities[index] } : {}),
    }));
    const before = structuredClone(policies);
    expect(await runPostActivationAskHandoff({ projectRoot: "/tmp/not-created-project", includeActions: true,
      selection: { route: "mcp-client", client: "claude-code" } }, {
      env: { WRITER_URL: "private-writer", SYNAPSOR_RUNNER_ID: "unrelated_process_identity",
        SYNAPSOR_TENANT_ID: "private-tenant-not-worker-identity" },
      readRuntimeIdentity: async () => "local_environment", readRuntimeBindings: async () => [],
      runMcpInstall: async () => 0, confirmLaunchCheck: async () => false,
      confirmWorkerStart: start, runWorker: run,
      readExecutionState: async () => ({ enabled: true, config_path: "synapsor.actions.runner.json", policies }),
      stdout: { write: (value) => { writes.push(String(value)); return true; } },
    })).toBe(0);
    const scoped = new Set(identities).size > 1;
    const base = ["run", "--supervised", "--yes", "--config", "/tmp/not-created-project/synapsor.actions.runner.json"];
    const commands = scoped ? policies.map((policy) => [...base, "--capability", policy.outcome,
      ...(policy.worker_identity ? ["--worker-id", policy.worker_identity] : [])])
      : [[...base, ...(identities[0] ? ["--worker-id", identities[0]] : [])]];
    expect(start).toHaveBeenCalledTimes(scoped ? 0 : 1);
    expect(run).toHaveBeenCalledTimes(!scoped && consent ? 1 : 0);
    const output = writes.join("");
    if (!scoped && consent) {
      expect(run).toHaveBeenCalledExactlyOnceWith(commands[0]);
      expect(output).toContain(`Launching worker command: synapsor-runner worker ${commands[0]!.join(" ")}`);
      expect(output).toContain("This worker has stopped");
    } else {
      const printed = output.split("\n").filter((line) => line.startsWith("Worker command (not run):"));
      expect(printed).toEqual(commands.map((args) => `Worker command (not run): synapsor-runner worker ${args.join(" ")}`));
      expect(output).toContain(scoped ? "No workers were started by setup." : "Worker not started");
      expect(output).not.toContain("Starting the reviewed worker");
    }
    expect(policies).toEqual(before);
    expect(output).not.toMatch(/private-writer|unrelated_process_identity|private-tenant-not-worker-identity/);
  });

  it("quotes worker identities and outcome selectors as literal shell arguments without launching them", async () => {
    const writes: string[] = [];
    const start = vi.fn(async () => true), run = vi.fn(async () => 0);
    const policies = [
      { outcome: "warehouse.correct'quantity;$(false)", worker_identity: "ops'writer;$(touch /tmp/never-create-this)" },
      { outcome: "warehouse.reorder", worker_identity: "second_writer" },
    ].map((entry) => ({ ...entry, write_url_env: "WRITER_URL", action_boundary_digest: `sha256:${"a".repeat(64)}` as const,
      mode: "supervised_worker" as const, concurrency: 1, queue_limit: 100, lease_seconds: 300, max_attempts: 5,
      proposal_ttl_seconds: 3600, rate_limit: { executions: 10, window_seconds: 60 } }));
    expect(await runPostActivationAskHandoff({ projectRoot: "/tmp/not-created project", includeActions: true,
      selection: { route: "mcp-client", client: "claude-code" } }, {
      env: { WRITER_URL: "private-writer" }, readRuntimeIdentity: async () => "local_environment",
      readRuntimeBindings: async () => [], runMcpInstall: async () => 0, confirmLaunchCheck: async () => false,
      confirmWorkerStart: start, runWorker: run,
      readExecutionState: async () => ({ enabled: true, config_path: "approved execution.json", policies }),
      stdout: { write: (value) => { writes.push(String(value)); return true; } },
    })).toBe(0);
    expect(start).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(writes.join("")).toContain("--config '/tmp/not-created project/approved execution.json' --capability 'warehouse.correct'\\''quantity;$(false)' --worker-id 'ops'\\''writer;$(touch /tmp/never-create-this)'");
    expect(writes.join("")).toContain("--capability warehouse.reorder --worker-id second_writer");
    expect(writes.join("")).not.toContain("private-writer");
  });

  it("requires semantic authority rather than legacy capabilities and propagates invalid active authority", async () => {
    const readSemanticActivation = vi.fn(async () => ({ digest: "reviewed" }) as never);
    const semantic = vi.fn(async () => ({
      registry: { rules: [{ compiled: { outcome: "support.refund_requested" } }] },
    }) as unknown as Awaited<ReturnType<typeof import("./action-rule-authority.js").loadActiveActionRuleAuthority>>);

    await expect(hasActiveActionRuntime("/tmp/reviewed-project", {
      readSemanticActivation,
      loadSemanticAuthority: semantic,
    })).resolves.toBe(true);
    expect(semantic).toHaveBeenCalledOnce();

    await expect(hasActiveActionRuntime("/tmp/reviewed-project", {
      readSemanticActivation: async () => undefined,
      loadSemanticAuthority: vi.fn(async () => {
        throw new Error("semantic lookup should not run");
      }),
    })).resolves.toBe(false);

    await expect(hasActiveActionRuntime("/tmp/reviewed-project", {
      readSemanticActivation,
      loadSemanticAuthority: async () => {
        throw new Error("ACTION_RULE_READ_AUTHORITY_STALE");
      },
    })).rejects.toThrow("ACTION_RULE_READ_AUTHORITY_STALE");
  });

  it("colors keyboard focus without inverse-video highlighting", () => {
    const selected = formatPostActivationRouteLine({
      option: { label: "OpenAI", detail: "Start terminal chat" },
      selected: true,
      color: true,
    });
    expect(selected).toContain("\u001b[1;96m> OpenAI");
    expect(selected).not.toContain("\u001b[7m");
    expect(formatPostActivationRouteLine({
      option: { label: "OpenAI", detail: "Start terminal chat" },
      selected: true,
      color: false,
    })).toBe("> OpenAI                Start terminal chat");
  });

  it("keeps numeric MCP-client shortcuts on the picker until Enter reviews the install", () => {
    const direct = mcpClientPickerTransition(0, { name: "2" });
    expect(direct).toEqual({ selected: 1 });
    expect(mcpClientPickerTransition(direct.selected, { name: "enter" }))
      .toEqual({ selected: 1, client: "cursor" });
    expect(mcpClientPickerTransition(0, { name: "escape" }))
      .toEqual({ selected: 0, cancelled: true });
  });

  it("prefers an already configured hosted provider", () => {
    expect(preferredRoute({ OPENAI_API_KEY: "configured" })).toBe("openai");
    expect(preferredRoute({ ANTHROPIC_API_KEY: "configured" })).toBe("anthropic");
    expect(preferredRoute({})).toBe("openai");
    expect(soleConfiguredHostedRoute({ OPENAI_API_KEY: "configured" })).toBe("openai");
    expect(soleConfiguredHostedRoute({ ANTHROPIC_API_KEY: "configured" })).toBe("anthropic");
    expect(soleConfiguredHostedRoute({
      OPENAI_API_KEY: "configured",
      ANTHROPIC_API_KEY: "configured",
    })).toBeUndefined();
    expect(defaultPostActivationAskSelection({})).toEqual({
      route: "openai",
      model: "gpt-5.6-terra",
    });
    expect(defaultPostActivationAskSelection({ ANTHROPIC_API_KEY: "configured" }))
      .toEqual({
        route: "anthropic",
        model: "claude-sonnet-4-20250514",
      });
  });

  it("skips provider and egress prompts for the two-gesture configured-model handoff", async () => {
    const chooseRoute = vi.fn(async () => "later" as const);
    const runAsk = vi.fn(async () => 0);
    const stdout = { write: vi.fn(() => true) };

    await expect(runPostActivationAskHandoff(
      {
        projectRoot: "/tmp/reviewed-project",
        autoStartConfiguredProvider: true,
        consentOnFirstQuestion: true,
      },
      {
        env: { OPENAI_API_KEY: "configured" },
        chooseRoute,
        runAsk,
        stdout,
        stderr: { write: vi.fn(() => true) },
      },
    )).resolves.toBe(0);

    expect(chooseRoute).not.toHaveBeenCalled();
    expect(runAsk).toHaveBeenCalledWith([
      "--project-root", "/tmp/reviewed-project",
      "--provider", "openai",
      "--model", "gpt-5.6-terra",
    ], { consentOnFirstQuestion: true });
    expect(String(stdout.write.mock.calls.flat()))
      .toContain("OpenAI is already configured");
  });

  it.each([
    {
      route: "openai" as const,
      expected: [
        "--project-root", "/tmp/reviewed-project",
        "--provider", "openai",
        "--model", "gpt-5.6-terra",
      ],
    },
    {
      route: "anthropic" as const,
      expected: [
        "--project-root", "/tmp/reviewed-project",
        "--provider", "anthropic",
        "--model", "claude-sonnet-4-20250514",
      ],
    },
  ])("starts the existing Ask path for $route", async ({ route, expected }) => {
    const stdout = { write: vi.fn(() => true) };
    const runAsk = vi.fn(async () => 0);
    const promptWithDefault = vi.fn(async (_prompt: string, defaultValue: string) => defaultValue);
    await expect(runPostActivationAskHandoff(
      { projectRoot: "/tmp/reviewed-project" },
      {
        chooseRoute: async () => route,
        promptWithDefault,
        runAsk,
        stdout,
        stderr: { write: vi.fn(() => true) },
      },
    )).resolves.toBe(0);

    expect(runAsk).toHaveBeenCalledWith(expected);
    expect(promptWithDefault).toHaveBeenCalledExactlyOnceWith(`Terminal Ask model (${route === "openai" ? "OpenAI" : "Anthropic"})`, expected.at(-1));
    expect(String(stdout.write.mock.calls.flat())).toContain("Starting Synapsor Analytics");
    expect(String(stdout.write.mock.calls.flat())).toContain("Terminal Ask model:");
    expect(String(stdout.write.mock.calls.flat())).toContain("separate from the saved Boundary drafting provider and any external MCP client");
  });

  it("collects loopback endpoint details and starts the same Ask path for a local model", async () => {
    const prompts: Array<[string, string]> = [];
    const runAsk = vi.fn(async () => 0);
    await expect(runPostActivationAskHandoff(
      {
        projectRoot: "/tmp/reviewed-project",
        requestTimeoutSeconds: 180,
        sessionTokenBudget: 350_000,
        maxOutputTokens: 2_048,
      },
      {
        chooseRoute: async () => "openai-compatible",
        promptWithDefault: async (prompt, defaultValue) => {
          prompts.push([prompt, defaultValue]);
          return defaultValue;
        },
        listOpenAiCompatibleModels: async () => [],
        runAsk,
        stdout: { write: vi.fn(() => true) },
        stderr: { write: vi.fn(() => true) },
      },
    )).resolves.toBe(0);

    expect(prompts).toEqual([
      ["Local OpenAI-compatible base URL", "http://127.0.0.1:11434/v1"],
      ["Terminal Ask model (local)", "llama3.2"],
    ]);
    expect(runAsk).toHaveBeenCalledWith([
      "--project-root", "/tmp/reviewed-project",
      "--provider", "openai-compatible",
      "--model", "llama3.2",
      "--base-url", "http://127.0.0.1:11434/v1",
      "--timeout", "180",
      "--session-token-budget", "350000",
      "--max-output-tokens", "2048",
    ]);
  });

  it("lets a developer choose the hosted provider and exact model", async () => {
    await expect(choosePostActivationAskSelection({
      env: { ANTHROPIC_API_KEY: "configured" },
      chooseRoute: async (defaultRoute) => {
        expect(defaultRoute).toBe("anthropic");
        return "anthropic";
      },
      promptWithDefault: async (prompt, defaultValue) => {
        expect(prompt).toBe("Terminal Ask model (Anthropic)");
        expect(defaultValue).toBe("claude-sonnet-4-20250514");
        return "claude-owner-selected";
      },
    })).resolves.toEqual({
      route: "anthropic",
      model: "claude-owner-selected",
    });
    expect(formatPostActivationAskSelection({
      route: "anthropic",
      model: "claude-owner-selected",
    })).toBe("Anthropic / claude-owner-selected");
  });

  it("uses a model reported by a local OpenAI-compatible endpoint instead of a stale hardcoded default", async () => {
    const prompts: Array<[string, string]> = [];
    await expect(choosePostActivationAskSelection({
      chooseRoute: async () => "openai-compatible",
      listOpenAiCompatibleModels: async () => ["qwen2.5:7b"],
      promptWithDefault: async (prompt, defaultValue) => {
        prompts.push([prompt, defaultValue]);
        return defaultValue;
      },
    })).resolves.toEqual({
      route: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen2.5:7b",
    });
    expect(prompts).toEqual([
      ["Local OpenAI-compatible base URL", "http://127.0.0.1:11434/v1"],
      ["Terminal Ask model (local) (detected: qwen2.5:7b)", "qwen2.5:7b"],
    ]);
  });

  it("returns one level from model input and leaves provider selection on Escape", async () => {
    const routes: Array<PostActivationAskRoute | undefined> = ["openai", "anthropic"];
    const models: Array<string | undefined> = [undefined, "claude-owner-selected"];
    await expect(choosePostActivationAskSelection({
      chooseRoute: async () => routes.shift(),
      promptWithDefault: async () => models.shift(),
    })).resolves.toEqual({
      route: "anthropic",
      model: "claude-owner-selected",
    });
  });

  it("returns from a local model name to its endpoint before leaving provider setup", async () => {
    const values: Array<string | undefined> = [
      "http://127.0.0.1:11434/v1",
      undefined,
      "http://127.0.0.1:1234/v1",
      "local-owner-model",
    ];
    const prompts: string[] = [];
    await expect(choosePostActivationAskSelection({
      chooseRoute: async () => "openai-compatible",
      promptWithDefault: async (prompt) => {
        prompts.push(prompt);
        return values.shift();
      },
      listOpenAiCompatibleModels: async () => [],
    })).resolves.toEqual({
      route: "openai-compatible",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-owner-model",
    });
    expect(prompts).toEqual([
      "Local OpenAI-compatible base URL",
      "Terminal Ask model (local)",
      "Local OpenAI-compatible base URL",
      "Terminal Ask model (local)",
    ]);
  });

  it("cancels provider selection without starting Ask or changing reviewed access", async () => {
    const output: string[] = [];
    const runAsk = vi.fn(async () => 0);
    await expect(runPostActivationAskHandoff(
      { projectRoot: "/tmp/reviewed-project" },
      {
        chooseRoute: async () => undefined,
        runAsk,
        stdout: { write: (value) => {
          output.push(String(value));
          return true;
        } },
        stderr: { write: vi.fn(() => true) },
      },
    )).resolves.toBe(0);
    expect(runAsk).not.toHaveBeenCalled();
    expect(output.join("" )).toContain("Setup saved");
    expect(output.join("" )).toContain("reviewed boundaries remain active");
  });

  it.each([0, 2])("leaves %s/3 execution unchanged on Later without inventing a connection failure for deferred outcomes", async (enabledCount) => {
    const boundary = await import("./boundary-commands.js");
    const resume = await import("./boundary-authoring-resume.js");
    const readiness = await import("./authoring-client-readiness.js");
    const authority = await import("./action-rule-authority.js");
    const setup = await import("./semantic-execution-setup.js");
    const digest = `sha256:${"a".repeat(64)}` as const;
    const outcomes = ["stock.correct_quantity", "stock.set_reorder_point", "stock.archive"];
    const active = { authority: { action_boundary: { digest }, rules: outcomes.map((outcome) => ({ rule: { outcome },
      effect_envelope: { writeback: { mode: "direct_sql", supervised_worker: "allowed" } } })) } };
    const execution = { enabled: enabledCount > 0, config_path: "synapsor.actions.runner.json", policies: outcomes.slice(0, enabledCount).map((outcome) => ({
      outcome, action_boundary_digest: digest, mode: "supervised_worker" as const, write_url_env: "WRITER_URL",
      concurrency: 1, queue_limit: 100, lease_seconds: 300, max_attempts: 5,
      proposal_ttl_seconds: 3600, rate_limit: { executions: 10, window_seconds: 60 },
    })) };
    const before = structuredClone({ active, execution });
    const output: string[] = [];
    const runWorker = vi.fn(async () => 0), runExecutionReview = vi.fn(async () => {});
    const runActionReview = vi.fn(async () => 0), runMcpInstall = vi.fn(async () => 0), runAsk = vi.fn(async () => 0);
    const mocks = [
      vi.spyOn(boundary, "loadBoundaryReviewContext").mockResolvedValue({ bundle: {} } as never),
      vi.spyOn(boundary, "boundaryAuthoringResumeBinding").mockReturnValue({} as never),
      vi.spyOn(resume, "readBoundaryAuthoringResumeState").mockResolvedValue({ status: "ready", value: {
        stage: "client_setup", client_handoff: { action_digest: digest },
      } } as never),
      vi.spyOn(readiness, "clientHandoffMatchesActiveAuthority").mockResolvedValue(true),
      vi.spyOn(readiness, "pendingClientResponsibilities").mockResolvedValue([]),
      vi.spyOn(authority, "loadActiveActionRuleAuthority").mockResolvedValue(active as never),
      vi.spyOn(setup, "readPausedExecutionSetup").mockResolvedValue(undefined),
      vi.spyOn(managedLauncher, "resolveManagedMcpLauncher").mockResolvedValue({ command: "/usr/bin/node", args: ["/isolated build/dist/runner.mjs"] }),
    ];
    try {
      expect(await runPostActivationAskHandoff({ projectRoot: "/tmp/not-created-project", selection: { route: "later" } }, {
        env: {}, readActionDrafts: async () => [], readExecutionState: async () => execution,
        readReadiness: async () => ({ read: "active", semantic_actions: "active", legacy_actions: "inactive", worker: "not_checked",
          semantic_outcomes: outcomes.map((outcome, index) => ({ outcome, approval_mode: "human", execution_enabled: index < enabledCount })) }),
        runWorker, runExecutionReview, runActionReview, runMcpInstall, runAsk,
        stdout: { write: (value) => { output.push(String(value)); return true; } }, stderr: { write: () => true },
      })).toBe(0);
      const receipt = output.join("");
      expect(receipt).toContain(`Execution enabled: ${enabledCount}/3 outcomes.`);
      expect(receipt).toContain(`Execution is not configured for this revision: ${outcomes.slice(enabledCount).sort().join(", ")}. Deferred outcomes remain off.`);
      expect(receipt).toContain("Setup saved. Execution review is still pending.");
      expect(receipt).toContain("Next: reopen Execution setup when you want to review the remaining outcomes. Existing execution settings are preserved.");
      expect(receipt).toContain("'/isolated build/dist/runner.mjs' boundary review --access --job-first --project-root /tmp/not-created-project");
      expect(receipt).not.toMatch(/repair the connection|saved writer requirements|Last check:|recover the exact save|Setup complete|not ready for automatic changes/i);
      expect({ active, execution }).toEqual(before);
      for (const action of [runWorker, runExecutionReview, runActionReview, runMcpInstall, runAsk]) expect(action).not.toHaveBeenCalled();
    } finally { for (const mock of mocks) mock.mockRestore(); }
  });

  it("prints a pinned-build execution resume receipt, not an Ask command or a completion claim", async () => {
    const spy = vi.spyOn(managedLauncher, "resolveManagedMcpLauncher").mockResolvedValue({ command: "/usr/bin/node", args: ["/isolated build/dist/runner.mjs"] });
    try {
      const receipt = await savedSetupReceipt("/saved project", true, { version: 1, action_digest: `sha256:${"a".repeat(64)}`,
        outcome: "telecom.offered_plan_change", paused_at: "2026-09-06T00:00:00.000Z",
        problem: { code: "SEMANTIC_ACTION_WRITER_POSTURE_INVALID", summary: "Writer permissions do not match this action.", details: [] },
      });
      expect(receipt).toContain("Execution review is still pending");
      expect(receipt).toContain("Writer permissions do not match");
      expect(receipt).toContain("review the saved writer requirements, repair the connection, then resume Execution setup");
      expect(receipt).not.toContain("when you want to review the remaining outcomes");
      expect(receipt).toContain("'/isolated build/dist/runner.mjs' boundary review --access --job-first --project-root '/saved project'");
      expect(receipt).toContain("does not verify a client connection, runtime identity, or worker");
      expect(receipt).not.toMatch(/try ask|Start.*chat|Setup complete/u);
    } finally { spy.mockRestore(); }
  });

  it("returns from saved blocker details to the same repair decision without a client-menu detour", async () => {
    const chooseOption = vi.fn().mockResolvedValueOnce("details").mockResolvedValueOnce("details").mockResolvedValueOnce("recheck");
    const showReviewDetails = vi.fn(async () => {});
    const paused = { version: 1 as const, action_digest: `sha256:${"a".repeat(64)}`, outcome: "courses.enroll",
      paused_at: "2026-09-06T00:00:00.000Z", problem: { code: "CHECK_FAILED", summary: "Repair the writer", details: ["Exact grant"] } };
    expect(await reviewPausedExecutionSetup({ chooseOption, showReviewDetails } as never, paused)).toBe(true);
    expect(showReviewDetails).toHaveBeenCalledTimes(2);
    expect(chooseOption).toHaveBeenCalledTimes(3);
    expect(chooseOption.mock.calls[0]).toEqual(chooseOption.mock.calls[2]);
    expect(paused.problem.details).toEqual(["Exact grant"]);
  });

  it.each(["unconfirmed", "committed", "cancelled"] as const)("does not declare execution off while resuming a %s publication", async (publication_state) => {
    const paused = { version: 1 as const, action_digest: `sha256:${"a".repeat(64)}`, outcome: "courses.enroll",
      paused_at: "2026-09-06T00:00:00.000Z", problem: { code: "POLICY_CONFIG_RECOVERY_CLEANUP_PENDING",
        summary: "Inspect the saved publication receipt.", details: ["Exact saved attempt"], publication_state } };
    const receipt = await savedSetupReceipt("/saved project", true, paused);
    expect(receipt).toContain("recover the exact save");
    expect(receipt).not.toMatch(/updates are off|completion stays off|repair the connection/i);
    const chooseOption = vi.fn().mockResolvedValueOnce("details").mockResolvedValueOnce("recheck");
    const showReviewDetails = vi.fn(async () => {});
    expect(await reviewPausedExecutionSetup({ chooseOption, showReviewDetails } as never, paused)).toBe(true);
    expect(showReviewDetails).toHaveBeenCalledWith("Saved execution recovery", ["Exact saved attempt"]);
    expect(JSON.stringify(chooseOption.mock.calls)).not.toMatch(/repaired the connection|administrator handoff/);
  });

  it.each([80, 120])("wraps saved setup receipts inside both margins at %s columns", async (columns) => {
    const output: string[] = [];
    await runPostActivationAskHandoff({ projectRoot: "/a/very-long/saved/project-name/that-must-stay-on-the-same-build" }, {
      chooseRoute: async () => "later", env: {},
      stdout: { isTTY: true, columns, write: (value) => { output.push(String(value)); return true; } },
      stderr: { write: vi.fn(() => true) },
    });
    const text = output.join("");
    expect(text).toContain("Setup saved");
    for (const line of text.split("\n").filter(Boolean)) {
      expect(line.startsWith("  ")).toBe(true);
      expect(line.length).toBeLessThanOrEqual(columns - 2);
    }
  });

  it("returns from hidden credential entry to model selection", async () => {
    const routes: Array<PostActivationAskRoute | undefined> = ["later"];
    const output: string[] = [];
    const runAsk = vi.fn(async () => {
      throw new ProviderCredentialInputCancelledError();
    });
    await expect(runPostActivationAskHandoff(
      {
        projectRoot: "/tmp/reviewed-project",
        selection: { route: "openai", model: "gpt-5-mini" },
      },
      {
        chooseRoute: async () => routes.shift(),
        runAsk,
        stdout: { write: (value) => {
          output.push(String(value));
          return true;
        } },
        stderr: { write: vi.fn(() => true) },
      },
    )).resolves.toBe(0);
    expect(runAsk).toHaveBeenCalledOnce();
    expect(output.join("")).toContain("Provider credential entry cancelled");
    expect(output.join("")).toContain("Back at model selection");
    expect(output.join("")).toContain("no provider request was made");
  });

  it("supports an existing MCP client and a clean later exit without starting Ask", async () => {
    for (const route of ["mcp-client", "mcp-http", "later"] as PostActivationAskRoute[]) {
      const output: string[] = [];
      const runAsk = vi.fn(async () => 0);
      const runMcpInstall = vi.fn(async () => 0);
      await expect(runPostActivationAskHandoff(
        { projectRoot: "/tmp/reviewed-project" },
        {
          chooseRoute: async () => route,
          chooseMcpClient: async () => "claude-code",
          hasActiveActions: async () => true,
          runMcpInstall,
          runAsk,
          stdout: { write: (value) => {
            output.push(String(value));
            return true;
          } },
          stderr: { write: vi.fn(() => true) },
        },
      )).resolves.toBe(0);
      expect(runAsk).not.toHaveBeenCalled();
      if (route === "mcp-client") {
        expect(runMcpInstall).toHaveBeenCalledWith([
          "install", "claude-code",
          "--project", "--authoring",
          "--project-root", "/tmp/reviewed-project",
          "--include-actions",
        ]);
      } else {
        expect(runMcpInstall).not.toHaveBeenCalled();
      }
      expect(output.join("")).toMatch(
        route === "mcp-client"
          ? /Claude Code/
          : route === "mcp-http"
            ? /production HTTP/i
          : /boundaries remain active/i,
      );
    }
    expect(formatMcpClientHandoff("/tmp/reviewed-project", "claude-code", true))
      .toContain("Claude Code launches Runner");
    expect(formatMcpClientHandoff("/tmp/reviewed-project", "claude-code", true))
      .toContain("four fixed tools");
    expect(formatMcpClientHandoff("/tmp/reviewed-project", "claude-code", true))
      .toContain("Do not start a separate MCP server");
    const scopedHandoff = formatMcpClientHandoff(
      "/tmp/reviewed-project",
      "claude-code",
      true,
      [
        { role: "tenant", environment: "SYNAPSOR_TENANT_ID" },
        { role: "principal", environment: "SYNAPSOR_PRINCIPAL" },
      ],
    );
    expect(scopedHandoff).toContain("Local test identity still needed");
    expect(scopedHandoff).toContain("NOT READY FOR CUSTOMER USE");
    expect(scopedHandoff).toContain("Return to the local-test identity review");
    expect(scopedHandoff).not.toContain("export ");
    expect(scopedHandoff).toContain("four fixed tools");
    expect(scopedHandoff.split("\n").length).toBeLessThanOrEqual(10);
    expect(scopedHandoff).not.toContain("Connection diagnostics");
    expect(formatMcpClientHandoff(
      "/tmp/reviewed-project",
      "claude-code",
      true,
      [],
      "production_authentication",
    )).toContain("Production identity comes from the reviewed authenticated session");
    expect(formatMcpClientHandoff("/tmp/reviewed-project", "claude-code", false)).toContain("change requests remain refused");
    expect(formatHttpMcpHandoff("/tmp/reviewed-project"))
      .toContain("mcp serve --transport streamable-http --production-explore");
    expect(formatHttpMcpHandoff("/tmp/reviewed-project"))
      .toContain("Read-only endpoint: this transport does not yet serve Action requests or owner settings");
    expect(formatHttpMcpHandoff("/tmp/reviewed-project"))
      .toContain("mcp client-config --client claude-code --transport streamable-http");
    expect(formatHttpMcpHandoff("/tmp/reviewed-project"))
      .not.toMatch(/Bearer\s+[A-Za-z0-9_-]/u);
  });

  it("does not treat unset local bindings as missing production authentication", () => {
    const handoff = formatMcpClientHandoff("/tmp/test-project", "claude-code", true,
      [{ role: "tenant", environment: "TENANT_CONTEXT" }, { role: "principal", environment: "PERSON_CONTEXT" }],
      "production_authentication", []);
    expect(handoff).toContain("CUSTOMER USE NOT VERIFIED");
    expect(handoff).toContain("Production identity comes from the reviewed authenticated session");
    expect(handoff).toContain("Do not copy fixture values or accept identity from a client prompt or model");
    expect(handoff).not.toMatch(/NOT READY FOR CUSTOMER USE|Local test identity|export |TENANT_CONTEXT|PERSON_CONTEXT/);
  });

  it("does not ask to replace already configured local identity bindings", () => {
    const bindings = [{ role: "tenant" as const, environment: "TENANT_CONTEXT" },
      { role: "principal" as const, environment: "PERSON_CONTEXT" }];
    const partial = formatMcpClientHandoff("/tmp/test-project", "claude-code", true, bindings,
      "local_environment", ["TENANT_CONTEXT"]);
    expect(partial).not.toContain("export ");
    expect(partial).toContain("Local test identity still needed: PERSON_CONTEXT.");
    const ready = formatMcpClientHandoff("/tmp/test-project", "claude-code", true, bindings,
      "local_environment", ["TENANT_CONTEXT", "PERSON_CONTEXT"]);
    expect(ready).not.toContain("export ");
    expect(ready).toContain("reviewed local runtime environment");
    expect(ready).toContain("not authenticated or proven by the MCP handshake");
    expect(ready).toContain("CUSTOMER USE NOT VERIFIED");
    expect(ready).not.toContain("NOT READY FOR CUSTOMER USE");
  });

  it("labels a collected local identity as a persistent local test runtime and never renders its values", () => {
    const handoff = formatMcpClientHandoff("/tmp/test-project", "claude-code", true,
      [{ role: "tenant", environment: "TENANT_CONTEXT" }, { role: "principal", environment: "PERSON_CONTEXT" }],
      "local_environment", ["TENANT_CONTEXT", "PERSON_CONTEXT"], ["TENANT_CONTEXT", "PERSON_CONTEXT"]);
    expect(handoff).toContain("LOCAL TEST RUNTIME CONFIGURED");
    expect(handoff).toContain("owner-only local project runtime file");
    expect(handoff).toContain("managed client and reviewed worker load this fixed local reference");
    expect(handoff).toContain("programs running as your user can read these values");
    expect(handoff).not.toContain("export ");
  });

  it("requires an explicit local MCP client choice", async () => {
    const routes: Array<PostActivationAskRoute | undefined> = ["mcp-client", "later"];
    const chooseMcpClient = vi.fn(async () => undefined);
    await expect(choosePostActivationAskSelection({
      chooseRoute: async () => routes.shift(),
      chooseMcpClient,
    })).resolves.toEqual({ route: "later" });
    expect(chooseMcpClient).toHaveBeenCalledOnce();
  });

  it("reports Ask setup failure without claiming activation was rolled back", async () => {
    const errors: string[] = [];
    await expect(runPostActivationAskHandoff(
      { projectRoot: "/tmp/reviewed-project" },
      {
        chooseRoute: async () => "openai",
        promptWithDefault: async (_prompt, defaultValue) => defaultValue,
        runAsk: async () => {
          throw new Error("provider credential unavailable");
        },
        stdout: { write: vi.fn(() => true) },
        stderr: { write: (value) => {
          errors.push(String(value));
          return true;
        } },
      },
    )).resolves.toBe(1);

    expect(errors.join("")).toContain("Ask did not start: provider credential unavailable");
    expect(errors.join("")).toContain("The reviewed boundary is still active.");
    expect(errors.join("")).toContain(
      "try ask --project-root /tmp/reviewed-project --provider openai --model gpt-5.6-terra",
    );
  });

  it("returns a declined MCP install to connection choices without adding --yes", async () => {
    const routes: Array<PostActivationAskRoute | undefined> = ["mcp-client", "later"];
    const output: string[] = [];
    const errors: string[] = [];
    const install = vi.fn(async () => {
      throw new Error("confirmation declined");
    });

    await expect(runPostActivationAskHandoff(
      { projectRoot: "/tmp/reviewed-project" },
      {
        chooseRoute: async () => routes.shift(),
        chooseMcpClient: async () => "claude-code",
        hasActiveActions: async () => true,
        runMcpInstall: install,
        stdout: { write: (value) => {
          output.push(String(value));
          return true;
        } },
        stderr: { write: (value) => {
          errors.push(String(value));
          return true;
        } },
      },
    )).resolves.toBe(0);

    expect(install).toHaveBeenCalledOnce();
    expect(output.join("")).toContain("Back at connection choices");
    expect(output.join("")).toContain("reviewed boundaries remain active");
    expect(errors.join("")).not.toContain("--yes");
  });

  it("keeps MCP failure recovery reviewed and does not recommend --yes", async () => {
    const errors: string[] = [];
    await expect(runPostActivationAskHandoff(
      {
        projectRoot: "/tmp/reviewed-project",
        selection: { route: "mcp-client", client: "claude-code" },
      },
      {
        hasActiveActions: async () => true,
        runMcpInstall: async () => {
          throw new Error("project file is not writable");
        },
        stdout: { write: vi.fn(() => true) },
        stderr: { write: (value) => {
          errors.push(String(value));
          return true;
        } },
      },
    )).resolves.toBe(1);

    const error = errors.join("");
    expect(error).toContain("Retry after resolving the error:");
    expect(error).toContain("mcp install claude-code");
    expect(error).not.toContain("--yes");
    expect(error).toContain("shows the exact install preview again");
  });
});

async function mixedStateProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-mixed-handoff-"));
  const authority = { schema_version: "synapsor.exploration-boundary.v1", activation: "reviewed",
    deployment_profile: "staging", source: "local_postgres", compiler_version: "test", spec_version: "test",
    trusted_context: { provider: "environment", tenant_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL" },
    generation_lock_fingerprint: `sha256:${"a".repeat(64)}`, role_posture_fingerprint: `sha256:${"b".repeat(64)}`,
    pack: { name: "reviewed_university", resources: [] }, budgets: {} };
  const active = { ...authority, activation: { state: "active", digest: canonicalJsonDigest(authority), actor: "test",
    activated_at: "2026-09-08T19:00:00.000Z", generation_lock_fingerprint: authority.generation_lock_fingerprint, reviewed_decisions: [] } };
  await fs.mkdir(path.join(root, ".synapsor"));
  await fs.writeFile(path.join(root, ".synapsor/exploration-boundaries.active.json"), JSON.stringify({
    schema_version: "synapsor.active-exploration-boundaries.v1", selected_name: active.pack.name,
    boundaries: [active], updated_at: active.activation.activated_at,
  }));
  await fs.writeFile(path.join(root, "synapsor.actions.runner.json"), JSON.stringify({
    version: 1, mode: "read_only", capabilities: [], action_rules: { project_root: root },
    sources: { local_postgres: { engine: "postgres", read_url_env: "MIXED_TEST_READ_URL", read_only: true } },
    trusted_context: { provider: "environment" }, storage: { sqlite_path: "./.synapsor/local.db" },
  }));
  await fs.writeFile(path.join(root, ".synapsor/boundary-authoring-resume.json"), JSON.stringify({
    saved_job: "Investigate course availability, then request registration under the reviewed credit policy.",
  }));
  return root;
}
