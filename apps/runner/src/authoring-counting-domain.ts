import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { readActionRuleAuthorityActivation, type ActionRuleAuthorityDraftV1 } from "./action-rule-authority.js";
import { borrowRuntimeControlPolicies, createProjectRuntimeStore } from "./control-policy-store.js";
import { readLedgerRuntimeConfig, runnerConfigPath } from "./cli-project.js";
import { SEMANTIC_ACTION_RUNTIME_CONFIG } from "./semantic-action-deployment.js";
import { withProjectRuntimeAdmission } from "./project-runtime-admission.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

/** Host-only point-in-time metadata, never a promise about future publication. */
export type CountingOutcomeDomain = {
  boundary_name: string;
  proposed_revision: string;
  proposed_outcomes: string[];
  current_revision: string | null;
  current_outcomes: string[];
  retained_automatic_outcomes: string[];
  complete: boolean;
  store_binding_digest: string;
  history_scope: "all_retained_boundary_automatic_approvals";
};

/** Read the already selected store, including before execution setup exists.
 * Runtime gate -> authority mutex -> store read; provider work stays outside.
 * A missing/mismatched store is unavailable evidence, never empty history. */
export async function withCountingOutcomeDomain<T>(projectRoot: string, proposed: ActionRuleAuthorityDraftV1,
  operation: (domain: CountingOutcomeDomain, permit: ProjectAuthorityMutationPermit) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env): Promise<T> {
  return withProjectRuntimeAdmission(projectRoot, async root => {
    const semantic = path.join(root, SEMANTIC_ACTION_RUNTIME_CONFIG);
    const fallback = await fs.stat(semantic).then(() => semantic).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return path.join(root, "synapsor.runner.json");
    });
    const configPath = path.resolve(root, runnerConfigPath([], fallback));
    const config = await readLedgerRuntimeConfig(configPath, { env });
    const storePath = path.resolve(root, env.SYNAPSOR_LOCAL_STORE ?? path.resolve(path.dirname(configPath), config.storage?.sqlite_path ?? ".synapsor/local.db"));
    if (config.storage?.shared_postgres?.mode !== "runtime_store") {
      if (!(await fs.stat(storePath)).isFile()) throw new Error("POLICY_COUNTING_HISTORY_UNAVAILABLE: Existing ledger required.");
    }
    const store = await createProjectRuntimeStore({ projectRoot: root, config, storePath, env });
    try {
      return await withProjectAuthorityMutation(root, async permit => {
        const binding = await borrowRuntimeControlPolicies(root, store);
        const active = await readActionRuleAuthorityActivation(root, binding);
        if (!store.automaticApprovalOutcomeDomain) throw new Error("POLICY_COUNTING_HISTORY_UNAVAILABLE: This store cannot establish the retained outcome domain.");
        const boundary = proposed.authority.action_boundary.name;
        const history = await store.automaticApprovalOutcomeDomain(boundary);
        const sameBoundary = active?.authority.action_boundary.name === boundary;
        const domain: CountingOutcomeDomain = {
          boundary_name: boundary, proposed_revision: proposed.digest,
          proposed_outcomes: proposed.authority.rules.map(entry => entry.rule.outcome).sort(),
          current_revision: active?.digest ?? null,
          current_outcomes: sameBoundary ? active!.authority.rules.map(entry => entry.rule.outcome).sort() : [],
          retained_automatic_outcomes: history.outcomes, complete: history.complete,
          store_binding_digest: canonicalJsonDigest({ root, storePath, storage: config.storage ?? null,
            repository: binding?.repository_id ?? null, deployment: binding?.deployment_id ?? null, project: binding?.project_id ?? null }),
          history_scope: "all_retained_boundary_automatic_approvals",
        };
        return await operation(domain, permit);
      });
    } finally { await store.close(); }
  });
}
