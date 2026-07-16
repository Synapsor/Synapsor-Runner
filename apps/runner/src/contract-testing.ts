import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createMcpRuntime, loadRuntimeConfigFromFile, type RuntimeConfig, type TrustedContext } from "@synapsor-runner/mcp-server";
import { loadReviewedContract } from "./contract-tools.js";

export type ContractTestAssertion = {
  id: string;
  kind: "tool_allow" | "tool_deny" | "cross_principal_deny" | "hide_fields" | "argument_constraint" | "transition_guard" | "set_cap" | "source_unchanged_before_approval" | "operator_boundary";
  capability: string;
  args?: Record<string, unknown>;
  trusted_context?: { tenant_id: string; principal: string; provenance?: "environment" | "static_dev" | "http_claims" | "cloud_session" };
  other_trusted_context?: { tenant_id: string; principal: string; provenance?: "environment" | "static_dev" | "http_claims" | "cloud_session" };
  expected_code?: string;
  fields?: string[];
  argument?: string;
  expected?: Record<string, unknown>;
};

export type ContractTestManifest = {
  $schema?: string;
  version: 1;
  name?: string;
  tests: ContractTestAssertion[];
};

export type ContractTestCaseResult = {
  id: string;
  kind: ContractTestAssertion["kind"];
  capability: string;
  status: "passed" | "failed";
  code: string;
  message: string;
  duration_ms: number;
};

export type ContractTestReport = {
  schema_version: "synapsor.contract-test-report.v1";
  ok: boolean;
  manifest: string;
  contract: string;
  mode: "static" | "live";
  engine?: "postgres" | "mysql";
  summary: { passed: number; failed: number; total: number };
  tests: ContractTestCaseResult[];
};

const kinds = new Set<ContractTestAssertion["kind"]>([
  "tool_allow", "tool_deny", "cross_principal_deny", "hide_fields", "argument_constraint", "transition_guard", "set_cap", "source_unchanged_before_approval", "operator_boundary",
]);

export async function loadContractTestManifest(filePath: string): Promise<ContractTestManifest> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("CONTRACT_TEST_MANIFEST_INVALID: manifest must be an object");
  const record = parsed as Record<string, unknown>;
  rejectUnknownKeys(record, new Set(["$schema", "version", "name", "tests"]), "$");
  if (record.version !== 1) throw new Error("CONTRACT_TEST_VERSION_UNSUPPORTED: version must be 1");
  if (!Array.isArray(record.tests) || record.tests.length === 0) throw new Error("CONTRACT_TESTS_REQUIRED: tests must be a non-empty array");
  const ids = new Set<string>();
  const tests = record.tests.map((raw, index) => validateAssertion(raw, index, ids));
  return {
    ...(typeof record.$schema === "string" ? { $schema: record.$schema } : {}),
    version: 1,
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    tests,
  };
}

export async function runContractTests(input: {
  manifestPath: string;
  contractPath: string;
  configPath: string;
  live: boolean;
  allowRemote?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<ContractTestReport> {
  const manifest = await loadContractTestManifest(input.manifestPath);
  const reviewed = await loadReviewedContract(input.contractPath);
  await assertConfigReferencesContract(input.configPath, input.contractPath);
  const config = loadRuntimeConfigFromFile(input.configPath);
  const served = new Set(config.capabilities?.map((capability) => capability.name) ?? []);
  const missing = reviewed.contract.capabilities.map((capability) => capability.name).filter((name) => !served.has(name));
  if (missing.length) throw new Error(`CONTRACT_TEST_CONFIG_MISMATCH: config does not serve ${missing.join(", ")}`);
  const env = input.env ?? process.env;
  const engine = liveEngine(config);
  if (input.live) assertDisposableSources(config, env, input.allowRemote === true);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-contract-test-"));
  const results: ContractTestCaseResult[] = [];
  try {
    for (const test of manifest.tests) {
      const started = Date.now();
      try {
        if (requiresLive(test) && !input.live) {
          throw new ContractAssertionFailure("LIVE_TEST_REQUIRED", `${test.kind} requires --live against a disposable database`);
        }
        if (requiresLive(test) || (input.live && test.kind === "hide_fields" && test.args && test.trusted_context)) {
          await runLiveAssertion(test, config, env, path.join(tempDir, `${safeId(test.id)}.db`));
        } else {
          await runStaticAssertion(test, config);
        }
        results.push({ id: test.id, kind: test.kind, capability: test.capability, status: "passed", code: "PASS", message: "assertion passed", duration_ms: Date.now() - started });
      } catch (error) {
        const code = error instanceof ContractAssertionFailure ? error.code : "CONTRACT_TEST_INTERNAL";
        const message = error instanceof Error ? redactDiagnostic(error.message) : "contract test failed";
        results.push({ id: test.id, kind: test.kind, capability: test.capability, status: "failed", code, message, duration_ms: Date.now() - started });
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.length - passed;
  return {
    schema_version: "synapsor.contract-test-report.v1",
    ok: failed === 0,
    manifest: path.basename(input.manifestPath),
    contract: path.basename(input.contractPath),
    mode: input.live ? "live" : "static",
    ...(engine ? { engine } : {}),
    summary: { passed, failed, total: results.length },
    tests: results,
  };
}

export function formatContractTestReport(report: ContractTestReport, format: "text" | "json" | "junit"): string {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
  if (format === "junit") {
    const cases = report.tests.map((test) => `  <testcase classname="synapsor.contract" name="${xml(test.id)}" time="${(test.duration_ms / 1000).toFixed(3)}">${test.status === "failed" ? `<failure type="${xml(test.code)}" message="${xml(test.message)}"/>` : ""}</testcase>`).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="synapsor-contract" tests="${report.summary.total}" failures="${report.summary.failed}">\n${cases}\n</testsuite>\n`;
  }
  return `${[
    `Synapsor contract tests: ${report.ok ? "PASS" : "FAIL"}`,
    `Mode: ${report.mode}${report.engine ? ` (${report.engine})` : ""}`,
    ...report.tests.map((test) => `${test.status === "passed" ? "PASS" : "FAIL"} ${test.id} [${test.code}] ${test.message}`),
    `Summary: ${report.summary.passed} passed / ${report.summary.failed} failed / ${report.summary.total} total`,
  ].join("\n")}\n`;
}

async function runStaticAssertion(test: ContractTestAssertion, config: RuntimeConfig): Promise<void> {
  const capability = config.capabilities?.find((candidate) => candidate.name === test.capability);
  if (!capability) throw new ContractAssertionFailure("CAPABILITY_NOT_FOUND", `capability ${test.capability} is not served`);
  if (test.kind === "operator_boundary") {
    const runtime = createMcpRuntime(config, { storePath: ":memory:" });
    try {
      const names = runtime.listTools().map((tool) => tool.name);
      const forbidden = names.filter((name) => /(?:^|[._-])(approve|approval|apply|commit|writeback)(?:$|[._-])/i.test(name));
      if (forbidden.length) throw new ContractAssertionFailure("OPERATOR_TOOL_EXPOSED", `operator-only tools are model-facing: ${forbidden.join(", ")}`);
      if (!names.includes(test.capability)) throw new ContractAssertionFailure("CAPABILITY_NOT_FOUND", `capability ${test.capability} is not model-facing`);
    } finally {
      await runtime.close();
    }
    return;
  }
  if (test.kind === "hide_fields") {
    const fields = requiredStrings(test.fields, "hide_fields requires fields");
    const visible = new Set(capability.visible_columns);
    const leaked = fields.filter((field) => visible.has(field));
    if (leaked.length) throw new ContractAssertionFailure("HIDDEN_FIELD_EXPOSED", `visible fields include ${leaked.join(", ")}`);
    return;
  }
  if (test.kind === "argument_constraint") {
    if (!test.argument) throw new ContractAssertionFailure("ASSERTION_ARGUMENT_REQUIRED", "argument_constraint requires argument");
    const arg = capability.args[test.argument];
    if (!arg || arg.type === "object_array") throw new ContractAssertionFailure("ARGUMENT_NOT_FOUND", `scalar argument ${test.argument} is not declared`);
    const expected = test.expected ?? {};
    for (const key of ["minimum", "maximum", "max_length", "enum"] as const) {
      if (expected[key] !== undefined && !isDeepStrictEqual(arg[key], expected[key])) {
        throw new ContractAssertionFailure("ARGUMENT_CONSTRAINT_MISMATCH", `${test.argument}.${key} differs from the expected reviewed constraint`);
      }
    }
    return;
  }
  if (test.kind === "transition_guard") {
    const expected = test.expected ?? {};
    if (!isDeepStrictEqual(capability.transition_guards ?? {}, expected)) throw new ContractAssertionFailure("TRANSITION_GUARD_MISMATCH", "reviewed transition guard differs from expected");
    return;
  }
  if (test.kind === "set_cap") {
    const expectedRows = Number(test.expected?.max_rows);
    const actualRows = capability.operation?.max_rows;
    if (!Number.isInteger(expectedRows) || actualRows !== expectedRows) throw new ContractAssertionFailure("SET_CAP_MISMATCH", `MAX ROWS is ${actualRows ?? "missing"}, expected ${expectedRows}`);
    const expectedBounds = test.expected?.aggregate_bounds;
    if (expectedBounds !== undefined && !isDeepStrictEqual(capability.operation?.aggregate_bounds ?? [], expectedBounds)) throw new ContractAssertionFailure("AGGREGATE_CAP_MISMATCH", "aggregate bounds differ from expected");
    return;
  }
  throw new ContractAssertionFailure("LIVE_TEST_REQUIRED", `${test.kind} requires --live`);
}

async function runLiveAssertion(test: ContractTestAssertion, config: RuntimeConfig, env: NodeJS.ProcessEnv, storePath: string): Promise<void> {
  const trusted = test.trusted_context;
  if (!trusted) throw new ContractAssertionFailure("TRUSTED_CONTEXT_REQUIRED", `${test.kind} requires trusted_context in test setup`);
  if (test.kind === "cross_principal_deny") {
    const other = test.other_trusted_context;
    if (!other) throw new ContractAssertionFailure("OTHER_TRUSTED_CONTEXT_REQUIRED", "cross_principal_deny requires other_trusted_context");
    if (other.tenant_id !== trusted.tenant_id) throw new ContractAssertionFailure("CROSS_PRINCIPAL_TENANT_MISMATCH", "cross_principal_deny contexts must use the same tenant");
    if (other.principal === trusted.principal) throw new ContractAssertionFailure("CROSS_PRINCIPAL_IDENTITY_MATCH", "cross_principal_deny contexts must use different principals");
    const ownerRuntime = createMcpRuntime(config, {
      env, storePath, resultFormat: 2,
      trustedContext: { tenant_id: trusted.tenant_id, principal: trusted.principal, provenance: trusted.provenance ?? "static_dev" } as TrustedContext,
    });
    const deniedRuntime = createMcpRuntime(config, {
      env, storePath, resultFormat: 2,
      trustedContext: { tenant_id: other.tenant_id, principal: other.principal, provenance: other.provenance ?? "static_dev" } as TrustedContext,
    });
    try {
      const allowed = await ownerRuntime.callTool(test.capability, test.args ?? {});
      if (allowed.ok !== true) throw new ContractAssertionFailure("OWNER_ACCESS_NOT_PROVEN", "the owning principal could not access the reviewed row");
      const denied = await deniedRuntime.callTool(test.capability, test.args ?? {});
      const code = isRecord(denied.error) && typeof denied.error.code === "string" ? denied.error.code : undefined;
      const expected = test.expected_code ?? "NOT_FOUND_IN_TENANT";
      if (denied.ok === true || code !== expected) throw new ContractAssertionFailure("CROSS_PRINCIPAL_DENIAL_MISMATCH", `expected generic ${expected}, got ${code ?? "success"}`);
      const serialized = JSON.stringify(denied);
      const deniedEvidenceHandle = isRecord(denied.evidence) && typeof denied.evidence.bundle_id === "string" ? denied.evidence.bundle_id : undefined;
      const deniedProposalHandle = isRecord(denied.proposal) && typeof denied.proposal.id === "string" ? denied.proposal.id : undefined;
      if (deniedEvidenceHandle || deniedProposalHandle || /\b(?:ev|wrp|receipt|replay)_[A-Za-z0-9_.-]+\b/.test(serialized)) {
        throw new ContractAssertionFailure("CROSS_PRINCIPAL_HANDLE_LEAK", "denied result exposed a local resource handle");
      }
      const evidenceId = isRecord(allowed.evidence) && typeof allowed.evidence.bundle_id === "string" ? allowed.evidence.bundle_id : undefined;
      if (!evidenceId) throw new ContractAssertionFailure("OWNER_EVIDENCE_NOT_PROVEN", "the owning principal call did not create an evidence handle");
      try {
        await deniedRuntime.readResource(`synapsor://evidence/${evidenceId}`);
        throw new ContractAssertionFailure("CROSS_PRINCIPAL_HANDLE_LEAK", "another principal could read the owner's evidence handle");
      } catch (error) {
        if (error instanceof ContractAssertionFailure) throw error;
        if (!isRecord(error) || error.code !== "RESOURCE_NOT_FOUND") {
          throw new ContractAssertionFailure("CROSS_PRINCIPAL_HANDLE_DENIAL_MISMATCH", "another principal's evidence handle did not fail with generic RESOURCE_NOT_FOUND");
        }
      }
      return;
    } finally {
      await ownerRuntime.close();
      await deniedRuntime.close();
    }
  }
  const runtime = createMcpRuntime(config, {
    env,
    storePath,
    resultFormat: 2,
    trustedContext: { tenant_id: trusted.tenant_id, principal: trusted.principal, provenance: trusted.provenance ?? "static_dev" } as TrustedContext,
  });
  try {
    const result = await runtime.callTool(test.capability, test.args ?? {});
    const ok = result.ok === true;
    const code = isRecord(result.error) && typeof result.error.code === "string" ? result.error.code : undefined;
    if (test.kind === "tool_deny") {
      if (ok) throw new ContractAssertionFailure("EXPECTED_DENIAL", `${test.capability} unexpectedly succeeded`);
      if (!test.expected_code) throw new ContractAssertionFailure("EXPECTED_CODE_REQUIRED", "tool_deny requires expected_code");
      if (code !== test.expected_code) throw new ContractAssertionFailure("DENIAL_CODE_MISMATCH", `expected ${test.expected_code}, got ${code ?? "none"}`);
      return;
    }
    if (!ok) throw new ContractAssertionFailure(code ?? "TOOL_CALL_FAILED", `tool call failed with ${code ?? "unknown safe code"}`);
    if (test.kind === "source_unchanged_before_approval") {
      if (result.source_database_changed !== false || !isRecord(result.proposal)) throw new ContractAssertionFailure("PROPOSAL_BOUNDARY_FAILED", "proposal call did not prove unchanged source plus saved proposal");
      return;
    }
    if (test.kind === "hide_fields") {
      const fields = requiredStrings(test.fields, "hide_fields requires fields");
      const serializedResult = JSON.stringify(result);
      for (const field of fields) if (hasObjectKey(result, field) || serializedResult.includes(`\"${field}\"`)) throw new ContractAssertionFailure("HIDDEN_FIELD_EXPOSED", `${field} appeared in tool output`);
      const bundleId = isRecord(result.evidence) && typeof result.evidence.bundle_id === "string" ? result.evidence.bundle_id : undefined;
      if (bundleId) {
        const evidence = await runtime.readResource(`synapsor://evidence/${bundleId}`);
        for (const field of fields) if (hasObjectKey(evidence, field) || JSON.stringify(evidence).includes(`\"${field}\"`)) throw new ContractAssertionFailure("HIDDEN_FIELD_IN_EVIDENCE", `${field} appeared in evidence`);
      }
      const proposalId = isRecord(result.proposal) && typeof result.proposal.id === "string" ? result.proposal.id : undefined;
      if (proposalId) {
        const replay = await runtime.readResource(`synapsor://replay/${proposalId}`);
        for (const field of fields) if (hasObjectKey(replay, field) || JSON.stringify(replay).includes(`\"${field}\"`)) throw new ContractAssertionFailure("HIDDEN_FIELD_IN_REPLAY", `${field} appeared in replay`);
      }
    }
  } finally {
    await runtime.close();
  }
}

function validateAssertion(raw: unknown, index: number, ids: Set<string>): ContractTestAssertion {
  if (!isRecord(raw)) throw new Error(`CONTRACT_TEST_INVALID: tests[${index}] must be an object`);
  rejectUnknownKeys(raw, new Set(["id", "kind", "capability", "args", "trusted_context", "other_trusted_context", "expected_code", "fields", "argument", "expected"]), `$.tests[${index}]`);
  const id = requiredString(raw.id, `tests[${index}].id`);
  if (ids.has(id)) throw new Error(`CONTRACT_TEST_ID_DUPLICATE: ${id}`);
  ids.add(id);
  const kind = requiredString(raw.kind, `tests[${index}].kind`) as ContractTestAssertion["kind"];
  if (!kinds.has(kind)) throw new Error(`CONTRACT_TEST_KIND_UNSUPPORTED: ${kind}`);
  const capability = requiredString(raw.capability, `tests[${index}].capability`);
  return {
    id, kind, capability,
    ...(isRecord(raw.args) ? { args: raw.args } : {}),
    ...(isRecord(raw.trusted_context) ? { trusted_context: trustedContextFromManifest(raw.trusted_context, id) } : {}),
    ...(isRecord(raw.other_trusted_context) ? { other_trusted_context: trustedContextFromManifest(raw.other_trusted_context, `${id}.other_trusted_context`) } : {}),
    ...(typeof raw.expected_code === "string" ? { expected_code: raw.expected_code } : {}),
    ...(Array.isArray(raw.fields) ? { fields: raw.fields.map(String) } : {}),
    ...(typeof raw.argument === "string" ? { argument: raw.argument } : {}),
    ...(isRecord(raw.expected) ? { expected: raw.expected } : {}),
  };
}

function assertDisposableSources(config: RuntimeConfig, env: NodeJS.ProcessEnv, allowRemote: boolean): void {
  for (const [name, source] of Object.entries(config.sources ?? {})) {
    const raw = env[source.read_url_env];
    if (!raw) throw new Error(`CONTRACT_TEST_DATABASE_URL_MISSING: ${source.read_url_env} is not set for ${name}`);
    const parsed = new URL(raw.trim());
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    const disposableName = /(?:test|demo|fixture|synapsor)/i.test(parsed.pathname);
    if (!allowRemote && (!loopback || !disposableName)) throw new Error(`CONTRACT_TEST_REMOTE_DATABASE_REFUSED: ${name} must use a localhost disposable database; --allow-remote is an explicit operator override`);
  }
}

async function assertConfigReferencesContract(configPath: string, contractPath: string): Promise<void> {
  const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
  const contracts = isRecord(raw) && Array.isArray(raw.contracts) ? raw.contracts.map(String) : [];
  const base = path.dirname(path.resolve(configPath));
  const expected = path.resolve(contractPath);
  const referenced = contracts.some((candidate) => path.resolve(base, candidate) === expected);
  if (!referenced) throw new Error("CONTRACT_TEST_CONFIG_MISMATCH: --config must reference the exact --contract file so tests cannot silently exercise a different contract");
}

function liveEngine(config: RuntimeConfig): "postgres" | "mysql" | undefined {
  const engines = new Set(Object.values(config.sources ?? {}).map((source) => source.engine));
  return engines.size === 1 ? [...engines][0] : undefined;
}

function requiresLive(test: ContractTestAssertion): boolean {
  return ["tool_allow", "tool_deny", "cross_principal_deny", "source_unchanged_before_approval"].includes(test.kind);
}

function trustedContextFromManifest(record: Record<string, unknown>, id: string): NonNullable<ContractTestAssertion["trusted_context"]> {
  const provenance = record.provenance;
  if (provenance !== undefined && !["environment", "static_dev", "http_claims", "cloud_session"].includes(String(provenance))) {
    throw new Error(`CONTRACT_TEST_PROVENANCE_INVALID: ${id}.trusted_context.provenance`);
  }
  return {
    tenant_id: requiredString(record.tenant_id, `${id}.trusted_context.tenant_id`),
    principal: requiredString(record.principal, `${id}.trusted_context.principal`),
    ...(typeof provenance === "string" ? { provenance: provenance as TrustedContext["provenance"] } : {}),
  };
}

function requiredStrings(value: string[] | undefined, message: string): string[] {
  if (!value?.length) throw new ContractAssertionFailure("ASSERTION_FIELDS_REQUIRED", message);
  return value;
}

function requiredString(value: unknown, pathName: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`CONTRACT_TEST_STRING_REQUIRED: ${pathName}`);
  return value.trim();
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: Set<string>, pathName: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`CONTRACT_TEST_UNKNOWN_FIELD: ${pathName}.${unknown[0]}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasObjectKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((child) => hasObjectKey(child, key));
  if (!isRecord(value)) return false;
  return Object.prototype.hasOwnProperty.call(value, key) || Object.values(value).some((child) => hasObjectKey(child, key));
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function redactDiagnostic(message: string): string {
  return message
    .replace(/(?:postgres(?:ql)?|mysql):\/\/[^\s]+/gi, "[database-url-redacted]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/\b(?:password|token|secret)=\S+/gi, "$1=[redacted]");
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

class ContractAssertionFailure extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ContractAssertionFailure";
  }
}
