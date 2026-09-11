import { randomUUID } from "node:crypto";
import path from "node:path";

export function demoScenarioAtPublishedPort(scenario, run) {
  const portKey = `${scenario.engine === "mysql" ? 3306 : 5432}/tcp`;
  const result = run("docker", ["container", "inspect", scenario.container, "--format", "{{json .NetworkSettings.Ports}}"], { capture: true });
  const bindings = JSON.parse(result.stdout)?.[portKey];
  const ports = Array.isArray(bindings) ? bindings.map((binding) => binding.HostPort) : [];
  if (!ports.length || ports.some((port) => typeof port !== "string" || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) || new Set(ports).size !== 1) {
    throw new Error(`DEMO_PUBLISHED_PORT_INVALID: ${scenario.container} has no unambiguous published ${portKey} binding.`);
  }
  const replacePort = (value) => { const url = new URL(value); url.port = ports[0]; return url.href; };
  const readUrl = replacePort(scenario.readUrl), writeUrl = replacePort(scenario.writeUrl);
  if (![scenario.readUrl, scenario.writeUrl].every((url) => Object.values(scenario.env).includes(url))) {
    throw new Error("DEMO_URL_BINDING_MISSING: the fixture reader and writer environment bindings must both match its URLs.");
  }
  return {
    ...scenario, readUrl, writeUrl,
    env: Object.fromEntries(Object.entries(scenario.env).map(([key, value]) => [key,
      value === scenario.readUrl ? readUrl : value === scenario.writeUrl ? writeUrl : value,
    ])),
  };
}

export async function withDemoComposeFixture({ exampleDir, container }, run, exercise) {
  const project = `synapsor-mcp-${randomUUID().replaceAll("-", "")}`;
  const inspect = (args) => run("docker", args, { capture: true }).stdout.trim();
  if (inspect(["container", "ls", "-aq", "--filter", `name=^/${container}$`])) {
    throw new Error(`DEMO_FIXTURE_ALREADY_EXISTS: ${container} already exists. No existing container was changed; review its ownership before retrying.`);
  }
  for (const resource of ["container", "network", "volume"]) {
    if (inspect([resource, "ls", resource === "container" ? "-aq" : "-q", "--filter", `label=com.docker.compose.project=${project}`])) {
      throw new Error(`DEMO_FIXTURE_ALREADY_EXISTS: generated project ${project} is occupied. No existing resource was changed.`);
    }
  }
  // A unique, initially empty project makes cleanup safe even if startup only partly succeeds.
  const compose = ["compose", "-p", project, "-f", path.join(exampleDir, "docker-compose.yml")];
  let failed = false;
  let failure;
  try {
    run("docker", [...compose, "up", "-d"], { cwd: exampleDir });
    return await exercise();
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    try {
      run("docker", [...compose, "down", "-v"], { cwd: exampleDir });
    } catch (cleanupError) {
      if (failed) throw new AggregateError([failure, cleanupError], "Demo failed and its owned fixture cleanup also failed.");
      throw cleanupError;
    }
  }
}
