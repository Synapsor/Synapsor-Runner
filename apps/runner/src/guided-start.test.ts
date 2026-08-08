import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { buildAutoBoundary } from "./auto-boundary.js";
import { start } from "./guided-start.js";
import {
  activateInstantCliBoundary,
  type InstantCliBoundaryActivationResult,
} from "./instant-cli-boundary.js";

const suiteCwd = process.cwd();

describe("guided start surfaces", () => {
  afterEach(() => {
    process.chdir(suiteCwd);
    vi.restoreAllMocks();
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
        ["--from-env", "DATABASE_URL", "--cli", "--timeout", "180"],
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
      await expect(fs.access(
        path.join(projectRoot, "synapsor/generated/exploration-boundary.draft.json"),
      )).resolves.toBeUndefined();
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
      await fs.writeFile(
        path.join(projectRoot, ".synapsor/exploration-boundary.active.json"),
        "{}\n",
        "utf8",
      );
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

      const draft = JSON.parse(await fs.readFile(
        path.join(projectRoot, "synapsor/generated/exploration-boundary.draft.json"),
        "utf8",
      )) as {
        organization_scope?: { organization_id: string };
        pack: { resources: Array<{ tenant_key?: string; tenant_scope?: unknown }> };
      };
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
      await expect(start(
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
      await expect(start(
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
      );
      expect(output).toContain(
        "Opening the focused access editor with this connected boundary as the baseline.",
      );
      const progress = JSON.parse(await fs.readFile(
        path.join(projectRoot, ".synapsor/boundary-review-progress.json"),
        "utf8",
      )) as {
        candidate: { pack: { resources: Array<{ id: string }> } };
        confirmed_decisions: string[];
      };
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
      expect(output).toContain("Runner prepared one conservative, connected boundary");
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

      const active = JSON.parse(await fs.readFile(
        path.join(projectRoot, ".synapsor/exploration-boundary.active.json"),
        "utf8",
      )) as {
        deployment_profile: string;
        pack: { resources: unknown[] };
        activation: {
          mode: string;
          confirmation_gesture: string;
          reviewed_decisions: Array<{ confirmed: boolean }>;
        };
      };
      expect(active.deployment_profile).toBe("development");
      expect(active.pack.resources).toHaveLength(1);
      expect(active.activation.mode).toBe("instant_development");
      expect(active.activation.confirmation_gesture).toBe("activate_for_model");
      expect(active.activation.reviewed_decisions.length).toBeGreaterThan(0);
      expect(active.activation.reviewed_decisions.every((item) => item.confirmed)).toBe(true);
      const progress = JSON.parse(await fs.readFile(
        path.join(projectRoot, ".synapsor/boundary-review-progress.json"),
        "utf8",
      )) as {
        candidate: { pack: { resources: Array<{ id: string }> } };
        confirmed_decisions: string[];
        confirmations: unknown[];
      };
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
      const activePath = path.join(projectRoot, ".synapsor/exploration-boundary.active.json");
      const activeExists = await fs.access(activePath).then(() => true, () => false);
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
      await expect(start(
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

      const active = JSON.parse(await fs.readFile(
        path.join(projectRoot, ".synapsor/exploration-boundary.active.json"),
        "utf8",
      )) as { role_posture_fingerprint: string; activation: { mode: string } };
      const lock = JSON.parse(await fs.readFile(
        path.join(projectRoot, ".synapsor/generation-lock.json"),
        "utf8",
      )) as { role_posture_fingerprint: string };
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
    process.chdir(projectRoot);

    try {
      await expect(start(
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
              promptText: async () => actions.shift() ?? "",
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
          runInstantCliBoundary: (input) => activateInstantCliBoundary({
            ...input,
            env: {
              ...process.env,
              SYNAPSOR_TENANT_ID: "tenant-1",
              USER: "developer@example.test",
            },
            session: { promptText: async () => actions.shift() ?? "" },
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
      await expect(start(
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
    process.chdir(projectRoot);

    try {
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
        session: { promptText: async () => "e" },
      });

      expect(result).toEqual({
        accepted: false,
        reason: "operator_requested_detailed_review",
      });
      const output = chunks.join("");
      expect(output).toContain("\u001b[1;36mYOUR FIRST SAFE QUESTION\u001b[0m");
      expect(output).toContain("\u001b[1mService Visits\u001b[0m");
      expect(output).toContain("\u001b[1;32m3 fields across 1 table\u001b[0m");
      expect(output).toContain("\u001b[2m1 field\u001b[0m");
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
          interactive: true,
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
