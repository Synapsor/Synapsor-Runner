import { describe, expect, it, vi } from "vitest";
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
  savedSetupReceipt,
  reviewPausedExecutionSetup,
  soleConfiguredHostedRoute,
  type PostActivationAskRoute,
} from "./post-activation-ask.js";
import { ProviderCredentialInputCancelledError } from "./secret-input.js";
import * as managedLauncher from "./managed-mcp-project.js";

describe("post-activation Ask handoff", () => {
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

  it.each(["decline", "pass", "fail", "exception"])("checks client launch only with permission and reports actual status (%s)", async (mode) => {
    const writes: string[] = [];
    const checkClientLaunch = vi.fn(async () => {
      if (mode === "exception") throw new Error("Launch timed out");
      return { ok: mode === "pass", messages: ["Command could not expose the reviewed tool catalog."] };
    });
    const code = await runPostActivationAskHandoff({ projectRoot: "/tmp/not-created-project", includeActions: false,
      selection: { route: "mcp-client", client: "claude-code" } }, {
      runMcpInstall: async () => 0, confirmLaunchCheck: async () => mode !== "decline", checkClientLaunch,
      stdout: { write: (value) => { writes.push(String(value)); return true; } },
    });
    expect(code).toBe(0);
    expect(checkClientLaunch).toHaveBeenCalledTimes(mode === "decline" ? 0 : 1);
    expect(writes.join("")).toContain(mode === "pass" ? "verified MCP handshake and tool catalog; test connection closed"
      : mode === "decline" ? "configured; launch not checked" : "configured; connection check failed");
    expect(writes.join("")).toContain("LOCAL STDIO MCP CONFIGURED");
    expect(writes.join("")).not.toContain("LOCAL STDIO MCP READY");
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
  });
  it.each(["missing", "configured", "unavailable"] as const)("checks local execution identity before offering worker start (%s)", async (mode) => {
    const configured = mode === "configured";
    const writes: string[] = [];
    const start = vi.fn(async () => false);
    const run = vi.fn(async () => 0);
    expect(await runPostActivationAskHandoff({ projectRoot: "/tmp/not-created-project", includeActions: true,
      selection: { route: "mcp-client", client: "claude-code" } }, {
      env: { WRITER_URL: "secret-writer", ...(configured ? { ACCOUNT_ENV: "private-account", USER_ENV: "private-user" } : {}) },
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
    expect(writes.join("")).not.toMatch(/secret-writer|private-account|private-user/);
  });

  it("discovers either legacy or verified semantic Action authority for the MCP handoff", async () => {
    const noLegacy = vi.fn(async () => ({
      action_boundary: { active: undefined },
    }) as Awaited<ReturnType<typeof import("./guided-action.js").guidedActionStatus>>);
    const semantic = vi.fn(async () => ({
      registry: { rules: [{ compiled: { outcome: "support.refund_requested" } }] },
    }) as unknown as Awaited<ReturnType<typeof import("./action-rule-authority.js").loadActiveActionRuleAuthority>>);

    await expect(hasActiveActionRuntime("/tmp/reviewed-project", {
      guidedStatus: noLegacy,
      loadSemanticAuthority: semantic,
    })).resolves.toBe(true);
    expect(semantic).toHaveBeenCalledOnce();

    await expect(hasActiveActionRuntime("/tmp/reviewed-project", {
      guidedStatus: async () => ({
        action_boundary: {
          active: { authority: { capabilities: [{ capability: "legacy.propose" }] } },
        },
      }) as Awaited<ReturnType<typeof import("./guided-action.js").guidedActionStatus>>,
      loadSemanticAuthority: vi.fn(async () => {
        throw new Error("semantic lookup should not run");
      }),
    })).resolves.toBe(true);

    await expect(hasActiveActionRuntime("/tmp/reviewed-project", {
      guidedStatus: noLegacy,
      loadSemanticAuthority: async () => {
        throw new Error("ACTION_RULE_READ_AUTHORITY_STALE");
      },
    })).resolves.toBe(false);
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
    await expect(runPostActivationAskHandoff(
      { projectRoot: "/tmp/reviewed-project" },
      {
        chooseRoute: async () => route,
        promptWithDefault: async (_prompt, defaultValue) => defaultValue,
        runAsk,
        stdout,
        stderr: { write: vi.fn(() => true) },
      },
    )).resolves.toBe(0);

    expect(runAsk).toHaveBeenCalledWith(expected);
    expect(String(stdout.write.mock.calls.flat())).toContain("Starting Synapsor Analytics");
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
      ["Local model name", "llama3.2"],
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
        expect(prompt).toBe("Anthropic model");
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
      ["Local model name (detected: qwen2.5:7b)", "qwen2.5:7b"],
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
      "Local model name",
      "Local OpenAI-compatible base URL",
      "Local model name",
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

  it("prints a pinned-build execution resume receipt, not an Ask command or a completion claim", async () => {
    const spy = vi.spyOn(managedLauncher, "resolveManagedMcpLauncher").mockResolvedValue({ command: "/usr/bin/node", args: ["/isolated build/dist/runner.mjs"] });
    try {
      const receipt = await savedSetupReceipt("/saved project", true, { version: 1, action_digest: `sha256:${"a".repeat(64)}`,
        outcome: "telecom.offered_plan_change", paused_at: "2026-09-06T00:00:00.000Z",
        problem: { code: "SEMANTIC_ACTION_WRITER_POSTURE_INVALID", summary: "Writer permissions do not match this action.", details: [] },
      });
      expect(receipt).toContain("not ready for automatic changes");
      expect(receipt).toContain("Writer permissions do not match");
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
    expect(scopedHandoff).toContain("export SYNAPSOR_TENANT_ID='<tenant>'");
    expect(scopedHandoff).toContain("export SYNAPSOR_PRINCIPAL='<principal>'");
    expect(scopedHandoff).toContain("Before live customer calls");
    expect(scopedHandoff).toContain("four fixed tools");
    expect(scopedHandoff.split("\n").length).toBeLessThanOrEqual(10);
    expect(formatMcpClientHandoff("/tmp/reviewed-project", "claude-code", false)).toContain("change requests remain refused");
    expect(formatHttpMcpHandoff("/tmp/reviewed-project"))
      .toContain("mcp serve --transport streamable-http --production-explore");
    expect(formatHttpMcpHandoff("/tmp/reviewed-project"))
      .toContain("mcp client-config --client claude-code --transport streamable-http");
    expect(formatHttpMcpHandoff("/tmp/reviewed-project"))
      .not.toMatch(/Bearer\s+[A-Za-z0-9_-]/u);
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
