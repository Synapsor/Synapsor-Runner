import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import { type RuntimeConfig } from "@synapsor-runner/mcp-server";
import {
  ProposalStore,
  type PolicyRecommendation,
  type StoredProposal
} from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { compileAgentDslWithWarnings, validateAgentDsl } from "@synapsor/dsl";
import { normalizeContract, validateContract, type SynapsorContract } from "@synapsor/spec";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { cliCommandName } from "./cli-command-meta.js";
import { fileExists, readJsonFileWithLocation, writeFileGuarded } from "./cli-files.js";
import { shellQuote } from "./cli-format.js";
import { usage } from "./cli-help.js";
import { operationalLog } from "./cli-logging.js";
import { assertKnownOptions, firstPositional, optionalArg, outputArg, positional, repeatedArgs, requiredOption, runtimeStoreBridgeFlag, uniqueStrings } from "./cli-options.js";
import { confirmDangerousAction, localStorePath, missingLocalStoreError, openLocalStore, optionalRuntimeConfig, readRuntimeConfig, redactConfig, resolveProposalIdFromStore, runnerConfigPath } from "./cli-project.js";
import { createComplianceReport, formatComplianceReport, readComplianceReport, verifyComplianceReport } from "./compliance-report.js";
import { validateConfigFile } from "./config-domain.js";
import { formatContractTestReport, runContractTests } from "./contract-testing.js";
import { explainContract, formatContractExplanation, formatContractLint, lintContract, lintFails, loadReviewedContract } from "./contract-tools.js";
import { runEffectCommandAdapter } from "./effect-command.js";
import {
  acceptEffectBaseline,
  compareEffectResult,
  createEffectFixtureFromReplay,
  createEffectFixtureFromShadowCase,
  createEffectRegressionReport,
  effectResultFileName,
  effectResultTemplate,
  formatEffectRegressionReport,
  loadEffectFixture,
  loadEffectFixtureSet,
  loadEffectResult,
  writeEffectJson,
  type EffectFixture,
} from "./effect-regression.js";
import { decideGraduatedTrustRecommendation, evaluateGraduatedTrust, formatGraduatedTrustEvaluation, markGraduatedTrustArtifactExported, prepareGraduatedTrustArtifact } from "./graduated-trust.js";
import { proposalIdFromReplayId } from "./ledger-options.js";
import { resolveOperatorIdentity, type OperatorIdentityConfig } from "./operator-identity.js";
import { argsWithRuntimeStoreBridge, assertNoRuntimeStoreForLocalMutation, maybeSharedPostgresRuntimeStoreRead, runtimeStoreBridgeRequired, sharedPostgresLedgerMirrorRequested, withoutSharedPostgresLedgerMirror, withSharedPostgresLedgerMirror, withSharedPostgresRuntimeStoreBridge, withSharedPostgresRuntimeStoreReadBridge } from "./store-shared.js";


export async function contractCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "validate") return contractValidate(rest);
  if (subcommand === "normalize") return contractNormalize(rest);
  if (subcommand === "bundle") return contractBundle(rest);
  if (subcommand === "explain") return contractExplain(rest);
  if (subcommand === "lint") return contractLint(rest);
  if (subcommand === "test") return contractTest(rest);
  usage(["contract"]);
  return 2;
}


export async function effectCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "fixture") return effectFixtureCommand(rest);
  if (subcommand === "result") return effectResultCommand(rest);
  if (subcommand === "run" || subcommand === "compare") return effectRun(rest);
  if (subcommand === "accept") return effectAccept(rest);
  usage(["effect"]);
  return 2;
}


async function effectFixtureCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "create") return effectFixtureCreate(rest);
  usage(["effect"]);
  return 2;
}


async function effectResultCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "init") return effectResultInit(rest);
  usage(["effect"]);
  return 2;
}


const effectFixtureCreateOptions = new Set([
  "--from-replay",
  "--from-proposal",
  "--from-shadow-case",
  "--request",
  "--name",
  "--contract",
  "--capability-call",
  "--config",
  "--store",
  "--output",
  "--out",
  "--force",
  runtimeStoreBridgeFlag,
]);


async function effectFixtureCreate(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(
    args,
    "effect fixture create",
    (storePath) => effectFixtureCreate(argsWithRuntimeStoreBridge(args, storePath)),
  );
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, effectFixtureCreateOptions, "effect fixture create");
  const sources = [
    ["replay", optionalArg(args, "--from-replay")],
    ["proposal", optionalArg(args, "--from-proposal")],
    ["shadow_case", optionalArg(args, "--from-shadow-case")],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  if (sources.length !== 1) {
    throw new Error("effect fixture create requires exactly one of --from-replay, --from-proposal, or --from-shadow-case");
  }
  const businessRequest = optionalArg(args, "--request");
  if (!businessRequest) throw new Error("effect fixture create requires --request <business-request>");
  const contractPath = optionalArg(args, "--contract");
  if (!contractPath) throw new Error("effect fixture create requires --contract <contract.synapsor.sql|synapsor.contract.json>");
  const output = outputArg(args);
  if (!output) throw new Error("effect fixture create requires --output <effect.fixture.json>");

  const reviewed = await loadReviewedContract(contractPath);
  const contractVersion = reviewed.contract.metadata?.version
    ?? canonicalJsonDigest(reviewed.contract);
  const store = await openLocalStore(args);
  let fixture: EffectFixture;
  try {
    const [sourceKind, reference] = sources[0]!;
    if (sourceKind === "shadow_case") {
      const shadowCase = store.getShadowCase(reference);
      if (!shadowCase) throw new Error(`shadow case not found: ${reference}`);
      const replay = shadowCase.proposal_id
        ? store.replay(shadowCase.proposal_id)
        : undefined;
      const capabilityCalls = effectCapabilityCalls(args, shadowCase.capability);
      fixture = createEffectFixtureFromShadowCase({
        shadowCase,
        replay,
        businessRequest,
        name: optionalArg(args, "--name"),
        capabilityCalls,
        hiddenFields: effectHiddenFields(reviewed.contract, capabilityCalls),
        contractVersion,
      });
    } else {
      const proposalId = reference.startsWith("replay_")
        ? proposalIdFromReplayId(reference)
        : resolveProposalIdFromStore(reference, store);
      const replay = store.replay(proposalId);
      const capability = replay.proposal.capability ?? replay.proposal.action;
      const capabilityCalls = effectCapabilityCalls(args, capability);
      fixture = createEffectFixtureFromReplay({
        replay,
        businessRequest,
        name: optionalArg(args, "--name"),
        sourceKind: sourceKind as "replay" | "proposal",
        capabilityCalls,
        hiddenFields: effectHiddenFields(reviewed.contract, capabilityCalls),
        contractVersion,
      });
    }
  } finally {
    store.close();
  }
  await writeEffectArtifactGuarded(output, fixture, args.includes("--force"));
  process.stdout.write([
    `wrote effect fixture: ${path.resolve(output)}`,
    `fixture: ${fixture.fixture_id}`,
    "evaluation mode: offline imported result (no Runner source read or write)",
    `next: ${cliCommandName()} effect result init --fixture ${shellQuote(output)} --output ${shellQuote(`${output}.result.json`)}`,
    "",
  ].join("\n"));
  return 0;
}


async function effectResultInit(args: string[]): Promise<number> {
  assertKnownOptions(
    args,
    new Set(["--fixture", "--output", "--out", "--force"]),
    "effect result init",
  );
  const fixturePath = optionalArg(args, "--fixture");
  if (!fixturePath) throw new Error("effect result init requires --fixture <effect.fixture.json>");
  const output = outputArg(args);
  if (!output) throw new Error("effect result init requires --output <effect.result.json>");
  const fixture = await loadEffectFixture(fixturePath);
  await writeEffectArtifactGuarded(
    output,
    effectResultTemplate(fixture),
    args.includes("--force"),
  );
  process.stdout.write([
    `wrote provider-neutral effect result template: ${path.resolve(output)}`,
    "Populate it from your agent harness without applying a write, then run:",
    `${cliCommandName()} effect run --fixture ${shellQuote(fixturePath)} --result ${shellQuote(output)}`,
    "",
  ].join("\n"));
  return 0;
}


async function effectRun(args: string[]): Promise<number> {
  assertKnownOptions(
    args,
    new Set([
      "--fixture",
      "--dataset",
      "--result",
      "--results-dir",
      "--adapter",
      "--adapter-arg",
      "--adapter-cwd",
      "--adapter-timeout-ms",
      "--result-origin",
      "--allow-live-read",
      "--format",
      "--json",
      "--output",
      "--out",
      "--force",
    ]),
    "effect run",
  );
  const fixturePath = optionalArg(args, "--fixture");
  const datasetPath = optionalArg(args, "--dataset");
  const fixtures = await loadEffectFixtureSet({ fixturePath, datasetPath });
  const explicitResult = optionalArg(args, "--result");
  const resultsDir = optionalArg(args, "--results-dir");
  const adapter = optionalArg(args, "--adapter");
  if (adapter && (explicitResult || resultsDir)) {
    throw new Error("effect run --adapter cannot be combined with --result or --results-dir");
  }
  if (!adapter && Boolean(explicitResult) === Boolean(resultsDir)) {
    throw new Error("effect run requires exactly one of --result, --results-dir, or --adapter");
  }
  if (explicitResult && fixtures.length !== 1) {
    throw new Error("effect run --result is valid only for one --fixture; use --results-dir with a dataset");
  }
  const allowLiveRead = args.includes("--allow-live-read");
  const resultOriginValue = optionalArg(args, "--result-origin");
  if (adapter && !resultOriginValue) {
    throw new Error("effect run --adapter requires --result-origin deterministic-application or external-model");
  }
  if (resultOriginValue && !["deterministic-application", "external-model"].includes(resultOriginValue)) {
    throw new Error("--result-origin must be deterministic-application or external-model");
  }
  const cases = [];
  for (const entry of fixtures) {
    const result = adapter
      ? await runEffectCommandAdapter({
          command: adapter,
          args: repeatedArgs(args, "--adapter-arg"),
          fixturePath: entry.path,
          cwd: optionalArg(args, "--adapter-cwd"),
          timeoutMs: optionalArg(args, "--adapter-timeout-ms")
            ? Number(optionalArg(args, "--adapter-timeout-ms"))
            : undefined,
        })
      : await loadEffectResult(explicitResult
        ?? path.join(path.resolve(resultsDir!), effectResultFileName(entry.fixture)));
    cases.push(compareEffectResult(entry.fixture, result, { allowLiveRead }));
  }
  const report = createEffectRegressionReport(cases, {
    allowLiveRead,
    mode: adapter ? "command_adapter" : "offline_import",
    resultOrigin: adapter
      ? resultOriginValue === "external-model" ? "external_model" : "deterministic_application"
      : "imported",
  });
  const formatValue = optionalArg(args, "--format") ?? (args.includes("--json") ? "json" : "text");
  if (!["text", "json", "junit"].includes(formatValue)) {
    throw new Error("effect run --format must be text, json, or junit");
  }
  const rendered = formatEffectRegressionReport(
    report,
    formatValue as "text" | "json" | "junit",
  );
  const output = outputArg(args);
  if (output) {
    await writeTextArtifactGuarded(output, rendered, args.includes("--force"));
  } else {
    process.stdout.write(rendered);
  }
  return report.ok ? 0 : 1;
}


async function effectAccept(args: string[]): Promise<number> {
  assertKnownOptions(
    args,
    new Set([
      "--fixture",
      "--result",
      "--actor",
      "--reason",
      "--output",
      "--out",
      "--in-place",
      "--yes",
      "--force",
    ]),
    "effect accept",
  );
  const fixturePath = optionalArg(args, "--fixture");
  const resultPath = optionalArg(args, "--result");
  const actor = optionalArg(args, "--actor");
  const reason = optionalArg(args, "--reason");
  if (!fixturePath || !resultPath) {
    throw new Error("effect accept requires --fixture <effect.fixture.json> --result <effect.result.json>");
  }
  if (!actor || !reason) throw new Error("effect accept requires --actor <identity> --reason <reviewed-change>");
  if (!args.includes("--yes")) {
    throw new Error("effect accept requires --yes after reviewing the changed business effect");
  }
  const inPlace = args.includes("--in-place");
  const output = outputArg(args);
  if (inPlace === Boolean(output)) {
    throw new Error("effect accept requires exactly one of --in-place or --output <new.fixture.json>");
  }
  const fixture = await loadEffectFixture(fixturePath);
  const result = await loadEffectResult(resultPath);
  const accepted = acceptEffectBaseline({ fixture, result, actor, reason });
  const destination = inPlace ? fixturePath : output!;
  if (inPlace) await writeEffectJson(destination, accepted);
  else await writeEffectArtifactGuarded(destination, accepted, args.includes("--force"));
  process.stdout.write([
    `accepted reviewed effect baseline: ${accepted.fixture_id}`,
    `actor: ${actor}`,
    `reason: ${reason}`,
    `wrote: ${path.resolve(destination)}`,
    "",
  ].join("\n"));
  return 0;
}


function effectCapabilityCalls(args: string[], fallback: string): string[] {
  const requested = repeatedArgs(args, "--capability-call")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return uniqueStrings(requested.length ? requested : [fallback]);
}


function effectHiddenFields(contract: SynapsorContract, capabilityCalls: string[]): string[] {
  const capabilities = new Map(contract.capabilities.map((capability) => [capability.name, capability]));
  const missing = capabilityCalls.filter((name) => !capabilities.has(name));
  if (missing.length) {
    throw new Error(`EFFECT_CAPABILITY_NOT_IN_CONTRACT: ${missing.join(", ")}`);
  }
  return uniqueStrings(capabilityCalls.flatMap((name) =>
    capabilities.get(name)?.kept_out_fields ?? []));
}


async function writeEffectArtifactGuarded(
  filePath: string,
  value: unknown,
  force: boolean,
): Promise<void> {
  if (!force && await fileExists(filePath)) {
    throw new Error(`${filePath} already exists. Use --force to overwrite it.`);
  }
  await writeEffectJson(filePath, value);
}


async function writeTextArtifactGuarded(
  filePath: string,
  value: string,
  force: boolean,
): Promise<void> {
  if (!force && await fileExists(filePath)) {
    throw new Error(`${filePath} already exists. Use --force to overwrite it.`);
  }
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await fs.writeFile(filePath, value, { encoding: "utf8", mode: 0o600 });
}


export async function dslCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "validate") return dslValidate(rest);
  if (subcommand === "compile") return dslCompile(rest);
  usage(["dsl"]);
  return 2;
}


async function dslValidate(args: string[]): Promise<number> {
  const target = firstPositional(args);
  if (!target) throw new Error("dsl validate requires a DSL source file such as contract.synapsor.sql or contract.synapsor");
  const source = await fs.readFile(target, "utf8");
  const strict = args.includes("--strict");
  const result = validateAgentDsl(source, { target: "runner" });
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`dsl valid: ${target}\n`);
    for (const warning of result.warnings) process.stdout.write(`warning ${warning.line}:${warning.column} ${warning.code}: ${warning.message}\n`);
  } else {
    process.stdout.write(`dsl invalid: ${target}\n`);
    for (const error of result.errors) process.stdout.write(`error ${error.line}:${error.column} ${error.code}: ${error.message}\n`);
  }
  return result.ok && (!strict || result.warnings.length === 0) ? 0 : 1;
}


async function dslCompile(args: string[]): Promise<number> {
  const target = firstPositional(args);
  if (!target) throw new Error("dsl compile requires a DSL source file such as contract.synapsor.sql or contract.synapsor");
  const source = await fs.readFile(target, "utf8");
  const strict = args.includes("--strict");
  const validation = validateAgentDsl(source, { target: "runner" });
  if (!validation.ok) {
    process.stdout.write(`dsl invalid for Synapsor Runner: ${target}\n`);
    for (const error of validation.errors) process.stdout.write(`error ${error.line}:${error.column} ${error.code}: ${error.message}\n`);
    return 1;
  }
  const result = compileAgentDslWithWarnings(source);
  if (strict && result.warnings.length > 0) {
    process.stdout.write(`dsl warnings treated as errors: ${target}\n`);
    for (const warning of result.warnings) process.stdout.write(`warning ${warning.line}:${warning.column} ${warning.code}: ${warning.message}\n`);
    return 1;
  }
  const contract = result.contract;
  const output = outputArg(args);
  const text = `${JSON.stringify(contract, null, 2)}\n`;
  if (output) {
    await fs.writeFile(output, text, "utf8");
    process.stdout.write(`wrote contract: ${output}\n`);
  } else {
    process.stdout.write(text);
  }
  for (const warning of result.warnings) process.stderr.write(`warning ${warning.line}:${warning.column} ${warning.code}: ${warning.message}\n`);
  return 0;
}


async function contractValidate(args: string[]): Promise<number> {
  const target = firstPositional(args);
  if (!target) throw new Error("contract validate requires <synapsor.contract.json>");
  const parsed = JSON.parse(await fs.readFile(target, "utf8"));
  const result = validateContract(parsed);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`contract valid: ${target}\n`);
    for (const warning of result.warnings) process.stdout.write(`warning ${warning.path} ${warning.code}: ${warning.message}\n`);
  } else {
    process.stdout.write(`contract invalid: ${target}\n`);
    for (const error of result.errors) process.stdout.write(`error ${error.path} ${error.code}: ${error.message}\n`);
  }
  return result.ok ? 0 : 1;
}


async function contractNormalize(args: string[]): Promise<number> {
  const target = firstPositional(args);
  if (!target) throw new Error("contract normalize requires <synapsor.contract.json>");
  const parsed = JSON.parse(await fs.readFile(target, "utf8"));
  const normalized = normalizeContract(parsed);
  const output = outputArg(args);
  const text = `${JSON.stringify(normalized, null, 2)}\n`;
  if (output) {
    await fs.writeFile(output, text, "utf8");
    process.stdout.write(`wrote normalized contract: ${output}\n`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}


async function contractExplain(args: string[]): Promise<number> {
  const target = firstPositional(args);
  if (!target) throw new Error("contract explain requires a .synapsor.sql, .synapsor, or canonical contract JSON file");
  const format = (optionalArg(args, "--format") ?? "text") as "text" | "markdown" | "json";
  if (!["text", "markdown", "json"].includes(format)) throw new Error("contract explain --format must be text, markdown, or json");
  const loaded = await loadReviewedContract(target);
  const text = formatContractExplanation(explainContract(loaded.contract), format);
  const output = outputArg(args);
  if (output) {
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, text, "utf8");
    process.stdout.write(`wrote contract explanation: ${output}\n`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}


async function contractLint(args: string[]): Promise<number> {
  const target = firstPositional(args);
  if (!target) throw new Error("contract lint requires a .synapsor.sql, .synapsor, or canonical contract JSON file");
  const format = (optionalArg(args, "--format") ?? "text") as "text" | "json" | "sarif";
  if (!["text", "json", "sarif"].includes(format)) throw new Error("contract lint --format must be text, json, or sarif");
  const failOn = (optionalArg(args, "--fail-on") ?? (args.includes("--strict") ? "warning" : "error")) as "error" | "warning";
  if (!["error", "warning"].includes(failOn)) throw new Error("contract lint --fail-on must be warning or error");
  const loaded = await loadReviewedContract(target);
  const configPath = optionalArg(args, "--config");
  const runnerConfig = configPath ? JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown> : undefined;
  const result = lintContract(loaded.contract, { runnerConfig, dslWarnings: loaded.dslWarnings });
  const text = formatContractLint(result, format);
  const output = outputArg(args);
  if (output) {
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, text, "utf8");
    process.stdout.write(`wrote contract lint report: ${output}\n`);
  } else {
    process.stdout.write(text);
  }
  return lintFails(result, failOn) ? 1 : 0;
}


async function contractTest(args: string[]): Promise<number> {
  const contractPath = optionalArg(args, "--contract");
  const testsPath = optionalArg(args, "--tests");
  const configPath = optionalArg(args, "--config");
  if (!contractPath || !testsPath || !configPath) throw new Error("contract test requires --contract, --tests, and --config");
  const format = (optionalArg(args, "--format") ?? "text") as "text" | "json" | "junit";
  if (!["text", "json", "junit"].includes(format)) throw new Error("contract test --format must be text, json, or junit");
  const report = await runContractTests({
    contractPath,
    manifestPath: testsPath,
    configPath,
    live: args.includes("--live"),
    allowRemote: args.includes("--allow-remote"),
  });
  const text = formatContractTestReport(report, format);
  const output = outputArg(args);
  if (output) {
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, text, "utf8");
    process.stdout.write(`wrote contract test report: ${output}\n`);
  } else {
    process.stdout.write(text);
  }
  return report.ok ? 0 : 1;
}


export async function reportCommand(args: string[]): Promise<number> {
  if (args[0] === "verify") {
    const file = firstPositional(args.slice(1));
    if (!file) throw new Error("report verify requires <report.json|report.md|report.pdf>");
    const result = await verifyComplianceReport(await readComplianceReport(file), optionalArg(args, "--public-key"));
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`Synapsor report verification: ${result.ok ? "PASS" : "FAIL"}\nCode: ${result.code}\nDigest: ${result.digest_ok ? "verified" : "invalid"}${result.signature_ok === undefined ? "" : `\nSignature: ${result.signature_ok ? "verified" : "invalid"}`}\n`);
    return result.ok ? 0 : 1;
  }
  const configPath = optionalArg(args, "--config");
  const config = configPath ? await readRuntimeConfig(configPath) : undefined;
  if (config && runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreReadBridge(args, config, "report", (bridgeStorePath) =>
      reportCommand(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  }
  const tenant = optionalArg(args, "--tenant")?.trim();
  if (!tenant) throw new Error("REPORT_TENANT_REQUIRED: report generation requires an explicit trusted --tenant scope");
  const object = optionalArg(args, "--object")?.trim();
  const principal = optionalArg(args, "--principal")?.trim();
  if (Boolean(object) === Boolean(principal)) throw new Error("report requires exactly one of --object <type:id> or --principal <principal>");
  const scope = object ? reportObjectScope(tenant, object) : { kind: "principal" as const, tenant_id: tenant, principal: principal! };
  const storePath = localStorePath(args);
  if (storePath !== ":memory:" && !await fileExists(storePath)) throw missingLocalStoreError(storePath);
  const format = (optionalArg(args, "--format") ?? "markdown") as "markdown" | "json" | "pdf";
  if (!["markdown", "json", "pdf"].includes(format)) throw new Error("report --format must be markdown, json, or pdf");
  const report = await createComplianceReport({
    storePath,
    scope,
    signingKeyPath: optionalArg(args, "--signing-key"),
    signingKeyId: optionalArg(args, "--key-id"),
  });
  const rendered = await formatComplianceReport(report, format);
  const output = outputArg(args);
  if (format === "pdf" && !output) throw new Error("report --format pdf requires --out <report.pdf>");
  if (output) {
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, rendered);
    process.stdout.write(`wrote ${format} compliance report: ${output}\nIntegrity: ${report.integrity.digest}\n`);
  } else {
    process.stdout.write(String(rendered));
  }
  return 0;
}


function reportObjectScope(tenant: string, value: string): { kind: "object"; tenant_id: string; object_type: string; object_id: string } {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) throw new Error("report --object must be <type:id>");
  return { kind: "object", tenant_id: tenant, object_type: value.slice(0, separator), object_id: value.slice(separator + 1) };
}


export async function policyCommand(args: string[]): Promise<number> {
  const configPath = runnerConfigPath(args);
  const config = await optionalRuntimeConfig(configPath);
  if (config && runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(args, config, `policy ${args.slice(0, 3).join(" ")}`, (bridgeStorePath) =>
      policyCommand(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  }
  assertNoRuntimeStoreForLocalMutation(config, "policy recommendations", args);
  const storePath = localStorePath(args);
  if (sharedPostgresLedgerMirrorRequested(args, config)) {
    return withSharedPostgresLedgerMirror(args, storePath, `policy ${args.slice(0, 3).join(" ")}`, () => policyCommand(withoutSharedPostgresLedgerMirror(args)), config);
  }

  const [group, action] = args;
  if (group === "recommend") return policyRecommend(args.slice(1), configPath, config);
  if (group !== "recommendations") throw new Error("policy requires recommend or recommendations <list|show|approve|reject|export>");
  if (action === "list") return policyRecommendationsList(args.slice(2));
  if (action === "show") return policyRecommendationsShow(args.slice(2));
  if (action === "approve" || action === "reject") return policyRecommendationsDecide(action, args.slice(2), configPath, config);
  if (action === "export") return policyRecommendationsExport(args.slice(2));
  throw new Error("policy recommendations requires list, show, approve, reject, or export");
}


async function policyRecommend(args: string[], configPath: string, config: RuntimeConfig | undefined): Promise<number> {
  if (!config) throw new Error(`graduated trust requires a Runner config: ${configPath}`);
  const contractPath = requiredOption(args, "--contract", "policy recommend");
  const tenant = requiredOption(args, "--tenant", "policy recommend");
  const capability = requiredOption(args, "--capability", "policy recommend");
  const policy = requiredOption(args, "--policy", "policy recommend");
  const loaded = await loadReviewedContract(contractPath);
  const store = await openLocalStore(args);
  try {
    const result = await evaluateGraduatedTrust({
      config,
      contract: loaded.contract,
      store,
      tenant,
      capability,
      policy,
      now: optionalArg(args, "--now"),
    });
    process.stdout.write(args.includes("--json") ? `${JSON.stringify(result, null, 2)}\n` : formatGraduatedTrustEvaluation(result));
    return result.ok ? 0 : 1;
  } finally {
    store.close();
  }
}


async function policyRecommendationsList(args: string[]): Promise<number> {
  const tenant = requiredOption(args, "--tenant", "policy recommendations list");
  const store = await openLocalStore(args);
  try {
    const recommendations = store.listPolicyRecommendations({
      tenant,
      capability: optionalArg(args, "--capability"),
      policy: optionalArg(args, "--policy"),
      status: optionalArg(args, "--status") as PolicyRecommendation["status"] | undefined,
    });
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(recommendations, null, 2)}\n`);
    else if (recommendations.length === 0) process.stdout.write("No policy recommendations matched the trusted tenant scope.\n");
    else process.stdout.write(`${recommendations.map(formatPolicyRecommendationSummary).join("\n")}\n`);
    return 0;
  } finally {
    store.close();
  }
}


async function policyRecommendationsShow(args: string[]): Promise<number> {
  const recommendationId = positional(args, 0);
  if (!recommendationId) throw new Error("policy recommendations show requires <recommendation_id>");
  const tenant = requiredOption(args, "--tenant", "policy recommendations show");
  const store = await openLocalStore(args);
  try {
    const recommendation = requirePolicyRecommendationForTenant(store, recommendationId, tenant);
    process.stdout.write(args.includes("--json") ? `${JSON.stringify(recommendation, null, 2)}\n` : formatPolicyRecommendationDetail(recommendation));
    return 0;
  } finally {
    store.close();
  }
}


async function policyRecommendationsDecide(
  action: "approve" | "reject",
  args: string[],
  configPath: string,
  config: RuntimeConfig | undefined,
): Promise<number> {
  const recommendationId = positional(args, 0);
  if (!recommendationId) throw new Error(`policy recommendations ${action} requires <recommendation_id>`);
  const tenant = requiredOption(args, "--tenant", `policy recommendations ${action}`);
  const reason = requiredOption(args, "--reason", `policy recommendations ${action}`);
  if (!config?.operator_identity || config.operator_identity.provider === "dev_env") {
    throw new Error("POLICY_RECOMMENDATION_VERIFIED_IDENTITY_REQUIRED: configure signed_key or jwt_oidc operator_identity");
  }
  const store = await openLocalStore(args);
  try {
    const recommendation = requirePolicyRecommendationForTenant(store, recommendationId, tenant);
    await confirmDangerousAction(args, `${action === "approve" ? "Approve" : "Reject"} policy recommendation ${recommendationId}? This records a decision but does not activate a contract.`);
    const identity = await policyRecommendationIdentity({ args, config, configPath, store, recommendation, action, reason });
    const updated = await decideGraduatedTrustRecommendation({
      store,
      recommendationId,
      action,
      actor: identity.subject,
      reason,
      identity,
      now: optionalArg(args, "--now"),
    });
    operationalLog("info", "policy_recommendation_decision", {
      recommendation_id: updated.recommendation_id,
      tenant: updated.tenant_id,
      capability: updated.capability,
      policy: updated.policy,
      action,
      subject: identity.subject,
      identity_provider: identity.provider,
      identity_verified: identity.verified,
      contract_activated: false,
    });
    process.stdout.write(args.includes("--json") ? `${JSON.stringify(updated, null, 2)}\n` : formatPolicyRecommendationDetail(updated));
    return 0;
  } finally {
    store.close();
  }
}


async function policyRecommendationsExport(args: string[]): Promise<number> {
  const recommendationId = positional(args, 0);
  if (!recommendationId) throw new Error("policy recommendations export requires <recommendation_id>");
  const tenant = requiredOption(args, "--tenant", "policy recommendations export");
  const contractPath = requiredOption(args, "--contract", "policy recommendations export");
  const output = outputArg(args);
  if (!output) throw new Error("policy recommendations export requires --out <contract.json>");
  const actor = requiredOption(args, "--actor", "policy recommendations export");
  const loaded = await loadReviewedContract(contractPath);
  const store = await openLocalStore(args);
  try {
    requirePolicyRecommendationForTenant(store, recommendationId, tenant);
    const artifact = await prepareGraduatedTrustArtifact({ store, recommendationId, activeContract: loaded.contract });
    await confirmDangerousAction(args, `Export reviewed policy artifact for ${recommendationId}? This does not push or activate it.`);
    await writeFileGuarded(output, `${JSON.stringify(artifact.contract, null, 2)}\n`, args.includes("--force"));
    const updated = await markGraduatedTrustArtifactExported({
      store,
      recommendationId,
      actor,
      artifactDigest: artifact.digest,
      now: optionalArg(args, "--now"),
    });
    operationalLog("info", "policy_recommendation_export", {
      recommendation_id: updated.recommendation_id,
      tenant: updated.tenant_id,
      artifact_digest: artifact.digest,
      base_contract_digest: updated.base_contract_digest,
      contract_activated: false,
    });
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify({ recommendation: updated, artifact: { path: output, digest: artifact.digest, diff: artifact.diff }, activated: false }, null, 2)}\n`
      : `exported reviewable policy artifact: ${output}\nDigest: ${artifact.digest}\nChange: ${artifact.diff.field} ${artifact.diff.before} -> ${artifact.diff.after}\nActivation: not performed\n`);
    return 0;
  } finally {
    store.close();
  }
}


async function policyRecommendationIdentity(input: {
  args: string[];
  config: RuntimeConfig;
  configPath: string;
  store: ProposalStore;
  recommendation: PolicyRecommendation;
  action: "approve" | "reject";
  reason: string;
}) {
  const evidenceProposalId = input.recommendation.evidence_proposal_ids[0];
  const evidenceProposal = evidenceProposalId ? input.store.getProposal(evidenceProposalId) : undefined;
  if (!evidenceProposal) throw new Error("POLICY_RECOMMENDATION_EVIDENCE_MISSING: the recommendation cannot be authorized without its bound proposal evidence");
  const syntheticProposal: StoredProposal = {
    ...evidenceProposal,
    proposal_id: input.recommendation.recommendation_id,
    proposal_version: 1,
    proposal_hash: input.recommendation.integrity_hash,
    tenant_id: input.recommendation.tenant_id,
    capability: input.recommendation.capability,
    action: `policy_change:${input.recommendation.policy}`,
  };
  const identity = await resolveOperatorIdentity({
    config: input.config.operator_identity as OperatorIdentityConfig,
    configPath: input.configPath,
    proposal: syntheticProposal,
    action: input.action,
    reason: input.reason,
    actor: optionalArg(input.args, "--actor"),
    identity: optionalArg(input.args, "--identity"),
    privateKeyPath: optionalArg(input.args, "--identity-key"),
  });
  if (!identity.verified || identity.provider === "dev_env") throw new Error("POLICY_RECOMMENDATION_VERIFIED_IDENTITY_REQUIRED: decision identity was not cryptographically verified");
  return identity;
}


function requirePolicyRecommendationForTenant(store: ProposalStore, recommendationId: string, tenant: string): PolicyRecommendation {
  const recommendation = store.getPolicyRecommendation(recommendationId);
  if (!recommendation || recommendation.tenant_id !== tenant) throw new Error(`policy recommendation not found in trusted tenant scope: ${recommendationId}`);
  return recommendation;
}


function formatPolicyRecommendationSummary(recommendation: PolicyRecommendation): string {
  return `${recommendation.recommendation_id}  ${recommendation.status}  ${recommendation.capability}  ${recommendation.policy}.${recommendation.field} ${recommendation.current_threshold} -> ${recommendation.proposed_threshold}`;
}


function formatPolicyRecommendationDetail(recommendation: PolicyRecommendation): string {
  return [
    `Policy recommendation: ${recommendation.recommendation_id}`,
    `Status: ${recommendation.status}`,
    `Tenant: ${recommendation.tenant_id}`,
    `Capability: ${recommendation.capability}`,
    `Policy: ${recommendation.policy}`,
    `Threshold: ${recommendation.field} ${recommendation.current_threshold} -> ${recommendation.proposed_threshold}`,
    `Base contract: ${recommendation.base_contract_digest} (${recommendation.base_contract_version})`,
    `Evidence proposals: ${recommendation.evidence_proposal_ids.length}`,
    `Integrity: ${recommendation.integrity_hash}`,
    recommendation.decision ? `Decision: ${recommendation.decision.action} by ${recommendation.decision.actor}` : "Decision: pending verified operator review",
    recommendation.export ? `Artifact: ${recommendation.export.artifact_digest}` : "Artifact: not exported",
    "Activation: not performed by Runner",
    "",
  ].join("\n");
}


async function contractBundle(args: string[]): Promise<number> {
  const target = firstPositional(args);
  if (!target) throw new Error("contract bundle requires <synapsor.contract.json>");
  const outDir = outputArg(args) ?? "synapsor-runner-bundle";
  const parsed = JSON.parse(await fs.readFile(target, "utf8"));
  const contract = normalizeContract(parsed);
  const firstCapability = contract.capabilities[0];
  const firstSource = firstCapability?.source ?? "local_postgres";
  const engine = inferContractBundleEngine(contract);
  const readUrlEnv = engine === "mysql" ? "SYNAPSOR_DATABASE_READ_URL" : "SYNAPSOR_DATABASE_READ_URL";
  const hasProposals = contract.capabilities.some((capability) => capability.kind === "proposal");
  const sourceConfig: Record<string, unknown> = {
    engine,
    read_url_env: readUrlEnv,
    statement_timeout_ms: 3000,
  };
  if (hasProposals) sourceConfig.write_url_env = "SYNAPSOR_DATABASE_WRITE_URL";
  const runnerConfig = {
    version: 1,
    mode: hasProposals ? "review" : "read_only",
    result_format: 2,
    storage: { sqlite_path: "./.synapsor/local.db" },
    contracts: ["./synapsor.contract.json"],
    sources: {
      [firstSource]: sourceConfig,
    },
  };
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(path.join(outDir, "mcp-client-examples"), { recursive: true });
  await fs.writeFile(path.join(outDir, "synapsor.contract.json"), `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outDir, "synapsor.runner.json"), `${JSON.stringify(runnerConfig, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outDir, ".env.example"), bundleEnvExample(contract, readUrlEnv, engine), "utf8");
  await fs.writeFile(path.join(outDir, "README.md"), bundleReadme(contract), "utf8");
  for (const [name, content] of Object.entries(bundleMcpClientExamples())) {
    await fs.writeFile(path.join(outDir, "mcp-client-examples", name), content, "utf8");
  }
  process.stdout.write(`created runner bundle: ${outDir}\n`);
  process.stdout.write("No database URLs, write credentials, tokens, or customer rows were included.\n");
  return 0;
}


function inferContractBundleEngine(contract: SynapsorContract): "postgres" | "mysql" {
  const engine = contract.resources?.find((resource) => resource.engine === "postgres" || resource.engine === "mysql")?.engine;
  return engine === "mysql" ? "mysql" : "postgres";
}


function bundleEnvExample(contract: SynapsorContract, readUrlEnv: string, engine: "postgres" | "mysql"): string {
  const context = contract.contexts[0];
  const tenantBinding = context?.bindings.find((binding) => binding.name === context.tenant_binding) ?? context?.bindings.find((binding) => binding.name === "tenant_id");
  const principalBinding = context?.bindings.find((binding) => binding.name === context.principal_binding) ?? context?.bindings.find((binding) => binding.name === "principal");
  return [
    "# Synapsor Runner bundle environment.",
    "# Fill these locally. Do not commit real values.",
    `# Set ${readUrlEnv} to your read-only ${engine === "mysql" ? "MySQL" : "Postgres"} URL.`,
    `${readUrlEnv}=`,
    ...(contract.capabilities.some((capability) => capability.kind === "proposal") ? ["# Optional: separate least-privilege write URL for guarded direct UPDATE writeback.", "SYNAPSOR_DATABASE_WRITE_URL="] : []),
    `${tenantBinding?.key ?? "SYNAPSOR_TENANT_ID"}=acme`,
    `${principalBinding?.key ?? "SYNAPSOR_PRINCIPAL"}=local_operator`,
    "",
  ].join("\n");
}


function bundleReadme(contract: SynapsorContract): string {
  const contractName = contract.metadata?.name ?? "Synapsor contract";
  return [
    `# ${contractName} Runner Bundle`,
    "",
    "This bundle lets you run a Cloud/exported Synapsor contract locally with Synapsor Runner.",
    "",
    "It includes:",
    "",
    "- `synapsor.contract.json`: canonical Synapsor contract;",
    "- `synapsor.runner.json`: local runtime wiring with env-var placeholders;",
    "- `.env.example`: placeholder runtime values only;",
    "- `mcp-client-examples/`: client snippets with command paths only.",
    "",
    "It does not include database passwords, write credentials, bearer tokens, or table rows.",
    "",
    "## Run Locally",
    "",
    "```bash",
    "cp .env.example .env",
    "# edit .env, then export the values in your shell",
    "set -a && . ./.env && set +a",
    "npx -y @synapsor/runner contract validate ./synapsor.contract.json",
    "npx -y @synapsor/runner config validate --config ./synapsor.runner.json",
    "npx -y @synapsor/runner tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db",
    "npx -y @synapsor/runner mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db",
    "```",
    "",
    "Approval and apply remain outside the model-facing MCP catalog. Inspect local history with:",
    "",
    "```bash",
    "npx -y @synapsor/runner replay show latest --store ./.synapsor/local.db",
    "npx -y @synapsor/runner cloud push ./synapsor.contract.json --dry-run",
    "```",
    "",
  ].join("\n");
}


function bundleMcpClientExamples(): Record<string, string> {
  const packageArgs = ["-y", "@synapsor/runner"];
  const stdioArgs = [...packageArgs, "mcp", "serve", "--config", "./synapsor.runner.json", "--store", "./.synapsor/local.db"];
  const server = { command: "npx", args: stdioArgs };
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  return {
    "claude-desktop.json": json({ mcpServers: { "synapsor-runner": server } }),
    "cursor-project.mcp.json": json({ mcpServers: { "synapsor-runner": { type: "stdio", ...server } } }),
    "cursor-global.mcp.json": json({
      mcpServers: {
        "synapsor-runner": {
          type: "stdio",
          command: "npx",
          args: [...packageArgs, "mcp", "serve", "--config", "<absolute-path-to-bundle>/synapsor.runner.json", "--store", "<absolute-path-to-bundle>/.synapsor/local.db"],
        },
      },
    }),
    "generic-stdio.json": json({ name: "synapsor-runner", transport: "stdio", ...server }),
    "generic-streamable-http.json": json({
      name: "synapsor-runner",
      transport: "streamable-http",
      url: "http://127.0.0.1:8766/mcp",
      headers_from_env: { Authorization: "Bearer $SYNAPSOR_RUNNER_HTTP_TOKEN" },
    }),
    "openai-agents-stdio.ts": `import { Agent, MCPServerStdio, run } from "@openai/agents";\n\nconst synapsor = new MCPServerStdio({\n  name: "Synapsor Runner",\n  fullCommand: "npx -y @synapsor/runner mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db --alias-mode openai",\n});\nawait synapsor.connect();\ntry {\n  const agent = new Agent({ name: "Reviewed database agent", instructions: "Use only Synapsor business tools. Inspect evidence before proposing a change.", mcpServers: [synapsor] });\n  console.log((await run(agent, "Inspect the customer and propose a safe next action.")).finalOutput);\n} finally {\n  await synapsor.close();\n}\n`,
    "openai-agents-streamable-http.ts": `import { Agent, MCPServerStreamableHttp, run } from "@openai/agents";\n\n// Start Runner separately with: synapsor-runner mcp serve --transport streamable-http --alias-mode openai --config ./synapsor.runner.json --store ./.synapsor/local.db\nconst token = process.env.SYNAPSOR_RUNNER_HTTP_TOKEN;\nif (!token) throw new Error("set SYNAPSOR_RUNNER_HTTP_TOKEN in the launching environment");\nconst synapsor = new MCPServerStreamableHttp({\n  name: "Synapsor Runner",\n  url: "http://127.0.0.1:8766/mcp",\n  requestInit: { headers: { Authorization: \`Bearer \${token}\` } },\n});\nawait synapsor.connect();\ntry {\n  const agent = new Agent({ name: "Reviewed database agent", instructions: "Use only Synapsor business tools. Inspect evidence before proposing a change.", mcpServers: [synapsor] });\n  console.log((await run(agent, "Inspect the customer and propose a safe next action.")).finalOutput);\n} finally {\n  await synapsor.close();\n}\n`,
  };
}


export async function configValidate(args: string[]): Promise<number> {
  const configPath = runnerConfigPath(args);
  const result = await validateConfigFile(configPath);
  const payload = {
    ...result,
    config_path: path.resolve(configPath),
    state_preserved: true,
    source_database_changed: false,
    ...(result.ok ? {} : {
      next_action: `Correct the reported field, then run ${cliCommandName()} config validate --config ${shellQuote(configPath)} --json.`,
    }),
  };
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`config valid: ${configPath}\n`);
    for (const warning of result.warnings) {
      process.stdout.write(`warning ${warning.path} ${warning.code}: ${warning.message}\n`);
    }
  } else {
    process.stdout.write(`config invalid: ${configPath}\n`);
    for (const error of result.errors) {
      process.stdout.write(`error ${error.path} ${error.code}: ${error.message}\n`);
    }
    process.stdout.write(`State preserved: ${configPath} and the source database were not changed.\n`);
    process.stdout.write(`Next: ${payload.next_action}\n`);
  }
  return result.ok ? 0 : 1;
}


export async function configShow(args: string[]): Promise<number> {
  const configPath = runnerConfigPath(args);
  const parsed = await readJsonFileWithLocation<unknown>(configPath, "Runner config");
  const output = args.includes("--redacted") ? redactConfig(parsed) : parsed;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return 0;
}


export async function configMigrate(args: string[]): Promise<number> {
  const configPath = runnerConfigPath(args);
  const outputPath = outputArg(args);
  const write = args.includes("--write") || Boolean(outputPath);
  const parsed = await readJsonFileWithLocation<Record<string, unknown>>(configPath, "Runner config");
  const version = Number((parsed as { version?: unknown }).version ?? 1);
  if (version !== 1) {
    throw new Error(`unsupported config version ${String((parsed as { version?: unknown }).version)}; no automatic widening migration is available`);
  }
  const validation = validateRunnerCapabilityConfig(parsed);
  if (!validation.ok) {
    throw new Error(`cannot migrate invalid config: ${validation.errors.map((error) => `${error.path} ${error.code}`).join("; ")}`);
  }
  const normalized = normalizeConfigForMigration(parsed);
  if (!write) {
    process.stdout.write(`config already current: version ${version}\n`);
    process.stdout.write("No file written. Use --output <path> or --write --yes to write a normalized copy.\n");
    return 0;
  }
  const destination = outputPath ? path.resolve(outputPath) : path.resolve(configPath);
  process.stderr.write(`Destination: ${destination}\n`);
  if (!outputPath) {
    process.stderr.write("Existing config will be backed up before writing.\n");
  }
  await confirmDangerousAction(args.includes("--yes") ? ["--yes"] : [], "Write migrated config?");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (!outputPath) {
    const backupPath = `${destination}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await fs.copyFile(path.resolve(configPath), backupPath);
    process.stderr.write(`Backup: ${backupPath}\n`);
  }
  await fs.writeFile(destination, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  process.stdout.write(`wrote migrated config: ${destination}\n`);
  return 0;
}


function normalizeConfigForMigration(config: unknown): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  clone.version = 1;
  return clone;
}
