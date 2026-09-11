import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { demoScenarioAtPublishedPort, withDemoComposeFixture } from "./demo-compose-fixture.mjs";

const fixture = { exampleDir: "/tmp/owned-demo-fixture", container: "owned_demo_container" };

function harness({ existingContainer = false, occupiedResource, inspectionFailure, startupFailure, cleanupFailure } = {}) {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] !== "compose") {
      if (inspectionFailure) throw inspectionFailure;
      const existing = args.includes(`name=^/${fixture.container}$`)
        ? existingContainer
        : args[0] === occupiedResource;
      return { status: 0, stdout: existing ? "existing-resource\n" : "" };
    }
    if (args.includes("up") && startupFailure) throw startupFailure;
    if (args.includes("down") && cleanupFailure) throw cleanupFailure;
    return { status: 0, stdout: "" };
  };
  return { calls, run, composeCalls: () => calls.filter(({ args }) => args[0] === "compose") };
}

describe("disposable demo Compose lifecycle", () => {
  it("includes the plan-credit database port in first-run preflight", () => {
    const script = fs.readFileSync(new URL("./try-synapsor.sh", import.meta.url), "utf8");
    const result = spawnSync("bash", ["-c", `${script.split("\nsay()")[0]}\nprintf '%s\\n' "\${PORTS[@]}"`], { encoding: "utf8", env: { ...process.env, SYNAPSOR_DEMO_PLAN_CREDIT_PORT: "" } });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toContain("55438");
  });

  it("cleans its unique project when startup fails, without running source checks", async () => {
    const failure = new Error("failed to bind host port: address already in use");
    const h = harness({ startupFailure: failure });
    let exercised = false;
    await expect(withDemoComposeFixture(fixture, h.run, async () => { exercised = true; })).rejects.toBe(failure);
    expect(exercised).toBe(false);
    const [up, down] = h.composeCalls();
    expect(h.composeCalls()).toHaveLength(2);
    expect(up.args).toEqual(["compose", "-p", expect.stringMatching(/^synapsor-mcp-[a-f0-9]{32}$/), "-f", `${fixture.exampleDir}/docker-compose.yml`, "up", "-d"]);
    expect(down.args).toEqual([...up.args.slice(0, -2), "down", "-v"]);
  });

  it("retains successful checks and tears down only the project started by this run", async () => {
    const h = harness();
    await expect(withDemoComposeFixture(fixture, h.run, async () => "checked")).resolves.toBe("checked");
    expect(h.composeCalls().map(({ args }) => args.at(-2))).toEqual(["up", "down"]);
    const other = harness();
    await withDemoComposeFixture(fixture, other.run, async () => undefined);
    expect(h.composeCalls()[0].args[2]).not.toBe(other.composeCalls()[0].args[2]);
  });

  it("does not swallow a failed safety assertion", async () => {
    const h = harness();
    const failure = new Error("source changed before approval");
    await expect(withDemoComposeFixture(fixture, h.run, async () => { throw failure; })).rejects.toBe(failure);
    expect(h.composeCalls().at(-1).args.at(-2)).toBe("down");
  });

  it("refuses a preexisting named container without startup or teardown", async () => {
    const h = harness({ existingContainer: true });
    await expect(withDemoComposeFixture(fixture, h.run, async () => { throw new Error("must not run"); })).rejects.toThrow("DEMO_FIXTURE_ALREADY_EXISTS");
    expect(h.composeCalls()).toEqual([]);
  });

  it.each(["container", "network", "volume"])("refuses an occupied project %s without mutation", async (resource) => {
    const h = harness({ occupiedResource: resource });
    await expect(withDemoComposeFixture(fixture, h.run, async () => undefined)).rejects.toThrow("DEMO_FIXTURE_ALREADY_EXISTS");
    expect(h.composeCalls()).toEqual([]);
  });

  it("fails closed if ownership inspection fails", async () => {
    const failure = new Error("Docker unavailable");
    const h = harness({ inspectionFailure: failure });
    await expect(withDemoComposeFixture(fixture, h.run, async () => undefined)).rejects.toBe(failure);
    expect(h.composeCalls()).toEqual([]);
  });

  it("reports cleanup failure instead of claiming a completed demo", async () => {
    const failure = new Error("cleanup failed");
    const h = harness({ cleanupFailure: failure });
    await expect(withDemoComposeFixture(fixture, h.run, async () => undefined)).rejects.toBe(failure);
  });

  it("preserves both the original failure and failed cleanup diagnostic", async () => {
    const startupFailure = new Error("port occupied"), cleanupFailure = new Error("daemon unavailable");
    const h = harness({ startupFailure, cleanupFailure });
    try {
      await withDemoComposeFixture(fixture, h.run, async () => undefined);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.errors).toEqual([startupFailure, cleanupFailure]);
    }
  });
});

describe("test-only plan-credit published port", () => {
  it.each(["0", "43123"])("uses configured port %s without probing unrelated 55438", (port) => {
    const script = fs.readFileSync(new URL("./try-synapsor.sh", import.meta.url), "utf8");
    const result = spawnSync("bash", ["-c", `${script.split("\nsay()")[0]}\nprintf '%s\\n' "\${PORTS[@]}"`], { encoding: "utf8", env: { ...process.env, SYNAPSOR_DEMO_PLAN_CREDIT_PORT: port } });
    expect(result.status).toBe(0);
    const ports = result.stdout.trim().split("\n");
    expect(ports).not.toContain("55438");
    expect(ports).not.toContain("0");
    if (port !== "0") expect(ports).toContain(port);
  });

  it.each(["-1", "65536", "abc", "1:5432", "04000"])("rejects invalid port %s", (port) => {
    const script = fs.readFileSync(new URL("./try-synapsor.sh", import.meta.url), "utf8");
    const result = spawnSync("bash", ["-c", script.split("\nsay()")[0]], { encoding: "utf8", env: { ...process.env, SYNAPSOR_DEMO_PLAN_CREDIT_PORT: port } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SYNAPSOR_DEMO_PLAN_CREDIT_PORT must be");
  });

  const scenario = {
    ...fixture, engine: "postgres", readUrl: "postgresql://reader:p%40ss@host.docker.internal:55438/owned?sslmode=disable",
    writeUrl: "postgresql://writer:p%40ss@host.docker.internal:55438/owned?sslmode=disable",
    policy: { minimum: 1, maximum: 100 },
  };
  scenario.env = { READ_URL: scenario.readUrl, WRITE_URL: scenario.writeUrl, SYNAPSOR_TENANT_ID: "owned", OTHER_URL: "https://example.test:55438/unchanged" };
  const inspect = (bindings) => (command, args, options) => {
    expect(command).toBe("docker");
    expect(args).toEqual(["container", "inspect", fixture.container, "--format", "{{json .NetworkSettings.Ports}}"]);
    expect(options).toEqual({ capture: true });
    return { stdout: JSON.stringify({ "5432/tcp": bindings }) };
  };

  it("propagates Docker's exact port to both URLs and runtime env while preserving all other values", () => {
    const before = structuredClone(scenario);
    const changed = demoScenarioAtPublishedPort(scenario, inspect([{ HostIp: "0.0.0.0", HostPort: "43123" }, { HostIp: "::", HostPort: "43123" }]));
    expect(changed.readUrl).toBe("postgresql://reader:p%40ss@host.docker.internal:43123/owned?sslmode=disable");
    expect(changed.writeUrl).toBe("postgresql://writer:p%40ss@host.docker.internal:43123/owned?sslmode=disable");
    expect(changed.env).toEqual({ ...scenario.env, READ_URL: changed.readUrl, WRITE_URL: changed.writeUrl });
    expect(changed.policy).toBe(scenario.policy);
    expect(scenario).toEqual(before);
  });

  it.each([null, [], [{ HostPort: "0" }], [{ HostPort: "65536" }], [{ HostPort: "43123" }, { HostPort: "43124" }]])("refuses missing or ambiguous publication %#", (bindings) => {
    expect(() => demoScenarioAtPublishedPort(scenario, inspect(bindings))).toThrow("DEMO_PUBLISHED_PORT_INVALID");
  });

  it("refuses missing reader/writer env bindings instead of leaving a stale URL", () => {
    expect(() => demoScenarioAtPublishedPort({ ...scenario, env: {} }, inspect([{ HostPort: "43123" }]))).toThrow("DEMO_URL_BINDING_MISSING");
  });

  it("forwards the same optional port into Docker and the plan-credit Compose fixture", () => {
    expect(fs.readFileSync(new URL("./demo-docker.sh", import.meta.url), "utf8")).toContain('-e SYNAPSOR_DEMO_PLAN_CREDIT_PORT="${SYNAPSOR_DEMO_PLAN_CREDIT_PORT:-55438}"');
    expect(fs.readFileSync(new URL("../examples/support-plan-credit/docker-compose.yml", import.meta.url), "utf8")).toContain('"${SYNAPSOR_DEMO_PLAN_CREDIT_PORT:-55438}:5432"');
  });
});
