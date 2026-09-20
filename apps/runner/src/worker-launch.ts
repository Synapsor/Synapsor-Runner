import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { resolveActivatedActionRule } from "@synapsor-runner/action-rules";
import { resolveTrustedContext, resolveSemanticSupervisedWriterSource, supervisedWorkerPolicies, supervisedWorkerPolicyName,
  type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { loadActiveActionRuleAuthority } from "./action-rule-authority.js";
import { semanticContextCapability } from "./semantic-action-runtime.js";
import { semanticActionProjectRoot } from "./writeback-execution.js";
import { resolveLocalTestRuntimeEnvironment } from "./local-test-runtime-identity.js";
import { inspectSemanticReceiptSetup } from "./semantic-receipt-setup.js";
import { cliCommandName } from "./cli-command-meta.js";
import { shellQuote } from "./cli-format.js";

export type WorkerLaunchAssessment = {
  config_path: string;
  scope: string;
  local_identity_reference?: string;
  local_identity: "reviewed_local_development" | "environment_or_other_trusted_provider" | "unusable";
  inputs: { reference: string; present: boolean; source: "reviewed_local_identity" | "environment"; purpose: "context" | "writer" }[];
  issues: string[];
  execution_enabled: boolean;
  execution_binding: "current" | "stale" | "unverified";
  receipt: { mode: string; selected_mode: string | null; matches_execution_configuration: boolean | null; selection: "current" | "stale" | "unverified"; live_verification: "not_performed" };
  coverage: "selected_semantic_outcome" | "per_item_only";
};

function safeCode(error: unknown): string {
  const e = error as { code?: unknown; message?: unknown };
  const code = typeof e?.code === "string" ? e.code : typeof e?.message === "string" ? (e.message.split(":", 1)[0] ?? "") : "";
  return /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : "WORKER_LAUNCH_ASSESSMENT_UNAVAILABLE";
}
function safeReference(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value) ? value : "<invalid configuration reference>";
}

/** Local inputs only. No queue, lease, writer connection, diagnostic probe or effect.
 * Observe the resolver's actual environment lookups instead of duplicating its
 * tenant/principal defaults, organization rules or optional-actor semantics. */
export async function assessWorkerLaunch(input: {
  config: RuntimeConfig; configPath: string; capability?: string; env?: NodeJS.ProcessEnv;
}): Promise<WorkerLaunchAssessment> {
  const { config } = input;
  const result: WorkerLaunchAssessment = { config_path: path.resolve(input.configPath), scope: input.capability ?? "all configured outcomes",
    local_identity: "environment_or_other_trusted_provider", inputs: [], issues: [], execution_enabled: config.supervised_worker?.enabled === true, execution_binding: "unverified",
    receipt: { mode: "unverified", selected_mode: null, matches_execution_configuration: null, selection: "unverified", live_verification: "not_performed" }, coverage: "per_item_only" };
  const projectRoot = semanticActionProjectRoot(config, input.configPath);
  let env = input.env ?? process.env;
  let supplied: Record<string, string> | undefined;
  if (projectRoot) {
    try {
      const local = await resolveLocalTestRuntimeEnvironment({ projectRoot }, env);
      env = local.env; supplied = local.values;
      if (local.reference) { result.local_identity_reference = local.reference; result.local_identity = "reviewed_local_development"; }
    } catch (error) {
      result.local_identity = "unusable"; result.issues.push(safeCode(error)); return result;
    }
  }
  const policies = supervisedWorkerPolicies(config).filter(p => p.mode === "supervised_worker"
    && (!input.capability || supervisedWorkerPolicyName(p) === input.capability));
  // Do not union unselected outcomes' credentials, or impose local context on
  // per-item delegated/session execution. An explicit outcome is the narrow
  // supported preflight; existing guarded dispatch remains authoritative.
  if (policies.length !== 1 || !("outcome" in policies[0]!) || !projectRoot) return result;
  const policy = policies[0]!;
  if (!("outcome" in policy)) return result;
  result.scope = policy.outcome;
  result.coverage = "selected_semantic_outcome";
  const record = (name: string, purpose: "context" | "writer") => {
    const reference = safeReference(name);
    if (!result.inputs.some(x => x.reference === reference && x.purpose === purpose)) {
      result.inputs.push({ reference, present: Boolean(env[name]?.trim()), source: supplied?.[name] === undefined ? "environment" : "reviewed_local_identity", purpose });
    }
  };
  try {
    const active = await loadActiveActionRuleAuthority(projectRoot, { outcome: policy.outcome });
    const rule = resolveActivatedActionRule(active.registry, policy.outcome);
    result.execution_binding = policy.action_boundary_digest === rule.action_boundary_digest ? "current" : "stale";
    try {
      const observed = new Proxy(env, { get(target, key) {
        if (typeof key === "string") record(key, "context");
        return Reflect.get(target, key);
      } });
      resolveTrustedContext(config, observed, semanticContextCapability(rule));
    } catch (error) { result.issues.push(safeCode(error)); }
    const source = resolveSemanticSupervisedWriterSource(config, rule.compiled.source, policy);
    if (!source?.write_url_env) result.issues.push("SEMANTIC_ACTION_WRITER_BINDING_MISSING");
    else {
      record(source.write_url_env, "writer");
      const value = env[source.write_url_env]?.trim();
      if (!value) result.issues.push("SEMANTIC_ACTION_WRITER_URL_MISSING");
      else {
        try {
          const url = new URL(value);
          // Transport details (including supported local socket URLs) belong to
          // the existing adapter. Only reject an unparseable/wrong-engine URL.
          if (!(source.engine === "postgres" ? ["postgres:", "postgresql:"] : ["mysql:"]).includes(url.protocol)) throw new Error();
        } catch { result.issues.push("SEMANTIC_ACTION_WRITER_URL_INVALID"); }
      }
      result.receipt.mode = source.receipts?.authority ?? "runner_ledger";
    }
    try {
      const setup = await inspectSemanticReceiptSetup({ projectRoot, configPath: input.configPath, outcome: policy.outcome, env });
      if (setup?.selection) {
        result.receipt.selected_mode = setup.selection.receipts.authority;
        result.receipt.selection = setup.selection_current ? "current" : "stale";
        result.receipt.matches_execution_configuration = Boolean(source && setup.selection_current
          && setup.selection.write_url_env === source.write_url_env
          && canonicalJsonDigest(setup.selection.receipts) === canonicalJsonDigest(source.receipts ?? { authority: "runner_ledger" }));
      }
    } catch { /* Missing evidence is unverified; never claim a live receipt check. */ }
  } catch (error) { result.issues.push(safeCode(error)); }
  result.issues = [...new Set(result.issues)];
  return result;
}

export function workerLaunchLines(result: WorkerLaunchAssessment): string[] {
  const scope = result.coverage === "selected_semantic_outcome" ? ` --capability ${shellQuote(result.scope)}` : "";
  const options = `--supervised --config ${shellQuote(result.config_path)}${scope}`;
  return [
    `Worker config: ${result.config_path}`,
    `Execution scope: ${result.scope}; execution ${result.execution_enabled ? "enabled (still guarded)" : "not enabled"}, binding ${result.execution_binding}.`,
    result.local_identity_reference ? `Local development identity: ${result.local_identity_reference} (reviewed; not production authentication).`
      : `Trusted launch context: ${result.local_identity}.`,
    ...result.inputs.map(x => `${x.purpose} reference ${x.reference}: ${x.present ? "present" : "missing"}${x.source === "reviewed_local_identity" ? " (reviewed local identity)" : ""}.`),
    `Receipts configured: ${result.receipt.mode}; selected: ${result.receipt.selected_mode ?? "unverified"} (${result.receipt.selection}); matches execution: ${result.receipt.matches_execution_configuration === null ? "unverified" : result.receipt.matches_execution_configuration ? "yes" : "no"}. Live verification not performed by this check.`,
    ...(result.issues.length ? [`Launch prerequisites refused: ${result.issues.join(", ")}. Restore the reviewed inputs, then check again.`] : []),
    ...(result.coverage === "per_item_only" ? ["Per-item prerequisites remain unassessed. Select one semantic outcome with --capability for its local launch check."] : []),
    `Check only: ${cliCommandName()} worker check ${options}`,
    `Start work separately: ${cliCommandName()} worker run ${options} --yes`,
    "A check grants no execution permission. Current authority, identity, writer, facts, scope, version, lease and receipt checks still run for every item.",
  ];
}
