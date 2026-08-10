import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeAskAuthority } from "./ask-authority.js";
import {
  resolveAskProviderConfiguration,
  type AskProvider,
  type AskProviderDependencies,
  type AskToolDefinition,
  type AskToolGateway,
} from "./model-ask.js";
import {
  formatProviderEgressActivationNotice,
  formatProviderEgressReview,
  parseEgressConfirmation,
  parseAskTimeoutSeconds,
  providerDisplayLabel,
  resolveAskModel,
  tryAsk,
} from "./try-ask.js";

const roots: string[] = [];
const activeDigest = `sha256:${"a".repeat(64)}` as const;
const secret = "sk-cli-ask-canary-never-persist";
const tools: AskToolDefinition[] = [
  {
    name: "app.describe_data",
    description: "Describe only the active reviewed analytical boundary.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    metadata: {
      "synapsor.approval_tool": false,
      "synapsor.commit_tool": false,
    },
  },
  {
    name: "app.explore_data",
    description: "Execute one bounded typed plan inside the reviewed boundary.",
    input_schema: {
      type: "object",
      properties: { plan: { type: "object" } },
      required: ["plan"],
      additionalProperties: false,
    },
    metadata: {
      "synapsor.approval_tool": false,
      "synapsor.commit_tool": false,
    },
  },
];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("try ask", () => {
  it("labels loopback and remote OpenAI-compatible endpoints honestly", () => {
    expect(providerDisplayLabel("openai_compatible", "custom_loopback"))
      .toBe("OpenAI-compatible (local/loopback)");
    expect(providerDisplayLabel("openai_compatible", "custom_remote"))
      .toBe("OpenAI-compatible (custom remote)");
    expect(providerDisplayLabel("openai", "official_remote")).toBe("OpenAI");
  });

  it("uses the documented hosted-provider defaults while requiring an explicit custom model", () => {
    expect(resolveAskModel("openai", undefined)).toBe("gpt-5-mini");
    expect(resolveAskModel("anthropic", undefined)).toBe("claude-sonnet-4-20250514");
    expect(resolveAskModel("openai", "gpt-custom")).toBe("gpt-custom");
    expect(() => resolveAskModel("openai_compatible", undefined))
      .toThrow("requires --model <value> for an OpenAI-compatible endpoint");
  });

  it("accepts only bounded whole-second model request timeouts", () => {
    expect(parseAskTimeoutSeconds(undefined)).toBeUndefined();
    expect(parseAskTimeoutSeconds("1")).toBe(1);
    expect(parseAskTimeoutSeconds("600")).toBe(600);
    for (const value of ["0", "1.5", "601", "slow"]) {
      expect(() => parseAskTimeoutSeconds(value)).toThrowError(expect.objectContaining({
        code: "ASK_TIMEOUT_INVALID",
      }));
    }
  });

  it("runs the OpenAI flag path without --model using the documented default", async () => {
    const fixture = await askProject();
    const consent = vi.fn(async () => true);
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        choices: [{ message: { role: "assistant", content: "The reviewed answer is available." } }],
      },
    }));

    await expect(tryAsk([
      "Count reviewed rows.",
      "--project-root", fixture.root,
      "--config", fixture.configPath,
      "--store", fixture.storePath,
      "--provider", "openai",
      "--timeout", "75",
    ], {
      env: fixture.env,
      gatewayFactory: testGatewayFactory([]),
      confirmEgress: consent,
      providerDependencies: { requestJson },
      bindPlansToAnswer: async () => undefined,
    })).resolves.toBe(0);

    expect(consent).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5-mini" }));
    expect(requestJson).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ model: "gpt-5-mini" }),
      timeoutMs: 75_000,
    }));
  });

  it("uses a default-Yes interactive egress confirmation without exposing the fingerprint", async () => {
    expect(parseEgressConfirmation("")).toBe(true);
    expect(parseEgressConfirmation("y")).toBe(true);
    expect(parseEgressConfirmation("YES")).toBe(true);
    expect(parseEgressConfirmation("n")).toBe(false);
    expect(parseEgressConfirmation("no")).toBe(false);
    expect(parseEgressConfirmation("continue")).toBeUndefined();

    const fixture = await askProject();
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    const review = vi.fn(async () => true);
    let requests = 0;

    await expect(tryAsk([
      "Count reviewed rows.",
      "--project-root", fixture.root,
      "--config", fixture.configPath,
      "--store", fixture.storePath,
      "--provider", "openai",
      "--model", "gpt-test",
    ], {
      env: fixture.env,
      gatewayFactory: testGatewayFactory([]),
      confirmEgress: review,
      providerDependencies: {
        requestJson: async () => {
          requests += 1;
          return requests === 1
            ? openAiToolCall()
            : {
              status: 200,
              body: {
                choices: [{
                  message: { role: "assistant", content: "The reviewed count is 12." },
                }],
              },
            };
        },
      },
      bindPlansToAnswer: async () => undefined,
    })).resolves.toBe(0);

    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      provider: "OpenAI",
      model: "gpt-test",
      endpointOrigin: "https://api.openai.com",
      tools: ["app.describe_data", "app.explore_data"],
    }));
    expect(output.join("")).toContain(
      "OpenAI will receive your question and only data allowed by the active reviewed boundaries.",
    );
    expect(output.join("")).not.toContain("ALLOW EGRESS");
    expect(output.join("")).not.toContain("consent_fingerprint");
    expect(requests).toBe(2);
  });

  it("styles the provider review only for an interactive color terminal", () => {
    const review = {
      provider: "OpenAI",
      model: "gpt-5-mini",
      endpointOrigin: "https://api.openai.com",
    };
    expect(formatProviderEgressReview(review)).not.toContain("\u001b[");
    const colored = formatProviderEgressReview(review, true);
    expect(colored).toContain("\u001b[1;36mProvider egress review\u001b[0m");
    expect(colored).toContain("\u001b[1;36mOpenAI\u001b[0m");
    expect(colored).toContain("\u001b[1;35mhttps://api.openai.com\u001b[0m");
    expect(colored).toContain("Trusted scope stays fixed outside model arguments");
    expect(colored).toContain("only when reviewed as Model + Runner");

    const activationNotice = formatProviderEgressActivationNotice({
      provider: "OpenAI",
      model: "gpt-5-mini",
      endpointOrigin: "https://api.openai.com",
      local: false,
    });
    expect(activationNotice).toContain("Confirming activation also renews provider egress consent");
    expect(activationNotice).toContain("Activation itself makes no provider request");
  });

  it("does not contact the provider when interactive egress is declined", async () => {
    const fixture = await askProject();
    const requestJson = vi.fn();
    await expect(tryAsk([
      "Count reviewed rows.",
      "--project-root", fixture.root,
      "--config", fixture.configPath,
      "--store", fixture.storePath,
      "--provider", "openai",
      "--model", "gpt-test",
    ], {
      env: fixture.env,
      gatewayFactory: testGatewayFactory([]),
      confirmEgress: async () => false,
      providerDependencies: { requestJson },
    })).rejects.toMatchObject({
      code: "ASK_EGRESS_CONSENT_DECLINED",
      message: "Provider egress was not approved. No provider request was made.",
    });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("runs OpenAI through the exact authoring tools and prints model prose separately from verified analysis", async () => {
    const fixture = await askProject();
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const requestBodies: Array<Record<string, unknown>> = [];
    const gatewayFactory = testGatewayFactory(calls);
    const providerDependencies: AskProviderDependencies = {
      requestJson: async (request) => {
        requestBodies.push(request.body);
        expect(request.headers.authorization).toBe(`Bearer ${secret}`);
        return requestBodies.length === 1
          ? openAiToolCall()
          : {
            status: 200,
            body: {
              choices: [{
                message: {
                  role: "assistant",
                  content: "North had the largest reviewed weekly change.",
                },
              }],
              usage: { prompt_tokens: 6, completion_tokens: 7, total_tokens: 13 },
            },
          };
      },
    };
    const consent = await exactConsent(fixture, "openai", "gpt-test", fixture.env);

    await expect(tryAsk([
      "Which reviewed region changed most by week?",
      "--project-root", fixture.root,
      "--config", fixture.configPath,
      "--store", fixture.storePath,
      "--provider", "openai",
      "--model", "gpt-test",
      "--consent", consent,
      "--json",
    ], {
      env: fixture.env,
      gatewayFactory,
      providerDependencies,
      bindPlansToAnswer: async () => undefined,
    })).resolves.toBe(0);

    const payload = JSON.parse(output.join("")) as Record<string, any>;
    expect(payload).toMatchObject({
      ok: true,
      mode: "authoring",
      provider: "openai",
      answer: "North had the largest reviewed weekly change.",
      answer_is_untrusted_model_output: true,
      source_database_changed: false,
      model_can_activate: false,
      model_can_approve: false,
      model_can_apply: false,
      runner_verified_analysis: {
        tools_called: ["app.explore_data"],
        database_result_verified: true,
        source_database_changed: false,
        analyses: [{
          index: 1,
          tool: "app.explore_data",
          status: "ok",
          analysis_reference: "protect_analysis_cli_1",
          source_database_changed: false,
        }],
      },
    });
    expect(calls).toEqual([{
      name: "app.explore_data",
      args: { plan: aggregatePlan() },
    }]);
    expect(JSON.stringify(requestBodies[0])).toContain("app__explore_data");
    expect(output.join("")).not.toContain(secret);
    expect(await projectContents(fixture.root)).not.toContain(secret);
    expect(await projectContents(fixture.root)).not.toContain("North had the largest");
  });

  it("prints clean one-shot human output while retaining the plan for later Protect", async () => {
    const fixture = await askProject();
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let requests = 0;
    const bindPlansToAnswer = vi.fn(async () => undefined);
    const consent = await exactConsent(fixture, "openai", "gpt-test", fixture.env);

    await expect(tryAsk([
      "Which reviewed regions changed most by week?",
      "--project-root", fixture.root,
      "--config", fixture.configPath,
      "--store", fixture.storePath,
      "--provider", "openai",
      "--model", "gpt-test",
      "--consent", consent,
    ], {
      env: fixture.env,
      gatewayFactory: testGatewayFactory(calls),
      bindPlansToAnswer,
      providerDependencies: {
        requestJson: async () => {
          requests += 1;
          return requests === 1
            ? openAiToolCall()
            : {
              status: 200,
              body: {
                choices: [{
                  message: {
                    role: "assistant",
                    content: "North had the largest reviewed weekly change.",
                  },
                }],
              },
            };
        },
      },
    })).resolves.toBe(0);

    const human = output.join("");
    expect(human).toContain("MODEL INTERPRETATION");
    expect(human).toContain("RUNNER-VERIFIED DATA");
    expect(human).toContain("north");
    expect(human).toContain("12");
    expect(human).toContain("1 additional group was withheld");
    expect(human).not.toContain("Analysis A1");
    expect(human).not.toContain("Evidence recorded");
    expect(human).not.toContain("Database unchanged");
    expect(human).not.toContain("Source database changed");
    expect(human).not.toContain(activeDigest);
    expect(bindPlansToAnswer).toHaveBeenCalledWith({
      projectRoot: fixture.root,
      tokens: ["protect_analysis_cli_1"],
      answerId: expect.stringMatching(/^ans_[a-f0-9]{24}$/),
    });
  });

  it("uses Anthropic through the same reviewed gateway and refuses generic or credential CLI shortcuts", async () => {
    const fixture = await askProject();
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let requests = 0;
    const consent = await exactConsent(fixture, "anthropic", "claude-test", {
      ...fixture.env,
      ANTHROPIC_API_KEY: secret,
    });
    const env = { ...fixture.env, ANTHROPIC_API_KEY: secret };

    await expect(tryAsk([
      "Count the reviewed weekly changes.",
      "--project-root", fixture.root,
      "--config", fixture.configPath,
      "--store", fixture.storePath,
      "--provider", "anthropic",
      "--model", "claude-test",
      "--consent", consent,
      "--json",
    ], {
      env,
      gatewayFactory: testGatewayFactory(calls),
      bindPlansToAnswer: async () => undefined,
      providerDependencies: {
        requestJson: async (request) => {
          requests += 1;
          expect(request.headers["x-api-key"]).toBe(secret);
          return requests === 1
            ? {
              status: 200,
              body: {
                content: [{
                  type: "tool_use",
                  id: "toolu_cli",
                  name: "app__explore_data",
                  input: { plan: aggregatePlan() },
                }],
              },
            }
            : {
              status: 200,
              body: {
                content: [{ type: "text", text: "The reviewed count is 12." }],
              },
            };
        },
      },
    })).resolves.toBe(0);

    expect(JSON.parse(output.join(""))).toMatchObject({
      mode: "authoring",
      provider: "anthropic",
      answer: "The reviewed count is 12.",
      answer_is_untrusted_model_output: true,
    });
    expect(calls).toHaveLength(1);
    expect(requests).toBe(2);

    await expect(tryAsk([
      "Count rows.",
      "--provider", "openai",
      "--model", "gpt-test",
      "--api-key", secret,
    ], { env })).rejects.toThrow(/Unknown option.*--api-key/);
    await expect(tryAsk([
      "Count rows.",
      "--provider", "openai",
      "--model", "gpt-test",
      "--yes",
    ], { env })).rejects.toThrow(/Unknown option.*--yes/);
  });

  it("requires exact authority-bound consent before making a provider request", async () => {
    const fixture = await askProject();
    const requestJson = vi.fn();
    await expect(tryAsk([
      "Count reviewed rows.",
      "--project-root", fixture.root,
      "--config", fixture.configPath,
      "--store", fixture.storePath,
      "--provider", "openai",
      "--model", "gpt-test",
      "--consent", "ALLOW EGRESS wrong",
      "--json",
    ], {
      env: fixture.env,
      gatewayFactory: testGatewayFactory([]),
      providerDependencies: { requestJson },
    })).rejects.toMatchObject({ code: "ASK_EGRESS_CONSENT_REQUIRED" });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("opens /access and resumes the same provider credential after the active boundary set changes", async () => {
    const fixture = await askProject();
    const env = { ...fixture.env };
    delete env.OPENAI_API_KEY;
    const readSecret = vi.fn(async () => secret);
    const answers: Array<string | undefined> = [
      "/access",
      "Count the reviewed rows in the new boundary.",
      undefined,
    ];
    const runPostAccessAsk = vi.fn(async () => 0);
    const consent = vi.fn(async () => true);
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let providerRequests = 0;
    const runTerminalBoundaryReview = vi.fn(async (input: {
      projectRoot: string;
      activationReviewNotice: string;
      onActivated: () => Promise<number>;
    }) => {
      expect(input.projectRoot).toBe(fixture.root);
      expect(input.activationReviewNotice).toContain(
        "Confirming activation also renews provider egress consent",
      );
      expect(input.activationReviewNotice).toContain("OpenAI / gpt-owner-selected");
      const financeDigest = `sha256:${"b".repeat(64)}`;
      const supportBoundary = {
        schema_version: "synapsor.exploration-boundary-active.v1",
        deployment_profile: "development",
        pack: { name: "support", resources: [{ id: "public.tickets" }] },
        activation: {
          state: "active",
          digest: activeDigest,
          actor: "reviewer@example.test",
          activated_at: "2026-07-26T00:05:00.000Z",
        },
      };
      const financeBoundary = {
        schema_version: "synapsor.exploration-boundary-active.v1",
        deployment_profile: "development",
        pack: { name: "finance", resources: [{ id: "public.invoices" }] },
        activation: {
          state: "active",
          digest: financeDigest,
          actor: "reviewer@example.test",
          activated_at: "2026-07-26T00:05:00.000Z",
        },
      };
      await fs.writeFile(
        path.join(fixture.root, ".synapsor/exploration-boundaries.active.json"),
        JSON.stringify({
          schema_version: "synapsor.active-exploration-boundaries.v1",
          selected_name: "finance",
          boundaries: [supportBoundary, financeBoundary],
          updated_at: "2026-07-26T00:05:00.000Z",
        }, null, 2),
      );
      await fs.rm(
        path.join(fixture.root, ".synapsor/exploration-boundary.active.json"),
        { force: true },
      );
      return input.onActivated();
    });

    await expect(tryAsk([
      "--project-root", fixture.root,
      "--config", fixture.configPath,
      "--store", fixture.storePath,
      "--provider", "openai",
      "--model", "gpt-owner-selected",
    ], {
      env,
      gatewayFactory: testGatewayFactory(calls),
      boundaryCatalogLoader: async () => undefined,
      confirmEgress: consent,
      providerDependencies: {
        requestJson: async (request) => {
          providerRequests += 1;
          expect(request.headers.authorization).toBe(`Bearer ${secret}`);
          return providerRequests === 1
            ? openAiToolCall("finance")
            : {
              status: 200,
              body: {
                choices: [{
                  message: { role: "assistant", content: "The reviewed count is 12." },
                }],
              },
            };
        },
      },
      bindPlansToAnswer: async () => undefined,
      shellIo: {
        read: async () => answers.shift(),
        write: () => undefined,
        columns: () => 100,
        onInterrupt: () => () => undefined,
        close: () => undefined,
      },
      runTerminalBoundaryReview,
      runPostAccessAsk,
      readSecret,
    })).resolves.toBe(0);

    expect(readSecret).toHaveBeenCalledOnce();
    expect(runTerminalBoundaryReview).toHaveBeenCalledOnce();
    expect(runPostAccessAsk).not.toHaveBeenCalled();
    expect(providerRequests).toBe(2);
    expect(calls.filter((call) => call.name === "app.explore_data")).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({ boundary: "finance" }),
      }),
    ]);
    expect(new Set(calls.map((call) => call.name))).toEqual(new Set([
      "app.describe_data",
      "app.explore_data",
    ]));
    expect(consent).toHaveBeenCalledOnce();
  });

  it("exits cleanly only after the operator closes /access with no active boundary", async () => {
    const fixture = await askProject();
    const answers: Array<string | undefined> = ["/access"];
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    const runTerminalBoundaryReview = vi.fn(async () => {
      await Promise.all([
        fs.rm(path.join(fixture.root, ".synapsor/exploration-boundary.active.json"), { force: true }),
        fs.rm(path.join(fixture.root, ".synapsor/exploration-boundaries.active.json"), { force: true }),
      ]);
      return 0;
    });

    await expect(tryAsk([
      "--project-root", fixture.root,
      "--config", fixture.configPath,
      "--store", fixture.storePath,
      "--provider", "openai",
      "--model", "gpt-test",
    ], {
      env: fixture.env,
      gatewayFactory: testGatewayFactory([]),
      boundaryCatalogLoader: async () => undefined,
      confirmEgress: async () => true,
      shellIo: {
        read: async () => answers.shift(),
        write: () => undefined,
        columns: () => 100,
        onInterrupt: () => () => undefined,
        close: () => undefined,
      },
      runTerminalBoundaryReview,
    })).resolves.toBe(0);

    expect(runTerminalBoundaryReview).toHaveBeenCalledOnce();
    expect(output.join("")).toContain("No active boundary. Ask remains disabled.");
    expect(output.join("")).not.toContain("Ask did not start");
  });

  it("returns to the previous Ask authority when boundary activation fails safely", async () => {
    const fixture = await askProject();
    const answers: Array<string | undefined> = ["/access", undefined];
    const output: string[] = [];
    const runTerminalBoundaryReview = vi.fn(async () => {
      throw new Error(
        "Active Explore boundaries must use the same reviewed source and deployment profile.",
      );
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(tryAsk([
      "--project-root", fixture.root,
      "--config", fixture.configPath,
      "--store", fixture.storePath,
      "--provider", "openai",
      "--model", "gpt-test",
    ], {
      env: fixture.env,
      gatewayFactory: testGatewayFactory([]),
      boundaryCatalogLoader: async () => undefined,
      confirmEgress: async () => true,
      shellIo: {
        read: async () => answers.shift(),
        write: () => undefined,
        columns: () => 100,
        onInterrupt: () => () => undefined,
        close: () => undefined,
      },
      runTerminalBoundaryReview,
    })).resolves.toBe(0);

    expect(runTerminalBoundaryReview).toHaveBeenCalledOnce();
    expect(output.join("")).toContain("Boundary was not activated");
    expect(output.join("")).toContain("previous reviewed Ask access is still active");
  });

  it("opens the visual access editor with the generated boundary artifact root", async () => {
    const fixture = await askProject();
    const answers: Array<string | undefined> = ["/access-workbench", undefined];
    const close = vi.fn(async () => undefined);
    const uiServerFactory = vi.fn(async () => ({
      url: "http://127.0.0.1:48123/?token=bootstrap",
      close,
    }) as never);

    await expect(tryAsk([
      "--project-root", fixture.root,
      "--config", fixture.configPath,
      "--store", fixture.storePath,
      "--provider", "openai",
      "--model", "gpt-test",
    ], {
      env: fixture.env,
      gatewayFactory: testGatewayFactory([]),
      boundaryCatalogLoader: async () => undefined,
      confirmEgress: async () => true,
      uiServerFactory,
      shellIo: {
        read: async () => answers.shift(),
        write: () => undefined,
        columns: () => 100,
        onInterrupt: () => () => undefined,
        close: () => undefined,
      },
    })).resolves.toBe(0);

    expect(uiServerFactory).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: fixture.root,
      boundaryRoot: path.join(fixture.root, "synapsor/generated"),
    }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("refuses an unsent question instead of prompting inside chat when authority changes externally", async () => {
    const fixture = await askProject();
    const consent = vi.fn(async () => true);
    const requestJson = vi.fn();
    const output: string[] = [];
    let readCount = 0;

    await expect(tryAsk([
      "--project-root", fixture.root,
      "--config", fixture.configPath,
      "--store", fixture.storePath,
      "--provider", "openai",
      "--model", "gpt-owner-selected",
    ], {
      env: fixture.env,
      gatewayFactory: testGatewayFactory([]),
      boundaryCatalogLoader: async () => undefined,
      confirmEgress: consent,
      providerDependencies: { requestJson },
      shellIo: {
        read: async () => {
          if (readCount > 0) return undefined;
          readCount += 1;
          await fs.writeFile(
            path.join(fixture.root, ".synapsor/exploration-boundary.active.json"),
            JSON.stringify({
              schema_version: "synapsor.exploration-boundary-active.v1",
              deployment_profile: "development",
              activation: {
                digest: `sha256:${"b".repeat(64)}`,
                actor: "another-reviewer@example.test",
                activated_at: "2026-07-26T00:10:00.000Z",
              },
            }, null, 2),
          );
          return "Count reviewed rows.";
        },
        write: (value) => output.push(value),
        columns: () => 100,
        onInterrupt: () => () => undefined,
        close: () => undefined,
      },
    })).resolves.toBe(0);

    expect(consent).toHaveBeenCalledOnce();
    expect(requestJson).not.toHaveBeenCalled();
    expect(output.join("")).toContain("Your question was not sent");
    expect(output.join("")).toContain("Run /refresh-access");
    expect(output.join("")).toContain("no restart is required");
  });

  it("rebinds an externally activated exact authority after an in-shell consent gesture", async () => {
    const fixture = await askProject();
    const requestJson = vi.fn();
    const output: string[] = [];
    const prompts: string[] = [];
    let readCount = 0;

    await expect(tryAsk([
      "--project-root", fixture.root,
      "--config", fixture.configPath,
      "--store", fixture.storePath,
      "--provider", "openai",
      "--model", "gpt-owner-selected",
    ], {
      env: fixture.env,
      gatewayFactory: testGatewayFactory([]),
      boundaryCatalogLoader: async () => undefined,
      confirmEgress: async () => true,
      providerDependencies: { requestJson },
      shellIo: {
        read: async (prompt) => {
          prompts.push(prompt);
          readCount += 1;
          if (readCount === 1) {
            await fs.writeFile(
              path.join(fixture.root, ".synapsor/exploration-boundary.active.json"),
              JSON.stringify({
                schema_version: "synapsor.exploration-boundary-active.v1",
                deployment_profile: "development",
                pack: { name: "new_review", resources: [] },
                activation: {
                  digest: `sha256:${"b".repeat(64)}`,
                  actor: "another-reviewer@example.test",
                  activated_at: "2026-07-26T00:10:00.000Z",
                },
              }, null, 2),
            );
            return "/refresh-access";
          }
          if (readCount === 2) return "";
          return undefined;
        },
        write: (value) => output.push(value),
        columns: () => 100,
        onInterrupt: () => () => undefined,
        close: () => undefined,
      },
    })).resolves.toBe(0);

    expect(requestJson).not.toHaveBeenCalled();
    expect(prompts.join("")).toContain("New reviewed access is active: new_review");
    expect(prompts.join("")).toContain("Use the newly activated access? [Y/n]");
    expect(output.join("")).toContain("Ask access updated");
    expect(output.join("")).toContain("No provider request was made");
  });
});

async function askProject(): Promise<{
  root: string;
  configPath: string;
  storePath: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-try-ask-"));
  roots.push(root);
  const configPath = path.join(root, "synapsor/synapsor.runner.json");
  const storePath = path.join(root, ".synapsor/local.db");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({
    version: 1,
    mode: "read_only",
    storage: { sqlite_path: ".synapsor/local.db" },
    sources: {},
    trusted_context: {
      provider: "static_dev",
      values: { tenant_id: "fixture-tenant", principal: "fixture-principal" },
    },
    capabilities: [{
      name: "support.inspect_ticket",
      kind: "read",
      source: "source",
      target: { schema: "public", table: "tickets", primary_key: "id" },
      args: { ticket_id: { type: "string", required: true } },
      lookup: { id_from_arg: "ticket_id" },
      visible_columns: ["id"],
      max_rows: 1,
    }],
  }, null, 2));
  await fs.writeFile(path.join(root, ".synapsor/exploration-boundary.active.json"), JSON.stringify({
    schema_version: "synapsor.exploration-boundary-active.v1",
    deployment_profile: "development",
    activation: {
      digest: activeDigest,
      actor: "reviewer@example.test",
      activated_at: "2026-07-26T00:00:00.000Z",
    },
  }, null, 2));
  return {
    root,
    configPath,
    storePath,
    env: {
      OPENAI_API_KEY: secret,
      SYNAPSOR_DEPLOYMENT_PROFILE: "development",
    },
  };
}

async function exactConsent(
  fixture: Awaited<ReturnType<typeof askProject>>,
  provider: AskProvider,
  model: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const authority = await computeAskAuthority({
    tools,
    configPath: fixture.configPath,
    projectRoot: fixture.root,
    profile: "development",
    mode: "authoring",
  });
  const configuration = resolveAskProviderConfiguration({
    provider,
    model,
    ...(provider === "openai" ? { api_key_env: "OPENAI_API_KEY" } : {}),
    ...(provider === "anthropic" ? { api_key_env: "ANTHROPIC_API_KEY" } : {}),
    authority_digest: authority.authority_digest,
    egress_acknowledged: true,
  }, env, new Date("2026-07-26T00:00:00.000Z"));
  return `ALLOW EGRESS ${configuration.consent_fingerprint}`;
}

function testGatewayFactory(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
): (input: {
  configPath: string;
  storePath: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  mode?: "auto" | "authoring" | "runtime";
}) => Promise<AskToolGateway> {
  return async () => ({
    mode: "authoring",
    listTools: async () => structuredClone(tools),
    callTool: async (name, args) => {
      calls.push({ name, args: structuredClone(args) });
      return {
        ok: true,
        value: {
          ok: true,
          boundary_digest: activeDigest,
          counted_entity: "sessions",
          rows: [{ region: "north", measure_0: 12 }],
          privacy: {
            minimum_cohort_size: 5,
            suppressed_groups: 1,
          },
          audit: {
            returned_rows_or_groups: 1,
            returned_cells: 2,
            query_audit_handle: "audit_cli_ask_1",
          },
          protect: {
            token: "protect_analysis_cli_1",
            expires_at: "2026-07-26T01:00:00.000Z",
          },
          source_database_changed: false,
        },
      };
    },
    close: async () => undefined,
  });
}

function openAiToolCall(boundary?: string): { status: number; body: Record<string, unknown> } {
  return {
    status: 200,
    body: {
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_cli",
            type: "function",
            function: {
              name: "app__explore_data",
              arguments: JSON.stringify({ ...(boundary ? { boundary } : {}), plan: aggregatePlan() }),
            },
          }],
        },
      }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    },
  };
}

function aggregatePlan(): Record<string, unknown> {
  return {
    kind: "aggregate",
    resource: "public.sessions",
    measures: [{ function: "count" }],
    dimensions: [{ field: "region" }],
    time_bucket: { field: "started_at", bucket: "week" },
    top_n: 5,
  };
}

async function projectContents(root: string): Promise<string> {
  const paths = await fs.readdir(root, { recursive: true });
  const chunks: string[] = [];
  for (const entry of paths) {
    const fullPath = path.join(root, entry);
    const stat = await fs.lstat(fullPath);
    if (stat.isFile() && stat.size <= 1024 * 1024) {
      chunks.push(await fs.readFile(fullPath, "utf8"));
    }
  }
  return chunks.join("\n");
}
