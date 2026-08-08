import { describe, expect, it, vi } from "vitest";
import {
  choosePostActivationAskSelection,
  defaultPostActivationAskSelection,
  formatMcpClientHandoff,
  formatPostActivationAskSelection,
  formatPostActivationRouteLine,
  preferredRoute,
  runPostActivationAskHandoff,
  soleConfiguredHostedRoute,
  type PostActivationAskRoute,
} from "./post-activation-ask.js";
import { ProviderCredentialInputCancelledError } from "./secret-input.js";

describe("post-activation Ask handoff", () => {
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
      "--model", "gpt-5-mini",
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
        "--model", "gpt-5-mini",
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
      { projectRoot: "/tmp/reviewed-project", requestTimeoutSeconds: 180 },
      {
        chooseRoute: async () => "openai-compatible",
        promptWithDefault: async (prompt, defaultValue) => {
          prompts.push([prompt, defaultValue]);
          return defaultValue;
        },
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
    expect(output.join("" )).toContain("Model selection cancelled");
    expect(output.join("" )).toContain("reviewed boundaries remain active");
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
    for (const route of ["mcp-client", "later"] as PostActivationAskRoute[]) {
      const output: string[] = [];
      const runAsk = vi.fn(async () => 0);
      await expect(runPostActivationAskHandoff(
        { projectRoot: "/tmp/reviewed-project" },
        {
          chooseRoute: async () => route,
          runAsk,
          stdout: { write: (value) => {
            output.push(String(value));
            return true;
          } },
          stderr: { write: vi.fn(() => true) },
        },
      )).resolves.toBe(0);
      expect(runAsk).not.toHaveBeenCalled();
      expect(output.join("")).toMatch(
        route === "mcp-client"
          ? /Cursor|cursor/
          : /boundaries remain active/i,
      );
    }
    expect(formatMcpClientHandoff("/tmp/reviewed-project"))
      .toContain("mcp install claude-code");
    expect(formatMcpClientHandoff("/tmp/reviewed-project"))
      .toContain("--project-root /tmp/reviewed-project");
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
      "try ask --project-root /tmp/reviewed-project --provider openai --model gpt-5-mini",
    );
  });
});
