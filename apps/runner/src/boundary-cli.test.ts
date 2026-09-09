import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as boundaryReviewMutations from "./boundary-review-mutation.js";
import { actionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import { loadPolicySources, activePolicySource } from "./authoring-policy-source.js";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { loadRuntimeConfigFromFile } from "@synapsor-runner/mcp-server";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import {
  AUTO_BOUNDARY_OVERRIDES_VERSION,
  CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION,
  activateExplorationBoundary,
  buildAutoBoundary,
  explorationBoundaryCandidateDigest,
  loadActivatedExplorationBoundaries,
  reviewExplorationBoundaryCandidate,
  writeAutoBoundaryArtifacts,
} from "./auto-boundary.js";
import {
  boundaryActivateCommand,
  boundaryReviewCommand,
  main,
} from "./cli.js";
import {
  boundaryAssistCommand,
  actionBoundaryHasDeterministicPolicy,
  boundaryActivateCommand as boundaryActivateCommandInternal,
  boundaryReviewCommand as boundaryReviewCommandInternal,
  formatBoundaryChatReviewSummary,
  formatCurrentBoundaryAuthoritySummary,
  formatFocusedBoundaryActivationReview,
  formatReadActivationBusinessSummary,
  loadBoundaryReviewContext,
  promptBoundaryMappingModel,
} from "./boundary-commands.js";
import {
  createSavedBoundary,
  renameSavedBoundary,
  switchSavedBoundary,
  synchronizeBoundaryLibrary,
} from "./boundary-library.js";
import type {
  BoundaryAccessNotice,
  BoundaryFieldTier,
  BoundaryReviewInteractiveSession,
} from "./boundary-cli-picker.js";
import {
  createBoundaryReviewProgress,
} from "./boundary-review-domain.js";
import {
  readBoundaryReviewProgress,
  saveBoundaryReviewProgress,
} from "./boundary-review-persistence.js";
import {
  commitBoundaryResourceReviewMutation,
  inspectBoundaryResourceReview,
  listBoundaryResourceReviews,
  prepareBoundaryReviewMutationBatch,
  prepareBoundaryResourceReviewMutation,
  reviewedBoundaryOperationRepairFields,
} from "./boundary-review-mutation.js";
import {
  analyzeReadWorkloadSet,
  buildReadWorkloadPlanCards,
  normalizeReadWorkloadSet,
  readWorkloadFromPlanCards,
  READ_WORKLOAD_SET_VERSION,
} from "./read-workload-assist.js";
import { generateModelReadWorkload } from "./read-workload-model.js";
import { ReadWorkloadDraftError } from "./read-workload-diagnostics.js";
import { generateModelReadBoundaryRevision } from "./read-boundary-revision-model.js";
import { AskError } from "./model-ask.js";
import {
  generateModelActionSuggestionSet,
} from "./action-suggestion-model.js";
import { compileActionRuleModelDraft, type ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { readActionRuleAuthorityDraft } from "./action-rule-authority.js";
import {
  generateModelActionRuleDraft,
  ActionAuthoringReadOnlyRequest,
  type ModelActionRuleDraftResult,
} from "./action-rule-model.js";
import {
  createBoundaryAuthoringChat,
  type BoundaryAuthoringChat,
  type BoundaryAuthoringPermissionGuide,
} from "./boundary-authoring-chat.js";
import { narrateValidatedAuthoringStep } from "./model-authoring-narration.js";
import { ACTION_SUGGESTION_VERSION, assessActionSuggestion } from "./action-design.js";
import {
  commitReadWorkloadCandidate,
  prepareReadWorkloadCandidate,
} from "./read-workload-authoring.js";
import {
  listReadWorkloadAnalyses,
  readReadWorkloadAnalysis,
  storeReadWorkloadAnalysis,
} from "./read-workloads.js";
import { readDelegationDraft } from "./delegation-setup.js";
import { readBoundaryAuthoringResumeState, buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { loadCompletedBoundaryReviewOverrides } from "./boundary-review-policy.js";
import { boundaryCommand } from "./guided-start.js";
import { initializeGuidedProject, readGuidedOnboardingState } from "./guided-project.js";
import {
  compileExplorePlan,
  prepareScopedExplore,
  validateExploreRequest,
} from "./scoped-explore.js";
import { selectActiveExploreBoundary } from "./scoped-explore-boundary-set.js";
import { inspectProductionExploreStartup } from "./mcp-runtime.js";
import { askIntentCheckModeForBoundary } from "./ask-intent-preferences.js";
import { runActionControlPlane } from "./action-tui.js";
import {
  activateGuidedAction,
  createGuidedActionDraft,
  guidedActionStatus,
  recordGuidedActionPreview,
  type GuidedActionInput,
} from "./guided-action.js";

describe("boundary operator-plane CLI", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("summarizes reused Read and Action authority instead of echoing the model request", () => {
    const summary = formatCurrentBoundaryAuthoritySummary({
      read: {
        boundary_name: "reviewed_staging",
        authority: "active_with_disabled_changes",
        fully_reviewed: true,
        resource_ids: ["telecom.accounts", "telecom.billing_preferences"],
        exact_reusable_revision_count: 1,
      },
      actions: [{
        capability: "billing_preference.propose_update",
        operation: "update",
        resource: "telecom.billing_preferences",
        authority: "active",
      }],
      control_plane: {
        trusted_scope: "runner_injected",
        approval_history: "runner_proposal_ledger",
        model_may_supply_scope_values: false,
        model_may_supply_approval_history: false,
      },
    }).join("\n");

    expect(summary).toContain("reviewed_staging");
    expect(summary).toContain("ACTIVE + DRAFT");
    expect(summary).toContain("billing_preference.propose_update");
    expect(summary).toContain("Propose UPDATE");
    expect(summary).toContain("telecom.accounts, telecom.billing_preferences");
    expect(summary).toContain("source database changed: no");
  });

  it("preserves a disabled deterministic policy in setup status", () => {
    const boundary = {
      authority: {
        approval_policies: [{
          capability: "billing_preference.propose_update",
          mode: "policy",
        }],
      },
    };

    expect(actionBoundaryHasDeterministicPolicy(
      boundary,
      new Set(["billing_preference.propose_update"]),
    )).toBe(true);
    expect(actionBoundaryHasDeterministicPolicy(
      boundary,
      new Set(["support_case.propose_insert"]),
    )).toBe(false);
  });

  it("detects an installed loopback model during first-run boundary drafting", async () => {
    const prompts: Array<{ label: string; context: string[] }> = [];
    const answers = ["3", "", ""];
    await expect(promptBoundaryMappingModel({
      promptText: async (label, options) => {
        prompts.push({ label, context: options?.context ?? [] });
        return answers.shift();
      },
    }, undefined, {
      discoverModels: async (baseUrl) => {
        expect(baseUrl).toBe("http://127.0.0.1:11434/v1");
        return ["qwen2.5:7b"];
      },
    })).resolves.toEqual({
      provider: "openai_compatible",
      model: "qwen2.5:7b",
      baseUrl: "http://127.0.0.1:11434/v1",
    });

    expect(prompts.map(({ label }) => label)).toEqual([
      "Provider (1-3)",
      "Local model endpoint [http://127.0.0.1:11434/v1]",
      "Exact model ID [qwen2.5:7b]",
    ]);
    expect(prompts[2]?.context).toContain("ADVANCED MODEL ID");
  });

  it("selects a detected loopback model from the TUI without endpoint or model text prompts", async () => {
    const choices: Array<{ title: string; values: string[]; initial?: string; explicit?: boolean }> = [];
    await expect(promptBoundaryMappingModel({
      chooseOption: async (title, options, promptOptions) => {
        choices.push({
          title,
          values: options.map((option) => option.value),
          ...(promptOptions?.initialValue ? { initial: promptOptions.initialValue } : {}),
          ...(promptOptions?.requireExplicitSelection ? { explicit: true } : {}),
        });
        return title === "CHOOSE A MODEL FOR BOUNDARY DRAFTING"
          ? "detected_local"
          : "qwen2.5:7b";
      },
      promptText: async () => {
        throw new Error("A detected local model should not require text setup.");
      },
    }, undefined, {
      discoverModels: async () => ["qwen2.5:7b"],
      env: {},
    })).resolves.toEqual({
      provider: "openai_compatible",
      model: "qwen2.5:7b",
      baseUrl: "http://127.0.0.1:11434/v1",
    });
    expect(choices).toEqual([
      {
        title: "CHOOSE A MODEL FOR BOUNDARY DRAFTING",
        values: ["detected_local", "openai", "anthropic", "openai_compatible"],
        explicit: true,
      },
      {
        title: "MODEL FOR BOUNDARY DRAFTING",
        values: ["qwen2.5:7b", "__exact_model_id__"],
        initial: "qwen2.5:7b",
      },
    ]);
  });

  it("does not infer a drafting provider from ready credentials or a detected local model", async () => {
    const prompts: Array<{ title: string; explicit?: boolean; labels: string[] }> = [];
    await expect(promptBoundaryMappingModel({
      chooseOption: async (title, options, promptOptions) => {
        prompts.push({
          title,
          labels: options.map((option) => option.label),
          ...(promptOptions?.requireExplicitSelection ? { explicit: true } : {}),
        });
        return undefined;
      },
      promptText: async () => {
        throw new Error("Canceling explicit provider selection must not open provider setup.");
      },
    }, undefined, {
      discoverModels: async () => ["qwen2.5:7b"],
      env: {
        OPENAI_API_KEY: "session-openai-key",
        ANTHROPIC_API_KEY: "session-anthropic-key",
      },
    })).resolves.toBeUndefined();
    expect(prompts).toEqual([{
      title: "CHOOSE A MODEL FOR BOUNDARY DRAFTING",
      explicit: true,
      labels: [
        "Local Ollama qwen2.5:7b  [detected]",
        "OpenAI  [ready]",
        "Anthropic  [ready]",
        "Another local OpenAI-compatible endpoint",
      ],
    }]);
  });

  it("lists compatible hosted models in an Up/Down picker after the credential source is chosen", async () => {
    const titles: string[] = [];
    await expect(promptBoundaryMappingModel({
      chooseOption: async (title) => {
        titles.push(title);
        return title === "CHOOSE A MODEL FOR BOUNDARY DRAFTING"
          ? "openai"
          : "gpt-5.6-terra";
      },
      promptText: async (label) => {
        expect(label).toBe("API key environment variable [OPENAI_API_KEY]");
        return "";
      },
    }, undefined, {
      discoverModels: async () => [],
      discoverHostedModels: async ({ provider, apiKey }) => {
        expect(provider).toBe("openai");
        expect(apiKey).toBe("session-openai-key");
        return ["gpt-5.6-terra", "gpt-5.6-luna"];
      },
      env: { OPENAI_API_KEY: "session-openai-key" },
    })).resolves.toEqual({
      provider: "openai",
      model: "gpt-5.6-terra",
      apiKeyEnv: "OPENAI_API_KEY",
    });
    expect(titles).toEqual([
      "CHOOSE A MODEL FOR BOUNDARY DRAFTING",
      "MODEL FOR BOUNDARY DRAFTING",
    ]);
  });

  it("requires an explicit choice before reusing the configured OpenAI drafting model", async () => {
    const choices: Array<{ title: string; values: string[]; initial?: string; explicit?: boolean; labels: string[] }> = [];
    const current = {
      provider: "openai" as const,
      model: "gpt-5.6-luna",
      apiKey: "session-secret",
    };
    await expect(promptBoundaryMappingModel({
      chooseOption: async (title, options, promptOptions) => {
        choices.push({
          title,
          values: options.map((option) => option.value),
          labels: options.map((option) => option.label),
          ...(promptOptions?.initialValue ? { initial: promptOptions.initialValue } : {}),
          ...(promptOptions?.requireExplicitSelection ? { explicit: true } : {}),
        });
        return "current";
      },
      promptText: async () => {
        throw new Error("Keeping the default model should not open a text prompt.");
      },
    }, current)).resolves.toEqual(current);
    expect(choices).toEqual([{
      title: "MODEL FOR BOUNDARY DRAFTING",
      values: ["current", "change_model", "change_provider"],
      labels: [
        "Use openai[gpt-5.6-luna]",
        "Change the model for openai",
        "Choose another provider",
      ],
      initial: "current",
      explicit: true,
    }]);
  });

  it("changes the OpenAI drafting model without replacing its in-memory credential", async () => {
    const current = {
      provider: "openai" as const,
      model: "gpt-5.6-luna",
      apiKey: "session-secret",
    };
    await expect(promptBoundaryMappingModel({
      chooseOption: async (title) => title === "MODEL FOR BOUNDARY DRAFTING"
        ? undefined
        : "change_model",
      promptText: async () => {
        throw new Error("Discovered hosted models should use the picker.");
      },
    }, current, {
      discoverHostedModels: async () => ["gpt-4.1"],
    })).resolves.toBeUndefined();

    let step = 0;
    await expect(promptBoundaryMappingModel({
      chooseOption: async () => {
        step += 1;
        return step === 1 ? "change_model" : "gpt-4.1";
      },
      promptText: async () => {
        throw new Error("Discovered hosted models should use the picker.");
      },
    }, current, {
      discoverHostedModels: async ({ apiKey }) => {
        expect(apiKey).toBe("session-secret");
        return ["gpt-4.1"];
      },
    })).resolves.toEqual({
      provider: "openai",
      model: "gpt-4.1",
      apiKey: "session-secret",
    });
  });

  it("switches a configured hosted drafting model to a detected local provider", async () => {
    const current = {
      provider: "openai" as const,
      model: "gpt-5.6-luna",
      apiKey: "session-secret",
    };
    const titles: string[] = [];
    await expect(promptBoundaryMappingModel({
      chooseOption: async (title) => {
        titles.push(title);
        if (titles.length === 1) return "change_provider";
        if (title === "CHOOSE A MODEL FOR BOUNDARY DRAFTING") return "detected_local";
        return "qwen2.5:7b";
      },
      promptText: async () => {
        throw new Error("A detected replacement provider should not require text setup.");
      },
    }, current, {
      discoverModels: async () => ["qwen2.5:7b"],
      env: {},
    })).resolves.toEqual({
      provider: "openai_compatible",
      model: "qwen2.5:7b",
      baseUrl: "http://127.0.0.1:11434/v1",
    });
    expect(titles).toEqual([
      "MODEL FOR BOUNDARY DRAFTING",
      "CHOOSE A MODEL FOR BOUNDARY DRAFTING",
      "MODEL FOR BOUNDARY DRAFTING",
    ]);
  });

  it("exports an exact review bundle and requires a replay-safe signed decision for headless activation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-cli-"));
    const inspection = boundaryInspection();
    const project = {
      root,
      package_manager: "npm" as const,
      frameworks: ["node"],
      schema_inputs: [],
      database_env_names: ["DATABASE_URL"],
    };
    const build = buildAutoBoundary({
      inspection,
      project,
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const guided = await initializeGuidedProject({
        projectRoot: root,
        build,
        runnerVersion: "1.6.4",
      });
      const progress = createBoundaryReviewProgress({
        draft: build.exploration_boundary,
        candidate: build.exploration_boundary,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        actor: "alice",
        revision: 1,
        now: "2026-07-25T12:00:00.000Z",
      });
      await saveBoundaryReviewProgress(root, progress);

      const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const configDir = path.dirname(guided.config_path);
      const publicPath = path.join(configDir, "operator.pub.pem");
      const privatePath = path.join(root, "operator.private.pem");
      await fs.writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }).toString(), "utf8");
      await fs.writeFile(
        privatePath,
        privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        { encoding: "utf8", mode: 0o600 },
      );
      const config = JSON.parse(await fs.readFile(guided.config_path, "utf8"));
      config.operator_identity = {
        provider: "signed_key",
        operators: {
          alice: {
            public_key_path: "./operator.pub.pem",
            roles: ["boundary_reviewer"],
          },
        },
      };
      await fs.writeFile(guided.config_path, `${JSON.stringify(config, null, 2)}\n`, "utf8");

      const bundlePath = path.join(root, "boundary-review.json");
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await expect(boundaryReviewCommand([
        "--project-root", root,
        "--output", bundlePath,
      ])).resolves.toBe(0);
      const bundle = JSON.parse(await fs.readFile(bundlePath, "utf8"));
      expect(bundle).toMatchObject({
        schema_version: "synapsor.boundary-review-bundle.v1",
        candidate_digest: explorationBoundaryCandidateDigest(build.exploration_boundary),
        outstanding_decision_ids: [],
      });
      expect(bundle.decisions.every((decision: { confirmed: boolean }) => decision.confirmed)).toBe(true);

      const fixedNow = new Date("2026-07-25T12:05:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);
      const digest = bundle.candidate_digest as string;
      const activationArgs = [
        "--project-root", root,
        "--config", guided.config_path,
        "--review-bundle", bundlePath,
        "--headless",
        "--confirm", `ACTIVATE ${digest}`,
        "--identity", "alice",
        "--identity-key", privatePath,
        "--required-role", "boundary_reviewer",
        "--reason", "Reviewed exact staging exploration authority.",
        "--environment", "staging",
        "--nonce", "fixed-review-nonce-0001",
        "--expires-at", "2026-07-25T12:10:00.000Z",
        "--json",
      ];

      const unsafeInspection = structuredClone(inspection);
      unsafeInspection.current_user = "postgres";
      unsafeInspection.role_posture = {
        verified: true,
        superuser: true,
        bypass_rls: true,
        read_only: false,
        writable_relations: ["public.service_visits"],
        owned_relations: ["public.service_visits"],
        reasons: [],
      };
      await expect(boundaryActivateCommand(
        activationArgs,
        async () => unsafeInspection,
      )).rejects.toMatchObject({
        code: "DATABASE_ROLE_UNSAFE",
        message: expect.stringMatching(/PostgreSQL superuser[\s\S]*BYPASSRLS[\s\S]*not activated/is),
      });
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });

      await expect(boundaryActivateCommand(
        [...activationArgs.slice(0, activationArgs.indexOf("--required-role") + 1), "finance_reviewer", ...activationArgs.slice(activationArgs.indexOf("--required-role") + 2)],
        async () => inspection,
      )).rejects.toThrow(/lacks required role finance_reviewer/i);
      await expect(boundaryActivateCommand(activationArgs, async () => inspection)).resolves.toBe(0);
      const active = JSON.parse(
        await fs.readFile(path.join(root, ".synapsor/exploration-boundary.active.json"), "utf8"),
      );
      expect(active).toMatchObject({
        activation: {
          state: "active",
          digest,
          actor: "alice",
        },
      });
      await expect(readGuidedOnboardingState(root)).resolves.toMatchObject({
        status: "boundary_active",
        authority_active: true,
        recommended_next_action: expect.stringMatching(/model or MCP client/i),
      });
      stdout.mockClear();
      await expect(boundaryCommand([
        "status",
        "--project-root", root,
        "--json",
      ])).resolves.toBe(0);
      const status = JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join(""));
      expect(status).toMatchObject({
        ok: true,
        project: root,
        database_source: {
          engine: "postgres",
          environment_reference: "DATABASE_URL",
          connection_value_returned: false,
        },
        config: { state: "valid" },
        activation: "active",
        candidate_boundary_name: build.exploration_boundary.pack.name,
        candidate_tables: ["public.service_visits"],
        active_boundary_name: build.exploration_boundary.pack.name,
        active_tables: ["public.service_visits"],
        outstanding_decision_ids: [],
        explore_budget_state: {
          queries_used: 0,
          queries_limit: 1000,
          extracted_cells_used: 0,
          extracted_cells_limit: 4000,
          state_persists_across_tabs_processes_and_provider_sessions: true,
        },
        recent_analysis_references: [],
        source_database_changed: false,
      });
      expect(status.active_named_tools).toEqual([]);
      expect(status.production_readiness).toMatchObject({
        ready: false,
        blockers: [expect.stringMatching(/no activated named capability/i)],
      });
      expect(status.next_action).toMatch(/first bounded question/i);
      await expect(boundaryActivateCommand(activationArgs, async () => inspection))
        .rejects.toThrow(/already consumed/i);

      const store = new ProposalStore(guided.store_path);
      try {
        expect(store.listAttentionEvents({ limit: 20 })).toEqual(expect.arrayContaining([
          expect.objectContaining({
            event_type: "capability.activated",
            contract_digest: digest,
          }),
        ]));
      } finally {
        store.close();
      }

      const tampered = { ...bundle, candidate_digest: `sha256:${"0".repeat(64)}` };
      const tamperedPath = path.join(root, "tampered-review.json");
      await fs.writeFile(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
      await expect(boundaryActivateCommand([
        ...activationArgs.slice(0, activationArgs.indexOf("--review-bundle") + 1),
        tamperedPath,
        ...activationArgs.slice(activationArgs.indexOf("--review-bundle") + 2),
      ], async () => inspection)).rejects.toThrow(/digest does not match/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("resolves a blocked tenant scope through the CLI without activating authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-cli-resource-"));
    const inspection = boundaryInspection();
    const table = inspection.tables[0]!;
    table.row_level_security = false;
    table.row_level_security_policies = [];
    table.role_posture!.row_security_effective_for_current_role = false;
    table.suggestions.tenant_columns = [];
    const project = {
      root,
      package_manager: "npm" as const,
      frameworks: ["node"],
      schema_inputs: [],
      database_env_names: ["DATABASE_URL"],
    };
    const build = buildAutoBoundary({
      inspection,
      project,
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    expect(build.exploration_boundary.pack.resources).toEqual([]);
    expect(build.review.resources[0]).toMatchObject({
      id: "public.service_visits",
      status: "blocked_scope",
      tenant_key: {
        candidates: ["tenant_id"],
      },
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const guided = await initializeGuidedProject({
        projectRoot: root,
        build,
        runnerVersion: "1.6.5",
      });
      const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const publicPath = path.join(path.dirname(guided.config_path), "reviewer.pub.pem");
      const privatePath = path.join(root, "reviewer.private.pem");
      await fs.writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }).toString(), "utf8");
      await fs.writeFile(
        privatePath,
        privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        { encoding: "utf8", mode: 0o600 },
      );
      const config = JSON.parse(await fs.readFile(guided.config_path, "utf8"));
      config.operator_identity = {
        provider: "signed_key",
        operators: {
          alice: {
            public_key_path: "./reviewer.pub.pem",
            roles: ["boundary_reviewer"],
          },
        },
      };
      await fs.writeFile(guided.config_path, `${JSON.stringify(config, null, 2)}\n`, "utf8");

      let output = "";
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });
      await expect(boundaryReviewCommand([
        "resource",
        "public.service_visits",
        "--project-root", root,
        "--json",
      ], async () => inspection)).resolves.toBe(0);
      expect(JSON.parse(output)).toMatchObject({
        status: "blocked_scope",
        included: false,
        tenant_key: { candidates: ["tenant_id"] },
        source_database_changed: false,
      });

      output = "";
      const mutationArgs = [
        "resource",
        "public.service_visits",
        "--project-root", root,
        "--include",
        "--tenant-key", "tenant_id",
        "--no-principal",
        "--visible-fields", "id,status,scheduled_at",
        "--withhold-from-model", "status",
        "--label", "Service visits",
        "--description", "Reviewed customer service appointments.",
        "--field-label", "status=Visit state",
        "--field-description", "status=Reviewed appointment lifecycle state.",
        "--max-ranked-groups", "200",
        "--max-rows", "75",
        "--max-groups", "200",
        "--max-top-n", "50",
        "--max-response-cells", "1000",
        "--max-response-bytes", "131072",
        "--statement-timeout-ms", "5000",
        "--max-measures", "4",
        "--max-dimensions", "4",
        "--max-derived-scope-hops", "3",
        "--max-analysis-relationship-hops", "3",
        "--max-queries-per-24-hours", "800",
        "--requests-per-minute", "90",
        "--actor", "alice",
        "--reason", "Service visits are isolated by the reviewed tenant column.",
        "--json",
      ];
      const excessiveAnalysisDepth = mutationArgs.map((value, index) =>
        mutationArgs[index - 1] === "--max-analysis-relationship-hops" ? "4" : value);
      await expect(boundaryReviewCommand(
        excessiveAnalysisDepth,
        async () => inspection,
      )).rejects.toThrow(/--max-analysis-relationship-hops must be an integer from 1 through 3/i);
      await expect(boundaryReviewCommand(mutationArgs, async () => inspection)).resolves.toBe(0);
      const preview = JSON.parse(output);
      expect(preview).toMatchObject({
        ok: true,
        semantic_diff: {
          resource_id: "public.service_visits",
          before_included: false,
          after_included: true,
          selected_tenant_key: "tenant_id",
          max_ranked_groups_before: 500,
          max_ranked_groups_after: 200,
          max_queries_per_session_before: 1000,
          max_queries_per_session_after: 800,
          rate_limit_per_minute_before: 120,
          rate_limit_per_minute_after: 90,
          reviewed_budget_changes: expect.arrayContaining([
            { name: "max_rows", before: 50, after: 75 },
            { name: "max_groups", before: 50, after: 200 },
            { name: "max_top_n", before: 25, after: 50 },
            { name: "statement_timeout_ms", before: 3000, after: 5000 },
            { name: "max_derived_scope_hops", before: 2, after: 3 },
            { name: "max_analysis_relationship_hops", before: 2, after: 3 },
          ]),
        },
        authority_activated: false,
        source_database_changed: false,
      });
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });

      output = "";
      await expect(boundaryReviewCommand([
        ...mutationArgs,
        "--apply",
        "--confirm", `APPLY REVIEW ${preview.decision_digest}`,
        "--config", guided.config_path,
        "--identity", "alice",
        "--identity-key", privatePath,
        "--required-role", "boundary_reviewer",
        "--nonce", "resource-review-nonce-0001",
      ], async () => inspection)).resolves.toBe(0);
      const applied = JSON.parse(output);
      expect(applied).toMatchObject({
        ok: true,
        decision_digest: preview.decision_digest,
        review_revision: 1,
        source_database_changed: false,
      });
      const regenerated = JSON.parse(await fs.readFile(
        path.join(root, "synapsor/generated/exploration-boundary.draft.json"),
        "utf8",
      ));
      expect(regenerated.pack.resources).toEqual([
        expect.objectContaining({
          id: "public.service_visits",
          label: "Service visits",
          description: "Reviewed customer service appointments.",
          field_metadata: {
            status: {
              label: "Visit state",
              description: "Reviewed appointment lifecycle state.",
            },
          },
          tenant_key: "tenant_id",
        }),
      ]);
      const progress = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(progress).toMatchObject({
        revision: 1,
        candidate: {
          budgets: {
            max_queries_per_session: 800,
            rate_limit_per_minute: 90,
            max_extracted_cells_per_session: 4000,
            max_differencing_queries: 16,
          },
          pack: {
            resources: [{
              id: "public.service_visits",
              label: "Service visits",
              description: "Reviewed customer service appointments.",
              field_metadata: {
                status: {
                  label: "Visit state",
                  description: "Reviewed appointment lifecycle state.",
                },
              },
              selectable_fields: ["id", "status", "scheduled_at"],
              model_withheld_fields: ["status"],
            }],
          },
        },
      });
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("previews an explicit owner cohort override with its threshold-one consequence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-cli-cohort-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommand([
        "resource",
        "public.service_visits",
        "--project-root", root,
        "--minimum-cohort", "0",
        "--actor", "owner@example.test",
        "--reason", "Invalid lower bound.",
      ], async () => inspection)).rejects.toThrow(/integer from 1 through 5/i);

      let output = "";
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });
      await expect(boundaryReviewCommand([
        "resource",
        "public.service_visits",
        "--project-root", root,
        "--minimum-cohort", "1",
        "--actor", "owner@example.test",
        "--reason", "This owner-controlled staging analysis may return groups of one.",
      ], async () => inspection)).resolves.toBe(0);
      expect(output).toContain("Minimum group size: 5 -> 1 (explicit owner override)");
      expect(output).toContain(
        "Warning: 1 disables small-group suppression; groups of one identify individuals.",
      );
      expect(output).toContain("Authority activated: no");

      const persisted = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/review-overrides.json"),
        "utf8",
      ));
      expect(persisted.resources["public.service_visits"]).toBeUndefined();
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("keeps the boundary draft front door in the CLI register and offers Workbench second", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-draft-front-door-"));
    const inspection = boundaryInspection();
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await expect(main([
        "boundary",
        "draft",
        "--from-env", "DATABASE_URL",
        "--project-root", root,
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      expect(output).toContain("State: disabled draft. Active Runner tools are unchanged.");
      expect(output).toContain(
        "Prepared the local Runner config, ledger, and MCP snippets automatically.",
      );
      expect(output).toContain("Next: review it in this terminal:");
      expect(output).toContain(`synapsor-runner boundary review --project-root '${root}'`);
      expect(output).toContain("Visual alternative:");
      expect(output).toContain(
        `synapsor-runner ui --boundary-root '${path.join(root, "synapsor/generated")}' ` +
        `--config '${path.join(root, "synapsor.runner.json")}' ` +
        `--store '${path.join(root, ".synapsor/local.db")}' --open`,
      );
      await expect(fs.access(path.join(root, "synapsor.runner.json"))).resolves.toBeUndefined();
      await expect(fs.access(path.join(root, ".synapsor/local.db"))).resolves.toBeUndefined();
      await expect(fs.access(path.join(root, ".synapsor/guided-onboarding.json")))
        .resolves.toBeUndefined();
      expect(output).not.toContain(
        "Review it in the local Workbench; active Runner tools are unchanged.",
      );

      output = "";
      await expect(main([
        "boundary",
        "draft",
        "--from-env", "DATABASE_URL",
        "--project-root", root,
        "--force",
        "--json",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      expect(JSON.parse(output)).toMatchObject({
        ok: true,
        reconciled: true,
        destructive_regeneration: false,
        report: {
          changed: false,
          source_database_changed: false,
        },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("points a production boundary draft directly to the secured runtime config generator", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-production-boundary-config-handoff-"));
    const inspection = boundaryInspection();
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await expect(main([
        "boundary",
        "draft",
        "--from-env", "DATABASE_URL",
        "--project-root", root,
        "--profile", "production",
        "--tenant-claim", "tenant_id",
        "--principal-claim", "sub",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);

      expect(output).toContain("Then generate the secured production runtime config:");
      expect(output).toContain("synapsor-runner config init --production-explore");
      expect(output).toContain("--engine postgres");
      expect(output).toContain(`--project-root '${root}'`);
      expect(output).toContain("--issuer https://identity.example");
      expect(output).toContain("--audience https://runner.example/mcp");
      expect(output).toContain("--accounting-namespace your_org.analytics.production");
      expect(output).toContain("reuses the reviewed source and JWT claim names");
      await expect(fs.access(path.join(root, "synapsor.runner.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("drafts explicit single-organization Explore without adding fake tenant columns", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-single-org-boundary-cli-"));
    const inspection = structuredClone(boundaryInspection());
    for (const table of inspection.tables) {
      const tenantFields = new Set(table.suggestions.tenant_columns);
      table.columns = table.columns.filter((column) => !tenantFields.has(column.name));
      table.suggestions.tenant_columns = [];
      table.suggestions.default_visible_columns = table.suggestions.default_visible_columns
        .filter((field) => !tenantFields.has(field));
      table.row_level_security = false;
      table.row_level_security_policies = [];
      if (table.role_posture) table.role_posture.row_security_effective_for_current_role = false;
    }
    try {
      await expect(main([
        "boundary",
        "draft",
        "--from-env", "DATABASE_URL",
        "--project-root", root,
        "--single-tenant",
        "--organization-id", "internal-finance",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      const draft = JSON.parse(await fs.readFile(
        path.join(root, "synapsor/generated/exploration-boundary.draft.json"),
        "utf8",
      ));
      expect(draft.organization_scope).toEqual({
        mode: "single_organization",
        organization_id: "internal-finance",
        acknowledgement: "all_rows_belong_to_one_organization",
      });
      expect(draft.pack.resources.length).toBeGreaterThan(0);
      expect(draft.pack.resources.every((resource: Record<string, unknown>) =>
        resource.tenant_key === undefined && resource.tenant_scope === undefined)).toBe(true);
      const reviews = await listBoundaryResourceReviews(root);
      expect(reviews.length).toBeGreaterThan(0);
      expect(reviews.every((resource) => resource.first_table_startable === true)).toBe(true);
      expect(reviews.every((resource) =>
        resource.organization_scope?.mode === "single_organization"
        && resource.organization_scope.organization_id === "internal-finance"
        && resource.scope_resolution_guidance === undefined)).toBe(true);
      expect(reviews.every((resource) =>
        resource.database_server_compatibility?.detected_version === "PostgreSQL 16"
        && resource.database_server_compatibility.tier === "full"
        && resource.database_server_compatibility.authority?.version_line === "16"))
        .toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("records a model-withheld field through the top-level CLI and rejects unknown fields", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-front-door-"));
    const inspection = boundaryInspection();
    const setup = await initializeSignedReviewProject(root, inspection);
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const baseArgs = [
      "boundary",
      "review",
      "resource",
      "public.service_visits",
      "--project-root", root,
      "--withhold-from-model", "status",
      "--actor", "alice",
      "--reason", "Keep reviewed status labels available locally without model egress.",
    ];
    try {
      await expect(main(baseArgs, {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      expect(output).toContain("Preview of one pending review decision. Nothing is saved or active yet.");
      expect(output).toContain(
        "Withhold from model: status - text column of public.service_visits",
      );
      expect(output).toContain("database-declared values: scheduled, completed");
      expect(output).toContain("Model-withheld fields added: status");
      expect(output).toContain("Everything else: unchanged.");
      expect(output).toContain("--withhold-from-model status");
      expect(output).toContain("--apply");
      await expect(fs.access(path.join(root, ".synapsor/boundary-review-progress.json")))
        .rejects.toMatchObject({ code: "ENOENT" });

      output = "";
      await expect(main([
        ...baseArgs,
        "--json",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      const preview = JSON.parse(output);

      output = "";
      await expect(main([
        ...baseArgs,
        "--apply",
        "--confirm", `APPLY REVIEW ${preview.decision_digest}`,
        "--config", setup.configPath,
        "--identity", "alice",
        "--identity-key", setup.privateKeyPath,
        "--required-role", "boundary_reviewer",
        "--nonce", "front-door-review-nonce-0001",
        "--json",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      expect(JSON.parse(output)).toMatchObject({
        ok: true,
        review_revision: 1,
        source_database_changed: false,
      });
      const progress = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(progress.candidate.pack.resources).toEqual([
        expect.objectContaining({
          id: "public.service_visits",
          model_withheld_fields: ["status"],
        }),
      ]);
      const overrides = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/review-overrides.json"),
        "utf8",
      ));
      expect(overrides.resources["public.service_visits"].fields.status).toMatchObject({
        exposure: "withhold_from_model",
        actor: "alice",
      });
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });

      output = "";
      await expect(main([
        "boundary", "review", "resource", "public.service_visits",
        "--project-root", root,
        "--withhold-from-model", "tenant_id",
        "--actor", "alice",
        "--reason", "Show the fixed tenant only in Runner's local verified output.",
        "--json",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      expect(JSON.parse(output)).toMatchObject({
        semantic_diff: {
          resource_id: "public.service_visits",
          selected_tenant_key: "tenant_id",
          added_visible_fields: ["tenant_id"],
          removed_kept_out_fields: ["tenant_id"],
          added_model_withheld_fields: ["tenant_id"],
          authority_changed: true,
        },
        authority_activated: false,
        source_database_changed: false,
      });

      output = "";
      await expect(main([
        "boundary", "review", "resource", "public.service_visits",
        "--project-root", root,
        "--allow-reviewed-field", "tenant_id",
        "--actor", "alice",
        "--reason", "The owner reviewed this fixed tenant value for model output.",
        "--json",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      expect(JSON.parse(output)).toMatchObject({
        semantic_diff: {
          resource_id: "public.service_visits",
          selected_tenant_key: "tenant_id",
          added_visible_fields: ["tenant_id"],
          removed_kept_out_fields: ["tenant_id"],
          authority_changed: true,
        },
        authority_activated: false,
        source_database_changed: false,
      });

      await expect(main([
        ...baseArgs.slice(0, baseArgs.indexOf("--withhold-from-model") + 1),
        "banana",
        ...baseArgs.slice(baseArgs.indexOf("--withhold-from-model") + 2),
      ], {
        boundarySchemaInspector: async () => inspection,
      })).rejects.toThrow(
        /unknown field "banana".*available columns: id, scheduled_at, status, tenant_id/i,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("never prompts for a resource decision on a non-TTY without decision flags", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-nontty-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    let stderr = "";
    let stdout = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(main([
        "boundary",
        "review",
        "--project-root", root,
        "--map",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      expect(stdout).toContain("BOUNDARY OVERVIEW");
      expect(stdout).toContain(
        'Boundary "reviewed_staging" is one boundary containing 1 table.',
      );
      expect(stdout).toContain('NEXT BOUNDARY "reviewed_staging" (DISABLED DRAFT)');
      expect(stdout).toContain("Show the complete catalog:");

      stdout = "";
      await expect(main([
        "boundary",
        "review",
        "--project-root", root,
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      expect(stdout).toContain("BOUNDARY OVERVIEW");
      expect(stdout).toContain('NEXT BOUNDARY "reviewed_staging" (DISABLED DRAFT)');
      expect(stdout).not.toContain("Usage:");

      stdout = "";
      await expect(main([
        "boundary",
        "review",
        "--project-root", root,
        "--map",
        "--all",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      expect(stdout).toContain("WHOLE BOUNDARY MAP (ALL TABLES)");
      expect(stdout).toContain('Next boundary "reviewed_staging": 1/1 tables | active 0');

      await expect(main([
        "boundary",
        "review",
        "--project-root", root,
        "--all",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).rejects.toThrow(/--all is available only with --map/i);

      await expect(main([
        "boundary",
        "review",
        "--project-root", root,
        "--map",
        "--details",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).rejects.toThrow(/--details requires --map --all/i);

      stdout = "";
      await expect(main([
        "boundary",
        "review",
        "resource",
        "public.service_visits",
        "--project-root", root,
        "--map",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      expect(stdout).toContain("TABLE ACCESS MAP - public.service_visits");
      expect(stdout).toContain("FIELD AUTHORITY");
      expect(stdout).toContain("Reviewed operations");
      expect(stdout).toMatch(/\| status\s+\| text\s+\| Model \+ Runner\s+\| Return value/u);
      expect(stdout).toContain("Filter");
      expect(stdout).toContain("Sort");
      expect(stdout).toContain("tenant scope      tenant_id (direct; trusted runtime value)");
      expect(stdout).not.toContain("filter: eq, neq, in");
      expect(stdout).not.toContain("\u001b[");

      stdout = "";
      await expect(main([
        "boundary",
        "review",
        "resource",
        "public.service_visits",
        "--project-root", root,
        "--map",
        "--details",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      expect(stdout).toContain("EXACT OPERATION DETAILS");
      expect(stdout).toContain("status  filter: eq, neq, in");
      await expect(main([
        "boundary",
        "review",
        "resource",
        "public.service_visits",
        "--project-root", root,
        "--map",
        "--withhold-from-model", "status",
        "--actor", "alice",
        "--reason", "This combination must not silently ignore either request.",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).rejects.toThrow(/--map is inspection-only/i);

      stdout = "";
      await expect(main([
        "boundary",
        "review",
        "resource",
        "public.service_visits",
        "--project-root", root,
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(2);
      expect(stderr).toContain("No boundary decision was supplied");
      expect(stderr).toContain("--withhold-from-model");
      expect(stdout).toContain("Resource decision flags:");
      expect(stdout).toContain("--principal-scope-path <path-id>");
      await expect(fs.access(path.join(root, ".synapsor/boundary-review-progress.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a hand-authored Runner config while drafting a boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-preserve-config-"));
    const configPath = path.join(root, "synapsor.runner.json");
    const config = `${JSON.stringify({
      version: 1,
      mode: "read_only",
      storage: { sqlite_path: "./custom-ledger.db" },
      sources: {
        warehouse_reader: {
          engine: "postgres",
          read_url_env: "WAREHOUSE_READ_URL",
          read_only: true,
          statement_timeout_ms: 2500,
        },
      },
      trusted_context: {
        provider: "environment",
        values: { tenant_id_env: "WAREHOUSE_TENANT" },
        tenant_binding: "tenant_id",
      },
      capabilities: [],
      strict: true,
      result_format: 2,
    }, null, 2)}\n`;
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await fs.writeFile(configPath, config, "utf8");
      await expect(boundaryCommand([
        "draft",
        "--from-env", "DATABASE_URL",
        "--project-root", root,
      ], async () => boundaryInspection())).resolves.toBe(0);

      await expect(fs.readFile(configPath, "utf8")).resolves.toBe(config);
      expect(output).toContain("Generated disabled Auto Boundary draft");
      expect(output).not.toContain("Prepared the local Runner config");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("points a production draft with a local trusted-context config to the production scaffold", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-production-config-mismatch-"));
    const configPath = path.join(root, "synapsor.runner.json");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "read_only",
      storage: { sqlite_path: "./.synapsor/local.db" },
      sources: {
        local_postgres: {
          engine: "postgres",
          read_url_env: "DATABASE_URL",
          read_only: true,
          statement_timeout_ms: 3000,
        },
      },
      trusted_context: {
        provider: "environment",
        values: {
          tenant_id_env: "SYNAPSOR_TENANT_ID",
          principal_env: "SYNAPSOR_PRINCIPAL",
        },
        tenant_binding: "tenant_id",
        principal_binding: "principal",
      },
      capabilities: [],
      strict: true,
      result_format: 2,
    }), "utf8");
    try {
      await expect(boundaryCommand([
        "draft",
        "--from-env", "DATABASE_URL",
        "--project-root", root,
        "--profile", "production",
        "--tenant-claim", "tenant_id",
        "--principal-claim", "sub",
      ], async () => boundaryInspection())).rejects.toThrow(
        /config init --production-explore --engine postgres.*retry the production boundary draft/i,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("turns a trusted config principal binding into a disabled reviewed column decision", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-config-principal-"));
    const configPath = path.join(root, "synapsor.runner.json");
    const config = `${JSON.stringify({
      version: 1,
      mode: "read_only",
      storage: { sqlite_path: "./.synapsor/local.db" },
      sources: {
        local_postgres: {
          engine: "postgres",
          read_url_env: "DATABASE_URL",
          read_only: true,
          statement_timeout_ms: 3000,
        },
      },
      trusted_context: {
        provider: "environment",
        values: {
          tenant_id_env: "SYNAPSOR_TENANT_ID",
          principal_env: "SYNAPSOR_PRINCIPAL",
        },
        tenant_binding: "tenant_id",
        principal_binding: "rep",
      },
      capabilities: [],
      strict: true,
      result_format: 2,
    }, null, 2)}\n`;
    const inspection = boundaryInspection();
    inspection.tables[0]!.columns.push({
      name: "rep",
      data_type: "text",
      nullable: false,
      generated: false,
      ordinal_position: inspection.tables[0]!.columns.length + 1,
      suggestions: {
        tenant: false,
        conflict: false,
        sensitive: false,
        immutable: false,
        large_or_binary: false,
      },
    });
    inspection.tables[0]!.suggestions.default_visible_columns.push("rep");
    try {
      await fs.writeFile(configPath, config, "utf8");
      await expect(boundaryCommand([
        "draft",
        "--from-env", "DATABASE_URL",
        "--project-root", root,
      ], async () => inspection)).resolves.toBe(0);

      const draft = JSON.parse(await fs.readFile(
        path.join(root, "synapsor/generated/exploration-boundary.draft.json"),
        "utf8",
      ));
      const resource = draft.pack.resources.find((candidate: { id: string }) =>
        candidate.id === "public.service_visits");
      expect(resource.principal_key).toBe("rep");
      expect(draft.unresolved_decisions).toContain(
        "public.service_visits: confirm principal scope rep",
      );
      await expect(fs.readFile(configPath, "utf8")).resolves.toBe(config);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("gives boundary diff a copy-paste regeneration command for the reviewed source env", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-stale-diff-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: [],
        schema_inputs: [],
        database_env_names: ["WAREHOUSE_DATABASE_URL"],
      },
      sourceEnv: "WAREHOUSE_DATABASE_URL",
    });
    const drifted = structuredClone(inspection);
    drifted.tables[0]!.role_posture!.owner = "replacement_owner";
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryCommand([
        "diff",
        "--project-root", root,
      ], async () => drifted)).resolves.toBe(1);

      expect(output).toContain("Generation lock is stale:");
      expect(output).toContain(
        "synapsor-runner boundary rescan --from-env WAREHOUSE_DATABASE_URL",
      );
      expect(output).toContain("preserves unchanged review decisions");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("routes boundary rescan and force-draft through the same non-destructive reconciliation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-rescan-command-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: [],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
    });
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryCommand([
        "rescan",
        "--from-env", "DATABASE_URL",
        "--project-root", root,
      ], async () => structuredClone(inspection))).resolves.toBe(0);
      expect(output).toContain(
        "schema, database-server capabilities, database-role posture, and trusted-context authority are unchanged",
      );

      output = "";
      await expect(boundaryCommand([
        "draft",
        "--from-env", "DATABASE_URL",
        "--project-root", root,
        "--force",
      ], async () => structuredClone(inspection))).resolves.toBe(0);
      expect(output).toContain("boundary draft used the reconciling rescan path");
      expect(output).toContain("No curated review state was discarded");

      const changed = structuredClone(inspection);
      changed.tables[0]!.columns.push({
        ...structuredClone(changed.tables[0]!.columns.at(-1)!),
        name: "reviewed_source_note",
        ordinal_position: changed.tables[0]!.columns.length + 1,
      });
      output = "";
      await expect(boundaryCommand([
        "rescan",
        "--from-env", "DATABASE_URL",
        "--project-root", root,
      ], async () => changed)).resolves.toBe(0);
      expect(output).toContain("Review and activate in the focused access editor (no second rescan)");
      expect(output).toContain("boundary review --project-root");
      expect(output).toContain("--access opens the same table, column, and path editor as /access");
      expect(output).toContain("resume guided review, activate, and continue to Ask (no second rescan)");
      expect(output).toContain(`cd '${root}' && synapsor-runner start --from-env DATABASE_URL --cli`);
      expect(output).toContain("start --from-env DATABASE_URL --cli");
      expect(output).not.toContain("start --from-env DATABASE_URL --cli --rescan");
      expect(output).toContain("Use start --rescan only when you want to inspect the database again");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("distinguishes rescan, focused access review, and guided rescan in boundary help", async () => {
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });

    await expect(main(["boundary", "--help"])).resolves.toBe(0);

    expect(output).toContain("Choose the boundary workflow by intent:");
    expect(output).toContain("boundary rescan\n    Inspects the current schema");
    expect(output).toContain("boundary review --access\n    Opens the focused table");
    expect(output).toContain("same editor as /access inside the Ask shell");
    expect(output).toContain("start --from-env DATABASE_URL --cli --rescan");
    expect(output).toContain("omit --rescan");
  });

  it("renames the one disabled multi-table boundary without activating authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-name-"));
    const inspection = boundaryInspection();
    const secondTable = structuredClone(inspection.tables[0]!);
    secondTable.name = "service_routes";
    secondTable.unique_constraints = [{ name: "service_routes_pkey", columns: ["id"] }];
    secondTable.indexes = [{ name: "service_routes_pkey", columns: ["id"], unique: true }];
    inspection.tables.push(secondTable);
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const answers = [
      "Service_Operations",
      "alice",
      "This boundary covers reviewed service operations analytics.",
    ];
    const choices = [
      { action: "rename" as const },
      undefined,
    ];
    let chooseCalls = 0;
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => {
        chooseCalls += 1;
        return choices.shift();
      },
      editFieldTiers: async () => undefined,
      promptText: async () => answers.shift() ?? "",
      confirm: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
      ], async () => inspection, session)).resolves.toBe(0);
      const progress = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(progress.candidate.pack.name).toBe("service_operations");
      expect(progress.candidate.pack.resources.length).toBeGreaterThan(1);
      const nextReview = await listBoundaryResourceReviews(root);
      expect(nextReview.length).toBeGreaterThan(1);
      expect(nextReview.every((resource) =>
        resource.candidate_boundary_name === "service_operations")).toBe(true);
      expect(output).toContain("DISABLED BOUNDARY NAME CHANGE");
      expect(output).toContain('Using lower-case boundary name "service_operations".');
      expect(output).toContain('Saved boundary name "service_operations"');
      expect(output).toContain("Active authority changed: no");
      expect(output).toContain("Boundary review paused. No new decision or authority was recorded.");
      expect(output).toContain("start --from-env DATABASE_URL --cli");
      expect(chooseCalls).toBe(2);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps every boundary limit visible while reviewing a numbered choice", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-limits-menu-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const choices = [{ action: "limits" as const }, undefined];
    const promptCalls: Array<{ prompt: string; context: string[] }> = [];
    const confirmationContexts: string[][] = [];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => choices.shift(),
      editFieldTiers: async () => undefined,
      promptText: async (prompt, options) => {
        promptCalls.push({ prompt, context: options?.context ?? [] });
        if (prompt.startsWith("Limit to review")) return "12";
        if (prompt.startsWith("Derived-scope depth")) return "3";
        return undefined;
      },
      confirm: async (_prompt, options) => {
        confirmationContexts.push(options?.context ?? []);
        return true;
      },
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session)).resolves.toBe(0);

      const menu = promptCalls[0]?.context.join("\n") ?? "";
      expect(menu).toContain("BOUNDARY LIMITS");
      expect(menu).toContain("1  Query volume");
      expect(menu).toContain("12  Derived-scope depth");
      expect(menu).toContain("13  Analysis-path depth");
      expect(menu).toContain("differencing protection");
      expect(promptCalls[1]?.context.join("\n")).toContain("Effect: mandatory tenant/principal scope traversal");
      expect(confirmationContexts[0]?.join("\n")).toContain("Derived-scope depth: 2 -> 3 proven hops");

      const context = await loadBoundaryReviewContext(root);
      expect(context.candidate.budgets.max_derived_scope_hops).toBe(3);
      expect(context.candidate.budgets.max_analysis_relationship_hops).toBe(2);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("disables active Explore without deleting its named draft, review state, or protected artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-disable-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const digest = explorationBoundaryCandidateDigest(build.exploration_boundary);
    const {
      activation: _disabledActivation,
      unresolved_decisions: _unresolvedDecisions,
      ...authority
    } = build.exploration_boundary;
    const active = {
      ...authority,
      activation: {
        state: "active",
        digest,
        actor: "alice",
        activated_at: "2026-07-30T12:00:00.000Z",
        generation_lock_fingerprint: build.exploration_boundary.generation_lock_fingerprint,
        reviewed_decisions: build.exploration_boundary.unresolved_decisions.map((decision) => ({
          decision,
          confirmed: true,
        })),
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await fs.mkdir(path.join(root, ".synapsor/protected"), { recursive: true });
      await fs.writeFile(
        path.join(root, ".synapsor/exploration-boundary.active.json"),
        `${JSON.stringify(active, null, 2)}\n`,
        "utf8",
      );
      await fs.writeFile(path.join(root, ".synapsor/protected/readme.txt"), "preserve\n", "utf8");

      await expect(boundaryCommand([
        "disable",
        "--project-root", root,
        "--actor", "alice",
        "--confirm", `DISABLE ${digest}`,
        "--json",
      ])).resolves.toBe(0);

      expect(JSON.parse(output)).toMatchObject({
        ok: true,
        disabled: true,
        activation: "disabled",
        boundary_name: build.exploration_boundary.pack.name,
        disabled_digest: digest,
        actor: "alice",
        protected_capabilities_changed: false,
        review_state_changed: false,
        source_database_changed: false,
      });
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(
        path.join(root, "synapsor/generated/exploration-boundary.draft.json"),
        "utf8",
      )).resolves.toContain(build.exploration_boundary.pack.name);
      await expect(fs.readFile(path.join(root, ".synapsor/protected/readme.txt"), "utf8"))
        .resolves.toBe("preserve\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps /access open when the last boundary is deactivated and supports immediate reactivation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-disable-reactivate-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const digest = explorationBoundaryCandidateDigest(build.exploration_boundary);
    const choices = [
      { action: "disable" as const, boundary_name: build.exploration_boundary.pack.name },
      { action: "confirm" as const },
      undefined,
    ];
    let chooseCalls = 0;
    const previousUser = process.env.USER;
    process.env.USER = "access-reviewer";
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => {
        chooseCalls += 1;
        return choices.shift();
      },
      editFieldTiers: async () => undefined,
      promptText: async () => undefined,
      confirm: async () => true,
      confirmActivation: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: build.exploration_boundary,
        expectedDigest: digest,
        actor: "initial-reviewer",
        confirmation: `ACTIVATE ${digest}`,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        currentInspection: inspection,
      });

      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access"],
        async () => inspection,
        session,
        undefined,
        { startAtBoundaryList: true },
      )).resolves.toBe(0);

      expect(chooseCalls).toBe(3);
      expect(output).toContain("No active boundary. Stay in /access");
      expect(output).toContain("/access is still open.");
      const reactivated = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/exploration-boundary.active.json"),
        "utf8",
      ));
      expect(reactivated.activation.state).toBe("active");
      expect(reactivated.pack.name).toBe(build.exploration_boundary.pack.name);
    } finally {
      if (previousUser === undefined) delete process.env.USER;
      else process.env.USER = previousUser;
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("returns from column review to the table list without saving", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-picker-back-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const choices = [
      { resource_id: "public.service_visits", action: "review" as const },
      undefined,
    ];
    let chooseCalls = 0;
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => {
        chooseCalls += 1;
        return choices.shift();
      },
      editFieldTiers: async () => "back",
      promptText: async () => {
        throw new Error("Back navigation must not request reviewer details.");
      },
      confirm: async () => {
        throw new Error("Back navigation must not request confirmation.");
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
      ], async () => inspection, session)).resolves.toBe(0);
      expect(chooseCalls).toBe(2);
      expect(output).toContain("Boundary review paused. No new decision or authority was recorded.");
      expect(output).toContain("Resume: synapsor-runner start --from-env DATABASE_URL --cli");
      await expect(fs.access(path.join(root, ".synapsor/boundary-review-progress.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("turns reviewed question cards into a fully reviewed disabled candidate for the same-session action flow", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-card-onboarding-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const choices = [
      { action: "workloads" as const },
      undefined,
    ];
    const promptAnswers = [
      "Report service visit activity.",
    ];
    const promptLabels: string[] = [];
    const mappingChoices: string[][] = [];
    const activationPrompts: string[] = [];
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => choices.shift(),
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        promptLabels.push(prompt);
        return promptAnswers.shift();
      },
      chooseOption: async (title, options, promptOptions) => {
        if (title === "MAP THE JOB TO REVIEWED STRUCTURE") {
          expect(promptOptions?.initialValue).toBe("cards");
          mappingChoices.push(options.map((option) => option.value));
          return "cards";
        }
        expect(title).toBe("RUNNER-GUIDED READ DRAFT");
        expect(promptOptions?.initialValue).toBe("use");
        return "use";
      },
      confirm: async (prompt) => {
        if (prompt.includes("Action Boundary")) return false;
        throw new Error(`Plan cards must not add a separate save confirmation: ${prompt}`);
      },
      confirmActivation: async (prompt) => {
        activationPrompts.push(prompt);
        return false;
      },
      confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access"],
        async () => inspection,
        session,
      )).resolves.toBe(0);

      expect(activationPrompts).toHaveLength(1);
      expect(promptLabels).toHaveLength(1);
      expect(promptLabels[0]).toContain("What job are you giving this agent?");
      expect(mappingChoices).toEqual([[
        "model",
        "cards",
        "manual",
        "exact",
        "intent_model",
        "saved",
      ]]);
      expect(output).toContain("READ CANDIDATE READY");
      expect(output).toMatch(/\| Read\s+\| reviewed_staging\s+\| DRAFT\s+\| None/u);
      expect(output).toMatch(/\| Apply\s+\| Source writeback\s+\| NOT ALLOWED\s+\| Cannot apply/u);
      expect(output).toContain("REVIEW EXACT BOUNDARY");
      expect(output).toContain("READ REVIEW COMPLETE - NOT ACTIVE");
      expect(output).toContain("Press Y in /access to prepare and rehearse a proposal action");
      const workloadFiles = (await fs.readdir(path.join(root, ".synapsor/read-workloads")))
        .filter((name) => name.endsWith(".json") && !name.endsWith(".review.json"));
      expect(workloadFiles).toHaveLength(1);
      await expect(readDelegationDraft(root, "report_service_visit_activity"))
        .resolves.toMatchObject({
          state: "disabled",
          actions: [],
          authority_granted: false,
          source_query_executed: false,
          explore_budget_consumed: false,
          source_database_changed: false,
        });
      const context = await loadBoundaryReviewContext(root);
      expect(context.candidate.activation).toBe("disabled_unreviewed");
      expect(context.progress?.confirmed_decisions).toEqual(context.candidate.unresolved_decisions);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      stdout.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("accepts a 2,000-character agent job before choosing a mapping path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-job-limit-accepted-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const job = "a".repeat(2_000);
    const promptContexts: string[][] = [];
    const mappingChoices: string[] = [];
    const notices: string[] = [];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async (_resources, _overview, options) => {
        if (options?.notice) notices.push(...options.notice.lines);
        return undefined;
      },
      editFieldTiers: async () => undefined,
      promptText: async (prompt, options) => {
        expect(prompt).toBe("What job are you giving this agent?");
        promptContexts.push(options?.context ?? []);
        return job;
      },
      chooseOption: async (title) => {
        mappingChoices.push(title);
        return "manual";
      },
      confirm: async () => {
        throw new Error("A valid job followed by Manual must not request confirmation.");
      },
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const before = await loadBoundaryReviewContext(root);
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        { startWithAgentJob: true },
      )).resolves.toBe(0);

      expect(promptContexts).toHaveLength(1);
      expect(promptContexts[0]).toContain("Maximum job description length: 2000 characters.");
      expect(mappingChoices).toEqual(["MAP THE JOB TO REVIEWED STRUCTURE"]);
      expect(notices).not.toContain(expect.stringContaining("maximum is 2000"));
      const after = await loadBoundaryReviewContext(root);
      expect(after.bundle.candidate_digest).toBe(before.bundle.candidate_digest);
      expect(after.candidate).toEqual(before.candidate);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a 2,001-character agent job before staging the mapping catalog", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-job-limit-refused-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const prompts: Array<{ prompt: string; context: string[] }> = [];
    const presented: Array<{ title: string; lines: string[] }> = [];
    const chooseOption = vi.fn();
    const session: BoundaryReviewInteractiveSession = {
      present: (title, lines) => presented.push({ title, lines }),
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt, options) => {
        prompts.push({ prompt, context: options?.context ?? [] });
        return prompts.length === 1 ? "a".repeat(2_001) : undefined;
      },
      chooseOption,
      confirm: async () => {
        throw new Error("An oversized job must be rejected before confirmation.");
      },
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const before = await loadBoundaryReviewContext(root);
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        { startWithAgentJob: true },
      )).resolves.toBe(0);

      expect(prompts).toHaveLength(2);
      expect(prompts[1]?.context).toEqual(expect.arrayContaining([
        "JOB DESCRIPTION TOO LONG",
        "Job description is 2001 characters; maximum is 2000.",
        "Shorten it and submit again. No disabled Boundary draft was staged or changed.",
      ]));
      expect(presented).toContainEqual({
        title: "JOB DESCRIPTION TOO LONG",
        lines: [
          "Job description is 2001 characters; maximum is 2000.",
          "Shorten it and submit again. No disabled Boundary draft was staged or changed.",
        ],
      });
      expect(chooseOption).not.toHaveBeenCalled();
      const after = await loadBoundaryReviewContext(root);
      expect(after.bundle.candidate_digest).toBe(before.bundle.candidate_digest);
      expect(after.candidate).toEqual(before.candidate);
      await expect(fs.access(path.join(root, ".synapsor/read-workloads")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a read-only model job in chat through its explicit activation gate", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-job-first-model-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const prompts: string[] = [];
    const confirmations: string[] = [];
    const activationPrompts: string[] = [];
    const modelReadWorkloadGenerator = vi.fn(async (
      input: Parameters<typeof generateModelReadWorkload>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelReadWorkload>>> => {
      const card = buildReadWorkloadPlanCards(input.generatedBoundary)[0]!;
      const workload = readWorkloadFromPlanCards({ cards: [card], selectedIds: [card.id] });
      return {
        workload,
        analysis: analyzeReadWorkloadSet({ workload, generatedBoundary: input.generatedBoundary }),
        provider: input.provider,
        model: input.model,
        model_message: "I drafted one representative Read plan from the reviewed service structure.",
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      };
    });
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        prompts.push(prompt);
        if (prompt.includes("What job are you giving this agent?")) {
          return "Explain service activity to support staff.";
        }
        if (prompt.includes("Mapping method")) return "";
        if (prompt.includes("Choice (1-3)")) return "1";
        throw new Error(`Unexpected job-first prompt: ${prompt}`);
      },
      confirm: async (prompt) => {
        confirmations.push(prompt);
        if (prompt.includes("Action Boundary")) return false;
        if (prompt.includes("reviewed structural context")) return true;
        throw new Error(`Unexpected job-first confirmation: ${prompt}`);
      },
      confirmActivation: async (prompt) => {
        activationPrompts.push(prompt);
        return false;
      },
    };
    const chatClose = vi.fn();
    const chatModel = vi.fn();
    const chatRunner = vi.fn();
    const chatDetails = vi.fn();
    const chatProgressCalls: string[] = [];
    const chatProgress = async <T>(message: string, operation: () => Promise<T>): Promise<T> => {
      chatProgressCalls.push(message);
      return operation();
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-job-mapper",
            apiKey: "session-only-secret",
          },
          modelReadWorkloadGenerator,
          modelAuthoringNarrator: vi.fn(async () =>
            "I drafted one representative Read plan from the reviewed service structure."),
          boundaryAuthoringChatFactory: () => ({
            session: { ...session, presentationMode: "conversation" },
            actionPrompter: {
              choose: async () => undefined,
              text: async () => undefined,
              confirm: async () => undefined,
              message: async () => undefined,
            },
            setModel: vi.fn(),
            runner: chatRunner,
            model: chatModel,
            checkpoint: chatRunner,
            streamRunner: async (...args) => { chatRunner(...args); },
            streamCheckpoint: async (...args) => { chatRunner(...args); },
            streamModel: async (lines) => { chatModel(lines); },
            rememberDetails: chatDetails,
            showDetails: vi.fn(),
            providerStream: vi.fn(),
            progress: chatProgress,
            close: chatClose,
          }),
        },
      )).resolves.toBe(0);

      expect(prompts).toEqual([
        "What job are you giving this agent?",
        "Mapping method [1]",
        "Choice (1-3)",
      ]);
      expect(confirmations).toHaveLength(1);
      expect(activationPrompts).toEqual([
        expect.stringContaining('Activate "reviewed_staging" for local read-only Explore'),
      ]);
      expect(modelReadWorkloadGenerator).toHaveBeenCalledWith(expect.objectContaining({
        provider: "openai",
        model: "gpt-job-mapper",
        allowedQuestions: ["Explain service activity to support staff."],
        egressAcknowledged: true,
        valueRequestHandler: expect.any(Function),
        clarificationHandler: expect.any(Function),
        conversation: expect.objectContaining({ turns: expect.any(Array) }),
      }));
      expect(chatProgressCalls).toEqual([
        "Mapping requested reads with the selected model",
        "openai[gpt-job-mapper] is summarizing the validated Read draft",
      ]);
      expect(chatModel).toHaveBeenCalledWith(expect.arrayContaining([
        expect.stringMatching(/representative Read plan/iu),
      ]));
      expect(chatRunner).not.toHaveBeenCalledWith("Runner verified", expect.any(Array), "success");
      expect(chatDetails).toHaveBeenCalledWith(
        "MODEL METADATA EGRESS",
        expect.arrayContaining([
          expect.stringContaining("schema-declared ENUM/CHECK allowlists"),
          expect.stringContaining("Never sent automatically: rows, observed values"),
          expect.stringContaining("Observed values require their own exact preview and permission"),
        ]),
      );
      expect(chatClose).toHaveBeenCalledOnce();
      const context = await loadBoundaryReviewContext(root);
      expect(context.candidate.activation).toBe("disabled_unreviewed");
      expect(context.candidate.pack.resources).toHaveLength(1);
      await expect(readDelegationDraft(root, "explain_service_activity_to_support_staff"))
        .resolves.toMatchObject({
          state: "disabled",
          actions: [],
          authority_granted: false,
          source_query_executed: false,
          source_database_changed: false,
          model_assist: {
            provider: "openai",
            model: "gpt-job-mapper",
            structural_metadata_egress_acknowledged: true,
          },
        });
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      const stored = await fs.readFile(
        path.join(root, ".synapsor/delegations/explain_service_activity_to_support_staff/draft.json"),
        "utf8",
      );
      expect(stored).not.toContain("session-only-secret");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("keeps an egress denial in the same authoring chat and continues without a model", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-chat-egress-denied-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const modelReadWorkloadGenerator = vi.fn();
    const modelAuthoringNarrator = vi.fn();
    const choices: string[] = [];
    const chatClose = vi.fn();
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (prompt.includes("What job are you giving this agent?")) {
          return "Explain service activity to support staff.";
        }
        throw new Error(`Unexpected denied-egress text prompt: ${prompt}`);
      },
      chooseOption: async (title, options, promptOptions) => {
        choices.push(title);
        if (title === "START BOUNDARY DRAFTING") return "model";
        if (title === "MODEL FOR BOUNDARY DRAFTING") return "current";
        if (title === "MODEL REQUEST NOT STARTED") {
          expect(promptOptions?.initialValue).toBe("runner");
          expect(options.map((option) => option.value)).toEqual([
            "runner",
            "review",
            "change_model",
            "back",
          ]);
          return "runner";
        }
        if (title === "RUNNER-GUIDED READ DRAFT") return "use";
        throw new Error(`Unexpected denied-egress choice: ${title}`);
      },
      confirm: async (prompt) => {
        if (prompt.includes("Action Boundary")) return false;
        if (prompt.includes("reviewed structural context")) return false;
        throw new Error(`Unexpected denied-egress confirmation: ${prompt}`);
      },
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-job-mapper",
            apiKey: "session-only-secret",
          },
          modelReadWorkloadGenerator,
          modelAuthoringNarrator,
          boundaryAuthoringChatFactory: () => ({
            session,
            actionPrompter: {
              choose: async () => undefined,
              text: async () => undefined,
              confirm: async () => undefined,
              message: async () => undefined,
            },
            setModel: vi.fn(),
            runner: vi.fn(),
            model: vi.fn(),
            checkpoint: vi.fn(),
            streamRunner: async () => undefined,
            streamCheckpoint: async () => undefined,
            streamModel: async () => undefined,
            rememberDetails: vi.fn(),
            showDetails: vi.fn(),
            providerStream: vi.fn(),
            progress: async <T>(_message: string, operation: () => Promise<T>) => operation(),
            close: chatClose,
          }),
        },
      )).resolves.toBe(0);

      expect(choices).toEqual(expect.arrayContaining([
        "MODEL REQUEST NOT STARTED",
        "RUNNER-GUIDED READ DRAFT",
      ]));
      expect(choices).not.toContain("MODEL FOR BOUNDARY DRAFTING");
      expect(modelReadWorkloadGenerator).not.toHaveBeenCalled();
      expect(modelAuthoringNarrator).not.toHaveBeenCalled();
      expect(chatClose).toHaveBeenCalledOnce();
      const delegation = await readDelegationDraft(root, "explain_service_activity_to_support_staff");
      expect(delegation).toMatchObject({
        state: "disabled",
        actions: [],
        authority_granted: false,
        source_query_executed: false,
        source_database_changed: false,
      });
      expect(delegation).not.toHaveProperty("model_assist");
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("maps one no-model job across uniquely proven three-hop scope paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-job-first-depth-three-"));
    const inspection = depthThreeDerivedCliInspection();
    const dispatchSettings = structuredClone(
      inspection.tables.find((table) => table.name === "orders")!,
    );
    dispatchSettings.name = "dispatch_settings";
    dispatchSettings.foreign_keys = [];
    dispatchSettings.unique_constraints = [{
      name: "dispatch_settings_pkey",
      columns: ["id"],
    }];
    dispatchSettings.indexes = [{
      name: "dispatch_settings_pkey",
      columns: ["id"],
      unique: true,
    }];
    inspection.tables.push(dispatchSettings);
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    let sawDepthThreeCard = false;
    let cardResources: string[] = [];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (prompt.includes("What job are you giving this agent?")) {
          return "Summarize order notes and their related order activity.";
        }
        if (prompt.includes("Mapping method")) return "2";
        throw new Error(`Unexpected no-model job prompt: ${prompt}`);
      },
      confirm: async (prompt) => {
        if (prompt.includes("Action Boundary")) return false;
        if (prompt.includes("disabled job-mapping catalog")) return true;
        throw new Error(`Unexpected no-model job confirmation: ${prompt}`);
      },
      selectReadWorkloadCards: async (cards) => {
        cardResources = [...new Set(cards.map((card) => String(card.plan.resource)))].sort();
        sawDepthThreeCard = cards.some((card) => card.plan.resource === "public.event_notes");
        return cards.map((card) => card.id);
      },
      confirmActivation: async () => {
        throw new Error("Catalog preparation and workload minimization must remain disabled.");
      },
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const narrowCandidate = structuredClone(build.exploration_boundary);
      narrowCandidate.pack.resources = narrowCandidate.pack.resources.filter(
        (resource) => resource.id === "public.orders",
      );
      await saveBoundaryReviewProgress(root, createBoundaryReviewProgress({
        draft: build.exploration_boundary,
        candidate: narrowCandidate,
        confirmedDecisions: [],
        actor: "local-developer",
        revision: 1,
        now: "2026-08-29T00:00:00.000Z",
      }));
      expect((await listBoundaryResourceReviews(root)).map((resource) => resource.resource_id).sort())
        .toEqual([
          "public.dispatch_settings",
          "public.event_notes",
          "public.order_events",
          "public.order_items",
          "public.orders",
        ]);
      expect((await inspectBoundaryResourceReview(root, "public.order_items"))
        .derived_tenant_scope?.candidates.map((candidate) => candidate.path_id))
        .toEqual(["order_items_order_id_fkey"]);
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        { startWithAgentJob: true },
      )).resolves.toBe(0);

      const context = await loadBoundaryReviewContext(root);
      const { unresolved_decisions: _unresolved, ...facade } = structuredClone(context.candidate);
      const eventNotesScope = context.candidate.pack.resources.find((resource) =>
        resource.id === "public.event_notes")?.tenant_scope;
      expect(eventNotesScope?.proof.links).toHaveLength(3);
      expect(eventNotesScope?.proof.digest).toBe(canonicalJsonDigest(eventNotesScope?.proof.links));
      const activated = {
        ...facade,
        activation: {
          state: "active" as const,
          digest: explorationBoundaryCandidateDigest(context.candidate),
          actor: "test",
          activated_at: "2026-08-29T00:00:00.000Z",
          generation_lock_fingerprint: context.candidate.generation_lock_fingerprint,
          reviewed_decisions: [],
        },
      };
      const validated = validateExploreRequest({
        kind: "aggregate",
        resource: "public.event_notes",
        measures: [{ function: "count" }],
        top_n: 1,
      }, activated);
      expect(() => compileExplorePlan(
        validated.plan,
        activated,
        { tenant: "tenant-test", principal: "principal-test" },
        "postgres",
      )).not.toThrow();
      expect(cardResources).toEqual([
        "public.dispatch_settings",
        "public.event_notes",
        "public.order_events",
        "public.order_items",
        "public.orders",
      ]);
      expect(sawDepthThreeCard).toBe(true);
      expect(context.candidate.pack.resources.map((resource) => resource.id).sort()).toEqual([
        "public.dispatch_settings",
        "public.event_notes",
        "public.order_events",
        "public.order_items",
        "public.orders",
      ]);
      expect(context.candidate.budgets.max_derived_scope_hops).toBe(3);
      expect(context.candidate.budgets.max_analysis_relationship_hops).toBe(3);
      expect(context.candidate.pack.resources.find((resource) => resource.id === "public.event_notes")
        ?.tenant_scope?.path_id).toBe(
          "event_notes_order_event_id_fkey__order_events_order_item_id_fkey__order_items_order_id_fkey",
        );
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("requires and records an exact principal predicate for an own-row model job", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-own-row-principal-"));
    const inspection = principalScopeInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const scopeReviews: string[][] = [];
    const modelReadWorkloadGenerator = vi.fn(async (
      input: Parameters<typeof generateModelReadWorkload>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelReadWorkload>>> => {
      const card = buildReadWorkloadPlanCards(input.generatedBoundary)
        .find((candidate) => candidate.plan.resource === "public.service_visits")!;
      const workload = normalizeReadWorkloadSet({
        schema_version: READ_WORKLOAD_SET_VERSION,
        name: "own_row_scope_projection",
        allowed: [{
          id: "own_row_scope_projection.service_visits",
          description: "Return service visits while Runner applies trusted principal scope.",
          plan: {
            ...card.plan,
            select: [...new Set([...(card.plan.select as string[]), "principal_id"])],
          },
        }],
        forbidden: [],
        source: { kind: "model", provider: input.provider, model: input.model },
      });
      expect(analyzeReadWorkloadSet({ workload, generatedBoundary: input.generatedBoundary }).status).toBe("ready");
      return {
        workload,
        analysis: analyzeReadWorkloadSet({ workload, generatedBoundary: input.generatedBoundary }),
        provider: input.provider,
        model: input.model,
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      };
    });
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (prompt.includes("What job are you giving this agent?")) {
          return "Let an authenticated operator inspect only their own service visits.";
        }
        throw new Error(`Unexpected own-row prompt: ${prompt}`);
      },
      chooseOption: async (title) => {
        if (title === "START BOUNDARY DRAFTING") return "model";
        if (title === "MAP THE JOB TO REVIEWED STRUCTURE") return "model";
        if (title === "MODEL FOR BOUNDARY DRAFTING") return "current";
        if (title === "ACTIVATE READ BOUNDARY") return "finish";
        throw new Error(`Unexpected own-row choice: ${title}`);
      },
      confirm: async (prompt, options) => {
        if (prompt.includes("reviewed structural context")) return true;
        if (prompt.includes("trusted user scope")) {
          scopeReviews.push(options?.context ?? []);
          return true;
        }
        throw new Error(`Unexpected own-row confirmation: ${prompt}`);
      },
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-5.6-luna",
            apiKey: "session-secret",
          },
          modelReadWorkloadGenerator,
          modelAuthoringNarrator: vi.fn(async () =>
            "The exact own-row Read draft passed Runner validation and remains disabled."),
          boundaryAuthoringChatFactory: () => testBoundaryAuthoringChat(session),
        },
      )).resolves.toBe(0);

      expect(scopeReviews).toHaveLength(1);
      expect(scopeReviews[0]?.join("\n")).toContain(
        "public.service_visits -> principal_id (low confidence)",
      );
      const reviewed = await loadBoundaryReviewContext(root);
      const resource = reviewed.candidate.pack.resources.find((candidate) =>
        candidate.id === "public.service_visits");
      expect(resource?.principal_key).toBe("principal_id");
      expect(resource?.selectable_fields).not.toContain("principal_id");
      expect([
        ...(resource?.kept_out_fields ?? []),
        ...(resource?.model_withheld_fields ?? []),
      ]).toContain("principal_id");
      const workloads = await listReadWorkloadAnalyses({
        projectRoot: root,
        generatedBoundary: reviewed.candidate,
      });
      expect(workloads).toHaveLength(1);
      expect(workloads[0]?.state).toBe("reviewed");
      expect(workloads[0]?.analysis.allowed[0]?.plan_shape?.select).not.toContain("principal_id");
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("resumes a long model-guided job after principal review with its concise Read intent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-long-job-scope-resume-"));
    const inspection = principalScopeInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const operatorJob = [
      "Let an authenticated field-service operator inspect only their own scheduled service visits and related status information.",
      "Keep tenant and principal identity outside model arguments and preserve the existing reviewed database posture.",
      "The operator should understand arrival windows, service state, and the equipment involved without seeing another operator's work.",
      "Do not prepare a source mutation, approval, apply operation, raw SQL surface, credential path, or unscoped fallback.",
      "Retain the exact disabled Read draft if authoring pauses for a business confirmation, and continue from that same reviewed job when reopened.",
      "No source row should change during this authoring session.",
    ].join(" ");
    const readIntent = "Show the authenticated operator only their own scheduled service visits.";
    expect(Array.from(operatorJob).length).toBeGreaterThan(500);
    expect(Array.from(operatorJob).length).toBeLessThanOrEqual(2_000);
    expect(Array.from(readIntent).length).toBeLessThanOrEqual(500);

    const modelBoundaryJobPlanner = vi.fn(async () => ({
      state: "planned" as const,
      read_mode: "create" as const,
      read_intent: readIntent,
      action_mode: "none" as const,
      summary: "I will prepare the exact own-visit Read draft and no Action draft.",
      correction_used: false,
      authority_granted: false as const,
      source_database_changed: false as const,
    }));
    const modelReadWorkloadGenerator = vi.fn(async (
      input: Parameters<typeof generateModelReadWorkload>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelReadWorkload>>> => {
      expect(input.allowedQuestions).toEqual([readIntent]);
      const card = buildReadWorkloadPlanCards(input.generatedBoundary)
        .find((candidate) => candidate.plan.resource === "public.service_visits")!;
      const workload = readWorkloadFromPlanCards({ cards: [card], selectedIds: [card.id] });
      return {
        workload,
        analysis: analyzeReadWorkloadSet({ workload, generatedBoundary: input.generatedBoundary }),
        provider: input.provider,
        model: input.model,
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      };
    });
    let scopeReviewAttempt = 0;
    let metadataEgressReviews = 0;
    const makeSession = (resume: boolean): BoundaryReviewInteractiveSession => ({
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (!resume && prompt.includes("What job are you giving this agent?")) return operatorJob;
        throw new Error(`Unexpected long-job resume prompt: ${prompt}`);
      },
      chooseOption: async (title) => {
        if (title === "START BOUNDARY DRAFTING") return resume ? "resume" : "model";
        if (title === "ACTIVATE READ BOUNDARY") return "finish";
        throw new Error(`Unexpected long-job resume choice: ${title}`);
      },
      confirm: async (prompt) => {
        if (prompt.includes("reviewed structural context")) {
          metadataEgressReviews += 1;
          return true;
        }
        if (prompt.includes("trusted user scope")) {
          scopeReviewAttempt += 1;
          return resume;
        }
        throw new Error(`Unexpected long-job resume confirmation: ${prompt}`);
      },
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const firstSession = makeSession(false);
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        firstSession,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-test",
            apiKey: "session-secret",
          },
          modelBoundaryJobPlanner,
          modelReadWorkloadGenerator,
          modelAuthoringNarrator: async () => "The exact own-visit Read draft remains disabled.",
          boundaryAuthoringChatFactory: () => testBoundaryAuthoringChat(firstSession),
        },
      )).resolves.toBe(0);

      const pausedContext = await loadBoundaryReviewContext(root);
      const pausedResume = await readBoundaryAuthoringResumeState(root, {
        boundary_name: pausedContext.candidate.pack.name,
        generation_lock_fingerprint: pausedContext.bundle.authority.generation_lock_fingerprint,
        schema_fingerprint: pausedContext.bundle.authority.schema_fingerprint,
        role_posture_fingerprint: pausedContext.bundle.authority.role_posture_fingerprint,
      });
      expect(pausedResume).toMatchObject({
        status: "ready",
        value: {
          stage: "read_mapping",
          job_intent: operatorJob,
          read_intent: readIntent,
        },
      });
      expect(modelBoundaryJobPlanner).toHaveBeenCalledOnce();
      expect(modelReadWorkloadGenerator).toHaveBeenCalledOnce();

      const resumedSession = makeSession(true);
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        resumedSession,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-test",
            apiKey: "session-secret",
          },
          modelBoundaryJobPlanner,
          modelReadWorkloadGenerator,
          modelAuthoringNarrator: async () => "I retained the saved job and resumed its Read review.",
          boundaryAuthoringChatFactory: () => testBoundaryAuthoringChat(resumedSession),
        },
      )).resolves.toBe(0);

      expect(modelBoundaryJobPlanner).toHaveBeenCalledOnce();
      expect(modelReadWorkloadGenerator).toHaveBeenCalledTimes(2);
      expect(scopeReviewAttempt).toBe(2);
      expect(metadataEgressReviews).toBe(1);
      const reviewed = await loadBoundaryReviewContext(root);
      expect(reviewed.candidate.pack.resources.find((resource) =>
        resource.id === "public.service_visits")?.principal_key).toBe("principal_id");
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(["new", "already reviewed"] as const)("stops before Action drafting when %s trusted scope blocks a model projection", async (scope) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-scope-reprojection-blocked-"));
    const inspection = principalScopeInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const modelReadWorkloadGenerator = vi.fn(async (
      input: Parameters<typeof generateModelReadWorkload>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelReadWorkload>>> => {
      const workload = normalizeReadWorkloadSet({
        schema_version: READ_WORKLOAD_SET_VERSION,
        name: "scope_only_projection",
        allowed: [{
          id: "scope_only_projection.service_visits",
          description: "Return only the candidate principal column.",
          plan: {
            kind: "rows",
            resource: "public.service_visits",
            select: ["principal_id"],
            limit: 10,
          },
        }],
        forbidden: [],
        source: { kind: "model", provider: input.provider, model: input.model },
      });
      expect(input.generatedBoundary.pack.resources.find((resource) => resource.id === "public.service_visits")!
        .model_withheld_fields).toContain("principal_id");
      // Private scope fields remain compiler-readable, but cannot be the model's whole row projection.
      const analysis = analyzeReadWorkloadSet({ workload, generatedBoundary: input.generatedBoundary });
      expect(analysis.status).toBe("ready");
      return {
        workload,
        analysis,
        provider: input.provider,
        model: input.model,
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      };
    });
    const actionProjectInspector = vi.fn();
    let scopeConfirmations = 0;
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (prompt.includes("What job are you giving this agent?")) {
          return "Inspect only the authenticated operator's own visits and propose a bounded update.";
        }
        throw new Error(`Unexpected blocked reprojection prompt: ${prompt}`);
      },
      chooseOption: async (title) => {
        if (title === "START BOUNDARY DRAFTING") return "model";
        if (title === "MAP THE JOB TO REVIEWED STRUCTURE") return "model";
        if (title === "MODEL FOR BOUNDARY DRAFTING") return "current";
        throw new Error(`Unexpected blocked reprojection choice: ${title}`);
      },
      confirm: async (prompt) => {
        if (prompt.includes("reviewed structural context")) return true;
        if (prompt.includes("trusted user scope") || prompt.includes("trusted user/owner predicate")) {
          scopeConfirmations += 1;
          return true;
        }
        throw new Error(`Unexpected blocked reprojection confirmation: ${prompt}`);
      },
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    };
    const chat = testBoundaryAuthoringChat(session);
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      if (scope === "already reviewed") {
        const preview = await prepareBoundaryResourceReviewMutation(root, {
          resource_id: "public.service_visits", principal_key: "principal_id",
          withhold_from_model_fields: ["principal_id"], actor: "operator",
          reason: "Keep the previously reviewed trusted identity private.",
        }, async () => inspection);
        await commitBoundaryResourceReviewMutation(root, preview);
      }
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-5.6-terra",
            apiKey: "session-secret",
          },
          modelReadWorkloadGenerator,
          actionProjectInspector,
          boundaryAuthoringChatFactory: () => chat,
        },
      )).resolves.toBe(0);

      expect(modelReadWorkloadGenerator).toHaveBeenCalledOnce();
      expect(scopeConfirmations).toBe(scope === "new" ? 1 : 0);
      expect(actionProjectInspector.mock.calls.length).toBe(0);
      expect(chat.rememberDetails).toHaveBeenCalledWith(
        "READ PLAN BLOCKED AFTER TRUSTED-SCOPE REVIEW",
        expect.arrayContaining([
          expect.stringContaining("principal_id"),
          "The model-generated Read plan was not saved and Action drafting did not start.",
        ]),
      );
      const reviewed = await loadBoundaryReviewContext(root);
      await expect(listReadWorkloadAnalyses({
        projectRoot: root,
        generatedBoundary: reviewed.candidate,
      })).resolves.toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("accepts reviewed PostgreSQL RLS principal scope for an own-row model job", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-own-row-rls-"));
    const inspection = boundaryInspection();
    inspection.tables[0]!.row_level_security_policies![0]!.using_expression = [
      "(tenant_id = current_setting('app.tenant_id')::uuid",
      "AND app.can_view_customer(tenant_id, current_setting('app.principal')))" ,
    ].join(" ");
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const scopePrompts: string[] = [];
    const modelReadWorkloadGenerator = vi.fn(async (
      input: Parameters<typeof generateModelReadWorkload>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelReadWorkload>>> => {
      const card = buildReadWorkloadPlanCards(input.generatedBoundary)
        .find((candidate) => candidate.plan.resource === "public.service_visits")!;
      const workload = readWorkloadFromPlanCards({ cards: [card], selectedIds: [card.id] });
      return {
        workload,
        analysis: analyzeReadWorkloadSet({ workload, generatedBoundary: input.generatedBoundary }),
        provider: input.provider,
        model: input.model,
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      };
    });
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (prompt.includes("What job are you giving this agent?")) {
          return "Let an authenticated customer inspect only their own service visits.";
        }
        throw new Error(`Unexpected RLS own-row prompt: ${prompt}`);
      },
      chooseOption: async (title) => {
        if (title === "START BOUNDARY DRAFTING") return "model";
        if (title === "MAP THE JOB TO REVIEWED STRUCTURE") return "model";
        if (title === "MODEL FOR BOUNDARY DRAFTING") return "current";
        if (title === "ACTIVATE READ BOUNDARY") return "finish";
        scopePrompts.push(title);
        throw new Error(`Unexpected RLS own-row choice: ${title}`);
      },
      confirm: async (prompt) => {
        if (prompt.includes("reviewed structural context")) return true;
        scopePrompts.push(prompt);
        throw new Error(`Unexpected RLS own-row confirmation: ${prompt}`);
      },
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-5.6-terra",
            apiKey: "session-secret",
          },
          modelReadWorkloadGenerator,
          modelAuthoringNarrator: vi.fn(async () =>
            "The exact own-row Read draft passed Runner validation and remains disabled."),
          boundaryAuthoringChatFactory: () => testBoundaryAuthoringChat(session),
        },
      )).resolves.toBe(0);

      expect(modelReadWorkloadGenerator).toHaveBeenCalledOnce();
      expect(scopePrompts).toEqual([]);
      const reviewed = await loadBoundaryReviewContext(root);
      const resource = reviewed.candidate.pack.resources.find((candidate) =>
        candidate.id === "public.service_visits");
      expect(resource?.principal_key).toBeUndefined();
      expect(resource?.principal_scope).toBeUndefined();
      expect(resource?.rls_session).toEqual({
        tenant_setting: "app.tenant_id",
        principal_setting: "app.principal",
      });
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("lets the model clarify an opaque RLS principal setting before exact Runner confirmation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-own-row-opaque-rls-"));
    const inspection = boundaryInspection();
    inspection.tables[0]!.row_level_security_policies![0]!.using_expression = [
      "(tenant_id = current_setting('app.tenant_id')::uuid",
      "AND app.can_view_customer(tenant_id, current_setting('app.viewer_context')))" ,
    ].join(" ");
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const modelReadWorkloadGenerator = vi.fn(async (
      input: Parameters<typeof generateModelReadWorkload>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelReadWorkload>>> => {
      const card = buildReadWorkloadPlanCards(input.generatedBoundary)
        .find((candidate) => candidate.plan.resource === "public.service_visits")!;
      const workload = readWorkloadFromPlanCards({ cards: [card], selectedIds: [card.id] });
      return {
        workload,
        analysis: analyzeReadWorkloadSet({ workload, generatedBoundary: input.generatedBoundary }),
        provider: input.provider,
        model: input.model,
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      };
    });
    const modelPrincipalScopeInterpreter = vi.fn(async () => ({
      state: "resolved" as const,
      option_id: "candidate_1",
      rationale: "The operator confirmed that this setting carries the signed-in customer identity.",
      correction_used: false,
    }));
    const modelAuthoringNarrator = vi.fn(async (input: {
      nextQuestion?: string;
    }) => input.nextQuestion ?? "The exact disabled draft passed Runner validation.");
    const prompts: string[] = [];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt, options) => {
        prompts.push(prompt);
        if (prompt.includes("What job are you giving this agent?")) {
          return "Let an authenticated customer inspect only their own service visits.";
        }
        if (options?.context?.[0] === "MODEL QUESTION - TRUSTED USER/OWNER SCOPE") {
          return "Yes. app.viewer_context comes from the authenticated customer's signed session.";
        }
        throw new Error(`Unexpected opaque RLS prompt: ${prompt}`);
      },
      chooseOption: async (title) => {
        if (title === "START BOUNDARY DRAFTING") return "model";
        if (title === "MAP THE JOB TO REVIEWED STRUCTURE") return "model";
        if (title === "MODEL FOR BOUNDARY DRAFTING") return "current";
        if (title === "ACTIVATE READ BOUNDARY") return "finish";
        throw new Error(`Unexpected opaque RLS choice: ${title}`);
      },
      confirm: async (prompt) => {
        if (prompt.includes("reviewed structural context")) return true;
        if (prompt.includes("PostgreSQL RLS setting app.viewer_context")) return true;
        throw new Error(`Unexpected opaque RLS confirmation: ${prompt}`);
      },
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-5.6-terra",
            apiKey: "session-secret",
          },
          modelReadWorkloadGenerator,
          modelAuthoringNarrator,
          modelPrincipalScopeInterpreter,
          boundaryAuthoringChatFactory: () => testBoundaryAuthoringChat(session),
        },
      )).resolves.toBe(0);

      expect(modelPrincipalScopeInterpreter).toHaveBeenCalledOnce();
      expect(prompts.some((prompt) => prompt.includes("app.viewer_context"))).toBe(true);
      const reviewed = await loadBoundaryReviewContext(root);
      const resource = reviewed.candidate.pack.resources.find((candidate) =>
        candidate.id === "public.service_visits");
      expect(resource?.principal_key).toBeUndefined();
      expect(resource?.principal_scope).toBeUndefined();
      expect(resource?.rls_session?.principal_setting).toBe("app.viewer_context");
      expect(reviewed.progress?.review_overrides.resources["public.service_visits"]
        ?.principal_rls_setting?.value).toBe("app.viewer_context");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("keeps own-row principal review when a refused model draft falls back to exact cards", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-own-row-fallback-"));
    const inspection = principalScopeInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const scopeReviews: string[][] = [];
    const modelReadWorkloadGenerator = vi.fn(async () => {
      throw new AskError(
        "ASK_REQUIRED_TOOL_NOT_CALLED",
        "The model returned prose instead of the required Read Boundary tool.",
      );
    });
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (prompt.includes("What job are you giving this agent?")) {
          return "Let an authenticated operator inspect only their own service visits.";
        }
        throw new Error(`Unexpected own-row fallback prompt: ${prompt}`);
      },
      chooseOption: async (title) => {
        if (title === "START BOUNDARY DRAFTING") return "model";
        if (title === "MAP THE JOB TO REVIEWED STRUCTURE") return "model";
        if (title === "MODEL FOR BOUNDARY DRAFTING") return "current";
        if (title === "READ BOUNDARY MODEL DRAFT FAILED") return "runner";
        if (title === "RUNNER-GUIDED READ DRAFT") return "use";
        throw new Error(`Unexpected own-row fallback choice: ${title}`);
      },
      confirm: async (prompt, options) => {
        if (prompt.includes("reviewed structural context")) return true;
        if (prompt.includes("trusted user scope") || prompt.includes("trusted user/owner predicate")) {
          scopeReviews.push(options?.context ?? []);
          return true;
        }
        throw new Error(`Unexpected own-row fallback confirmation: ${prompt}`);
      },
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai_compatible",
            model: "qwen2.5:7b",
            baseUrl: "http://127.0.0.1:11434/v1",
          },
          modelReadWorkloadGenerator,
          boundaryAuthoringChatFactory: () => testBoundaryAuthoringChat(session),
        },
      )).resolves.toBe(0);

      expect(modelReadWorkloadGenerator).toHaveBeenCalledOnce();
      expect(scopeReviews).toHaveLength(1);
      expect(scopeReviews[0]?.join("\n")).toContain(
        "public.service_visits -> principal_id (low confidence)",
      );
      const reviewed = await loadBoundaryReviewContext(root);
      expect(reviewed.candidate.pack.resources.find((candidate) =>
        candidate.id === "public.service_visits")?.principal_key).toBe("principal_id");
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("confirms a direct principal meaning once and carries it through mandatory dependent paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-own-row-derived-"));
    const inspection = derivedPrincipalFirstTableInspection(false);
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const scopeReviews: string[][] = [];
    const savedScopeSummaries: string[][] = [];
    const modelReadWorkloadGenerator = vi.fn(async (
      input: Parameters<typeof generateModelReadWorkload>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelReadWorkload>>> => {
      const cards = buildReadWorkloadPlanCards(input.generatedBoundary).filter((candidate) =>
        candidate.plan.resource === "public.orders"
        || candidate.plan.resource === "public.order_items");
      expect(new Set(cards.map((card) => card.plan.resource))).toEqual(
        new Set(["public.orders", "public.order_items"]),
      );
      const workload = readWorkloadFromPlanCards({
        cards,
        selectedIds: cards.map((card) => card.id),
      });
      return {
        workload,
        analysis: analyzeReadWorkloadSet({ workload, generatedBoundary: input.generatedBoundary }),
        provider: input.provider,
        model: input.model,
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      };
    });
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (prompt.includes("What job are you giving this agent?")) {
          return "Let an authenticated operator inspect only their own orders and order items.";
        }
        throw new Error(`Unexpected derived own-row prompt: ${prompt}`);
      },
      chooseOption: async (title) => {
        if (title === "START BOUNDARY DRAFTING") return "model";
        if (title === "MAP THE JOB TO REVIEWED STRUCTURE") return "model";
        if (title === "MODEL FOR BOUNDARY DRAFTING") return "current";
        throw new Error(`Unexpected derived own-row choice: ${title}`);
      },
      confirm: async (prompt, options) => {
        if (prompt.includes("reviewed structural context")) return true;
        if (prompt.includes("trusted user scope") || prompt.includes("trusted user/owner predicate")) {
          scopeReviews.push(options?.context ?? []);
          return true;
        }
        throw new Error(`Unexpected derived own-row confirmation: ${prompt}`);
      },
      present: (title, lines) => {
        if (title === "TRUSTED USER/OWNER SCOPE SAVED") savedScopeSummaries.push(lines);
      },
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-5.6-luna",
            apiKey: "session-secret",
          },
          modelReadWorkloadGenerator,
          modelAuthoringNarrator: vi.fn(async () =>
            "The exact own-row Read draft passed Runner validation and remains disabled."),
          boundaryAuthoringChatFactory: () => testBoundaryAuthoringChat(session),
        },
      )).resolves.toBe(0);

      expect(scopeReviews).toHaveLength(1);
      expect(scopeReviews[0]?.join("\n")).toContain(
        "public.orders -> owner_id (low confidence)",
      );
      expect(savedScopeSummaries).toHaveLength(1);
      expect(savedScopeSummaries[0]?.join("\n")).toContain("2 exact predicates recorded");
      const reviewed = await loadBoundaryReviewContext(root);
      expect(reviewed.candidate.pack.resources.find((candidate) =>
        candidate.id === "public.orders")?.principal_key).toBe("owner_id");
      expect(reviewed.candidate.pack.resources.find((candidate) =>
        candidate.id === "public.order_items")?.principal_scope?.path_id)
        .toBe("order_items_order_id_fkey");
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("pauses an own-row model job instead of guessing between principal candidates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-ambiguous-principal-"));
    const inspection = principalScopeInspection({ ambiguous: true });
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const principalScopeQuestions: string[] = [];
    const modelPrincipalScopeInterpreter = vi.fn()
      .mockResolvedValueOnce({
        state: "clarification",
        question: "Which column is populated from the authenticated operator identity: principal_id or owner_id?",
        correction_used: false,
      })
      .mockResolvedValueOnce({
        state: "none",
        rationale: "The operator did not confirm either exact candidate.",
        correction_used: false,
      });
    const modelAuthoringNarrator = vi.fn(async (
      _input: Parameters<typeof import("./model-authoring-narration.js").narrateValidatedAuthoringStep>[0],
    ) => "Which reviewed column carries the authenticated operator identity for public.service_visits?");
    const modelReadWorkloadGenerator = vi.fn(async (
      input: Parameters<typeof generateModelReadWorkload>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelReadWorkload>>> => {
      const card = buildReadWorkloadPlanCards(input.generatedBoundary)
        .find((candidate) => candidate.plan.resource === "public.service_visits")!;
      const workload = readWorkloadFromPlanCards({ cards: [card], selectedIds: [card.id] });
      return {
        workload,
        analysis: analyzeReadWorkloadSet({ workload, generatedBoundary: input.generatedBoundary }),
        provider: input.provider,
        model: input.model,
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      };
    });
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt, options) => {
        if (prompt.includes("What job are you giving this agent?")) {
          return "Show an authenticated operator only their own service visits.";
        }
        if (options?.context?.[0] === "MODEL QUESTION - TRUSTED USER/OWNER SCOPE") {
          principalScopeQuestions.push(prompt, ...options.context);
          return principalScopeQuestions.length === options.context.length + 1
            ? "Use the owner column."
            : "I cannot confirm which one is bound from authentication.";
        }
        throw new Error(`Unexpected ambiguous-principal prompt: ${prompt}`);
      },
      chooseOption: async (title, choices, options) => {
        if (title === "START BOUNDARY DRAFTING") return "model";
        if (title === "MAP THE JOB TO REVIEWED STRUCTURE") return "model";
        if (title === "MODEL FOR BOUNDARY DRAFTING") return "current";
        throw new Error(`Unexpected ambiguous-principal choice: ${title}`);
      },
      confirm: async (prompt) => {
        if (prompt.includes("reviewed structural context")) return true;
        throw new Error(`Unexpected ambiguous-principal confirmation: ${prompt}`);
      },
      confirmActivation: async () => {
        throw new Error("A paused principal review must not reach activation.");
      },
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-5.6-luna",
            apiKey: "session-secret",
          },
          modelReadWorkloadGenerator,
          modelAuthoringNarrator,
          modelPrincipalScopeInterpreter,
          boundaryAuthoringChatFactory: () => testBoundaryAuthoringChat(session),
        },
      )).resolves.toBe(0);

      expect(modelPrincipalScopeInterpreter).toHaveBeenCalledTimes(2);
      expect(modelPrincipalScopeInterpreter.mock.calls[0]?.[0].options).toEqual(expect.arrayContaining([
        expect.objectContaining({ value: "principal_id", kind: "direct" }),
        expect.objectContaining({ value: "owner_id", kind: "direct" }),
      ]));
      expect(principalScopeQuestions.join("\n")).toContain("column principal_id [low-confidence candidate]");
      expect(principalScopeQuestions.join("\n")).toContain("column owner_id [low-confidence candidate]");
      expect(principalScopeQuestions.join("\n")).toContain(
        "Which column is populated from the authenticated operator identity",
      );
      const scopeNarration = modelAuthoringNarrator.mock.calls
        .map(([call]) => call)
        .find((call) => call.operatorMessage.includes("principal-scope candidates"));
      expect(scopeNarration?.nextQuestion).toMatch(
        /Candidate [12]: column principal_id \[low-confidence candidate\]/u,
      );
      expect(scopeNarration?.nextQuestion).toMatch(
        /Candidate [12]: column owner_id \[low-confidence candidate\]/u,
      );
      const reviewed = await loadBoundaryReviewContext(root);
      expect(reviewed.candidate.pack.resources.find((candidate) =>
        candidate.id === "public.service_visits")?.principal_key).toBeUndefined();
      const pausedResume = await readBoundaryAuthoringResumeState(root, {
        boundary_name: reviewed.candidate.pack.name,
        generation_lock_fingerprint: reviewed.bundle.authority.generation_lock_fingerprint,
        schema_fingerprint: reviewed.bundle.authority.schema_fingerprint,
        role_posture_fingerprint: reviewed.bundle.authority.role_posture_fingerprint,
      });
      expect(pausedResume).toMatchObject({
        status: "ready",
        value: {
          stage: "read_mapping",
          job_intent: "Show an authenticated operator only their own service visits.",
        },
      });
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("resolves an exact numbered principal-scope answer without a second model interpretation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-numbered-principal-"));
    const inspection = principalScopeInspection({ ambiguous: true });
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const modelPrincipalScopeInterpreter = vi.fn(async () => {
      throw new Error("An exact candidate number must resolve without another provider request.");
    });
    const modelAuthoringNarrator = vi.fn(async (input: {
      nextQuestion?: string;
    }) => input.nextQuestion ?? "The exact disabled draft passed Runner validation.");
    const modelReadWorkloadGenerator = vi.fn(async (
      input: Parameters<typeof generateModelReadWorkload>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelReadWorkload>>> => {
      const card = buildReadWorkloadPlanCards(input.generatedBoundary)
        .find((candidate) => candidate.plan.resource === "public.service_visits")!;
      const workload = readWorkloadFromPlanCards({ cards: [card], selectedIds: [card.id] });
      return {
        workload,
        analysis: analyzeReadWorkloadSet({ workload, generatedBoundary: input.generatedBoundary }),
        provider: input.provider,
        model: input.model,
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      };
    });
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt, options) => {
        if (prompt.includes("What job are you giving this agent?")) {
          return "Show an authenticated operator only their own service visits.";
        }
        if (options?.context?.[0] === "MODEL QUESTION - TRUSTED USER/OWNER SCOPE") {
          return "1";
        }
        throw new Error(`Unexpected numbered-principal prompt: ${prompt}`);
      },
      chooseOption: async (title) => {
        if (title === "START BOUNDARY DRAFTING") return "model";
        if (title === "MAP THE JOB TO REVIEWED STRUCTURE") return "model";
        if (title === "MODEL FOR BOUNDARY DRAFTING") return "current";
        if (title === "ACTIVATE READ BOUNDARY") return "finish";
        throw new Error(`Unexpected numbered-principal choice: ${title}`);
      },
      confirm: async (prompt) => {
        if (prompt.includes("reviewed structural context")) return true;
        if (prompt.includes("trusted user/owner predicate")) return true;
        throw new Error(`Unexpected numbered-principal confirmation: ${prompt}`);
      },
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-5.6-terra",
            apiKey: "session-secret",
          },
          modelReadWorkloadGenerator,
          modelAuthoringNarrator,
          modelPrincipalScopeInterpreter,
          boundaryAuthoringChatFactory: () => testBoundaryAuthoringChat(session),
        },
      )).resolves.toBe(0);

      expect(modelPrincipalScopeInterpreter).not.toHaveBeenCalled();
      const reviewed = await loadBoundaryReviewContext(root);
      expect(reviewed.candidate.pack.resources.find((candidate) =>
        candidate.id === "public.service_visits")?.principal_key).toBe("owner_id");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("skips an unrelated shared-reference table without interrupting no-model job mapping", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-job-first-shared-"));
    const inspection = scopedAndSharedReferenceInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const confirmations: string[] = [];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (prompt.includes("What job are you giving this agent?")) return "Describe service visits.";
        if (prompt.includes("Mapping method")) return "2";
        throw new Error(`Unexpected shared-reference job prompt: ${prompt}`);
      },
      confirm: async (prompt) => {
        confirmations.push(prompt);
        if (prompt.includes("Action Boundary")) return false;
        if (prompt.includes("shared reference")) return false;
        throw new Error(`Unexpected shared-reference confirmation: ${prompt}`);
      },
      selectReadWorkloadCards: async (cards) => cards.map((card) => card.id),
      confirmActivation: async () => {
        throw new Error("Job mapping must not activate a shared-reference decision.");
      },
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        { startWithAgentJob: true },
      )).resolves.toBe(0);

      expect(confirmations).not.toContain("Review 1 job-matched shared-reference table now?");
      expect(confirmations.some((prompt) => prompt.startsWith("public.reference_catalog"))).toBe(false);
      const context = await loadBoundaryReviewContext(root);
      expect(context.candidate.pack.resources.map((resource) => resource.id))
        .toEqual(["public.service_visits"]);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("requires a human attestation when a no-model job explicitly names a shared-reference table", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-job-first-named-shared-"));
    const inspection = scopedAndSharedReferenceInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const confirmations: string[] = [];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (prompt.includes("What job are you giving this agent?")) {
          return "Compare service visits with reference catalog entries.";
        }
        if (prompt.includes("Mapping method")) return "2";
        throw new Error(`Unexpected named shared-reference job prompt: ${prompt}`);
      },
      confirm: async (prompt) => {
        confirmations.push(prompt);
        if (prompt.includes("Action Boundary")) return false;
        if (prompt.includes("job-matched shared-reference")) return true;
        if (prompt.startsWith("public.reference_catalog")) return true;
        throw new Error(`Unexpected named shared-reference confirmation: ${prompt}`);
      },
      selectReadWorkloadCards: async (cards) => cards.map((card) => card.id),
      confirmActivation: async () => {
        throw new Error("Job mapping must not activate a shared-reference decision.");
      },
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        { startWithAgentJob: true },
      )).resolves.toBe(0);

      expect(confirmations).toContain("Review 1 job-matched shared-reference table now?");
      expect(confirmations.some((prompt) => prompt.startsWith("public.reference_catalog"))).toBe(true);
      const context = await loadBoundaryReviewContext(root);
      expect(context.candidate.pack.resources.map((resource) => resource.id).sort()).toEqual([
        "public.reference_catalog",
        "public.service_visits",
      ]);
      expect(context.candidate.pack.resources.find((resource) => resource.id === "public.reference_catalog")
        ?.shared_reference_scope).toMatchObject({ mode: "shared_reference" });
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("threads one job purpose into prepare-only action authoring without granting either authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-delegation-action-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const choices = [{ action: "workloads" as const }, undefined];
    const answers = [
      "Answer service questions and propose a bounded visit status change.",
    ];
    const actionCalls: Array<Parameters<typeof runActionControlPlane>[0]> = [];
    const accessNotices: Array<BoundaryAccessNotice | undefined> = [];
    const runDelegationActionReview = vi.fn(async (
      actionInput: Parameters<typeof runActionControlPlane>[0],
    ) => {
      const reviewed = await loadBoundaryReviewContext(root);
      expect(reviewed.progress?.confirmed_decisions)
        .toEqual(reviewed.candidate.unresolved_decisions);
      actionCalls.push(actionInput);
      return { state: "closed" as const, source_database_changed: false as const, activated_actions: [] };
    });
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async (_resources, _overview, options) => {
        accessNotices.push(options?.notice);
        return choices.shift();
      },
      editFieldTiers: async () => undefined,
      promptText: async () => answers.shift(),
      chooseOption: async (title, _options, promptOptions) => {
        if (title === "MAP THE JOB TO REVIEWED STRUCTURE") {
          expect(promptOptions?.initialValue).toBe("cards");
          return "cards";
        }
        expect(title).toBe("RUNNER-GUIDED READ DRAFT");
        expect(promptOptions?.initialValue).toBe("use");
        return "use";
      },
      confirm: async (prompt) => {
        if (prompt.includes("Action Boundary")) return true;
        throw new Error(`Deterministic drafting must not request model egress: ${prompt}`);
      },
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access"],
        async () => inspection,
        session,
        undefined,
        {
          actionProjectInspector: async () => inspection,
          runDelegationActionReview,
        },
      )).resolves.toBe(0);

      expect(actionCalls, JSON.stringify(accessNotices, null, 2)).toHaveLength(1);
      expect(actionCalls[0]).toMatchObject({
        projectRoot: root,
        boundaryName: "reviewed_staging",
        initialIntent: "Answer service questions and propose a bounded visit status change.",
        prepareOnly: true,
        actionBoundaryJobIntent: "Answer service questions and propose a bounded visit status change.",
      });
      const delegation = await readDelegationDraft(
        root,
        "answer_service_questions_and_propose_a_bounded_visit_status_chan",
      );
      expect(delegation).toMatchObject({
        state: "disabled",
        actions: [{
          intent: "Answer service questions and propose a bounded visit status change.",
          rehearsal: "not_started",
          state: "disabled",
        }],
        authority_granted: false,
        source_database_changed: false,
      });
      expect(delegation?.actions[0]).not.toHaveProperty("capability");
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("continues one agent job through separate Read and Action activation before MCP handoff", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-complete-job-"));
    const inspection = actionTargetInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const action: GuidedActionInput = {
      capability_name: "maintenance_request.propose_insert_maintenance_requests",
      description: "Propose one bounded maintenance request.",
      resource: "public.maintenance_requests",
      operation: "insert",
      patches: [
        { column: "request_kind", value_source: "argument", argument_name: "request_kind" },
        { column: "estimated_hours", value_source: "argument", argument_name: "estimated_hours", minimum: 1, maximum: 16 },
      ],
      dedup_proposal_column: "id",
      approval_role: "action_reviewer",
      required_approvals: 1,
      authority_posture: "proposal_only",
      writeback: { mode: "none" },
      supervised_worker_execution: false,
      reversible: false,
      confirmed_trusted_scope: true,
    };
    const actionCalls: Array<Parameters<typeof runActionControlPlane>[0]> = [];
    const runDelegationActionReview = vi.fn(async (
      actionInput: Parameters<typeof runActionControlPlane>[0],
    ) => {
      actionCalls.push(actionInput);
      if (actionInput.prepareOnly) {
        const created = await createGuidedActionDraft({
          projectRoot: root,
          action,
          inspection,
          boundaryName: "reviewed_staging",
          allowReviewedPending: true,
          actionBoundaryJobIntent: "Explain service visits and propose creating a bounded maintenance request.",
        });
        await recordGuidedActionPreview({
          projectRoot: root,
          capabilityName: created.draft.capability,
          contractDigest: created.draft.contract_digest,
          actionBoundaryDigest: created.draft.action_boundary_digest!,
          proposalId: "rehearsal-maintenance-request",
          proposalHash: `sha256:${"b".repeat(64)}`,
          sourceDatabaseChanged: false,
        });
        return { state: "closed" as const, source_database_changed: false as const, activated_actions: [] };
      }
      expect(actionInput).toMatchObject({
        initialDraftCapability: action.capability_name,
        exitAfterInitialDraft: true,
      });
      const draft = (await guidedActionStatus(root)).drafts.find((candidate) =>
        candidate.capability === action.capability_name)!;
      const active = await activateGuidedAction({
        projectRoot: root,
        capabilityName: draft.capability,
        expectedDigest: draft.action_boundary_digest!,
        confirmation: `ACTIVATE ${draft.action_boundary_digest}`,
        actor: "job-owner",
        inspection,
      });
      return {
        state: "closed" as const,
        source_database_changed: false as const,
        activated_actions: [active.capability],
      };
    });
    const activationHandoff = vi.fn(async () => 0);
    let boundaryListFallbacks = 0;
    let fallbackNotice: BoundaryAccessNotice | undefined;
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async (_resources, _overview, options) => {
        boundaryListFallbacks += 1;
        fallbackNotice = options?.notice;
        return undefined;
      },
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (prompt.includes("What job are you giving this agent?")) {
          return "Explain service visits and propose creating a bounded maintenance request.";
        }
        throw new Error(`Unexpected one-job text prompt: ${prompt}`);
      },
      chooseOption: async (title, _choices, options) => {
        if (title === "MAP THE JOB TO REVIEWED STRUCTURE") {
          expect(options?.initialValue).toBe("cards");
          return "cards";
        }
        if (title === "RUNNER-GUIDED READ DRAFT") return "use";
        throw new Error(`Unexpected one-job choice: ${title}`);
      },
      confirm: async (prompt, options) => {
        if (prompt.includes("Should this job include an Action Boundary")) {
          expect(options?.defaultValue).toBe(true);
          return true;
        }
        if (prompt.includes("disabled dependency for its Action Boundary")) {
          expect(options?.defaultValue).toBe(true);
          return true;
        }
        throw new Error(`Unexpected one-job confirmation: ${prompt}`);
      },
      confirmActivation: async (prompt) => {
        expect(prompt).toContain('Activate "reviewed_staging" exactly as shown now');
        return true;
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await initializeGuidedProject({ projectRoot: root, build, runnerVersion: "1.8.0" });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        activationHandoff,
        {
          startWithAgentJob: true,
          actionProjectInspector: async () => inspection,
          runDelegationActionReview,
        },
      )).resolves.toBe(0);

      expect(actionCalls).toHaveLength(2);
      expect(boundaryListFallbacks, JSON.stringify(fallbackNotice, null, 2)).toBe(0);
      expect(actionCalls[0]).toMatchObject({ prepareOnly: true });
      expect(actionCalls[1]).toMatchObject({
        initialDraftCapability: action.capability_name,
        exitAfterInitialDraft: true,
      });
      expect(activationHandoff).toHaveBeenCalledOnce();
      await expect(loadActivatedExplorationBoundaries(root)).resolves.toHaveLength(1);
      const actionStatus = await guidedActionStatus(root);
      expect(actionStatus.activations.map((activation) => activation.capability))
        .toEqual([action.capability_name]);
      expect(output).toContain("NEXT AUTHORITY REVIEW - READ BOUNDARY");
      expect(output).toContain("NEXT AUTHORITY REVIEW - ACTION BOUNDARY");
      expect(output).toMatch(/\| Read\s+\| reviewed_staging\s+\| ACTIVE\s+\| Explore/u);
      expect(output).toMatch(/\| Action\s+\| default_action_boundary\s+\| ACTIVE\s+\| Propose/u);
      expect(output).toMatch(/\| Apply\s+\| Source writeback\s+\| NOT ALLOWED\s+\| Cannot apply/u);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("reuses the current Ask model for workload mapping without asking for provider setup again", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-current-model-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const choices = [{ action: "workloads" as const }, undefined];
    const answers = [
      "Report service visit activity.",
    ];
    const prompts: string[] = [];
    const modelChoices: string[] = [];
    const confirms: Array<{ prompt: string; context: string[] }> = [];
    const modelReadWorkloadGenerator = vi.fn(async (
      input: Parameters<typeof generateModelReadWorkload>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelReadWorkload>>> => {
      const card = buildReadWorkloadPlanCards(input.generatedBoundary)[0]!;
      const workload = readWorkloadFromPlanCards({ cards: [card], selectedIds: [card.id] });
      return {
        workload,
        analysis: analyzeReadWorkloadSet({ workload, generatedBoundary: input.generatedBoundary }),
        provider: input.provider,
        model: input.model,
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      };
    });
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => choices.shift(),
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        prompts.push(prompt);
        return answers.shift();
      },
      chooseOption: async (title, options, promptOptions) => {
        if (title === "MAP THE JOB TO REVIEWED STRUCTURE") {
          expect(promptOptions?.initialValue).toBe("model");
          return "model";
        }
        expect(title).toBe("MODEL FOR BOUNDARY DRAFTING");
        expect(promptOptions?.initialValue).toBe("current");
        expect(promptOptions?.requireExplicitSelection).toBe(true);
        modelChoices.push(...options.map((option) => option.label));
        return "current";
      },
      confirm: async (prompt, options) => {
        if (prompt.includes("Action Boundary")) return false;
        confirms.push({ prompt, context: options?.context ?? [] });
        return true;
      },
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access"],
        async () => inspection,
        session,
        undefined,
        {
          modelAuthoringSession: {
            provider: "anthropic",
            model: "claude-current",
            apiKey: "session-secret",
          },
          modelReadWorkloadGenerator,
        },
      )).resolves.toBe(0);

      expect(prompts[0]).toContain("What job are you giving this agent?");
      expect(modelChoices).toContain("Use anthropic[claude-current]");
      expect(prompts.some((prompt) => /Provider:|Model \[|API key environment/.test(prompt))).toBe(false);
      expect(confirms).toHaveLength(1);
      expect(confirms[0]?.prompt).toContain("anthropic[claude-current]");
      expect(confirms[0]?.context).toEqual(expect.arrayContaining([
        expect.stringContaining("reviewed structural metadata"),
        expect.stringContaining("Does not send: rows, observed values, SQL, credentials, or trusted identity values"),
        expect.stringContaining("Model suggestions remain untrusted"),
      ]));
      expect(modelReadWorkloadGenerator).toHaveBeenCalledWith(expect.objectContaining({
        provider: "anthropic",
        model: "claude-current",
        apiKey: "session-secret",
        egressAcknowledged: true,
      }));
      const savedWorkloads = await Promise.all(
        (await fs.readdir(path.join(root, ".synapsor/read-workloads")))
          .filter((name) => name.endsWith(".json"))
          .map((name) => fs.readFile(path.join(root, ".synapsor/read-workloads", name), "utf8")),
      );
      expect(savedWorkloads.join("\n")).not.toContain("session-secret");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("revalidates a saved review without model replanning or clearing its pending review", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-revalidate-reuse-"));
    const inspection = actionTargetInspection();
    const build = buildAutoBoundary({ inspection, project: { root, package_manager: "npm", frameworks: ["node"],
      schema_inputs: [], database_env_names: ["DATABASE_URL"] }, sourceEnv: "DATABASE_URL", inspectedSchema: "public" });
    const prompts: string[] = [];
    const modelReadWorkloadGenerator = vi.fn();
    const modelBoundaryJobPlanner = vi.fn(async () => { throw new Error("A schema repair must not reinterpret the saved business job."); });
    const confirmActivation = vi.fn(async () => false);
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined, editFieldTiers: async () => undefined,
      promptText: async (prompt) => { throw new Error(`Business job must be retained: ${prompt}`); },
      chooseOption: async (title) => { prompts.push(title);
        if (title === "START BOUNDARY DRAFTING") return "resume";
        if (title === "ACTIVATE READ BOUNDARY") return "finish";
        throw new Error(`Unexpected revalidation menu: ${title}`);
      }, confirm: async () => true, confirmActivation, confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const context = await loadBoundaryReviewContext(root);
      await writeBoundaryAuthoringResumeState(root, buildBoundaryAuthoringResumeState({
        binding: { boundary_name: context.candidate.pack.name,
          generation_lock_fingerprint: context.bundle.authority.generation_lock_fingerprint,
          schema_fingerprint: `sha256:${"0".repeat(64)}`, role_posture_fingerprint: context.bundle.authority.role_posture_fingerprint },
        stage: "authority_review", jobIntent: "Keep the reviewed maintenance request reads.", provider: "openai", model: "gpt-test",
      }));
      await expect(boundaryReviewCommandInternal(["--project-root", root, "--access", "--job-first"],
        async () => inspection, session, undefined, {
          startWithAgentJob: true, modelAuthoringSession: { provider: "openai", model: "gpt-test", apiKey: "session-secret" },
          modelBoundaryJobPlanner,
          modelReadWorkloadGenerator, modelAuthoringNarrator: async () => "Review the reconciled Read revision; nothing is active.",
          boundaryAuthoringChatFactory: () => testBoundaryAuthoringChat(session),
        })).resolves.toBe(0);
      expect(modelReadWorkloadGenerator).not.toHaveBeenCalled();
      expect(modelBoundaryJobPlanner).not.toHaveBeenCalled();
      expect(confirmActivation.mock.calls.length + prompts.filter((title) => title === "ACTIVATE READ BOUNDARY").length).toBeGreaterThan(0);
      await expect(fs.access(path.join(root, ".synapsor/boundary-authoring/resume.json"))).resolves.toBeUndefined();
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each([502, 2_000])("reuses exact active reads for a %i-character Action edit without remapping or changing Read authority", async (jobLength) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-action-only-reuse-"));
    const inspection = actionTargetInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const modelReadWorkloadGenerator = vi.fn();
    const operatorJob = "Keep the existing reviewed reads and add only a bounded maintenance-request proposal.".padEnd(jobLength, ".");
    const expandedActionIntent = `Propose inserting one bounded maintenance request. ${"Keep this as proposal-only reviewed Action detail. ".repeat(12)}`;
    expect([...expandedActionIntent].length).toBeGreaterThan(500);
    const modelBoundaryJobPlanner = vi.fn(async () => ({
      state: "planned" as const,
      read_mode: "reuse" as const,
      action_mode: "create" as const,
      action_intent: expandedActionIntent,
      summary: "I will keep the reviewed Read Boundary unchanged and draft only the maintenance proposal.",
      correction_used: false,
      authority_granted: false as const,
      source_database_changed: false as const,
    }));
    const modelActionSuggestionGenerator = vi.fn(async (input) => {
      const assessment = assessActionSuggestion({
        schema_version: ACTION_SUGGESTION_VERSION,
        intent: "Propose inserting one bounded maintenance request.",
        operation: "insert",
        resource: "public.maintenance_requests",
        fields: ["request_kind", "estimated_hours"],
        suggested_by: { kind: "model", provider: "openai", model: "gpt-test" },
      }, input.options.resources);
      return {
        assessment,
        provider: "openai" as const,
        model: "gpt-test",
        authority_granted: false as const,
        source_database_changed: false as const,
      };
    });
    const runDelegationActionReview = vi.fn(async () => ({
      state: "closed" as const,
      source_database_changed: false as const,
      activated_actions: [],
    }));
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (prompt.includes("What job are you giving this agent?")) {
          return operatorJob;
        }
        throw new Error(`Unexpected action-only text prompt: ${prompt}`);
      },
      chooseOption: async (title) => {
        if (title === "START BOUNDARY DRAFTING") return "model";
        if (title === "MODEL FOR BOUNDARY DRAFTING") return "current";
        if (title === "ACTIVATE READ BOUNDARY") return "finish";
        throw new Error(`Unexpected action-only choice: ${title}`);
      },
      confirm: async () => true,
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const generated = (await loadBoundaryReviewContext(root)).candidate;
      const workloadSet = {
        schema_version: READ_WORKLOAD_SET_VERSION,
        name: "maintenance_request_review",
        allowed: [{
          id: "maintenance_request_fields",
          description: "Review bounded maintenance request fields",
          plan: {
            kind: "rows",
            resource: "public.maintenance_requests",
            select: ["request_kind", "estimated_hours"],
            limit: 10,
          },
        }],
        forbidden: [],
        source: { kind: "operator_exact_plan" as const },
      };
      const analysis = analyzeReadWorkloadSet({ workload: workloadSet, generatedBoundary: generated });
      const stored = await storeReadWorkloadAnalysis({
        projectRoot: root,
        generatedBoundary: generated,
        source: workloadSet.source,
        analysis,
      });
      const preview = await prepareReadWorkloadCandidate({
        projectRoot: root,
        workload: stored,
        actor: "test-reviewer",
        reason: "Prepare exact reusable Read revision.",
        schemaInspector: async () => inspection,
      });
      await commitReadWorkloadCandidate({ projectRoot: root, preview });
      const reviewedContext = await loadBoundaryReviewContext(root);
      await saveBoundaryReviewProgress(root, createBoundaryReviewProgress({
        draft: reviewedContext.draft,
        candidate: reviewedContext.candidate,
        confirmedDecisions: reviewedContext.candidate.unresolved_decisions,
        previous: reviewedContext.progress,
        revision: (reviewedContext.progress?.revision ?? 0) + 1,
        actor: "test-reviewer",
      }));
      const digestBefore = explorationBoundaryCandidateDigest((await loadBoundaryReviewContext(root)).candidate);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: (await loadBoundaryReviewContext(root)).candidate,
        expectedDigest: digestBefore,
        actor: "test-reviewer",
        confirmation: `ACTIVATE ${digestBefore}`,
        confirmedDecisions: (await loadBoundaryReviewContext(root)).candidate.unresolved_decisions,
        currentInspection: inspection,
      });
      await fs.rm(path.join(root, ".synapsor/read-workloads"), { recursive: true, force: true });

      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-test",
            apiKey: "session-secret",
          },
          modelBoundaryJobPlanner,
          modelReadWorkloadGenerator,
          modelActionSuggestionGenerator,
          actionProjectInspector: async () => inspection,
          runDelegationActionReview,
          modelAuthoringNarrator: async () => "The exact local Read revision remains unchanged.",
          boundaryAuthoringChatFactory: () => testBoundaryAuthoringChat(session),
        },
      )).resolves.toBe(0);

      expect(modelBoundaryJobPlanner).toHaveBeenCalledWith(expect.objectContaining({
        currentState: expect.objectContaining({
          read: expect.objectContaining({
            authority: "active",
            fully_reviewed: true,
            exact_reusable_revision_count: 1,
          }),
        }),
      }));
      expect(modelReadWorkloadGenerator).not.toHaveBeenCalled();
      expect(modelActionSuggestionGenerator).toHaveBeenCalledOnce();
      expect(modelActionSuggestionGenerator).toHaveBeenCalledWith(expect.objectContaining({
        intent: expandedActionIntent,
      }));
      expect(runDelegationActionReview).toHaveBeenCalledWith(expect.objectContaining({
        prepareOnly: true,
        initialSuggestionId: expect.stringMatching(/^as_/u),
      }));
      const digestAfter = explorationBoundaryCandidateDigest((await loadBoundaryReviewContext(root)).candidate);
      expect(digestAfter).toBe(digestBefore);
      expect((await loadActivatedExplorationBoundaries(root)).find((boundary) =>
        boundary.pack.name === build.exploration_boundary.pack.name)?.activation.digest
      ).toBe(digestBefore);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("resumes a saved disabled Read mapping after Action drafting stops without remapping reads", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-action-resume-"));
    const inspection = principalScopeInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const operatorJob = "Review my scheduled service visits and prepare one verified maintenance follow-up outcome.";
    const modelReadWorkloadGenerator = vi.fn(async (
      input: Parameters<typeof generateModelReadWorkload>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelReadWorkload>>> => {
      const card = buildReadWorkloadPlanCards(input.generatedBoundary).find((candidate) =>
        candidate.plan.kind === "aggregate"
        && candidate.plan.resource === "public.service_visits")!;
      const workload = readWorkloadFromPlanCards({ cards: [card], selectedIds: [card.id] });
      return {
        workload,
        analysis: analyzeReadWorkloadSet({ workload, generatedBoundary: input.generatedBoundary }),
        provider: input.provider,
        model: input.model,
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      };
    });
    let actionDraftAttempt = 0;
    let resumedMessages: string[] | undefined;
    const modelActionRuleGenerator = vi.fn(async (input: Parameters<typeof generateModelActionRuleDraft>[0]) => {
      actionDraftAttempt += 1;
      if (actionDraftAttempt === 1) {
        const answer = await input.askClarification?.(
          "What is the maximum number of automatically approved follow-ups in a rolling 24-hour window?",
        );
        expect(answer).toBe("At most three per customer each rolling 24 hours.");
        await input.onCheckpoint?.(actionRuleAuthoringCheckpoint({
          intent_digest: canonicalJsonDigest(input.intent),
          context_digest: canonicalJsonDigest({ catalog: input.builtCatalog.catalog, read: input.readBoundaryDigest, baseline: null }),
          components: {}, operator_messages: [answer!],
        }));
      } else {
        resumedMessages = input.checkpoint?.operator_messages;
      }
      throw new AskError(
        "ASK_REQUIRED_TOOL_NOT_CALLED",
        "The model did not submit the required verified Action draft.",
      );
    });
    const firstPlanner = vi.fn(async () => ({
      state: "planned" as const,
      read_mode: "create" as const,
      read_intent: "Review the authenticated customer's scheduled service visits.",
      action_mode: "create" as const,
      action_intent: "Prepare one verified maintenance follow-up outcome.",
      action_strategy: "rule_derived" as const,
      summary: "I will map the requested reads and prepare the verified maintenance outcome.",
      correction_used: false,
      authority_granted: false as const,
      source_database_changed: false as const,
    }));
    const metadataEgressPrompts: string[] = [];
    const makeSession = (resume = false): BoundaryReviewInteractiveSession => ({
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (!resume && prompt.includes("What job are you giving this agent?")) return operatorJob;
        if (!resume && prompt.includes("maximum number of automatically approved follow-ups")) {
          return "At most three per customer each rolling 24 hours.";
        }
        throw new Error(`Unexpected resumable Action text prompt: ${prompt}`);
      },
      chooseOption: async (title) => {
        if (title === "START BOUNDARY DRAFTING") return resume ? "resume" : "model";
        if (title === "ACTION BOUNDARY MODEL DRAFT FAILED") return "back";
        throw new Error(`Unexpected resumable Action choice: ${title}`);
      },
      confirm: async (prompt) => {
        if (prompt.startsWith("Send this Boundary-authoring conversation")) {
          metadataEgressPrompts.push(`${resume ? "resume" : "new"}:${prompt}`);
        }
        return true;
      },
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const firstSession = makeSession(false);
      const firstChat = testBoundaryAuthoringChat(firstSession);
      firstChat.streamModel = vi.fn(async () => undefined);
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        firstSession,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-test",
            apiKey: "session-secret",
          },
          modelBoundaryJobPlanner: firstPlanner,
          modelReadWorkloadGenerator,
          modelActionRuleGenerator,
          modelAuthoringNarrator: async () => "The validated Read mapping is saved while Action drafting remains paused.",
          actionProjectInspector: async () => inspection,
          boundaryAuthoringChatFactory: () => firstChat,
        },
      )).resolves.toBe(0);

      expect(modelReadWorkloadGenerator).toHaveBeenCalledOnce();
      expect(modelActionRuleGenerator).toHaveBeenCalledOnce();
      expect(metadataEgressPrompts).toHaveLength(1);
      expect(metadataEgressPrompts[0]).toMatch(/^new:/u);
      expect(firstChat.streamModel).not.toHaveBeenCalledWith([
        "I will map the requested reads and prepare the verified maintenance outcome.",
      ]);
      expect(firstChat.rememberDetails).toHaveBeenCalledWith("BOUNDARY JOB ROUTE", expect.arrayContaining([
        "Read: create",
        "Action: create (rule_derived)",
      ]));
      const savedAfterFailure = await listReadWorkloadAnalyses({
        projectRoot: root,
        generatedBoundary: (await loadBoundaryReviewContext(root)).candidate,
      });
      expect(savedAfterFailure).toHaveLength(1);
      expect(savedAfterFailure[0]).toMatchObject({ state: "ready" });
      expect(savedAfterFailure[0]?.review).toBeUndefined();
      const savedResume = await fs.readFile(
        path.join(root, ".synapsor/boundary-authoring/resume.json"),
        "utf8",
      );
      expect(savedResume).toContain(operatorJob);
      expect(savedResume).toContain("At most three per customer each rolling 24 hours.");
      expect(savedResume).not.toContain("session-secret");
      const resumeContext = await loadBoundaryReviewContext(root);
      const storedResumeState = await readBoundaryAuthoringResumeState(root, {
        boundary_name: resumeContext.candidate.pack.name,
        generation_lock_fingerprint: resumeContext.bundle.authority.generation_lock_fingerprint,
        schema_fingerprint: resumeContext.bundle.authority.schema_fingerprint,
        role_posture_fingerprint: resumeContext.bundle.authority.role_posture_fingerprint,
      });
      expect(storedResumeState.status === "stale" ? storedResumeState.reason : storedResumeState.status).toBe("ready");
      if (storedResumeState.status !== "ready") throw new Error("Expected resumable Boundary authoring state.");
      expect(storedResumeState.value).toMatchObject({
        stage: "action_drafting",
        job_intent: operatorJob,
        read_intent: "Review the authenticated customer's scheduled service visits.",
        action: {
          intent: "Prepare one verified maintenance follow-up outcome.",
          strategy: "rule_derived",
        },
      });
      const resumedPlanner = vi.fn(async () => {
        throw new Error("The saved job route must not be planned again.");
      });
      const resumedSession = makeSession(true);
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        resumedSession,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-test",
            apiKey: "session-secret",
          },
          modelBoundaryJobPlanner: resumedPlanner,
          modelReadWorkloadGenerator,
          modelActionRuleGenerator,
          modelAuthoringNarrator: async () => "I retained the exact mapped reads and resumed the Action step.",
          actionProjectInspector: async () => inspection,
          boundaryAuthoringChatFactory: () => testBoundaryAuthoringChat(resumedSession),
        },
      )).resolves.toBe(0);

      expect(modelReadWorkloadGenerator).toHaveBeenCalledOnce();
      expect(modelActionRuleGenerator).toHaveBeenCalledTimes(2);
      expect(resumedPlanner).not.toHaveBeenCalled();
      expect(metadataEgressPrompts).toHaveLength(1);
      expect(resumedMessages).toEqual(["At most three per customer each rolling 24 hours."]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("carries two Boundary-routing clarifications into the third model turn", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-job-two-answers-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const plannerInputs: Array<{ clarificationAnswer?: string }> = [];
    const modelBoundaryJobPlanner = vi.fn(async (plannerInput: { clarificationAnswer?: string }) => {
      plannerInputs.push(plannerInput);
      if (plannerInputs.length === 1) {
        return {
          state: "clarification" as const,
          question: "Should the current reviewed reads remain unchanged?",
          correction_used: false,
          authority_granted: false as const,
          source_database_changed: false as const,
        };
      }
      if (plannerInputs.length === 2) {
        return {
          state: "clarification" as const,
          question: "Should this job prepare an Action Boundary too?",
          correction_used: false,
          authority_granted: false as const,
          source_database_changed: false as const,
        };
      }
      return {
        state: "planned" as const,
        read_mode: "none" as const,
        action_mode: "none" as const,
        summary: "The operator asked to keep the current Boundary state unchanged.",
        correction_used: false,
        authority_granted: false as const,
        source_database_changed: false as const,
      };
    });
    const answers = [
      "Keep the current Boundary state unchanged.",
      "Yes, keep the reviewed reads unchanged.",
      "No, do not prepare an Action Boundary.",
    ];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async () => answers.shift(),
      chooseOption: async (title) => {
        if (title === "START BOUNDARY DRAFTING") return "model";
        throw new Error(`Unexpected two-answer planning choice: ${title}`);
      },
      confirm: async () => true,
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-test",
            apiKey: "session-secret",
          },
          modelBoundaryJobPlanner,
          modelAuthoringNarrator: async () => "Tell me the Boundary job to prepare.",
          boundaryAuthoringChatFactory: () => testBoundaryAuthoringChat(session),
        },
      )).resolves.toBe(0);

      expect(modelBoundaryJobPlanner).toHaveBeenCalledTimes(3);
      expect(plannerInputs[1]?.clarificationAnswer).toContain("Should the current reviewed reads remain unchanged?");
      expect(plannerInputs[1]?.clarificationAnswer).toContain("Yes, keep the reviewed reads unchanged.");
      expect(plannerInputs[2]?.clarificationAnswer).toContain("Should this job prepare an Action Boundary too?");
      expect(plannerInputs[2]?.clarificationAnswer).toContain("No, do not prepare an Action Boundary.");
      expect(plannerInputs[2]?.clarificationAnswer).toContain("Yes, keep the reviewed reads unchanged.");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("offers one bounded retry when typed job planning fails before candidate mutation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-job-plan-retry-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const modelBoundaryJobPlanner = vi.fn()
      .mockRejectedValueOnce(new Error("AUTHORING_CONTEXT_UNAVAILABLE: saved source could not be loaded."))
      .mockResolvedValueOnce({
        state: "planned" as const,
        read_mode: "none" as const,
        action_mode: "none" as const,
        summary: "The current Boundary state already matches this job.",
        correction_used: false,
        authority_granted: false as const,
        source_database_changed: false as const,
      });
    const recoveryOptions: string[] = [];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (prompt.includes("What job are you giving this agent?")) return "Keep the current reviewed Boundary unchanged.";
        throw new Error(`Unexpected planning-retry text prompt: ${prompt}`);
      },
      chooseOption: async (title, options, config) => {
        if (title === "START BOUNDARY DRAFTING") return "model";
        if (title === "BOUNDARY JOB PLANNING DID NOT COMPLETE") {
          expect(config?.context?.join("\n")).toContain("AUTHORING_CONTEXT_UNAVAILABLE");
          expect(config?.context?.join("\n")).not.toContain("did not complete a valid job plan");
          recoveryOptions.push(...options.map((option) => option.value));
          return "retry";
        }
        throw new Error(`Unexpected planning-retry choice: ${title}`);
      },
      confirm: async () => true,
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const digestBefore = explorationBoundaryCandidateDigest((await loadBoundaryReviewContext(root)).candidate);

      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-test",
            apiKey: "session-secret",
          },
          modelBoundaryJobPlanner,
          modelAuthoringNarrator: async () => "Tell me the Boundary job to prepare.",
          boundaryAuthoringChatFactory: () => testBoundaryAuthoringChat(session),
        },
      )).resolves.toBe(0);

      expect(modelBoundaryJobPlanner).toHaveBeenCalledTimes(2);
      expect(recoveryOptions).toEqual(expect.arrayContaining([
        "runner",
        "retry",
        "change_model",
        "details",
        "back",
      ]));
      const digestAfter = explorationBoundaryCandidateDigest((await loadBoundaryReviewContext(root)).candidate);
      expect(digestAfter).toBe(digestBefore);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("pauses safely after an invalid typed job plan without staging a mapping catalog", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-job-plan-pause-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const modelBoundaryJobPlanner = vi.fn(async () => {
      throw new Error("BOUNDARY_JOB_PLAN_INVALID: status must be planned or clarification.");
    });
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (prompt.includes("What job are you giving this agent?")) return "Review service activity and propose one bounded follow-up.";
        throw new Error(`Unexpected planning-pause text prompt: ${prompt}`);
      },
      chooseOption: async (title) => {
        if (title === "START BOUNDARY DRAFTING") return "model";
        if (title === "BOUNDARY JOB PLANNING DID NOT COMPLETE") return "back";
        throw new Error(`Unexpected planning-pause choice: ${title}`);
      },
      confirm: async () => true,
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const contextBefore = await loadBoundaryReviewContext(root);
      const digestBefore = explorationBoundaryCandidateDigest(contextBefore.candidate);
      const revisionBefore = contextBefore.progress?.revision;

      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-test",
            apiKey: "session-secret",
          },
          modelBoundaryJobPlanner,
          modelAuthoringNarrator: async () => "Tell me the Boundary job to prepare.",
          boundaryAuthoringChatFactory: () => testBoundaryAuthoringChat(session),
        },
      )).resolves.toBe(0);

      expect(modelBoundaryJobPlanner).toHaveBeenCalledOnce();
      const contextAfter = await loadBoundaryReviewContext(root);
      expect(explorationBoundaryCandidateDigest(contextAfter.candidate)).toBe(digestBefore);
      expect(contextAfter.progress?.revision).toBe(revisionBefore);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("carries a model-selected action target into exact disabled read review before reusing the suggestion", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-job-action-target-"));
    const inspection = actionTargetInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const answers = [
      "Analyze service visits and propose creating a maintenance request.",
      "",
    ];
    const modelReadWorkloadGenerator = vi.fn(async (
      input: Parameters<typeof generateModelReadWorkload>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelReadWorkload>>> => {
      const cards = buildReadWorkloadPlanCards(input.generatedBoundary);
      const card = cards.find((candidate) =>
        candidate.plan.kind === "aggregate"
        && candidate.plan.resource === "public.service_visits")!;
      const workload = readWorkloadFromPlanCards({ cards: [card], selectedIds: [card.id] });
      return {
        workload,
        analysis: analyzeReadWorkloadSet({ workload, generatedBoundary: input.generatedBoundary }),
        provider: input.provider,
        model: input.model,
        model_message: "I drafted one representative Read plan for reviewed service visits.",
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      };
    });
    let actionAssessment: ReturnType<typeof assessActionSuggestion> | undefined;
    const modelActionSuggestionSetGenerator = vi.fn(async (
      input: Parameters<typeof generateModelActionSuggestionSet>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelActionSuggestionSet>>> => {
      const assessment = assessActionSuggestion({
        schema_version: ACTION_SUGGESTION_VERSION,
        intent: input.jobIntent,
        operation: "insert",
        resource: "public.maintenance_requests",
        fields: ["request_kind", "estimated_hours"],
        suggested_by: { kind: "model", provider: input.provider, model: input.model },
      }, input.options.resources);
      actionAssessment = assessment;
      return {
        assessments: [assessment],
        provider: input.provider,
        model: input.model,
        authority_granted: false,
        source_database_changed: false,
      };
    });
    const runDelegationActionReview = vi.fn(async (reviewInput: Parameters<typeof runActionControlPlane>[0]) => {
      const reviewed = await loadBoundaryReviewContext(root);
      const target = reviewed.candidate.pack.resources.find((resource) =>
        resource.id === "public.maintenance_requests");
      expect(target?.selectable_fields).toEqual(expect.arrayContaining([
        "request_kind",
        "estimated_hours",
      ]));
      expect(reviewInput.modelSuggestionSession?.openingValidatedFacts).toEqual(expect.arrayContaining([
        expect.stringContaining("Read plans (1)"),
        expect.stringContaining("INSERT public.maintenance_requests"),
        expect.stringContaining("Read and Action authority remain off"),
      ]));
      expect(reviewInput.modelSuggestionSession?.openingOperatorMessage).toBe(
        "Analyze service visits and propose creating a maintenance request.",
      );
      return { state: "closed" as const, source_database_changed: false as const, activated_actions: [] };
    });
    const transcript: Array<{ speaker: "model" | "runner" | "check"; lines: string[] }> = [];
    const mappingChoices: string[] = [];
    let installedPermissionGuide: BoundaryAuthoringPermissionGuide | undefined;
    const modelAuthoringNarrator = vi.fn(async (
      input: Parameters<typeof import("./model-authoring-narration.js").narrateValidatedAuthoringStep>[0],
    ) => input.responseStyle === "inspection"
      ? "This activates only the reviewed authority. Would you like Runner to activate it?"
      : "What should this agent be able to read or propose?");
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async () => answers.shift(),
      chooseOption: async (title, choices, options) => {
        if (title === "MODEL FOR BOUNDARY DRAFTING") return "current";
        expect(title).toBe("START BOUNDARY DRAFTING");
        expect(options?.initialValue).toBe("model");
        mappingChoices.push(...choices.map((choice) => choice.value));
        return "model";
      },
      confirm: async () => true,
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-5.6-luna",
            apiKey: "session-secret",
          },
          modelReadWorkloadGenerator,
          modelActionSuggestionSetGenerator,
          modelAuthoringNarrator,
          actionProjectInspector: async () => inspection,
          runDelegationActionReview,
          boundaryAuthoringChatFactory: () => ({
            session,
            actionPrompter: {
              choose: async () => undefined,
              text: async () => undefined,
              confirm: async () => undefined,
              message: async () => undefined,
            },
            setModel: vi.fn(),
            setPermissionGuide: (guide) => {
              installedPermissionGuide = guide;
            },
            runner: vi.fn(),
            model: vi.fn(),
            checkpoint: (title, lines = []) => {
              transcript.push({ speaker: "check", lines: [title, ...lines] });
            },
            streamRunner: async (title, lines = []) => {
              transcript.push({ speaker: "runner", lines: [title, ...lines] });
            },
            streamCheckpoint: async (title, lines = []) => {
              transcript.push({ speaker: "check", lines: [title, ...lines] });
            },
            streamModel: async (lines) => {
              transcript.push({ speaker: "model", lines });
            },
            rememberDetails: vi.fn(),
            showDetails: vi.fn(),
            providerStream: vi.fn(),
            progress: async (_message, operation) => operation(),
            close: vi.fn(),
          }),
        },
      )).resolves.toBe(0);

      expect(modelReadWorkloadGenerator).toHaveBeenCalledOnce();
      expect(modelActionSuggestionSetGenerator).toHaveBeenCalledOnce();
      expect(modelReadWorkloadGenerator).toHaveBeenCalledWith(expect.objectContaining({
        deferNarration: true,
      }));
      expect(modelActionSuggestionSetGenerator).toHaveBeenCalledWith(expect.objectContaining({
        deferNarration: true,
      }));
      expect(installedPermissionGuide).toBeTypeOf("function");
      await expect(installedPermissionGuide?.({
        title: "PERMISSION REQUIRED",
        prompt: "Activate exact digest sha256:deadbeef for this Read Boundary?",
        context: [
          "Boundary: reviewed_staging",
          "Exact fingerprint: sha256:deadbeef",
          "Tenant ID: northstar-mobile",
          "Three reviewed resources; source unchanged",
          "Excluded fields: secret_internal_note, password_hash.",
        ],
        choices: [
          { value: "activate", label: "Activate this exact Read Boundary" },
          { value: "back", label: "Keep disabled" },
        ],
        operatorQuestion: "Why is activation separate?",
      })).resolves.toContain("activates only the reviewed authority");
      const permissionNarration = modelAuthoringNarrator.mock.calls
        .map(([call]) => call)
        .find((call) => call.responseStyle === "inspection");
      expect(permissionNarration).toMatchObject({
        operatorMessage: expect.stringContaining("Why is activation separate?"),
        egressAcknowledged: true,
        responseStyle: "inspection",
      });
      expect(permissionNarration?.nextQuestion).toBeUndefined();
      expect(permissionNarration?.validatedFacts.join("\n")).not.toMatch(/deadbeef|northstar-mobile|secret_internal_note|password_hash/iu);
      expect(mappingChoices).toEqual([
        "model",
        "choose_model",
        "cards",
        "manual",
        "advanced",
      ]);
      expect(actionAssessment?.status, actionAssessment?.blockers.join("; ")).toBe("suggested");
      expect(runDelegationActionReview).toHaveBeenCalledOnce();
      const greetingCall = modelAuthoringNarrator.mock.calls
        .map(([call]) => call)
        .find((call) => call.operatorMessage.includes("current reviewed Boundary state"));
      expect(greetingCall?.validatedFacts.join("\n")).toContain(
        "This is a new conversation, not a resumed model transcript.",
      );
      expect(greetingCall?.validatedFacts.join("\n")).not.toContain(
        "No Read or Action Boundary draft has been created",
      );
      expect(greetingCall?.responseStyle).toBe("opening");
      const readModelIndex = transcript.findIndex((entry) =>
        entry.speaker === "model"
        && entry.lines.some((line) => /representative Read plan/iu.test(line)));
      const actionModelIndex = transcript.findIndex((entry) =>
        entry.speaker === "model"
        && entry.lines.some((line) => line.includes("INSERT public.maintenance_requests")));
      expect(readModelIndex).toBe(-1);
      expect(actionModelIndex).toBe(-1);
      expect(transcript.some((entry) =>
        entry.speaker === "check"
        && entry.lines[0] === "Action drafts validated; model summary unavailable")).toBe(false);
      expect(transcript.filter((entry) => entry.lines[0] === "Runner verified")).toHaveLength(0);
      const reviewed = await loadBoundaryReviewContext(root);
      expect(reviewed.candidate.pack.resources.map((resource) => resource.id).sort()).toEqual([
        "public.maintenance_requests",
        "public.service_visits",
      ]);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it.each(["proposal_only", "supervised", "repair_on_resume", "privacy_retry", "guided_privacy", "guided_privacy_manual_retry_noop", "guided_privacy_manual_retry_change", "decline_privacy", "policy_text", "clarified_privacy", "confirmed_current", "partial_confirmation", "read_correction", "read_correction_failed", "read_correction_retry", "application_clarification", "coverage_failure", "read_only_pivot", "cancel_action", "cancel_coverage", "cancel_read_scope_preview", "cancel_action_scope_preview", "cancel_action_scope_dependency", "cancel_action_scope_commit"] as const)("compiles a rule-derived job into disabled semantic authority bound to the exact reviewed Read revision (%s)", async (posture) => {
    const coverageFailure = posture === "coverage_failure";
    const partialConfirmation = posture === "partial_confirmation";
    const manualGuidedRetryNoop = posture === "guided_privacy_manual_retry_noop";
    const manualGuidedRetryChange = posture === "guided_privacy_manual_retry_change";
    const manualGuidedRetry = manualGuidedRetryNoop || manualGuidedRetryChange;
    const failedReadCorrection = posture === "read_correction_failed" || posture === "read_correction_retry";
    const mechanicalRead = posture === "read_correction" || failedReadCorrection;
    const confirmedCurrent = posture === "confirmed_current" || partialConfirmation || manualGuidedRetryNoop;
    const clarifiedPrivacy = posture === "clarified_privacy" || confirmedCurrent || mechanicalRead || manualGuidedRetry;
    const applicationClarification = posture === "application_clarification";
    const policyText = posture === "policy_text" || (clarifiedPrivacy && !manualGuidedRetry) || applicationClarification || coverageFailure || posture === "cancel_coverage";
    const writeback = posture === "supervised" || posture === "privacy_retry" ? "supervised" : "proposal_only";
    const guidedPrivacy = posture === "guided_privacy" || posture === "decline_privacy";
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-semantic-action-"));
    const cancellation = new AbortController();
    const dependencyCancellation = new AbortController();
    const snapshot = async () => ({
      resume: await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"), "utf8"),
      candidate: (await loadBoundaryReviewContext(root)).bundle.candidate_digest,
      action: await readActionRuleAuthorityDraft(root, "reviewed_staging_rules"),
    });
    let beforeCancellation: Awaited<ReturnType<typeof snapshot>> | undefined;
    const cancelDrafting = async () => {
      beforeCancellation = await snapshot();
      (posture === "cancel_action_scope_dependency" ? dependencyCancellation : cancellation).abort();
      await Promise.resolve();
    };
    const cancelScope = posture === "cancel_read_scope_preview" || posture === "cancel_action_scope_preview"
      || posture === "cancel_action_scope_dependency" || posture === "cancel_action_scope_commit";
    let scopePreview: Awaited<ReturnType<typeof prepareBoundaryReviewMutationBatch>> | undefined;
    let scopeCommits = 0, scopeCommitCompleted = false;
    if (cancelScope) {
      const prepare = boundaryReviewMutations.prepareBoundaryReviewMutationBatch;
      const commit = boundaryReviewMutations.commitBoundaryReviewMutationBatch;
      vi.spyOn(boundaryReviewMutations, "prepareBoundaryReviewMutationBatch").mockImplementation(async (...args) => {
        const target = posture === "cancel_read_scope_preview" ? "public.service_visits" : "public.maintenance_requests";
        if ((posture !== "cancel_read_scope_preview" && semanticActionAttempt === 0)
          || !args[1].some((request) => request.resource_id === target
            && request.reason === "The reviewed job explicitly requires authenticated user/owner row isolation.")) return prepare(...args);
        const before = await snapshot();
        const preview = await prepare(...args);
        expect(await snapshot()).toEqual(before);
        scopePreview = preview;
        if (posture !== "cancel_action_scope_commit") {
          await cancelDrafting();
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(scopeCommits).toBe(0);
        }
        return preview;
      });
      vi.spyOn(boundaryReviewMutations, "commitBoundaryReviewMutationBatch").mockImplementation(async (...args) => {
        if (args[1] !== scopePreview) return commit(...args);
        scopeCommits++;
        if (posture === "cancel_action_scope_commit") beforeCancellation = await snapshot();
        const pending = commit(...args);
        if (posture === "cancel_action_scope_commit") cancellation.abort();
        const result = await pending;
        scopeCommitCompleted = true;
        return result;
      });
    }
    let sourceHandler: ((command: string, argument: string) => Promise<boolean>) | undefined;
    const sourceText = applicationClarification ? "The application captures the customer's selected visit.\nRequire one maintenance reviewer. Do not execute changes."
      : confirmedCurrent ? "Customers may see business status; internal eligibility state stays private.\nRequire one maintenance reviewer. Do not execute changes."
      : clarifiedPrivacy ? "Hide internal visit status from the customer; retain eligibility verification.\nRequire one maintenance reviewer. Do not execute changes."
      : "A scheduled visit may receive one two-hour follow-up.\nRequire two maintenance reviewers. Do not execute changes.";
    if (policyText) await fs.writeFile(path.join(root, "Rules.txt"), sourceText);
    const sourceReviews: string[][] = [];
    let rulesMenuVisits = 0;
    const coverageRequests: string[] = [];
    const inspection = principalScopeInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const operatorJob = "When an authenticated customer's own scheduled service visit needs follow-up, let the agent request one bounded maintenance action."
      + (writeback === "proposal_only" && posture !== "repair_on_resume" ? "" : " Automatically approve and complete eligible follow-ups.")
      + (posture === "repair_on_resume" ? " Do not write refunds or unrelated changes." : "");
    const modelBoundaryJobPlanner = vi.fn(async () => ({
      state: "planned" as const,
      read_mode: "create" as const,
      action_mode: "create" as const,
      action_strategy: "rule_derived" as const,
      read_intent: operatorJob,
      action_intent: operatorJob,
      ...(posture === "cancel_action" ? { action_intents: [operatorJob, "Propose a separate routine follow-up."] } : {}),
      summary: "Draft one reviewed Read Boundary and one verified Action outcome.",
      correction_used: false,
      authority_granted: false as const,
      source_database_changed: false as const,
    }));
    const modelReadWorkloadGenerator = vi.fn(async (
      input: Parameters<typeof generateModelReadWorkload>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelReadWorkload>>> => {
      const card = buildReadWorkloadPlanCards(input.generatedBoundary).find((candidate) =>
        candidate.plan.kind === "aggregate"
        && candidate.plan.resource === "public.service_visits")!;
      const workload = readWorkloadFromPlanCards({ cards: [card], selectedIds: [card.id] });
      return {
        workload,
        analysis: analyzeReadWorkloadSet({ workload, generatedBoundary: input.generatedBoundary }),
        provider: input.provider,
        model: input.model,
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      };
    });
    let semanticActionAttempt = 0;
    let revisionCompiledRequiredApprovals: number | undefined;
    const semanticRecoveryChoices: string[][] = [];
    const semanticRecoveryContexts: string[][] = [];
    const preparedActionPrincipalKeys: Array<string | undefined> = [];
    const clarificationQuestion = "What maximum maintenance proposals may auto-approve in a rolling 24 hours?";
    let clarificationAnswer: string | undefined;
    const modelActionRuleGenerator = vi.fn(async (
      input: Parameters<typeof generateModelActionRuleDraft>[0],
    ): Promise<ModelActionRuleDraftResult> => {
      semanticActionAttempt += 1;
      if (posture === "read_only_pivot") throw new ActionAuthoringReadOnlyRequest("The operator withdrew the pending action and requested Read review only.");
      if (semanticActionAttempt === 1 && posture !== "cancel_action") {
        throw new Error(
          "ACTION_RULE_MODEL_DRAFT_INVALID: Derived UPDATE requires one exact subject target binding.",
        );
      }
      if (semanticActionAttempt === 2) {
        clarificationAnswer = await input.askClarification?.(clarificationQuestion);
        if (clarificationAnswer === "Why does Runner need this limit?") {
          clarificationAnswer = await input.askClarification?.(`It bounds automatic approval. ${clarificationQuestion}`);
        }
      }
      if (input.existingDraft) {
        const revised = structuredClone(input.existingDraft);
        revised.approval.required_approvals = 2;
        revised.review.human_review = "Two maintenance reviewers must approve the proposal.";
        const compiled = compileActionRuleModelDraft({
          draft: revised,
          builtCatalog: input.builtCatalog,
          readBoundary: input.readBoundary,
          readBoundaryDigest: input.readBoundaryDigest,
          activatedAt: "2026-09-03T13:00:00.000Z",
        });
        revisionCompiledRequiredApprovals = compiled.approval_class.required_approvals;
        return {
          state: "ready",
          compiled,
          provider: input.session.provider,
          model: input.session.model,
          correction_used: false,
          clarification_count: 0,
          authority_granted: false,
          source_database_changed: false,
          revision: {
            outcome: revised.outcome,
            changed_phases: ["approval", "rule"],
          },
        };
      }
      let prepared = {
        builtCatalog: input.builtCatalog,
        readBoundary: input.readBoundary,
        readBoundaryDigest: input.readBoundaryDigest,
      };
      if (input.prepareResources) {
        prepared = await input.prepareResources({
          phase: "verification",
          resourceIds: ["public.service_visits"],
        });
        prepared = await input.prepareResources({
          phase: "effect",
          resourceIds: ["public.maintenance_requests"],
        });
        preparedActionPrincipalKeys.push(prepared.builtCatalog.catalog.resources.find((candidate) =>
          candidate.name === "public.maintenance_requests")?.principal_scope_key);
      }
      const resource = (name: string) => prepared.builtCatalog.catalog.resources.find((candidate) => candidate.name === name)!;
      const fieldType = (resourceName: string, fieldName: string) =>
        structuredClone(resource(resourceName).fields.find((field) => field.name === fieldName)!.type);
      const statusType = fieldType("public.service_visits", "status");
      const requestKindType = fieldType("public.maintenance_requests", "request_kind");
      const estimatedHoursType = fieldType("public.maintenance_requests", "estimated_hours");
      const draft: ActionRuleModelDraftV1 = {
        schema_version: "synapsor.action-rule-model-draft.v1",
        name: "maintenance.create_inspection_followup",
        outcome: "maintenance.create_inspection_followup",
        verification: {
          name: "maintenance.create_inspection_followup_verification",
          resources: [{
            binding: "visit",
            resource: "public.service_visits",
            source: { kind: "subject_ref" },
            fields: ["status"],
          }],
        },
        effect: {
          name: "maintenance.create_inspection_followup_effect",
          operation: "insert",
          target_resource: "public.maintenance_requests",
          allowed_fields: [
            { name: "request_kind", values: ["inspection_followup"] },
            { name: "estimated_hours", minimum: 1, maximum: 8 },
          ],
          set: {
            request_kind: { kind: "literal", value: "inspection_followup", value_type: requestKindType },
            estimated_hours: { kind: "literal", value: 2, value_type: estimatedHoursType },
          },
          writeback,
        },
        require: {
          kind: "compare",
          operator: "eq",
          left: { kind: "field", binding: "visit", field: "status" },
          right: { kind: "literal", value: "scheduled", value_type: statusType },
        },
        derive: {},
        approval: {
          class_name: "maintenance.human_followup",
          mode: "human",
          required_role: "maintenance_reviewer",
          required_approvals: 1,
          shared_limits: [],
        },
        ttl_seconds: 300,
        review: {
          when: "The selected service visit is still scheduled.",
          then: "Propose one two-hour inspection follow-up maintenance request.",
          refused: ["The visit is no longer scheduled."],
          human_review: "One maintenance reviewer must approve the proposal.",
          examples: [
            { kind: "eligible", scenario: "Scheduled visit", result: "Create a proposal" },
            { kind: "ineligible", scenario: "Completed visit", result: "Refuse without a proposal" },
          ],
        },
      };
      const compiled = compileActionRuleModelDraft({ draft, ...prepared, activatedAt: "2026-09-03T12:00:00.000Z" });
      if (posture === "cancel_action") await cancelDrafting();
      return {
        state: "ready",
        compiled,
        provider: input.session.provider,
        model: input.session.model,
        correction_used: false,
        clarification_count: 0,
        authority_granted: false,
        source_database_changed: false,
      };
    });
    const legacyActionGenerator = vi.fn();
    const legacyActionReview = vi.fn();
    const readReviewChoiceValues: string[][] = [];
    const boundaryListStarts: Array<boolean | undefined> = [];
    let preRevisionReadDigest: `sha256:${string}` | undefined;
    const manualRetryPrivacyOnly: boolean[] = [];
    const modelReadBoundaryRevisionGenerator = vi.fn(async (
      input: Parameters<typeof generateModelReadBoundaryRevision>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelReadBoundaryRevision>>> => {
      const resource = input.boundary.pack.resources.find((candidate) =>
        candidate.id === "public.service_visits")!;
      expect(resource.selectable_fields).toContain("status");
      expect(resource.kept_out_fields).not.toContain("status");
      expect(resource.model_withheld_fields ?? []).not.toContain("status");
      preRevisionReadDigest = explorationBoundaryCandidateDigest(input.boundary);
      const before = await fs.readFile(path.join(root, ".synapsor/boundary-review-progress.json"), "utf8");
      if (manualGuidedRetry) {
        manualRetryPrivacyOnly.push(Boolean(input.privacyOnly));
        if (modelReadBoundaryRevisionGenerator.mock.calls.length === 1) {
          throw new Error("GUIDED_PRIVACY_RETRY_TEST_UNAVAILABLE");
        }
        const result = await generateModelReadBoundaryRevision({ ...input, dependencies: { requestJson: async () => ({ status: 200,
          body: { output: [{ type: "function_call", call_id: "manual_retry", name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({
            status: manualGuidedRetryNoop ? "already_satisfied" : "revision", resource_changes: [{ resource: resource.id,
              field_exposure: [{ field: "status", exposure: manualGuidedRetryNoop ? "model_and_runner" : "runner_only" }],
            }],
          }) }] },
        }) } });
        expect(await fs.readFile(path.join(root, ".synapsor/boundary-review-progress.json"), "utf8")).toBe(before);
        return result;
      }
      if (failedReadCorrection && modelReadBoundaryRevisionGenerator.mock.calls.length === 1) {
        throw new Error("READ_CORRECTION_TEST_UNAVAILABLE");
      }
      if (posture === "privacy_retry" && modelReadBoundaryRevisionGenerator.mock.calls.length === 2) {
        const clarificationHandler = input.clarificationHandler;
        if (!clarificationHandler) throw new Error("Read revision clarification handler missing");
        await expect(clarificationHandler({
          question: "Is visit status internal eligibility state?",
          reason: "The revision needs the operator's exact privacy meaning.",
        })).resolves.toEqual({ state: "answered", answer: "Visit status is internal eligibility state." });
      }
      if (confirmedCurrent) {
        const result = await generateModelReadBoundaryRevision({ ...input,
          // Exercise a general revision that also confirms an unchanged field.
          ...(partialConfirmation ? { privacyOnly: false } : {}),
          dependencies: { requestJson: async () => ({ status: 200,
          body: { output: [{ type: "function_call", call_id: "same", name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({
            status: partialConfirmation ? "revision" : "already_satisfied", resource_changes: [{ resource: resource.id,
              field_exposure: [{ field: "status", exposure: "model_and_runner" }],
              ...(partialConfirmation ? { settings: { field_metadata: [{ field: "status", label: "Customer status" }] } } : {}),
            }],
          }) }] },
        }) } });
        expect(result.changes).toEqual([]);
        expect(result.confirmed_fields).toHaveLength(1);
        expect(await fs.readFile(path.join(root, ".synapsor/boundary-review-progress.json"), "utf8")).toBe(before);
        return result;
      }
      let attempt = 0;
      expect(input.validateRevision).toBeTypeOf("function");
      const result = await generateModelReadBoundaryRevision({
        ...input,
        dependencies: { requestJson: async (request) => {
          attempt += 1;
          expect(await fs.readFile(path.join(root, ".synapsor/boundary-review-progress.json"), "utf8")).toBe(before);
          if (attempt === 2) expect(JSON.stringify(request)).toContain(input.privacyOnly
            ? "Privacy-only review accepts field privacy reductions" : "settings.selectable_fields removes Runner's access");
          return { status: 200, body: { output: [{
            type: "function_call", call_id: "privacy", name: "runner__submit_read_boundary_revision",
            arguments: JSON.stringify({ resource_changes: [{ resource: resource.id,
              field_exposure: [{ field: "status", exposure: "runner_only" }],
              ...(attempt === 1 || (posture === "privacy_retry" && modelReadBoundaryRevisionGenerator.mock.calls.length === 1)
                ? { settings: { selectable_fields: resource.selectable_fields.filter((field) => field !== "status") } } : {}),
            }] }),
          }] } };
        } },
      });
      expect(attempt).toBe(2);
      expect(result.correction_used).toBe(true);
      expect(await fs.readFile(path.join(root, ".synapsor/boundary-review-progress.json"), "utf8")).toBe(before);
      return result;
    });
    const answers = [operatorJob];
    let readActivationReviewCount = 0;
    const rememberFailureDetails = vi.fn();
    const session: BoundaryReviewInteractiveSession = {
      terminalColumns: 80,
      chooseResource: async (_resources, _overview, options) => {
        boundaryListStarts.push(options?.startAtBoundaryList);
        return undefined;
      },
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (prompt.includes("What job are you giving this agent?")) {
          if (policyText) expect(await sourceHandler?.("/attach", "Rules.txt")).toBe(true);
          return answers.shift();
        }
        if (prompt === clarificationQuestion) return "Why does Runner need this limit?";
        throw new Error(`Unexpected semantic Action text prompt: ${prompt}`);
      },
      chooseOption: async (title, options, choiceOptions) => {
        if (cancellation.signal.aborted || dependencyCancellation.signal.aborted) throw new Error(`Unexpected post-cancellation menu: ${title}`);
        if (posture === "read_only_pivot" && title === "ACTIVATE READ BOUNDARY") {
          readActivationReviewCount++;
          return "finish";
        }
        if (policyText) {
          if (title === "SEND ATTACHED RULES") return "send";
          if (title === "CLIENT INTEGRATION RESPONSIBILITIES") {
            expect(applicationClarification).toBe(true);
            expect(choiceOptions?.initialValue).toBe("back");
            return "assign";
          }
          if (title === "REVIEW ATTACHED RULES") {
            rulesMenuVisits++;
            if (semanticActionAttempt < 3) {
              expect(options.some((option) => option.value === "accept")).toBe(false);
              return rulesMenuVisits === 1 ? "details" : "action:0";
            }
            expect(options.some((option) => option.value === "accept")).toBe(true);
            return "accept";
          }
          if (title === "REVIEW DISABLED ACTION REVISION") {
            expect(choiceOptions?.context?.join("\n")).toContain("approval");
            return "save";
          }
          if (title === "FINISH BOUNDARY REVIEW") {
            if (confirmedCurrent) throw new Error(`No-change reconciliation did not finish: ${JSON.stringify(vi.mocked(semanticChat.rememberDetails).mock.calls)}`);
            expect(options.some((option) => option.value === "activate")).toBe(false);
            expect(choiceOptions?.initialValue).toBe("resolve");
            expect(choiceOptions?.reviewOnly).toBe(true);
            expect(choiceOptions?.context?.join(" ").replace(/\s+/gu, " "), JSON.stringify(vi.mocked(semanticChat.rememberDetails).mock.calls)).toContain("Activation is unavailable");
            if (coverageFailure) return rulesMenuVisits++ === 0 ? "rules" : "finish";
            if (failedReadCorrection) {
              expect(coverageRequests).toHaveLength(2);
              expect(modelReadBoundaryRevisionGenerator).toHaveBeenCalledOnce();
              return posture === "read_correction_retry" && rulesMenuVisits++ === 0 ? "resolve" : "finish";
            }
            return "resolve";
          }
          if (title === "ACTIVATE READ BOUNDARY") {
            expect(options.some((option) => option.value === "more_review")).toBe(true);
            expect(choiceOptions?.context?.join("\n")).toContain("Rules.txt v1");
            expect(semanticActionAttempt).toBe(clarifiedPrivacy || applicationClarification ? 2 : 3);
            return "finish";
          }
        }
        if (title === "START BOUNDARY DRAFTING") return "model";
        if (title === "MODEL FOR BOUNDARY DRAFTING") return "current";
        if (title === "SAVE DISABLED PRIVACY REVISION") {
          if (!partialConfirmation) expect(choiceOptions?.exactDetails?.sections?.[0]?.id).toBe("reductions");
          expect(choiceOptions?.explainOnRequest).toBe(true);
          expect((await loadBoundaryReviewContext(root)).bundle.candidate_digest).toBe(preRevisionReadDigest);
          return posture === "decline_privacy" ? "back" : "save";
        }
        if (title === "ACTION BOUNDARY MODEL DRAFT FAILED") {
          semanticRecoveryChoices.push(options.map((option) => option.value));
          semanticRecoveryContexts.push(choiceOptions?.context ?? []);
          return "retry";
        }
        if (title === "ACTIVATE READ BOUNDARY") {
          const review = choiceOptions?.context?.join(" ").replace(/\s+/gu, " ") ?? "";
          expect(review).toContain("Read review -> Action review");
          expect(review).toContain("read access only");
          expect(review).not.toContain("Action 1:"); // Action rules have their own explicit next review.
          if (posture === "repair_on_resume" || writeback === "supervised") expect(review).toContain("prepared, not enabled; worker required");
          expect(review).not.toMatch(/\+\d+ more|small-group minimum|fields per|1000 queries/u);
          if (writeback === "supervised") expect(review).toContain("-> execution review");
          readReviewChoiceValues.push(options.map((option) => option.value));
          readActivationReviewCount += 1;
          if (manualGuidedRetry) {
            return readActivationReviewCount === 1 ? "more_review"
              : readActivationReviewCount === 2 ? "revise_model" : "finish";
          }
          return readActivationReviewCount <= (posture === "privacy_retry" ? 2 : 1) ? guidedPrivacy ? "more_review" : "revise_model" : "finish";
        }
        if (title === "Review options") {
          expect(options.map((option) => option.value)).toContain("manual_editor");
          return "privacy";
        }
        throw new Error(`Unexpected semantic Action choice: ${title}`);
      },
      confirm: async () => true,
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
      rememberDetails: rememberFailureDetails,
      showReviewDetails: async (_title, lines) => { sourceReviews.push(lines); },
    };
    const modelAuthoringNarrator = vi.fn(async (
      narration: Parameters<typeof import("./model-authoring-narration.js").narrateValidatedAuthoringStep>[0],
    ) => narration.operatorMessage === "Why does Runner need this limit?"
      ? `It bounds automatic approval while proposals outside the limit remain reviewable. ${clarificationQuestion}`
      : narration.responseStyle === "clarification" ? "Should customers see the visit status, or should it stay internal?"
      : "The exact disabled drafts are ready for review.");
    const semanticChat = { ...testBoundaryAuthoringChat(session), signal: cancellation.signal };
    semanticChat.streamCheckpoint = vi.fn(async () => undefined);
    semanticChat.progress = vi.fn(async (_message, operation) => operation());
    const readOperator = vi.fn()
      .mockResolvedValueOnce("Why does Runner need this limit?")
      .mockResolvedValueOnce("At most ten proposals in a rolling 24 hours.");
    if (!manualGuidedRetry) readOperator.mockResolvedValueOnce("Keep the service visit status private for eligibility verification.");
    if (posture === "privacy_retry" || manualGuidedRetry) readOperator.mockResolvedValueOnce("retry");
    if (posture === "privacy_retry") readOperator.mockResolvedValueOnce("Visit status is internal eligibility state.");
    semanticChat.readOperator = readOperator;
    if (policyText) {
      semanticChat.setSourceCommandHandler = (handler) => { sourceHandler = handler; };
      semanticChat.readOperator = vi.fn().mockResolvedValueOnce("One reviewer currently; inspect the attached requirement before activation.")
        .mockResolvedValueOnce(applicationClarification ? "Our client captures and submits the customer's selected visit reference. Preserve the draft."
          : confirmedCurrent ? "Visit status is customer-facing business information. Preserve the existing access, Action rule and execution setup."
          : clarifiedPrivacy ? "Yes, visit status is internal eligibility state; hide it from customers, retaining private verification."
          : "Use two maintenance reviewers as required by the attached rules. Keep this same outcome and all other rules.");
    }
    semanticChat.streamModel = vi.fn(async () => undefined);
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-test",
            apiKey: "session-secret",
            ...(posture === "cancel_action_scope_dependency" ? { dependencies: { signal: dependencyCancellation.signal } } : {}),
            ...(policyText ? { dependencies: { requestJson: async (request: Parameters<NonNullable<import("./model-ask.js").AskProviderDependencies["requestJson"]>>[0]) => {
              coverageRequests.push(JSON.stringify(request.body));
              if (posture === "cancel_coverage") {
                await cancelDrafting();
                throw new Error("ASK_REQUIRED_TOOL_NOT_CALLED");
              }
              if (coverageFailure) throw new Error("COVERAGE_TEST_PROVIDER_UNAVAILABLE");
              if (applicationClarification) return { status: 200, body: { output: [{ type: "function_call", call_id: "coverage", name: "runner__review_policy_coverage",
                arguments: JSON.stringify({ passages: [{ start: 1, end: 1, disposition: "needs_decision",
                  topic: "Customer selection", issue_kind: "missing_configuration", responsibility: "application",
                  application_obligations: ["customer_selection"],
                  interpretation: "The client captures the customer's selection; Runner validates the selected scoped reference.", next_step: "Does your client capture the customer's selected visit before submitting its reference?",
                  draft_paths: ["/runner_evidence/runtime_contract/application_obligations/customer_selection"],
                }, { start: 2, end: 2, disposition: "implemented", interpretation: "One maintenance reviewer; execution is disabled.",
                  draft_paths: ["/actions/0/approval", "/actions/0/effect"] }] }),
              }] } };
              const privateStatus = clarifiedPrivacy && (await loadBoundaryReviewContext(root)).candidate.pack.resources
                .find((resource) => resource.id === "public.service_visits")?.model_withheld_fields?.includes("status");
              if (clarifiedPrivacy) return { status: 200, body: { output: [{ type: "function_call", call_id: "coverage", name: "runner__review_policy_coverage",
                arguments: JSON.stringify({ passages: [{ start: 1, end: 2,
                  disposition: privateStatus || confirmedCurrent && coverageRequests.length > 1 ? "implemented" : "needs_decision",
                  topic: "Internal visit status", issue_kind: coverageRequests.length === 1 && !mechanicalRead ? "schema_meaning" : "contradiction",
                  responsibility: coverageRequests.length === 1 && !mechanicalRead ? "operator" : "runner",
                  interpretation: coverageRequests.length === 1 ? "Is visit status internal eligibility state?" : "Keep internal status private and preserve verification.",
                  next_step: "Is visit status internal eligibility state rather than customer-facing information?",
                  ...(confirmedCurrent && coverageRequests.length > 1 ? {} : { field_checks: [{ resource: "public.service_visits", field: "status", expectation: "private" }] }),
                  draft_paths: ["/read", "/actions/0/approval"],
                }] }),
              }] } };
              return { status: 200, body: { output: [{ type: "function_call", call_id: "coverage", name: "runner__review_policy_coverage",
                arguments: JSON.stringify({ passages: [{ start: 1, end: 2,
                  disposition: semanticActionAttempt < 3 ? "needs_decision" : "implemented",
                  interpretation: semanticActionAttempt < 3 ? "Two reviewers requested; draft has one." : "Two reviewers, no writeback, same valid visit rule.",
                  draft_paths: ["/actions/0/approval", "/actions/0/effect"],
                }] }),
              }] } };
            } } } : {}),
          },
          modelBoundaryJobPlanner,
          modelReadWorkloadGenerator,
          modelReadBoundaryRevisionGenerator,
          modelActionRuleGenerator,
          modelActionSuggestionSetGenerator: legacyActionGenerator,
          runDelegationActionReview: legacyActionReview,
          modelAuthoringNarrator,
          actionProjectInspector: async () => inspection,
          boundaryAuthoringChatFactory: () => semanticChat,
        },
      )).resolves.toBe(0);

      if (cancelScope) {
        expect(scopePreview).toBeDefined();
        expect(scopePreview!.source_database_changed).toBe(false);
        expect(cancellation.signal.aborted).toBe(posture !== "cancel_action_scope_dependency");
        expect(dependencyCancellation.signal.aborted).toBe(posture === "cancel_action_scope_dependency");
        expect(beforeCancellation).toBeDefined();
        const after = await snapshot();
        if (posture === "cancel_action_scope_commit") {
          expect(scopeCommits).toBe(1);
          expect(scopeCommitCompleted).toBe(true);
          expect(after.candidate).not.toBe(beforeCancellation!.candidate);
          expect(after.resume).toBe(beforeCancellation!.resume);
          expect(after.action).toEqual(beforeCancellation!.action);
          expect(after.candidate).toBe(scopePreview!.candidate_digest);
        } else {
          expect(scopeCommits).toBe(0);
          expect(scopeCommitCompleted).toBe(false);
          expect(after).toEqual(beforeCancellation);
        }
        expect(semanticChat.streamCheckpoint).toHaveBeenLastCalledWith("Boundary conversation paused.",
          ["Existing authority is unchanged by interruption; saved steps are retained."], "warning");
        expect(semanticChat.close).toHaveBeenCalledOnce();
        expect(modelActionRuleGenerator).toHaveBeenCalledTimes(posture === "cancel_read_scope_preview" ? 0 : 2);
        expect(semanticRecoveryChoices).toHaveLength(posture === "cancel_read_scope_preview" ? 0 : 1);
        expect(modelReadBoundaryRevisionGenerator).not.toHaveBeenCalled();
        expect(legacyActionGenerator).not.toHaveBeenCalled();
        expect(legacyActionReview).not.toHaveBeenCalled();
        expect(readActivationReviewCount).toBe(0);
        await expect(loadActivatedExplorationBoundaries(root)).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }

      if (posture === "cancel_action" || posture === "cancel_coverage") {
        expect(beforeCancellation).toBeDefined();
        expect(await snapshot()).toEqual(beforeCancellation);
        expect(semanticChat.streamCheckpoint).toHaveBeenLastCalledWith("Boundary conversation paused.",
          ["Existing authority is unchanged by interruption; saved steps are retained."], "warning");
        expect(semanticChat.close).toHaveBeenCalledOnce();
        expect(modelActionRuleGenerator).toHaveBeenCalledTimes(posture === "cancel_action" ? 1 : 2);
        expect(semanticRecoveryChoices).toHaveLength(posture === "cancel_action" ? 0 : 1);
        expect(coverageRequests).toHaveLength(posture === "cancel_coverage" ? 1 : 0);
        expect(modelReadBoundaryRevisionGenerator).not.toHaveBeenCalled();
        expect(legacyActionGenerator).not.toHaveBeenCalled();
        expect(legacyActionReview).not.toHaveBeenCalled();
        expect(readActivationReviewCount).toBe(0);
        expect(beforeCancellation?.action === undefined).toBe(posture === "cancel_action");
        if (posture === "cancel_action") {
          expect(vi.mocked(semanticChat.progress).mock.calls.map(([message]) => message)).toContain("Preparing action 1 of 2");
          expect(modelActionRuleGenerator.mock.calls[0]?.[0].pendingIntents).toHaveLength(2);
        }
        await expect(loadActivatedExplorationBoundaries(root)).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }

      if (posture === "read_only_pivot") {
        expect(readActivationReviewCount).toBe(1);
        expect(modelActionRuleGenerator).toHaveBeenCalledOnce();
        expect(modelReadBoundaryRevisionGenerator).not.toHaveBeenCalled();
        const context = await loadBoundaryReviewContext(root);
        const resume = await readBoundaryAuthoringResumeState(root, {
          boundary_name: context.candidate.pack.name, generation_lock_fingerprint: context.bundle.authority.generation_lock_fingerprint,
          schema_fingerprint: context.bundle.authority.schema_fingerprint, role_posture_fingerprint: context.bundle.authority.role_posture_fingerprint });
        expect(resume).toMatchObject({ status: "ready", value: { stage: "authority_review" } });
        if (resume.status !== "ready") throw new Error("Read-only resume missing");
        expect(resume.value.action).toBeUndefined();
        expect(context.candidate.pack.resources.map((resource) => resource.id)).toEqual(["public.service_visits"]);
        expect(await readActionRuleAuthorityDraft(root, "reviewed_staging_rules")).toBeUndefined();
        await expect(loadActivatedExplorationBoundaries(root)).rejects.toMatchObject({ code: "ENOENT" });
        const firstChoose = session.chooseOption!;
        session.chooseOption = async (title, options, choiceOptions) => title === "START BOUNDARY DRAFTING"
          ? "resume" : firstChoose(title, options, choiceOptions);
        let listVisits = 0;
        session.chooseResource = async () => listVisits++ === 0 ? { action: "workloads" } : undefined;
        const manualActivation = vi.fn(async () => false);
        session.confirmActivation = manualActivation;
        await expect(boundaryReviewCommandInternal(
          ["--project-root", root, "--access"], async () => inspection, session, undefined,
          { startWithAgentJob: false,
            modelAuthoringSession: { provider: "openai", model: "gpt-test", apiKey: "session-secret" },
            modelBoundaryJobPlanner, modelReadWorkloadGenerator, modelActionRuleGenerator,
            modelAuthoringNarrator, actionProjectInspector: async () => inspection,
            boundaryAuthoringChatFactory: () => testBoundaryAuthoringChat(session) },
        )).resolves.toBe(0);
        expect(readActivationReviewCount).toBe(2);
        expect(manualActivation).not.toHaveBeenCalled();
        expect(modelActionRuleGenerator).toHaveBeenCalledOnce();
        expect(modelBoundaryJobPlanner).toHaveBeenCalledOnce();
        expect(modelReadWorkloadGenerator).toHaveBeenCalledOnce();
        expect((await loadBoundaryReviewContext(root)).bundle.candidate_digest).toBe(context.bundle.candidate_digest);
        expect(await readActionRuleAuthorityDraft(root, "reviewed_staging_rules")).toBeUndefined();
        await expect(loadActivatedExplorationBoundaries(root)).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }

      if (policyText) {
        if (coverageFailure) {
          expect(sourceReviews.flat().join("\n")).toContain("COVERAGE_TEST_PROVIDER_UNAVAILABLE");
          expect(sourceReviews.flat().join("\n")).toContain("Viewing this record makes no model request");
          expect(coverageRequests).toHaveLength(1);
          expect(rulesMenuVisits).toBe(2);
          expect(await readActionRuleAuthorityDraft(root, "reviewed_staging_rules")).toBeDefined();
          await expect(loadActivatedExplorationBoundaries(root)).rejects.toMatchObject({ code: "ENOENT" });
          return;
        }
        if (applicationClarification) {
          expect(modelActionRuleGenerator).toHaveBeenCalledTimes(2);
          expect(modelReadBoundaryRevisionGenerator).not.toHaveBeenCalled();
          expect(semanticChat.readOperator).toHaveBeenCalledOnce();
          expect(coverageRequests).toHaveLength(1);
          expect(rulesMenuVisits).toBe(0);
          const saved = await readActionRuleAuthorityDraft(root, "reviewed_staging_rules");
          expect(saved?.authority.rules).toHaveLength(1);
          expect(saved?.authority.approval_classes[0]?.required_approvals).toBe(1);
          await expect(loadActivatedExplorationBoundaries(root)).rejects.toMatchObject({ code: "ENOENT" });
          return;
        }
        if (clarifiedPrivacy) {
          expect(modelActionRuleGenerator).toHaveBeenCalledTimes(2);
          expect(modelReadBoundaryRevisionGenerator).toHaveBeenCalledTimes(posture === "read_correction_retry" ? 2 : 1);
          expect(semanticChat.readOperator).toHaveBeenCalledTimes(mechanicalRead ? 1 : 2);
          expect(coverageRequests).toHaveLength(posture === "read_correction_failed" ? 2 : mechanicalRead ? 3 : 2);
          const context = await loadBoundaryReviewContext(root);
          const visit = context.candidate.pack.resources.find((resource) => resource.id === "public.service_visits")!;
          if (confirmedCurrent) {
            expect(visit.model_withheld_fields ?? []).not.toContain("status");
            if (partialConfirmation) expect(context.bundle.candidate_digest).not.toBe(preRevisionReadDigest);
            else {
              expect(context.bundle.candidate_digest).toBe(preRevisionReadDigest);
              expect(vi.mocked(semanticChat.streamModel).mock.calls.flat(2).join("\n")).toContain("No access change was needed");
            }
            expect(vi.mocked(semanticChat.checkpoint).mock.calls.flat(2).join("\n")).not.toContain("Read revision not saved");
            const resumeLoad = await readBoundaryAuthoringResumeState(root, { boundary_name: context.candidate.pack.name,
              generation_lock_fingerprint: context.candidate.generation_lock_fingerprint,
              schema_fingerprint: context.bundle.authority.schema_fingerprint, role_posture_fingerprint: context.bundle.authority.role_posture_fingerprint });
            if (resumeLoad.status !== "ready") throw new Error("No saved interpretation session");
            const restored = await loadPolicySources(root, resumeLoad.value.policy_source_session!);
            expect(restored.read_interpretations?.[0]?.fields).toContainEqual({ resource: "public.service_visits", field: "status", exposure: "model_and_runner" });
            expect(restored.read_interpretations?.[0]?.instruction).toContain("Visit status is customer-facing business information");
            expect(restored.read_interpretations?.[0]?.read_digest).toBe(context.bundle.candidate_digest);
            expect(restored.coverage?.passages[0]?.disposition).toBe("implemented");
            expect(resumeLoad.value.conversation).toContainEqual({
              question: "Should customers see the visit status, or should it stay internal?",
              answer: "Visit status is customer-facing business information. Preserve the existing access, Action rule and execution setup.",
              kind: "clarification",
            });
            if (!partialConfirmation) {
              expect(resumeLoad.value.conversation).toContainEqual({
                question: "Visit status is customer-facing business information. Preserve the existing access, Action rule and execution setup.",
                answer: expect.stringContaining("Confirmed: the checked field settings already match your answer."),
              });
            }
          } else if (posture === "read_correction_failed") {
            expect(visit.model_withheld_fields ?? []).not.toContain("status");
            expect(context.bundle.candidate_digest).toBe(preRevisionReadDigest);
            expect(vi.mocked(semanticChat.rememberDetails).mock.calls.flat(2).join("\n")).toContain("READ_CORRECTION_TEST_UNAVAILABLE");
          } else expect(visit.model_withheld_fields).toContain("status");
          expect(visit.kept_out_fields).toContain("tenant_id");
          const saved = await readActionRuleAuthorityDraft(root, "reviewed_staging_rules");
          expect(saved?.authority.rules).toHaveLength(1);
          expect(saved?.authority.approval_classes[0]?.required_approvals).toBe(1);
          await expect(loadActivatedExplorationBoundaries(root)).rejects.toMatchObject({ code: "ENOENT" });
          expect(rulesMenuVisits).toBe(posture === "read_correction_retry" ? 1 : 0);
          return;
        }
        expect(modelActionRuleGenerator).toHaveBeenCalledTimes(3);
        expect(modelReadBoundaryRevisionGenerator).not.toHaveBeenCalled();
        expect(coverageRequests).toHaveLength(2);
        expect(coverageRequests.every((request) => request.includes("Require two maintenance reviewers"))).toBe(true);
        expect(coverageRequests.every((request) => request.includes("runner_evidence") && request.includes("read_review") && request.includes("scoped_bindings"))).toBe(true);
        expect(rulesMenuVisits).toBe(0); // same-action clarification does not require inspecting source menus
        const saved = await readActionRuleAuthorityDraft(root, "reviewed_staging_rules");
        expect(saved?.authority.rules).toHaveLength(1);
        expect(saved?.authority.approval_classes[0]?.required_approvals).toBe(2);
        const context = await loadBoundaryReviewContext(root);
        const resumeLoad = await readBoundaryAuthoringResumeState(root, { boundary_name: context.candidate.pack.name,
          generation_lock_fingerprint: context.candidate.generation_lock_fingerprint,
          schema_fingerprint: context.bundle.authority.schema_fingerprint, role_posture_fingerprint: context.bundle.authority.role_posture_fingerprint });
        expect(resumeLoad.status).toBe("ready");
        if (resumeLoad.status !== "ready") throw new Error("Missing source-bound resume");
        const resume = resumeLoad.value;
        expect(resume.policy_source_session).toBeTypeOf("string");
        await fs.unlink(path.join(root, "Rules.txt"));
        const restored = await loadPolicySources(root, resume.policy_source_session!);
        expect(activePolicySource(restored)?.text).toBe(sourceText);
        expect(restored.coverage?.passages[0]?.disposition).toBe("implemented");
        await expect(loadActivatedExplorationBoundaries(root)).rejects.toMatchObject({ code: "ENOENT" });
        expect(semanticChat.checkpoint).toHaveBeenCalledWith("Action revision saved", expect.any(Array));
        return;
      }

      if (manualGuidedRetry) {
        expect(modelReadBoundaryRevisionGenerator).toHaveBeenCalledTimes(2);
        expect(manualRetryPrivacyOnly).toEqual([true, true]);
        const context = await loadBoundaryReviewContext(root);
        const visit = context.candidate.pack.resources.find((resource) => resource.id === "public.service_visits")!;
        expect(visit.kept_out_fields).toContain("tenant_id");
        expect(await readActionRuleAuthorityDraft(root, "reviewed_staging_rules")).toBeDefined();
        await expect(loadActivatedExplorationBoundaries(root)).rejects.toMatchObject({ code: "ENOENT" });
        if (manualGuidedRetryNoop) {
          expect(visit.model_withheld_fields ?? []).not.toContain("status");
          expect(context.bundle.candidate_digest).toBe(preRevisionReadDigest);
        } else {
          expect(visit.model_withheld_fields).toContain("status");
          expect(context.bundle.candidate_digest).not.toBe(preRevisionReadDigest);
        }
        const resume = await readBoundaryAuthoringResumeState(root, {
          boundary_name: context.candidate.pack.name,
          generation_lock_fingerprint: context.candidate.generation_lock_fingerprint,
          schema_fingerprint: context.bundle.authority.schema_fingerprint,
          role_posture_fingerprint: context.bundle.authority.role_posture_fingerprint,
        });
        if (resume.status !== "ready") throw new Error("Manual retry resume missing");
        const conversation = resume.value.conversation.flatMap((turn) => [turn.question, turn.answer]).join("\n");
        expect(conversation).not.toContain("Keep the service visit status private for eligibility verification.");
        expect(conversation).not.toContain("retry");
        return;
      }

      expect(modelBoundaryJobPlanner).toHaveBeenCalledWith(expect.objectContaining({ jobIntent: operatorJob }));
      expect(modelActionRuleGenerator).toHaveBeenCalledTimes(2);
      expect(clarificationAnswer).toBe("At most ten proposals in a rolling 24 hours.");
      expect(semanticChat.readOperator).toHaveBeenCalledTimes(guidedPrivacy ? 2 : posture === "privacy_retry" ? 5 : 3);
      expect(modelReadBoundaryRevisionGenerator).toHaveBeenCalledTimes(posture === "privacy_retry" ? 2 : 1);
      if (posture === "decline_privacy") {
        const unchanged = await loadBoundaryReviewContext(root);
        expect(unchanged.bundle.candidate_digest).toBe(preRevisionReadDigest);
        expect(unchanged.candidate.pack.resources[0]!.model_withheld_fields ?? []).not.toContain("status");
        expect(unchanged.candidate.activation).toBe("disabled_unreviewed");
        expect(semanticChat.rememberDetails).not.toHaveBeenCalledWith("READ BOUNDARY REVISION", expect.anything());
        return;
      }
      if (posture === "privacy_retry") {
        expect(modelReadBoundaryRevisionGenerator.mock.calls[1]![0].instruction).toBe(
          "Keep the service visit status private for eligibility verification.",
        );
        expect(semanticChat.rememberDetails).toHaveBeenCalledWith("READ BOUNDARY REVISION NOT SAVED", expect.arrayContaining([
          expect.stringContaining("settings.selectable_fields removes Runner's access"),
          "The exact disabled Read and Action drafts are unchanged.",
        ]));
        const context = await loadBoundaryReviewContext(root);
        const resume = await readBoundaryAuthoringResumeState(root, {
          boundary_name: context.candidate.pack.name,
          generation_lock_fingerprint: context.candidate.generation_lock_fingerprint,
          schema_fingerprint: context.bundle.authority.schema_fingerprint,
          role_posture_fingerprint: context.bundle.authority.role_posture_fingerprint,
        });
        if (resume.status !== "ready") throw new Error("Manual revision resume missing");
        expect(resume.value.conversation).toContainEqual({
          question: "What should change in this Read Boundary?",
          answer: "Keep the service visit status private for eligibility verification.",
          kind: "clarification",
        });
        expect(resume.value.conversation).toContainEqual({
          question: "Is visit status internal eligibility state?",
          answer: "Visit status is internal eligibility state.",
          kind: "clarification",
        });
      }
      const readRevisionDetails = vi.mocked(semanticChat.rememberDetails).mock.calls
        .find(([title]) => title === "READ BOUNDARY REVISION");
      expect(readRevisionDetails, JSON.stringify(vi.mocked(semanticChat.rememberDetails).mock.calls)).toEqual([
        "READ BOUNDARY REVISION",
        expect.arrayContaining([
          expect.stringContaining("public.service_visits.status: values hidden from agent"),
          expect.stringMatching(/^Read digest changed: sha256:.+ -> sha256:.+$/),
          "Dependent Action revision: rebuilt and revalidated against the new exact Read digest",
          "Read authority: unchanged",
          "Action authority: unchanged",
          "Source query executed: no",
          "Source database changed: no",
        ]),
      ]);
      expect(readReviewChoiceValues[0]).toEqual([
        "activate",
        "revise_model",
        "details",
        "finish",
        "more_review",
      ]);
      expect(boundaryListStarts[0]).toBe(true);
      expect(modelAuthoringNarrator).not.toHaveBeenCalledWith(expect.objectContaining({
        operatorMessage: "Why does Runner need this limit?",
        nextQuestion: clarificationQuestion,
      }));
      expect(semanticChat.streamModel).toHaveBeenCalledWith([
        expect.stringContaining("It bounds automatic approval"),
      ]);
      expect(preparedActionPrincipalKeys).toEqual(["principal_id"]);
      expect(semanticRecoveryChoices).toEqual([[
        "retry",
        "change_model",
        "details",
        "back",
      ]]);
      expect(semanticRecoveryContexts[0]?.join("\n")).toContain(
        "Runner could not identify one exact reviewed row for the proposed change. No Action draft was saved.",
      );
      expect(semanticRecoveryContexts[0]?.join("\n")).not.toMatch(/target_binding|subject target binding/iu);
      expect(rememberFailureDetails).toHaveBeenCalledWith(
        "ACTION BOUNDARY MODEL DRAFT FAILED",
        expect.arrayContaining([
          "Runner could not identify one exact reviewed row for the proposed change. No Action draft was saved.",
          "Exact local validation: Derived UPDATE requires one exact subject target binding.",
          "The rejected draft was not saved or executed. No model output became authority and no source query or write ran.",
        ]),
      );
      expect(legacyActionGenerator).not.toHaveBeenCalled();
      expect(legacyActionReview).not.toHaveBeenCalled();
      const reviewed = await loadBoundaryReviewContext(root);
      const exactReadDigest = explorationBoundaryCandidateDigest(reviewed.candidate);
      expect(preRevisionReadDigest).toBeDefined();
      expect(exactReadDigest).not.toBe(preRevisionReadDigest);
      expect(reviewed.candidate.pack.resources.map((resource) => resource.id))
        .not.toContain("public.maintenance_requests");
      expect(reviewed.candidate.pack.resources.find((resource) =>
        resource.id === "public.service_visits")?.principal_key).toBe("principal_id");
      const revisedServiceVisits = reviewed.candidate.pack.resources.find((resource) =>
        resource.id === "public.service_visits")!;
      expect({
        fields: Object.keys(revisedServiceVisits.field_types),
        keptOut: revisedServiceVisits.kept_out_fields,
        runnerOnly: revisedServiceVisits.model_withheld_fields ?? [],
      }).toMatchObject({ runnerOnly: expect.arrayContaining(["status"]) });
      const semantic = await readActionRuleAuthorityDraft(root, "reviewed_staging_rules");
      expect(semantic).toMatchObject({
        state: "disabled",
        authority: {
          action_boundary: { name: "reviewed_staging_actions" },
          rules: [{
            read_boundary_name: "reviewed_staging",
            read_boundary_digest: exactReadDigest,
            rule: { outcome: "maintenance.create_inspection_followup" },
            effect_envelope: { principal_scope_key: "principal_id" },
          }],
        },
      });
      const storedWorkloads = await fs.readdir(path.join(root, ".synapsor/read-workloads"));
      const storedText = (await Promise.all(storedWorkloads
        .filter((name) => name.endsWith(".json"))
        .map((name) => fs.readFile(path.join(root, ".synapsor/read-workloads", name), "utf8"))))
        .join("\n");
      expect(storedText).toContain("semantic_action_subject_1");
      await expect(fs.access(path.join(root, ".synapsor/action-rules/active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      const deferredResumeContext = await loadBoundaryReviewContext(root);
      const deferredResume = await readBoundaryAuthoringResumeState(root, {
        boundary_name: deferredResumeContext.candidate.pack.name,
        generation_lock_fingerprint: deferredResumeContext.bundle.authority.generation_lock_fingerprint,
        schema_fingerprint: deferredResumeContext.bundle.authority.schema_fingerprint,
        role_posture_fingerprint: deferredResumeContext.bundle.authority.role_posture_fingerprint,
      });
      expect(deferredResume).toMatchObject({
        status: "ready",
        value: {
          stage: "authority_review",
          job_intent: operatorJob,
          read: expect.objectContaining({ analysis_id: expect.any(String) }),
          action: {
            intent: operatorJob,
            outcome: "maintenance.create_inspection_followup",
            strategy: "rule_derived",
          },
        },
      });

      const resumedPlanner = vi.fn(async () => {
        throw new Error("Authority review must not re-plan the saved job.");
      });
      let executionPrepared = false;
      const resumedSession: BoundaryReviewInteractiveSession = {
        terminalColumns: 80,
        chooseResource: async () => undefined,
        editFieldTiers: async () => undefined,
        promptText: async (prompt) => {
          throw new Error(`Unexpected resumed semantic Action text prompt: ${prompt}`);
        },
        chooseOption: async (title, choices, options) => {
          if (title === "START BOUNDARY DRAFTING") return "resume";
          if (title === "ACTIVATE READ BOUNDARY") {
            if (posture === "repair_on_resume") {
              expect(options?.context?.join(" ").replace(/\s+/gu, " ")).toContain("execution review (prepared, not enabled; worker required)");
              expect(choices.some((choice) => choice.value === "prepare_execution")).toBe(false);
              executionPrepared = true;
            }
            return "finish";
          }
          throw new Error(`Unexpected resumed semantic Action choice: ${title}`);
        },
        confirm: async () => true,
        confirmActivation: async () => false,
        confirmReviewedDisabled: async () => true,
      };
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        resumedSession,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-test",
            apiKey: "session-secret",
          },
          modelBoundaryJobPlanner: resumedPlanner,
          modelAuthoringNarrator: async () => "The exact existing authority remains unchanged.",
          actionProjectInspector: async () => inspection,
          boundaryAuthoringChatFactory: () => testBoundaryAuthoringChat(resumedSession),
        },
      )).resolves.toBe(0);
      expect(resumedPlanner).not.toHaveBeenCalled();
      expect(modelActionRuleGenerator).toHaveBeenCalledTimes(2);
      if (posture === "repair_on_resume") {
        expect(executionPrepared).toBe(true);
        const updated = await readActionRuleAuthorityDraft(root, "reviewed_staging_rules");
        if (!updated || !semantic) throw new Error("Expected saved Action drafts");
        expect(updated.authority.rules[0]!.effect_envelope.writeback).toMatchObject({ mode: "direct_sql", supervised_worker: "allowed" });
        expect(updated.authority.rules[0]!.rule.require).toEqual(semantic.authority.rules[0]!.rule.require);
        expect(updated.authority.rules[0]!.rule.effect.set).toEqual(semantic.authority.rules[0]!.rule.effect.set);
        expect(updated.authority.approval_classes).toEqual(semantic.authority.approval_classes);
        expect((await loadBoundaryReviewContext(root)).bundle.candidate_digest).toBe(exactReadDigest);
        await expect(fs.access(path.join(root, ".synapsor/action-rules/active.json"))).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        const unchanged = await readActionRuleAuthorityDraft(root, "reviewed_staging_rules");
        expect(unchanged?.digest).toBe(semantic?.digest);
        expect(unchanged?.authority).toEqual(semantic?.authority);
      }

      const revisionJob = "Keep the reviewed reads and change the maintenance outcome to require two reviewers.";
      let revisionReusableReadCount: number | undefined;
      const revisionPlanner = vi.fn(async (plannerInput: {
        currentState: { read: { exact_reusable_revision_count: number } };
      }) => {
        revisionReusableReadCount = plannerInput.currentState.read.exact_reusable_revision_count;
        return {
          state: "planned" as const,
          read_mode: "reuse" as const,
          action_mode: "revise" as const,
          action_strategy: "rule_derived" as const,
          action_outcome: "maintenance.create_inspection_followup",
          action_intent: "Require two maintenance reviewers for the existing inspection follow-up outcome.",
          summary: "Keep the Read Boundary and prepare one disabled approval-policy replacement.",
          correction_used: false,
          authority_granted: false as const,
          source_database_changed: false as const,
        };
      });
      const revisionSession: BoundaryReviewInteractiveSession = {
        chooseResource: async () => undefined,
        editFieldTiers: async () => undefined,
        promptText: async (prompt) => {
          if (prompt.includes("What job are you giving this agent?")) return revisionJob;
          throw new Error(`Unexpected revision text prompt: ${prompt}`);
        },
        chooseOption: async (title) => {
          if (title === "START BOUNDARY DRAFTING") return "model";
          if (title === "ACTIVATE READ BOUNDARY") return "finish";
          throw new Error(`Unexpected revision choice: ${title}`);
        },
        confirm: async () => true,
        confirmActivation: async () => false,
        confirmReviewedDisabled: async () => true,
      };
      const revisionChat = testBoundaryAuthoringChat(revisionSession);
      revisionChat.streamCheckpoint = vi.fn(async () => undefined);
      const revisionNarrator = vi.fn<typeof narrateValidatedAuthoringStep>(async () =>
        "The exact disabled replacement requires two reviewers.");
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        revisionSession,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-test",
            apiKey: "session-secret",
          },
          modelBoundaryJobPlanner: revisionPlanner,
          modelReadWorkloadGenerator,
          modelActionRuleGenerator,
          modelAuthoringNarrator: revisionNarrator,
          actionProjectInspector: async () => inspection,
          boundaryAuthoringChatFactory: () => revisionChat,
        },
      )).resolves.toBe(0);
      expect(revisionPlanner).toHaveBeenCalledTimes(1);
      expect(modelActionRuleGenerator).toHaveBeenCalledTimes(3);
      expect(revisionReusableReadCount).toBe(1);
      const revisionGreeting = revisionNarrator.mock.calls
        .map(([call]) => call)
        .find((call) => call.responseStyle === "opening");
      expect(revisionGreeting?.validatedFacts).toEqual(expect.arrayContaining([
        expect.stringContaining("Current Read Boundary reviewed_staging"),
        expect.stringContaining("Current Action maintenance.create_inspection_followup: disabled"),
        expect.stringContaining("approval history remains in Runner's proposal ledger"),
      ]));
      expect(modelActionRuleGenerator.mock.calls[2]?.[0].existingDraft).toMatchObject({
        outcome: "maintenance.create_inspection_followup",
        effect: {
          operation: "insert",
          target_resource: "public.maintenance_requests",
        },
        approval: { required_approvals: 1 },
      });
      expect(revisionCompiledRequiredApprovals).toBe(2);
      const revisedSemantic = await readActionRuleAuthorityDraft(root, "reviewed_staging_rules");
      expect(revisedSemantic?.authority.approval_classes[0]).toMatchObject({
        required_approvals: 2,
      });
      expect(revisedSemantic?.reviews[0]).toMatchObject({
        human_review: "Two maintenance reviewers must approve the proposal.",
      });
      expect(revisionChat.streamCheckpoint).toHaveBeenCalledWith(
        "Runner-validated Action change",
        expect.arrayContaining([
          "Editing maintenance.create_inspection_followup; INSERT public.maintenance_requests is unchanged.",
          "Human-review quorum: 1 distinct maintenance_reviewer approval -> 2 distinct maintenance_reviewer approvals",
          "The prior active revision remains live until this disabled replacement is explicitly activated.",
        ]),
        "normal",
      );
      const revisionCheckpoint = vi.mocked(revisionChat.streamCheckpoint).mock.calls.find(([title]) =>
        title === "Runner-validated Action change");
      expect(revisionCheckpoint?.[1]).not.toEqual(expect.arrayContaining([
        expect.stringContaining("Private facts"),
      ]));
      expect(revisionChat.rememberDetails).toHaveBeenCalledWith(
        "VERIFIED ACTION OUTCOME",
        expect.arrayContaining([
          "REPLACEMENT OF EXISTING VERIFIED OUTCOME",
          "Human-review quorum: 1 distinct maintenance_reviewer approval -> 2 distinct maintenance_reviewer approvals",
        ]),
      );
      const intents = ["Prepare a three-hour follow-up.", "Prepare a four-hour follow-up."];
      const completedIntents: string[] = [];
      const multiDiagnostics: string[] = [];
      let interruptSecond = true;
      const multiGenerator = vi.fn(async (input: Parameters<typeof generateModelActionRuleDraft>[0]): Promise<ModelActionRuleDraftResult> => {
        if (input.intent === intents[1] && interruptSecond) {
          interruptSecond = false;
          throw new Error("ACTION_RULE_MODEL_DRAFT_CANCELLED");
        }
        const draft = structuredClone(modelActionRuleGenerator.mock.calls[2]![0].existingDraft!);
        const suffix = input.intent === intents[0] ? "three" : "four";
        draft.name = draft.outcome = `maintenance.followup_${suffix}`;
        draft.effect.name = `maintenance.effect_${suffix}`;
        draft.verification.name = `maintenance.verification_${suffix}`;
        const hours = draft.effect.set.estimated_hours!;
        if (hours.kind !== "literal") throw new Error("Expected literal fixture hours.");
        hours.value = suffix === "three" ? 3 : 4;
        draft.review.then = `Propose a ${suffix}-hour follow-up.`;
        let compiled;
        try {
          compiled = compileActionRuleModelDraft({ draft, builtCatalog: input.builtCatalog, readBoundary: input.readBoundary, readBoundaryDigest: input.readBoundaryDigest });
        } catch (error) { multiDiagnostics.push(String(error)); throw error; }
        completedIntents.push(input.intent);
        return { state: "ready", compiled, provider: input.session.provider, model: input.session.model,
          correction_used: false, clarification_count: 0, authority_granted: false, source_database_changed: false };
      });
      const multiPlanner = vi.fn(async () => ({
        state: "planned" as const, read_mode: "reuse" as const, action_mode: "create" as const,
        action_strategy: "rule_derived" as const, action_intent: intents[0]!, action_intents: intents,
        summary: "Reuse the reviewed reads and prepare both new outcomes.", correction_used: false,
        authority_granted: false as const, source_database_changed: false as const,
      }));
      for (const resume of [false, true]) {
        const multiSession: BoundaryReviewInteractiveSession = {
          ...session,
          chooseResource: async (_resources, _overview, options) => { multiDiagnostics.push(JSON.stringify(options)); return undefined; },
          promptText: async () => "Keep the reads and prepare separate three-hour and four-hour follow-up outcomes.",
          chooseOption: async (title, _options, choiceOptions) => {
            multiDiagnostics.push(`${title}: ${(choiceOptions?.context ?? []).join(" ")}`);
            if (title === "START BOUNDARY DRAFTING") return resume ? "resume" : "model";
            if (title === "ACTION BOUNDARY MODEL DRAFT FAILED") return "back";
            if (title === "ACTIVATE READ BOUNDARY") return "finish";
            throw new Error(`Unexpected multi-outcome prompt: ${title}`);
          },
        };
        await boundaryReviewCommandInternal(["--project-root", root, "--access", "--job-first"], async () => inspection,
          multiSession, undefined, {
            startWithAgentJob: true, modelAuthoringSession: { provider: "openai", model: "gpt-test", apiKey: "session-secret" },
            modelBoundaryJobPlanner: multiPlanner, modelReadWorkloadGenerator,
            modelActionRuleGenerator: multiGenerator, modelAuthoringNarrator: revisionNarrator,
            actionProjectInspector: async () => inspection,
            boundaryAuthoringChatFactory: () => testBoundaryAuthoringChat(multiSession),
          });
      }
      expect(multiPlanner).toHaveBeenCalledOnce();
      expect(completedIntents, multiDiagnostics.join("\n")).toEqual(intents);
      expect(multiGenerator).toHaveBeenCalledTimes(3);
      const multiple = await readActionRuleAuthorityDraft(root, "reviewed_staging_rules");
      expect(multiple?.authority.rules.map((entry) => entry.rule.outcome).sort()).toEqual([
        "maintenance.create_inspection_followup", "maintenance.followup_four", "maintenance.followup_three",
      ]);
      const finalReadDigest = explorationBoundaryCandidateDigest((await loadBoundaryReviewContext(root)).candidate);
      expect(multiple?.authority.rules.every((entry) => entry.read_boundary_digest === finalReadDigest)).toBe(true);
      if (posture === "proposal_only") {
        let vocabularyReviewCount = 0;
        const vocabularySession: BoundaryReviewInteractiveSession = { ...resumedSession,
          promptText: async () => "Label visit status as Visit lifecycle. Keep every action and its approval settings unchanged.",
          chooseOption: async (title) => {
            if (title === "START BOUNDARY DRAFTING") return "resume";
            if (title === "ACTIVATE READ BOUNDARY") return vocabularyReviewCount++ === 0 ? "revise_model" : "finish";
            throw new Error(`Unexpected vocabulary revision menu: ${title}`);
          },
        };
        const vocabularyChat = testBoundaryAuthoringChat(vocabularySession);
        vi.spyOn(vocabularyChat, "streamCheckpoint");
        let vocabularyLabel = "Visit lifecycle";
        const vocabularyGenerator: typeof generateModelReadBoundaryRevision = async (input) => generateModelReadBoundaryRevision({
          ...input, dependencies: { requestJson: async () => ({ status: 200,
            body: { output: [{ type: "function_call", call_id: "labels", name: "runner__submit_read_boundary_revision",
              arguments: JSON.stringify({ resource_changes: [{ resource: "public.service_visits",
                settings: { field_metadata: [{ field: "status", label: vocabularyLabel }] } }] }) }] } }) },
        });
        await boundaryReviewCommandInternal(["--project-root", root, "--access", "--job-first"], async () => inspection,
          vocabularySession, undefined, { startWithAgentJob: true,
            modelAuthoringSession: { provider: "openai", model: "gpt-test", apiKey: "session-secret" },
            modelAuthoringNarrator: revisionNarrator, actionProjectInspector: async () => inspection,
            modelReadBoundaryRevisionGenerator: vocabularyGenerator, boundaryAuthoringChatFactory: () => vocabularyChat });
        const labelledRead = (await loadBoundaryReviewContext(root)).candidate;
        const labelledActions = await readActionRuleAuthorityDraft(root, "reviewed_staging_rules");
        expect(vocabularyChat.streamCheckpoint).not.toHaveBeenCalledWith("Read revision not saved", expect.anything(), expect.anything());
        expect(labelledRead.generation_lock_fingerprint).not.toBe(multiple!.authority.catalog.generation_lock_fingerprint);
        expect(labelledActions!.authority.rules).toHaveLength(3);
        expect(labelledActions!.authority.approval_classes).toEqual(multiple!.authority.approval_classes);
        for (const entry of labelledActions!.authority.rules) {
          const previous = multiple!.authority.rules.find((rule) => rule.rule.outcome === entry.rule.outcome)!;
          expect(entry.rule).toEqual(previous.rule);
          expect(entry.effect_envelope).toEqual(previous.effect_envelope);
          expect(entry.verification_boundary).toEqual({ ...previous.verification_boundary,
            generation_lock_fingerprint: labelledRead.generation_lock_fingerprint });
          expect(entry.read_boundary_digest).toBe(explorationBoundaryCandidateDigest(labelledRead));
        }
        await expect(fs.access(path.join(root, ".synapsor/action-rules/active.json"))).rejects.toMatchObject({ code: "ENOENT" });
        const splitIntents = ["Complete a scheduled-visit follow-up.", "Send valid exceptions to a reviewer.", "Refuse invalid follow-ups."];
        const splitPlanner = vi.fn(async () => ({ ...await multiPlanner(), action_intent: splitIntents[0]!, action_intents: splitIntents }));
        let pauseSecond = true;
        const splitGenerator = vi.fn(async (input: Parameters<typeof generateModelActionRuleDraft>[0]): Promise<ModelActionRuleDraftResult> => {
          if (input.intent === splitIntents[1] && pauseSecond) {
            pauseSecond = false;
            expect(input.pendingIntents).toEqual(splitIntents.slice(1));
            expect(input.preparedDrafts).toHaveLength(1);
            throw new Error("ACTION_RULE_MODEL_DRAFT_CANCELLED");
          }
          expect(input.intent).not.toBe(splitIntents[2]);
          const baseline = input.preparedDrafts?.[0];
          const draft = structuredClone(baseline ?? modelActionRuleGenerator.mock.calls[2]![0].existingDraft!);
          if (baseline) {
            draft.approval.required_approvals = 3;
            draft.review.human_review = "Three maintenance reviewers review the same follow-up.";
          } else {
            draft.name = draft.outcome = "maintenance.same_followup";
            draft.effect.name = "maintenance.same_followup_effect";
            draft.verification.name = "maintenance_same_followup_verification";
            draft.approval.class_name = "maintenance.same_followup_approval";
            draft.effect.writeback = "supervised";
          }
          return { state: "ready", compiled: compileActionRuleModelDraft({ draft, ...input }),
            provider: input.session.provider, model: input.session.model, correction_used: false,
            clarification_count: 0, authority_granted: false, source_database_changed: false,
            ...(baseline ? { revision: { outcome: baseline.outcome, changed_phases: ["approval", "rule"],
              reopened_draft: { outcome: baseline.outcome, digest: canonicalJsonDigest(baseline), covered_intent_indexes: [0, 1] } } } : {}),
          };
        });
        const splitContexts: string[] = [];
        const splitChats: BoundaryAuthoringChat[] = [];
        for (const resume of [false, true, true]) {
          const splitSession: BoundaryReviewInteractiveSession = { ...session,
            chooseResource: async () => undefined,
            promptText: async () => "One follow-up action: routine completion, human fallback and invalid refusal.",
            chooseOption: async (title, _options, options) => {
              splitContexts.push(`${title}: ${(options?.context ?? []).join(" ")}`);
              if (title === "START BOUNDARY DRAFTING") return resume ? "resume" : "model";
              if (title === "ACTIVATE READ BOUNDARY") return "finish";
              if (title === "ACTION BOUNDARY MODEL DRAFT FAILED") return "back";
              throw new Error(`Unexpected same-action review: ${title}`);
            },
          };
          const chat = testBoundaryAuthoringChat(splitSession);
          vi.spyOn(chat, "streamCheckpoint");
          splitChats.push(chat);
          await boundaryReviewCommandInternal(["--project-root", root, "--access", "--job-first"], async () => inspection,
            splitSession, undefined, { startWithAgentJob: true,
              modelAuthoringSession: { provider: "openai", model: "gpt-test", apiKey: "session-secret" },
              modelBoundaryJobPlanner: splitPlanner, modelReadWorkloadGenerator,
              modelActionRuleGenerator: splitGenerator, modelAuthoringNarrator: revisionNarrator,
              actionProjectInspector: async () => inspection, boundaryAuthoringChatFactory: () => chat,
            });
        }
        expect(splitPlanner, splitContexts.join("\n")).toHaveBeenCalledOnce();
        expect(splitGenerator, splitContexts.join("\n")).toHaveBeenCalledTimes(3);
        const single = await readActionRuleAuthorityDraft(root, "reviewed_staging_rules");
        expect(single?.authority.rules.map((entry) => entry.rule.outcome).sort()).toEqual([
          "maintenance.create_inspection_followup", "maintenance.followup_four", "maintenance.followup_three", "maintenance.same_followup",
        ]);
        expect(single?.authority.approval_classes.find((entry) => entry.name === "maintenance.same_followup_approval")?.required_approvals).toBe(3);
        const savedResume = JSON.parse(await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"), "utf8"));
        expect(savedResume.action.intents).toEqual([splitIntents[0]]);
        expect(savedResume.action.completed_outcomes).toEqual(["maintenance.same_followup"]);
        expect(splitChats[1]!.streamCheckpoint).toHaveBeenCalledWith("One Action draft; policy clarification incorporated",
          expect.arrayContaining([expect.stringContaining("Human-review quorum:")]), "normal");
        expect(splitContexts.join(" ").replace(/\s+/gu, " ")).toContain("execution review (prepared, not enabled; worker required)");
        await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json"))).rejects.toMatchObject({ code: "ENOENT" });

        vocabularyReviewCount = 0;
        vocabularyLabel = "Reviewed visit lifecycle";
        await boundaryReviewCommandInternal(["--project-root", root, "--access", "--job-first"], async () => inspection,
          vocabularySession, undefined, { startWithAgentJob: true,
            modelAuthoringSession: { provider: "openai", model: "gpt-test", apiKey: "session-secret" },
            modelAuthoringNarrator: async (input) => {
              if (input.validatedFacts.some((fact) => fact.startsWith("Runner validated and saved"))) {
                throw new Error("Model narration unavailable after the revision was persisted.");
              }
              return revisionNarrator(input);
            }, actionProjectInspector: async () => inspection,
            modelReadBoundaryRevisionGenerator: vocabularyGenerator, boundaryAuthoringChatFactory: () => vocabularyChat });
        const savedRead = (await loadBoundaryReviewContext(root)).candidate;
        const savedActions = await readActionRuleAuthorityDraft(root, "reviewed_staging_rules");
        expect(savedActions!.authority.rules.map((entry) => entry.rule)).toEqual(single!.authority.rules.map((entry) => entry.rule));
        expect(savedActions!.authority.approval_classes).toEqual(single!.authority.approval_classes);
        expect(savedActions!.authority.rules.every((entry) => entry.read_boundary_digest === explorationBoundaryCandidateDigest(savedRead))).toBe(true);
        expect(vocabularyChat.streamCheckpoint).toHaveBeenCalledWith("Read revision saved; review needs recovery",
          expect.arrayContaining([expect.stringContaining("The disabled Read revision was saved, but its review did not finish.")]), "warning");
        expect(vi.mocked(vocabularyChat.streamCheckpoint).mock.calls.flat(2).join("\n")).not.toContain("the prior Action draft is retained");
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(["ASK_REQUIRED_TOOL_NOT_CALLED", "ASK_PROVIDER_RESPONSE_INVALID", "ASK_TOOL_ARGUMENTS_INVALID"])("retries Action drafting after %s without restarting the agent job", async (failureCode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-action-model-retry-"));
    const inspection = actionTargetInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const answers = [
      "Analyze service visits and propose creating a maintenance request.",
      "",
    ];
    const modelReadWorkloadGenerator = vi.fn(async (
      input: Parameters<typeof generateModelReadWorkload>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelReadWorkload>>> => {
      const card = buildReadWorkloadPlanCards(input.generatedBoundary).find((candidate) =>
        candidate.plan.kind === "aggregate"
        && candidate.plan.resource === "public.service_visits")!;
      const workload = readWorkloadFromPlanCards({ cards: [card], selectedIds: [card.id] });
      return {
        workload,
        analysis: analyzeReadWorkloadSet({ workload, generatedBoundary: input.generatedBoundary }),
        provider: input.provider,
        model: input.model,
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      };
    });
    let actionAttempt = 0;
    const modelActionSuggestionSetGenerator = vi.fn(async (
      input: Parameters<typeof generateModelActionSuggestionSet>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelActionSuggestionSet>>> => {
      actionAttempt += 1;
      if (actionAttempt === 1) {
        throw new AskError(
          failureCode,
          "The initial provider response was refused.",
        );
      }
      const assessment = assessActionSuggestion({
        schema_version: ACTION_SUGGESTION_VERSION,
        intent: input.jobIntent,
        operation: "insert",
        resource: "public.maintenance_requests",
        fields: ["request_kind", "estimated_hours"],
        suggested_by: { kind: "model", provider: input.provider, model: input.model },
      }, input.options.resources);
      return {
        assessments: [assessment],
        provider: input.provider,
        model: input.model,
        authority_granted: false,
        source_database_changed: false,
      };
    });
    const recoveryChoices: string[][] = [];
    const runDelegationActionReview = vi.fn(async (
      _reviewInput: Parameters<typeof runActionControlPlane>[0],
    ) => ({
      state: "closed" as const,
      source_database_changed: false as const,
      activated_actions: [],
    }));
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async () => answers.shift(),
      chooseOption: async (title, choices) => {
        if (title === "MAP THE JOB TO REVIEWED STRUCTURE") return "model";
        if (title === "MODEL FOR BOUNDARY DRAFTING") return "current";
        if (title === "ACTION BOUNDARY MODEL DRAFT FAILED") {
          recoveryChoices.push(choices.map((choice) => choice.value));
          return "retry";
        }
        throw new Error(`Unexpected Action Boundary retry choice: ${title}`);
      },
      confirm: async () => true,
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-5.6-luna",
            apiKey: "session-secret",
          },
          modelReadWorkloadGenerator,
          modelActionSuggestionSetGenerator,
          actionProjectInspector: async () => inspection,
          runDelegationActionReview,
        },
      )).resolves.toBe(0);

      expect(modelReadWorkloadGenerator).toHaveBeenCalledOnce();
      expect(modelActionSuggestionSetGenerator).toHaveBeenCalledTimes(2);
      expect(recoveryChoices).toEqual([[
        "retry",
        "change_model",
        "details",
        "runner",
        "back",
      ]]);
      expect(runDelegationActionReview).toHaveBeenCalledOnce();
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("replaces a refused Action Boundary model once and re-confirms structural metadata egress", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-action-model-replacement-"));
    const inspection = actionTargetInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const modelReadWorkloadGenerator = vi.fn(async (
      input: Parameters<typeof generateModelReadWorkload>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelReadWorkload>>> => {
      const card = buildReadWorkloadPlanCards(input.generatedBoundary).find((candidate) =>
        candidate.plan.kind === "aggregate"
        && candidate.plan.resource === "public.service_visits")!;
      const workload = readWorkloadFromPlanCards({ cards: [card], selectedIds: [card.id] });
      return {
        workload,
        analysis: analyzeReadWorkloadSet({ workload, generatedBoundary: input.generatedBoundary }),
        provider: input.provider,
        model: input.model,
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      };
    });
    const attemptedActionModels: string[] = [];
    const modelActionSuggestionSetGenerator = vi.fn(async (
      input: Parameters<typeof generateModelActionSuggestionSet>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelActionSuggestionSet>>> => {
      attemptedActionModels.push(input.model);
      if (input.model === "gpt-5.6-luna") {
        throw new Error(
          "ACTION_SUGGESTION_SET_BLOCKED: Suggestion 1 uses a field outside the reviewed action catalog.",
        );
      }
      const assessment = assessActionSuggestion({
        schema_version: ACTION_SUGGESTION_VERSION,
        intent: input.jobIntent,
        operation: "insert",
        resource: "public.maintenance_requests",
        fields: ["request_kind", "estimated_hours"],
        suggested_by: { kind: "model", provider: input.provider, model: input.model },
      }, input.options.resources);
      return {
        assessments: [assessment],
        provider: input.provider,
        model: input.model,
        authority_granted: false,
        source_database_changed: false,
      };
    });
    let modelChooserCount = 0;
    const egressPrompts: string[] = [];
    const recoveryContexts: string[][] = [];
    const runDelegationActionReview = vi.fn(async (
      _reviewInput: Parameters<typeof runActionControlPlane>[0],
    ) => ({
      state: "closed" as const,
      source_database_changed: false as const,
      activated_actions: [],
    }));
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (prompt.includes("What job are you giving this agent?")) {
          return "Analyze service visits and propose creating a maintenance request.";
        }
        if (prompt.includes("Model for openai")) return "gpt-action-replacement";
        return "";
      },
      chooseOption: async (title, choices, options) => {
        if (title === "MAP THE JOB TO REVIEWED STRUCTURE") return "model";
        if (title === "MODEL FOR BOUNDARY DRAFTING") {
          if (choices.some((choice) => choice.value === "gpt-action-replacement")) {
            return "gpt-action-replacement";
          }
          modelChooserCount += 1;
          return modelChooserCount === 1 ? "current" : "change_model";
        }
        if (title === "ACTION BOUNDARY MODEL DRAFT FAILED") {
          recoveryContexts.push(options?.context ?? []);
          return "change_model";
        }
        throw new Error(`Unexpected Action Boundary replacement choice: ${title}`);
      },
      confirm: async (prompt) => {
        if (prompt.includes("reviewed structural context")) egressPrompts.push(prompt);
        return true;
      },
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-5.6-luna",
            apiKey: "session-secret",
          },
          modelReadWorkloadGenerator,
          modelActionSuggestionSetGenerator,
          modelDiscovery: {
            discoverHostedModels: async () => ["gpt-action-replacement"],
          },
          actionProjectInspector: async () => inspection,
          runDelegationActionReview,
        },
      )).resolves.toBe(0);

      expect(modelReadWorkloadGenerator).toHaveBeenCalledOnce();
      expect(attemptedActionModels).toEqual(["gpt-5.6-luna", "gpt-action-replacement"]);
      expect(egressPrompts).toHaveLength(2);
      expect(egressPrompts[0]).toContain("openai[gpt-5.6-luna]");
      expect(egressPrompts[1]).toContain("openai[gpt-action-replacement]");
      expect(recoveryContexts[0]?.join("\n")).toContain("outside the reviewed action catalog");
      expect(runDelegationActionReview).toHaveBeenCalledOnce();
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it.each(["required_tool", "validation", "mixed", "clarification_paused"] as const)("offers model retry and exact %s details while preserving optional Runner guidance", async (failureKind) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-model-fallback-"));
    const inspection = actionTargetInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const fallbackChoices: string[] = [];
    const fallbackDetails: Array<{ title: string; lines: string[]; tone?: string }> = [];
    const installedPermissionGuides: Array<BoundaryAuthoringPermissionGuide | undefined> = [];
    const runDelegationActionReview = vi.fn(async (
      _reviewInput: Parameters<typeof runActionControlPlane>[0],
    ) => ({
      state: "closed" as const,
      source_database_changed: false as const,
      activated_actions: [],
    }));
    const modelReadWorkloadGenerator = vi.fn(async () => {
      if (failureKind === "clarification_paused") throw new Error(
        "READ_WORKLOAD_CLARIFICATION_DECLINED: no business meaning was supplied for public.service_visits.visit_date; Runner accepted no model draft.",
      );
      if (failureKind !== "required_tool") throw new ReadWorkloadDraftError([
        { attempt: 1, phase: "initial", category: "validation", code: "READ_WORKLOAD_BLOCKED", reasons: ["READ_WORKLOAD_ID_INVALID: allowed[0].id must be one stable lower-case id."] },
        failureKind === "mixed"
          ? { attempt: 2, phase: "correction", category: "provider_response", code: "ASK_TOOL_ARGUMENTS_INVALID", reasons: ["The provider returned malformed tool arguments."] }
          : { attempt: 2, phase: "correction", category: "validation", code: "READ_WORKLOAD_BLOCKED", reasons: ["READ_WORKLOAD_ID_INVALID: allowed[0].id must be one stable lower-case id."] },
      ]);
      throw new AskError(
        "ASK_REQUIRED_TOOL_NOT_CALLED",
        "The local model returned prose instead of the required authoring tool.",
      );
    });
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (prompt.includes("What job are you giving this agent?")) {
          return "Explain service visits and propose creating a maintenance request.";
        }
        throw new Error(`Unexpected model-fallback text prompt: ${prompt}`);
      },
      chooseOption: async (title, _choices, options) => {
        if (title === "START BOUNDARY DRAFTING") return "model";
        if (title === "MAP THE JOB TO REVIEWED STRUCTURE") return "model";
        if (title === "MODEL FOR BOUNDARY DRAFTING") return "current";
        if (title === "READ BOUNDARY MODEL DRAFT FAILED") {
          expect(options?.initialValue).toBe("retry");
          expect(_choices[0]?.value).toBe("retry");
          fallbackChoices.push(title);
          return fallbackChoices.length === 1 ? "details" : "runner";
        }
        if (title === "RUNNER-GUIDED READ DRAFT") return "use";
        throw new Error(`Unexpected model-fallback choice: ${title}`);
      },
      confirm: async () => true,
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
      present: (title, lines, tone) => fallbackDetails.push({ title, lines, tone }),
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai_compatible",
            model: "qwen2.5:7b",
            baseUrl: "http://127.0.0.1:11434/v1",
          },
          modelReadWorkloadGenerator,
          actionProjectInspector: async () => inspection,
          runDelegationActionReview,
          boundaryAuthoringChatFactory: () => ({
            session,
            actionPrompter: {
              choose: async () => undefined,
              text: async () => undefined,
              confirm: async () => undefined,
              message: async () => undefined,
            },
            setModel: vi.fn(),
            setPermissionGuide: (guide) => installedPermissionGuides.push(guide),
            runner: vi.fn(),
            model: vi.fn(),
            checkpoint: vi.fn(),
            streamRunner: async () => undefined,
            streamCheckpoint: async () => undefined,
            streamModel: async () => undefined,
            rememberDetails: vi.fn(),
            showDetails: vi.fn(),
            providerStream: vi.fn(),
            progress: async (_message, operation) => operation(),
            close: vi.fn(),
          }),
        },
      )).resolves.toBe(0);

      expect(modelReadWorkloadGenerator).toHaveBeenCalledOnce();
      expect(fallbackChoices).toEqual([
        "READ BOUNDARY MODEL DRAFT FAILED",
        "READ BOUNDARY MODEL DRAFT FAILED",
      ]);
      expect(fallbackDetails).toContainEqual(expect.objectContaining({
        title: "READ BOUNDARY FAILURE DETAILS",
        tone: "danger",
        lines: expect.arrayContaining([
          expect.stringContaining(failureKind === "required_tool"
            ? "required bounded Read Boundary authoring tool"
            : failureKind === "clarification_paused" ? "READ_WORKLOAD_CLARIFICATION_DECLINED" : "READ_WORKLOAD_ID_INVALID"),
          expect.stringContaining("no source query or write ran"),
          expect.stringContaining("intermediate metadata workspace, not an accepted model draft or active access"),
        ]),
      }));
      const failureText = fallbackDetails.map((detail) => detail.lines.join("\n")).join("\n");
      if (failureKind === "clarification_paused") {
        expect(failureText).toContain("business clarification was left unanswered");
        expect(failureText).not.toContain("submitted a structured Read Boundary draft");
      } else if (failureKind !== "required_tool") {
        expect(failureText).toContain("Attempt 1 (initial)");
        expect(failureText).toContain("Attempt 2 (correction)");
        expect(failureText).not.toContain("did not produce");
        if (failureKind === "mixed") expect(failureText).toContain("ASK_TOOL_ARGUMENTS_INVALID");
      }
      expect(modelReadWorkloadGenerator).toHaveBeenCalledOnce();
      expect(runDelegationActionReview).toHaveBeenCalledOnce();
      expect(runDelegationActionReview).toHaveBeenCalledWith(expect.objectContaining({
        initialIntent: "Explain service visits and propose creating a maintenance request.",
        prepareOnly: true,
      }));
      const reviewInput = runDelegationActionReview.mock.calls[0]?.[0];
      expect(reviewInput).not.toHaveProperty("modelSuggestionSession");
      expect(reviewInput).not.toHaveProperty("modelInterviewEgressAcknowledged");
      expect(installedPermissionGuides[0]).toBeTypeOf("function");
      expect(installedPermissionGuides.at(-1)).toBeUndefined();
      const reviewed = await loadBoundaryReviewContext(root);
      expect(reviewed.candidate.pack.resources.map((resource) => resource.id)).toContain(
        "public.maintenance_requests",
      );
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("continues the same job through Runner guidance when a structured model draft violates reviewed grammar", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-model-grammar-fallback-"));
    const inspection = actionTargetInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const fallbackContexts: string[][] = [];
    const fallbackOptionValues: string[][] = [];
    const runDelegationActionReview = vi.fn(async () => ({
      state: "closed" as const,
      source_database_changed: false as const,
      activated_actions: [],
    }));
    const modelReadWorkloadGenerator = vi.fn(async (
      input: Parameters<typeof generateModelReadWorkload>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelReadWorkload>>> => {
      const workload = {
        schema_version: READ_WORKLOAD_SET_VERSION,
        name: input.name,
        allowed: [{
          id: "too_many_dimensions",
          description: "Count service visits across four dimensions.",
          plan: {
            kind: "aggregate",
            resource: "public.service_visits",
            measures: [{ function: "count" }],
            dimensions: [
              { field: "status" },
              { field: "status" },
              { field: "status" },
              { field: "status" },
            ],
          },
        }],
        forbidden: [],
        source: { kind: "model" as const, provider: input.provider, model: input.model },
      };
      const analysis = analyzeReadWorkloadSet({
        workload,
        generatedBoundary: input.generatedBoundary,
      });
      expect(analysis.status).toBe("blocked");
      return {
        workload,
        analysis,
        provider: input.provider,
        model: input.model,
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      };
    });
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (prompt.includes("What job are you giving this agent?")) {
          return "Explain service visits and propose creating a maintenance request.";
        }
        throw new Error(`Unexpected grammar-fallback text prompt: ${prompt}`);
      },
      chooseOption: async (title, choices, options) => {
        if (title === "MAP THE JOB TO REVIEWED STRUCTURE") return "model";
        if (title === "MODEL FOR BOUNDARY DRAFTING") return "current";
        if (title === "READ BOUNDARY MODEL DRAFT FAILED") {
          expect(options?.initialValue).toBe("retry");
          fallbackContexts.push(options?.context ?? []);
          fallbackOptionValues.push(choices.map((choice) => choice.value));
          return "runner";
        }
        if (title === "RUNNER-GUIDED READ DRAFT") return "use";
        throw new Error(`Unexpected grammar-fallback choice: ${title}`);
      },
      confirm: async () => true,
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-5.6-luna",
            apiKey: "session-secret",
          },
          modelReadWorkloadGenerator,
          actionProjectInspector: async () => inspection,
          runDelegationActionReview,
        },
      )).resolves.toBe(0);

      expect(modelReadWorkloadGenerator).toHaveBeenCalledOnce();
      expect(fallbackContexts).toHaveLength(1);
      expect(fallbackOptionValues).toEqual([[
        "retry",
        "change_model",
        "details",
        "runner",
        "back",
      ]]);
      expect(fallbackContexts[0]?.join("\n")).toContain("dimensions");
      expect(fallbackContexts[0]?.join("\n")).toContain("not saved or executed");
      expect(runDelegationActionReview).toHaveBeenCalledOnce();
      expect(runDelegationActionReview).toHaveBeenCalledWith(expect.objectContaining({
        initialIntent: "Explain service visits and propose creating a maintenance request.",
        prepareOnly: true,
      }));
      const reviewed = await loadBoundaryReviewContext(root);
      expect(reviewed.candidate.pack.resources.map((resource) => resource.id)).toContain(
        "public.maintenance_requests",
      );
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("lets the operator retry one refused structured model draft without re-entering the job", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-model-retry-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    let attempt = 0;
    const modelReadWorkloadGenerator = vi.fn(async (
      input: Parameters<typeof generateModelReadWorkload>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelReadWorkload>>> => {
      attempt += 1;
      const workload = attempt === 1
        ? {
            schema_version: READ_WORKLOAD_SET_VERSION,
            name: input.name,
            allowed: [{
              id: "invalid_first_attempt",
              description: "Count service visits across too many dimensions.",
              plan: {
                kind: "aggregate",
                resource: "public.service_visits",
                measures: [{ function: "count" }],
                dimensions: Array.from({ length: 4 }, () => ({ field: "status" })),
              },
            }],
            forbidden: [],
            source: { kind: "model" as const, provider: input.provider, model: input.model },
          }
        : readWorkloadFromPlanCards({
            cards: [buildReadWorkloadPlanCards(input.generatedBoundary)[0]!],
            selectedIds: [buildReadWorkloadPlanCards(input.generatedBoundary)[0]!.id],
          });
      return {
        workload,
        analysis: analyzeReadWorkloadSet({ workload, generatedBoundary: input.generatedBoundary }),
        provider: input.provider,
        model: input.model,
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      };
    });
    const recoveryChoices: string[][] = [];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (prompt.includes("What job are you giving this agent?")) return "Explain service visit activity.";
        throw new Error(`Unexpected model-retry prompt: ${prompt}`);
      },
      chooseOption: async (title, choices) => {
        if (title === "MAP THE JOB TO REVIEWED STRUCTURE") return "model";
        if (title === "MODEL FOR BOUNDARY DRAFTING") return "current";
        if (title === "READ BOUNDARY MODEL DRAFT FAILED") {
          recoveryChoices.push(choices.map((choice) => choice.value));
          return "retry";
        }
        throw new Error(`Unexpected model-retry choice: ${title}`);
      },
      confirm: async (prompt) => prompt.includes("Action Boundary") ? false : true,
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-5.6-luna",
            apiKey: "session-secret",
          },
          modelReadWorkloadGenerator,
        },
      )).resolves.toBe(0);

      expect(modelReadWorkloadGenerator).toHaveBeenCalledTimes(2);
      expect(recoveryChoices).toEqual([[
        "retry",
        "change_model",
        "details",
        "runner",
        "back",
      ]]);
      const reviewed = await loadBoundaryReviewContext(root);
      expect(reviewed.candidate.pack.resources).toHaveLength(1);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("lets the operator replace a refused drafting model and requires fresh metadata-egress review", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-model-replacement-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const attemptedModels: string[] = [];
    const egressPrompts: string[] = [];
    let modelChooserCount = 0;
    const modelReadWorkloadGenerator = vi.fn(async (
      input: Parameters<typeof generateModelReadWorkload>[0],
    ): Promise<Awaited<ReturnType<typeof generateModelReadWorkload>>> => {
      attemptedModels.push(input.model);
      const workload = input.model === "gpt-5.6-luna"
        ? {
            schema_version: READ_WORKLOAD_SET_VERSION,
            name: input.name,
            allowed: [{
              id: "invalid_original_model",
              description: "Count service visits across too many dimensions.",
              plan: {
                kind: "aggregate",
                resource: "public.service_visits",
                measures: [{ function: "count" }],
                dimensions: Array.from({ length: 4 }, () => ({ field: "status" })),
              },
            }],
            forbidden: [],
            source: { kind: "model" as const, provider: input.provider, model: input.model },
          }
        : readWorkloadFromPlanCards({
            cards: [buildReadWorkloadPlanCards(input.generatedBoundary)[0]!],
            selectedIds: [buildReadWorkloadPlanCards(input.generatedBoundary)[0]!.id],
          });
      return {
        workload,
        analysis: analyzeReadWorkloadSet({ workload, generatedBoundary: input.generatedBoundary }),
        provider: input.provider,
        model: input.model,
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      };
    });
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (prompt.includes("What job are you giving this agent?")) return "Explain service visit activity.";
        if (prompt.includes("Model for openai")) return "gpt-replacement";
        throw new Error(`Unexpected model-replacement prompt: ${prompt}`);
      },
      chooseOption: async (title, choices) => {
        if (title === "MAP THE JOB TO REVIEWED STRUCTURE") return "model";
        if (title === "MODEL FOR BOUNDARY DRAFTING") {
          if (choices.some((choice) => choice.value === "gpt-replacement")) {
            return "gpt-replacement";
          }
          modelChooserCount += 1;
          return modelChooserCount === 1 ? "current" : "change_model";
        }
        if (title === "READ BOUNDARY MODEL DRAFT FAILED") return "change_model";
        throw new Error(`Unexpected model-replacement choice: ${title}`);
      },
      confirm: async (prompt) => {
        if (prompt.includes("Action Boundary")) return false;
        if (prompt.includes("reviewed structural context")) {
          egressPrompts.push(prompt);
          return true;
        }
        throw new Error(`Unexpected model-replacement confirmation: ${prompt}`);
      },
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          modelAuthoringSession: {
            provider: "openai",
            model: "gpt-5.6-luna",
            apiKey: "session-secret",
          },
          modelReadWorkloadGenerator,
          modelDiscovery: {
            discoverHostedModels: async () => ["gpt-replacement"],
          },
        },
      )).resolves.toBe(0);

      expect(attemptedModels).toEqual(["gpt-5.6-luna", "gpt-replacement"]);
      expect(egressPrompts).toHaveLength(2);
      expect(egressPrompts[0]).toContain("openai[gpt-5.6-luna]");
      expect(egressPrompts[1]).toContain("openai[gpt-replacement]");
      const draft = await readDelegationDraft(root, "explain_service_visit_activity");
      expect(draft?.model_assist).toMatchObject({
        provider: "openai",
        model: "gpt-replacement",
      });
      const stored = await fs.readFile(
        path.join(root, ".synapsor/delegations/explain_service_visit_activity/draft.json"),
        "utf8",
      );
      expect(stored).not.toContain("session-secret");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("accepts a bounded no-model recommendation once and preserves its proposal target without activation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-job-no-model-recommended-"));
    const inspection = actionTargetInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const recommendationTitles: string[] = [];
    const runDelegationActionReview = vi.fn(async () => ({
      state: "closed" as const,
      source_database_changed: false as const,
      activated_actions: [],
    }));
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async (prompt) => {
        if (prompt.includes("What job are you giving this agent?")) {
          return "Explain service visits and propose creating a maintenance request.";
        }
        throw new Error(`Unexpected no-model recommendation prompt: ${prompt}`);
      },
      chooseOption: async (title, _choices, options) => {
        if (title === "MAP THE JOB TO REVIEWED STRUCTURE") {
          expect(options?.initialValue).toBe("cards");
          return "cards";
        }
        if (title === "RUNNER-GUIDED READ DRAFT") {
          recommendationTitles.push(...(options?.context ?? []).filter((line) => line.startsWith("- ")));
          return "use";
        }
        throw new Error(`Unexpected no-model recommendation choice: ${title}`);
      },
      selectReadWorkloadCards: async () => {
        throw new Error("The recommended path should not open the full exact-card picker.");
      },
      confirm: async (prompt) => {
        if (prompt.includes("Action Boundary")) return true;
        throw new Error(`Unexpected no-model recommendation confirmation: ${prompt}`);
      },
      confirmActivation: async () => false,
      confirmReviewedDisabled: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access", "--job-first"],
        async () => inspection,
        session,
        undefined,
        {
          startWithAgentJob: true,
          actionProjectInspector: async () => inspection,
          runDelegationActionReview,
        },
      )).resolves.toBe(0);

      expect(recommendationTitles.length).toBeGreaterThan(0);
      expect(recommendationTitles.length).toBeLessThanOrEqual(4);
      expect(runDelegationActionReview).toHaveBeenCalledOnce();
      const reviewed = await loadBoundaryReviewContext(root);
      expect(reviewed.candidate.pack.resources.map((resource) => resource.id)).toContain(
        "public.maintenance_requests",
      );
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundaries.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("returns from boundary naming and final review prompts without saving or activating", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-prompt-back-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const choices = [
      { action: "create" as const },
      { action: "confirm" as const },
    ];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => choices.shift(),
      editFieldTiers: async () => undefined,
      promptText: async () => undefined,
      confirm: async () => {
        throw new Error("Escape at reviewer input must return before confirmation.");
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
      ], async () => inspection, session)).resolves.toBe(0);
      expect(output).toContain("New boundary cancelled. Nothing was saved or activated.");
      expect(output).toContain("Returned to boundary review. No sign-offs were recorded.");
      await expect(fs.access(path.join(root, ".synapsor/boundary-review-progress.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("turns an unchanged column inspection into one explicit table sign-off", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-table-signoff-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const choices = [
      { resource_id: "public.service_visits", action: "review" as const },
      undefined,
    ];
    let confirmations = 0;
    const confirmationDefaults: Array<boolean | undefined> = [];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => choices.shift(),
      editFieldTiers: async (view) => Object.fromEntries(view.fields.map((field) => [
        field.name,
        view.candidate?.kept_out_fields.includes(field.name)
          ? "kept_out"
          : view.candidate?.model_withheld_fields?.includes(field.name)
            ? "withheld_from_model"
            : "visible",
      ])) as Record<string, BoundaryFieldTier>,
      promptText: async () => "alice",
      confirm: async (_prompt, options) => {
        confirmations += 1;
        confirmationDefaults.push(options?.defaultValue);
        return true;
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
      ], async () => inspection, session)).resolves.toBe(0);
      const progress = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      const tableDecisions = build.exploration_boundary.unresolved_decisions.filter(
        (decision) => decision.startsWith("public.service_visits:"),
      );
      expect(confirmations).toBe(1);
      expect(confirmationDefaults).toEqual([true]);
      expect(progress.confirmed_decisions).toEqual(tableDecisions);
      expect(output).toContain("TABLE SIGN-OFF - public.service_visits");
      expect(output).toContain("ACCESS");
      expect(output).toContain("REVIEWED VALUE");
      expect(output).toContain(`Signed off public.service_visits.`);
      expect(output).toContain(
        `${tableDecisions.length} digest-bound decisions are now recorded under one table sign-off.`,
      );
      expect(output).not.toContain("Type CONFIRM");
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["candidate", "confirmations"])("refuses a stale grouped sign-off after another session changes %s", async (change) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-signoff-race-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({ inspection,
      project: { root, package_manager: "npm", frameworks: ["node"], schema_inputs: [], database_env_names: ["DATABASE_URL"] },
      sourceEnv: "DATABASE_URL", inspectedSchema: "public", deploymentProfile: "production",
      httpClaims: { tenantClaim: "tenant_id", principalClaim: "sub" } });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const shown = await loadBoundaryReviewContext(root);
      const first = createBoundaryReviewProgress({ draft: shown.draft, candidate: shown.candidate,
        confirmedDecisions: [], actor: "first_operator", revision: 1 });
      await saveBoundaryReviewProgress(root, first);
      let latest: typeof first | undefined;
      const session: BoundaryReviewInteractiveSession = {
        chooseResource: async () => ({ action: "confirm" }), editFieldTiers: async () => undefined,
        promptText: async () => "first_operator",
        confirm: async (prompt) => {
          if (!latest) {
            const candidate = structuredClone(first.candidate);
            if (change === "candidate") candidate.budgets.max_rows = 2;
            latest = createBoundaryReviewProgress({ draft: shown.draft, candidate, previous: first,
              confirmedDecisions: [candidate.unresolved_decisions[0]!], actor: "second_operator", revision: 2 });
            await saveBoundaryReviewProgress(root, latest);
          }
          return !prompt.startsWith("Activate ");
        },
      };
      await expect(boundaryReviewCommandInternal(["--project-root", root], async () => inspection, session))
        .rejects.toHaveProperty("code", "POLICY_AUTHORING_REVIEW_CHANGED");
      expect(JSON.parse(await fs.readFile(path.join(root, ".synapsor/boundary-review-progress.json"), "utf8"))).toEqual(latest);
      await expect(loadActivatedExplorationBoundaries(root)).rejects.toHaveProperty("code", "ENOENT");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("groups final review into one boundary sign-off and one sign-off per table", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-grouped-review-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
      deploymentProfile: "production",
      httpClaims: { tenantClaim: "tenant_id", principalClaim: "sub" },
    });
    let confirmations = 0;
    const confirmationDefaults: Array<boolean | undefined> = [];
    const confirmationPrompts: string[] = [];
    const activationHandoff = vi.fn(async () => 0);
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => ({ action: "confirm" }),
      editFieldTiers: async () => undefined,
      promptText: async () => "alice",
      confirm: async (prompt, options) => {
        confirmations += 1;
        confirmationPrompts.push(prompt);
        confirmationDefaults.push(options?.defaultValue);
        return true;
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
      ], async () => inspection, session, activationHandoff)).resolves.toBe(0);
      const progress = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(confirmations).toBe(3);
      expect(confirmationDefaults).toEqual([true, true, true]);
      expect(confirmationPrompts[0]).toBe(
        "Confirm these boundary-wide production HTTP and trusted JWT scope settings?",
      );
      expect(confirmationPrompts.at(-1)).toBe(
        `Activate "${build.exploration_boundary.pack.name}" now?`,
      );
      expect(progress.confirmed_decisions).toEqual(
        build.exploration_boundary.unresolved_decisions,
      );
      expect(output).toContain("FINAL REVIEW");
      expect(output).toContain("Boundary settings");
      expect(output).toContain("production HTTP + JWT");
      expect(output).toContain("production over secured Streamable HTTP");
      expect(output).not.toContain("local authoring + trusted scope");
      expect(output).toContain("TABLE SIGN-OFF - public.service_visits");
      expect(output).toContain("REVIEWED - NOT ACTIVE");
      expect(output).toContain("REVIEW");
      expect(output).toContain("Complete");
      expect(output).toContain("Exact reviewed fingerprint:");
      expect(output).toContain(
        `Reviewed boundary "${build.exploration_boundary.pack.name}" is active`,
      );
      expect(output).toContain("\uD83D\uDC90 ACTIVATION SUCCEEDED");
      expect(output).toContain("active for secured production HTTP Explore");
      expect(output).toContain("initialize its shared accounting ledger, and run doctor");
      expect(output).not.toContain("active for local read-only Explore");
      expect(output).not.toContain("Next: synapsor-runner try ask");
      expect(activationHandoff).not.toHaveBeenCalled();
      expect(output).not.toContain("Stable ID:");
      expect(output).not.toContain("Type CONFIRM");
      const active = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/exploration-boundary.active.json"),
        "utf8",
      ));
      expect(active.activation.digest).toBe(
        explorationBoundaryCandidateDigest(build.exploration_boundary),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("lets an operator inspect the complete Read revision during a provider outage and activate without leaving chat", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-exact-read-review-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({ inspection, project: {
      root, package_manager: "npm", frameworks: ["node"], schema_inputs: [], database_env_names: ["DATABASE_URL"],
    }, sourceEnv: "DATABASE_URL", inspectedSchema: "public" });
    const writes: string[] = [];
    const reviews: string[] = [];
    const choices = ["details", "section:1", "section:1", "section:1", "back", "back", "section:3", "section:5", "back", "__ask_boundary_model__", "details", "section:6", "back", "activate"];
    const guide = vi.fn(async () => { throw new AskError("ASK_PROVIDER_TIMEOUT", "private-provider-body"); });
    let digest: string;
    let candidateBefore: string;
    const chat = createBoundaryAuthoringChat({ color: false, io: {
      columns: () => 76,
      read: async () => "What may the customer read?",
      choose: async (choice) => {
        if (choice.title === "PERMISSION REQUIRED") {
          expect(choice.initialValue).toBe("finish");
          expect(choice.options.find((option) => option.value === "finish")?.label).not.toContain("recommended");
        }
        return choices.shift();
      },
      review: async (_title, lines) => {
        const current = await loadBoundaryReviewContext(root);
        expect(current.bundle.candidate_digest).toBe(digest);
        expect(JSON.stringify(current.candidate)).toBe(candidateBefore);
        await expect(loadActivatedExplorationBoundaries(root)).rejects.toMatchObject({ code: "ENOENT" });
        reviews.push(lines.join("\n"));
      },
      write: (value) => writes.push(value), onInterrupt: () => () => undefined, close: () => undefined,
    } });
    chat.setPermissionGuide!(guide);
    let visits = 0;
    chat.session.chooseResource = async () => visits++ === 0 ? { action: "confirm" } : undefined;
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const before = await loadBoundaryReviewContext(root);
      digest = before.bundle.candidate_digest;
      candidateBefore = JSON.stringify(before.candidate);
      const summary = formatReadActivationBusinessSummary(before.bundle).join("\n");
      expect(summary).toContain("service visits");
      expect(summary).toContain("Who:");
      expect(summary).toContain("Kept private:");
      expect(summary).not.toMatch(/relationships|scheduled_at|tenant_id|fingerprint|\+\d+ more/u);
      expect(summary.split("\n").length).toBeLessThanOrEqual(6);
      const acknowledged = structuredClone(before.bundle);
      const resource = acknowledged.candidate.pack.resources[0]!;
      resource.field_types.updated_at = "timestamp with time zone";
      resource.field_types.version = "integer";
      resource.selectable_fields.push("updated_at", "version");
      const meanings = new Set([`${resource.id}.updated_at`]);
      const reviewedSummary = formatReadActivationBusinessSummary(acknowledged, meanings).join("\n");
      expect(reviewedSummary).toContain("Confirmed meaning:");
      expect(reviewedSummary).toContain("Privacy advisory:"); // The unrelated version still needs review; a hint is not a policy violation.
      expect(formatReadActivationBusinessSummary(acknowledged).join("\n")).not.toContain("Confirmed meaning:");
      await expect(boundaryReviewCommandInternal(["--project-root", root, "--access"], async () => inspection,
        chat.session)).resolves.toBe(0);
      expect(reviews, writes.join("\n")).toHaveLength(4);
      expect(guide).toHaveBeenCalledTimes(1); // Explicit question only; local review does not require narration.
      for (const fact of ["public.service_visits", "scheduled_at", "tenant_id", "trusted_context", "budgets", digest]) {
        expect(reviews.join("\n").replace(/\s+/gu, "")).toContain(fact.replace(/\s+/gu, ""));
      }
      expect(reviews[0]).not.toContain('"activation"');
      expect(reviews[3]).toContain("ASK_PROVIDER_TIMEOUT");
      expect(writes.join("").match(/READ REVIEW SUMMARY/gu)).toHaveLength(1);
      expect(writes.join("")).not.toContain("LOCAL REVIEW SUMMARY");
      expect(writes.join("")).toContain("Exact details work without the model");
      expect(writes.join("")).not.toContain("private-provider-body");
      expect((await loadActivatedExplorationBoundaries(root))[0]?.activation.digest).toBe(digest);
      expect((await loadBoundaryReviewContext(root)).bundle.candidate_digest).toBe(digest);
      expect(choices).toEqual([]);
    } finally { chat.close(); await fs.rm(root, { recursive: true, force: true }); }
  });

  it("keeps conversational activation output inside the authoring transcript", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-conversation-activation-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const presented: Array<{ title: string; lines: string[]; tone?: string }> = [];
    const session: BoundaryReviewInteractiveSession = {
      presentationMode: "conversation",
      present: (title, lines, tone) => presented.push({ title, lines, ...(tone ? { tone } : {}) }),
      chooseResource: async () => ({ action: "confirm" }),
      editFieldTiers: async () => undefined,
      promptText: async () => "alice",
      confirm: async () => true,
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const review = formatBoundaryChatReviewSummary((await loadBoundaryReviewContext(root)).bundle);
      expect(review.join("\n")).toContain("Reviewed table");
      expect(review.join("\n")).toContain("Runner only");
      expect(review.join("\n")).toMatch(/Reviewed: \d+ model \| \d+ Runner only \| \d+ kept out/u);
      expect(review.join("\n")).toContain("Schema: public");
      expect(review.join("\n")).toContain("Trusted scope:");
      expect(review.join("\n")).not.toContain("| public.products");
      expect(review.join("\n")).not.toContain("| Trusted scope");
      expect(review.join("\n")).toContain("source writes: NONE");
      expect(review.join("\n")).not.toContain("sha256:");
      expect(review.filter((line) => /^[+|]/u.test(line)).every((line) => line.length <= 72)).toBe(true);
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root],
        async () => inspection,
        session,
        async () => 0,
      )).resolves.toBe(0);

      expect(presented).toEqual(expect.arrayContaining([
        expect.objectContaining({
          title: "READ BOUNDARY ACTIVATED",
          tone: "success",
          lines: expect.arrayContaining([
            expect.stringMatching(/active for local read-only Explore/i),
            "Source database changed: no",
          ]),
        }),
      ]));
      expect(output).not.toContain("BOUNDARY REVIEW\n");
      expect(output).not.toContain("ACTIVATION SUCCEEDED");
      expect(output).not.toContain("/access is still open");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["pause", "retry"] as const)("keeps a stale-schema activation failure in guided recovery (%s)", async (recovery) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-read-activation-recovery-"));
    const inspection = boundaryInspection();
    const drifted = structuredClone(inspection);
    drifted.tables[0]!.role_posture!.owner = "replacement_owner";
    const build = buildAutoBoundary({ inspection, project: {
      root, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"],
    }, sourceEnv: "DATABASE_URL", inspectedSchema: "public" });
    let scans = 0;
    let visits = 0;
    let inspected = false;
    const choices = ["activate", "details", recovery, ...(recovery === "retry" ? ["activate"] : [])];
    const diagnostics: string[] = [];
    const session: BoundaryReviewInteractiveSession = {
      presentationMode: "conversation",
      chooseResource: async () => visits++ === 0 ? { action: "confirm" } : undefined,
      editFieldTiers: async () => undefined, promptText: async () => "reviewer", confirm: async () => true,
      chooseOption: async (title, _options, context) => {
        if (title === "READ ACTIVATION NEEDS ATTENTION") {
          expect(context?.reviewOnly).toBe(true);
          expect(context?.initialValue).toBe("pause");
          await expect(loadActivatedExplorationBoundaries(root)).rejects.toMatchObject({ code: "ENOENT" });
        }
        return choices.shift();
      },
      showReviewDetails: async (_title, lines) => { inspected = true; diagnostics.push(...lines); },
    };
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const digest = (await loadBoundaryReviewContext(root)).bundle.candidate_digest;
      await expect(boundaryReviewCommandInternal(["--project-root", root, "--access"],
        async () => scans++ === 0 ? drifted : inspection, session)).resolves.toBe(0);
      expect(inspected).toBe(true);
      expect(diagnostics.join("\n")).toContain("Generation lock is stale");
      expect(diagnostics.join("\n")).toContain("boundary rescan --from-env DATABASE_URL");
      expect((await loadBoundaryReviewContext(root)).bundle.candidate_digest).toBe(digest);
      expect(choices).toEqual([]);
      if (recovery === "retry") expect((await loadActivatedExplorationBoundaries(root))[0]?.activation.digest).toBe(digest);
      else await expect(loadActivatedExplorationBoundaries(root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("reports live boundary refresh after production runtime setup is already ready", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-production-activation-refresh-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
      deploymentProfile: "production",
      httpClaims: { tenantClaim: "tenant_id", principalClaim: "sub" },
    });
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const firstDigest = explorationBoundaryCandidateDigest(build.exploration_boundary);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: build.exploration_boundary,
        expectedDigest: firstDigest,
        actor: "first-reviewer",
        confirmation: `ACTIVATE ${firstDigest}`,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        currentInspection: inspection,
      });
      const second = await createSavedBoundary({
        projectRoot: root,
        draft: build.exploration_boundary,
        currentCandidate: build.exploration_boundary,
        name: "reviewed_catalog",
        resourceId: "public.service_visits",
        actor: "second-reviewer",
      });
      await saveBoundaryReviewProgress(root, createBoundaryReviewProgress({
        draft: build.exploration_boundary,
        candidate: second.candidate,
        confirmedDecisions: second.candidate.unresolved_decisions,
        previous: second,
        actor: "second-reviewer",
        revision: second.revision + 1,
      }));
      const session: BoundaryReviewInteractiveSession = {
        chooseResource: async () => undefined,
        editFieldTiers: async () => undefined,
        promptText: async () => "second-reviewer",
        confirm: async () => true,
      };
      const inspectProductionReadiness = vi.fn(async () => ({
        ready: true,
        config_valid: true,
        shared_ledger_initialized: true,
        config_path: path.join(root, "synapsor.runner.json"),
      }));

      await expect(boundaryActivateCommandInternal(
        ["--project-root", root, "--actor", "second-reviewer"],
        async () => inspection,
        session,
        undefined,
        { inspectProductionReadiness },
      )).resolves.toBe(0);

      expect(inspectProductionReadiness).toHaveBeenCalledWith({
        args: ["--project-root", root, "--actor", "second-reviewer"],
        projectRoot: root,
      });
      expect(output).toContain("\uD83D\uDC90 ACTIVATION SUCCEEDED");
      expect(output).toContain("NEXT - PRODUCTION ACCESS UPDATED");
      expect(output).toContain(
        'Boundary "reviewed_catalog" is in the active production Explore set.',
      );
      expect(output).toContain("reloads the active set on its next tool call");
      expect(output).toContain("no restart is required");
      expect(output).toContain(
        "do not rerun config initialization or the ledger migration for this activation",
      );
      expect(output).not.toContain(
        "Next: configure the secured production HTTP runtime, initialize its shared accounting ledger",
      );
      await expect(loadActivatedExplorationBoundaries(root)).resolves.toHaveLength(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("names authority removals before replacing an active Read Boundary and keeps the active revision by default", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-replacement-warning-"));
    const inspection = actionTargetInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const initialDigest = explorationBoundaryCandidateDigest(build.exploration_boundary);
    const removed = build.exploration_boundary.pack.resources.at(-1)!;
    const candidate = structuredClone(build.exploration_boundary);
    candidate.pack.resources = candidate.pack.resources.filter((resource) => resource.id !== removed.id);
    candidate.unresolved_decisions = candidate.unresolved_decisions.filter((decision) =>
      !decision.startsWith(`${removed.id}:`));
    const replacementChoices: Array<{
      title: string;
      labels: string[];
      initialValue?: string;
      context: string[];
    }> = [];
    let resourceVisit = 0;
    const session: BoundaryReviewInteractiveSession = {
      presentationMode: "conversation",
      chooseResource: async () => resourceVisit++ === 0 ? { action: "confirm" } : undefined,
      editFieldTiers: async () => undefined,
      promptText: async () => {
        throw new Error("A fully reviewed replacement must not ask for free text.");
      },
      chooseOption: async (title, choices, options) => {
        replacementChoices.push({
          title,
          labels: choices.map((choice) => choice.label),
          ...(options?.initialValue ? { initialValue: options.initialValue } : {}),
          context: options?.context ?? [],
        });
        return "back";
      },
      confirm: async () => {
        throw new Error("Conversation replacement must use the explicit choice gate.");
      },
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: build.exploration_boundary,
        expectedDigest: initialDigest,
        actor: "initial-reviewer",
        confirmation: `ACTIVATE ${initialDigest}`,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        currentInspection: inspection,
      });
      await saveBoundaryReviewProgress(root, createBoundaryReviewProgress({
        draft: build.exploration_boundary,
        candidate,
        confirmedDecisions: candidate.unresolved_decisions,
        actor: "replacement-reviewer",
        revision: 1,
      }));

      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access"],
        async () => inspection,
        session,
      )).resolves.toBe(0);

      expect(replacementChoices).toHaveLength(1);
      expect(replacementChoices[0]).toMatchObject({
        title: "REPLACE ACTIVE READ BOUNDARY",
        initialValue: "finish",
      });
      expect(replacementChoices[0]?.labels[0]).toContain("removes 1 table");
      expect(replacementChoices[0]?.labels).toContain(
        "Keep current active Read Boundary and finish",
      );
      const replacementReview = replacementChoices[0]!.context;
      expect(replacementReview.map((line) => line.split("|")[1]?.trim() ?? line)
        .join(" ").replace(/\s+/gu, " ")).toContain("Removes active tables (1)");
      expect(replacementReview.join("\n")).toContain(removed.id);
      expect((await loadActivatedExplorationBoundaries(root)).find((boundary) =>
        boundary.pack.name === build.exploration_boundary.pack.name)?.activation.digest
      ).toBe(initialDigest);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("stages focused access edits and activates the exact replacement with one confirmation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-focused-access-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const choices = [
      { resource_id: "public.service_visits", action: "review" as const },
      { action: "confirm" as const },
    ];
    const confirmationPrompts: string[] = [];
    const activationHandoff = vi.fn(async () => 0);
    let previousActive = "";
    let resourceSelections = 0;
    const previousUser = process.env.USER;
    process.env.USER = "focused-reviewer";
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async (_resources, _overview, options) => {
        resourceSelections += 1;
        if (resourceSelections === 3) {
          expect(activationHandoff).not.toHaveBeenCalled();
        }
        expect(options?.initialView).toBe("access");
        expect(options?.startAtBoundaryList).toBe(
          resourceSelections === 1 ? undefined : false,
        );
        if (resourceSelections === 2) {
          await expect(fs.readFile(
            path.join(root, ".synapsor/exploration-boundary.active.json"),
            "utf8",
          )).resolves.toBe(previousActive);
          await expect(prepareScopedExplore({
            projectRoot: root,
            transport: "stdio",
            env: {
              DATABASE_URL: "postgresql://unused.example.test/synapsor",
              SYNAPSOR_TENANT_ID: "tenant-acme",
            },
            inspectDatabaseFn: async () => inspection,
          })).resolves.toMatchObject({
            boundary: {
              activation: { actor: "initial-reviewer" },
            },
          });
        }
        return choices.shift();
      },
      editFieldTiers: async (view, options) => {
        expect(options).toEqual({ focusedAccess: true });
        return Object.fromEntries(view.fields.map((field) => [
          field.name,
          field.name === "status"
            ? "withheld_from_model"
            : view.candidate?.kept_out_fields.includes(field.name)
              ? "kept_out"
              : "visible",
        ])) as Record<string, BoundaryFieldTier>;
      },
      promptText: async () => {
        throw new Error("Routine focused edits must not ask for repeated actor or reason input.");
      },
      confirm: async () => {
        throw new Error("Focused activation must use the raw-key activation prompt.");
      },
      confirmActivation: async (prompt) => {
        confirmationPrompts.push(prompt);
        return true;
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const initialDigest = explorationBoundaryCandidateDigest(build.exploration_boundary);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: build.exploration_boundary,
        expectedDigest: initialDigest,
        actor: "initial-reviewer",
        confirmation: `ACTIVATE ${initialDigest}`,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        currentInspection: inspection,
      });
      previousActive = await fs.readFile(
        path.join(root, ".synapsor/exploration-boundary.active.json"),
        "utf8",
      );
      await fs.rm(path.join(root, ".synapsor/exploration-locks"), {
        recursive: true,
        force: true,
      });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session, activationHandoff, {
        activationReviewNotice: ({ boundaryName, boundaryDigest }) => [
          "MODEL CONTINUATION TEST",
          `Boundary: ${boundaryName}`,
          `Digest: ${boundaryDigest}`,
          "The activation confirmation renews this Ask session.",
          "",
        ].join("\n"),
      })).resolves.toBe(0);

      expect(confirmationPrompts).toEqual([
        `Activate "${build.exploration_boundary.pack.name}" exactly as shown now? You will stay in /access.`,
      ]);
      expect(resourceSelections).toBe(3);
      expect(output).toContain("Draft updated: public.service_visits");
      expect(output).toContain("REVIEW EXACT BOUNDARY");
      expect(output).toContain("Runner only");
      expect(output).toContain("Principal scope");
      expect(output).toContain("Not required for this boundary");
      expect(output).toContain("MODEL CONTINUATION TEST");
      expect(output).toContain("The activation confirmation renews this Ask session.");
      expect(output.indexOf("MODEL CONTINUATION TEST")).toBeLessThan(
        output.indexOf(`Reviewed boundary "${build.exploration_boundary.pack.name}" is active`),
      );
      expect(output).toContain("/access is still open.");
      expect(output).toContain("press Q/Esc when finished to return to Ask");
      expect(output).not.toContain("TABLE SIGN-OFF");
      const styledReviewContext = await loadBoundaryReviewContext(root);
      const plainReview = formatFocusedBoundaryActivationReview(
        styledReviewContext.bundle,
        false,
      );
      const styledReview = formatFocusedBoundaryActivationReview(
        styledReviewContext.bundle,
        true,
      );
      expect(styledReview).toContain("\u001b[1;36mREAD TABLE");
      expect(styledReview).toContain("\u001b[1;35mpublic.service_visits\u001b[0m");
      expect(styledReview).toContain("\u001b[1;32m");
      expect(styledReview).toContain("\u001b[1;33m");
      expect(styledReview).toContain("\u001b[2m");
      expect(stripAnsi(styledReview)).toBe(plainReview);
      const active = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/exploration-boundary.active.json"),
        "utf8",
      )) as {
        pack: { resources: Array<{ id: string; model_withheld_fields?: string[] }> };
      };
      expect(active.pack.resources.find((resource) =>
        resource.id === "public.service_visits")?.model_withheld_fields).toContain("status");
      expect(activationHandoff).toHaveBeenCalledOnce();
    } finally {
      if (previousUser === undefined) delete process.env.USER;
      else process.env.USER = previousUser;
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("renders a width-bounded Read access matrix with conspicuous internal-field review notes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-read-review-renderer-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const resource = build.exploration_boundary.pack.resources[0]!;
    resource.field_types.version = "integer";
    resource.field_types.auto_approval_eligible = "boolean";
    resource.selectable_fields = [...new Set([
      ...resource.selectable_fields,
      "version",
      "auto_approval_eligible",
    ])];
    resource.kept_out_fields = [...new Set([
      ...resource.kept_out_fields.filter((field) => field !== "id"),
      "tenant_id",
    ])];
    resource.model_withheld_fields = [
      ...new Set([...(resource.model_withheld_fields ?? []), "id"]),
    ];
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const bundle = (await loadBoundaryReviewContext(root)).bundle;
      const plain = formatFocusedBoundaryActivationReview(bundle, false, true, 76);
      const styled = formatFocusedBoundaryActivationReview(bundle, true, true, 76);
      // Rejoin the note column independently of wrapped field names and borders.
      const normalized = plain.split("Reviewer notes\n")[1]!.split("\n")
        .map((line) => line.split("|")[2] ?? line).join(" ").replace(/\s+/gu, " ");
      expect(plain).toContain("READ TABLE 1/1");
      expect(plain).toContain("Field access:");
      expect(plain).toContain("Model + Runner");
      expect(plain).toContain("Runner only");
      expect(plain).toContain("Kept out");
      expect(plain).toContain("REVIEW BEFORE ACTIVATION:");
      expect(plain).toContain("auto_approval_eligible");
      expect(plain).toContain("version");
      expect(normalized).toContain("private policy fact");
      expect(normalized).toContain("conflict/version guard");
      expect(normalized).toContain("Runner-only record identity");
      expect(normalized).toContain("obj_* references");
      expect(normalized).toContain("Kept out trusted scope");
      expect(plain.split("\n").every((line) => line.length <= 76)).toBe(true);
      expect(styled).toContain("\u001b[1;33m");
      expect(styled).toContain("\u001b[1;32m");
      expect(styled).toContain("\u001b[1;36m");
      expect(stripAnsi(styled)).toBe(plain);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("saves an enum review with pending column edits and returns to the column screen", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-enum-columns-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const choices = [
      { resource_id: "public.service_visits", action: "review" as const },
      undefined,
    ];
    let editorVisits = 0;
    let output = "";
    const previousUser = process.env.USER;
    process.env.USER = "enum-reviewer";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const tiersFor = (
      view: Parameters<BoundaryReviewInteractiveSession["editFieldTiers"]>[0],
      statusTier: BoundaryFieldTier,
    ) => Object.fromEntries(view.fields.map((field) => [
      field.name,
      field.name === "status"
        ? statusTier
        : view.candidate?.kept_out_fields.includes(field.name)
          ? "kept_out"
          : view.candidate?.model_withheld_fields?.includes(field.name)
            ? "withheld_from_model"
            : "visible",
    ])) as Record<string, BoundaryFieldTier>;
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => choices.shift(),
      editFieldTiers: async (view, options) => {
        editorVisits += 1;
        expect(options?.focusedAccess).toBe(true);
        if (editorVisits === 1) {
          const tiers = tiersFor(view, "withheld_from_model");
          return { action: "enum", field: "status", tiers };
        }
        expect(view.candidate?.field_enums.status).toEqual(["completed"]);
        expect(view.candidate?.model_withheld_fields).toContain("status");
        return tiersFor(view, "withheld_from_model");
      },
      editFieldEnumValues: async () => ["completed"],
      promptText: async (prompt) => {
        expect(prompt).toContain("Required reason for this allowed-value change");
        return "Use completed statuses and keep raw labels local.";
      },
      confirm: async () => {
        throw new Error("Saving a disabled enum review must not activate authority.");
      },
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session)).resolves.toBe(0);

      expect(editorVisits).toBe(2);
      const context = await loadBoundaryReviewContext(root);
      const resource = context.candidate.pack.resources[0]!;
      expect(resource.field_enums.status).toEqual(["completed"]);
      expect(resource.model_withheld_fields).toContain("status");
      expect(output).toContain("these column access changes will be saved with the allowed-value review");
      expect(output).toContain("Recorded: public.service_visits.status allowed values -> completed");
      expect(output).toContain("Saved in disabled boundary revision");
      expect(output).toContain("Agent authority changed: no");
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousUser === undefined) delete process.env.USER;
      else process.env.USER = previousUser;
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("reports deterministic outcomes when focused access widens a sensitive field", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-sensitive-outcome-"));
    const inspection = boundaryInspection();
    const table = inspection.tables[0]!;
    const contactName = structuredClone(table.columns.find((field) => field.name === "status")!);
    contactName.name = "contact_name";
    contactName.suggestions.sensitive = true;
    contactName.suggestions.sensitivity = {
      state: "high_confidence_sensitive",
      reason_codes: ["person_name"],
      reasons: ["The field name indicates a person's name."],
      evidence_source: "database",
    };
    table.columns.push(contactName);
    table.suggestions.sensitive_columns.push("contact_name");
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    expect(build.exploration_boundary.pack.resources[0]?.kept_out_fields)
      .toContain("contact_name");

    const previousUser = process.env.USER;
    process.env.USER = "sensitive-reviewer";
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const selectedTiers = (
      view: Parameters<BoundaryReviewInteractiveSession["editFieldTiers"]>[0],
      contactTier: BoundaryFieldTier,
    ) => Object.fromEntries(view.fields.map((field) => [
      field.name,
      field.name === "contact_name"
        ? contactTier
        : view.candidate?.kept_out_fields.includes(field.name)
          ? "kept_out"
          : view.candidate?.model_withheld_fields?.includes(field.name)
            ? "withheld_from_model"
            : "visible",
    ])) as Record<string, BoundaryFieldTier>;

    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });

      const firstChoices = [
        { resource_id: "public.service_visits", action: "review" as const },
        undefined,
      ];
      const reasonPrompts: string[] = [];
      let reasonAttempt = 0;
      const firstSession: BoundaryReviewInteractiveSession = {
        chooseResource: async () => firstChoices.shift(),
        editFieldTiers: async (view) => selectedTiers(view, "withheld_from_model"),
        promptText: async (prompt) => {
          reasonPrompts.push(prompt);
          reasonAttempt += 1;
          if (reasonAttempt === 1) return "";
          expect(await readBoundaryReviewProgress(root, build.exploration_boundary))
            .toBeUndefined();
          return "Support analytics needs local unique counts.";
        },
        confirm: async () => {
          throw new Error("A focused visibility edit must not activate authority implicitly.");
        },
      };
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, firstSession)).resolves.toBe(0);

      expect(reasonPrompts).toEqual([
        "Required reason for this sensitive-field access change: ",
        "Required reason for this sensitive-field access change: ",
      ]);
      expect(output).toContain(
        "This widens sensitive-field access:\n  public.service_visits.contact_name -> Runner only (withheld from model)",
      );
      expect(output).toContain("Reviewer: sensitive-reviewer");
      expect(output).toContain("A concrete reason is required before Runner can save this change.");
      expect(output).toContain("Rejected: a concrete reason is required; no change was made.");
      expect(output).toContain(
        "Recorded: public.service_visits.contact_name -> Runner only (withheld from model); " +
        "actor=sensitive-reviewer; reason=\"Support analytics needs local unique counts.\"",
      );
      expect(output).toContain(
        "Restored only the operations currently supported by the field's inspected type",
      );
      expect(output).toMatch(
        /public\.service_visits\.contact_name: return, filter\([^)]*\), sort, group, count distinct/,
      );
      expect(output).toContain("These grants are staged, not active.");

      const progressPath = path.join(root, ".synapsor/boundary-review-progress.json");
      const applied = JSON.parse(await fs.readFile(progressPath, "utf8")) as {
        revision: number;
        candidate: { pack: { resources: Array<{
          id: string;
          model_withheld_fields?: string[];
          filterable_fields: Record<string, string[]>;
          sortable_fields: string[];
          groupable_fields: string[];
          count_distinct_fields: string[];
        }> } };
      };
      const appliedResource = applied.candidate.pack.resources.find((resource) =>
        resource.id === "public.service_visits")!;
      expect(appliedResource.model_withheld_fields).toContain("contact_name");
      expect(appliedResource.filterable_fields.contact_name)
        .toEqual(expect.arrayContaining(["eq", "in"]));
      expect(appliedResource.sortable_fields).toContain("contact_name");
      expect(appliedResource.groupable_fields).toContain("contact_name");
      expect(appliedResource.count_distinct_fields).toContain("contact_name");
      const appliedRevision = applied.revision;

      output = "";
      const repeatChoices = [
        { resource_id: "public.service_visits", action: "review" as const },
        undefined,
      ];
      const repeatSession: BoundaryReviewInteractiveSession = {
        chooseResource: async () => repeatChoices.shift(),
        editFieldTiers: async (view) => selectedTiers(view, "withheld_from_model"),
        promptText: async () => {
          throw new Error("An idempotent repeat must not ask for another reason.");
        },
        confirm: async () => {
          throw new Error("An idempotent repeat must not activate authority.");
        },
      };
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, repeatSession)).resolves.toBe(0);
      expect(output).toContain(
        "Unchanged: public.service_visits already has the access levels shown; no change was made.",
      );
      expect(JSON.parse(await fs.readFile(progressPath, "utf8")).revision).toBe(appliedRevision);

      output = "";
      const cancelChoices = [
        { resource_id: "public.service_visits", action: "review" as const },
        undefined,
      ];
      const cancelSession: BoundaryReviewInteractiveSession = {
        chooseResource: async () => cancelChoices.shift(),
        editFieldTiers: async (view) => selectedTiers(view, "visible"),
        promptText: async () => undefined,
        confirm: async () => {
          throw new Error("Cancelling a sensitive-field edit must not activate authority.");
        },
      };
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, cancelSession)).resolves.toBe(0);
      expect(output).toContain("Cancelled - no sensitive-field access change was made.");
      const cancelled = JSON.parse(await fs.readFile(progressPath, "utf8"));
      expect(cancelled.revision).toBe(appliedRevision);
      expect(cancelled.candidate.pack.resources.find((resource: { id: string }) =>
        resource.id === "public.service_visits").model_withheld_fields).toContain("contact_name");
    } finally {
      if (previousUser === undefined) delete process.env.USER;
      else process.env.USER = previousUser;
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("returns from a focused column editor to the selected boundary's table list", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-column-back-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const starts: Array<boolean | undefined> = [];
    let chooseCalls = 0;
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async (_resources, _overview, options) => {
        starts.push(options?.startAtBoundaryList);
        chooseCalls += 1;
        return chooseCalls === 1
          ? { resource_id: "public.service_visits", action: "review" }
          : undefined;
      },
      editFieldTiers: async () => "back",
      promptText: async () => {
        throw new Error("Back from columns must not open a prompt.");
      },
      confirm: async () => {
        throw new Error("Back from columns must not confirm authority.");
      },
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access"],
        async () => inspection,
        session,
        undefined,
        { startAtBoundaryList: true },
      )).resolves.toBe(0);
      expect(starts).toEqual([true, false]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("reviews an ordinary principal column inline and returns to the same column editor", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-principal-column-"));
    const inspection = boundaryInspection();
    const table = inspection.tables[0]!;
    table.columns.push({
      name: "rep",
      data_type: "text",
      nullable: false,
      generated: false,
      ordinal_position: table.columns.length + 1,
      suggestions: {
        tenant: false,
        conflict: false,
        sensitive: false,
        immutable: false,
        large_or_binary: false,
      },
    });
    table.suggestions.default_visible_columns.push("rep");
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const choices = [
      { resource_id: "public.service_visits", action: "review" as const },
      undefined,
    ];
    let editCalls = 0;
    const prompts = ["6", "Limit each user to rows assigned to their reviewed rep identity."];
    const previousUser = process.env.USER;
    process.env.USER = "principal-reviewer";
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => choices.shift(),
      editFieldTiers: async (view, options) => {
        editCalls += 1;
        expect(options?.focusedAccess).toBe(true);
        if (editCalls === 1) {
          return {
            action: "principal",
            tiers: Object.fromEntries(view.fields.map((field) => [
              field.name,
              view.candidate?.kept_out_fields.includes(field.name) ? "kept_out" : "visible",
            ])) as Record<string, BoundaryFieldTier>,
          };
        }
        expect(options?.initialTiers).toBeDefined();
        return "back";
      },
      promptText: async () => prompts.shift(),
      confirm: async () => {
        throw new Error("A principal policy edit must not activate authority.");
      },
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session)).resolves.toBe(0);
      const progress = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(progress.candidate.pack.resources.find((resource: { id: string }) =>
        resource.id === "public.service_visits").principal_key).toBe("rep");
      expect(output).toContain("Saved: public.service_visits user/owner row limit -> Direct column rep.");
      expect(output).toContain("Returning to this table's columns.");
      expect(editCalls).toBe(2);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousUser === undefined) delete process.env.USER;
      else process.env.USER = previousUser;
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("keeps a completed review inactive when the operator declines the default-yes activation handoff", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-activation-decline-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const prompts: string[] = [];
    const defaults: Array<boolean | undefined> = [];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async () => "alice",
      confirm: async (prompt, options) => {
        prompts.push(prompt);
        defaults.push(options?.defaultValue);
        return false;
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await saveBoundaryReviewProgress(root, createBoundaryReviewProgress({
        draft: build.exploration_boundary,
        candidate: build.exploration_boundary,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        actor: "alice",
        revision: 1,
      }));

      await expect(boundaryActivateCommandInternal(
        ["--project-root", root, "--actor", "alice"],
        async () => inspection,
        session,
      )).resolves.toBe(0);

      expect(prompts).toEqual([
        `Activate "${build.exploration_boundary.pack.name}" now?`,
      ]);
      expect(defaults).toEqual([true]);
      expect(output).toContain("Boundary remains reviewed and inactive.");
      expect(output).toContain("No agent authority or source data changed.");
      expect(output).not.toContain("Type ACTIVATE");
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prints direct routes back to guided or explicit Ask after standalone activation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-activation-resume-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async () => "alice",
      confirm: async () => true,
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await saveBoundaryReviewProgress(root, createBoundaryReviewProgress({
        draft: build.exploration_boundary,
        candidate: build.exploration_boundary,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        actor: "alice",
        revision: 1,
      }));

      await expect(boundaryActivateCommandInternal(
        ["--project-root", root, "--actor", "alice"],
        async () => inspection,
        session,
      )).resolves.toBe(0);

      expect(output).toContain("Resume the guided CLI and choose a model or MCP client:");
      expect(output).toContain(`cd '${root}' && synapsor-runner start --from-env DATABASE_URL --cli`);
      expect(output).toContain("start --from-env DATABASE_URL --cli");
      expect(output).toContain("Or open Ask directly with an explicit provider:");
      expect(output).toContain("try ask --project-root");
      expect(output).toContain("--provider openai --model gpt-5.6-terra");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("records the same disabled candidate through the picker and flag paths", async () => {
    const flagRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-flag-equivalence-"));
    const pickerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-picker-equivalence-"));
    const inspection = boundaryInspection();
    const flagSetup = await initializeSignedReviewProject(flagRoot, inspection);
    await initializeSignedReviewProject(pickerRoot, inspection);
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      const flagArgs = [
        "boundary", "review", "resource", "public.service_visits",
        "--project-root", flagRoot,
        "--withhold-from-model", "status",
        "--actor", "alice",
        "--reason", "Equivalent reviewed egress decision.",
        "--json",
      ];
      await main(flagArgs, { boundarySchemaInspector: async () => inspection });
      const preview = JSON.parse(output);
      output = "";
      await main([
        ...flagArgs,
        "--apply",
        "--confirm", `APPLY REVIEW ${preview.decision_digest}`,
        "--config", flagSetup.configPath,
        "--identity", "alice",
        "--identity-key", flagSetup.privateKeyPath,
        "--required-role", "boundary_reviewer",
        "--nonce", "equivalent-flag-nonce-0001",
      ], { boundarySchemaInspector: async () => inspection });

      const answers = ["alice", "Equivalent reviewed egress decision."];
      const session: BoundaryReviewInteractiveSession = {
        chooseResource: async () => ({
          resource_id: "public.service_visits",
          action: "review",
        }),
        editFieldTiers: async (view) => Object.fromEntries(view.fields.map((field) => {
          const tier: BoundaryFieldTier = field.name === "status"
            ? "withheld_from_model"
            : view.candidate?.kept_out_fields.includes(field.name)
              ? "kept_out"
              : view.candidate?.model_withheld_fields?.includes(field.name)
                ? "withheld_from_model"
                : "visible";
          return [field.name, tier];
        })),
        promptText: async () => answers.shift() ?? "",
        confirm: async () => true,
      };
      output = "";
      await expect(boundaryReviewCommandInternal([
        "resource",
        "public.service_visits",
        "--project-root", pickerRoot,
      ], async () => inspection, session)).resolves.toBe(0);
      expect(output).toContain("Saved disabled boundary review revision 1.");
      expect(output).toContain("Authority activated: no");

      const flagProgress = JSON.parse(await fs.readFile(
        path.join(flagRoot, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      const pickerProgress = JSON.parse(await fs.readFile(
        path.join(pickerRoot, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(pickerProgress.candidate).toEqual(flagProgress.candidate);
      expect(pickerProgress.candidate_digest).toBe(flagProgress.candidate_digest);
      await expect(fs.access(path.join(pickerRoot, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(flagRoot, { recursive: true, force: true });
      await fs.rm(pickerRoot, { recursive: true, force: true });
    }
  }, 25_000);

  it("opens an excluded reviewable table in the picker and includes it only after confirmation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-picker-excluded-"));
    const inspection = boundaryInspection();
    const secondTable = structuredClone(inspection.tables[0]!);
    secondTable.name = "service_routes";
    secondTable.unique_constraints = [{ name: "service_routes_pkey", columns: ["id"] }];
    secondTable.indexes = [{ name: "service_routes_pkey", columns: ["id"], unique: true }];
    inspection.tables.push(secondTable);
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const excluded = structuredClone(build.exploration_boundary);
    excluded.pack.resources = excluded.pack.resources.filter(
      (resource) => resource.id !== "public.service_visits",
    );
    const progress = createBoundaryReviewProgress({
      draft: build.exploration_boundary,
      candidate: excluded,
      confirmedDecisions: [],
      actor: "alice",
      revision: 1,
    });
    const answers = ["alice", "Include this reviewed table through the interactive picker."];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => ({
        resource_id: "public.service_visits",
        action: "review",
      }),
      editFieldTiers: async (view) => {
        expect(view.candidate).toBeNull();
        expect(view.generated_candidate?.id).toBe("public.service_visits");
        return Object.fromEntries(view.fields.map((field) => [
          field.name,
          view.generated_candidate?.kept_out_fields.includes(field.name)
            ? "kept_out"
            : "visible",
        ])) as Record<string, BoundaryFieldTier>;
      },
      promptText: async () => answers.shift() ?? "",
      confirm: async () => true,
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await saveBoundaryReviewProgress(root, progress);
      await expect(boundaryReviewCommandInternal([
        "resource",
        "public.service_visits",
        "--project-root", root,
      ], async () => inspection, session)).resolves.toBe(0);
      expect(output).toContain("Include public.service_visits in the disabled candidate.");
      expect(output).toContain("Table access: not included -> included");
      const saved = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(saved.candidate.pack.resources.map((resource: { id: string }) => resource.id))
        .toEqual(["public.service_routes", "public.service_visits"]);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("resolves a blocked table inline and returns to review instead of terminating the CLI", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-inline-scope-"));
    const inspection = batchBoundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    expect(build.exploration_boundary.pack.resources).toEqual([]);
    const choices = [
      { resource_id: "public.service_visits", action: "add" as const },
      undefined,
    ];
    let resolverCalls = 0;
    let pickerCalls = 0;
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => {
        pickerCalls += 1;
        return choices.shift();
      },
      resolveBlockedResource: async (view) => {
        resolverCalls += 1;
        expect(view.generated_candidate).toBeNull();
        expect(view.row_identity.candidates).toContain("id");
        expect(view.tenant_key.candidates).toContain("tenant_id");
        return { row_identity: "id", tenant_key: "tenant_id" };
      },
      editFieldTiers: async (view) => {
        expect(view.generated_candidate?.id).toBe("public.service_visits");
        return "back";
      },
      promptText: async () => {
        throw new Error("Inline scope resolution must not require a signed-key prompt.");
      },
      confirm: async () => {
        throw new Error("Inline scope resolution must not activate authority.");
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
      ], async () => inspection, session)).resolves.toBe(0);
      expect(resolverCalls).toBe(1);
      expect(pickerCalls).toBe(2);
      expect(output).toContain("Saved structural review for public.service_visits");
      expect(output).toContain("Record ID: id");
      expect(output).toContain("Tenant isolation: tenant_id");
      expect(output).toContain("Agent authority activated: no");
      expect(output).toContain("Boundary review paused");
      const reviews = await listBoundaryResourceReviews(root);
      expect(reviews.find((resource) => resource.resource_id === "public.service_visits"))
        .toMatchObject({ included: true, status: "draft_read" });
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("keeps identical shared-reference review previews digest-stable across reviewer timestamps", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-shared-reference-digest-"));
    const inspection = sharedReferenceInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const request = {
      resource_id: "public.service_visits",
      include: true,
      shared_reference_scope: "table_has_no_per_tenant_rows" as const,
      actor: "owner@example.test",
      reason: "This reference data is centrally maintained and identical for every tenant.",
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-12T12:00:00.000Z"));
      const first = await prepareBoundaryResourceReviewMutation(
        root,
        request,
        async () => inspection,
      );
      vi.setSystemTime(new Date("2026-08-12T12:05:00.000Z"));
      const second = await prepareBoundaryResourceReviewMutation(
        root,
        request,
        async () => inspection,
      );
      expect(second.build.graph.resources[0]?.shared_reference_scope?.review_override?.decided_at)
        .not.toBe(first.build.graph.resources[0]?.shared_reference_scope?.review_override?.decided_at);
      expect(second.candidate_digest).toBe(first.candidate_digest);
      expect(second.decision_digest).toBe(first.decision_digest);
      expect(second.build.lock.evidence_fingerprint).toBe(first.build.lock.evidence_fingerprint);
    } finally {
      vi.useRealTimers();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("requires a fresh shared-reference acknowledgement when adding the table to a second boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-second-boundary-shared-reference-"));
    const inspection = scopedAndSharedReferenceInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
      overrides: {
        schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
        resources: {
          "public.reference_catalog": {
            shared_reference_scope: {
              value: "table_has_no_per_tenant_rows",
              actor: "first-reviewer",
              reason: "The first boundary reviewed this centrally maintained catalog.",
              decided_at: "2026-08-12T12:00:00.000Z",
            },
          },
        },
      },
    });
    const choices = [
      { resource_id: "public.reference_catalog", action: "add" as const },
      undefined,
    ];
    let pickerCalls = 0;
    let resolverCalls = 0;
    const prompts: string[] = [];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => {
        pickerCalls += 1;
        return choices.shift();
      },
      resolveBlockedResource: async (view) => {
        resolverCalls += 1;
        expect(view.candidate).toBeNull();
        expect(view.generated_candidate?.shared_reference_scope).toEqual({
          mode: "shared_reference",
          acknowledgement: "table_has_no_per_tenant_rows",
        });
        expect(view.shared_reference_scope).toMatchObject({ eligible: true });
        return {
          row_identity: "id",
          shared_reference_scope: "table_has_no_per_tenant_rows",
        };
      },
      editFieldTiers: async (view) => {
        expect(view.candidate?.shared_reference_scope).toEqual({
          mode: "shared_reference",
          acknowledgement: "table_has_no_per_tenant_rows",
        });
        return "back";
      },
      promptText: async (prompt) => {
        prompts.push(prompt);
        return "This second boundary independently reviews the same tenant-neutral catalog.";
      },
      confirm: async (_prompt, options) => {
        expect(options?.defaultValue).toBe(false);
        return true;
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      expect(build.exploration_boundary.pack.resources.map((resource) => resource.id).sort()).toEqual([
        "public.reference_catalog",
        "public.service_visits",
      ]);
      expect(build.policy_baseline.boundary.pack.resources.map((resource) => resource.id))
        .toEqual(["public.service_visits"]);
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const firstDigest = explorationBoundaryCandidateDigest(build.exploration_boundary);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: build.exploration_boundary,
        expectedDigest: firstDigest,
        actor: "first-reviewer",
        confirmation: `ACTIVATE ${firstDigest}`,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        currentInspection: inspection,
      });
      await createSavedBoundary({
        projectRoot: root,
        draft: build.exploration_boundary,
        currentCandidate: build.exploration_boundary,
        name: "reviewed_catalog",
        resourceId: "public.service_visits",
        actor: "second-reviewer",
      });

      const before = await listBoundaryResourceReviews(root);
      expect(before.find((resource) => resource.resource_id === "public.reference_catalog"))
        .toMatchObject({
          included: false,
          inline_resolution_available: true,
          first_table_startable: false,
          first_table_scope_kind: "shared_reference",
          first_table_guidance: expect.stringContaining("confirm Shared reference for this boundary"),
        });

      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session)).resolves.toBe(0);
      expect(resolverCalls).toBe(1);
      expect(pickerCalls).toBe(2);
      expect(prompts[0]).toContain("SHARED REFERENCE REVIEW");
      expect(output).toContain("Row scope: Shared reference (no tenant predicate");
      expect(output).toContain("Access editor closed. Reviewed authority is unchanged.");

      const progress = await readBoundaryReviewProgress(root, build.exploration_boundary);
      expect(progress?.candidate.pack.resources.map((resource) => resource.id).sort()).toEqual([
        "public.reference_catalog",
        "public.service_visits",
      ]);
      expect(progress?.review_overrides.resources["public.reference_catalog"]?.shared_reference_scope)
        .toMatchObject({
          value: "table_has_no_per_tenant_rows",
          reason: "This second boundary independently reviews the same tenant-neutral catalog.",
        });
      const active = await loadActivatedExplorationBoundaries(root);
      expect(active).toHaveLength(1);
      expect(active[0]?.pack.name).toBe(build.exploration_boundary.pack.name);
      expect(active[0]?.activation.digest).toBe(firstDigest);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("requires a reason and explicit confirmation before adding a shared reference", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-shared-reference-"));
    const inspection = sharedReferenceInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    expect(build.exploration_boundary.pack.resources).toEqual([]);
    const choices = [
      { resource_id: "public.service_visits", action: "add" as const },
      undefined,
    ];
    const prompts: string[] = [];
    const confirmations: string[] = [];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => choices.shift(),
      resolveBlockedResource: async (view) => {
        expect(view.shared_reference_scope).toMatchObject({ eligible: true });
        return {
          row_identity: "id",
          shared_reference_scope: "table_has_no_per_tenant_rows",
        };
      },
      editFieldTiers: async () => "back",
      promptText: async (prompt) => {
        prompts.push(prompt);
        return "This reference data is centrally maintained and identical for every tenant.";
      },
      confirm: async (prompt, options) => {
        confirmations.push(prompt);
        expect(options?.defaultValue).toBe(false);
        return true;
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommand([
        "resource",
        "public.service_visits",
        "--project-root", root,
        "--include",
        "--shared-reference",
        "--acknowledge-table-has-no-per-tenant-rows",
        "--actor", "owner@example.test",
        "--reason", "This reference data is centrally maintained and identical for every tenant.",
        "--json",
      ], async () => inspection)).resolves.toBe(0);
      expect(JSON.parse(output)).toMatchObject({
        ok: true,
        semantic_diff: {
          resource_id: "public.service_visits",
          before_included: false,
          after_included: true,
          selected_shared_reference_scope: true,
        },
        authority_activated: false,
        source_database_changed: false,
      });
      output = "";
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
      ], async () => inspection, session)).resolves.toBe(0);
      expect(prompts[0]).toContain("SHARED REFERENCE REVIEW");
      expect(prompts[0]).toContain("Table: public.service_visits");
      expect(prompts[0]).toContain("Explain why this table contains the same rows for every tenant.");
      expect(prompts[0]?.split("\n").at(-1)).toBe("Required reason");
      expect(confirmations[0]).toMatch(/has no per-tenant rows.*every tenant/i);
      expect(output).toContain("Row scope: Shared reference (no tenant predicate");
      const reviews = await listBoundaryResourceReviews(root);
      expect(reviews[0]).toMatchObject({ included: true, status: "draft_read" });
      const progress = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(progress.candidate.pack.resources[0].shared_reference_scope).toEqual({
        mode: "shared_reference",
        acknowledgement: "table_has_no_per_tenant_rows",
      });
      expect(progress.review_overrides.resources["public.service_visits"].shared_reference_scope)
        .toMatchObject({
          value: "table_has_no_per_tenant_rows",
          actor: expect.any(String),
          reason: "This reference data is centrally maintained and identical for every tenant.",
        });

      const reviewedContext = await loadBoundaryReviewContext(root);
      const analysis = analyzeReadWorkloadSet({
        generatedBoundary: reviewedContext.candidate,
        workload: {
          schema_version: READ_WORKLOAD_SET_VERSION,
          name: "shared_reference_reporting",
          allowed: [{
            id: "count_service_visits",
            description: "Count the reviewed shared-reference rows",
            plan: {
              kind: "aggregate",
              resource: "public.service_visits",
              measures: [{ function: "count" }],
              top_n: 1,
            },
          }],
          forbidden: [],
          source: { kind: "operator_exact_plan" },
        },
      });
      expect(analysis.status).toBe("ready");
      const stored = await storeReadWorkloadAnalysis({
        projectRoot: root,
        generatedBoundary: reviewedContext.candidate,
        source: { kind: "operator_exact_plan" },
        analysis,
      });
      const workloadPreview = await prepareReadWorkloadCandidate({
        projectRoot: root,
        workload: stored,
        actor: "owner@example.test",
        reason: "Compile the reviewed shared-reference workload without dropping its explicit scope decision.",
        schemaInspector: async () => inspection,
      });
      expect(workloadPreview.mutation.candidate.pack.resources[0]?.shared_reference_scope)
        .toEqual({
          mode: "shared_reference",
          acknowledgement: "table_has_no_per_tenant_rows",
        });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("adds a table before column review and stages removal without exiting the access editor", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-add-remove-loop-"));
    const inspection = boundaryInspection();
    const visits = inspection.tables[0]!;
    const relationColumn = structuredClone(visits.columns[0]!);
    relationColumn.name = "route_id";
    relationColumn.suggestions.immutable = true;
    const unrelatedRelationColumn = structuredClone(relationColumn);
    unrelatedRelationColumn.name = "region_id";
    visits.columns.push(relationColumn, unrelatedRelationColumn);
    visits.suggestions.default_visible_columns.push("route_id", "region_id");
    visits.foreign_keys = [{
      name: "service_visits_route_id_fkey",
      columns: ["route_id"],
      referenced_schema: "public",
      referenced_table: "service_routes",
      referenced_columns: ["id"],
      delete_rule: "RESTRICT",
    }, {
      name: "service_visits_region_id_fkey",
      columns: ["region_id"],
      referenced_schema: "public",
      referenced_table: "service_regions",
      referenced_columns: ["id"],
      delete_rule: "RESTRICT",
    }];
    const routeTable = structuredClone(visits);
    routeTable.name = "service_routes";
    routeTable.foreign_keys = [];
    routeTable.unique_constraints = [{ name: "service_routes_pkey", columns: ["id"] }];
    routeTable.indexes = [{ name: "service_routes_pkey", columns: ["id"], unique: true }];
    const regionTable = structuredClone(routeTable);
    regionTable.name = "service_regions";
    regionTable.unique_constraints = [{ name: "service_regions_pkey", columns: ["id"] }];
    regionTable.indexes = [{ name: "service_regions_pkey", columns: ["id"], unique: true }];
    inspection.tables.push(routeTable, regionTable);
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const candidate = structuredClone(build.exploration_boundary);
    candidate.pack.resources = candidate.pack.resources.filter(
      (resource) => resource.id === "public.service_visits",
    );
    candidate.pack.resources[0]!.relationships = [];
    const progress = createBoundaryReviewProgress({
      draft: build.exploration_boundary,
      candidate,
      confirmedDecisions: [],
      actor: "alice",
      revision: 1,
    });
    const actions = [
      { resource_id: "public.service_routes", action: "add" as const },
      { resource_id: "public.service_routes", action: "remove" as const },
      undefined,
    ];
    let chooseCalls = 0;
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => {
        chooseCalls += 1;
        if (chooseCalls === 2) {
          const saved = JSON.parse(await fs.readFile(
            path.join(root, ".synapsor/boundary-review-progress.json"),
            "utf8",
          ));
          expect(saved.candidate.pack.resources.map((resource: { id: string }) => resource.id))
            .toEqual(["public.service_routes", "public.service_visits"]);
          expect(saved.candidate.pack.resources
            .find((resource: { id: string }) => resource.id === "public.service_visits")
            .relationships.map((relationship: { target_resource: string }) => relationship.target_resource))
            .toEqual(["public.service_routes"]);
        }
        if (chooseCalls === 3) {
          const saved = JSON.parse(await fs.readFile(
            path.join(root, ".synapsor/boundary-review-progress.json"),
            "utf8",
          ));
          expect(saved.candidate.pack.resources.map((resource: { id: string }) => resource.id))
            .toEqual(["public.service_visits"]);
          expect(saved.candidate.pack.resources[0].relationships).toEqual([]);
        }
        return actions.shift();
      },
      editFieldTiers: async (view) => {
        expect(view.candidate?.id).toBe("public.service_routes");
        return "back";
      },
      promptText: async () => {
        throw new Error("Focused add/remove must not request repeated reviewer text.");
      },
      confirm: async () => {
        throw new Error("Explicit Add and Remove keys stage only a disabled draft and need no extra prompt.");
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await saveBoundaryReviewProgress(root, progress);
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session)).resolves.toBe(0);
      const saved = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(saved.candidate.pack.resources.map((resource: { id: string }) => resource.id))
        .toEqual(["public.service_visits"]);
      expect(chooseCalls).toBe(3);
      expect(output).toContain("Draft added: public.service_routes");
      expect(output).toContain("Draft removed: public.service_routes");
      expect(output).toContain(
        "Related-data relationship removed from the disabled draft: service_visits -> service_routes " +
        "(path ID: service_visits_route_id_fkey)",
      );
      expect(output).toContain("Access editor closed. Reviewed authority is unchanged.");
      expect(output).not.toContain("Returning to Ask.");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("explains a scope-dependent removal and stays in the focused access editor", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-dependent-remove-"));
    const inspection = derivedFirstTableInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const child = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.order_items",
        include: true,
        row_identity: "id",
        tenant_scope_path: "order_items_order_id_fkey",
        principal_key: null,
        actor: "owner@example.test",
        reason: "Each order item belongs to its required reviewed order.",
      }, async () => inspection);
      await commitBoundaryResourceReviewMutation(root, child);
      const before = await loadBoundaryReviewContext(root);
      const actions = [
        { resource_id: "public.orders", action: "remove" as const },
        undefined,
      ];
      let chooseCalls = 0;
      let blockedNotice: Parameters<BoundaryReviewInteractiveSession["chooseResource"]>[2];
      const session: BoundaryReviewInteractiveSession = {
        chooseResource: async (_resources, _overview, options) => {
          chooseCalls += 1;
          if (chooseCalls === 2) blockedNotice = options;
          return actions.shift();
        },
        editFieldTiers: async () => {
          throw new Error("A rejected table removal must return to the table list.");
        },
        promptText: async () => {
          throw new Error("Focused removal must not open a line-mode prompt.");
        },
        confirm: async () => {
          throw new Error("A blocked removal must not request activation or confirmation.");
        },
      };

      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session)).resolves.toBe(0);
      expect(chooseCalls).toBe(2);
      expect(blockedNotice?.notice).toMatchObject({
        tone: "danger",
        title: "REMOVE BLOCKED - public.orders",
      });
      expect(blockedNotice?.notice?.lines.join("\n")).toContain(
        "public.order_items: tenant scope through order_items -> orders.tenant_id " +
        "(path ID: order_items_order_id_fkey)",
      );
      expect(blockedNotice?.notice?.lines.join("\n"))
        .toContain("Suggested leaf-first order: public.order_items -> public.orders");
      expect(blockedNotice?.notice?.footer).toContain("No draft or active authority changed");
      const after = await loadBoundaryReviewContext(root);
      expect(explorationBoundaryCandidateDigest(after.candidate))
        .toBe(explorationBoundaryCandidateDigest(before.candidate));
      expect(after.candidate.pack.resources.map((resource) => resource.id).sort())
        .toEqual(["public.order_items", "public.orders"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("changes one table's minimum group size with default-Yes save and activation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-group-size-one-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const choices = [
      { resource_id: "public.service_visits", action: "privacy" as const },
      undefined,
    ];
    const text = ["1", "Owner-reviewed local analysis may show groups of one."];
    const confirmationPrompts: string[] = [];
    const confirmationDefaults: Array<boolean | undefined> = [];
    const activationHandoff = vi.fn(async () => 0);
    let chooseCalls = 0;
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async (_resources, _overview, options) => {
        chooseCalls += 1;
        if (chooseCalls === 2) {
          expect(options?.initialResourceId).toBe("public.service_visits");
        }
        return choices.shift();
      },
      editFieldTiers: async () => {
        throw new Error("Table privacy must not open the column editor.");
      },
      promptText: async () => text.shift(),
      confirm: async (prompt, options) => {
        confirmationPrompts.push(prompt);
        confirmationDefaults.push(options?.defaultValue);
        return true;
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session, activationHandoff)).resolves.toBe(0);
      const progress = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(progress.candidate.pack.resources[0].minimum_cohort_size).toBe(1);
      expect(output).toContain("PRIVACY - public.service_visits");
      expect(output).toContain("Current minimum group size: 5");
      expect(confirmationPrompts).toEqual([
        "Save this privacy change for public.service_visits?",
        "Review and activate this boundary change now?",
        `Activate "${build.exploration_boundary.pack.name}" exactly as shown now? You will stay in /access.`,
      ]);
      expect(confirmationDefaults).toEqual([true, true, false]);
      expect(chooseCalls).toBe(2);
      expect(activationHandoff).toHaveBeenCalledOnce();
      expect(output).toContain("/access is still open.");
      expect(output).toContain("press Q/Esc when finished to return to Ask");
      const active = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/exploration-boundary.active.json"),
        "utf8",
      ));
      expect(active.pack.resources[0].minimum_cohort_size).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("toggles the selected boundary's local Ask plan check without changing authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-ask-intent-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const choices = [{
      action: "intent_check" as const,
      boundary_name: build.exploration_boundary.pack.name,
    }, undefined];
    const confirmations: string[] = [];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => choices.shift(),
      editFieldTiers: async () => undefined,
      promptText: async () => undefined,
      confirm: async (prompt) => {
        confirmations.push(prompt);
        return true;
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const lockBefore = await fs.readFile(path.join(root, ".synapsor/generation-lock.json"), "utf8");
      const draftBefore = await fs.readFile(
        path.join(root, "synapsor/generated/exploration-boundary.draft.json"),
        "utf8",
      );
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session)).resolves.toBe(0);

      await expect(askIntentCheckModeForBoundary(
        root,
        build.exploration_boundary.pack.name,
      )).resolves.toBe("boundary_only");
      expect(await fs.readFile(path.join(root, ".synapsor/generation-lock.json"), "utf8"))
        .toBe(lockBefore);
      expect(await fs.readFile(
        path.join(root, "synapsor/generated/exploration-boundary.draft.json"),
        "utf8",
      )).toBe(draftBefore);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundaries.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(confirmations[0]).toContain("Turn off the English question-to-plan check");
      expect(output).toContain("Access editor closed");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("toggles model-facing authority metadata from access without changing reviewed authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-model-output-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const choices = [{
      action: "model_output" as const,
      exact_metadata_confirmed: true as const,
    }, undefined];
    const confirmations: string[] = [];
    const notices: Array<unknown> = [];
    const displayedModes: Array<unknown> = [];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async (_resources, overview, options) => {
        displayedModes.push(overview?.model_authority_metadata_mode);
        notices.push(options?.notice);
        return choices.shift();
      },
      editFieldTiers: async () => undefined,
      promptText: async () => undefined,
      confirm: async (prompt) => {
        confirmations.push(prompt);
        return true;
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const guided = await initializeGuidedProject({
        projectRoot: root,
        build,
        runnerVersion: "1.7.14",
      });
      const lockPath = path.join(root, ".synapsor/generation-lock.json");
      const draftPath = path.join(root, "synapsor/generated/exploration-boundary.draft.json");
      const lockBefore = await fs.readFile(lockPath, "utf8");
      const draftBefore = await fs.readFile(draftPath, "utf8");

      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session)).resolves.toBe(0);

      expect(JSON.parse(await fs.readFile(guided.config_path, "utf8"))).toMatchObject({
        model_output: { authority_metadata: "exact" },
      });
      expect(await fs.readFile(lockPath, "utf8")).toBe(lockBefore);
      expect(await fs.readFile(draftPath, "utf8")).toBe(draftBefore);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundaries.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(confirmations).toEqual([]);
      expect(displayedModes).toEqual(["semantic", "exact"]);
      expect(notices[1]).toMatchObject({
        tone: "warning",
        title: "Model responses now include Exact diagnostic metadata.",
        footer: expect.stringContaining("reviewed data authority is unchanged"),
      });
      expect(output).toContain("Access editor closed");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("sets one cohort threshold across the boundary, activates it, and keeps access open", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-cohort-all-"));
    const inspection = boundaryInspection();
    const second = structuredClone(inspection.tables[0]!);
    second.name = "service_routes";
    second.unique_constraints = [{ name: "service_routes_pkey", columns: ["id"] }];
    second.indexes = [{ name: "service_routes_pkey", columns: ["id"], unique: true }];
    inspection.tables.push(second);
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const choices = [{ action: "privacy_all" as const }, undefined];
    const text = ["1", "Local owner review for this non-production demonstration."];
    const confirmations = [true, true, true];
    const prompts: string[] = [];
    const confirmationPrompts: string[] = [];
    const confirmationDefaults: Array<boolean | undefined> = [];
    const activationHandoff = vi.fn(async () => 0);
    let chooseCalls = 0;
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => {
        chooseCalls += 1;
        return choices.shift();
      },
      editFieldTiers: async () => {
        throw new Error("Boundary-wide privacy must not open one table's column editor.");
      },
      promptText: async (prompt) => {
        prompts.push(prompt);
        return text.shift();
      },
      confirm: async (prompt, options) => {
        confirmationPrompts.push(prompt);
        confirmationDefaults.push(options?.defaultValue);
        return confirmations.shift();
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session, activationHandoff)).resolves.toBe(0);
      const progress = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(progress.candidate.pack.resources).toHaveLength(2);
      expect(progress.candidate.pack.resources.every((resource: { minimum_cohort_size: number }) =>
        resource.minimum_cohort_size === 1)).toBe(true);
      expect(output).toContain("PRIVACY - ALL 2 TABLES IN THIS BOUNDARY");
      expect(output).toContain("Enter a whole number from 1 through 5");
      expect(output).toContain("Consequence: aggregate output may contain groups with one person or record");
      expect(output).toContain("Saved minimum group size 1 (small-group suppression off) for 2 tables");
      expect(output).toContain("/access is still open.");
      expect(output).toContain("press Q/Esc when finished to return to Ask");
      expect(prompts).toEqual([
        "New minimum group size for all tables [current 5]: ",
        "Reason for setting 2 tables to minimum group size 1 (recorded with this decision): ",
      ]);
      expect(confirmationPrompts).toEqual([
        "Save this privacy change for 2 tables?",
        "Review and activate this boundary change now?",
        `Activate "${build.exploration_boundary.pack.name}" exactly as shown now? You will stay in /access.`,
      ]);
      expect(confirmationDefaults).toEqual([true, true, false]);
      expect(confirmations).toHaveLength(0);
      expect(chooseCalls).toBe(2);
      expect(activationHandoff).toHaveBeenCalledOnce();
      const active = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/exploration-boundary.active.json"),
        "utf8",
      ));
      expect(active.pack.resources).toHaveLength(2);
      expect(active.pack.resources.every((resource: { minimum_cohort_size: number }) =>
        resource.minimum_cohort_size === 1)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("refuses a requested relationship when its target table is not in the boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-missing-target-"));
    const inspection = boundaryInspection();
    const visits = inspection.tables[0]!;
    const routeId = structuredClone(visits.columns[0]!);
    routeId.name = "route_id";
    visits.columns.push(routeId);
    visits.suggestions.default_visible_columns.push("route_id");
    visits.foreign_keys = [{
      name: "service_visits_route_id_fkey",
      columns: ["route_id"],
      referenced_schema: "public",
      referenced_table: "service_routes",
      referenced_columns: ["id"],
      delete_rule: "RESTRICT",
    }];
    const routes = structuredClone(visits);
    routes.name = "service_routes";
    routes.foreign_keys = [];
    routes.unique_constraints = [{ name: "service_routes_pkey", columns: ["id"] }];
    routes.indexes = [{ name: "service_routes_pkey", columns: ["id"], unique: true }];
    inspection.tables.push(routes);
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const candidate = structuredClone(build.exploration_boundary);
    candidate.pack.resources = candidate.pack.resources.filter(
      (resource) => resource.id === "public.service_visits",
    );
    candidate.pack.resources[0]!.relationships = [];
    const progress = createBoundaryReviewProgress({
      draft: build.exploration_boundary,
      candidate,
      confirmedDecisions: [],
      actor: "alice",
      revision: 1,
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await saveBoundaryReviewProgress(root, progress);
      await expect(main([
        "boundary", "review", "resource", "public.service_visits",
        "--project-root", root,
        "--relationships", "service_visits_route_id_fkey",
        "--actor", "alice",
        "--reason", "Review only a complete proven relationship path.",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).rejects.toThrow(
        /service_visits_route_id_fkey requires public\.service_routes.*include that table first/i,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("stages an available relationship through the terminal editor without activating it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-relationship-tui-"));
    const inspection = boundaryInspection();
    const visits = inspection.tables[0]!;
    const routeId = structuredClone(visits.columns[0]!);
    routeId.name = "route_id";
    routeId.nullable = true;
    visits.columns.push(routeId);
    visits.suggestions.default_visible_columns.push("route_id");
    visits.foreign_keys = [{
      name: "service_visits_route_id_fkey",
      columns: ["route_id"],
      referenced_schema: "public",
      referenced_table: "service_routes",
      referenced_columns: ["id"],
      delete_rule: "RESTRICT",
    }];
    const routes = structuredClone(visits);
    routes.name = "service_routes";
    routes.foreign_keys = [];
    routes.unique_constraints = [{ name: "service_routes_pkey", columns: ["id"] }];
    routes.indexes = [{ name: "service_routes_pkey", columns: ["id"], unique: true }];
    inspection.tables.push(routes);
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const candidate = structuredClone(build.exploration_boundary);
    expect(candidate.pack.resources.map((resource) => resource.id)).toEqual(expect.arrayContaining([
      "public.service_visits",
      "public.service_routes",
    ]));
    candidate.pack.resources.find((resource) =>
      resource.id === "public.service_visits")!.relationships = [];
    const progress = createBoundaryReviewProgress({
      draft: build.exploration_boundary,
      candidate,
      confirmedDecisions: candidate.unresolved_decisions,
      actor: "alice",
      revision: 1,
    });
    let pickerCalls = 0;
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => {
        pickerCalls += 1;
        return pickerCalls === 1
          ? { resource_id: "public.service_visits", action: "relationships" }
          : undefined;
      },
      editFieldTiers: async () => undefined,
      editRelationshipPaths: async (view, summary) => {
        expect(view.candidate?.relationships).toEqual([]);
        expect(view.generated_candidate?.relationships.find((relationship) =>
          relationship.id === "service_visits_route_id_fkey")).toMatchObject({
          nullable: true,
          unmatched_rows: "review_required",
        });
        expect(summary.relationships).toContainEqual(expect.objectContaining({
          relationship_id: "service_visits_route_id_fkey",
          state: "available",
        }));
        return { action: "add", relationship_id: "service_visits_route_id_fkey" };
      },
      promptText: async (prompt) => prompt.startsWith("Missing related rows")
        ? "2"
        : "Reviewed the exact visit-to-route many-to-one path and retained unmatched visits.",
      confirm: async () => undefined,
    };
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await saveBoundaryReviewProgress(root, progress);
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session)).resolves.toBe(0);
      const rawProgress = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor", "boundary-review-progress.json"),
        "utf8",
      ));
      expect(rawProgress.candidate.pack.resources.find((resource: { id: string }) =>
        resource.id === "public.service_visits").relationships.find((relationship: { id: string }) =>
        relationship.id === "service_visits_route_id_fkey").unmatched_rows).toBe("keep_null");
      const saved = (await loadBoundaryReviewContext(root)).progress;
      expect(saved?.candidate.pack.resources.find((resource) =>
        resource.id === "public.service_visits")?.relationships.map((relationship) =>
        relationship.id)).toContain("service_visits_route_id_fkey");
      expect(saved?.candidate.pack.resources.find((resource) =>
        resource.id === "public.service_visits")?.relationships.find((relationship) =>
        relationship.id === "service_visits_route_id_fkey")?.unmatched_rows).toBe("keep_null");
      expect(saved?.revision).toBe(2);
      expect(stdout.mock.calls.flat().join(" ")).toContain("Active authority changed: no");
      await expect(fs.access(path.join(root, ".synapsor", "exploration-boundary.active.json")))
        .rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("creates, switches, and deletes named disabled boundaries without changing active authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-library-cli-"));
    const inspection = boundaryInspection();
    const routes = structuredClone(inspection.tables[0]!);
    routes.name = "service_routes";
    routes.unique_constraints = [{ name: "service_routes_pkey", columns: ["id"] }];
    routes.indexes = [{ name: "service_routes_pkey", columns: ["id"], unique: true }];
    inspection.tables.push(routes);
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const originalName = build.exploration_boundary.pack.name;
    let call = 0;
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async (resources, overview, options) => {
        if (options?.startingBoundaryName) {
          expect(options.startingBoundaryName).toBe("support_analytics");
          expect(resources.every((resource) => !resource.included)).toBe(true);
          expect(resources.map((resource) => resource.resource_id))
            .toEqual(["public.service_routes", "public.service_visits"]);
          return { resource_id: "public.service_routes", action: "add" };
        }
        call += 1;
        if (call === 1) return { action: "create" };
        if (call === 2) {
          const stored = JSON.parse(await fs.readFile(
            path.join(root, ".synapsor/boundary-library.json"),
            "utf8",
          ));
          expect(stored.boundaries.support_analytics.candidate.pack.resources)
            .toMatchObject([{ id: "public.service_routes", relationships: [] }]);
          expect(overview?.boundaries).toHaveLength(2);
          expect(overview?.boundaries?.find((entry) => entry.name === "support_analytics")?.selected)
            .toBe(true);
          return { action: "switch", boundary_name: originalName };
        }
        if (call === 3) {
          expect(overview?.boundaries?.find((entry) => entry.name === originalName)?.selected)
            .toBe(true);
          return { action: "delete", boundary_name: "support_analytics" };
        }
        return undefined;
      },
      editFieldTiers: async () => undefined,
      promptText: async () => "support_analytics",
      confirm: async () => true,
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session)).resolves.toBe(0);
      const library = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-library.json"),
        "utf8",
      ));
      expect(library.selected_name).toBe(originalName);
      expect(Object.keys(library.boundaries)).toEqual([originalName]);
      expect(output).toContain('Created disabled boundary "support_analytics"');
      expect(output).toContain("with public.service_routes");
      expect(output).toContain(`Opened saved boundary "${originalName}"`);
      expect(output).toContain('Deleted saved disabled boundary "support_analytics"');
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("marks derived-only tables as add-after-ancestor and refuses them before first-table review", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-derived-first-table-"));
    const inspection = derivedFirstTableInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    let chooseCall = 0;
    const resolveBlockedResource = vi.fn();
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async (resources, _overview, options) => {
        chooseCall += 1;
        if (chooseCall === 1) return { action: "create" };
        if (options?.startingBoundaryName) {
          const child = resources.find((resource) => resource.resource_id === "public.order_items")!;
          const ancestor = resources.find((resource) => resource.resource_id === "public.orders")!;
          expect(child).toMatchObject({
            first_table_startable: false,
            first_table_scope_label: "order_items -> orders.tenant_id",
          });
          expect(child.first_table_guidance).toContain("start with public.orders");
          expect(ancestor.first_table_startable).toBe(true);
          return { resource_id: child.resource_id, action: "add" };
        }
        return undefined;
      },
      editFieldTiers: async () => undefined,
      resolveBlockedResource,
      promptText: async () => "line_item_analytics",
      confirm: async () => true,
    };

    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommand([
        "resource", "public.order_items",
        "--project-root", root,
        "--include",
        "--row-identity", "id",
        "--tenant-scope-path", "order_items_order_id_fkey",
        "--no-principal",
        "--actor", "owner@example.test",
        "--reason", "Order items inherit tenant isolation through their required order.",
        "--json",
      ], async () => inspection)).resolves.toBe(0);
      expect(JSON.parse(output)).toMatchObject({
        semantic_diff: {
          resource_id: "public.order_items",
          selected_tenant_scope_path: "order_items_order_id_fkey",
        },
        authority_activated: false,
      });
      output = "";
      const resources = await listBoundaryResourceReviews(root);
      expect(resources.find((resource) => resource.resource_id === "public.order_items"))
        .toMatchObject({
          first_table_startable: false,
          first_table_scope_label: "order_items -> orders.tenant_id",
          derived_tenant_scope: {
            candidates: [{ path_id: "order_items_order_id_fkey" }],
          },
        });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session)).resolves.toBe(0);
      expect(resolveBlockedResource).not.toHaveBeenCalled();
      expect(output).toContain("public.order_items cannot be the first table");
      expect(output).toContain("start with public.orders, then add this table");
      expect(output).toContain("No table review was started, and nothing was saved or activated.");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("adds a genuine depth-three derived resource through the reviewed CLI mutation path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-derived-depth-three-cli-"));
    const inspection = depthThreeDerivedCliInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const apply = async (request: Parameters<typeof prepareBoundaryResourceReviewMutation>[1]) => {
      const preview = await prepareBoundaryResourceReviewMutation(
        root,
        request,
        async () => inspection,
      );
      await commitBoundaryResourceReviewMutation(root, preview);
      return preview;
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await apply({
        resource_id: "public.order_items",
        include: true,
        tenant_scope_path: "order_items_order_id_fkey",
        principal_key: null,
        actor: "owner@example.test",
        reason: "Order items inherit tenant isolation through their required order.",
      });
      await apply({
        resource_id: "public.order_events",
        include: true,
        tenant_scope_path: "order_events_order_item_id_fkey__order_items_order_id_fkey",
        principal_key: null,
        actor: "owner@example.test",
        reason: "Order events inherit tenant isolation through the reviewed item path.",
      });
      const leafRequest = {
        resource_id: "public.event_notes",
        include: true,
        tenant_scope_path:
          "event_notes_order_event_id_fkey__order_events_order_item_id_fkey__order_items_order_id_fkey",
        principal_key: null,
        actor: "owner@example.test",
        reason: "Event notes use the exact reviewed three-hop path to their tenant-owned order.",
      } as const;
      await expect(prepareBoundaryResourceReviewMutation(
        root,
        leafRequest,
        async () => inspection,
      )).rejects.toThrow(/uses 3 hops.*max_derived_scope_hops is 2.*Raise.*to 3/i);

      const leaf = await apply({
        ...leafRequest,
        max_derived_scope_hops: 3,
        max_analysis_relationship_hops: 3,
      });
      expect(leaf.candidate.budgets).toMatchObject({
        max_derived_scope_hops: 3,
        max_analysis_relationship_hops: 3,
      });
      expect(leaf.candidate.pack.resources.find((resource) =>
        resource.id === "public.event_notes")?.tenant_scope?.proof.links).toHaveLength(3);
      const reviews = await listBoundaryResourceReviews(root);
      expect(reviews.find((resource) => resource.resource_id === "public.event_notes"))
        .toMatchObject({ included: true });

      await expect(prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.order_events",
        exclude: true,
        actor: "owner@example.test",
        reason: "An intermediate scope table cannot disappear beneath its reviewed leaf.",
      }, async () => inspection)).rejects.toThrow(
        /public\.event_notes: tenant scope through event_notes -> order_events -> order_items -> orders\.tenant_id \(path ID: event_notes_order_event_id_fkey__order_events_order_item_id_fkey__order_items_order_id_fkey\)[\s\S]*leaf-first order: public\.event_notes -> public\.order_events/i,
      );

      const removeLeaf = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.event_notes",
        exclude: true,
        actor: "owner@example.test",
        reason: "Remove the deepest dependent table first.",
      }, async () => inspection);
      expect(removeLeaf.resource_removal_impact?.blocking_dependencies).toEqual([]);
      await commitBoundaryResourceReviewMutation(root, removeLeaf);
      const removeMiddle = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.order_events",
        exclude: true,
        actor: "owner@example.test",
        reason: "The intermediate table is removable after its dependent leaf is gone.",
      }, async () => inspection);
      expect(removeMiddle.resource_removal_impact?.blocking_dependencies).toEqual([]);
      expect(removeMiddle.candidate.pack.resources.map((resource) => resource.id))
        .not.toContain("public.order_events");

      await expect(prepareBoundaryResourceReviewMutation(root, {
        ...leafRequest,
        resource_id: "public.not_visible_to_reader",
      }, async () => inspection)).rejects.toThrow(
        /schema visible to the reviewed read role.*USAGE.*SELECT grants.*rescan/i,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("also blocks a selected derived principal path from starting a boundary alone", async () => {
    for (const singleOrganization of [false, true]) {
      const root = await fs.mkdtemp(path.join(
        os.tmpdir(),
        singleOrganization
          ? "synapsor-derived-principal-single-org-first-table-"
          : "synapsor-derived-principal-first-table-",
      ));
      const inspection = derivedPrincipalFirstTableInspection(singleOrganization);
      const decision = (value: string, reason: string) => ({
        value,
        actor: "owner@example.test",
        reason,
        decided_at: "2026-08-07T12:00:00.000Z",
      });
      const build = buildAutoBoundary({
        inspection,
        project: {
          root,
          package_manager: "npm",
          frameworks: ["node"],
          schema_inputs: [],
          database_env_names: ["DATABASE_URL"],
        },
        sourceEnv: "DATABASE_URL",
        inspectedSchema: "public",
        overrides: {
          schema_version: "synapsor.auto-boundary-overrides.v1",
          resources: {
            "public.orders": {
              principal_key: decision(
                "owner_id",
                "Each order is owned by the reviewed application principal.",
              ),
            },
            "public.order_items": {
              principal_scope_path: decision(
                "order_items_order_id_fkey",
                "Each item inherits principal scope through its required order.",
              ),
            },
          },
        },
        ...(singleOrganization
          ? { singleOrganization: { organizationId: "internal-analytics" } }
          : {}),
      });
      try {
        await writeAutoBoundaryArtifacts({ projectRoot: root, build });
        const resources = await listBoundaryResourceReviews(root);
        expect(resources.find((resource) => resource.resource_id === "public.order_items"))
          .toMatchObject({
            first_table_startable: false,
            first_table_scope_label: "order_items -> orders.owner_id",
            first_table_guidance: "start with public.orders, then add this table",
          });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  it("keeps invalid interactive boundary names inside review and normalizes ordinary capitalization", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-name-cli-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const names = ["hotel/analytics", "Test_hotel"];
    let chooseCalls = 0;
    const activationHandoff = vi.fn(async () => 0);
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async (resources, overview, options) => {
        if (options?.startingBoundaryName) {
          expect(options.startingBoundaryName).toBe("test_hotel");
          expect(resources.map((resource) => resource.resource_id))
            .toContain("public.service_visits");
          return { resource_id: "public.service_visits", action: "add" };
        }
        chooseCalls += 1;
        if (chooseCalls <= 2) return { action: "create" };
        expect(overview?.boundaries?.some((entry) => entry.name === "test_hotel"))
          .toBe(true);
        return undefined;
      },
      editFieldTiers: async () => undefined,
      promptText: async () => names.shift() ?? "",
      confirm: async () => true,
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session, activationHandoff)).resolves.toBe(0);
      const library = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-library.json"),
        "utf8",
      ));
      expect(library.selected_name).toBe("test_hotel");
      expect(output).toContain("Boundary was not created.");
      expect(output).toContain("You are still in boundary review.");
      expect(output).toContain('Using lower-case boundary name "test_hotel".');
      expect(output).toContain('Created disabled boundary "test_hotel"');
      expect(output).not.toContain("Ask did not start");
      expect(activationHandoff).not.toHaveBeenCalled();
      expect(chooseCalls).toBe(3);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("conservatively rebases another saved draft only after shared schema facts change", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-library-rebase-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const activeDigest = explorationBoundaryCandidateDigest(build.exploration_boundary);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: build.exploration_boundary,
        expectedDigest: activeDigest,
        actor: "original-reviewer",
        confirmation: `ACTIVATE ${activeDigest}`,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        currentInspection: inspection,
      });
      let context = await loadBoundaryReviewContext(root);
      await synchronizeBoundaryLibrary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: context.candidate,
      });
      await createSavedBoundary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: context.candidate,
        name: "support_analytics",
        resourceId: "public.service_visits",
        actor: "alice",
      });
      context = await loadBoundaryReviewContext(root);
      await switchSavedBoundary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: context.candidate,
        currentProgress: context.progress,
        name: build.exploration_boundary.pack.name,
      });

      const driftedInspection = structuredClone(inspection);
      const table = driftedInspection.tables[0]!;
      table.columns.push({
        name: "priority",
        data_type: "text",
        nullable: false,
        generated: false,
        ordinal_position: table.columns.length + 1,
        suggestions: {
          tenant: false,
          conflict: false,
          sensitive: false,
          immutable: false,
          large_or_binary: false,
        },
      });
      table.suggestions.default_visible_columns.push("priority");
      const preview = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        keep_out_fields: ["status"],
        actor: "alice",
        reason: "Keep status unavailable in this reviewed analytics boundary.",
      }, async () => driftedInspection);
      await commitBoundaryResourceReviewMutation(root, preview);

      const libraryAfterMutation = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-library.json"),
        "utf8",
      ));
      expect(libraryAfterMutation.selected_name).toBe(build.exploration_boundary.pack.name);
      expect(
        libraryAfterMutation.boundaries[build.exploration_boundary.pack.name]
          .candidate.pack.resources[0].kept_out_fields,
      ).toContain("status");

      context = await loadBoundaryReviewContext(root);
      const snapshot = await synchronizeBoundaryLibrary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: context.candidate,
        currentProgress: context.progress,
      });
      expect(snapshot.entries).toHaveLength(2);
      const restored = await switchSavedBoundary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: context.candidate,
        currentProgress: context.progress,
        name: "support_analytics",
      });
      const policyBaseline = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/auto-boundary-policy-baseline.json"),
        "utf8",
      ));
      expect(restored.candidate).toMatchObject({
        generation_lock_fingerprint: policyBaseline.boundary.generation_lock_fingerprint,
        pack: {
          name: "support_analytics",
          resources: [{
            id: "public.service_visits",
            kept_out_fields: expect.arrayContaining(["priority"]),
          }],
        },
      });
      expect(restored.candidate.pack.resources[0]!.kept_out_fields).not.toContain("status");
      expect(restored.confirmed_decisions).not.toEqual(
        restored.candidate.unresolved_decisions,
      );
      const active = (await loadActivatedExplorationBoundaries(root))
        .find((boundary) => boundary.pack.name === build.exploration_boundary.pack.name)!;
      expect(active.activation.digest).toBe(activeDigest);
      expect(active.pack.resources[0]!.kept_out_fields).not.toContain("status");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("keeps overlapping table policy isolated by immutable boundary identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-policy-isolation-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const activeDigest = explorationBoundaryCandidateDigest(build.exploration_boundary);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: build.exploration_boundary,
        expectedDigest: activeDigest,
        actor: "original-reviewer",
        confirmation: `ACTIVATE ${activeDigest}`,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        currentInspection: inspection,
      });
      let context = await loadBoundaryReviewContext(root);
      const originalName = context.candidate.pack.name;
      const originalCandidate = structuredClone(context.candidate);
      await synchronizeBoundaryLibrary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: context.candidate,
        currentProgress: context.progress,
      });
      const second = await createSavedBoundary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: context.candidate,
        currentProgress: context.progress,
        name: "finance_lens",
        resourceId: "public.service_visits",
        actor: "finance-reviewer",
      });
      const secondBoundaryId = second.boundary_id;

      const withhold = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        withhold_from_model_fields: ["scheduled_at"],
        field_enum: { field: "status", values: ["completed"] },
        groupable_fields: [],
        minimum_cohort_size: 2,
        actor: "finance-reviewer",
        reason: "Use a narrower finance-only view and owner-reviewed cohort in this boundary.",
      }, async () => inspection);
      await commitBoundaryResourceReviewMutation(root, withhold);
      const privacyEdit = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        minimum_cohort_size: 3,
        actor: "finance-reviewer",
        reason: "Adjust only this boundary's privacy threshold without changing its operation grants.",
      }, async () => inspection);
      await commitBoundaryResourceReviewMutation(root, privacyEdit);
      context = await loadBoundaryReviewContext(root);
      expect(context.candidate.pack.resources[0]).toMatchObject({
        model_withheld_fields: expect.arrayContaining(["scheduled_at"]),
        field_enums: { status: ["completed"] },
        groupable_fields: [],
        minimum_cohort_size: 3,
        minimum_cohort_overridden: true,
      });
      const stillActive = (await loadActivatedExplorationBoundaries(root))
        .find((boundary) => boundary.pack.name === originalName)!;
      expect(stillActive.pack.resources[0]!.model_withheld_fields ?? []).not.toContain("scheduled_at");
      expect(stillActive.pack.resources[0]!.field_enums.status).toEqual(["scheduled", "completed"]);
      expect(stillActive.pack.resources[0]!.minimum_cohort_size).toBe(5);
      expect(stillActive.activation.digest).toBe(activeDigest);
      await synchronizeBoundaryLibrary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: context.candidate,
        currentProgress: context.progress,
      });

      const restored = await switchSavedBoundary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: context.candidate,
        currentProgress: context.progress,
        name: originalName,
      });
      expect(restored.candidate).toEqual(originalCandidate);
      expect(restored.candidate.pack.resources[0]!.model_withheld_fields ?? [])
        .not.toContain("scheduled_at");
      expect(restored.invalidated_decisions).toEqual([]);
      expect(restored.boundary_id).not.toBe(secondBoundaryId);

      context = await loadBoundaryReviewContext(root);
      const finance = await switchSavedBoundary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: context.candidate,
        currentProgress: context.progress,
        name: "finance_lens",
      });
      expect(finance.candidate.pack.resources[0]!.model_withheld_fields).toContain("scheduled_at");
      const renamed = await renameSavedBoundary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: finance.candidate,
        currentProgress: finance,
        name: "finance_lens",
        newName: "finance_reviewed",
        actor: "finance-reviewer",
        reason: "Use the reviewed finance boundary label.",
      });
      expect(renamed.boundary_id).toBe(secondBoundaryId);
      expect(renamed.review_overrides.resources["public.service_visits"]?.fields?.scheduled_at)
        .toMatchObject({ exposure: "withhold_from_model" });
      expect(renamed.review_overrides.resources["public.service_visits"]?.field_enums?.status)
        .toMatchObject({ values: ["completed"] });
      expect(renamed.review_overrides.resources["public.service_visits"]?.minimum_cohort)
        .toMatchObject({ value: 3 });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("starts an overlapping boundary from policy-neutral schema facts instead of the selected policy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-neutral-start-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const selectedPolicy = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        withhold_from_model_fields: ["scheduled_at"],
        field_enum: { field: "status", values: ["completed"] },
        minimum_cohort_size: 2,
        actor: "support-reviewer",
        reason: "Use a narrow support view only in the selected boundary.",
      }, async () => inspection);
      await commitBoundaryResourceReviewMutation(root, selectedPolicy);
      const context = await loadBoundaryReviewContext(root);
      await synchronizeBoundaryLibrary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: context.candidate,
        currentProgress: context.progress,
      });
      const created = await createSavedBoundary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: context.candidate,
        currentProgress: context.progress,
        name: "independent_lens",
        resourceId: "public.service_visits",
        actor: "finance-reviewer",
      });
      const resource = created.candidate.pack.resources[0]!;
      expect(resource.model_withheld_fields ?? []).not.toContain("scheduled_at");
      expect(resource.field_enums.status).toEqual(["scheduled", "completed"]);
      expect(resource.minimum_cohort_size).toBe(5);
      expect(created.review_overrides.resources).toEqual({});
      expect(created.boundary_id).not.toBe(context.progress!.boundary_id);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("migrates legacy review state from the exact boundary without trusting a conflicting global override", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-policy-migration-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const digest = explorationBoundaryCandidateDigest(build.exploration_boundary);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: build.exploration_boundary,
        expectedDigest: digest,
        actor: "legacy-reviewer",
        confirmation: `ACTIVATE ${digest}`,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        currentInspection: inspection,
      });
      const current = createBoundaryReviewProgress({
        draft: build.exploration_boundary,
        candidate: build.exploration_boundary,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        actor: "legacy-reviewer",
        revision: 1,
        now: "2026-08-07T12:00:00.000Z",
      });
      const {
        boundary_id: _boundaryId,
        review_overrides: _reviewOverrides,
        policy_migration: _policyMigration,
        ...legacyProgress
      } = current;
      await fs.writeFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        `${JSON.stringify({
          ...legacyProgress,
          schema_version: "synapsor.boundary-review-progress.v2",
        }, null, 2)}\n`,
      );
      const conflictingGlobal = structuredClone(build.overrides);
      conflictingGlobal.resources["public.service_visits"] = {
        fields: {
          scheduled_at: {
            exposure: "withhold_from_model",
            actor: "different-boundary-reviewer",
            reason: "This project-global decision belongs to a different legacy boundary.",
            decided_at: "2026-08-07T12:30:00.000Z",
          },
        },
      };
      await fs.writeFile(
        path.join(root, ".synapsor/review-overrides.json"),
        `${JSON.stringify(conflictingGlobal, null, 2)}\n`,
      );

      const conflictingDraft = buildAutoBoundary({
        inspection,
        project: {
          root,
          package_manager: "npm",
          frameworks: ["node"],
          schema_inputs: [],
          database_env_names: ["DATABASE_URL"],
        },
        sourceEnv: "DATABASE_URL",
        inspectedSchema: "public",
        overrides: conflictingGlobal,
      }).exploration_boundary;
      const preservedLegacy = await readBoundaryReviewProgress(root, conflictingDraft);
      expect(preservedLegacy).toMatchObject({
        policy_migration: { status: "review_required" },
        candidate: build.exploration_boundary,
      });
      expect(preservedLegacy!.candidate.pack.resources[0]!.model_withheld_fields ?? [])
        .not.toContain("scheduled_at");

      await expect(boundaryActivateCommandInternal([
        "--project-root", root,
      ], async () => inspection)).rejects.toThrow(
        /legacy project-wide review settings.*not yet isolated.*save a reviewed setting.*Rescan/s,
      );

      const migratedPreview = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        minimum_cohort_size: 2,
        actor: "boundary-owner",
        reason: "Record this boundary's reviewed cohort independently.",
      }, async () => inspection);
      await commitBoundaryResourceReviewMutation(root, migratedPreview);

      const context = await loadBoundaryReviewContext(root);
      expect(context.progress).toMatchObject({
        schema_version: "synapsor.boundary-review-progress.v3",
        boundary_id: expect.stringMatching(/^bnd_[a-f0-9]{32}$/),
        policy_migration: {
          status: "complete",
          source: "legacy_exact_boundary_revision",
        },
        review_overrides: {
          resources: {
            "public.service_visits": {
              minimum_cohort: { value: 2 },
            },
          },
        },
      });
      expect(context.progress!.review_overrides.resources["public.service_visits"]?.fields)
        .toBeUndefined();
      expect(context.candidate.pack.resources[0]!.model_withheld_fields ?? [])
        .not.toContain("scheduled_at");
      const active = (await loadActivatedExplorationBoundaries(root))[0]!;
      expect(active.activation.digest).toBe(digest);
      expect(active.pack.resources[0]!.minimum_cohort_size).toBe(5);
      expect(active.pack.resources[0]!.model_withheld_fields ?? []).not.toContain("scheduled_at");
      const backup = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/review-overrides.legacy-backup.json"),
        "utf8",
      ));
      expect(backup.resources["public.service_visits"].fields.scheduled_at.exposure)
        .toBe("withhold_from_model");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("never assigns one ambiguous legacy override to either overlapping boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-policy-ambiguous-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await fs.mkdir(path.join(root, ".synapsor"), { recursive: true });
      const progress = createBoundaryReviewProgress({
        draft: build.exploration_boundary,
        candidate: build.exploration_boundary,
        confirmedDecisions: [],
        actor: "legacy-reviewer",
        revision: 1,
      });
      const {
        boundary_id: _boundaryId,
        review_overrides: _reviewOverrides,
        policy_migration: _policyMigration,
        ...legacyProgress
      } = progress;
      const first = {
        ...legacyProgress,
        schema_version: "synapsor.boundary-review-progress.v2",
      };
      const secondCandidate = structuredClone(build.exploration_boundary);
      secondCandidate.pack.name = "finance_lens";
      const second = {
        ...first,
        candidate: secondCandidate,
        candidate_digest: explorationBoundaryCandidateDigest(secondCandidate),
      };
      await fs.writeFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        `${JSON.stringify(first, null, 2)}\n`,
      );
      await fs.writeFile(path.join(root, ".synapsor/boundary-library.json"), `${JSON.stringify({
        schema_version: "synapsor.boundary-library.v1",
        selected_name: build.exploration_boundary.pack.name,
        boundaries: {
          [build.exploration_boundary.pack.name]: first,
          finance_lens: second,
        },
        updated_at: "2026-08-07T12:00:00.000Z",
      }, null, 2)}\n`);
      const global = structuredClone(build.overrides);
      global.resources["public.service_visits"] = {
        fields: {
          scheduled_at: {
            exposure: "withhold_from_model",
            actor: "unknown-legacy-owner",
            reason: "Ownership is ambiguous across the two saved boundaries.",
            decided_at: "2026-08-07T12:00:00.000Z",
          },
        },
      };
      await fs.writeFile(
        path.join(root, ".synapsor/review-overrides.json"),
        `${JSON.stringify(global, null, 2)}\n`,
      );

      await expect(loadCompletedBoundaryReviewOverrides({
        projectRoot: root,
        boundaryName: build.exploration_boundary.pack.name,
      })).resolves.toBeUndefined();
      await expect(loadCompletedBoundaryReviewOverrides({
        projectRoot: root,
        boundaryName: "finance_lens",
      })).resolves.toBeUndefined();
      const normalized = await readBoundaryReviewProgress(root, build.exploration_boundary);
      expect(normalized).toMatchObject({
        policy_migration: { status: "review_required" },
        review_overrides: { resources: {} },
        candidate: build.exploration_boundary,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a self-consistent saved policy candidate bound to different shared database facts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-policy-lock-"));
    const inspection = boundaryInspection();
    const project = {
      root,
      package_manager: "npm" as const,
      frameworks: ["node"],
      schema_inputs: [],
      database_env_names: ["DATABASE_URL"],
    };
    const original = buildAutoBoundary({
      inspection,
      project,
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const driftedInspection = structuredClone(inspection);
    driftedInspection.tables[0]!.columns.push({
      name: "new_schema_field",
      data_type: "text",
      nullable: true,
      generated: false,
      ordinal_position: 99,
      suggestions: {
        tenant: false,
        conflict: false,
        sensitive: false,
        immutable: false,
        large_or_binary: false,
      },
    });
    const drifted = buildAutoBoundary({
      inspection: driftedInspection,
      project,
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build: original });
      await writeAutoBoundaryArtifacts({
        projectRoot: root,
        build: drifted,
        force: true,
        preserveReviewProgress: true,
      });
      const invalid = createBoundaryReviewProgress({
        draft: original.exploration_boundary,
        candidate: drifted.exploration_boundary,
        confirmedDecisions: [],
        actor: "local-boundary-library",
        revision: 1,
      });
      await saveBoundaryReviewProgress(root, invalid);
      await expect(readBoundaryReviewProgress(root, original.exploration_boundary))
        .rejects.toThrow("different schema or role facts");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("records a narrow schema-enum allowlist and disables value operations when none remain", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-enum-review-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      expect(build.exploration_boundary.pack.resources[0]!.field_enums.status)
        .toEqual(["scheduled", "completed"]);

      const narrowed = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        field_enum: { field: "status", values: ["completed"] },
        actor: "alice",
        reason: "Keep the agent on completed service visits only.",
      }, async () => inspection);
      expect(narrowed.semantic_diff.reviewed_enum_changes).toEqual([{
        field: "status",
        before: ["scheduled", "completed"],
        after: ["completed"],
      }]);
      await commitBoundaryResourceReviewMutation(root, narrowed);
      let context = await loadBoundaryReviewContext(root);
      expect(context.candidate.pack.resources[0]!.field_enums.status).toEqual(["completed"]);

      await expect(prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        field_enum: { field: "status", values: ["completed", "invented"] },
        actor: "alice",
        reason: "This must not widen the database-declared set.",
      }, async () => inspection)).rejects.toThrow(/may only remove schema-declared values.*invented/i);

      const disabled = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        field_enum: { field: "status", values: [] },
        actor: "alice",
        reason: "Do not let this boundary filter or group by service status.",
      }, async () => inspection);
      await commitBoundaryResourceReviewMutation(root, disabled);
      context = await loadBoundaryReviewContext(root);
      const resource = context.candidate.pack.resources[0]!;
      expect(resource.field_enums).not.toHaveProperty("status");
      expect(resource.filterable_fields).not.toHaveProperty("status");
      expect(resource.groupable_fields).not.toContain("status");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("restores current inspected operation suggestions when a kept-out enum becomes model-visible again", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-field-restore-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const fieldOperations = (
      resource: typeof build.exploration_boundary.pack.resources[number],
      field: string,
    ) => ({
      selectable: resource.selectable_fields.includes(field),
      filters: resource.filterable_fields[field] ?? null,
      sortable: resource.sortable_fields.includes(field),
      groupable: resource.groupable_fields.includes(field),
      aggregate: resource.aggregate_measures.includes(field),
      aggregate_functions: resource.aggregate_measure_functions?.[field] ?? null,
      presence: resource.presence_measure_fields?.includes(field) ?? false,
      count_distinct: resource.count_distinct_fields.includes(field),
      time_buckets: resource.time_bucket_fields[field] ?? null,
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const keepOut = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        keep_out_fields: ["status"],
        actor: "owner@example.test",
        reason: "Temporarily remove lifecycle status from this boundary.",
      }, async () => inspection);
      await commitBoundaryResourceReviewMutation(root, keepOut);

      let context = await loadBoundaryReviewContext(root);
      const keptOutResource = context.candidate.pack.resources[0]!;
      expect(keptOutResource.kept_out_fields).toContain("status");
      expect(fieldOperations(keptOutResource, "status")).toEqual({
        selectable: false,
        filters: null,
        sortable: false,
        groupable: false,
        aggregate: false,
        aggregate_functions: null,
        presence: false,
        count_distinct: false,
        time_buckets: null,
      });

      const keptOutDigest = explorationBoundaryCandidateDigest(context.candidate);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: context.candidate,
        expectedDigest: keptOutDigest,
        actor: "owner@example.test",
        confirmation: `ACTIVATE ${keptOutDigest}`,
        confirmedDecisions: context.candidate.unresolved_decisions,
        currentInspection: inspection,
      });

      const restore = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        allow_reviewed_fields: ["status"],
        actor: "owner@example.test",
        reason: "Restore reviewed categorical analysis for lifecycle status.",
      }, async () => inspection);
      const restoredResource = restore.candidate.pack.resources[0]!;
      const generatedResource = restore.build.exploration_boundary.pack.resources[0]!;
      expect(restoredResource.kept_out_fields).not.toContain("status");
      expect(fieldOperations(restoredResource, "status"))
        .toEqual(fieldOperations(generatedResource, "status"));
      expect(fieldOperations(restoredResource, "status")).toMatchObject({
        selectable: true,
        filters: expect.arrayContaining(["eq", "in"]),
        sortable: true,
        groupable: true,
        presence: true,
        count_distinct: true,
      });
      await commitBoundaryResourceReviewMutation(root, restore);

      const stillActive = (await loadActivatedExplorationBoundaries(root))[0]!;
      expect(stillActive.activation.digest).toBe(keptOutDigest);
      expect(fieldOperations(stillActive.pack.resources[0]!, "status").selectable).toBe(false);

      context = await loadBoundaryReviewContext(root);
      const restoredDigest = explorationBoundaryCandidateDigest(context.candidate);
      const activated = await activateExplorationBoundary({
        projectRoot: root,
        candidate: context.candidate,
        expectedDigest: restoredDigest,
        actor: "owner@example.test",
        confirmation: `ACTIVATE ${restoredDigest}`,
        confirmedDecisions: context.candidate.unresolved_decisions,
        currentInspection: inspection,
      });
      expect(fieldOperations(activated.pack.resources[0]!, "status"))
        .toEqual(fieldOperations(restoredResource, "status"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("repairs a legacy model-visible field with no analytical operations without changing active authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-field-repair-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const narrowedCandidate = structuredClone(build.exploration_boundary);
      const narrowedResource = narrowedCandidate.pack.resources[0]!;
      expect(narrowedResource.selectable_fields).toContain("status");
      narrowedResource.sortable_fields = narrowedResource.sortable_fields.filter((field) => field !== "status");
      narrowedResource.groupable_fields = narrowedResource.groupable_fields.filter((field) => field !== "status");
      narrowedResource.aggregate_measures = narrowedResource.aggregate_measures.filter((field) => field !== "status");
      if (narrowedResource.aggregate_measure_functions) {
        delete narrowedResource.aggregate_measure_functions.status;
      }
      narrowedResource.presence_measure_fields = (narrowedResource.presence_measure_fields ?? [])
        .filter((field) => field !== "status");
      narrowedResource.count_distinct_fields = narrowedResource.count_distinct_fields
        .filter((field) => field !== "status");
      delete narrowedResource.time_bucket_fields.status;
      await saveBoundaryReviewProgress(root, createBoundaryReviewProgress({
        draft: build.exploration_boundary,
        candidate: narrowedCandidate,
        confirmedDecisions: narrowedCandidate.unresolved_decisions,
        actor: "narrowing-owner@example.test",
        revision: 1,
        now: "2026-08-15T11:00:00.000Z",
      }));
      const unchangedNarrowing = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        allow_reviewed_fields: ["status"],
        actor: "owner@example.test",
        reason: "Repeat the visible tier without changing deliberate analytical narrowing.",
      }, async () => inspection);
      expect(unchangedNarrowing.semantic_diff.analytical_operation_changes).toEqual([]);
      expect(unchangedNarrowing.candidate.pack.resources[0]!.filterable_fields.status)
        .toEqual(expect.arrayContaining(["eq", "in"]));
      expect(unchangedNarrowing.candidate.pack.resources[0]!.groupable_fields).not.toContain("status");

      const legacyCandidate = structuredClone(narrowedCandidate);
      const legacyResource = legacyCandidate.pack.resources[0]!;
      delete legacyResource.filterable_fields.status;
      const legacyProgress = createBoundaryReviewProgress({
        draft: build.exploration_boundary,
        candidate: legacyCandidate,
        confirmedDecisions: legacyCandidate.unresolved_decisions,
        actor: "legacy-owner@example.test",
        revision: 2,
        now: "2026-08-15T12:00:00.000Z",
      });
      await saveBoundaryReviewProgress(root, legacyProgress);

      const legacyDigest = explorationBoundaryCandidateDigest(legacyCandidate);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: legacyCandidate,
        expectedDigest: legacyDigest,
        actor: "legacy-owner@example.test",
        confirmation: `ACTIVATE ${legacyDigest}`,
        confirmedDecisions: legacyCandidate.unresolved_decisions,
        currentInspection: inspection,
      });

      const strandedView = await inspectBoundaryResourceReview(root, "public.service_visits");
      expect(strandedView.operation_repair_fields).toEqual(["status"]);
      const generatedWithoutReturn = structuredClone(strandedView.generated_candidate!);
      generatedWithoutReturn.selectable_fields = generatedWithoutReturn.selectable_fields
        .filter((field) => field !== "status");
      expect(reviewedBoundaryOperationRepairFields(
        strandedView.candidate,
        generatedWithoutReturn,
      )).toEqual([]);
      const summaries = await listBoundaryResourceReviews(root);
      expect(summaries.find((resource) => resource.resource_id === "public.service_visits")
        ?.operation_repair_fields).toEqual(["status"]);

      const repair = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        allow_reviewed_fields: ["status"],
        actor: "owner@example.test",
        reason: "Repair the analytical grants missing from the legacy review.",
      }, async () => inspection);
      expect(repair.semantic_diff.added_visible_fields).toEqual([]);
      expect(repair.semantic_diff.removed_visible_fields).toEqual([]);
      expect(repair.semantic_diff.analytical_operation_changes).toEqual([{
        field: "status",
        before: [],
        after: expect.arrayContaining(["filter(eq/neq/in)", "sort", "group", "presence measures", "count distinct"]),
      }]);
      expect(repair.candidate_digest).not.toBe(legacyDigest);
      await commitBoundaryResourceReviewMutation(root, repair);

      const repairedView = await inspectBoundaryResourceReview(root, "public.service_visits");
      expect(repairedView.operation_repair_fields).toEqual([]);
      expect(repairedView.candidate?.filterable_fields.status)
        .toEqual(expect.arrayContaining(["eq", "in"]));
      expect(repairedView.candidate?.groupable_fields).toContain("status");
      expect(repairedView.candidate?.presence_measure_fields).toContain("status");

      const stillActive = (await loadActivatedExplorationBoundaries(root))[0]!;
      expect(stillActive.activation.digest).toBe(legacyDigest);
      expect(stillActive.pack.resources[0]!.groupable_fields).not.toContain("status");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("records a reviewed child-count metric through the shared CLI and Workbench mutation path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-child-count-review-"));
    const inspection = derivedFirstTableInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const childReview = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.order_items",
        include: true,
        row_identity: "id",
        tenant_scope_path: "order_items_order_id_fkey",
        actor: "analytics-owner",
        reason: "Every item belongs to its required reviewed order.",
      }, async () => inspection);
      await commitBoundaryResourceReviewMutation(root, childReview);
      const preview = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.orders",
        derived_measure: {
          name: "order_item_count",
          label: "Order item count",
          shape: "child_count_total",
          child_resource: "public.order_items",
          relationship: "order_items_order_id_fkey",
        },
        actor: "analytics-owner",
        reason: "Count scoped item rows without exposing a one-to-many join.",
      }, async () => inspection);
      expect(preview.candidate.pack.resources.find((resource) =>
        resource.id === "public.orders")?.derived_measures).toEqual([{
        name: "order_item_count",
        label: "Order item count",
        shape: "child_count_total",
        child_resource: "public.order_items",
        relationship: "order_items_order_id_fkey",
      }]);
      expect(preview.build.overrides.resources["public.orders"]?.derived_measures)
        .toMatchObject({
          order_item_count: {
            actor: "analytics-owner",
            reason: "Count scoped item rows without exposing a one-to-many join.",
          },
        });
      await commitBoundaryResourceReviewMutation(root, preview);
      const context = await loadBoundaryReviewContext(root);
      expect(context.candidate.pack.resources.find((resource) =>
        resource.id === "public.orders")?.derived_measures?.[0]?.name).toBe("order_item_count");
      await expect(prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.order_items",
        exclude: true,
        actor: "analytics-owner",
        reason: "Attempting to remove a reviewed metric dependency must fail closed.",
      }, async () => inspection)).rejects.toThrow(
        /public\.orders: reviewed metric order_item_count uses child public\.order_items/i,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("records and removes reviewed automatic numeric bands through the shared CLI and Workbench mutation path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-auto-band-review-"));
    const inspection = boundaryInspection();
    inspection.tables[0]!.columns.push({
      name: "duration_ms",
      data_type: "integer",
      nullable: false,
      generated: false,
      ordinal_position: inspection.tables[0]!.columns.length + 1,
      suggestions: {
        tenant: false,
        conflict: false,
        sensitive: false,
        immutable: false,
        large_or_binary: false,
      },
    });
    inspection.tables[0]!.suggestions.default_visible_columns.push("duration_ms");
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const policy = {
      field: "duration_ms",
      methods: ["quantile", "equal_width"] as Array<"quantile" | "equal_width">,
      min_buckets: 3,
      max_buckets: 8,
      min_bucket_width: 100,
      label_style: "ordinal" as const,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const preview = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        auto_band: policy,
        actor: "analytics-owner",
        reason: "Allow bounded duration groups without model-authored edges.",
      }, async () => inspection);
      expect(preview.candidate.pack.resources[0]!.auto_bands).toEqual([policy]);
      expect(preview.build.overrides.resources["public.service_visits"]?.auto_bands)
        .toMatchObject({
          duration_ms: {
            actor: "analytics-owner",
            reason: "Allow bounded duration groups without model-authored edges.",
          },
        });
      await commitBoundaryResourceReviewMutation(root, preview);

      let context = await loadBoundaryReviewContext(root);
      expect(context.candidate.pack.resources[0]!.auto_bands).toEqual([policy]);
      const review = formatFocusedBoundaryActivationReview(context.bundle, false);
      expect(review).toContain(
        "duration_ms: automatic quantile or equal_width, 3-8 buckets, ordinal",
      );
      expect(review).toContain("labels");

      const removal = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        auto_band: { ...policy, remove: true },
        actor: "analytics-owner",
        reason: "Return duration grouping to fixed reviewed bands only.",
      }, async () => inspection);
      await commitBoundaryResourceReviewMutation(root, removal);
      context = await loadBoundaryReviewContext(root);
      expect(context.candidate.pack.resources[0]!.auto_bands).toBeUndefined();
      expect(context.progress?.review_overrides.resources["public.service_visits"]?.auto_bands)
        .toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("stages exact scalar grouping without changing active authority until activation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-exact-numeric-grouping-"));
    const inspection = boundaryInspection();
    inspection.tables[0]!.columns.push({
      name: "started_year",
      data_type: "integer",
      nullable: false,
      generated: false,
      ordinal_position: inspection.tables[0]!.columns.length + 1,
      suggestions: {
        tenant: false,
        conflict: false,
        sensitive: false,
        immutable: false,
        large_or_binary: false,
      },
    });
    inspection.tables[0]!.suggestions.default_visible_columns.push("started_year");
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const generated = await loadBoundaryReviewContext(root);
      const generatedResource = generated.candidate.pack.resources[0]!;
      const narrowing = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        filterable_fields: Object.keys(generatedResource.filterable_fields)
          .filter((field) => field !== "started_year"),
        sortable_fields: generatedResource.sortable_fields
          .filter((field) => field !== "started_year"),
        aggregate_measures: generatedResource.aggregate_measures
          .filter((field) => field !== "started_year"),
        actor: "analytics-owner",
        reason: "Keep exact grouping independent from filtering, sorting, and measures.",
      }, async () => inspection);
      await commitBoundaryResourceReviewMutation(root, narrowing);
      const initial = await loadBoundaryReviewContext(root);
      const initialResource = initial.candidate.pack.resources[0]!;
      expect(initialResource.groupable_fields).not.toContain("started_year");
      expect(initialResource.filterable_fields).not.toHaveProperty("started_year");
      expect(initialResource.sortable_fields).not.toContain("started_year");
      expect(initialResource.aggregate_measures).not.toContain("started_year");
      const initialGroupable = [...initialResource.groupable_fields];
      const initialDigest = explorationBoundaryCandidateDigest(initial.candidate);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: initial.candidate,
        expectedDigest: initialDigest,
        actor: "analytics-owner",
        confirmation: `ACTIVATE ${initialDigest}`,
        confirmedDecisions: initial.candidate.unresolved_decisions,
        currentInspection: inspection,
      });

      let cliPreviewOutput = "";
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        cliPreviewOutput += String(chunk);
        return true;
      });
      await expect(boundaryReviewCommandInternal([
        "resource", "public.service_visits",
        "--project-root", root,
        "--allow-exact-grouping", "started_year",
        "--actor", "analytics-owner",
        "--reason", "Calendar year is a safe, bounded operational dimension.",
        "--json",
      ], async () => inspection)).resolves.toBe(0);
      stdout.mockRestore();
      expect(JSON.parse(cliPreviewOutput)).toMatchObject({
        authority_activated: false,
        source_database_changed: false,
      });

      const preview = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        allow_exact_numeric_grouping_fields: ["started_year"],
        actor: "analytics-owner",
        reason: "Calendar year is a safe, bounded operational dimension.",
      }, async () => inspection);
      const staged = preview.candidate.pack.resources[0]!;
      expect(staged.groupable_fields).toEqual(
        expect.arrayContaining([...initialGroupable, "started_year"]),
      );
      expect(staged.filterable_fields).not.toHaveProperty("started_year");
      expect(staged.sortable_fields).not.toContain("started_year");
      expect(staged.aggregate_measures).not.toContain("started_year");
      expect(staged.numeric_bands).toBeUndefined();
      expect(staged.auto_bands).toBeUndefined();
      expect(preview.build.overrides.resources["public.service_visits"]?.exact_numeric_grouping)
        .toMatchObject({
          started_year: {
            actor: "analytics-owner",
            reason: "Calendar year is a safe, bounded operational dimension.",
          },
        });
      expect((await loadActivatedExplorationBoundaries(root))[0]!
        .pack.resources[0]!.groupable_fields).not.toContain("started_year");

      await commitBoundaryResourceReviewMutation(root, preview);
      expect((await loadActivatedExplorationBoundaries(root))[0]!
        .pack.resources[0]!.groupable_fields).not.toContain("started_year");
      const stagedContext = await loadBoundaryReviewContext(root);
      const stagedDigest = explorationBoundaryCandidateDigest(stagedContext.candidate);
      const activated = await activateExplorationBoundary({
        projectRoot: root,
        candidate: stagedContext.candidate,
        expectedDigest: stagedDigest,
        actor: "analytics-owner",
        confirmation: `ACTIVATE ${stagedDigest}`,
        confirmedDecisions: stagedContext.candidate.unresolved_decisions,
        currentInspection: inspection,
      });
      expect(activated.pack.resources[0]!.groupable_fields).toContain("started_year");
      expect(activated.pack.resources[0]!.filterable_fields).not.toHaveProperty("started_year");
      expect(activated.pack.resources[0]!.sortable_fields).not.toContain("started_year");
      expect(activated.pack.resources[0]!.aggregate_measures).not.toContain("started_year");

      const view = await inspectBoundaryResourceReview(root, "public.service_visits");
      expect(view.exact_numeric_grouping_eligibility?.started_year).toEqual({
        eligible: true,
        reasons: [],
      });
      expect(view.fields.find((field) => field.name === "started_year")
        ?.exact_numeric_grouping_review_override).toMatchObject({ actor: "analytics-owner" });

      let legacyAliasOutput = "";
      const legacyStdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        legacyAliasOutput += String(chunk);
        return true;
      });
      await expect(boundaryReviewCommandInternal([
        "resource", "public.service_visits",
        "--project-root", root,
        "--remove-exact-numeric-grouping", "started_year",
        "--actor", "analytics-owner",
        "--reason", "Verify the Runner 1.7.1 compatibility alias.",
        "--json",
      ], async () => inspection)).resolves.toBe(0);
      legacyStdout.mockRestore();
      const legacyAliasPreview = JSON.parse(legacyAliasOutput);
      const legacyGroupingChange = legacyAliasPreview.semantic_diff
        .analytical_operation_changes.find((change: { field: string }) =>
          change.field === "started_year");
      expect(legacyGroupingChange.before).toContain("group");
      expect(legacyGroupingChange.after).not.toContain("group");

      const retypedInspection = structuredClone(inspection);
      retypedInspection.tables[0]!.columns
        .find((field) => field.name === "started_year")!.data_type = "date";
      const unrelatedAfterRetype = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        metadata: { label: "Service visits" },
        actor: "analytics-owner",
        reason: "Add a reviewed display label without carrying stale field authority.",
      }, async () => retypedInspection);
      expect(unrelatedAfterRetype.candidate.pack.resources[0]!.groupable_fields)
        .not.toContain("started_year");
      expect(unrelatedAfterRetype.build.overrides.resources["public.service_visits"]
        ?.exact_numeric_grouping).toBeUndefined();
      expect((await loadActivatedExplorationBoundaries(root))[0]!
        .pack.resources[0]!.groupable_fields).toContain("started_year");

      const removal = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        remove_exact_numeric_grouping_fields: ["started_year"],
        actor: "analytics-owner",
        reason: "This dimension is no longer needed by the reviewed agent.",
      }, async () => inspection);
      expect(removal.candidate.pack.resources[0]!.groupable_fields)
        .not.toContain("started_year");
      expect((await loadActivatedExplorationBoundaries(root))[0]!
        .pack.resources[0]!.groupable_fields).toContain("started_year");
      await commitBoundaryResourceReviewMutation(root, removal);
      expect((await loadBoundaryReviewContext(root)).candidate.pack.resources[0]!
        .groupable_fields).not.toContain("started_year");
      expect((await loadActivatedExplorationBoundaries(root))[0]!
        .pack.resources[0]!.groupable_fields).toContain("started_year");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("refuses automatic numeric-band review on MySQL 5.7 through the shared CLI and Workbench mutation path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-mysql57-auto-band-"));
    const inspection = boundaryInspection();
    inspection.engine = "mysql";
    inspection.server_version = "MySQL 5.7.44-log";
    inspection.tables[0]!.columns.push({
      name: "duration_ms",
      data_type: "integer",
      nullable: false,
      generated: false,
      ordinal_position: inspection.tables[0]!.columns.length + 1,
      suggestions: {
        tenant: false,
        conflict: false,
        sensitive: false,
        immutable: false,
        large_or_binary: false,
      },
    });
    inspection.tables[0]!.suggestions.default_visible_columns.push("duration_ms");
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        auto_band: {
          field: "duration_ms",
          methods: ["quantile"],
          min_buckets: 3,
          max_buckets: 8,
          label_style: "ordinal",
        },
        actor: "analytics-owner",
        reason: "This request must be rejected before it can become authority.",
      }, async () => inspection)).rejects.toThrow(
        /automatic numeric bands.*unavailable.*MySQL 5\.7/i,
      );
      const context = await loadBoundaryReviewContext(root);
      expect(context.candidate.pack.resources[0]!.auto_bands).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("renames and deletes disabled saved boundaries through the CLI front door", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-library-cli-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const context = await loadBoundaryReviewContext(root);
      await synchronizeBoundaryLibrary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: context.candidate,
      });
      await createSavedBoundary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: context.candidate,
        name: "support_analytics",
        resourceId: "public.service_visits",
        actor: "alice",
      });

      await expect(boundaryCommand([
        "rename", "support_analytics",
        "--to", "support_team",
        "--actor", "alice",
        "--reason", "Use the team-facing boundary name.",
        "--project-root", root,
        "--json",
      ], async () => inspection)).resolves.toBe(0);
      let library = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-library.json"),
        "utf8",
      ));
      expect(library.selected_name).toBe("support_team");
      expect(library.boundaries).toHaveProperty("support_team");
      expect(library.boundaries).not.toHaveProperty("support_analytics");

      await expect(boundaryCommand([
        "delete", "support_team",
        "--yes",
        "--project-root", root,
        "--json",
      ], async () => inspection)).resolves.toBe(0);
      library = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-library.json"),
        "utf8",
      ));
      expect(library.boundaries).not.toHaveProperty("support_team");
      expect(Object.keys(library.boundaries)).toHaveLength(1);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("lists the fixed four tools for an active local Read project, even before Action activation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-explore-tools-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const guided = await initializeGuidedProject({
        projectRoot: root,
        build,
        runnerVersion: "1.7.0",
      });
      await expect(main([
        "mcp", "client-config",
        "--client", "claude-code",
        "--config", guided.config_path,
      ])).rejects.toThrow(
        /Local Explore client config requires an active reviewed development\/staging boundary.*start --cli/s,
      );
      const digest = explorationBoundaryCandidateDigest(build.exploration_boundary);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: build.exploration_boundary,
        expectedDigest: digest,
        actor: "reviewer",
        confirmation: `ACTIVATE ${digest}`,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        currentInspection: inspection,
      });

      let output = "";
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });
      await expect(main([
        "tools", "list",
        "--config", guided.config_path,
        "--store", ":memory:",
        "--json",
      ])).resolves.toBe(0);
      const preview = JSON.parse(output);
      expect(preview).toMatchObject({
        ok: true,
        surface: "local_explore",
        alias_mode: "canonical",
        exposed_to_mcp: ["app.describe_data", "app.explore_data", "app.describe_actions", "app.request_change"],
      });
      expect(preview.checks).toContainEqual({
        name: "model-facing tools present",
        ok: true,
        detail: "app.describe_data, app.explore_data, app.describe_actions, app.request_change",
      });
      expect(JSON.stringify(preview)).not.toContain("semantic tools present");

      output = "";
      await expect(main([
        "mcp", "client-config",
        "--client", "claude-code",
        "--config", guided.config_path,
        "--include-instructions",
      ])).resolves.toBe(0);
      const clientConfig = JSON.parse(output);
      expect(clientConfig.mcpServers.synapsor).toEqual({
        command: "synapsor-runner",
        args: [
          "mcp", "serve",
          "--authoring",
          "--project-root", root,
          "--config", guided.config_path,
        ],
      });
      expect(clientConfig.agent_instructions).toMatchObject({
        alias_mode: "canonical",
        recommended_system_prompt: expect.stringContaining(
          "Use app.describe_data only to discover exact reviewed",
        ),
      });
      expect(clientConfig.agent_instructions.recommended_system_prompt).not.toContain("propose-first");

      await expect(main([
        "mcp", "client-config",
        "--client", "claude-code",
        "--config", guided.config_path,
        "--alias-mode", "openai",
      ])).rejects.toThrow(/Local Explore client config uses fixed app\.describe_data\/app\.explore_data names/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("reports serving boundaries separately from the disabled boundary being edited", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-status-active-set-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const activeDigest = explorationBoundaryCandidateDigest(build.exploration_boundary);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: build.exploration_boundary,
        expectedDigest: activeDigest,
        actor: "first-reviewer",
        confirmation: `ACTIVATE ${activeDigest}`,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        currentInspection: inspection,
      });
      const disabled = await createSavedBoundary({
        projectRoot: root,
        draft: build.exploration_boundary,
        currentCandidate: build.exploration_boundary,
        name: "reviewed_catalog",
        resourceId: "public.service_visits",
        actor: "second-reviewer",
      });

      await expect(boundaryCommand([
        "status", "--project-root", root, "--json",
      ])).resolves.toBe(0);
      const status = JSON.parse(output);
      expect(status).toMatchObject({
        activation: "active",
        deployment_state: "active",
        active_boundaries: [{
          name: build.exploration_boundary.pack.name,
          tables: ["public.service_visits"],
          digest: activeDigest,
        }],
        active_boundary_name: build.exploration_boundary.pack.name,
        active_tables: ["public.service_visits"],
        editing: {
          name: "reviewed_catalog",
          state: "disabled_draft",
          tables: ["public.service_visits"],
          decisions_confirmed: 0,
          decisions_total: disabled.candidate.unresolved_decisions.length,
        },
      });

      output = "";
      await expect(boundaryCommand([
        "status", "--project-root", root,
      ])).resolves.toBe(0);
      expect(output).toContain("Deployment state: active");
      expect(output).toContain(
        `Active boundaries: ${build.exploration_boundary.pack.name} (1 table)`,
      );
      expect(output).toContain(
        `Editing: reviewed_catalog (1 table, disabled draft, 0/${disabled.candidate.unresolved_decisions.length} decisions)`,
      );
      expect(output).not.toContain("Active boundary: none");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("creates and activates an additional boundary in the active development profile", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-profile-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
      overrides: {
        schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
        resources: {
          "public.service_visits": {
            fields: {
              scheduled_at: {
                exposure: "withhold_from_model",
                actor: "first-reviewer",
                reason: "Keep exact visit timestamps out of the first boundary only.",
                decided_at: "2026-08-12T12:00:00.000Z",
              },
            },
          },
        },
      },
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const development = reviewExplorationBoundaryCandidate(
        build.exploration_boundary,
        {
          ...structuredClone(build.exploration_boundary),
          deployment_profile: "development",
        },
      ).candidate;
      const firstDigest = explorationBoundaryCandidateDigest(development);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: development,
        expectedDigest: firstDigest,
        actor: "first-reviewer",
        confirmation: `ACTIVATE ${firstDigest}`,
        confirmedDecisions: development.unresolved_decisions,
        currentInspection: inspection,
      });

      const progress = await createSavedBoundary({
        projectRoot: root,
        draft: build.exploration_boundary,
        currentCandidate: build.exploration_boundary,
        name: "products",
        resourceId: build.exploration_boundary.pack.resources[0]!.id,
        actor: "second-reviewer",
      });
      expect(progress.candidate.deployment_profile).toBe("development");
      expect(progress.candidate.generation_lock_fingerprint)
        .not.toBe(build.exploration_boundary.generation_lock_fingerprint);
      const completed = createBoundaryReviewProgress({
        draft: build.exploration_boundary,
        candidate: progress.candidate,
        confirmedDecisions: progress.candidate.unresolved_decisions,
        previous: progress,
        actor: "second-reviewer",
        revision: progress.revision + 1,
      });
      await saveBoundaryReviewProgress(root, completed);
      const session: BoundaryReviewInteractiveSession = {
        chooseResource: async () => undefined,
        editFieldTiers: async () => undefined,
        promptText: async () => "second-reviewer",
        confirm: async () => true,
      };
      await expect(boundaryActivateCommandInternal(
        ["--project-root", root, "--actor", "second-reviewer"],
        async () => inspection,
        session,
      )).resolves.toBe(0);
      const active = await loadActivatedExplorationBoundaries(root);
      expect(active).toHaveLength(2);
      expect(active.map((boundary) => boundary.deployment_profile)).toEqual([
        "development",
        "development",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("creates and activates a second MySQL boundary from explicit trusted bindings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-mysql-second-boundary-"));
    const inspection = boundaryInspection();
    inspection.engine = "mysql";
    inspection.server_version = "MySQL 8.4";
    inspection.schemas = ["clinicdb"];
    inspection.tables[0]!.schema = "clinicdb";
    inspection.tables[0]!.row_level_security = false;
    inspection.tables[0]!.row_level_security_policies = [];
    inspection.tables[0]!.role_posture = {
      ...inspection.tables[0]!.role_posture!,
      row_security_forced: false,
      row_security_effective_for_current_role: false,
    };
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "clinicdb",
      configuredTrustedContext: {
        schema_version: CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION,
        provider: "environment",
        tenant_binding: "tenant_id",
        tenant_env: "SYNAPSOR_TENANT_ID",
        principal_env: "SYNAPSOR_PRINCIPAL",
      },
      overrides: {
        schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
        resources: {
          "clinicdb.service_visits": {
            fields: {
              scheduled_at: {
                exposure: "withhold_from_model",
                actor: "first-reviewer",
                reason: "Keep exact timestamps out of the first boundary only.",
                decided_at: "2026-08-12T20:00:00.000Z",
              },
            },
          },
        },
      },
    });
    try {
      expect(build.policy_baseline.boundary.pack.resources).toEqual([
        expect.objectContaining({
          id: "clinicdb.service_visits",
          tenant_key: "tenant_id",
        }),
      ]);
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const reviewed = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "clinicdb.service_visits",
        minimum_cohort_size: 4,
        actor: "first-reviewer",
        reason: "Use a reviewed four-row aggregate cohort in the first boundary.",
      }, async () => inspection);
      await commitBoundaryResourceReviewMutation(root, reviewed);
      const firstContext = await loadBoundaryReviewContext(root);
      const baselineAfterReview = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/auto-boundary-policy-baseline.json"),
        "utf8",
      ));
      expect(baselineAfterReview.boundary.pack.resources).toEqual([
        expect.objectContaining({
          id: "clinicdb.service_visits",
          tenant_key: "tenant_id",
        }),
      ]);
      const firstDigest = explorationBoundaryCandidateDigest(firstContext.candidate);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: firstContext.candidate,
        expectedDigest: firstDigest,
        actor: "first-reviewer",
        confirmation: `ACTIVATE ${firstDigest}`,
        confirmedDecisions: firstContext.candidate.unresolved_decisions,
        currentInspection: inspection,
      });
      const second = await createSavedBoundary({
        projectRoot: root,
        draft: firstContext.draft,
        currentCandidate: firstContext.candidate,
        currentProgress: firstContext.progress,
        name: "visits_secondary",
        resourceId: "clinicdb.service_visits",
        actor: "second-reviewer",
      });
      expect(second.candidate.pack.resources[0]).toMatchObject({
        id: "clinicdb.service_visits",
        tenant_key: "tenant_id",
      });
      expect(second.candidate.pack.resources[0]!.model_withheld_fields ?? [])
        .not.toContain("scheduled_at");
      expect(second.review_overrides.resources).toEqual({});

      const completed = createBoundaryReviewProgress({
        draft: firstContext.draft,
        candidate: second.candidate,
        confirmedDecisions: second.candidate.unresolved_decisions,
        previous: second,
        actor: "second-reviewer",
        revision: second.revision + 1,
      });
      await saveBoundaryReviewProgress(root, completed);
      const session: BoundaryReviewInteractiveSession = {
        chooseResource: async () => undefined,
        editFieldTiers: async () => undefined,
        promptText: async () => "second-reviewer",
        confirm: async () => true,
      };
      await expect(boundaryActivateCommandInternal(
        ["--project-root", root, "--actor", "second-reviewer"],
        async () => inspection,
        session,
      )).resolves.toBe(0);

      const active = await loadActivatedExplorationBoundaries(root);
      expect(active.map((boundary) => boundary.pack.name).sort()).toEqual([
        "reviewed_staging",
        "visits_secondary",
      ]);
      expect(() => selectActiveExploreBoundary(
        active,
        undefined,
        "clinicdb.service_visits",
      )).toThrowError(expect.objectContaining({ code: "EXPLORE_BOUNDARY_REQUIRED" }));
      expect(selectActiveExploreBoundary(
        active,
        "reviewed_staging",
        "clinicdb.service_visits",
      ).pack.name).toBe("reviewed_staging");
      expect(selectActiveExploreBoundary(
        active,
        "visits_secondary",
        "clinicdb.service_visits",
      ).pack.name).toBe("visits_secondary");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("preserves reviewed MySQL HTTP bindings and its authoring baseline through review mutation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-mysql-production-review-bindings-"));
    const inspection = boundaryInspection();
    inspection.engine = "mysql";
    inspection.server_version = "MySQL 8.4";
    inspection.schemas = ["clinicdb"];
    const table = inspection.tables[0]!;
    table.schema = "clinicdb";
    table.row_level_security = false;
    table.row_level_security_policies = [];
    table.role_posture = {
      ...table.role_posture!,
      row_security_forced: false,
      row_security_effective_for_current_role: false,
    };
    table.columns.push({
      name: "attending",
      data_type: "varchar",
      nullable: false,
      generated: false,
      ordinal_position: table.columns.length + 1,
      suggestions: {
        tenant: false,
        conflict: false,
        sensitive: false,
        immutable: false,
        large_or_binary: false,
      },
    });
    table.suggestions.default_visible_columns.push("attending");
    const configuredTrustedContext = {
      schema_version: CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION,
      provider: "http_claims" as const,
      tenant_binding: "tenant_id",
      principal_binding: "attending",
      tenant_claim: "tenant_id",
      principal_claim: "sub",
    } as const;
    const configPath = path.join(root, "synapsor.runner.json");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(main([
      "config", "init", "--production-explore",
      "--project-root", root,
      "--output", configPath,
      "--engine", "mysql",
      "--source", "local_mysql",
      "--read-url-env", "DATABASE_URL",
      "--tenant-binding", "tenant_id",
      "--principal-binding", "attending",
      "--tenant-claim", "tenant_id",
      "--principal-claim", "sub",
      "--issuer", "https://identity.example.test",
      "--audience", "https://runner.example.test/mcp",
      "--accounting-namespace", "clinic.production",
    ])).resolves.toBe(0);
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      sourceName: "local_mysql",
      inspectedSchema: "clinicdb",
      deploymentProfile: "production",
      httpClaims: { tenantClaim: "tenant_id", principalClaim: "sub" },
      configuredTrustedContext,
    });
    try {
      expect(build.policy_baseline.boundary.pack.resources).toEqual([
        expect.objectContaining({
          id: "clinicdb.service_visits",
          tenant_key: "tenant_id",
          principal_key: "attending",
        }),
      ]);
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const preview = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "clinicdb.service_visits",
        minimum_cohort_size: 4,
        actor: "production-reviewer@example.test",
        reason: "Require four contributing rows before releasing an aggregate.",
      }, async () => inspection);
      await commitBoundaryResourceReviewMutation(root, preview);

      const [baseline, lock, context] = await Promise.all([
        fs.readFile(path.join(root, ".synapsor/auto-boundary-policy-baseline.json"), "utf8").then(JSON.parse),
        fs.readFile(path.join(root, ".synapsor/generation-lock.json"), "utf8").then(JSON.parse),
        loadBoundaryReviewContext(root),
      ]);
      expect(baseline.boundary.pack.resources).toEqual([
        expect.objectContaining({
          id: "clinicdb.service_visits",
          tenant_key: "tenant_id",
          principal_key: "attending",
        }),
      ]);
      expect(lock.trusted_context_authority).toEqual(configuredTrustedContext);
      expect(lock.trusted_context_fingerprint).toBe(build.lock.trusted_context_fingerprint);
      expect(context.candidate).toMatchObject({
        deployment_profile: "production",
        trusted_context: {
          provider: "http_claims",
          tenant_claim: "tenant_id",
          principal_claim: "sub",
        },
        budgets: expect.any(Object),
        pack: {
          resources: [expect.objectContaining({
            id: "clinicdb.service_visits",
            tenant_key: "tenant_id",
            principal_key: "attending",
            minimum_cohort_size: 4,
          })],
        },
      });

      const candidateDigest = explorationBoundaryCandidateDigest(context.candidate);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: context.candidate,
        expectedDigest: candidateDigest,
        actor: "production-reviewer@example.test",
        confirmation: `ACTIVATE ${candidateDigest}`,
        confirmedDecisions: context.candidate.unresolved_decisions,
        currentInspection: inspection,
      });
      const active = await loadActivatedExplorationBoundaries(root);
      const runtimeConfig = loadRuntimeConfigFromFile(configPath);
      const startup = await inspectProductionExploreStartup(
        runtimeConfig,
        {
          DATABASE_URL: "mysql://reviewed:secret@mysql.internal/clinicdb",
          SYNAPSOR_CONTROL_DATABASE_URL: "postgresql://control:secret@control.internal/synapsor",
          SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY: "production-budget-hmac-key-material-1234567890",
          SYNAPSOR_SESSION_JWKS_URL: "https://identity.example.test/.well-known/jwks.json",
        },
        async () => active,
        async () => ({ boundary: active[0]!, lock }) as Awaited<ReturnType<typeof prepareScopedExplore>>,
      );
      expect(startup.ok).toBe(true);
      expect(startup.checks).toContainEqual(expect.objectContaining({
        name: "active-production-boundaries",
        ok: true,
      }));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("writes a startable MySQL baseline through the standalone boundary draft command", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-mysql-boundary-draft-command-"));
    const inspection = boundaryInspection();
    inspection.engine = "mysql";
    inspection.server_version = "MySQL 8.4";
    inspection.schemas = ["clinicdb"];
    inspection.tables[0]!.schema = "clinicdb";
    inspection.tables[0]!.row_level_security = false;
    inspection.tables[0]!.row_level_security_policies = [];
    inspection.tables[0]!.role_posture = {
      ...inspection.tables[0]!.role_posture!,
      row_security_forced: false,
      row_security_effective_for_current_role: false,
    };
    try {
      await expect(boundaryCommand([
        "draft",
        "--from-env", "DATABASE_URL",
        "--engine", "mysql",
        "--schema", "clinicdb",
        "--project-root", root,
      ], async () => inspection)).resolves.toBe(0);

      const generatedConfig = JSON.parse(await fs.readFile(
        path.join(root, "synapsor.runner.json"),
        "utf8",
      ));
      expect(generatedConfig.trusted_context).toMatchObject({
        provider: "environment",
        tenant_binding: "tenant_id",
      });
      const draft = JSON.parse(await fs.readFile(
        path.join(root, "synapsor/generated/exploration-boundary.draft.json"),
        "utf8",
      ));
      const baseline = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/auto-boundary-policy-baseline.json"),
        "utf8",
      ));
      expect(draft.pack.resources).toEqual([
        expect.objectContaining({ id: "clinicdb.service_visits", tenant_key: "tenant_id" }),
      ]);
      expect(baseline.boundary.pack.resources).toEqual([
        expect.objectContaining({ id: "clinicdb.service_visits", tenant_key: "tenant_id" }),
      ]);

      const second = await createSavedBoundary({
        projectRoot: root,
        draft,
        currentCandidate: draft,
        name: "visits_from_cli_draft",
        resourceId: "clinicdb.service_visits",
        actor: "second-reviewer",
      });
      expect(second.candidate.pack.resources).toEqual([
        expect.objectContaining({ id: "clinicdb.service_visits", tenant_key: "tenant_id" }),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("invalidates stale profile review when restoring an existing disabled boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-profile-rebase-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const development = reviewExplorationBoundaryCandidate(
        build.exploration_boundary,
        {
          ...structuredClone(build.exploration_boundary),
          deployment_profile: "development",
        },
      ).candidate;
      const activeDigest = explorationBoundaryCandidateDigest(development);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: development,
        expectedDigest: activeDigest,
        actor: "first-reviewer",
        confirmation: `ACTIVATE ${activeDigest}`,
        confirmedDecisions: development.unresolved_decisions,
        currentInspection: inspection,
      });

      const staleCandidate = structuredClone(build.exploration_boundary);
      staleCandidate.pack.name = "products";
      staleCandidate.pack.resources = [{
        ...structuredClone(staleCandidate.pack.resources[0]!),
        relationships: [],
      }];
      const reviewedStale = reviewExplorationBoundaryCandidate(
        build.exploration_boundary,
        staleCandidate,
      ).candidate;
      const staleProgress = createBoundaryReviewProgress({
        draft: build.exploration_boundary,
        candidate: reviewedStale,
        confirmedDecisions: reviewedStale.unresolved_decisions,
        actor: "stale-reviewer",
        revision: 1,
      });
      await saveBoundaryReviewProgress(root, staleProgress);

      let observedOutstanding: number | undefined;
      let observedEntryOutstanding: number | undefined;
      const session: BoundaryReviewInteractiveSession = {
        chooseResource: async (_resources, overview) => {
          observedOutstanding = overview?.outstanding_decisions;
          observedEntryOutstanding = overview?.boundaries?.find(
            (entry) => entry.name === "products",
          )?.outstanding_decisions;
          return undefined;
        },
        editFieldTiers: async () => undefined,
        promptText: async () => undefined,
        confirm: async () => undefined,
      };
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session)).resolves.toBe(0);
      expect(observedOutstanding).toBe(1);
      expect(observedEntryOutstanding).toBe(1);
      const aligned = await readBoundaryReviewProgress(root, build.exploration_boundary);
      expect(aligned?.candidate.deployment_profile).toBe("development");
      expect(aligned?.confirmations).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "global.deployment_profile" }),
      ]));
      expect(aligned?.invalidated_decisions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "global.deployment_profile",
          reason: "reviewed_input_changed",
        }),
      ]));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("preserves and reports every Runner-only decision across an atomic multi-table batch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-privacy-batch-"));
    const inspection = boundaryInspection();
    const second = structuredClone(inspection.tables[0]!);
    second.name = "x17";
    inspection.tables.push(second);
    const build = buildAutoBoundary({ inspection,
      project: { root, package_manager: "npm", frameworks: ["node"], schema_inputs: [], database_env_names: ["DATABASE_URL"] },
      sourceEnv: "DATABASE_URL", inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const before = await loadBoundaryReviewContext(root);
      expect(before.candidate.pack.resources).toHaveLength(2);
      const requests = before.candidate.pack.resources.map((resource) => ({
        resource_id: resource.id, withhold_from_model_fields: ["id", "scheduled_at"],
        private_model_fields: ["id", "scheduled_at"],
        actor: "privacy-reviewer", reason: "Keep exact identifiers and verification fields private.",
      }));
      const preview = await prepareBoundaryReviewMutationBatch(root, requests, async () => inspection);
      for (const diff of preview.semantic_diff) expect(diff.added_model_withheld_fields).toEqual(["id", "scheduled_at"]);
      for (const resource of preview.candidate.pack.resources) {
        expect(resource.model_withheld_fields).toEqual(["id", "scheduled_at"]);
        expect(resource.selectable_fields).toEqual(expect.arrayContaining(["id", "scheduled_at", "status"]));
        expect(resource.kept_out_fields).not.toEqual(expect.arrayContaining(["id"]));
        for (const field of ["id", "scheduled_at"]) {
          expect(resource.filterable_fields[field]).toBeUndefined();
          expect(resource.sortable_fields).not.toContain(field);
          expect(resource.count_distinct_fields).not.toContain(field);
          expect(resource.time_bucket_fields[field]).toBeUndefined();
        }
      }
      expect((await loadBoundaryReviewContext(root)).candidate).toEqual(before.candidate);
      // Keep the final consistency check even for callers outside model chat.
      await expect(prepareBoundaryReviewMutationBatch(root, [
        { ...requests[0]!, selectable_fields: ["status"] }, requests[1]!,
      ], async () => inspection)).rejects.toThrow("model-withheld decision");
      expect((await loadBoundaryReviewContext(root)).candidate).toEqual(before.candidate);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves one boundary-wide depth decision across every resource in an atomic batch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-cli-batch-limits-"));
    const inspection = batchBoundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm" as const,
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await initializeGuidedProject({ projectRoot: root, build, runnerVersion: "1.8.0" });
      const preview = await prepareBoundaryReviewMutationBatch(root, [
        {
          resource_id: "public.service_routes",
          include: true,
          tenant_key: "tenant_id",
          principal_key: null,
          selectable_fields: ["id", "status"],
          max_derived_scope_hops: 3,
          max_analysis_relationship_hops: 3,
          actor: "alice",
          reason: "Prepare one disabled three-hop mapping catalog.",
        },
        {
          resource_id: "public.service_visits",
          include: true,
          tenant_key: "tenant_id",
          principal_key: null,
          selectable_fields: ["id", "scheduled_at", "status"],
          actor: "alice",
          reason: "Prepare one disabled three-hop mapping catalog.",
        },
      ], async () => inspection);

      expect(preview.candidate.pack.resources.map((resource) => resource.id))
        .toEqual(["public.service_routes", "public.service_visits"]);
      expect(preview.candidate.budgets).toMatchObject({
        max_derived_scope_hops: 3,
        max_analysis_relationship_hops: 3,
      });
      expect(preview.build.exploration_boundary.budgets).toMatchObject({
        max_derived_scope_hops: 3,
        max_analysis_relationship_hops: 3,
      });
      expect(preview.candidate.activation).toBe("disabled_unreviewed");
      expect(preview.source_database_changed).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("applies a versioned multi-resource decision file and headlessly activates its exact result", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-cli-batch-"));
    const inspection = batchBoundaryInspection();
    const project = {
      root,
      package_manager: "npm" as const,
      frameworks: ["node"],
      schema_inputs: [],
      database_env_names: ["DATABASE_URL"],
    };
    const build = buildAutoBoundary({
      inspection,
      project,
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    expect(build.exploration_boundary.pack.resources).toEqual([]);
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const guided = await initializeGuidedProject({
        projectRoot: root,
        build,
        runnerVersion: "1.6.5",
      });
      const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const publicPath = path.join(path.dirname(guided.config_path), "batch-reviewer.pub.pem");
      const privatePath = path.join(root, "batch-reviewer.private.pem");
      await fs.writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }).toString(), "utf8");
      await fs.writeFile(
        privatePath,
        privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        { encoding: "utf8", mode: 0o600 },
      );
      const config = JSON.parse(await fs.readFile(guided.config_path, "utf8"));
      config.operator_identity = {
        provider: "signed_key",
        operators: {
          alice: {
            public_key_path: "./batch-reviewer.pub.pem",
            roles: ["boundary_reviewer"],
          },
        },
      };
      await fs.writeFile(guided.config_path, `${JSON.stringify(config, null, 2)}\n`, "utf8");

      let output = "";
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });
      const bundlePath = path.join(root, "boundary-review.json");
      await boundaryReviewCommand([
        "--project-root", root,
        "--output", bundlePath,
      ], async () => inspection);
      const bundle = JSON.parse(await fs.readFile(bundlePath, "utf8"));
      expect(bundle.mutation_bindings).toMatchObject({
        candidate_digest: bundle.candidate_digest,
        review_revision: 0,
      });

      const resources = [
        {
          resource_id: "public.service_routes",
          include: true,
          tenant_key: "tenant_id",
          principal_key: null,
          selectable_fields: ["id", "status"],
        },
        {
          resource_id: "public.service_visits",
          include: true,
          tenant_key: "tenant_id",
          principal_key: null,
          selectable_fields: ["id", "scheduled_at", "status"],
        },
      ];
      const decision = {
        schema_version: "synapsor.boundary-review-decisions.v1",
        review_bundle_digest: bundle.bundle_digest,
        bindings: bundle.mutation_bindings,
        actor: "alice",
        reason: "Both service resources use the reviewed tenant column and need no principal restriction.",
        resources,
      };
      const decisionPath = path.join(root, "boundary-decisions.json");
      await fs.writeFile(decisionPath, `${JSON.stringify(decision, null, 2)}\n`, "utf8");

      const duplicatePath = path.join(root, "duplicate-decisions.json");
      await fs.writeFile(
        duplicatePath,
        `${JSON.stringify({ ...decision, resources: [resources[0], resources[0]] }, null, 2)}\n`,
        "utf8",
      );
      await expect(boundaryReviewCommand([
        "--project-root", root,
        "--apply-decisions", duplicatePath,
        "--json",
      ], async () => inspection)).rejects.toThrow(/repeats resource/i);
      await expect(fs.access(path.join(root, ".synapsor/boundary-review-progress.json")))
        .rejects.toMatchObject({ code: "ENOENT" });

      const unknownPath = path.join(root, "unknown-decisions.json");
      await fs.writeFile(
        unknownPath,
        `${JSON.stringify({
          ...decision,
          resources: [{ ...resources[0], resource_id: "public.not_inspected" }],
        }, null, 2)}\n`,
        "utf8",
      );
      await expect(boundaryReviewCommand([
        "--project-root", root,
        "--apply-decisions", unknownPath,
        "--json",
      ], async () => inspection)).rejects.toThrow(/unknown resource/i);

      output = "";
      await expect(boundaryReviewCommand([
        "--project-root", root,
        "--apply-decisions", decisionPath,
        "--json",
      ], async () => inspection)).resolves.toBe(0);
      const preview = JSON.parse(output);
      expect(preview).toMatchObject({
        ok: true,
        schema_version: "synapsor.boundary-review-mutation-batch-preview.v1",
        authority_activated: false,
        source_database_changed: false,
      });
      expect(preview.semantic_diff).toHaveLength(2);

      output = "";
      await expect(boundaryReviewCommand([
        "--project-root", root,
        "--apply-decisions", decisionPath,
        "--apply",
        "--confirm", `APPLY REVIEW ${preview.decision_digest}`,
        "--config", guided.config_path,
        "--identity", "alice",
        "--identity-key", privatePath,
        "--required-role", "boundary_reviewer",
        "--nonce", "batch-resource-review-nonce-0001",
        "--json",
      ], async () => inspection)).resolves.toBe(0);
      const applied = JSON.parse(output);
      expect(applied).toMatchObject({
        ok: true,
        review_revision: 1,
        source_database_changed: false,
      });
      const progress = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(progress.candidate.pack.resources.map((resource: { id: string }) => resource.id))
        .toEqual(["public.service_routes", "public.service_visits"]);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });

      const reviewedContext = await loadBoundaryReviewContext(root);
      const completedProgress = createBoundaryReviewProgress({
        draft: reviewedContext.draft,
        candidate: reviewedContext.candidate,
        confirmedDecisions: reviewedContext.candidate.unresolved_decisions,
        previous: reviewedContext.progress,
        actor: "alice",
        reason: "Confirmed the exact post-review authority for both resources.",
        revision: (reviewedContext.progress?.revision ?? 0) + 1,
        now: "2026-08-12T12:00:00.000Z",
      });
      await saveBoundaryReviewProgress(root, completedProgress);
      const activationBundlePath = path.join(root, "post-review-boundary.json");
      await boundaryReviewCommand([
        "--project-root", root,
        "--output", activationBundlePath,
      ], async () => inspection);
      const activationBundle = JSON.parse(await fs.readFile(activationBundlePath, "utf8"));
      expect(activationBundle.outstanding_decision_ids).toEqual([]);
      await expect(boundaryActivateCommandInternal([
        "--project-root", root,
        "--config", guided.config_path,
        "--review-bundle", activationBundlePath,
        "--headless",
        "--confirm", `ACTIVATE ${activationBundle.candidate_digest}`,
        "--identity", "alice",
        "--identity-key", privatePath,
        "--required-role", "boundary_reviewer",
        "--reason", "Activate the exact reviewed multi-resource authority.",
        "--environment", "staging",
        "--nonce", "batch-activation-nonce-0001",
        "--json",
      ], async () => inspection)).resolves.toBe(0);
      const active = await loadActivatedExplorationBoundaries(root);
      expect(active.map((boundary) => boundary.pack.resources.map((resource) => resource.id)))
        .toEqual([["public.service_routes", "public.service_visits"]]);

      await expect(boundaryReviewCommand([
        "--project-root", root,
        "--apply-decisions", decisionPath,
        "--json",
      ], async () => inspection)).rejects.toThrow(/stale|another review bundle/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("revalidates a workload-minimized candidate and saves it disabled without active authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-read-workload-authoring-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const analysis = analyzeReadWorkloadSet({
        generatedBoundary: build.exploration_boundary,
        workload: {
          schema_version: READ_WORKLOAD_SET_VERSION,
          name: "service_reporting",
          allowed: [{
            id: "visits_by_status",
            description: "Count service visits by status",
            plan: {
              kind: "aggregate",
              resource: "public.service_visits",
              measures: [{ function: "count" }],
              dimensions: [{ field: "status" }],
            },
          }],
          forbidden: [{
            id: "raw_visit_times",
            description: "Do not return individual scheduled timestamps",
            plan: {
              kind: "rows",
              resource: "public.service_visits",
              select: ["scheduled_at"],
            },
          }],
          source: { kind: "operator_exact_plan" },
        },
      });
      expect(analysis.status).toBe("ready");
      const stored = await storeReadWorkloadAnalysis({
        projectRoot: root,
        generatedBoundary: build.exploration_boundary,
        source: { kind: "operator_exact_plan" },
        analysis,
        now: "2026-08-27T12:00:00.000Z",
      });
      const preview = await prepareReadWorkloadCandidate({
        projectRoot: root,
        workload: stored,
        actor: "reviewer@example.test",
        reason: "Compile the representative service reporting workload into a minimum boundary.",
        schemaInspector: async () => inspection,
      });
      expect(preview.mutation.candidate.activation).toBe("disabled_unreviewed");
      expect(preview.authority_activated).toBe(false);
      expect(preview.mutation.candidate.pack.resources[0]).toMatchObject({
        id: "public.service_visits",
        selectable_fields: [],
        groupable_fields: ["status"],
      });
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });

      const committed = await commitReadWorkloadCandidate({
        projectRoot: root,
        preview,
        now: "2026-08-27T12:01:00.000Z",
      });
      expect(committed).toMatchObject({
        authority_activated: false,
        source_database_changed: false,
        review_revision: 1,
      });
      const context = await loadBoundaryReviewContext(root);
      expect(context.bundle.candidate_digest).toBe(committed.candidate_digest);
      expect(context.candidate.activation).toBe("disabled_unreviewed");
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      const reviewed = await readReadWorkloadAnalysis({
        projectRoot: root,
        analysisId: stored.analysis_id,
        generatedBoundary: context.draft,
      });
      expect(reviewed).toMatchObject({
        state: "reviewed",
        review: {
          authority_activated: false,
          candidate_digest: committed.candidate_digest,
        },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("previews and applies an exact workload through boundary assist with a digest-bound human decision", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-assist-cli-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const workloadPath = path.join(root, "representative-reads.json");
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await fs.writeFile(workloadPath, `${JSON.stringify({
        schema_version: READ_WORKLOAD_SET_VERSION,
        name: "service_reporting",
        allowed: [{
          id: "visits_by_status",
          description: "Count service visits by status",
          plan: {
            kind: "aggregate",
            resource: "public.service_visits",
            measures: [{ function: "count" }],
            dimensions: [{ field: "status" }],
          },
        }],
        forbidden: [{
          id: "raw_visit_times",
          description: "Do not return individual scheduled timestamps",
          plan: { kind: "rows", resource: "public.service_visits", select: ["scheduled_at"] },
        }],
        source: { kind: "operator_exact_plan" },
      }, null, 2)}\n`, "utf8");
      await expect(boundaryAssistCommand([
        "--project-root", root,
        "--workload", workloadPath,
        "--actor", "reviewer@example.test",
        "--reason", "Review the minimum service reporting workload.",
        "--json",
      ], async () => inspection)).resolves.toBe(0);
      const preview = JSON.parse(output);
      expect(preview).toMatchObject({
        ok: true,
        workload: { state: "ready" },
        preview: {
          authority_activated: false,
          source_database_changed: false,
        },
      });
      expect(preview.preview.decision_digest).toMatch(/^sha256:/);

      output = "";
      await expect(boundaryAssistCommand([
        "--project-root", root,
        "--analysis", preview.workload.analysis_id,
        "--actor", "reviewer@example.test",
        "--reason", "Review the minimum service reporting workload.",
        "--apply",
        "--confirm", `APPLY WORKLOAD ${preview.preview.decision_digest}`,
        "--json",
      ], async () => inspection)).resolves.toBe(0);
      expect(JSON.parse(output)).toMatchObject({
        ok: true,
        analysis_id: preview.workload.analysis_id,
        authority_activated: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      });
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      stdout.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);
});

function boundaryInspection(): SchemaInspection {
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
    inspected_at: "2026-07-25T12:00:00.000Z",
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
        { ...column("status", "text"), enum_values: ["scheduled", "completed"] },
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

function actionTargetInspection(): SchemaInspection {
  const inspection = boundaryInspection();
  const maintenance = structuredClone(inspection.tables[0]!);
  maintenance.name = "maintenance_requests";
  maintenance.columns = [
    {
      name: "id",
      data_type: "text",
      nullable: false,
      generated: false,
      ordinal_position: 1,
      suggestions: {
        tenant: false,
        conflict: false,
        sensitive: false,
        immutable: true,
        large_or_binary: false,
      },
    },
    {
      name: "tenant_id",
      data_type: "uuid",
      nullable: false,
      generated: false,
      ordinal_position: 2,
      suggestions: {
        tenant: true,
        conflict: false,
        sensitive: false,
        immutable: true,
        large_or_binary: false,
      },
    },
    {
      name: "request_kind",
      data_type: "text",
      nullable: false,
      generated: false,
      ordinal_position: 3,
      enum_values: ["inspection_followup", "repair"],
      suggestions: {
        tenant: false,
        conflict: false,
        sensitive: false,
        immutable: false,
        large_or_binary: false,
      },
    },
    {
      name: "estimated_hours",
      data_type: "integer",
      nullable: false,
      generated: false,
      ordinal_position: 4,
      suggestions: {
        tenant: false,
        conflict: false,
        sensitive: false,
        immutable: false,
        large_or_binary: false,
      },
    },
  ];
  maintenance.primary_key = ["id"];
  maintenance.unique_constraints = [{ name: "maintenance_requests_pkey", columns: ["id"] }];
  maintenance.indexes = [{ name: "maintenance_requests_pkey", columns: ["id"], unique: true }];
  maintenance.suggestions = {
    tenant_columns: ["tenant_id"],
    conflict_columns: [],
    sensitive_columns: [],
    default_visible_columns: ["id", "tenant_id", "request_kind", "estimated_hours"],
  };
  inspection.tables.push(maintenance);
  return inspection;
}

function principalScopeInspection(options: { ambiguous?: boolean } = {}): SchemaInspection {
  const inspection = actionTargetInspection();
  for (const table of inspection.tables) {
    const nextOrdinal = Math.max(0, ...table.columns.map((column) => column.ordinal_position)) + 1;
    table.columns.push({
      name: "principal_id",
      data_type: "uuid",
      nullable: false,
      generated: false,
      ordinal_position: nextOrdinal,
      suggestions: {
        tenant: false,
        conflict: false,
        sensitive: false,
        immutable: true,
        large_or_binary: false,
      },
    });
    table.suggestions.default_visible_columns.push("principal_id");
    if (options.ambiguous) {
      table.columns.push({
        name: "owner_id",
        data_type: "uuid",
        nullable: false,
        generated: false,
        ordinal_position: nextOrdinal + 1,
        suggestions: {
          tenant: false,
          conflict: false,
          sensitive: false,
          immutable: true,
          large_or_binary: false,
        },
      });
      table.suggestions.default_visible_columns.push("owner_id");
    }
  }
  return inspection;
}

function testBoundaryAuthoringChat(
  session: BoundaryReviewInteractiveSession,
): BoundaryAuthoringChat {
  return {
    session: { ...session, presentationMode: "conversation" },
    actionPrompter: {
      choose: async () => undefined,
      text: async () => undefined,
      confirm: async () => undefined,
      message: async () => undefined,
    },
    setModel: vi.fn(),
    setPermissionGuide: vi.fn(),
    runner: vi.fn(),
    model: vi.fn(),
    checkpoint: vi.fn(),
    streamRunner: async () => undefined,
    streamCheckpoint: async () => undefined,
    streamModel: async () => undefined,
    rememberDetails: vi.fn(),
    showDetails: vi.fn(),
    providerStream: vi.fn(),
    progress: async (_message, operation) => operation(),
    close: vi.fn(),
  };
}

function derivedFirstTableInspection(): SchemaInspection {
  const inspection = boundaryInspection();
  const orders = structuredClone(inspection.tables[0]!);
  orders.name = "orders";
  orders.unique_constraints = [{ name: "orders_pkey", columns: ["id"] }];
  orders.indexes = [{ name: "orders_pkey", columns: ["id"], unique: true }];
  const orderItems = structuredClone(orders);
  orderItems.name = "order_items";
  orderItems.columns = orderItems.columns.filter((field) =>
    field.name !== "tenant_id" && field.name !== "status" && field.name !== "scheduled_at");
  orderItems.columns.push({
    name: "order_id",
    data_type: "uuid",
    nullable: false,
    generated: false,
    ordinal_position: orderItems.columns.length + 1,
    suggestions: {
      tenant: false,
      conflict: false,
      sensitive: false,
      immutable: true,
      large_or_binary: false,
    },
  });
  orderItems.suggestions.tenant_columns = [];
  orderItems.suggestions.default_visible_columns = ["id", "order_id"];
  orderItems.row_level_security = false;
  orderItems.row_level_security_policies = [];
  orderItems.role_posture!.row_security_effective_for_current_role = false;
  orderItems.unique_constraints = [{ name: "order_items_pkey", columns: ["id"] }];
  orderItems.indexes = [{ name: "order_items_pkey", columns: ["id"], unique: true }];
  orderItems.foreign_keys = [{
    name: "order_items_order_id_fkey",
    columns: ["order_id"],
    referenced_schema: "public",
    referenced_table: "orders",
    referenced_columns: ["id"],
    delete_rule: "RESTRICT",
  }];
  inspection.tables = [orderItems, orders];
  return inspection;
}

function depthThreeDerivedCliInspection(): SchemaInspection {
  const inspection = derivedFirstTableInspection();
  const orderItems = inspection.tables.find((table) => table.name === "order_items")!;
  const orders = inspection.tables.find((table) => table.name === "orders")!;
  const derivedChild = (
    source: typeof orderItems,
    name: string,
    foreignKeyField: string,
    target: string,
    constraint: string,
  ) => {
    const table = structuredClone(source);
    table.name = name;
    table.columns = table.columns.filter((field) => field.name === "id");
    const foreignKey = structuredClone(source.columns.find((field) => field.name !== "id")!);
    foreignKey.name = foreignKeyField;
    foreignKey.ordinal_position = 2;
    table.columns.push(foreignKey);
    table.primary_key = ["id"];
    table.unique_constraints = [{ name: `${name}_pkey`, columns: ["id"] }];
    table.indexes = [{ name: `${name}_pkey`, columns: ["id"], unique: true }];
    table.foreign_keys = [{
      name: constraint,
      columns: [foreignKeyField],
      referenced_schema: "public",
      referenced_table: target,
      referenced_columns: ["id"],
      delete_rule: "RESTRICT",
    }];
    table.suggestions.default_visible_columns = ["id", foreignKeyField];
    return table;
  };
  const orderEvents = derivedChild(
    orderItems,
    "order_events",
    "order_item_id",
    "order_items",
    "order_events_order_item_id_fkey",
  );
  const eventNotes = derivedChild(
    orderEvents,
    "event_notes",
    "order_event_id",
    "order_events",
    "event_notes_order_event_id_fkey",
  );
  inspection.tables = [eventNotes, orderEvents, orderItems, orders];
  return inspection;
}

function derivedPrincipalFirstTableInspection(singleOrganization: boolean): SchemaInspection {
  const inspection = boundaryInspection();
  const orders = structuredClone(inspection.tables[0]!);
  orders.name = "orders";
  orders.columns.push({
    name: "owner_id",
    data_type: "uuid",
    nullable: false,
    generated: false,
    ordinal_position: orders.columns.length + 1,
    suggestions: {
      tenant: false,
      conflict: false,
      sensitive: false,
      immutable: true,
      large_or_binary: false,
    },
  });
  orders.suggestions.default_visible_columns.push("owner_id");
  orders.unique_constraints = [{ name: "orders_pkey", columns: ["id"] }];
  orders.indexes = [{ name: "orders_pkey", columns: ["id"], unique: true }];

  const orderItems = structuredClone(orders);
  orderItems.name = "order_items";
  orderItems.columns = orderItems.columns.filter((field) =>
    field.name !== "owner_id" && field.name !== "status" && field.name !== "scheduled_at");
  orderItems.columns.push({
    name: "order_id",
    data_type: "uuid",
    nullable: false,
    generated: false,
    ordinal_position: orderItems.columns.length + 1,
    suggestions: {
      tenant: false,
      conflict: false,
      sensitive: false,
      immutable: true,
      large_or_binary: false,
    },
  });
  orderItems.suggestions.default_visible_columns = orderItems.columns.map((field) => field.name);
  orderItems.unique_constraints = [{ name: "order_items_pkey", columns: ["id"] }];
  orderItems.indexes = [{ name: "order_items_pkey", columns: ["id"], unique: true }];
  orderItems.foreign_keys = [{
    name: "order_items_order_id_fkey",
    columns: ["order_id"],
    referenced_schema: "public",
    referenced_table: "orders",
    referenced_columns: ["id"],
    delete_rule: "RESTRICT",
  }];
  if (singleOrganization) {
    for (const table of [orders, orderItems]) {
      table.columns = table.columns.filter((field) => field.name !== "tenant_id");
      table.suggestions.tenant_columns = [];
      table.suggestions.default_visible_columns =
        table.suggestions.default_visible_columns.filter((field) => field !== "tenant_id");
      table.row_level_security = false;
      table.row_level_security_policies = [];
      if (table.role_posture) {
        table.role_posture.row_security_effective_for_current_role = false;
      }
    }
  }
  inspection.tables = [orderItems, orders];
  return inspection;
}

function sharedReferenceInspection(): SchemaInspection {
  const inspection = boundaryInspection();
  const table = inspection.tables[0]!;
  table.columns = table.columns.filter((column) => column.name !== "tenant_id");
  table.suggestions.tenant_columns = [];
  table.suggestions.default_visible_columns = table.suggestions.default_visible_columns
    .filter((column) => column !== "tenant_id");
  table.row_level_security = false;
  table.row_level_security_policies = [];
  table.role_posture = {
    ...table.role_posture!,
    row_security_effective_for_current_role: false,
  };
  return inspection;
}

function scopedAndSharedReferenceInspection(): SchemaInspection {
  const inspection = boundaryInspection();
  const catalog = structuredClone(inspection.tables[0]!);
  catalog.name = "reference_catalog";
  catalog.columns = catalog.columns.filter((column) => column.name !== "tenant_id");
  catalog.primary_key = ["id"];
  catalog.unique_constraints = [{ name: "reference_catalog_pkey", columns: ["id"] }];
  catalog.indexes = [{ name: "reference_catalog_pkey", columns: ["id"], unique: true }];
  catalog.suggestions.tenant_columns = [];
  catalog.suggestions.default_visible_columns = catalog.suggestions.default_visible_columns
    .filter((column) => column !== "tenant_id");
  catalog.row_level_security = false;
  catalog.row_level_security_policies = [];
  catalog.role_posture = {
    ...catalog.role_posture!,
    row_security_effective_for_current_role: false,
  };
  inspection.tables.push(catalog);
  return inspection;
}

function batchBoundaryInspection(): SchemaInspection {
  const inspection = boundaryInspection();
  const visits = inspection.tables[0]!;
  const routes = structuredClone(visits);
  routes.name = "service_routes";
  routes.primary_key = ["id"];
  routes.unique_constraints = [{ name: "service_routes_pkey", columns: ["id"] }];
  routes.indexes = [{ name: "service_routes_pkey", columns: ["id"], unique: true }];
  for (const table of [visits, routes]) {
    table.row_level_security = false;
    table.row_level_security_policies = [];
    table.role_posture!.row_security_effective_for_current_role = false;
    table.suggestions.tenant_columns = [];
  }
  inspection.tables.push(routes);
  return inspection;
}

async function initializeSignedReviewProject(
  root: string,
  inspection: SchemaInspection,
): Promise<{ configPath: string; privateKeyPath: string }> {
  const build = buildAutoBoundary({
    inspection,
    project: {
      root,
      package_manager: "npm",
      frameworks: ["node"],
      schema_inputs: [],
      database_env_names: ["DATABASE_URL"],
    },
    sourceEnv: "DATABASE_URL",
    inspectedSchema: "public",
  });
  await writeAutoBoundaryArtifacts({ projectRoot: root, build });
  const guided = await initializeGuidedProject({
    projectRoot: root,
    build,
    runnerVersion: "1.6.6",
  });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeyPath = path.join(path.dirname(guided.config_path), "reviewer.pub.pem");
  const privateKeyPath = path.join(root, "reviewer.private.pem");
  await fs.writeFile(
    publicKeyPath,
    publicKey.export({ type: "spki", format: "pem" }).toString(),
    "utf8",
  );
  await fs.writeFile(
    privateKeyPath,
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    { encoding: "utf8", mode: 0o600 },
  );
  const config = JSON.parse(await fs.readFile(guided.config_path, "utf8"));
  config.operator_identity = {
    provider: "signed_key",
    operators: {
      alice: {
        public_key_path: "./reviewer.pub.pem",
        roles: ["boundary_reviewer"],
      },
    },
  };
  await fs.writeFile(guided.config_path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return {
    configPath: guided.config_path,
    privateKeyPath,
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
