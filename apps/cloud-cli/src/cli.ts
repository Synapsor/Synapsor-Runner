#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CloudControlClient, CloudControlError } from "@synapsor-runner/control-plane-client";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { formatAgentDsl } from "@synapsor/dsl";
import { normalizeContract, validateContract, type SynapsorContract } from "@synapsor/spec";
import manifest from "../package.json" with { type: "json" };
import specManifest from "../../../packages/spec/package.json" with { type: "json" };
import dslManifest from "../../../packages/dsl/package.json" with { type: "json" };
import runnerManifest from "../../runner/package.json" with { type: "json" };
import {
  deleteStoredCredential,
  readProfiles,
  resolveCredential,
  safeProfileName,
  selectProfile,
  storeHumanCredential,
  upsertProfile,
  writeProfiles,
  type CloudProfile,
  type ProfileDocument,
} from "./profiles.js";
import {
  formatContractFile,
  initializeContract,
  inspectContract,
  loadContractFile,
  mutateDefinition,
  renderSemanticDiff,
  semanticDiff,
  type SemanticChange,
} from "./contracts.js";

type Json = Record<string, unknown>;

export class CliError extends Error {
  readonly errorCode: string;
  readonly exitCode: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly details?: Json;

  constructor(input: { errorCode: string; message: string; exitCode?: number; retryable?: boolean; retryAfterMs?: number; requestId?: string; details?: Json }) {
    super(input.message);
    this.name = "CliError";
    this.errorCode = input.errorCode;
    this.exitCode = input.exitCode ?? 1;
    this.retryable = input.retryable ?? false;
    this.retryAfterMs = input.retryAfterMs;
    this.requestId = input.requestId;
    this.details = input.details;
  }
}

type RemoteContext = {
  client: CloudControlClient;
  profileName: string;
  profile: CloudProfile;
  profiles: ProfileDocument;
  projectId: string;
  workspaceId: string;
  apiUrl: string;
  credentialKind: "human" | "service";
};

const GROUPS = [
  ["auth", "Sign in, inspect identity, and manage local profiles"],
  ["status", "Show Cloud identity, project, service health, and entitlement"],
  ["entitlements", "Inspect effective hosted feature access"],
  ["billing", "Inspect plan and billing lifecycle status"],
  ["workspaces", "List and select a workspace"],
  ["projects", "List, inspect, and select a project"],
  ["sources", "List safe source metadata (never database credentials)"],
  ["contracts", "Author, validate, version, push, activate, and pull contracts"],
  ["contexts", "Author trusted contexts inside a local canonical contract"],
  ["capabilities", "Author and preview semantic capabilities"],
  ["workflows", "Author declarative workflows"],
  ["api-keys", "Manage scoped Cloud automation keys"],
  ["runners", "Manage separately scoped Runner connections and bundles"],
  ["proposals", "Review Cloud proposals and record human decisions"],
  ["activity", "Search the shared Cloud chronology"],
  ["evidence", "Inspect metadata-only evidence references"],
  ["receipts", "Inspect safe writeback receipt metadata"],
  ["replay", "Inspect and verify replay integrity references"],
  ["exports", "Create and download scoped audit exports"],
] as const;

function definitionHelp(noun: string): ReadonlyArray<readonly [syntax: string, description: string]> {
  return [
    ["list --contract <path>", `List local ${noun} definitions`],
    ["show <name> --contract <path>", `Show one local ${noun}`],
    ["create <name> --contract <path> --from-file <path>", `Create and validate a local ${noun}`],
    ["update <name> --contract <path> --from-file <path>", `Update and validate a local ${noun}`],
    ["remove <name> --contract <path>", `Remove an unreferenced local ${noun}`],
  ];
}

const COMMAND_HELP: Record<string, ReadonlyArray<readonly [syntax: string, description: string]>> = {
  auth: [
    ["login [--open]", "Start the browser/device human-login flow"],
    ["logout", "Revoke the active human session and remove its local reference"],
    ["whoami", "Show authenticated human or service identity and effective entitlement"],
    ["profiles", "List local non-secret profiles"],
    ["use <profile>", "Select a local profile"],
    ["configure-service --credential-env <NAME>|--credential-file <path>", "Configure a scoped service-key reference without storing its value"],
  ],
  status: [["", "Show profile, identity, service health, project, plan, billing, and entitlement"]],
  entitlements: [["show", "Show effective hosted features, limits, grace, and blocked reason"]],
  billing: [["status", "Show safe plan and billing lifecycle status"]],
  workspaces: [["list", "List accessible workspaces"], ["use <workspace-id>", "Select a workspace"]],
  projects: [["list", "List accessible projects"], ["show [project-id]", "Show a project"], ["use <project-id>", "Select a project"]],
  sources: [["list", "List safe source metadata"], ["show <source-id>", "Show safe source metadata"]],
  contracts: [
    ["init [path] [--name <name>]", "Create a minimal local canonical contract"],
    ["validate <path>", "Validate a local JSON or DSL contract"],
    ["format <path> [--check]", "Canonically format a local contract"],
    ["inspect <path>", "Summarize a local contract and digest"],
    ["diff <left> <right>", "Show a local or remote semantic safety diff"],
    ["push <path> [--dry-run]", "Create or reuse an immutable Cloud contract version"],
    ["list", "List Cloud contracts"],
    ["show <contract-id>", "Show a Cloud contract"],
    ["history <contract-id>", "List immutable versions"],
    ["pull <contract/version> --out <path>", "Download and digest-check a contract version"],
    ["activate <contract/version> --yes", "Activate a reviewed version"],
    ["rollback <contract/version> --yes", "Activate an older reviewed version"],
  ],
  contexts: definitionHelp("trusted context"),
  capabilities: [
    ...definitionHelp("capability"),
    ["preview <name> --contract <path>", "Show the model-visible and trusted safety surface"],
  ],
  workflows: [
    ...definitionHelp("workflow"),
    ["validate <name> --contract <path>", "Validate one declarative workflow in its full contract"],
  ],
  "api-keys": [
    ["list", "List redacted project API keys"],
    ["show <key-id>", "Show one redacted API key"],
    ["create --name <name> --scopes <csv> --secret-file <path>", "Create a scoped key and write its one-time secret to a mode-0600 file"],
    ["rotate <key-id> --secret-file <path>", "Rotate a key and write its one-time replacement secret"],
    ["revoke <key-id> --yes", "Revoke a key"],
  ],
  runners: [
    ["list", "List registered Runner connections"],
    ["show <runner-id>", "Show one Runner connection"],
    ["create --sources <csv> --secret-file <path>", "Create a source-scoped Runner token"],
    ["rotate-token <token-id> --secret-file <path>", "Rotate a Runner token"],
    ["revoke-token <token-id> --yes", "Revoke a Runner token"],
    ["bundle download <contract/version> --source <id> --out <path>", "Download a source-bound, credential-free Runner bundle"],
    ["doctor <runner-id>", "Show Runner readiness and safe diagnostics"],
  ],
  proposals: [
    ["list", "List shared proposals"],
    ["show <proposal-id>", "Show a proposal, bounded diff, scope summary, and policy state"],
    ["decisions <proposal-id>", "List identity-stamped decisions"],
    ["approve <proposal-id> --yes", "Record an authorized human approval"],
    ["reject <proposal-id> --reason <text> --yes", "Record an authorized human rejection"],
  ],
  activity: [["search", "Search the shared Cloud chronology"], ["show <event-or-proposal-id>", "Show one scoped activity record"]],
  evidence: [["show <id-or-proposal-id>", "Show metadata-only evidence references; payload remains local"]],
  receipts: [["show <id-or-proposal-id>", "Show safe writeback receipt metadata"]],
  replay: [["show <id-or-proposal-id>", "Show replay integrity references"], ["verify <id-or-proposal-id>", "Verify Cloud hash-linked metadata integrity"]],
  exports: [
    ["create [--format jsonl]", "Create a scoped audit export"],
    ["status <export-id>", "Show export status"],
    ["download <export-id> --out <path>", "Download a completed export"],
  ],
};

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (!argv.length || has(argv, "--help") || argv[0] === "help") {
    writeHelp(argv[0] === "help" ? argv.slice(1) : argv);
    return 0;
  }
  if (has(argv, "--version") || has(argv, "-v") || argv[0] === "version") {
    process.stdout.write(`${manifest.version}\n`);
    return 0;
  }
  const [group, ...args] = argv;
  switch (group) {
    case "auth": return authCommand(args);
    case "status": return statusCommand(args);
    case "entitlements": return entitlementCommand(args);
    case "billing": return billingCommand(args);
    case "workspaces": return workspaceCommand(args);
    case "projects": return projectCommand(args);
    case "sources": return sourceCommand(args);
    case "contracts": return contractCommand(args);
    case "contexts": return definitionCommand("contexts", args);
    case "capabilities": return definitionCommand("capabilities", args);
    case "workflows": return definitionCommand("workflows", args);
    case "api-keys": return apiKeyCommand(args);
    case "runners": return runnerCommand(args);
    case "proposals": return proposalCommand(args);
    case "activity": return activityCommand(args);
    case "evidence": return linkedResourceCommand("evidence", args);
    case "receipts": return linkedResourceCommand("receipts", args);
    case "replay": return replayCommand(args);
    case "exports": return exportCommand(args);
    default: throw usage(`unknown command group: ${group}`);
  }
}

async function authCommand(args: string[]): Promise<number> {
  const action = args[0] || "whoami";
  if (action === "profiles") {
    const document = await readProfiles();
    output(args, { ok: true, active_profile: document.active_profile, profiles: Object.entries(document.profiles).map(([name, profile]) => ({ name, ...profile, credential_file: profile.credential_file ? "configured" : undefined, credential_keychain: profile.credential_keychain ? { provider: profile.credential_keychain.provider, configured: true } : undefined })) },
      [`Active profile: ${document.active_profile}`, ...Object.entries(document.profiles).map(([name, profile]) => `${name === document.active_profile ? "*" : " "} ${name}  ${profile.api_url}  project=${profile.project_id || "not selected"}`)]);
    return 0;
  }
  if (action === "configure-service") {
    const profileName = safeProfileName(option(args, "--profile") || "default");
    const apiUrl = cleanApiUrl(option(args, "--api-url") || process.env.SYNAPSOR_CLOUD_BASE_URL || "https://dev-api.synapsor.ai");
    const credentialEnv = option(args, "--credential-env");
    const credentialFile = option(args, "--credential-file");
    if (Boolean(credentialEnv) === Boolean(credentialFile)) throw usage("auth configure-service requires exactly one of --credential-env <NAME> or --credential-file <path>");
    if (credentialEnv && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(credentialEnv)) throw usage("--credential-env must be an uppercase environment-variable name");
    if (credentialFile) {
      const stat = await fs.stat(path.resolve(credentialFile));
      if ((stat.mode & 0o077) !== 0) throw usage(`--credential-file must be mode 0600: ${path.resolve(credentialFile)}`);
    }
    const document = await readProfiles();
    const previous = document.profiles[profileName];
    if (previous?.credential_kind === "human") await deleteStoredCredential(previous);
    await upsertProfile(profileName, {
      api_url: apiUrl,
      credential_kind: "service",
      credential_env: credentialEnv || undefined,
      credential_file: credentialFile ? path.resolve(credentialFile) : undefined,
      credential_keychain: undefined,
      project_id: option(args, "--project") || undefined,
      workspace_id: option(args, "--workspace") || undefined,
    });
    await selectProfile(profileName);
    output(args, { ok: true, profile: profileName, api_url: apiUrl, credential_kind: "service", credential_reference: credentialEnv || "permission-0600-file" }, [
      `Configured service profile ${profileName}.`,
      credentialEnv ? `Credential source: environment variable ${credentialEnv}` : "Credential source: permission-0600 file reference",
      "No credential value was stored in the profile.",
    ]);
    return 0;
  }
  if (action === "use") {
    const name = positional(args, 1, "auth use requires <profile>");
    await selectProfile(name);
    output(args, { ok: true, active_profile: name }, [`Active profile: ${name}`]);
    return 0;
  }
  if (action === "login") return authLogin(args);
  const remote = await remoteContext(args, false);
  if (action === "whoami") {
    const identityResponse = await remote.client.get("/v1/control/sessions/self");
    const identity = object(identityResponse.context || identityResponse.identity || identityResponse.session || identityResponse);
    const embeddedEntitlements = identity.entitlements && typeof identity.entitlements === "object"
      ? object(identity.entitlements)
      : undefined;
    const entitlements = remote.credentialKind === "human" && remote.projectId
      ? await remote.client.get(`/v1/control/projects/${encodeURIComponent(remote.projectId)}/entitlements`)
      : embeddedEntitlements;
    const result = {
      ok: true,
      identity,
      profile: remote.profileName,
      credential_kind: remote.credentialKind,
      selected_workspace: remote.workspaceId || null,
      selected_project: remote.projectId || null,
      ...(entitlements ? { entitlements: redact(entitlements) } : {}),
    };
    output(args, redact(result), [
      ...identityLines(identityResponse, remote),
      ...(entitlements ? [`Entitlement: ${string(entitlements.entitlement_status || object(entitlements.entitlements).entitlement_status || "unknown")}`] : []),
    ]);
    return 0;
  }
  if (action === "logout") {
    if (remote.credentialKind === "human") {
      await remote.client.post("/v1/control/sessions/revoke", {}, { idempotencyKey: idempotency(args) });
      await deleteStoredCredential(remote.profile);
      const document = await readProfiles();
      if (document.profiles[remote.profileName]) {
        delete document.profiles[remote.profileName]!.credential_file;
        delete document.profiles[remote.profileName]!.credential_keychain;
        delete document.profiles[remote.profileName]!.credential_kind;
        await writeProfiles(document);
      }
    }
    output(args, { ok: true, logged_out: true, profile: remote.profileName }, [`Logged out profile ${remote.profileName}.`]);
    return 0;
  }
  throw usage(`unknown auth command: ${action}`);
}

async function authLogin(args: string[]): Promise<number> {
  if (has(args, "--no-interactive")) throw usage("auth login requires an interactive browser/device flow; use SYNAPSOR_API_KEY for CI");
  const profileName = safeProfileName(option(args, "--profile") || "default");
  const apiUrl = cleanApiUrl(option(args, "--api-url") || process.env.SYNAPSOR_CLOUD_BASE_URL || "https://dev-api.synapsor.ai");
  const start = await anonymousRequest(apiUrl, "/v1/control/device-authorizations", { profile: profileName });
  const deviceCode = string(start.device_code);
  const userCode = string(start.user_code);
  const verificationUri = string(start.verification_uri_complete || start.verification_uri);
  if (!deviceCode || !userCode || !verificationUri) throw new CliError({ errorCode: "device_authorization_invalid", message: "Cloud returned an incomplete device authorization response." });
  process.stderr.write(`Open ${verificationUri}\nConfirm code: ${userCode}\n`);
  if (has(args, "--open")) openBrowser(verificationUri);
  const expiresAt = Date.now() + Math.max(60, number(start.expires_in, 600)) * 1_000;
  const interval = Math.max(1, number(start.interval, 3)) * 1_000;
  let token = "";
  while (Date.now() < expiresAt) {
    await delay(interval);
    try {
      const polled = await anonymousRequest(apiUrl, "/v1/control/device-authorizations/token", { device_code: deviceCode });
      token = string(polled.access_token);
      if (token) break;
    } catch (error) {
      if (error instanceof CliError && ["authorization_pending", "slow_down"].includes(error.errorCode)) continue;
      throw error;
    }
  }
  if (!token) throw new CliError({ errorCode: "device_authorization_expired", message: "The device authorization expired before approval.", exitCode: 3 });
  const stored = await storeHumanCredential(profileName, token);
  await upsertProfile(profileName, {
    api_url: apiUrl,
    credential_kind: "human",
    credential_env: undefined,
    credential_file: stored.storage === "secure_file" ? stored.file : undefined,
    credential_keychain: stored.storage === "keychain" ? stored.keychain : undefined,
  });
  await selectProfile(profileName);
  output(args, { ok: true, profile: profileName, api_url: apiUrl, credential_storage: stored.storage }, [
    `Signed in to ${apiUrl} as profile ${profileName}.`,
    stored.storage === "keychain"
      ? "Credential stored in the operating-system keychain."
      : "OS keychain integration was unavailable; credential stored in a permission-0600 fallback file.",
  ]);
  return 0;
}

async function statusCommand(args: string[]): Promise<number> {
  const remote = await remoteContext(args, false);
  const [identity, status, entitlements] = await Promise.all([
    remote.client.get("/v1/control/sessions/self"),
    remote.client.get(`/v1/control/status${remote.projectId ? `?project_id=${encodeURIComponent(remote.projectId)}` : ""}`),
    remote.projectId
      ? remote.client.get(`/v1/control/projects/${encodeURIComponent(remote.projectId)}/entitlements`)
      : Promise.resolve(undefined),
  ]);
  const result = {
    ok: true,
    profile: remote.profileName,
    api_url: remote.apiUrl,
    selected_workspace: remote.workspaceId || null,
    selected_project: remote.projectId || null,
    credential_kind: remote.credentialKind,
    identity: redact(identity),
    service: redact(status),
    ...(entitlements ? { entitlements: redact(entitlements) } : {}),
  };
  output(args, result, [
    `Profile: ${remote.profileName}`,
    `API: ${remote.apiUrl}`,
    `Credential: ${remote.credentialKind}`,
    `Project: ${remote.projectId || "not selected"}`,
    `Service: ${string(status.status || (status.ok ? "ok" : "unknown"))}`,
    ...(entitlements
      ? [
          `Plan: ${string(entitlements.plan || object(entitlements.entitlements).plan || "unknown")}`,
          `Billing: ${string(entitlements.billing_status || object(entitlements.billing).status || "unknown")}`,
          `Entitlement: ${string(entitlements.entitlement_status || object(entitlements.entitlements).entitlement_status || "unknown")}`,
          ...(entitlements.grace_deadline ? [`Grace deadline: ${string(entitlements.grace_deadline)}`] : []),
          ...(entitlements.blocked_reason ? [`Blocked: ${string(entitlements.blocked_reason)}`] : []),
        ]
      : []),
  ]);
  return 0;
}

async function entitlementCommand(args: string[]): Promise<number> {
  if ((args[0] || "show") !== "show") throw usage("entitlements supports: show");
  const remote = await remoteContext(args, true);
  const result = await remote.client.get(`/v1/control/projects/${encodeURIComponent(remote.projectId)}/entitlements`);
  output(args, redact(result), keyValueLines(result.entitlements || result));
  return 0;
}

async function billingCommand(args: string[]): Promise<number> {
  if ((args[0] || "status") !== "status") throw usage("billing supports: status");
  const remote = await remoteContext(args, true);
  const result = await remote.client.get(`/v1/control/projects/${encodeURIComponent(remote.projectId)}/entitlements`);
  output(args, redact(result), keyValueLines(result.billing || result));
  return 0;
}

async function workspaceCommand(args: string[]): Promise<number> {
  const action = args[0] || "list";
  if (action === "use") {
    const workspace = positional(args, 1, "workspaces use requires <workspace>");
    await updateSelection(args, { workspace_id: workspace });
    output(args, { ok: true, workspace_id: workspace }, [`Selected workspace: ${workspace}`]);
    return 0;
  }
  if (action !== "list") throw usage("workspaces supports: list, use");
  const remote = await remoteContext(args, false);
  const result = await paginatedGet(remote, "/v1/control/accounts", args, "accounts");
  outputList(args, result, "accounts", (item) => `${string(item.account_id)}  ${string(item.name)}  ${string(item.status)}`);
  return 0;
}

async function projectCommand(args: string[]): Promise<number> {
  const action = args[0] || "list";
  if (action === "use") {
    const project = positional(args, 1, "projects use requires <project>");
    await updateSelection(args, { project_id: project });
    output(args, { ok: true, project_id: project }, [`Selected project: ${project}`]);
    return 0;
  }
  const remote = await remoteContext(args, action === "show");
  if (action === "list") {
    const result = await paginatedGet(remote, "/v1/control/projects", args, "projects");
    outputList(args, result, "projects", (item) => `${string(item.project_id)}  ${string(item.name)}  ${string(item.plan)}  ${string(item.status)}`);
    return 0;
  }
  if (action === "show") {
    const id = args[1] && !args[1]!.startsWith("--") ? args[1]! : remote.projectId;
    const result = await remote.client.get(`/v1/control/projects/${encodeURIComponent(id)}`);
    output(args, redact(result), keyValueLines(result.project || result));
    return 0;
  }
  throw usage("projects supports: list, show, use");
}

async function sourceCommand(args: string[]): Promise<number> {
  const action = args[0] || "list";
  const remote = await remoteContext(args, true);
  if (action === "list") {
    const result = await paginatedGet(remote, "/v1/control/external-sources", args, "sources", { project_id: remote.projectId });
    outputList(args, result, "sources", (item) => `${string(item.source_id)}  ${string(item.name)}  ${string(item.kind)}  ${string(item.status)}`);
    return 0;
  }
  if (action === "show") {
    const id = positional(args, 1, "sources show requires <source>");
    const result = await remote.client.get(`/v1/control/external-sources/${encodeURIComponent(id)}`);
    output(args, redact(result), keyValueLines(result.source || result));
    return 0;
  }
  throw usage("sources supports: list, show");
}

async function contractCommand(args: string[]): Promise<number> {
  const action = args[0] || "list";
  if (action === "init") {
    const target = args[1] && !args[1]!.startsWith("--") ? args[1]! : "synapsor.contract.json";
    const contract = await initializeContract(target, option(args, "--name") || "synapsor-contract");
    output(args, { ok: true, path: path.resolve(target), contract }, [`Created ${path.resolve(target)}`]);
    return 0;
  }
  if (["validate", "format", "inspect"].includes(action)) {
    const target = positional(args, 1, `contracts ${action} requires <path>`);
    if (action === "format") {
      const result = await formatContractFile(target, has(args, "--check"));
      if (has(args, "--check") && result.changed) throw new CliError({ errorCode: "contract_format_required", message: `${target} is not canonically formatted.`, exitCode: 2 });
      output(args, { ok: true, changed: result.changed, digest: canonicalJsonDigest(result.contract) }, [result.changed ? `Formatted ${target}` : `${target} is already formatted.`]);
      return 0;
    }
    const loaded = await loadContractFile(target);
    const result = action === "inspect" ? inspectContract(loaded.contract) : { ok: true, path: loaded.path, digest: canonicalJsonDigest(loaded.contract), spec_version: loaded.contract.spec_version };
    output(args, result, action === "inspect" ? inspectLines(result) : [`Contract valid: ${loaded.path}`, `Digest: ${canonicalJsonDigest(loaded.contract)}`]);
    return 0;
  }
  if (action === "diff" && isLocalPath(args[1]) && isLocalPath(args[2])) {
    const left = await loadContractFile(args[1]!);
    const right = await loadContractFile(args[2]!);
    const changes = semanticDiff(left.contract, right.contract);
    output(args, { ok: true, left_digest: canonicalJsonDigest(left.contract), right_digest: canonicalJsonDigest(right.contract), risk_increasing: changes.some((item) => item.risk_increasing), changes }, renderSemanticDiff(changes));
    return 0;
  }
  const remote = await remoteContext(args, true);
  if (action === "push") return remoteContractPush(args, remote);
  if (action === "list") {
    const result = await paginatedGet(remote, `/v1/control/projects/${encodeURIComponent(remote.projectId)}/agent-contracts`, args, "contracts");
    outputList(args, result, "contracts", (item) => `${string(item.contract_id)}  v${string(item.current_version_number)}  ${string(item.name)}  ${string(item.status)}  ${string(item.digest)}`);
    return 0;
  }
  if (["show", "history"].includes(action)) {
    const id = positional(args, 1, `contracts ${action} requires <contract>`);
    const result = await remote.client.get(`/v1/control/projects/${encodeURIComponent(remote.projectId)}/agent-contracts/${encodeURIComponent(id)}`);
    output(args, redact(result), action === "history" ? listLines(array(result.versions), (item) => `v${string(item.version_number)}  ${string(item.status)}  ${string(item.digest)}`) : keyValueLines(result.contract || result));
    return 0;
  }
  if (action === "pull") {
    const reference = positional(args, 1, "contracts pull requires <contract/version>");
    const out = requiredOption(args, "--out");
    const { contractId, versionId } = splitVersionReference(reference, option(args, "--version"));
    const result = await remote.client.get(`/v1/control/projects/${encodeURIComponent(remote.projectId)}/agent-contracts/${encodeURIComponent(contractId)}/versions/${encodeURIComponent(versionId)}`);
    const version = object(result.version);
    const contract = object(version.contract);
    const digest = canonicalJsonDigest(contract);
    if (digest !== string(version.digest)) throw new CliError({ errorCode: "contract_digest_mismatch", message: "Downloaded contract digest does not match Cloud metadata.", exitCode: 5 });
    await atomicOutput(out, `${JSON.stringify(contract, null, 2)}\n`);
    output(args, { ok: true, out: path.resolve(out), digest }, [`Wrote ${path.resolve(out)}`, `Digest verified: ${digest}`]);
    return 0;
  }
  if (["activate", "rollback"].includes(action)) {
    confirmMutation(args, `${action} this contract version`);
    const reference = positional(args, 1, `contracts ${action} requires <contract/version>`);
    const { contractId, versionId } = splitVersionReference(reference, option(args, "--version"));
    const result = await remote.client.post(`/v1/control/projects/${encodeURIComponent(remote.projectId)}/agent-contracts/${encodeURIComponent(contractId)}/versions/${encodeURIComponent(versionId)}/${action}`, { reason: option(args, "--reason") || `${action} from Synapsor CLI` }, { idempotencyKey: idempotency(args) });
    output(args, redact(result), keyValueLines(result.version || result));
    return 0;
  }
  if (action === "diff") {
    const leftRef = positional(args, 1, "contracts diff requires two local paths or remote contract/version references");
    const rightRef = positional(args, 2, "contracts diff requires two local paths or remote contract/version references");
    const left = await fetchRemoteContract(remote, leftRef);
    const right = await fetchRemoteContract(remote, rightRef);
    const changes = semanticDiff(left, right);
    output(args, { ok: true, risk_increasing: changes.some((item) => item.risk_increasing), changes }, renderSemanticDiff(changes));
    return 0;
  }
  throw usage("contracts supports: init, validate, format, inspect, diff, push, list, show, pull, activate, rollback, history");
}

async function remoteContractPush(args: string[], remote: RemoteContext): Promise<number> {
  const target = positional(args, 1, "contracts push requires <path>");
  const loaded = await loadContractFile(target);
  const name = option(args, "--name") || loaded.contract.metadata?.name || "";
  const localDigest = canonicalJsonDigest(loaded.contract);
  if (has(args, "--dry-run")) {
    const existing = await findRemoteContractByName(remote, name);
    const previous = existing ? await latestRemoteContract(remote, string(existing.contract_id)) : undefined;
    const changes = previous ? semanticDiff(previous, loaded.contract) : [{ area: "contract", change: "initial_version", risk_increasing: false }] satisfies SemanticChange[];
    output(args, { ok: true, dry_run: true, local_digest: localDigest, risk_increasing: changes.some((item) => item.risk_increasing), changes }, [`Dry run: ${name || target}`, `Digest: ${localDigest}`, ...renderSemanticDiff(changes)]);
    return 0;
  }
  const result = await remote.client.pushContract({
    projectId: remote.projectId,
    contract: loaded.contract as unknown as Json,
    name,
    description: option(args, "--description") || loaded.contract.metadata?.description,
    source: "cli",
    sourceVersions: { "@synapsor/spec": specManifest.version, "@synapsor/dsl": dslManifest.version, "@synapsor/cli": manifest.version },
    activate: has(args, "--activate"),
    idempotencyKey: idempotency(args, localDigest),
  });
  output(args, redact(result), [`Contract pushed: ${string(result.contract_id || object(result.contract).contract_id)}`, `Version: ${string(result.contract_version_id || object(result.version).contract_version_id)}`, `Digest verified: ${localDigest}`, `Status: ${string(result.status || object(result.version).status || "stored")}`]);
  return 0;
}

async function definitionCommand(section: "contexts" | "capabilities" | "workflows", args: string[]): Promise<number> {
  const action = args[0] || "list";
  const file = requiredOption(args, "--contract");
  const loaded = await loadContractFile(file);
  if (action === "list") {
    const items = loaded.contract[section] || [];
    output(args, { ok: true, [section]: items }, listLines(items as unknown as Json[], (item) => `${string(item.name)}${section === "capabilities" ? `  ${string(item.kind)}` : ""}`));
    return 0;
  }
  const name = positional(args, 1, `${section} ${action} requires <name>`);
  const existing = (loaded.contract[section] || []).find((item) => item.name === name);
  if (["show", "preview", "validate"].includes(action)) {
    if (!existing) throw new CliError({ errorCode: `${section.slice(0, -1)}_not_found`, message: `${name} is not defined in ${file}.`, exitCode: 2 });
    const result = section === "capabilities" && action === "preview" ? capabilityPreview(existing as unknown as Json, loaded.contract) : existing;
    output(args, { ok: true, [singularDefinition(section)]: result }, keyValueLines(result));
    return 0;
  }
  if (!["create", "update", "remove"].includes(action)) throw usage(`${section} supports: list, show, create, update, remove${section === "capabilities" ? ", preview" : section === "workflows" ? ", validate" : ""}`);
  const value = action === "remove" ? undefined : await definitionInput(section, name, args);
  const result = await mutateDefinition(file, section, action as "create" | "update" | "remove", name, value);
  output(args, { ok: true, digest: canonicalJsonDigest(result.contract), changes: result.changes }, [`Updated ${file}`, `Digest: ${canonicalJsonDigest(result.contract)}`, ...renderSemanticDiff(result.changes)]);
  return 0;
}

async function apiKeyCommand(args: string[]): Promise<number> {
  const action = args[0] || "list";
  const remote = await remoteContext(args, true);
  if (action === "list") {
    const result = await paginatedGet(remote, "/v1/control/api-keys", args, "api_keys", { project_id: remote.projectId });
    outputList(args, result, "api_keys", (item) => `${string(item.key_id)}  ${string(item.name)}  ${string(item.role || stringArray(item.scopes).join(","))}  ${string(item.status)}  ${string(item.token_prefix)}`);
    return 0;
  }
  if (action === "show") {
    const id = positional(args, 1, "api-keys show requires <key-id>");
    const result = await remote.client.get(`/v1/control/api-keys/${encodeURIComponent(id)}?project_id=${encodeURIComponent(remote.projectId)}`);
    output(args, redact(result), keyValueLines(result.api_key || result));
    return 0;
  }
  if (action === "create") {
    const scopes = csv(requiredOption(args, "--scopes"));
    requiredOption(args, "--secret-file");
    const result = await remote.client.post("/v1/control/api-keys", {
      project_id: remote.projectId,
      name: requiredOption(args, "--name"),
      scopes,
      role: option(args, "--role") || scopesToLegacyRole(scopes),
      expires_at: epoch(option(args, "--expires-at")),
    }, { idempotencyKey: idempotency(args) });
    await outputOneTimeSecret(args, result, "token", "SYNAPSOR_API_KEY");
    return 0;
  }
  if (action === "rotate") {
    requiredOption(args, "--secret-file");
    const keyId = positional(args, 1, "api-keys rotate requires <key-id>");
    const result = await remote.client.post("/v1/control/api-keys/rotate", { project_id: remote.projectId, key_id: keyId, expires_at: epoch(option(args, "--expires-at")) }, { idempotencyKey: idempotency(args) });
    await outputOneTimeSecret(args, result, "token", "SYNAPSOR_API_KEY");
    return 0;
  }
  if (action === "revoke") {
    confirmMutation(args, "revoke this API key");
    const keyId = positional(args, 1, "api-keys revoke requires <key-id>");
    const result = await remote.client.post("/v1/control/api-keys/revoke", { project_id: remote.projectId, key_id: keyId }, { idempotencyKey: idempotency(args) });
    output(args, redact(result), [`Revoked API key ${keyId}.`]);
    return 0;
  }
  throw usage("api-keys supports: list, show, create, rotate, revoke");
}

async function runnerCommand(args: string[]): Promise<number> {
  const action = args[0] || "list";
  const remote = await remoteContext(args, true);
  if (action === "list") {
    const result = await paginatedGet(remote, `/v1/control/projects/${encodeURIComponent(remote.projectId)}/runners`, args, "runners");
    outputList(args, result, "runners", (item) => `${string(item.runner_id)}  ${string(item.status)}  ${string(item.runner_version)}  ${string(item.last_seen_at)}`);
    return 0;
  }
  if (["show", "doctor"].includes(action)) {
    const id = positional(args, 1, `runners ${action} requires <runner-id>`);
    const result = await remote.client.get(`/v1/control/projects/${encodeURIComponent(remote.projectId)}/runners/${encodeURIComponent(id)}${action === "doctor" ? "/doctor" : ""}`);
    output(args, redact(result), keyValueLines(result.runner || result));
    return 0;
  }
  if (action === "create") {
    const sourceIds = csv(requiredOption(args, "--sources"));
    const permissions = csv(option(args, "--permissions"));
    requiredOption(args, "--secret-file");
    const result = await remote.client.post(
      `/v1/control/projects/${encodeURIComponent(remote.projectId)}/runner-tokens`,
      {
        name: option(args, "--name") || "Runner",
        source_ids: sourceIds,
        ...(permissions.length > 0 ? { permissions } : {}),
      },
      { idempotencyKey: idempotency(args) },
    );
    await outputOneTimeSecret(args, result, "runner_token", "SYNAPSOR_RUNNER_TOKEN");
    return 0;
  }
  if (["rotate-token", "revoke-token"].includes(action)) {
    const tokenId = positional(args, 1, `runners ${action} requires <token-id>`);
    if (action === "rotate-token") requiredOption(args, "--secret-file");
    if (action === "revoke-token") confirmMutation(args, "revoke this Runner token");
    const operation = action === "rotate-token" ? "rotate" : "revoke";
    const result = await remote.client.post(`/v1/control/projects/${encodeURIComponent(remote.projectId)}/runner-tokens/${encodeURIComponent(tokenId)}/${operation}`, {}, { idempotencyKey: idempotency(args) });
    if (operation === "rotate") await outputOneTimeSecret(args, result, "runner_token", "SYNAPSOR_RUNNER_TOKEN");
    else output(args, redact(result), [`Revoked Runner token ${tokenId}.`]);
    return 0;
  }
  if (action === "bundle" && args[1] === "download") {
    const reference = positional(args, 2, "runners bundle download requires <contract/version>");
    const sourceId = requiredOption(args, "--source");
    const out = requiredOption(args, "--out");
    const { contractId, versionId } = splitVersionReference(reference, option(args, "--version"));
    await downloadAuthenticated(remote, `/v1/control/projects/${encodeURIComponent(remote.projectId)}/agent-contracts/${encodeURIComponent(contractId)}/versions/${encodeURIComponent(versionId)}/runner-bundle?download=1&source_id=${encodeURIComponent(sourceId)}`, out);
    output(args, { ok: true, out: path.resolve(out) }, [`Runner bundle written: ${path.resolve(out)}`, "Bundle is credential-free; supply SYNAPSOR_RUNNER_TOKEN separately."]);
    return 0;
  }
  throw usage("runners supports: list, show, create, rotate-token, revoke-token, bundle download, doctor");
}

async function proposalCommand(args: string[]): Promise<number> {
  const action = args[0] || "list";
  const remote = await remoteContext(args, true);
  if (action === "list") {
    const result = await paginatedGet(remote, `/v1/control/projects/${encodeURIComponent(remote.projectId)}/runner-activity`, args, "events", { status: option(args, "--status"), capability: option(args, "--capability"), lookup: option(args, "--lookup") });
    outputList(args, result, "events", (item) => `${string(item.proposal_id)}  ${string(item.capability)}  ${string(item.status)}  tenant=${string(item.tenant_id)}  principal=${shortFingerprint(item.principal)}`);
    return 0;
  }
  const proposalId = positional(args, 1, `proposals ${action} requires <proposal-id>`);
  if (["show", "decisions"].includes(action)) {
    const result = await remote.client.get(`/v1/control/projects/${encodeURIComponent(remote.projectId)}/runner-activity/${encodeURIComponent(proposalId)}`);
    const selected = action === "decisions" ? { ok: true, decisions: result.decisions || array(result.events).filter((event) => string(event.event_type).includes("decision")) } : result;
    output(args, redact(selected), keyValueLines(action === "show" ? result.proposal || result : selected));
    return 0;
  }
  if (["approve", "reject"].includes(action)) {
    if (remote.credentialKind !== "human") throw new CliError({ errorCode: "human_identity_required", message: "Proposal decisions require an authenticated human session; service API keys and Runner tokens cannot approve.", exitCode: 4 });
    confirmMutation(args, `${action} proposal ${proposalId}`);
    const reason = action === "reject" ? requiredOption(args, "--reason") : option(args, "--reason") || "Approved through Synapsor CLI";
    const result = await remote.client.post(`/v1/control/external-writebacks/proposals/${encodeURIComponent(proposalId)}/${action}`, { reason, project_id: remote.projectId }, { idempotencyKey: idempotency(args) });
    output(args, redact(result), [`Proposal ${proposalId}: ${action} recorded.`, "Approval records governance state only; the source changes only after a trusted Runner lease and guarded apply."]);
    return 0;
  }
  throw usage("proposals supports: list, show, approve, reject, decisions");
}

async function activityCommand(args: string[]): Promise<number> {
  const action = args[0] || "search";
  const remote = await remoteContext(args, true);
  if (action === "search") {
    const result = await paginatedGet(remote, `/v1/control/projects/${encodeURIComponent(remote.projectId)}/runner-activity`, args, "events", { lookup: option(args, "--lookup"), source_id: option(args, "--source"), status: option(args, "--status"), capability: option(args, "--capability"), from_time: option(args, "--from"), to_time: option(args, "--to") });
    outputList(args, result, "events", (item) => `${string(item.event_id)}  ${string(item.event_type)}  ${string(item.status)}  ${string(item.proposal_id)}`);
    return 0;
  }
  if (action === "show") {
    const id = positional(args, 1, "activity show requires <event-id or proposal-id>");
    const result = await remote.client.get(`/v1/control/projects/${encodeURIComponent(remote.projectId)}/runner-activity/${encodeURIComponent(id)}`);
    output(args, redact(result), keyValueLines(result));
    return 0;
  }
  throw usage("activity supports: search, show");
}

async function linkedResourceCommand(kind: "evidence" | "receipts", args: string[]): Promise<number> {
  if ((args[0] || "show") !== "show") throw usage(`${kind} supports: show`);
  const id = positional(args, 1, `${kind} show requires <id-or-proposal-id>`);
  const remote = await remoteContext(args, true);
  const result = await remote.client.get(`/v1/control/projects/${encodeURIComponent(remote.projectId)}/runner-activity/${encodeURIComponent(id)}`);
  const selected = kind === "evidence"
    ? { ok: true, residency: "metadata_only", evidence: result.evidence || object(result.proposal).evidence_metadata || array(result.events).flatMap((event) => stringArray(event.evidence_ids)) }
    : { ok: true, receipts: result.receipts || array(result.events).filter((event) => event.receipt_id).map((event) => ({ receipt_id: event.receipt_id, event_id: event.event_id, status: event.status })) };
  output(args, redact(selected), [kind === "evidence" ? "Evidence residency: metadata_only (payload remains local)" : "Receipt metadata", ...keyValueLines(selected)]);
  return 0;
}

async function replayCommand(args: string[]): Promise<number> {
  const action = args[0] || "show";
  if (!["show", "verify"].includes(action)) throw usage("replay supports: show, verify");
  const id = positional(args, 1, `replay ${action} requires <replay-id-or-proposal-id>`);
  const remote = await remoteContext(args, true);
  const result = await remote.client.get(`/v1/control/projects/${encodeURIComponent(remote.projectId)}/runner-activity/${encodeURIComponent(id)}`);
  const integrity = object(result.integrity);
  const selected = action === "verify" ? { ok: integrity.ok === true, integrity, boundary: "Cloud verifies hash-linked metadata and references; local replay payload verification remains with Runner." } : { ok: true, residency: "metadata_only", replay: result.replay || array(result.events).filter((event) => event.replay_id) };
  if (action === "verify" && selected.ok !== true) throw new CliError({ errorCode: "replay_integrity_not_verified", message: "Cloud replay reference integrity did not verify.", exitCode: 5, details: selected });
  output(args, redact(selected), keyValueLines(selected));
  return 0;
}

async function exportCommand(args: string[]): Promise<number> {
  const action = args[0] || "create";
  const remote = await remoteContext(args, true);
  if (action === "create") {
    const result = await remote.client.post("/v1/control/audit-export", { project_id: remote.projectId, format: option(args, "--format") || "jsonl", filters: filters(args) }, { idempotencyKey: idempotency(args) });
    output(args, redact(result), keyValueLines(result.export || result));
    return 0;
  }
  if (action === "status") {
    const id = positional(args, 1, "exports status requires <export-id>");
    const result = await remote.client.get(`/v1/control/audit-export/${encodeURIComponent(id)}?project_id=${encodeURIComponent(remote.projectId)}`);
    output(args, redact(result), keyValueLines(result.export || result));
    return 0;
  }
  if (action === "download") {
    const id = positional(args, 1, "exports download requires <export-id>");
    const out = requiredOption(args, "--out");
    await downloadAuthenticated(remote, `/v1/control/audit-export/${encodeURIComponent(id)}/download?project_id=${encodeURIComponent(remote.projectId)}`, out);
    output(args, { ok: true, out: path.resolve(out) }, [`Export written: ${path.resolve(out)}`]);
    return 0;
  }
  throw usage("exports supports: create, status, download");
}

async function remoteContext(args: string[], projectRequired: boolean): Promise<RemoteContext> {
  const profiles = await readProfiles();
  const profileName = safeProfileName(option(args, "--profile") || profiles.active_profile || "default");
  const profile = profiles.profiles[profileName];
  if (!profile) throw new CliError({ errorCode: "profile_not_found", message: `Cloud profile ${profileName} does not exist.`, exitCode: 2 });
  const apiUrl = cleanApiUrl(option(args, "--api-url") || process.env.SYNAPSOR_CLOUD_BASE_URL || profile.api_url);
  const credential = await resolveCredential(profile).catch((error) => { throw normalizeError(error); });
  if (credential.value.startsWith("syn_run_")) {
    throw new CliError({
      errorCode: "runner_token_not_cloud_cli_credential",
      message: "Runner tokens authenticate only synapsor-runner machine protocol operations. Use a human login or scoped SYNAPSOR_API_KEY with the Cloud CLI.",
      exitCode: 3,
    });
  }
  const projectId = option(args, "--project") || process.env.SYNAPSOR_PROJECT_ID || profile.project_id || "";
  const workspaceId = option(args, "--workspace") || process.env.SYNAPSOR_WORKSPACE_ID || profile.workspace_id || "";
  if (projectRequired && !projectId) throw usage("a project is required; pass --project or run synapsor projects use <project>");
  return {
    client: new CloudControlClient({ baseUrl: apiUrl, credential: credential.value, credentialKind: credential.kind, userAgent: `synapsor-cli/${manifest.version}` }),
    profileName,
    profile,
    profiles,
    projectId,
    workspaceId,
    apiUrl,
    credentialKind: credential.kind,
  };
}

async function updateSelection(args: string[], patch: Partial<CloudProfile>): Promise<void> {
  const document = await readProfiles();
  const name = safeProfileName(option(args, "--profile") || document.active_profile || "default");
  const current = document.profiles[name] || { api_url: "https://dev-api.synapsor.ai" };
  await upsertProfile(name, { ...current, ...patch });
}

async function definitionInput(section: "contexts" | "capabilities" | "workflows", name: string, args: string[]): Promise<Json> {
  const fromFile = option(args, "--from-file");
  if (fromFile) {
    const parsed = JSON.parse(await fs.readFile(path.resolve(fromFile), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw usage("--from-file must contain one JSON object");
    return { ...parsed, name };
  }
  if (has(args, "--no-interactive") && section !== "contexts" && !option(args, "--context")) throw usage("non-interactive authoring requires --from-file or complete structured flags");
  if (section === "contexts") {
    const tenantBinding = option(args, "--tenant-binding") || "tenant_id";
    const principalBinding = option(args, "--principal-binding") || "principal";
    const source = (option(args, "--binding-source") || "http_claim") as "session" | "environment" | "cloud_session" | "static_dev" | "http_claim";
    return {
      name,
      bindings: [
        { name: tenantBinding, source, key: option(args, "--tenant-key") || tenantBinding, required: true },
        { name: principalBinding, source, key: option(args, "--principal-key") || (source === "http_claim" ? "sub" : principalBinding), required: true },
      ],
      tenant_binding: tenantBinding,
      principal_binding: principalBinding,
    };
  }
  if (section === "capabilities") {
    const kind = option(args, "--kind") || "read";
    const visible = csv(requiredOption(args, "--visible-fields"));
    const primaryKey = requiredOption(args, "--primary-key");
    const lookupArg = option(args, "--lookup-arg") || `${primaryKey}_value`;
    const subject: Json = {
      schema: requiredOption(args, "--schema"),
      table: requiredOption(args, "--table"),
      primary_key: primaryKey,
      tenant_key: requiredOption(args, "--tenant-key"),
      ...(option(args, "--principal-scope-key") ? { principal_scope_key: option(args, "--principal-scope-key") } : {}),
      ...(option(args, "--conflict-key") ? { conflict_key: option(args, "--conflict-key") } : {}),
    };
    return {
      name,
      kind,
      context: requiredOption(args, "--context"),
      source: requiredOption(args, "--source"),
      subject,
      args: { [lookupArg]: { type: "string", required: true, max_length: 128 } },
      lookup: { id_from_arg: lookupArg },
      visible_fields: visible,
      kept_out_fields: csv(option(args, "--kept-out-fields")),
      evidence: { required: true, query_audit: true },
      max_rows: 1,
    };
  }
  return { name, context: requiredOption(args, "--context"), allowed_capabilities: csv(requiredOption(args, "--capabilities")), required_evidence: true };
}

function capabilityPreview(capability: Json, contract: SynapsorContract): Json {
  const context = contract.contexts.find((item) => item.name === capability.context);
  const subject = object(capability.subject);
  return {
    name: capability.name,
    kind: capability.kind,
    model_arguments: Object.keys(object(capability.args)),
    visible_fields: capability.visible_fields || [],
    kept_out_fields: capability.kept_out_fields || [],
    tenant_scope: { column: subject.tenant_key || "resource tenant key", binding: context?.tenant_binding, trusted: true },
    principal_scope: subject.principal_scope_key ? { column: subject.principal_scope_key, binding: context?.principal_binding, trusted: true, composition: "AND tenant" } : { configured: false },
    proposal: capability.proposal,
    warning: "Schema inspection and field names are not complete data classification. Review every visible and kept-out field.",
  };
}

async function findRemoteContractByName(remote: RemoteContext, name: string): Promise<Json | undefined> {
  if (!name) return undefined;
  const result = await remote.client.get(`/v1/control/projects/${encodeURIComponent(remote.projectId)}/agent-contracts?limit=100`);
  return array(result.contracts).find((item) => string(item.name) === name);
}

async function latestRemoteContract(remote: RemoteContext, contractId: string): Promise<SynapsorContract | undefined> {
  const detail = await remote.client.get(`/v1/control/projects/${encodeURIComponent(remote.projectId)}/agent-contracts/${encodeURIComponent(contractId)}`);
  const versions = array(detail.versions);
  const latest = versions.at(-1);
  if (!latest) return undefined;
  return fetchRemoteContract(remote, `${contractId}/${string(latest.contract_version_id)}`);
}

async function fetchRemoteContract(remote: RemoteContext, reference: string): Promise<SynapsorContract> {
  const { contractId, versionId } = splitVersionReference(reference);
  const result = await remote.client.get(`/v1/control/projects/${encodeURIComponent(remote.projectId)}/agent-contracts/${encodeURIComponent(contractId)}/versions/${encodeURIComponent(versionId)}`);
  const version = object(result.version);
  const contract = normalizeContract(version.contract);
  if (canonicalJsonDigest(contract) !== string(version.digest)) throw new CliError({ errorCode: "contract_digest_mismatch", message: `Cloud version ${reference} failed digest verification.`, exitCode: 5 });
  return contract;
}

async function outputOneTimeSecret(args: string[], result: Json, key: string, envName: string): Promise<void> {
  const secret = string(result[key]);
  if (!secret && result.secret_available === false) {
    const safe = object(redact(result));
    output(args, safe, [...keyValueLines(safe), "The one-time secret was already issued. Rotate the credential if the original response was lost."]);
    return;
  }
  if (!secret) throw new CliError({ errorCode: "one_time_secret_missing", message: "Cloud did not return the expected one-time secret." });
  const secretFile = option(args, "--secret-file");
  if (secretFile) {
    await atomicSecret(secretFile, secret);
    const safe = object(redact(result));
    output(args, { ...safe, secret_file: path.resolve(secretFile) }, [`Secret written once to ${path.resolve(secretFile)} (mode 0600).`, `Use: export ${envName}="$(cat ${path.resolve(secretFile)})"`]);
    return;
  }
  throw new CliError({
    errorCode: "secret_output_destination_required",
    message: `One-time ${envName} material requires --secret-file <path>; Cloud CLI never prints credential values to stdout.`,
    exitCode: 2,
  });
}

async function downloadAuthenticated(remote: RemoteContext, apiPath: string, out: string): Promise<void> {
  const credential = await resolveCredential(remote.profile);
  const response = await fetch(new URL(apiPath, `${remote.apiUrl}/`), { headers: { authorization: `Bearer ${credential.value}`, accept: "application/octet-stream" } });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as Json;
    throw normalizeError(new CloudControlError({ error_code: string(payload.error || `http_${response.status}`), message: string(payload.message || "Download failed."), retryable: false, status: response.status }));
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await atomicBinaryOutput(out, bytes);
}

async function anonymousRequest(apiUrl: string, route: string, body: Json): Promise<Json> {
  const response = await fetch(new URL(route, `${apiUrl}/`), { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": `synapsor-cli/${manifest.version}` }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({})) as Json;
  if (!response.ok || payload.ok === false) throw new CliError({ errorCode: string(payload.error || `http_${response.status}`), message: string(payload.message || `Cloud authorization request failed (${response.status}).`), exitCode: response.status === 401 ? 3 : 1, retryable: payload.retryable === true, retryAfterMs: number(payload.retry_after_ms, undefined) });
  return payload;
}

function writeHelp(args: string[]): void {
  const positionals = args.filter((item) => item && !item.startsWith("-"));
  const group = positionals[0];
  if (group) {
    const commands = COMMAND_HELP[group];
    if (!commands) {
      process.stdout.write(`Unknown command group: ${group}\n\nRun synapsor --help for the command index.\n`);
      return;
    }
    const action = positionals[1];
    const selected = action ? commands.filter(([syntax]) => syntax === action || syntax.startsWith(`${action} `)) : commands;
    const shown = selected.length ? selected : commands;
    const heading = action && selected.length ? `synapsor ${group} ${action}` : `synapsor ${group}`;
    process.stdout.write(`${heading}\n\n${shown.map(([syntax, description]) => `  synapsor ${group}${syntax ? ` ${syntax}` : ""}\n      ${description}`).join("\n")}\n\nCommon options:\n  --profile <name>       Select a local non-secret profile\n  --project <id>         Override selected project\n  --api-url <url>        Explicit Cloud API override\n  --json                 Stable machine-readable output\n  --no-interactive       Never wait for input\n  --idempotency-key <id> Caller-supplied retry identity for mutations\n\nSecrets are accepted only through secure references, never flag values.\n`);
    return;
  }
  process.stdout.write(`Synapsor Cloud CLI ${manifest.version}\n\nUse synapsor-runner for the local MCP/database safety boundary.\nUse synapsor for Cloud administration, review, and audit.\n\nCommands:\n${GROUPS.map(([name, description]) => `  ${name.padEnd(14)} ${description}`).join("\n")}\n\nGlobal options:\n  --profile <name>       Select a local non-secret profile\n  --project <id>         Override selected project\n  --api-url <url>        Explicit Cloud API override\n  --json                 Stable machine-readable output\n  --no-interactive       Never wait for input\n\nAuthentication:\n  SYNAPSOR_API_KEY              Scoped service principal for CI\n  SYNAPSOR_CLOUD_ACCESS_TOKEN   Human access token reference\n\nDatabase URLs and Runner tokens are never Cloud CLI credentials.\n`);
}

function output(args: string[], json: unknown, lines: string[]): void {
  if (has(args, "--json")) process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
  else process.stdout.write(`${lines.filter(Boolean).join("\n")}\n`);
}

function outputList(args: string[], result: Json, key: string, render: (item: Json) => string): void {
  const items = array(result[key]);
  const lines = listLines(items, render);
  const showing = result.total === undefined ? `Showing ${items.length}` : `Showing ${items.length} of ${number(result.total, items.length)}`;
  output(args, redact(result), [...lines, showing, ...(result.next_cursor ? [`Next cursor: ${string(result.next_cursor)}`] : [])]);
}

function listLines(items: Json[], render: (item: Json) => string): string[] {
  return items.length ? items.map(render) : ["No matching records."];
}

function keyValueLines(value: unknown): string[] {
  const record = object(value);
  return Object.entries(record).filter(([, item]) => typeof item !== "object" || item === null).map(([key, item]) => `${key}: ${String(item ?? "")}`);
}

function inspectLines(value: Json): string[] {
  return [`Contract: ${string(value.name || "unnamed")}`, `Spec: ${string(value.spec_version)}`, `Digest: ${string(value.digest)}`, `Contexts: ${array(value.contexts).length}`, `Capabilities: ${array(value.capabilities).length}`, `Workflows: ${array(value.workflows).length}`];
}

function identityLines(result: Json, remote: RemoteContext): string[] {
  const session = object(result.context || result.session || result.identity || result);
  return [`Profile: ${remote.profileName}`, `Auth: ${remote.credentialKind}`, `Identity: ${string(session.email || session.actor || session.key_id || "authenticated")}`, `Project: ${remote.projectId || string(session.project_id) || "not selected"}`, `Expires: ${string(session.expires_at || "not reported")}`];
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "string") return redactString(value);
  if (!value || typeof value !== "object") return value;
  const result: Json = {};
  for (const [key, item] of Object.entries(value as Json)) {
    const normalized = key.toLowerCase();
    if (
      (["access_token", "refresh_token", "session_token", "secret", "token_hash", "password", "private_key", "database_url", "read_url", "write_url", "connection_url", "authorization"].includes(normalized))
      || (normalized === "token" && typeof item === "string")
      || normalized.endsWith("_secret")
      || normalized.endsWith("_password")
      || normalized.endsWith("_private_key")
    ) {
      result[key] = "[REDACTED]";
    } else result[key] = redact(item);
  }
  return result;
}

function redactString(value: string): string {
  if (/^syn_[A-Za-z0-9_-]{20,}$/.test(value) || /^Bearer\s+[A-Za-z0-9._~+/=-]{12,}$/i.test(value)) return "[REDACTED]";
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? "redacted" : "";
      parsed.password = parsed.password ? "redacted" : "";
      return parsed.toString();
    }
  } catch {
    // Ordinary text is not a URL and is returned unchanged.
  }
  return value;
}

function normalizeError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof CloudControlError) {
    const exitCode = error.status === 401 ? 3 : error.status === 403 ? 4 : error.status === 409 ? 5 : error.retryable ? 6 : error.status >= 500 ? 7 : 1;
    return new CliError({ errorCode: error.error_code, message: error.message, exitCode, retryable: error.retryable, retryAfterMs: error.retry_after_ms, requestId: error.request_id, details: error.details });
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = message.split(":", 1)[0]?.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase() || "internal_error";
  return new CliError({ errorCode: code, message, exitCode: code.includes("validation") || code.includes("required") || code.includes("invalid") ? 2 : 1 });
}

function printFailure(error: unknown, argv: string[]): number {
  const normalized = normalizeError(error);
  if (has(argv, "--json")) {
    process.stdout.write(`${JSON.stringify({ error_code: normalized.errorCode, message: normalized.message, retryable: normalized.retryable, ...(normalized.retryAfterMs === undefined ? {} : { retry_after_ms: normalized.retryAfterMs }), ...(normalized.requestId ? { request_id: normalized.requestId } : {}), ...(normalized.details ? { details: redact(normalized.details) } : {}) }, null, 2)}\n`);
  } else {
    process.stderr.write(`ERROR ${normalized.errorCode}: ${normalized.message}${normalized.requestId ? `\nRequest: ${normalized.requestId}` : ""}\n`);
  }
  return normalized.exitCode;
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0) return "";
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw usage(`${name} requires a value`);
  return value;
}

function requiredOption(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw usage(`${name} is required`);
  return value;
}

function positional(args: string[], index: number, message: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw usage(message);
  return value;
}

function has(args: string[], name: string): boolean { return args.includes(name); }
function string(value: unknown): string { return value === null || value === undefined ? "" : String(value); }
function number(value: unknown, fallback: number | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback as number;
}
function object(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function array(value: unknown): Json[] { return Array.isArray(value) ? value.filter((item): item is Json => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function csv(value: string): string[] { return value.split(",").map((item) => item.trim()).filter(Boolean); }
function epoch(value: string): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw usage("timestamp must be epoch seconds or an ISO date");
  return Math.floor(parsed / 1_000);
}
function shortFingerprint(value: unknown): string { const text = string(value); return /^sha256:[a-f0-9]{32,}$/i.test(text) ? `${text.slice(0, 22)}...` : "not recorded"; }
function usage(message: string): CliError { return new CliError({ errorCode: "usage_error", message, exitCode: 2 }); }
function idempotency(args: string[], fallback = ""): string { return option(args, "--idempotency-key") || fallback || `cli-${Date.now()}-${process.pid}`; }
function confirmMutation(args: string[], operation: string): void { if (!has(args, "--yes")) throw usage(`confirmation required to ${operation}; rerun with --yes after reviewing the target`); }
function scopesToLegacyRole(scopes: string[]): string { return scopes.some((scope) => /manage|activate|write/.test(scope)) ? "developer" : "readonly"; }
function singularDefinition(section: "contexts" | "capabilities" | "workflows"): "context" | "capability" | "workflow" {
  return section === "contexts" ? "context" : section === "capabilities" ? "capability" : "workflow";
}
function isLocalPath(value: string | undefined): boolean { return Boolean(value && (value.endsWith(".json") || value.endsWith(".synapsor") || value.endsWith(".synapsor.sql"))); }

async function paginatedGet(
  remote: RemoteContext,
  route: string,
  args: string[],
  itemKey: string,
  extra: Record<string, string | undefined> = {},
): Promise<Json> {
  const fetchAll = has(args, "--all");
  const limit = positiveIntegerOption(args, "--limit", fetchAll ? 100 : 50, 500);
  let cursor = option(args, "--cursor");
  if (!fetchAll) return remote.client.get(withQuery(route, { ...extra, limit: String(limit), cursor }));

  const maxItems = positiveIntegerOption(args, "--max-items", 10_000, 100_000);
  if (maxItems > 10_000 && !has(args, "--allow-large-result")) {
    throw usage("--max-items above 10000 requires --allow-large-result after reviewing memory and export size");
  }
  const seenCursors = new Set<string>();
  const items: Json[] = [];
  let finalPage: Json = { ok: true };
  for (let pageNumber = 0; pageNumber < 1_000; pageNumber += 1) {
    if (cursor) {
      if (seenCursors.has(cursor)) throw new CliError({ errorCode: "pagination_cursor_cycle", message: "Cloud returned a repeated pagination cursor.", exitCode: 5 });
      seenCursors.add(cursor);
    }
    const page = await remote.client.get(withQuery(route, { ...extra, limit: String(limit), cursor }));
    finalPage = page;
    const pageItems = array(page[itemKey]);
    if (items.length + pageItems.length > maxItems) {
      throw new CliError({
        errorCode: "pagination_bound_exceeded",
        message: `--all exceeded the ${maxItems} item safety bound; narrow the filters or raise --max-items deliberately.`,
        exitCode: 2,
      });
    }
    items.push(...pageItems);
    const next = string(page.next_cursor);
    if (!next) return { ...finalPage, [itemKey]: items, next_cursor: null, fetched_all: true };
    cursor = next;
  }
  throw new CliError({ errorCode: "pagination_page_bound_exceeded", message: "Cloud pagination exceeded 1000 pages.", exitCode: 5 });
}

function listQuery(args: string[]): Record<string, string> {
  return {
    limit: String(positiveIntegerOption(args, "--limit", has(args, "--all") ? 100 : 50, 500)),
    cursor: option(args, "--cursor"),
  };
}

function positiveIntegerOption(args: string[], name: string, fallback: number, maximum: number): number {
  const raw = option(args, name);
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw usage(`${name} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw usage(`${name} must be between 1 and ${maximum}`);
  return parsed;
}

function filters(args: string[]): Json {
  return { from_time: option(args, "--from"), to_time: option(args, "--to"), capability: option(args, "--capability"), status: option(args, "--status"), source_id: option(args, "--source") };
}

function withQuery(route: string, values: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) query.set(key, value);
  const encoded = query.toString();
  return encoded ? `${route}?${encoded}` : route;
}

function splitVersionReference(reference: string, explicitVersion = ""): { contractId: string; versionId: string } {
  const [contractId, inlineVersion] = reference.split("/", 2);
  const versionId = explicitVersion || inlineVersion;
  if (!contractId || !versionId) throw usage("use <contract-id>/<version-id> or pass --version <version-id>");
  return { contractId, versionId };
}

function cleanApiUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/$/, "");
  } catch {
    throw usage("--api-url must be an HTTP(S) origin without credentials, query, or fragment");
  }
}

async function atomicOutput(file: string, content: string): Promise<void> {
  const resolved = path.resolve(file);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, resolved);
}

async function atomicBinaryOutput(file: string, content: Uint8Array): Promise<void> {
  const resolved = path.resolve(file);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content);
  await fs.rename(temporary, resolved);
}

async function atomicSecret(file: string, secret: string): Promise<void> {
  const resolved = path.resolve(file);
  await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${secret}\n`, { mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, resolved);
  await fs.chmod(resolved, 0o600);
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

const invokedPath = process.argv[1]
  ? await fs.realpath(process.argv[1]).catch(() => path.resolve(process.argv[1]!))
  : "";
const invokedDirectly = invokedPath === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { process.exitCode = printFailure(error, process.argv.slice(2)); });
}
