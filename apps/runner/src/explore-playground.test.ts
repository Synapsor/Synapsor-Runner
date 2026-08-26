import process from "node:process";
import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exploreCommand } from "./explore-playground.js";
import { ScopedExploreError } from "./scoped-explore.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Explore Plan Playground CLI", () => {
  it("validates a fixed JSON plan through the local boundary runtime", async () => {
    const plan = aggregatePlan();
    const validate = vi.fn(async () => validationResult(plan));
    const explore = vi.fn();
    const close = vi.fn(async () => undefined);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = await exploreCommand([
      "validate",
      "--plan-json",
      JSON.stringify({ plan, boundary: "finance" }),
      "--json",
    ], {
      createRuntime: (async () => localRuntime({ validate, explore, close })) as never,
      env: {},
    });

    expect(code).toBe(0);
    expect(validate).toHaveBeenCalledWith(plan, "finance");
    expect(explore).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    const output = write.mock.calls.map(([value]) => String(value)).join("");
    expect(JSON.parse(output)).toMatchObject({
      validation: {
        source_query_executed: false,
        explore_budget_consumed: false,
      },
    });
  });

  it("runs a remote plan only through app.explore_data semantics and keeps the token value out of output", async () => {
    const plan = aggregatePlan();
    const run = vi.fn(async () => ({
      ok: true,
      data: [{ dimension_0: "west", measure_0: 7 }],
      source_database_changed: false,
      audit: { returned_rows_or_groups: 1, returned_cells: 2 },
      privacy: { suppressed_groups: 0 },
    }));
    const close = vi.fn(async () => undefined);
    const connectRemote = vi.fn(async () => ({
      target: "remote_http" as const,
      targetLabel: "http://127.0.0.1:8766/mcp",
      scopeLabel: ["verified JWT claims"],
      describe: async () => ({ ok: true, resources: [] }),
      run,
      close,
    }));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = await exploreCommand([
      "run",
      "--url",
      "http://127.0.0.1:8766/mcp",
      "--token-env",
      "PLAYGROUND_TOKEN",
      "--plan-json",
      JSON.stringify(plan),
      "--json",
    ], {
      connectRemote: connectRemote as never,
      env: { PLAYGROUND_TOKEN: "secret-jwt-value" },
    });

    expect(code).toBe(0);
    expect(connectRemote).toHaveBeenCalledWith(expect.objectContaining({
      url: "http://127.0.0.1:8766/mcp",
      tokenEnv: "PLAYGROUND_TOKEN",
    }));
    expect(run).toHaveBeenCalledWith({ plan });
    expect(close).toHaveBeenCalledOnce();
    expect(write.mock.calls.map(([value]) => String(value)).join(""))
      .not.toContain("secret-jwt-value");
  });

  it("refuses tenant injection in the MCP envelope before either validator or executor runs", async () => {
    const validate = vi.fn();
    const explore = vi.fn();
    const close = vi.fn(async () => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(exploreCommand([
      "run",
      "--plan-json",
      JSON.stringify({
        plan: aggregatePlan(),
        tenant: "model-selected-tenant",
      }),
      "--json",
    ], {
      createRuntime: (async () => localRuntime({ validate, explore, close })) as never,
      env: {},
    })).rejects.toMatchObject({
      code: "EXPLORE_PLAN_INVALID",
      message: expect.stringContaining("unsupported key(s): tenant"),
    });
    expect(validate).not.toHaveBeenCalled();
    expect(explore).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("requires HTTPS away from loopback and never accepts an inline token option", async () => {
    await expect(exploreCommand([
      "run",
      "--url",
      "http://runner.example/mcp",
      "--token-env",
      "PLAYGROUND_TOKEN",
      "--plan-json",
      JSON.stringify(aggregatePlan()),
      "--json",
    ], {
      env: { PLAYGROUND_TOKEN: "hidden" },
    })).rejects.toThrow(/requires HTTPS/i);

    await expect(exploreCommand([
      "run",
      "--url",
      "https://runner.example/mcp",
      "--token",
      "literal-jwt",
      "--plan-json",
      JSON.stringify(aggregatePlan()),
    ], {
      env: {},
    })).rejects.toThrow(/unknown option.*--token/i);

    await expect(exploreCommand([
      "run",
      "--url",
      "https://runner.example/mcp?access_token=literal-jwt",
      "--token-env",
      "PLAYGROUND_TOKEN",
      "--plan-json",
      JSON.stringify(aggregatePlan()),
      "--json",
    ], {
      env: { PLAYGROUND_TOKEN: "hidden" },
    })).rejects.toThrow(/cannot contain query parameters or fragments/i);
  });

  it("reports post-query privacy refusals accurately without implying source mutation", async () => {
    const explore = vi.fn(async () => {
      throw new ScopedExploreError(
        "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
        "A complementary reviewed aggregate cannot be released.",
        { source_query_executed: true, result_returned_to_caller: false },
      );
    });
    const close = vi.fn(async () => undefined);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = await exploreCommand([
      "run",
      "--plan-json",
      JSON.stringify(aggregatePlan()),
      "--no-color",
    ], {
      createRuntime: (async () => localRuntime({ validate: vi.fn(), explore, close })) as never,
      env: {},
    });

    expect(code).toBe(1);
    expect(write.mock.calls.map(([value]) => String(value)).join(""))
      .toContain("Source query executed: yes; no result was released");
    expect(write.mock.calls.map(([value]) => String(value)).join(""))
      .toContain("Source database changed: no");
  });

  it("does not consume interactive stdin as both the plan document and command stream", async () => {
    const close = vi.fn(async () => undefined);

    await expect(exploreCommand([
      "playground",
      "--plan",
      "-",
    ], {
      createRuntime: (async () => localRuntime({ validate: vi.fn(), explore: vi.fn(), close })) as never,
      env: {},
    })).rejects.toThrow(/cannot reuse stdin/i);
    expect(close).toHaveBeenCalledOnce();
  });

  it("accepts formatted multiline JSON immediately, navigates with Escape, and shows exact SQL captured for the run", async () => {
    const terminal = testTerminal();
    const plan = aggregatePlan();
    const explore = vi.fn(async () => ({
      ok: true,
      boundary_digest: `sha256:${"c".repeat(64)}`,
      data: [{ dimension_0: "west", measure_0: 7 }],
      source_database_changed: false,
      audit: {
        evidence_bundle_id: "ev_playground_exact_sql",
        returned_rows_or_groups: 1,
        returned_cells: 2,
      },
      privacy: { suppressed_groups: 0 },
      evidence_bundle_id: "ev_playground_exact_sql",
    }));
    const close = vi.fn(async () => undefined);
    const readEvidenceSql = vi.fn(async () => ({
      source: "captured_parameterized_sql",
      evidence_bundle_id: "ev_playground_exact_sql",
      parameterized_sql: {
        engine: "postgres",
        statements: [{
          statement: "SELECT region, COUNT(*) FROM public.orders GROUP BY region",
          parameter_count: 1,
        }],
      },
    }));

    const interaction = exploreCommand([
      "playground",
      "--project-root",
      ".",
      "--no-color",
    ], {
      createRuntime: (async () => localRuntime({ validate: vi.fn(), explore, close })) as never,
      readEvidenceSql,
      stdin: terminal.input as unknown as NodeJS.ReadStream,
      stdout: terminal.output as unknown as NodeJS.WriteStream,
      stderr: terminal.output as unknown as NodeJS.WriteStream,
      env: {},
    });

    await waitForTerminalText(terminal, "Paste one formatted plan or MCP envelope");
    terminal.input.write(`\u001b[200~${JSON.stringify(plan, null, 2)}\n\u001b[201~r`);
    await waitForTerminalText(terminal, "Run reviewed plan");
    await waitForTerminalText(terminal, "RUN RESULT");
    expect(terminal.text()).toContain("| Validating and running through the reviewed Explore boundary");
    expect(terminal.text()).toContain("\r\u001b[2K\u001b[?25h");
    await emitTerminalKey(terminal, { name: "escape", sequence: "\u001b" });
    await waitForTerminalText(terminal, "Press S for captured SQL");
    await emitTerminalKey(terminal, { name: "s", sequence: "s" });
    await waitForTerminalText(terminal, "SQL CAPTURED FOR THE LAST RUN");
    expect(terminal.text()).toContain("SELECT");
    expect(terminal.text()).toContain("public.orders");
    expect(terminal.text()).toContain("GROUP BY");
    await emitTerminalKey(terminal, { name: "escape", sequence: "\u001b" });
    await emitTerminalKey(terminal, { name: "escape", sequence: "\u001b" });

    await expect(interaction).resolves.toBe(0);
    expect(explore).toHaveBeenCalledWith(plan, undefined);
    expect(readEvidenceSql).toHaveBeenCalledWith(
      expect.stringMatching(/\.synapsor\/local\.db$/),
      "ev_playground_exact_sql",
    );
    expect(close).toHaveBeenCalledOnce();
    expect(terminal.input.isRaw).toBe(false);
    expect(terminal.text()).toContain("\u001b[?25h");
  });

  it("dispatches post-paste shortcuts immediately instead of replaying them on the next key", async () => {
    const terminal = testTerminal();
    const plan = aggregatePlan();
    const validate = vi.fn(async () => validationResult(plan));
    const explore = vi.fn();
    const close = vi.fn(async () => undefined);
    const interaction = exploreCommand(["playground", "--no-color"], {
      createRuntime: (async () => localRuntime({ validate, explore, close })) as never,
      stdin: terminal.input as unknown as NodeJS.ReadStream,
      stdout: terminal.output as unknown as NodeJS.WriteStream,
      stderr: terminal.output as unknown as NodeJS.WriteStream,
      env: {},
    });

    await waitForTerminalText(terminal, "Paste one formatted plan or MCP envelope");
    terminal.input.write(`\u001b[200~${JSON.stringify(plan, null, 2)}\ntrailing copied text with r\u001b[201~j`);
    await waitForTerminalText(terminal, "LOADED JSON PLAN");
    expect(validate).not.toHaveBeenCalled();
    expect(explore).not.toHaveBeenCalled();

    await emitTerminalKey(terminal, { name: "escape", sequence: "\u001b" });
    terminal.input.write("v");
    await waitForTerminalText(terminal, "PARAMETERIZED SQL PREVIEW");
    expect(validate).toHaveBeenCalledOnce();
    expect(explore).not.toHaveBeenCalled();

    await emitTerminalKey(terminal, { name: "escape", sequence: "\u001b" });
    await emitTerminalKey(terminal, { name: "escape", sequence: "\u001b" });
    await expect(interaction).resolves.toBe(0);
    expect(close).toHaveBeenCalledOnce();
    expect(terminal.input.isRaw).toBe(false);
  });

  it("lets Escape cancel the initial JSON paste and exit without changing authority or querying data", async () => {
    const terminal = testTerminal();
    const validate = vi.fn();
    const explore = vi.fn();
    const close = vi.fn(async () => undefined);
    const interaction = exploreCommand(["playground", "--no-color"], {
      createRuntime: (async () => localRuntime({ validate, explore, close })) as never,
      stdin: terminal.input as unknown as NodeJS.ReadStream,
      stdout: terminal.output as unknown as NodeJS.WriteStream,
      stderr: terminal.output as unknown as NodeJS.WriteStream,
      env: {},
    });

    await waitForTerminalText(terminal, "Esc cancels");
    await emitTerminalKey(terminal, { name: "escape", sequence: "\u001b" });
    await waitForTerminalText(terminal, "Paste cancelled. No plan is loaded.");
    await emitTerminalKey(terminal, { name: "escape", sequence: "\u001b" });

    await expect(interaction).resolves.toBe(0);
    expect(validate).not.toHaveBeenCalled();
    expect(explore).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(terminal.input.isRaw).toBe(false);
  });

  it("launches Workbench directly at the authenticated JSON playground", async () => {
    const openWorkbench = vi.fn(async () => 0);
    const resolveWorkbenchProject = vi.fn(async () => ({
      boundaryRoot: "/project/synapsor/generated",
      configPath: "/project/synapsor.runner.json",
      storePath: "/project/.synapsor/local.db",
    }));

    await expect(exploreCommand([
      "workbench",
      "--project-root",
      "/project",
    ], {
      openWorkbench,
      resolveWorkbenchProject,
      env: {},
    })).resolves.toBe(0);

    expect(resolveWorkbenchProject).toHaveBeenCalledWith("/project", {});
    expect(openWorkbench).toHaveBeenCalledWith([
      "--open",
      "--playground",
      "--boundary-root",
      "/project/synapsor/generated",
      "--config",
      "/project/synapsor.runner.json",
      "--store",
      "/project/.synapsor/local.db",
    ]);
  });
});

function aggregatePlan(): Record<string, unknown> {
  return {
    kind: "aggregate",
    resource: "public.orders",
    measures: [{ function: "count" }],
    dimensions: [{ field: "region" }],
    top_n: 10,
  };
}

function localRuntime(input: {
  validate: ReturnType<typeof vi.fn>;
  explore: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}) {
  return {
    boundary: { pack: { name: "finance" } },
    boundaries: [{ pack: { name: "finance" } }],
    active_boundary_set_digest: `sha256:${"a".repeat(64)}`,
    session_fingerprint: `sha256:${"b".repeat(64)}`,
    trusted_scope: {
      tenant: { source: "environment", binding: "SYNAPSOR_TENANT_ID" },
      principal: { source: "not_required" },
    },
    describe: async () => ({ ok: true, resources: [] }),
    validate: input.validate,
    explore: input.explore,
    projectResultForModel: ({ result }: { result: Record<string, unknown> }) => ({
      value: result,
      withheld: false,
    }),
    close: input.close,
  };
}

function validationResult(plan: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: true,
    outcome: { type: "validated", status: "ready" },
    normalized_plan: plan,
    boundary_name: "finance",
    boundary_digest: `sha256:${"c".repeat(64)}`,
    generation_lock_fingerprint: `sha256:${"d".repeat(64)}`,
    database_engine: "postgres",
    trusted_scope: {
      tenant: { source: "environment", binding: "SYNAPSOR_TENANT_ID" },
      principal: { source: "not_required" },
    },
    parameterized_sql: {
      schema_version: "synapsor.explore-parameterized-sql.v1",
      engine: "postgres",
      provenance: "captured_before_source_execution",
      parameter_values_persisted: false,
      model_received_sql: false,
      statements: [{ statement: "SELECT COUNT(*) FROM public.orders", parameter_count: 0, parameter_types: [] }],
    },
    validation: {
      source_catalog_rechecked: true,
      source_query_executed: false,
      explore_budget_consumed: false,
      estimated_response_cells: 20,
      statement_count: 1,
      parameter_values_included: false,
    },
    source_database_changed: false,
  };
}

function testTerminal(): {
  input: ReadStream & PassThrough & { isRaw: boolean };
  output: WriteStream & PassThrough;
  text(): string;
} {
  const input = new PassThrough() as ReadStream & PassThrough & {
    isRaw: boolean;
    setRawMode(value: boolean): ReadStream;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value: boolean) => {
    input.isRaw = value;
    return input;
  };
  const output = new PassThrough() as WriteStream & PassThrough;
  Object.assign(output, { isTTY: true, columns: 100, rows: 28 });
  const chunks: string[] = [];
  output.on("data", (chunk) => chunks.push(String(chunk)));
  return { input, output, text: () => chunks.join("") };
}

async function emitTerminalKey(
  terminal: ReturnType<typeof testTerminal>,
  key: { name: string; sequence: string },
): Promise<void> {
  terminal.input.emit("keypress", key.sequence, key);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForTerminalText(
  terminal: ReturnType<typeof testTerminal>,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!terminal.text().includes(expected)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for terminal text ${JSON.stringify(expected)}. Output:\n${terminal.text()}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
}
