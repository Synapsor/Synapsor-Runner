import { CloudLinkedSynchronizer, bindPostgresTrustedScope, capabilityWritebackMode, createDefaultRuntimeStore, describeIsolationAssurance, preflightGeneratedAuthority, type RuntimeCapabilityConfig, type RuntimeConfig, type SourceIsolationAssurance } from "@synapsor-runner/mcp-server";
import { createPostgresPool, inspectPostgresRlsTarget, type PostgresRlsOperation } from "@synapsor-runner/postgres";
import {
  ProposalStore
} from "@synapsor-runner/proposal-store";
import {
  type RunnerConfig
} from "@synapsor-runner/worker-core";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { cliCommandName } from "./cli-command-meta.js";
import { fileExists } from "./cli-files.js";
import { formatScalar, isRecord, safeErrorMessage, stableStringArray } from "./cli-format.js";
import { envValue, optionalArg, outputArg } from "./cli-options.js";
import { readRuntimeConfig, resolvedLocalStorePath, runnerConfigPath } from "./cli-project.js";
import { RunnerCapabilityConfig, RunnerSourceConfig, adapters, dynamicImportModule } from "./cli-runtime.js";
import { validateConfigFile } from "./config-domain.js";
import { DoctorCheck, LocalDoctorGovernance, LocalDoctorReport, envPresenceCheck, formatLocalDoctorMarkdown, formatLocalDoctorReport, httpHandlerReachabilityCheck, inspectConfiguredSource, localToolNames, proposalApprovalPolicyResolutionDoctorCheck, proposalConflictGuardDoctorCheck, proposalReversibilityDoctorCheck, proposalWritebackResolutionDoctorCheck, sharedPostgresLedgerDoctorChecks, trustedContextsForDoctor } from "./doctor-domain.js";
import {
  managedMcpProjectDefinition,
  managedMcpProjectStatus,
  parseManagedMcpProjectClient,
  type ManagedMcpProjectClient
} from "./managed-mcp-project.js";
import { fetchStdioMcpToolsCommand, mcpAuditToolNames } from "./mcp-audit.js";
import { isManagedAuthoringEntry } from "./mcp-project-domain.js";
import { trustedCliContext } from "./operator-authority.js";
import { capabilityOperation, formatSourceReceiptMode, receiptTableGuidance, runnerReceiptConfig, sourceNeedsSqlWriteback, writebackTimeoutMs } from "./writeback-domain.js";


export async function localDoctor(args: string[]): Promise<number> {
  const configPath = runnerConfigPath(args);
  const allowSharedCredential = args.includes("--allow-shared-credential");
  const checkHandlers = args.includes("--check-handlers");
  const checkWriteback = args.includes("--check-writeback") || args.includes("--check-db");
  const checkRls = args.includes("--check-rls");
  const rawConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as RuntimeConfig;
  let parsed = rawConfig;
  const checks: DoctorCheck[] = [];
  const validation = await validateConfigFile(configPath);
  checks.push({
    name: "config-valid",
    ok: validation.ok,
    level: validation.ok ? "pass" : "fail",
    message: validation.ok ? "Config parses and validates." : validation.errors.map((error) => `${error.path} ${error.code}`).join("; "),
  });
  for (const warning of validation.warnings) {
    checks.push({ name: `config-warning:${warning.code}`, ok: true, level: "warn", message: warning.message });
  }
  if (validation.ok) {
    parsed = await readRuntimeConfig(configPath);
  }
  if ((parsed.capabilities ?? []).some((capability) => capability.protected_read)) {
    try {
      await preflightGeneratedAuthority(parsed, process.env);
      checks.push({
        name: "generated-authority:current",
        ok: true,
        level: "pass",
        message: "Generated protected authority matches its exact lock, current schema, database role, grants, ownership, and RLS posture.",
      });
    } catch (error) {
      checks.push({
        name: "generated-authority:current",
        ok: false,
        level: "fail",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  checks.push(...await sharedPostgresLedgerDoctorChecks(parsed));
  checks.push(...graduatedTrustDoctorChecks(parsed));
  const governance = await cloudLinkedGovernanceDoctorStatus(parsed, args, checks);
  const isolation = describeIsolationAssurance(parsed);

  const contextsToCheck = trustedContextsForDoctor(parsed);
  for (const context of contextsToCheck) {
    if (context.provider === "http_claims") {
      checks.push({
        name: `trusted-context:${context.name}`,
        ok: Boolean(parsed.session_auth),
        level: parsed.session_auth ? "pass" : "fail",
        message: parsed.session_auth
          ? `${context.name} binds tenant/principal from verified signed HTTP session claims; arbitrary headers, query parameters, MCP metadata, and model arguments are not trusted.`
          : `${context.name} uses http_claims but session_auth is missing.`,
      });
      continue;
    }
    if (context.provider === "cloud_session") {
      checks.push({
        name: `trusted-context:${context.name}`,
        ok: parsed.mode === "cloud",
        level: parsed.mode === "cloud" ? "pass" : "fail",
        message: parsed.mode === "cloud"
          ? `${context.name} requires a verified Cloud session binding from the embedding control plane.`
          : `${context.name} cannot be resolved by the stock local server; use a verified Cloud-session embedding.`,
      });
      continue;
    }
    const tenantEnv = String(context.values.tenant_id_env ?? "SYNAPSOR_TENANT_ID");
    const principalEnv = String(context.values.principal_env ?? "SYNAPSOR_PRINCIPAL");
    for (const envName of [tenantEnv, ...(context.principal_required ? [principalEnv] : [])]) {
      checks.push(envPresenceCheck(envName, `${envName} is required for trusted context ${context.name}.`));
    }
  }
  checks.push(...await httpSecurityDoctorChecks(parsed, args));
  checks.push(...await sessionAuthDoctorChecks(parsed, configPath));

  const sources = parsed.sources ?? {};
  if (parsed.mode === "review") {
    for (const capability of (parsed.capabilities ?? []).filter((item) => item.kind === "proposal")) {
      checks.push(proposalWritebackResolutionDoctorCheck(parsed, capability));
      checks.push(proposalApprovalPolicyResolutionDoctorCheck(parsed, capability));
      const conflictGuardCheck = proposalConflictGuardDoctorCheck(capability);
      if (conflictGuardCheck) checks.push(conflictGuardCheck);
      if (capabilityWritebackMode(capability) === "direct_sql") checks.push(proposalReversibilityDoctorCheck(capability));
      if (capability.operation?.cardinality === "set") {
        const selection = capability.operation.selection?.all
          .map((term) => `${term.column} ${term.operator} ${formatScalar(term.value)}`)
          .join(" AND ") || "exact reviewed batch items";
        const bounds = capability.operation.aggregate_bounds
          ?.map((bound) => `${bound.measure}(${bound.column}) <= ${bound.maximum}`)
          .join("; ") || "missing";
        checks.push({
          name: `capability:${capability.name}:bounded-set-authority`,
          ok: true,
          level: "pass",
          message: `Bounded-set ${capabilityOperation(capability).toUpperCase()}: fixed selection ${selection}; max rows ${capability.operation.max_rows}; aggregate bounds ${bounds}; human/operator approval required.`,
        });
      }
    }
  }
  for (const [sourceName, source] of Object.entries(sources)) {
    const assurance = isolation.find((item) => item.source === sourceName);
    if (assurance) checks.push(databaseScopeModeDoctorCheck(assurance));
    if (source.credential_scope?.mode === "tenant_resolver") {
      checks.push({
        name: `source:${sourceName}:tenant-credential-resolver`,
        ok: false,
        level: "fail",
        message: `Source requires tenant credential resolver ${source.credential_scope.resolver}. The stock CLI does not load executable resolver code; provide the matching TenantCredentialResolver through the embedding API, or use one tenant-bound Runner process with shared credentials.`,
      });
    }
    if (parsed.mode === "review" && sourceNeedsSqlWriteback(parsed, sourceName)) {
      checks.push(sourceReceiptModeDoctorCheck(parsed, sourceName, source));
    }
    checks.push(envPresenceCheck(source.read_url_env, `${source.read_url_env} is required for ${sourceName} reads.`));
    if (parsed.mode === "review") {
      if (sourceNeedsSqlWriteback(parsed, sourceName)) {
        if (source.write_url_env) {
          checks.push(envPresenceCheck(source.write_url_env, `${source.write_url_env} is required for trusted writeback in review mode.`));
          const readValue = envValue(process.env, source.read_url_env);
          const writeValue = envValue(process.env, source.write_url_env);
          if (readValue && writeValue && readValue === writeValue) {
            checks.push({
              name: `source:${sourceName}:credential-separation`,
              ok: allowSharedCredential,
              level: allowSharedCredential ? "warn" : "fail",
              message: allowSharedCredential
                ? "Read and write URL env vars currently resolve to the same value; accepted only because --allow-shared-credential was provided."
                : "Read and write URL env vars resolve to the same value. Use separate credentials or rerun with --allow-shared-credential for local testing.",
            });
          } else if (readValue && writeValue) {
            checks.push({ name: `source:${sourceName}:credential-separation`, ok: true, level: "pass", message: "Read and write URL env vars are distinct." });
          }
        } else {
          checks.push({ name: `source:${sourceName}:write-url-env`, ok: false, level: "fail", message: "SQL writeback proposal capabilities require write_url_env for trusted writeback." });
        }
        const writeUrl = source.write_url_env ? envValue(process.env, source.write_url_env) : undefined;
        if (checkWriteback && writeUrl) {
          checks.push(...await directSqlWritebackDoctorChecks(parsed, sourceName, source, writeUrl));
        } else if (checkWriteback) {
          checks.push({
            name: `source:${sourceName}:writeback-probe`,
            ok: false,
            level: "fail",
            message: "Direct SQL writeback probe skipped because the writer env var is missing.",
          });
        } else {
          checks.push({
            name: `source:${sourceName}:writeback-probe`,
            ok: true,
            level: "warn",
            message: `Direct SQL writeback was not probed. Rerun doctor with --check-writeback to verify writer connectivity, receipt-table permissions, and rollback-only target-table access.`,
          });
        }
      }
    }
    await inspectConfiguredSource({ config: parsed, sourceName, source, checks });
    if (source.database_scope?.mode === "postgres_rls") {
      checks.push(...await postgresRlsDoctorChecks({
        config: parsed,
        sourceName,
        source,
        checkCanary: checkRls,
      }));
    }
  }

  for (const [executorName, executor] of Object.entries(parsed.executors ?? {})) {
    if (!isRecord(executor)) continue;
    if (executor.type === "http_handler") {
      const urlEnv = String(executor.url_env ?? "");
      if (urlEnv) {
        checks.push(envPresenceCheck(urlEnv, `${urlEnv} is required for http_handler executor ${executorName}.`));
        const handlerUrl = envValue(process.env, urlEnv);
        if (checkHandlers && handlerUrl) {
          checks.push(await httpHandlerReachabilityCheck(executorName, handlerUrl, Number(executor.timeout_ms ?? 3000)));
        } else if (!checkHandlers) {
          checks.push({
            name: `executor:${executorName}:handler-reachability`,
            ok: true,
            level: "warn",
            message: `Handler reachability was not probed for ${executorName}. Rerun doctor with --check-handlers to verify the network path without applying a proposal.`,
          });
        }
      }
      const auth = isRecord(executor.auth) ? executor.auth : undefined;
      const tokenEnv = typeof auth?.token_env === "string" ? auth.token_env : undefined;
      if (tokenEnv) checks.push(envPresenceCheck(tokenEnv, `${tokenEnv} is required for http_handler executor ${executorName} bearer auth.`));
      const signingSecretEnv = typeof executor.signing_secret_env === "string" ? executor.signing_secret_env : undefined;
      if (signingSecretEnv) {
        checks.push(envPresenceCheck(signingSecretEnv, `${signingSecretEnv} is required to sign http_handler requests for executor ${executorName}.`));
      } else {
        checks.push({
          name: `executor:${executorName}:handler-signing`,
          ok: true,
          level: "warn",
          message: `No signing_secret_env is configured for http_handler executor ${executorName}. HMAC signing is recommended unless the handler is loopback-only and protected by another trusted boundary.`,
        });
      }
    }
    if (executor.type === "command_handler") {
      const commandEnv = String(executor.command_env ?? "");
      if (commandEnv) checks.push(envPresenceCheck(commandEnv, `${commandEnv} is required for command_handler executor ${executorName}.`));
    }
  }

  const tools = await localToolNames(parsed, checks);
  const forbiddenTools = tools.filter((tool) => /execute_sql|run_query|approve|commit|apply_writeback/i.test(tool));
  checks.push({
    name: "mcp-tool-boundary",
    ok: forbiddenTools.length === 0,
    level: forbiddenTools.length === 0 ? "pass" : "fail",
    message: forbiddenTools.length === 0 ? "MCP tool catalog is semantic-only." : `Forbidden model-facing tools: ${forbiddenTools.join(", ")}`,
  });
  checks.push(...await managedMcpProjectDoctorChecks(configPath, tools, args));

  const report: LocalDoctorReport = {
    ok: checks.every((check) => check.level !== "fail"),
    mode: String(parsed.mode),
    config_path: configPath,
    checks,
    tools,
    governance,
    isolation,
    store_stats: await localDoctorStoreStats(optionalArg(args, "--store") ?? parsed.storage?.sqlite_path),
  };
  if (args.includes("--report")) {
    const output = outputArg(args) ?? "synapsor-doctor.md";
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, formatLocalDoctorMarkdown(report), "utf8");
    process.stdout.write(`wrote redacted doctor report: ${output}\n`);
  } else if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatLocalDoctorReport(report));
  }
  return report.ok ? 0 : 1;
}


async function managedMcpProjectDoctorChecks(configPath: string, expectedTools: string[], args: string[]): Promise<DoctorCheck[]> {
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? path.dirname(path.resolve(configPath)));
  const clients: ManagedMcpProjectClient[] = ["cursor", "claude-code", "vscode"];
  const requestedLaunch = args.includes("--check-cursor")
    ? "cursor"
    : optionalArg(args, "--check-mcp-client");
  const launchClient = requestedLaunch === undefined
    ? undefined
    : parseManagedMcpProjectClient(requestedLaunch);
  const statuses = await Promise.all(clients.map(async (client) => ({
    client,
    definition: managedMcpProjectDefinition(client),
    status: await managedMcpProjectStatus(client, projectRoot),
  })));
  const relevant = statuses.filter(({ status, client }) =>
    status.state !== "not_installed" || client === launchClient);
  if (relevant.length === 0) {
    return [{
      name: "mcp-project:installation",
      ok: true,
      level: "warn",
      message: `No Runner-owned project MCP entry is installed. Preview one with ${cliCommandName()} mcp install <cursor|claude-code|vscode> --project --project-root ${projectRoot} --dry-run.`,
    }];
  }

  const checks: DoctorCheck[] = [];
  for (const { client, definition, status } of relevant) {
    const prefix = `${client}-project`;
    try {
      if (status.state === "not_installed") {
        checks.push({
          name: `${prefix}:installation`,
          ok: false,
          level: "fail",
          message: `No Runner-owned ${definition.displayName} project entry is installed, so the requested launch check cannot run.`,
        });
        continue;
      }
      if (status.state !== "installed") {
        checks.push({
          name: `${prefix}:installation`,
          ok: false,
          level: "fail",
          message: status.message,
        });
        continue;
      }
      const authoring = isManagedAuthoringEntry(status.entry);
      const authoringTools = ["app.describe_data", "app.explore_data"];
      const reviewedTools = authoring ? authoringTools : expectedTools;
      const recordedConfig = path.resolve(projectRoot, status.paths.configArgument);
      const configMatches = recordedConfig === path.resolve(configPath);
      checks.push({
        name: `${prefix}:installation`,
        ok: authoring || configMatches,
        level: authoring || configMatches ? "pass" : "fail",
        message: authoring
          ? `Runner owns an intact local authoring ${definition.displayName} entry; it does not depend on a production Runner config.`
          : configMatches
            ? `Runner owns an intact ${definition.displayName} project entry for ${status.paths.configArgument}.`
            : `${definition.displayName} entry points to ${status.paths.configArgument}, but doctor inspected ${path.resolve(configPath)}.`,
      }, {
        name: `${prefix}:model-tools`,
        ok: reviewedTools.length > 0,
        level: reviewedTools.length > 0 ? "pass" : "fail",
        message: authoring
          ? `Authoring tools: ${authoringTools.join(", ")}. Scoped Explore remains local development/staging only; activation, approval, apply, revert, credentials, and trusted identity remain outside MCP.`
          : `Reviewed model-facing tools: ${expectedTools.join(", ") || "none"}. Approval, apply, revert, policy, credentials, and trusted identity remain outside MCP.`,
      });
      if (launchClient !== client) {
        checks.push({
          name: `${prefix}:launch`,
          ok: true,
          level: "warn",
          message: `${definition.displayName} command was not launched. Rerun with --check-mcp-client ${client} to perform a real stdio initialize + tools/list handshake.`,
        });
        continue;
      }
      const entry = status.entry;
      const command = typeof entry?.command === "string" ? entry.command : "";
      const commandArgs = Array.isArray(entry?.args) && entry.args.every((value) => typeof value === "string") ? entry.args as string[] : [];
      if (!command) {
        checks.push({ name: `${prefix}:launch`, ok: false, level: "fail", message: `${definition.displayName} Synapsor entry has no valid command.` });
        continue;
      }
      const timeoutMs = Number(optionalArg(args, "--timeout-ms") ?? "10000");
      if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error("--timeout-ms must be an integer from 100 to 120000");
      const response = await fetchStdioMcpToolsCommand(command, commandArgs, timeoutMs, projectRoot);
      const liveTools = mcpAuditToolNames(response);
      const matches = stableStringArray(liveTools).join("\n") === stableStringArray(reviewedTools).join("\n");
      checks.push({
        name: `${prefix}:launch`,
        ok: matches,
        level: matches ? "pass" : "fail",
        message: matches
          ? `Configured ${definition.displayName} command started and exposed exactly ${liveTools.length} reviewed tool(s).`
          : `Configured command exposed ${liveTools.join(", ") || "no tools"}; expected ${reviewedTools.join(", ") || "no tools"}.`,
      });
    } catch (error) {
      checks.push({
        name: `${prefix}:installation`,
        ok: false,
        level: "fail",
        message: `${definition.displayName} project verification failed: ${safeErrorMessage(error)}`,
      });
    }
  }
  return checks;
}


async function httpSecurityDoctorChecks(config: RuntimeConfig, args: string[]): Promise<DoctorCheck[]> {
  const requestedTransport = optionalArg(args, "--transport") ?? "stdio";
  if (requestedTransport === "stdio") {
    return [{
      name: "http-security:transport",
      ok: true,
      level: "pass",
      message: "Transport is stdio: Runner opens no network listener, and the launching MCP client supplies the process environment. HTTP Bearer, TLS, CORS, and MCP HTTP sessions do not apply.",
    }];
  }
  if (!new Set(["streamable-http", "http", "json-rpc-http", "jsonrpc-http"]).has(requestedTransport)) {
    return [{
      name: "http-security:transport",
      ok: false,
      level: "fail",
      message: `Unknown network transport ${requestedTransport}. Fix: use --transport streamable-http (recommended) or --transport http for the legacy JSON-RPC bridge.`,
    }];
  }

  const security = config.http_security;
  const host = optionalArg(args, "--host") ?? "127.0.0.1";
  const loopback = isDoctorLoopbackHost(host);
  const deployment = security?.deployment ?? (loopback ? "loopback" : undefined);
  const usesClaims = trustedContextsForDoctor(config).some((context) => context.provider === "http_claims");
  const tlsCertEnv = optionalArg(args, "--tls-cert-env");
  const tlsKeyEnv = optionalArg(args, "--tls-key-env");
  const tlsCaEnv = optionalArg(args, "--tls-ca-env");
  const cliDirectTls = Boolean(tlsCertEnv || tlsKeyEnv || tlsCaEnv || args.includes("--require-client-cert"));
  const channel = cliDirectTls
    ? "direct_tls"
    : args.includes("--trusted-tls-proxy")
      ? "trusted_tls_proxy"
      : args.includes("--unsafe-allow-cleartext-http")
        ? "insecure_http_break_glass"
        : security?.channel ?? (loopback ? "loopback_cleartext" : undefined);
  const checks: DoctorCheck[] = [{
    name: "http-security:transport",
    ok: true,
    level: "pass",
    message: `${requestedTransport} will bind ${host}; bind scope is ${loopback ? "loopback-only" : "non-loopback"}.`,
  }];

  checks.push({
    name: "http-security:deployment",
    ok: Boolean(deployment) && !(deployment === "loopback" && !loopback),
    level: !deployment || (deployment === "loopback" && !loopback) ? "fail" : "pass",
    message: !deployment
      ? "Non-loopback HTTP has no explicit deployment profile. Fix: set http_security.deployment to single_tenant or shared."
      : deployment === "loopback" && !loopback
        ? "The loopback deployment profile cannot bind a non-loopback host. Fix: bind 127.0.0.1 or select and secure a single_tenant/shared profile."
        : `Deployment profile is ${deployment}.`,
  });

  if (!channel) {
    checks.push({
      name: "http-security:channel",
      ok: false,
      level: "fail",
      message: "Remote cleartext HTTP is refused. Fix: supply Runner TLS env references, declare a trusted TLS proxy/private hop, or use the explicitly unsafe authenticated cleartext break-glass flag only for emergency diagnostics.",
    });
  } else if (channel === "direct_tls") {
    const certReady = Boolean(tlsCertEnv && envValue(process.env, tlsCertEnv));
    const keyReady = Boolean(tlsKeyEnv && envValue(process.env, tlsKeyEnv));
    checks.push({
      name: "http-security:channel",
      ok: certReady && keyReady,
      level: certReady && keyReady ? "pass" : "fail",
      message: certReady && keyReady
        ? `Channel is Runner-owned TLS; certificate and private key are loaded from ${tlsCertEnv} and ${tlsKeyEnv} without printing their values.`
        : "Channel is direct TLS but runtime certificate/key env references are not both ready. Fix: pass --tls-cert-env <ENV> --tls-key-env <ENV> with protected PEM values.",
    });
    if (args.includes("--require-client-cert")) {
      const caReady = Boolean(tlsCaEnv && envValue(process.env, tlsCaEnv));
      checks.push({
        name: "http-security:mtls",
        ok: caReady,
        level: caReady ? "pass" : "fail",
        message: caReady
          ? `mTLS client certificates supplement Bearer authentication; trusted client CA is loaded from ${tlsCaEnv}.`
          : "mTLS requires a trusted client CA. Fix: pass --tls-ca-env <ENV> with --require-client-cert.",
      });
    }
  } else if (channel === "trusted_tls_proxy") {
    checks.push({
      name: "http-security:channel",
      ok: true,
      level: "warn",
      message: "Channel trusts an external TLS-terminating proxy. Fix/verify: firewall Runner from direct client access, protect the proxy-to-Runner hop, preserve the original Host, and never use forwarded tenant/principal headers as identity.",
    });
  } else if (channel === "insecure_http_break_glass") {
    checks.push({
      name: "http-security:channel",
      ok: true,
      level: "warn",
      message: "SECURITY WARNING: authenticated Bearer traffic will cross non-loopback cleartext HTTP. Fix: replace break-glass with Runner-owned TLS or an explicitly trusted TLS proxy immediately.",
    });
  } else {
    checks.push({
      name: "http-security:channel",
      ok: loopback,
      level: loopback ? "pass" : "fail",
      message: loopback
        ? "Channel is loopback cleartext; endpoint authentication is still required by default."
        : "Non-loopback cleartext HTTP is not an accepted normal channel. Fix: configure direct TLS or a trusted TLS proxy.",
    });
  }

  const devNoAuth = args.includes("--dev-no-auth");
  if (devNoAuth) {
    checks.push({
      name: "http-security:authentication",
      ok: loopback && deployment === "loopback" && channel !== "insecure_http_break_glass",
      level: loopback && deployment === "loopback" && channel !== "insecure_http_break_glass" ? "warn" : "fail",
      message: loopback && deployment === "loopback" && channel !== "insecure_http_break_glass"
        ? "Authentication is explicitly disabled for loopback development only. Fix before sharing: remove --dev-no-auth and provision an endpoint token."
        : "No-auth is forbidden for this bind/profile. Fix: remove --dev-no-auth and configure endpoint or signed-session authentication.",
    });
  } else if (usesClaims) {
    const auth = config.session_auth;
    const resource = security?.oauth_resource?.resource;
    const issuer = auth?.issuer;
    const audience = auth?.audience;
    const sharedReady = deployment === "shared" && Boolean(auth && issuer && audience && resource && audience === resource);
    checks.push({
      name: "http-security:authentication",
      ok: loopback ? Boolean(auth) : sharedReady,
      level: loopback ? auth ? "pass" : "fail" : sharedReady ? "pass" : "fail",
      message: sharedReady
        ? `Authentication is verified per-session ${auth?.provider}; issuer ${issuer}, audience/resource ${audience}, and trusted tenant/principal claims are checked on every request.`
        : loopback && auth
          ? `Loopback claims authentication uses ${auth.provider}; for a shared deployment add exact issuer/audience plus RFC 9728 oauth_resource metadata.`
          : "Shared HTTP identity is incomplete. Fix: use http_claims plus signed session_auth, exact issuer/audience, and matching http_security.oauth_resource metadata.",
    });
    if (security?.oauth_resource) {
      checks.push({
        name: "http-security:oauth-resource",
        ok: Boolean(resource && security.oauth_resource.authorization_servers.length > 0),
        level: resource && security.oauth_resource.authorization_servers.length > 0 ? "pass" : "fail",
        message: `Protected resource metadata advertises ${resource ?? "no resource"}; required scopes: ${security.oauth_resource.required_scopes?.join(", ") || "none"}. Runner verifies tokens but does not issue or refresh them.`,
      });
    }
  } else {
    const activeEnv = optionalArg(args, "--auth-token-env") ?? security?.static_token?.active_env ?? "SYNAPSOR_RUNNER_HTTP_TOKEN";
    const previousEnv = optionalArg(args, "--previous-auth-token-env") ?? security?.static_token?.previous_env;
    const active = envValue(process.env, activeEnv);
    const previous = previousEnv ? envValue(process.env, previousEnv) : undefined;
    const strong = Boolean(active && isStrongEndpointTokenForDoctor(active));
    const strengthOk = loopback ? Boolean(active) : strong;
    checks.push({
      name: "http-security:authentication",
      ok: strengthOk,
      level: !active || (!loopback && !strong) ? "fail" : strong ? "pass" : "warn",
      message: !active
        ? `Opaque endpoint token env ${activeEnv} is missing. Fix: generate at least 32 random bytes and provision the same value out of band to Runner and the authorized client.`
        : strong
          ? `Opaque endpoint token is present in ${activeEnv} with production-strength shape; it is shared service access, not tenant/user identity.`
          : `Opaque endpoint token in ${activeEnv} is accepted only as weak loopback development input. Fix: replace it with at least 32 random bytes.`,
    });
    if (previousEnv) {
      checks.push({
        name: "http-security:static-token-rotation",
        ok: Boolean(previous && active && previous !== active && isStrongEndpointTokenForDoctor(previous)),
        level: previous && active && previous !== active && isStrongEndpointTokenForDoctor(previous) ? "pass" : "fail",
        message: previous && active && previous !== active && isStrongEndpointTokenForDoctor(previous)
          ? `One previous endpoint token is temporarily accepted from ${previousEnv}; remove it after the bounded client-rotation window.`
          : `Previous-token rotation env ${previousEnv} is missing, weak, or duplicates the active credential. Fix the env or remove previous_env after rotation.`,
      });
    }
  }

  const origins = security?.allowed_origins ?? [];
  checks.push({
    name: "http-security:origin-cors",
    ok: !origins.includes("*"),
    level: origins.includes("*") ? "fail" : "pass",
    message: origins.length === 0
      ? "Browser CORS is disabled; native MCP clients may omit Origin."
      : `Only exact reviewed browser origins are accepted: ${origins.join(", ")}. Wildcard CORS is forbidden.`,
  });
  const hosts = security?.allowed_hosts ?? (loopback ? ["localhost", "127.0.0.1", "[::1]"] : []);
  checks.push({
    name: "http-security:host-policy",
    ok: hosts.length > 0,
    level: hosts.length > 0 ? "pass" : "fail",
    message: hosts.length > 0
      ? `Host validation allowlist: ${hosts.join(", ")}. Forwarded Host is not identity authority.`
      : "No exact Host allowlist is configured for a non-loopback listener. Fix: set http_security.allowed_hosts to the externally used authority names.",
  });
  const limits = security?.limits;
  checks.push({
    name: "http-security:limits",
    ok: true,
    level: "pass",
    message: `HTTP bounds: request ${limits?.max_request_bytes ?? 1_048_576} bytes; headers ${limits?.max_header_bytes ?? 16_384} bytes; sessions ${limits?.max_sessions ?? 1_024}; idle ${limits?.session_idle_timeout_seconds ?? 900}s; connections ${limits?.max_connections ?? 2_048}.`,
  });
  const fleetRateScope = config.storage?.shared_postgres?.mode === "runtime_store" ? "shared runtime store (fleet-wide)" : "this Runner process only";
  checks.push({
    name: "http-security:rate-limit-scope",
    ok: true,
    level: config.rate_limits?.enabled && fleetRateScope.includes("process") ? "warn" : "pass",
    message: `Operational rate limits are ${config.rate_limits?.enabled ? "enabled" : "not configured"}; accounting scope is ${fleetRateScope}.`,
  });
  return checks;
}


function isDoctorLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}


function isStrongEndpointTokenForDoctor(value: string): boolean {
  return Buffer.byteLength(value, "utf8") >= 32
    && new Set(value).size >= 12
    && !/^(.)\1+$/.test(value)
    && !/(?:password|secret|token|changeme|example|development)/i.test(value);
}


async function sessionAuthDoctorChecks(config: RuntimeConfig, configPath: string): Promise<DoctorCheck[]> {
  if (!trustedContextsForDoctor(config).some((context) => context.provider === "http_claims")) return [];
  const auth = config.session_auth;
  if (!auth) {
    return [{
      name: "session-auth:configuration",
      ok: false,
      level: "fail",
      message: "http_claims trusted context requires signed session_auth.",
    }];
  }
  const checks: DoctorCheck[] = [{
    name: "session-auth:configuration",
    ok: true,
    level: auth.provider === "jwt_hs256" ? "warn" : "pass",
    message: auth.provider === "jwt_hs256"
      ? "Signed HS256 session claims are configured. Use asymmetric JWT verification for shared production deployments so Runner never holds the signing secret."
      : `Signed asymmetric session claims are configured with ${(auth.algorithms ?? []).join(", ")}.`,
  }];
  if (auth.provider === "jwt_hs256" && auth.secret_env) {
    checks.push(envPresenceCheck(auth.secret_env, `${auth.secret_env} is required to verify signed HTTP sessions.`));
    if (auth.previous_secret_env) {
      checks.push(envPresenceCheck(auth.previous_secret_env, `${auth.previous_secret_env} is configured for session-key rotation and must be present while accepted.`));
    }
    return checks;
  }
  if (auth.jwks_url_env) {
    checks.push(envPresenceCheck(auth.jwks_url_env, `${auth.jwks_url_env} is required to resolve the trusted session JWKS endpoint.`));
  }
  if (auth.public_key_env) {
    checks.push(envPresenceCheck(auth.public_key_env, `${auth.public_key_env} is required to verify signed HTTP sessions.`));
  }
  if (auth.public_key_path) {
    const keyPath = path.resolve(path.dirname(path.resolve(configPath)), auth.public_key_path);
    const exists = await fileExists(keyPath);
    checks.push({
      name: "session-auth:public-key-path",
      ok: exists,
      level: exists ? "pass" : "fail",
      message: exists
        ? "Configured session-auth public key file exists."
        : "Configured session-auth public key file does not exist relative to the Runner config.",
    });
  }
  return checks;
}


async function cloudLinkedGovernanceDoctorStatus(
  config: RuntimeConfig,
  args: string[],
  checks: DoctorCheck[],
): Promise<LocalDoctorGovernance> {
  if (config.governance?.mode !== "cloud_linked") {
    checks.push({ name: "governance:authority", ok: true, level: "pass", message: "Governance authority is local-only; no Synapsor Cloud account is required." });
    return { authority_mode: "local_only", evidence_residency: "metadata_only", queue_when_unavailable: false };
  }
  const storePath = resolvedLocalStorePath(args, config.storage?.sqlite_path);
  let store: ReturnType<typeof createDefaultRuntimeStore> | undefined;
  let synchronizer: CloudLinkedSynchronizer | undefined;
  try {
    store = createDefaultRuntimeStore(config, process.env, storePath);
    synchronizer = new CloudLinkedSynchronizer(config, store, process.env);
    const status = await synchronizer.status();
    checks.push({
      name: "governance:authority",
      ok: true,
      level: "pass",
      message: `Governance authority is Synapsor Cloud; local store ${storePath} is an operational spool/mirror and is never uploaded.`,
    });
    checks.push({
      name: "governance:evidence-residency",
      ok: true,
      level: "pass",
      message: "Evidence residency is metadata_only; source rows, SQL details, kept-out fields, credentials, and replay payloads remain local.",
    });
    const unhealthy = status.dead_letter > 0 || status.reconciliation_required > 0;
    const lagging = status.pending > 0 || status.leased > 0;
    checks.push({
      name: "governance:outbox",
      ok: !unhealthy,
      level: unhealthy ? "fail" : lagging ? "warn" : "pass",
      message: unhealthy
        ? `Cloud outbox needs operator attention: ${status.dead_letter} dead-letter and ${status.reconciliation_required} reconciliation-required event(s). Run ${cliCommandName()} cloud outbox inspect latest.`
        : lagging
          ? `Cloud outbox has ${status.pending} pending and ${status.leased} leased event(s); source writes remain blocked until Cloud governance completes.`
          : "Cloud outbox has no pending, leased, dead-letter, or reconciliation-required events.",
    });
    return { ...status, queue_when_unavailable: config.governance.queue_when_unavailable !== false };
  } catch (error) {
    const errorCode = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code ?? "CLOUD_LINKED_DOCTOR_FAILED") : "CLOUD_LINKED_DOCTOR_FAILED";
    checks.push({
      name: "governance:cloud-connection",
      ok: false,
      level: "fail",
      message: `Cloud-linked governance configuration could not be opened (${errorCode}). Check the reviewed connection file and Runner credential environment; no local approval fallback is allowed.`,
    });
    return {
      authority_mode: "cloud_linked",
      evidence_residency: "metadata_only",
      queue_when_unavailable: config.governance.queue_when_unavailable !== false,
      connection_error_code: errorCode,
    };
  } finally {
    await synchronizer?.stop();
    await store?.close();
  }
}


function graduatedTrustDoctorChecks(config: RuntimeConfig): DoctorCheck[] {
  const trust = config.graduated_trust;
  if (trust?.enabled !== true) {
    return [{
      name: "graduated-trust:mode",
      ok: true,
      level: "pass",
      message: "Graduated trust is disabled by default; Runner will not create policy recommendations.",
    }];
  }
  if (trust.kill_switch === true) {
    return [{
      name: "graduated-trust:kill-switch",
      ok: true,
      level: "warn",
      message: "Graduated-trust kill switch is active; no recommendations can be created.",
    }];
  }
  const checks: DoctorCheck[] = [{
    name: "graduated-trust:mode",
    ok: true,
    level: "pass",
    message: `Graduated trust is enabled for ${trust.criteria?.length ?? 0} reviewed criterion/criteria. It can recommend only; it cannot approve, export, push, or activate a contract automatically.`,
  }];
  const verifiedIdentity = config.operator_identity?.provider === "signed_key" || config.operator_identity?.provider === "jwt_oidc";
  checks.push({
    name: "graduated-trust:operator-identity",
    ok: verifiedIdentity,
    level: verifiedIdentity ? "pass" : "fail",
    message: verifiedIdentity
      ? `Policy recommendation decisions require configured ${config.operator_identity?.provider} operator identity.`
      : "Enabled graduated trust requires signed_key or jwt_oidc operator_identity before any recommendation can be approved or rejected.",
  });
  for (const criterion of trust.criteria ?? []) {
    const capability = (config.capabilities ?? []).find((item) => item.name === criterion.capability);
    const policy = (config.policies ?? []).find((item) => item.name === criterion.policy && item.kind === "approval");
    const rule = policy?.rules?.find((item) => item.field === criterion.field);
    const current = typeof rule?.max === "number" ? rule.max : undefined;
    const resolvable = capability?.kind === "proposal" && capability.approval?.mode === "policy" && capability.approval.policy === criterion.policy && current !== undefined;
    checks.push({
      name: `graduated-trust:${criterion.capability}:${criterion.policy}:${criterion.field}`,
      ok: resolvable,
      level: resolvable ? "pass" : "fail",
      message: resolvable
        ? `Reviewed threshold ${current}; minimum ${criterion.minimum_human_reviews} human reviews over ${criterion.window_days} days; increment <= ${criterion.maximum_threshold_increase}; ceiling ${criterion.absolute_ceiling}.`
        : `Criterion does not resolve to a policy-approved proposal capability and numeric approval rule for ${criterion.field}.`,
    });
  }
  return checks;
}


function databaseScopeModeDoctorCheck(assurance: SourceIsolationAssurance): DoctorCheck {
  if (assurance.mode === "tenant_bound") {
    return {
      name: `source:${assurance.source}:isolation-assurance`,
      ok: true,
      level: "pass",
      message: `Isolation mode tenant_bound uses ${assurance.credential_scope}; trusted context is ${assurance.trusted_context.request_binding}. ${assurance.remaining_trust_boundary}`,
    };
  }
  if (assurance.mode === "postgres_rls") {
    return {
      name: `source:${assurance.source}:isolation-assurance`,
      ok: true,
      level: "pass",
      message: `Isolation mode postgres_rls combines Runner predicates with database policy; trusted context is ${assurance.trusted_context.request_binding}. ${assurance.remaining_trust_boundary}`,
    };
  }
  return {
    name: `source:${assurance.source}:isolation-assurance`,
    ok: true,
    level: "warn",
    message: assurance.engine === "mysql"
      ? `Isolation mode application_scope uses Runner tenant/principal predicates with a shared MySQL credential; trusted context is ${assurance.trusted_context.request_binding}. MySQL has no PostgreSQL-equivalent native RLS; use tenant-bound credentials, restricted views/procedures, or isolated deployments.`
      : `Isolation mode application_scope uses Runner tenant/principal predicates with a shared credential; trusted context is ${assurance.trusted_context.request_binding}. ${assurance.warning ?? assurance.remaining_trust_boundary}`,
  };
}


async function postgresRlsDoctorChecks(input: {
  config: RuntimeConfig;
  sourceName: string;
  source: RunnerSourceConfig;
  checkCanary: boolean;
}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const scope = input.source.database_scope;
  if (scope?.mode !== "postgres_rls") return checks;
  const readUrl = envValue(process.env, input.source.read_url_env);
  const readCapabilities = (input.config.capabilities ?? []).filter((capability) => capability.source === input.sourceName);
  const readTargets = uniqueRlsTargets(readCapabilities.map((capability) => ({
    schema: capability.target.schema,
    table: capability.target.table,
    operations: ["SELECT"] as PostgresRlsOperation[],
  })));
  if (!readUrl) {
    checks.push({
      name: `source:${input.sourceName}:postgres-rls-reader`,
      ok: false,
      level: "fail",
      message: `Cannot inspect PostgreSQL RLS reader role because ${input.source.read_url_env} is missing.`,
    });
  } else {
    for (const target of readTargets) {
      checks.push(await inspectPostgresRlsDoctorTarget(input.sourceName, "reader", readUrl, scope, target));
    }
  }

  const writeCapabilities = directSqlProposalCapabilities(input.config, input.sourceName);
  const writeTargets = uniqueRlsTargets(writeCapabilities.map((capability) => ({
    schema: capability.target.schema,
    table: capability.target.table,
    operations: ["SELECT", capabilityOperation(capability).toUpperCase() as Exclude<PostgresRlsOperation, "SELECT">],
  })));
  if (writeTargets.length) {
    const writeUrl = input.source.write_url_env ? envValue(process.env, input.source.write_url_env) : undefined;
    if (!writeUrl) {
      checks.push({
        name: `source:${input.sourceName}:postgres-rls-writer`,
        ok: false,
        level: "fail",
        message: `Cannot inspect PostgreSQL RLS writer role because ${input.source.write_url_env ?? "write_url_env"} is missing.`,
      });
    } else {
      for (const target of writeTargets) {
        checks.push(await inspectPostgresRlsDoctorTarget(input.sourceName, "writer", writeUrl, scope, target));
      }
    }
  }

  if (!input.checkCanary) {
    checks.push({
      name: `source:${input.sourceName}:postgres-rls-live-canary`,
      ok: true,
      level: "warn",
      message: "Live cross-tenant/principal RLS canary was not run. On a disposable or explicitly approved live target, rerun doctor with --check-rls.",
    });
  } else if (!readUrl || !readCapabilities.length) {
    checks.push({
      name: `source:${input.sourceName}:postgres-rls-live-canary`,
      ok: false,
      level: "fail",
      message: "Live RLS canary requires the reader credential and at least one capability target.",
    });
  } else {
    try {
      await verifyPostgresRlsCanary(input.config, readCapabilities[0]!, readUrl, scope);
      checks.push({
        name: `source:${input.sourceName}:postgres-rls-live-canary`,
        ok: true,
        level: "pass",
        message: "Transaction-local trusted scope allowed the reviewed tenant/principal, denied an intentionally tenant-unscoped cross-tenant query, denied a cross-principal query, and did not bleed across transaction reuse.",
      });
    } catch (error) {
      checks.push({
        name: `source:${input.sourceName}:postgres-rls-live-canary`,
        ok: false,
        level: "fail",
        message: `Live RLS canary failed (${rlsDoctorError(error)}). Use a disposable row visible to the configured trusted context and verify both tenant and principal policy clauses.`,
      });
    }
  }
  return checks;
}


function uniqueRlsTargets(
  targets: Array<{ schema: string; table: string; operations: PostgresRlsOperation[] }>,
): Array<{ schema: string; table: string; operations: PostgresRlsOperation[] }> {
  const unique = new Map<string, { schema: string; table: string; operations: Set<PostgresRlsOperation> }>();
  for (const target of targets) {
    const key = `${target.schema}\u0000${target.table}`;
    const current = unique.get(key) ?? { schema: target.schema, table: target.table, operations: new Set<PostgresRlsOperation>() };
    for (const operation of target.operations) current.operations.add(operation);
    unique.set(key, current);
  }
  return [...unique.values()].map((target) => ({
    schema: target.schema,
    table: target.table,
    operations: [...target.operations].sort(),
  }));
}


async function inspectPostgresRlsDoctorTarget(
  sourceName: string,
  credentialKind: "reader" | "writer",
  databaseUrl: string,
  scope: Extract<NonNullable<RunnerSourceConfig["database_scope"]>, { mode: "postgres_rls" }>,
  target: { schema: string; table: string; operations: PostgresRlsOperation[] },
): Promise<DoctorCheck> {
  const pool = createPostgresPool(databaseUrl, { max: 1, connectionTimeoutMillis: 3000 });
  const client = await pool.connect();
  try {
    const report = await inspectPostgresRlsTarget(client, {
      schema: target.schema,
      table: target.table,
      scope: {
        tenantSetting: scope.tenant_setting,
        principalSetting: scope.principal_setting,
      },
      operations: target.operations,
    });
    return {
      name: `source:${sourceName}:postgres-rls:${credentialKind}:${target.schema}.${target.table}`,
      ok: report.ok,
      level: report.ok ? "pass" : "fail",
      message: report.ok
        ? `Role ${report.role} is non-owner/non-bypass, RLS and FORCE RLS are enabled, and ${target.operations.join("/")} policies use both configured settings (${report.policies.length} applicable policy record(s)).`
        : `RLS prerequisites failed for role ${report.role}: ${report.errors.join(", ")}. Hardened mode will refuse this target rather than fall back to Runner-only predicates.`,
    };
  } catch (error) {
    return {
      name: `source:${sourceName}:postgres-rls:${credentialKind}:${target.schema}.${target.table}`,
      ok: false,
      level: "fail",
      message: `RLS metadata inspection failed (${rlsDoctorError(error)}). Hardened mode will refuse this target.`,
    };
  } finally {
    client.release();
    await pool.end();
  }
}


async function verifyPostgresRlsCanary(
  config: RuntimeConfig,
  capability: RunnerCapabilityConfig,
  databaseUrl: string,
  scope: Extract<NonNullable<RunnerSourceConfig["database_scope"]>, { mode: "postgres_rls" }>,
): Promise<void> {
  const context = trustedCliContext(config, capability, process.env);
  const pool = createPostgresPool(databaseUrl, { max: 1, connectionTimeoutMillis: 3000 });
  const client = await pool.connect();
  const table = `${quotePostgresIdentifier(capability.target.schema)}.${quotePostgresIdentifier(capability.target.table)}`;
  const primaryKey = quotePostgresIdentifier(capability.target.primary_key);
  const bind = async (tenantId: string, principal: string) => bindPostgresTrustedScope(client, scope, {
    tenant_id: tenantId,
    principal,
    provenance: "environment",
  });
  try {
    await client.query("BEGIN");
    await bind(context.tenant_id, context.principal);
    const visible = await client.query(`SELECT ${primaryKey} AS id FROM ${table} ORDER BY ${primaryKey} LIMIT 1`);
    await client.query("ROLLBACK");
    const id = visible.rows[0]?.id;
    if (id === undefined) throw new Error("POSTGRES_RLS_CANARY_NO_VISIBLE_ROW");

    const deniedScopes: Array<[string, string]> = [
      [`synapsor-canary-tenant-${crypto.randomUUID()}`, context.principal],
      ...(scope.principal_setting
        ? [[context.tenant_id, `synapsor-canary-principal-${crypto.randomUUID()}`] as [string, string]]
        : []),
    ];
    for (const [tenantId, principal] of deniedScopes) {
      await client.query("BEGIN");
      const before = await client.query(
        "SELECT current_setting($1, true) AS tenant, current_setting($2, true) AS principal",
        [scope.tenant_setting, scope.principal_setting],
      );
      if (before.rows[0]?.tenant === context.tenant_id || before.rows[0]?.principal === context.principal) {
        throw new Error("POSTGRES_RLS_CONTEXT_LEAKED_ACROSS_TRANSACTION");
      }
      await bind(tenantId, principal);
      const denied = await client.query(`SELECT ${primaryKey} AS id FROM ${table} WHERE ${primaryKey} = $1`, [id]);
      await client.query("ROLLBACK");
      if ((denied.rowCount ?? denied.rows.length) !== 0) throw new Error("POSTGRES_RLS_CANARY_SCOPE_BYPASS");
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}


function rlsDoctorError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/POSTGRES_RLS_[A-Z0-9_:,-]+/.test(message)) return message.match(/POSTGRES_RLS_[A-Z0-9_:,-]+/)?.[0] ?? "POSTGRES_RLS_CHECK_FAILED";
  return safeDatabaseProbeError(error);
}


async function directSqlWritebackDoctorChecks(
  config: RuntimeConfig,
  sourceName: string,
  source: RunnerSourceConfig,
  writeUrl: string,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  try {
    const result = await adapters[source.engine].doctor({
      controlPlaneUrl: "local",
      runnerToken: "local",
      runnerId: "doctor",
      sourceId: sourceName,
      databaseUrl: writeUrl,
      engine: source.engine,
      pollIntervalMs: 0,
      statementTimeoutMs: writebackTimeoutMs(source),
      logLevel: "error",
      dryRun: true,
      stateDir: "./state",
      receipts: runnerReceiptConfig(source),
    } satisfies RunnerConfig);
    const receiptMode = formatSourceReceiptMode(source);
    checks.push({
      name: `source:${sourceName}:receipt-table-probe`,
      ok: result.ok,
      level: result.ok ? "pass" : "fail",
      message: result.ok
        ? source.receipts?.authority === "runner_ledger"
          ? `Writer credential can reach the source; ${receiptMode} performed no source receipt DDL/DML.`
          : `Writer credential can reach the database and the ${receiptMode} SELECT/INSERT/UPDATE rollback probe succeeded.`
        : `Writer receipt-mode probe failed (${safeDatabaseProbeError(result.details)}). ${receiptTableGuidance(source.engine, source)}`,
    });
  } catch (error) {
    checks.push({
      name: `source:${sourceName}:receipt-table-probe`,
      ok: false,
      level: "fail",
      message: `Writer receipt-mode probe failed (${safeDatabaseProbeError(error)}). ${receiptTableGuidance(source.engine, source)}`,
    });
  }

  for (const capability of directSqlProposalCapabilities(config, sourceName)) {
    try {
      await rollbackOnlyTargetProbe(source.engine, writeUrl, capability);
      checks.push({
        name: `capability:${capability.name}:writeback-target-probe`,
        ok: true,
        level: "pass",
        message: `Rollback-only writer probe reached ${capability.target.schema}.${capability.target.table} and verified ${capabilityOperation(capability).toUpperCase()} authority without mutating business rows.`,
      });
    } catch (error) {
      checks.push({
        name: `capability:${capability.name}:writeback-target-probe`,
        ok: false,
        level: "fail",
        message: `Rollback-only writer probe failed for configured target ${capability.target.schema}.${capability.target.table} (${safeDatabaseProbeError(error)}). Verify writer SELECT/${capabilityOperation(capability).toUpperCase()} on the target table and configured columns.`,
      });
    }
    for (const dependency of proposalFreshnessDependencyCapabilities(config, capability)) {
      try {
        await rollbackOnlyFreshnessDependencyProbe(
          source.engine,
          writeUrl,
          dependency.capability,
          dependency.versionColumn,
        );
        checks.push({
          name: `capability:${capability.name}:freshness-dependency:${dependency.id}:lock-probe`,
          ok: true,
          level: "pass",
          message: `Rollback-only writer probe verified locking-read authority for freshness dependency ${dependency.capability.target.schema}.${dependency.capability.target.table} without reading or mutating business rows.`,
        });
      } catch (error) {
        checks.push({
          name: `capability:${capability.name}:freshness-dependency:${dependency.id}:lock-probe`,
          ok: false,
          level: "fail",
          message: `Rollback-only locking-read probe failed for freshness dependency ${dependency.capability.target.schema}.${dependency.capability.target.table} (${safeDatabaseProbeError(error)}). Verify writer SELECT plus row-lock authority on the dependency relation; a narrow UPDATE grant on its version column is sufficient for the supported PostgreSQL/MySQL fixtures.`,
        });
      }
    }
  }
  return checks;
}


function directSqlProposalCapabilities(config: RuntimeConfig, sourceName: string): RunnerCapabilityConfig[] {
  return (config.capabilities ?? []).filter((capability) => {
    if (capability.kind !== "proposal" || capability.source !== sourceName) return false;
    return capabilityWritebackMode(capability) === "direct_sql";
  });
}


function proposalFreshnessDependencyCapabilities(
  config: RuntimeConfig,
  proposal: RuntimeCapabilityConfig,
): Array<{ id: string; capability: RuntimeCapabilityConfig; versionColumn: string }> {
  const policy = config.proposal_freshness?.[proposal.name];
  if (!policy) return [];
  const capabilities = new Map((config.capabilities ?? []).map((capability) => [capability.name, capability]));
  return (policy.dependencies ?? []).map((dependency) => {
    const capability = capabilities.get(dependency.capability);
    if (!capability) {
      throw new Error(`reviewed freshness dependency capability is missing: ${dependency.capability}`);
    }
    return {
      id: dependency.id,
      capability,
      versionColumn: dependency.version_column,
    };
  });
}


async function rollbackOnlyTargetProbe(engine: "postgres" | "mysql", databaseUrl: string, capability: RunnerCapabilityConfig): Promise<void> {
  if (engine === "postgres") {
    await rollbackOnlyPostgresTargetProbe(databaseUrl, capability);
    return;
  }
  await rollbackOnlyMysqlTargetProbe(databaseUrl, capability);
}


async function rollbackOnlyFreshnessDependencyProbe(
  engine: "postgres" | "mysql",
  databaseUrl: string,
  capability: RuntimeCapabilityConfig,
  versionColumn: string,
): Promise<void> {
  if (engine === "postgres") {
    const pg = await dynamicImportModule<{ Pool: new (options: { connectionString: string }) => { connect(): Promise<PostgresProbeClient>; end(): Promise<void> } }>("pg");
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const table = `${quotePostgresIdentifier(capability.target.schema)}.${quotePostgresIdentifier(capability.target.table)}`;
        const columns = freshnessDependencyProbeColumns(capability, versionColumn).map(quotePostgresIdentifier).join(", ");
        await client.query(`SELECT ${columns} FROM ${table} WHERE false FOR UPDATE`);
        await client.query("ROLLBACK");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    } finally {
      client.release();
      await pool.end();
    }
    return;
  }

  const mysql = await dynamicImportModule<{ createConnection(options: { uri: string; dateStrings: boolean }): Promise<MysqlProbeConnection> }>("mysql2/promise");
  const connection = await mysql.createConnection({ uri: databaseUrl, dateStrings: true });
  try {
    await connection.beginTransaction();
    try {
      const table = `${quoteMysqlIdentifier(capability.target.schema)}.${quoteMysqlIdentifier(capability.target.table)}`;
      const columns = freshnessDependencyProbeColumns(capability, versionColumn).map(quoteMysqlIdentifier).join(", ");
      await connection.query(`SELECT ${columns} FROM ${table} WHERE 1 = 0 FOR UPDATE`);
      await connection.rollback();
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    }
  } finally {
    await connection.end();
  }
}


async function rollbackOnlyPostgresTargetProbe(databaseUrl: string, capability: RunnerCapabilityConfig): Promise<void> {
  const pg = await dynamicImportModule<{ Pool: new (options: { connectionString: string }) => { connect(): Promise<PostgresProbeClient>; end(): Promise<void> } }>("pg");
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const table = `${quotePostgresIdentifier(capability.target.schema)}.${quotePostgresIdentifier(capability.target.table)}`;
      const columns = proposalReadProbeColumns(capability).map(quotePostgresIdentifier).join(", ");
      await client.query(`SELECT ${columns} FROM ${table} WHERE false`);
      const operation = capabilityOperation(capability);
      const writeColumns = proposalWriteProbeColumns(capability);
      if (operation === "update") {
        for (const column of writeColumns) {
          const quoted = quotePostgresIdentifier(column);
          await client.query(`UPDATE ${table} SET ${quoted} = NULL WHERE false`);
        }
      } else if (operation === "insert") {
        const quotedColumns = writeColumns.map(quotePostgresIdentifier).join(", ");
        const nullValues = writeColumns.map(() => "NULL").join(", ");
        await client.query(`INSERT INTO ${table} (${quotedColumns}) SELECT ${nullValues} WHERE false`);
      } else {
        await client.query(`DELETE FROM ${table} WHERE false`);
      }
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
}


async function rollbackOnlyMysqlTargetProbe(databaseUrl: string, capability: RunnerCapabilityConfig): Promise<void> {
  const mysql = await dynamicImportModule<{ createConnection(options: { uri: string; dateStrings: boolean }): Promise<MysqlProbeConnection> }>("mysql2/promise");
  const connection = await mysql.createConnection({ uri: databaseUrl, dateStrings: true });
  try {
    await connection.beginTransaction();
    try {
      const table = `${quoteMysqlIdentifier(capability.target.schema)}.${quoteMysqlIdentifier(capability.target.table)}`;
      const columns = proposalReadProbeColumns(capability).map(quoteMysqlIdentifier).join(", ");
      await connection.query(`SELECT ${columns} FROM ${table} WHERE 1 = 0`);
      const operation = capabilityOperation(capability);
      const writeColumns = proposalWriteProbeColumns(capability);
      if (operation === "update") {
        for (const column of writeColumns) {
          const quoted = quoteMysqlIdentifier(column);
          await connection.query(`UPDATE ${table} SET ${quoted} = NULL WHERE 1 = 0`);
        }
      } else if (operation === "insert") {
        const quotedColumns = writeColumns.map(quoteMysqlIdentifier).join(", ");
        const nullValues = writeColumns.map(() => "NULL").join(", ");
        await connection.query(`INSERT INTO ${table} (${quotedColumns}) SELECT ${nullValues} FROM DUAL WHERE 1 = 0`);
      } else {
        await connection.query(`DELETE FROM ${table} WHERE 1 = 0`);
      }
      await connection.rollback();
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    }
  } finally {
    await connection.end();
  }
}


type PostgresProbeClient = {
  query(sql: string, values?: unknown[]): Promise<unknown>;
  release(): void;
};


type MysqlProbeConnection = {
  query(sql: string, values?: unknown[]): Promise<unknown>;
  beginTransaction(): Promise<void>;
  rollback(): Promise<void>;
  end(): Promise<void>;
};


function proposalReadProbeColumns(capability: RunnerCapabilityConfig): string[] {
  const columns = new Set<string>();
  columns.add(capability.target.primary_key);
  const operation = capabilityOperation(capability);
  if (operation === "insert") {
    for (const component of capability.operation?.deduplication?.components ?? []) columns.add(component.column);
  } else {
    if (capability.target.tenant_key) columns.add(capability.target.tenant_key);
    if (capability.conflict_guard?.column) columns.add(capability.conflict_guard.column);
  }
  return [...columns];
}


function freshnessDependencyProbeColumns(capability: RuntimeCapabilityConfig, versionColumn: string): string[] {
  return [...new Set([
    capability.target.primary_key,
    capability.target.tenant_key,
    capability.target.principal_scope_key,
    versionColumn,
  ].filter((column): column is string => Boolean(column)))];
}


function proposalWriteProbeColumns(capability: RunnerCapabilityConfig): string[] {
  const columns = new Set<string>();
  for (const column of capability.allowed_columns ?? []) columns.add(column);
  for (const column of Object.keys(capability.patch ?? {})) columns.add(column);
  if (capabilityOperation(capability) === "insert") {
    if (capability.target.tenant_key) columns.add(capability.target.tenant_key);
    for (const component of capability.operation?.deduplication?.components ?? []) columns.add(component.column);
  }
  return [...columns];
}


function quotePostgresIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}


function quoteMysqlIdentifier(value: string): string {
  return `\`${value.replace(/`/g, "``")}\``;
}


function safeDatabaseProbeError(error: unknown): string {
  const raw = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : JSON.stringify(error ?? {});
  const message = raw.toLowerCase();
  if (/permission|denied|not authorized|insufficient|42501|er_tableaccess_denied|er_dbaccess_denied/.test(message)) return "permission denied";
  if (/authentication|password|28p01|access denied for user|invalid authorization/.test(message)) return "authentication failed";
  if (/timeout|timed out|etimedout/.test(message)) return "timeout";
  if (/econnrefused|enotfound|eai_again|network|connection terminated|connection failed/.test(message)) return "connection failed";
  if (/does not exist|unknown database|no such table|undefined_table|er_no_such_table|42p01/.test(message)) return "configured object not found";
  return "database probe failed";
}


function sourceReceiptModeDoctorCheck(config: RuntimeConfig, sourceName: string, source: RunnerSourceConfig): DoctorCheck {
  const receipts = runnerReceiptConfig(source);
  if (receipts?.authority !== "runner_ledger") {
    return {
      name: `source:${sourceName}:receipt-mode`,
      ok: true,
      level: receipts?.provisioning === "auto_migrate" ? "warn" : "pass",
      message: receipts?.provisioning === "auto_migrate"
        ? `${formatSourceReceiptMode(source)} is active; Runner may execute only its fixed idempotent receipt-table migration and the writer needs CREATE for that table.`
        : `${formatSourceReceiptMode(source)} is active; Runner will not execute source DDL and requires the pre-created table with SELECT/INSERT/UPDATE.`,
    };
  }
  const shared = config.storage?.shared_postgres;
  const local = Boolean(config.storage?.sqlite_path);
  const authoritative = shared?.mode === "runtime_store" || (!shared && local);
  return {
    name: `source:${sourceName}:receipt-mode`,
    ok: authoritative,
    level: authoritative ? "pass" : "fail",
    message: authoritative
      ? `${formatSourceReceiptMode(source)} is active; durable intents use ${shared?.mode === "runtime_store" ? "the authoritative shared Postgres runtime store" : "single-process local SQLite"} and no source receipt DDL/DML is allowed.`
      : "runner_ledger requires single-process local SQLite or storage.shared_postgres.mode runtime_store before source mutation.",
  };
}


async function localDoctorStoreStats(storePath?: string): Promise<LocalDoctorReport["store_stats"]> {
  if (!storePath || storePath === ":memory:") return { path: storePath ?? "not configured", exists: storePath === ":memory:" };
  if (!await fileExists(storePath)) return { path: storePath, exists: false };
  const store = new ProposalStore(storePath);
  try {
    return {
      path: storePath,
      exists: true,
      proposals: store.listProposals({ limit: 1_000_000 }).length,
      evidence: store.listEvidenceBundles({ limit: 1_000_000 }).length,
      query_audit: store.listQueryAudit({ limit: 1_000_000 }).length,
      receipts: store.listReceipts({ limit: 1_000_000 }).length,
    };
  } finally {
    store.close();
  }
}
