import crypto from "node:crypto";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_ISSUER = "https://identity.example";
const DEFAULT_AUDIENCE = "https://runner.example/mcp";
const DEFAULT_SCOPE = "synapsor.explore";

function assertE2e(condition, message, detail) {
  if (!condition) {
    throw new Error(`${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
  }
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Could not reserve a loopback port for the production Explore verifier."));
        return;
      }
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

export function productionExploreRunnerInvocation(root, args) {
  const packedRunner = process.env.SYNAPSOR_PRODUCTION_EXPLORE_RUNNER?.trim();
  return packedRunner
    ? { command: packedRunner, args }
    : { command: process.execPath, args: [path.join(root, "apps/runner/dist/cli.js"), ...args] };
}

export async function startProductionExploreCli({ root, configPath, env }) {
  const port = await findFreePort();
  const invocation = productionExploreRunnerInvocation(root, [
    "mcp",
    "serve",
    "--transport",
    "streamable-http",
    "--production-explore",
    "--config",
    configPath,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--trusted-tls-proxy",
  ]);
  const child = spawn(invocation.command, invocation.args, {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let exitState;

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Production Explore CLI did not become ready.\n${stdout}\n${stderr}`));
    }, 30_000);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const inspect = () => {
      if (settled) return;
      const match = stderr.match(/Synapsor Runner Streamable HTTP MCP listening on (https?:\/\/\S+)/);
      if (!match || !stderr.includes("PRODUCTION EXPLORE READY")) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        child,
        url: match[1],
        stdout: () => stdout,
        stderr: () => stderr,
        exitState: () => exitState,
      });
    };
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-40_000);
      inspect();
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-40_000);
      inspect();
    });
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      exitState = { code, signal, at: new Date().toISOString() };
      fail(new Error(`Production Explore CLI exited before readiness (${code ?? signal}).\n${stdout}\n${stderr}`));
    });
  });
}

export async function stopProductionExploreCli(handle) {
  if (!handle || handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  const killGroup = (signal) => {
    try {
      process.kill(-handle.child.pid, signal);
    } catch {
      handle.child.kill(signal);
    }
  };
  await new Promise((resolve) => {
    const timeout = setTimeout(() => killGroup("SIGKILL"), 5_000);
    handle.child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    killGroup("SIGTERM");
  });
}

function encodedJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function tokenPayload(input) {
  const now = Math.floor(Date.now() / 1000);
  return {
    ...(input.tenant !== undefined ? { tenant_id: input.tenant } : {}),
    ...(input.principal !== undefined ? { sub: input.principal } : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    iss: input.issuer ?? DEFAULT_ISSUER,
    aud: input.audience ?? DEFAULT_AUDIENCE,
    iat: input.issuedAt ?? now,
    exp: input.expiresAt ?? now + 600,
    ...(input.notBefore !== undefined ? { nbf: input.notBefore } : {}),
  };
}

function signedRs256Token(privateKey, input) {
  const header = encodedJson({ alg: "RS256", typ: "JWT", kid: input.kid ?? "production-explore-test" });
  const payload = encodedJson(tokenPayload({ scope: DEFAULT_SCOPE, ...input }));
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

function signedHs256Token(secret, input) {
  const header = encodedJson({ alg: "HS256", typ: "JWT", kid: "disallowed-hs256" });
  const payload = encodedJson(tokenPayload({ scope: DEFAULT_SCOPE, ...input }));
  const unsigned = `${header}.${payload}`;
  const signature = crypto.createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function unsignedNoneToken(input) {
  const header = encodedJson({ alg: "none", typ: "JWT" });
  const payload = encodedJson(tokenPayload({ scope: DEFAULT_SCOPE, ...input }));
  return `${header}.${payload}.`;
}

function createProductionExploreMcpClient(url, bearer, options = {}) {
  const endpoint = new URL(url);
  for (const [key, value] of Object.entries(options.query ?? {})) endpoint.searchParams.set(key, value);
  const headers = { ...(options.headers ?? {}) };
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers },
  });
  return {
    client: new Client({ name: "production-explore-verifier", version: "1.0.0" }),
    transport,
  };
}

export async function verifyGeneratedProductionHttpClientConfigs(input) {
  const cases = [
    {
      client: "claude-code",
      entry: (config) => config.mcpServers?.synapsor,
      tokenReference: "${SYNAPSOR_MCP_ACCESS_TOKEN}",
    },
    {
      client: "cursor",
      entry: (config) => config.mcpServers?.synapsor,
      tokenReference: "${env:SYNAPSOR_MCP_ACCESS_TOKEN}",
    },
    {
      client: "vscode",
      entry: (config) => config.servers?.synapsor,
      tokenReference: "${env:SYNAPSOR_MCP_ACCESS_TOKEN}",
    },
  ];
  const verified = [];
  for (const item of cases) {
    const invocation = productionExploreRunnerInvocation(input.root, [
      "mcp", "client-config",
      "--client", item.client,
      "--transport", "streamable-http",
      "--config", input.configPath,
      "--client-access-token-env", "SYNAPSOR_MCP_ACCESS_TOKEN",
    ]);
    const generated = spawnSync(invocation.command, invocation.args, {
      cwd: input.root,
      env: input.env,
      encoding: "utf8",
      stdio: "pipe",
    });
    assertE2e(generated.status === 0,
      `${item.client} client config generation failed.`, `${generated.stdout}\n${generated.stderr}`);
    const config = JSON.parse(generated.stdout);
    const entry = item.entry(config);
    assertE2e(entry?.url === input.protectedResource,
      `${item.client} client config did not use the reviewed protected-resource URL.`, entry);
    assertE2e(entry?.headers?.Authorization === `Bearer ${item.tokenReference}`,
      `${item.client} client config did not use its native environment-variable syntax.`, entry);
    assertE2e(/no token value was written/i.test(generated.stderr)
      && generated.stderr.includes("SYNAPSOR_MCP_ACCESS_TOKEN")
      && generated.stderr.includes(input.authorizationServer),
    `${item.client} client guidance did not explain safe token provisioning.`, generated.stderr);
    assertE2e(!/eyJ[A-Za-z0-9_-]+\.|BEGIN (?:RSA )?PRIVATE KEY|postgres(?:ql)?:\/\/|mysql:\/\//i.test(
      `${generated.stdout}\n${generated.stderr}`,
    ), `${item.client} client config disclosed secret or database material.`);

    const accessToken = await input.tokenForPrincipal(`client-config-${item.client}`);
    const authorization = entry.headers.Authorization.replace(item.tokenReference, accessToken);
    assertE2e(authorization === `Bearer ${accessToken}`,
      `${item.client} environment placeholder could not be resolved without editing the config.`);
    const handle = createProductionExploreMcpClient(
      input.serverUrl,
      authorization.slice("Bearer ".length),
    );
    await handle.client.connect(handle.transport);
    try {
      const names = (await handle.client.listTools()).tools.map((tool) => tool.name);
      assertE2e(names.join(",") === "app.describe_data,app.explore_data",
        `${item.client} generated HTTP config did not reach the exact production Explore surface.`, names);
    } finally {
      await handle.client.close();
    }
    verified.push(item.client);
  }
  return verified;
}

async function expectMcpAuthenticationRejected(input) {
  const handle = createProductionExploreMcpClient(input.url, input.bearer);
  let failure;
  try {
    await handle.client.connect(handle.transport);
  } catch (error) {
    failure = error;
  } finally {
    await handle.client.close().catch(() => undefined);
  }
  assertE2e(failure, `${input.label} unexpectedly initialized an MCP session.`);
  const message = String(failure);
  assertE2e(input.expected.test(message), `${input.label} returned the wrong authentication refusal.`, message);
  return message;
}

export async function verifyJwtRejectionMatrix(input) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { tenant: input.tenant, principal: input.principal };
  const cases = [
    {
      label: "Missing Authorization",
      bearer: undefined,
      expected: /401|unauthorized/i,
    },
    {
      label: "Bad JWT signature",
      bearer: signedRs256Token(input.wrongPrivateKey, claims),
      expected: /401|unauthorized/i,
    },
    {
      label: "Wrong JWT issuer",
      bearer: signedRs256Token(input.privateKey, { ...claims, issuer: "https://wrong-issuer.example" }),
      expected: /401|unauthorized/i,
    },
    {
      label: "Wrong JWT audience",
      bearer: signedRs256Token(input.privateKey, { ...claims, audience: "https://other-service.example/mcp" }),
      expected: /401|unauthorized/i,
    },
    {
      label: "Expired JWT",
      bearer: signedRs256Token(input.privateKey, { ...claims, issuedAt: now - 600, expiresAt: now - 120 }),
      expected: /401|unauthorized/i,
    },
    {
      label: "Missing tenant claim",
      bearer: signedRs256Token(input.privateKey, { principal: input.principal }),
      expected: /401|unauthorized/i,
    },
    {
      label: "Missing principal claim",
      bearer: signedRs256Token(input.privateKey, { tenant: input.tenant }),
      expected: /401|unauthorized/i,
    },
    {
      label: "Missing OAuth scope",
      bearer: signedRs256Token(input.privateKey, { ...claims, scope: undefined }),
      expected: /403|insufficient_scope/i,
    },
    {
      label: "Incorrect OAuth scope",
      bearer: signedRs256Token(input.privateKey, { ...claims, scope: "unrelated.scope" }),
      expected: /403|insufficient_scope/i,
    },
    {
      label: "Disallowed HS256 algorithm",
      bearer: signedHs256Token(crypto.randomBytes(32), claims),
      expected: /401|unauthorized/i,
    },
    {
      label: "Disallowed none algorithm",
      bearer: unsignedNoneToken(claims),
      expected: /401|unauthorized/i,
    },
  ];
  const refusals = [];
  for (const testCase of cases) {
    refusals.push({
      label: testCase.label,
      message: await expectMcpAuthenticationRejected({
        url: input.url,
        bearer: testCase.bearer,
        label: testCase.label,
        expected: testCase.expected,
      }),
    });
  }
  return refusals;
}
