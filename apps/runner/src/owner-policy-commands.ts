import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { resolveRuntimeConfig, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import { createTerminalAnalyticsShellIo } from "./analytics-shell.js";
import type { OwnerPolicyReviewIo } from "./owner-policy-review-ui.js";
import { safeTerminalText } from "./analytics-shell-render.js";
import { assertKnownOptions, optionalArg } from "./cli-options.js";
import { readRuntimeConfig, runnerConfigPath } from "./cli-project.js";
import { readJsonFileWithLocation } from "./cli-files.js";
import { openProjectControlPolicies } from "./control-policy-store.js";
import { previewProjectControlPolicyMigration, migrateProjectControlPoliciesFromProject } from "./control-policy-project-migration.js";
import { createOperatorParentReview } from "./owner-policy-parent-review.js";
import { parentReviewLines } from "./owner-policy-parent-summary.js";
import { renderTerminalJson } from "./terminal-syntax.js";
import { terminalContentWidth, wrapStyledTerminalLine } from "./terminal-layout.js";

/** Optional deployment-operator bootstrap; ordinary Boundary onboarding does
 * not require owner delegation or an identity-provider setup. */
export async function ownerPolicyCommand(args: string[], dependencies: {
  io?: OwnerPolicyReviewIo; env?: NodeJS.ProcessEnv;
} = {}): Promise<number> {
  const [mode, ...rest] = args;
  if (mode === "connection") return ownerConnectionCommand(rest, dependencies);
  if (mode === "approver") return approverConfigurationCommand(rest, dependencies);
  if (mode !== "storage" && mode !== "delegation") throw new Error("policy requires storage or delegation for owner-rule setup.");
  assertKnownOptions(rest, new Set(["--config", "--project-root", "--store", "--input", "--name"]), `policy ${mode}`);
  const configPath = runnerConfigPath(rest);
  const loadConfig = async () => {
    try { return await readRuntimeConfig(configPath, { env: dependencies.env, storePath: optionalArg(rest, "--store") }); }
    catch (error) {
      // Only storage recovery may read configuration while the governed store
      // is frozen mid-import. No runtime or parent grant uses this fallback.
      if (mode !== "storage" || (error as { code?: unknown })?.code !== "POLICY_MIGRATION_PENDING") throw error;
      const raw = await readJsonFileWithLocation<RuntimeConfig>(configPath, "Runner config");
      const resolved = resolveRuntimeConfig(raw, path.dirname(path.resolve(configPath)));
      if (!validateRunnerCapabilityConfig(resolved).ok) throw new Error("Runner configuration is invalid. Repair it before recovering policy storage; no authority was changed.");
      return resolved;
    }
  };
  const config = await loadConfig();
  const projectRoot = path.resolve(optionalArg(rest, "--project-root") ?? config.action_rules?.project_root ?? path.dirname(path.resolve(configPath)));
  const storePath = path.resolve(optionalArg(rest, "--store") ?? path.resolve(projectRoot, config.storage?.sqlite_path ?? ".synapsor/local.db"));
  const env = dependencies.env ?? process.env;
  const actor = `local:${os.userInfo().username}`;
  if (mode === "delegation" && !optionalArg(rest, "--input")) {
    const { runOperatorParentChat } = await import("./owner-policy-parent-chat.js");
    return runOperatorParentChat({ projectRoot, config, configPath, storePath,
      name: optionalArg(rest, "--name") ?? config.action_rules?.owner_management?.parent_name ?? "agent_rules",
      env, actor, recheckConfig: async () => {
        if (canonicalJsonDigest(await loadConfig()) !== canonicalJsonDigest(config)) throw new Error("Runner configuration changed. Review again; no parent change was confirmed.");
      } }, { io: dependencies.io });
  }
  const terminal = dependencies.io ? undefined : createTerminalAnalyticsShellIo({ slashCommands: false });
  const io = dependencies.io ?? terminal!;
  const write = (lines: string[]) => io.write(lines.flatMap((line) => wrapStyledTerminalLine(safeTerminalText(line), terminalContentWidth(io.columns()))).join("\n") + "\n");
  const recheckConfig = async () => {
    if (canonicalJsonDigest(await loadConfig()) !== canonicalJsonDigest(config)) {
      throw new Error("Runner configuration changed during review. Review again; this confirmation was not applied.");
    }
  };
  try {
    if (mode === "storage") {
      if (optionalArg(rest, "--input") || optionalArg(rest, "--name")) throw new Error("policy storage does not accept --input or --name.");
      const preview = await previewProjectControlPolicyMigration({ projectRoot, config, storePath, env });
      if (preview.status === "already_migrated") { write(["Policy storage is already configured. Current authority remains unchanged."]); return 0; }
      if (preview.status === "migration_pending") {
        await recheckConfig();
        const result = await migrateProjectControlPoliciesFromProject({ projectRoot, config, storePath, env, actor, preview });
        await result.binding.close();
        write(["Previously reviewed policy-storage migration recovered. No new permission was granted."]);
        return 0;
      }
      const counts = (state: "active" | "drafts") => ["read", "action", "execution"].map((kind) =>
        `${preview.snapshot[state].filter((entry) => entry.kind === kind && entry.revision_id !== null).length} ${kind}`).join(", ");
      write(["Review policy storage", `Existing active authority: ${counts("active")}`, `Saved drafts: ${counts("drafts")}`,
        `Destination: ${storageDescription(config, storePath)}`,
        "The reviewed store becomes authoritative. Existing grants, digests and saved review decisions stay unchanged.",
        "Files become exports/recovery inputs, not a second writable source of active authority. No source row changes."]);
      if (!await confirm(io, "Move this exact existing authority into the reviewed store", preview.snapshot)) return 0;
      await recheckConfig();
      const result = await migrateProjectControlPoliciesFromProject({ projectRoot, config, storePath, env, actor, preview });
      await result.binding.close();
      write(["Policy storage ready. Existing authority was preserved; no new permission or source write was granted."]);
      return 0;
    }
    const file = optionalArg(rest, "--input"), name = optionalArg(rest, "--name") ?? config.action_rules?.owner_management?.parent_name;
    if (!file || !name) throw new Error("policy delegation requires --input <reviewed-parent.json> and --name <parent-name>. This is trusted operator configuration, not a model-supplied identity grant.");
    const size = (await fs.stat(file)).size;
    if (size > 262_144) throw new Error("The delegation document exceeds the 256 KiB operator review limit.");
    const contents = await fs.readFile(file, "utf8");
    if (Buffer.byteLength(contents) > 262_144) throw new Error("The delegation document changed beyond the review limit.");
    const document: unknown = JSON.parse(contents);
    const binding = await openProjectControlPolicies({ projectRoot, config, storePath, env });
    if (!binding) throw new Error("First run policy storage for this project and review the exact existing authority migration. No parent permission was added.");
    try {
      const service = createOperatorParentReview({ projectRoot, binding, config, actor });
      const review = await service.prepare(name, document);
      write(parentReviewLines(review, io.columns()));
      if (!await confirm(io, "Enable these exact owner-management and agent bindings", review)) { service.cancel(review); return 0; }
      await recheckConfig();
      const result = await service.confirm(review);
      write([result.changed ? "Owner delegation configuration activated." : "This exact owner delegation configuration is already active.",
        "Owners can draft only within these permissions. Their policies still need separate authenticated human review.",
        "Source changes require current Read, Action, owner and execution authority; this setup does not execute anything.",
        "Next: run policy connection with your backend's sign-in configuration, then use local Ask or stdio MCP."]);
      return 0;
    } finally { await binding.close(); }
  } finally { terminal?.close(); }
}

async function approverConfigurationCommand(args: string[], dependencies: { io?: OwnerPolicyReviewIo; env?: NodeJS.ProcessEnv }): Promise<number> {
  assertKnownOptions(args, new Set(["--config", "--project-root", "--store", "--input", "--previous-config"]), "policy approver");
  // This is the existing local deployment-operator management boundary, not
  // an agent, reviewer, or noninteractive development-identity decision.
  if (!dependencies.io && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error("POLICY_APPROVER_INTERACTIVE_ADMIN_REQUIRED: use the local deployment-operator terminal; no approver authority was changed.");
  }
  const configPath = path.resolve(runnerConfigPath(args));
  const raw = await readJsonFileWithLocation<RuntimeConfig>(configPath, "Runner config");
  const resolved = resolveRuntimeConfig(raw, path.dirname(configPath));
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? resolved.action_rules?.project_root ?? path.dirname(configPath));
  const file = optionalArg(args, "--input");
  let identity: unknown;
  if (file) {
    if ((await fs.stat(file)).size > 65_536) throw new Error("Approver roster exceeds the 64 KiB local review limit.");
    const text = await fs.readFile(file, "utf8");
    if (Buffer.byteLength(text) > 65_536) throw new Error("Approver roster changed beyond the review limit.");
    const document: unknown = JSON.parse(text);
    if (!document || typeof document !== "object" || Array.isArray(document)
      || Object.keys(document).length !== 1 || !Object.hasOwn(document, "operator_identity")) {
      throw new Error("POLICY_APPROVER_INPUT_INVALID: --input must contain only operator_identity.");
    }
    identity = (document as { operator_identity: unknown }).operator_identity;
  }
  const { prepareApproverPolicyConfiguration } = await import("./approver-policy-configuration.js");
  const prepared = await prepareApproverPolicyConfiguration({ projectRoot, configPath, identity,
    previousConfigPath: optionalArg(args, "--previous-config"), storePath: optionalArg(args, "--store"), env: dependencies.env });
  const terminal = dependencies.io ? undefined : createTerminalAnalyticsShellIo({ slashCommands: false });
  const io = dependencies.io ?? terminal!;
  const write = (lines: string[]) => io.write(lines.flatMap((line) => wrapStyledTerminalLine(safeTerminalText(line), terminalContentWidth(io.columns()))).join("\n") + "\n");
  try {
    const review = prepared.review;
    write(["Review scoped verified approver configuration",
      "Authority for this first-use transition: the interactive local deployment-operator account owns this project and its control-store process. This is local administration, not a cryptographically verified reviewer or dev identity.",
      `Existing deployment revision: ${review.epoch}; exact operation: ${review.digest}`,
      ...(review.recovery ? ["The prior execution binding was proven from the supplied previous configuration."] : []),
      ...review.roster.map((item) => `${item.subject}: roles ${item.roles.join(", ")}; outcomes ${item.outcomes.join(", ")}; public key ${item.public_key_fingerprint}`),
      ...review.role_scopes.map((item) => `${item.outcome}: approval role ${item.required_role}`),
      `Affected execution outcomes: ${review.affected_outcomes.join(", ") || "none"}`,
      "Saving this revision disables affected supervised execution. Review writer, receipt and Action prerequisites separately before enabling it again.",
      "Historical proposals, approvals and queues retain their original bindings. This does not run or publish a business Action."]);
    if (!await confirm(io, "Save this exact approver revision and leave execution disabled", review)) return 0;
    await prepared.confirm(review.digest);
    write(["Approver configuration reviewed and saved; execution remains disabled.",
      "Next: use Action review to verify writer and receipt posture, then separately authorize execution under the new identity binding."]);
    return 0;
  } finally { terminal?.close(); await prepared.close(); }
}

async function confirm(io: OwnerPolicyReviewIo, label: string, details: unknown): Promise<boolean> {
  while (true) {
    const answer = io.choose ? await io.choose({ title: "REVIEW OPERATOR DECISION", message: "Only the exact reviewed configuration can be applied.",
      initialValue: "cancel", options: [{ value: "confirm", label }, { value: "details", label: "Inspect complete exact configuration" },
        { value: "cancel", label: "Leave unchanged" }] })
      : await io.read("Type confirm to apply this exact review, details to inspect, or press Enter to leave unchanged: ");
    if (answer === "details") {
      const lines = renderTerminalJson(details, io.isTerminal?.() === true && !("NO_COLOR" in process.env)).split("\n");
      if (io.review) await io.review("Exact operator configuration", lines, "Operator decision");
      else io.write(lines.join("\n") + "\n");
      continue;
    }
    if (answer === "confirm") return true;
    io.write("Configuration left unchanged. No authority was granted.\n");
    return false;
  }
}

function storageDescription(config: RuntimeConfig, storePath: string): string {
  return config.storage?.shared_postgres?.mode === "runtime_store" ? "configured PostgreSQL control store (not the source database)" : storePath;
}

async function ownerConnectionCommand(args: string[], dependencies: { io?: OwnerPolicyReviewIo; env?: NodeJS.ProcessEnv }): Promise<number> {
  assertKnownOptions(args, new Set(["--config", "--project-root", "--store", "--input", "--previous-config"]), "policy connection");
  const configPath = path.resolve(runnerConfigPath(args));
  const raw = await readJsonFileWithLocation<RuntimeConfig>(configPath, "Runner config");
  const resolved = resolveRuntimeConfig(raw, path.dirname(configPath));
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? resolved.action_rules?.project_root ?? path.dirname(configPath));
  const file = optionalArg(args, "--input");
  let connections: unknown;
  if (file) {
    if ((await fs.stat(file)).size > 65_536) throw new Error("Owner sign-in configuration exceeds the 64 KiB limit. Use environment-variable names, never credential values.");
    const contents = await fs.readFile(file, "utf8");
    if (Buffer.byteLength(contents) > 65_536) throw new Error("Owner sign-in configuration changed beyond the review limit.");
    connections = JSON.parse(contents);
  }
  const { prepareOwnerConnectionReview } = await import("./owner-policy-connection.js");
  const prepared = await prepareOwnerConnectionReview({ projectRoot, configPath, connections,
    previousConfigPath: optionalArg(args, "--previous-config"), storePath: optionalArg(args, "--store"),
    env: dependencies.env, actor: `local:${os.userInfo().username}` });
  const terminal = dependencies.io ? undefined : createTerminalAnalyticsShellIo({ slashCommands: false });
  const io = dependencies.io ?? terminal!;
  const write = (lines: string[]) => io.write(lines.flatMap((line) => wrapStyledTerminalLine(safeTerminalText(line), terminalContentWidth(io.columns()))).join("\n") + "\n");
  try {
    const review = prepared.review, management = review.after.owner_management, workload = review.after.owner_delegation;
    write(["Review owner sign-ins", ...(review.recovery ? ["The previous execution binding is verified. Only owner sign-in settings changed."] : []),
      ...(management ? [`Owner chat: ${management.parent_name} / ${management.policy_name} (${management.scope})`,
        `Assistant: ${management.authentication.issuer} -> ${management.authentication.audience}; token from ${management.credential_env}`,
        `Separate human review: ${management.human_review.audience}; token from ${management.human_review.credential_env}`] : []),
      ...(workload ? [`Agent execution sign-in: ${workload.parent_name}; ${workload.authentication.audience}; token from ${workload.credential_env}`]
        : ["Agent execution sign-in: not configured here. Owner chat alone does not bind source requests to an owner policy."]),
      "Backend-issued identities and the active parent still control scope. No token or signing-key value is requested.",
      "Read boundaries, business rules, approval limits and saved drafts stay unchanged."]);
    if (!await confirm(io, "Use these exact owner sign-in bindings", review)) return 0;
    if (review.execution_enabled) {
      write(["Review existing execution with changed sign-ins",
        "The existing execution policy is enabled. Its writer, effects, limits and identity guards are unchanged.",
        "A new immutable execution revision will bind that same policy to these reviewed sign-ins.",
        "Requests still require current Read, Action and applicable owner authority. This confirmation does not execute a request.",
        "Declining leaves both the runtime file and stored execution authority unchanged."]);
      if (!await confirm(io, "Bind existing execution to these exact reviewed sign-ins", review)) return 0;
    }
    await prepared.confirm({ connectionDigest: review.digest, ...(review.execution_enabled ? { executionDigest: review.digest } : {}) });
    write(["Owner sign-in configuration reviewed and saved.",
      "Configured, not authenticated: start local Ask or stdio MCP with backend-issued credentials, then verify the saved owner revision.",
      "Owner edits remain disabled until separately authenticated human review. No source row changed."]);
    return 0;
  } finally { terminal?.close(); await prepared.close(); }
}
