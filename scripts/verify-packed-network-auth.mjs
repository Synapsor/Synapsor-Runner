import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = path.join(root, "apps", "runner");
const specPackageDir = path.join(root, "packages", "spec");
const expectedVersion = JSON.parse(await fsp.readFile(path.join(packageDir, "package.json"), "utf8")).version;
const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "synapsor-packed-network-auth-"));
const children = new Set();
let tarball;

try {
  run("corepack", ["pnpm", "build:runner-package"], { cwd: root });
  const specPack = run("corepack", ["pnpm", "pack", "--pack-destination", tempDir], { cwd: specPackageDir });
  const specPackedName = specPack.stdout.trim().split(/\r?\n/).findLast((line) => line.endsWith(".tgz"));
  assert(specPackedName, "pnpm pack did not return a Spec tarball filename", specPack.stdout);
  const specTarball = path.join(tempDir, path.basename(specPackedName));
  const pack = run("corepack", ["pnpm", "pack", "--pack-destination", tempDir], { cwd: packageDir });
  const packedName = pack.stdout.trim().split(/\r?\n/).findLast((line) => line.endsWith(".tgz"));
  assert(packedName, "pnpm pack did not return a tarball filename", pack.stdout);
  tarball = path.join(tempDir, path.basename(packedName));

  const entries = run("tar", ["-tzf", tarball]).stdout.trim().split(/\r?\n/);
  const forbiddenEntry = entries.find((entry) => /(^|\/)(?:development|\.synapsor)(?:\/|$)|\.(?:pem|key|crt|db|log)$|mcp-audit\.sarif$/i.test(entry));
  assert(!forbiddenEntry, "packed Runner contains development, state, or test authentication material", forbiddenEntry);
  assert(entries.includes("package/docs/http-mcp.md"), "packed Runner is missing docs/http-mcp.md");

  run("npm", ["init", "-y"], { cwd: tempDir });
  run("npm", ["install", specTarball, tarball], { cwd: tempDir });
  const packedRoot = path.join(tempDir, "node_modules", "@synapsor", "runner");
  const cli = path.join(packedRoot, "dist", "cli.js");
  const installed = JSON.parse(await fsp.readFile(path.join(packedRoot, "package.json"), "utf8"));
  assert(installed.version === expectedVersion, "scratch install has the wrong Runner version", installed.version);

  const clientScript = path.join(tempDir, "mcp-client.mjs");
  await fsp.writeFile(clientScript, `
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const transport = new StreamableHTTPClientTransport(new URL(process.env.PACKED_MCP_URL), {
  requestInit: { headers: { Authorization: \`Bearer \${process.env.PACKED_MCP_TOKEN}\` } },
});
const client = new Client({ name: "packed-network-verifier", version: "1.0.0" });
await client.connect(transport);
try {
  const result = await client.listTools();
  process.stdout.write(JSON.stringify(result.tools.map((tool) => tool.name).sort()));
} finally {
  await client.close();
}
`, { mode: 0o600 });

  const staticPort = await reservePort();
  const staticToken = crypto.randomBytes(32).toString("base64url");
  const staticConfigPath = path.join(tempDir, "loopback.runner.json");
  const staticConfig = baseConfig(path.join(tempDir, "loopback.db"));
  staticConfig.trusted_context = { provider: "static_dev", values: { tenant_id: "acme", principal: "packed-loopback" } };
  staticConfig.http_security = {
    deployment: "loopback",
    static_token: { active_env: "PACKED_STATIC_TOKEN" },
    allowed_hosts: [`127.0.0.1:${staticPort}`],
  };
  await writeJson(staticConfigPath, staticConfig);
  const staticEnv = runtimeEnv({ PACKED_STATIC_TOKEN: staticToken });
  const staticServer = startServer(cli, [
    "mcp", "serve", "--transport", "streamable-http", "--host", "127.0.0.1",
    "--port", String(staticPort), "--config", staticConfigPath,
  ], staticEnv);
  await waitForHealth(staticServer, staticPort, false);
  const missing = await request({ port: staticPort, method: "POST", path: "/mcp" });
  const wrong = await request({ port: staticPort, method: "POST", path: "/mcp", token: crypto.randomBytes(32).toString("base64url") });
  assert(missing.status === 401 && wrong.status === 401, "loopback HTTP did not reject missing/wrong opaque tokens", { missing: missing.status, wrong: wrong.status });
  const staticTools = runClient(clientScript, `http://127.0.0.1:${staticPort}/mcp`, staticToken, false);
  assertSemanticTools(staticTools);
  await stopServer(staticServer);

  const remotePort = await reservePort();
  const remoteConfigPath = path.join(tempDir, "remote-cleartext.runner.json");
  const remoteConfig = structuredClone(staticConfig);
  remoteConfig.storage.sqlite_path = path.join(tempDir, "remote-cleartext.db");
  remoteConfig.http_security = {
    deployment: "single_tenant",
    static_token: { active_env: "PACKED_STATIC_TOKEN" },
    allowed_hosts: [`127.0.0.1:${remotePort}`],
  };
  await writeJson(remoteConfigPath, remoteConfig);
  const refused = runPacked(cli, [
    "mcp", "serve", "--transport", "streamable-http", "--host", "0.0.0.0",
    "--port", String(remotePort), "--config", remoteConfigPath,
  ], staticEnv, { allowFailure: true, timeout: 10000 });
  const refusedOutput = `${refused.stdout}\n${refused.stderr}`;
  assert(refused.status !== 0 && refusedOutput.includes("HTTP_REMOTE_CLEARTEXT_REFUSED"), "packed Runner did not refuse undeclared remote cleartext before bind", refusedOutput);
  assert(!(await canConnect(remotePort)), "remote-cleartext refusal left a listening socket");

  const tlsPort = await reservePort();
  const tlsKeyPath = path.join(tempDir, "server.key");
  const tlsCertPath = path.join(tempDir, "server.crt");
  run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    "-keyout", tlsKeyPath, "-out", tlsCertPath,
  ], { quiet: true });
  const tlsKey = await fsp.readFile(tlsKeyPath, "utf8");
  const tlsCert = await fsp.readFile(tlsCertPath, "utf8");
  const sessionKeys = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const resource = `https://127.0.0.1:${tlsPort}/mcp`;
  const issuer = "https://identity.example.invalid";
  const sharedConfigPath = path.join(tempDir, "shared.runner.json");
  const sharedConfig = baseConfig(path.join(tempDir, "shared.db"));
  sharedConfig.trusted_context = {
    provider: "http_claims",
    values: { tenant_id_key: "tenant_id", principal_key: "sub" },
  };
  sharedConfig.session_auth = {
    provider: "jwt_asymmetric",
    algorithms: ["RS256"],
    public_key_env: "PACKED_SESSION_PUBLIC_KEY",
    issuer,
    audience: resource,
    tenant_claim: "tenant_id",
    principal_claim: "sub",
    clock_skew_seconds: 5,
  };
  sharedConfig.http_security = {
    deployment: "shared",
    channel: "direct_tls",
    oauth_resource: {
      resource,
      authorization_servers: [issuer],
      scopes_supported: ["synapsor:mcp"],
      required_scopes: ["synapsor:mcp"],
      resource_name: "Packed Synapsor Runner",
    },
    allowed_hosts: [`127.0.0.1:${tlsPort}`],
    limits: {
      max_request_bytes: 65536,
      max_header_bytes: 8192,
      max_sessions: 8,
      session_idle_timeout_seconds: 60,
      request_timeout_ms: 10000,
      headers_timeout_ms: 5000,
      keep_alive_timeout_ms: 5000,
      max_connections: 16,
    },
  };
  await writeJson(sharedConfigPath, sharedConfig);
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJwt({
    iss: issuer,
    aud: resource,
    sub: "packed-agent",
    tenant_id: "acme",
    scope: "synapsor:mcp",
    iat: now,
    nbf: now - 1,
    exp: now + 120,
  }, sessionKeys.privateKey);
  const sharedEnv = runtimeEnv({
    PACKED_SESSION_PUBLIC_KEY: sessionKeys.publicKey,
    PACKED_TLS_CERT: tlsCert,
    PACKED_TLS_KEY: tlsKey,
  });
  const tlsServer = startServer(cli, [
    "mcp", "serve", "--transport", "streamable-http", "--host", "127.0.0.1",
    "--port", String(tlsPort), "--config", sharedConfigPath,
    "--tls-cert-env", "PACKED_TLS_CERT", "--tls-key-env", "PACKED_TLS_KEY",
  ], sharedEnv);
  await waitForHealth(tlsServer, tlsPort, true);
  const metadata = await request({ port: tlsPort, secure: true, path: "/.well-known/oauth-protected-resource/mcp" });
  const metadataBody = JSON.parse(metadata.body);
  assert(metadata.status === 200 && metadataBody.resource === resource && metadataBody.authorization_servers?.[0] === issuer,
    "packed RFC 9728 protected-resource metadata is incorrect", metadataBody);
  const challenge = await request({ port: tlsPort, secure: true, method: "POST", path: "/mcp" });
  assert(challenge.status === 401 && String(challenge.headers["www-authenticate"] ?? "").includes("resource_metadata="),
    "packed shared endpoint omitted its protected-resource Bearer challenge", challenge.headers);
  const sharedTools = runClient(clientScript, resource, jwt, true);
  assertSemanticTools(sharedTools);

  const doctor = runPacked(cli, [
    "doctor", "--config", sharedConfigPath, "--json", "--transport", "streamable-http",
    "--host", "127.0.0.1", "--tls-cert-env", "PACKED_TLS_CERT", "--tls-key-env", "PACKED_TLS_KEY",
  ], sharedEnv, { allowFailure: true });
  const report = JSON.parse(doctor.stdout);
  for (const check of ["http-security:deployment", "http-security:channel", "http-security:authentication", "http-security:oauth-resource", "http-security:limits"]) {
    assert(report.checks?.some((item) => item.name === check), `packed doctor omitted ${check}`, report);
  }
  const combinedOutput = `${doctor.stdout}\n${doctor.stderr}\n${tlsServer.output}`;
  for (const secret of [jwt, sessionKeys.privateKey, tlsKey]) {
    assert(!combinedOutput.includes(secret), "packed diagnostics or startup output leaked authentication material");
  }
  await stopServer(tlsServer);

  process.stdout.write(`Packed Runner ${expectedVersion} network authentication verified:\n`);
  process.stdout.write("- loopback opaque Bearer authentication rejects missing/wrong credentials\n");
  process.stdout.write("- undeclared non-loopback cleartext refuses before bind\n");
  process.stdout.write("- direct TLS plus RS256 identity serves semantic tools through the official MCP client\n");
  process.stdout.write("- RFC 9728 metadata/challenge and redacted doctor posture are present\n");
  process.stdout.write("- tarball contains no development state, stores, logs, or certificate/key files\n");
} finally {
  for (const child of [...children]) await stopServer(child);
  await fsp.rm(tempDir, { recursive: true, force: true });
  if (tarball) await fsp.rm(tarball, { force: true });
}

function baseConfig(storePath) {
  return {
    version: 1,
    mode: "review",
    storage: { sqlite_path: storePath },
    sources: {
      app_postgres: {
        engine: "postgres",
        read_url_env: "PACKED_TEST_READ_URL",
        write_url_env: "PACKED_TEST_WRITE_URL",
        statement_timeout_ms: 1000,
      },
    },
    capabilities: [
      {
        name: "billing.inspect_invoice",
        kind: "read",
        source: "app_postgres",
        target: { schema: "public", table: "invoices", primary_key: "id", tenant_key: "tenant_id" },
        args: { invoice_id: { type: "string", required: true, max_length: 128 } },
        lookup: { id_from_arg: "invoice_id" },
        visible_columns: ["id", "tenant_id", "status", "late_fee_cents", "updated_at"],
        evidence: "required",
        max_rows: 1,
      },
      {
        name: "billing.propose_late_fee_waiver",
        kind: "proposal",
        source: "app_postgres",
        target: { schema: "public", table: "invoices", primary_key: "id", tenant_key: "tenant_id" },
        args: {
          invoice_id: { type: "string", required: true, max_length: 128 },
          reason: { type: "string", required: true, max_length: 500 },
        },
        lookup: { id_from_arg: "invoice_id" },
        visible_columns: ["id", "tenant_id", "status", "late_fee_cents", "updated_at"],
        evidence: "required",
        max_rows: 1,
        patch: { late_fee_cents: { fixed: 0 } },
        allowed_columns: ["late_fee_cents"],
        conflict_guard: { column: "updated_at" },
        approval: { mode: "human", required_role: "billing_lead" },
      },
    ],
  };
}

function runtimeEnv(extra = {}) {
  return {
    ...process.env,
    PACKED_TEST_READ_URL: "postgresql://reader:synthetic@127.0.0.1:9/app",
    PACKED_TEST_WRITE_URL: "postgresql://writer:synthetic@127.0.0.1:9/app",
    ...extra,
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout,
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "pipe",
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result;
}

function runPacked(cli, args, env, options = {}) {
  return run(process.execPath, [cli, ...args], { cwd: tempDir, env, ...options });
}

function startServer(cli, args, env) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: tempDir,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.output = "";
  child.stdout.on("data", (chunk) => { child.output += String(chunk); });
  child.stderr.on("data", (chunk) => { child.output += String(chunk); });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
  children.delete(child);
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(child, port, secure) {
  let last = "not attempted";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`packed server exited before readiness\n${child.output}`);
    try {
      const response = await request({ port, secure, path: "/healthz" });
      if (response.status === 200) return;
      last = `${response.status}: ${response.body}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`packed server did not become ready: ${last}\n${child.output}`);
}

function request({ port, secure = false, method = "GET", path: requestPath, token }) {
  const client = secure ? https : http;
  return new Promise((resolve, reject) => {
    const headers = { Accept: "application/json, text/event-stream" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = client.request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method,
      headers,
      rejectUnauthorized: false,
      timeout: 3000,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.once("timeout", () => req.destroy(new Error("request timed out")));
    req.once("error", reject);
    req.end();
  });
}

function runClient(clientScript, url, token, allowSyntheticTls) {
  const result = run(process.execPath, [clientScript], {
    cwd: tempDir,
    env: {
      ...process.env,
      PACKED_MCP_URL: url,
      PACKED_MCP_TOKEN: token,
      ...(allowSyntheticTls ? { NODE_TLS_REJECT_UNAUTHORIZED: "0" } : {}),
    },
  });
  return JSON.parse(result.stdout);
}

function assertSemanticTools(names) {
  assert(names.includes("billing.inspect_invoice") && names.includes("billing.propose_late_fee_waiver"), "packed MCP endpoint omitted semantic tools", names);
  const forbidden = names.find((name) => /(?:execute_sql|approve|apply|commit|reconcile|revert|token|credential)/i.test(name));
  assert(!forbidden, "packed MCP endpoint exposed operator or credential authority", forbidden);
}

function signJwt(payload, privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = `${header}.${body}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  return `${input}.${signature}`;
}

async function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function assert(condition, message, detail) {
  if (!condition) throw new Error(`${message}${detail === undefined ? "" : `\n${typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}`}`);
}
