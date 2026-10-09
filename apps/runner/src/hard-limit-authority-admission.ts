import fs from "node:fs/promises";
import path from "node:path";
import { resolveRuntimeConfig, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { assertReviewedSharedSumRegistry, type RuntimeActionRuleRegistryV1 } from "@synapsor-runner/action-rules";
import type { BoundProjectPolicyStore } from "./control-policy-store.js";
import { executionConfigForReview, SEMANTIC_ACTION_RUNTIME_CONFIG } from "./semantic-execution-state.js";
import { assertHardLimitWriterSetup } from "./hard-limit-writer-setup.js";
import { projectHardLimitActivationWriterSelectionsHeld } from "./hard-limit-writer-selection.js";
import { withHeldProjectAuthorityAccess, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

/** The authority writer owns publication. This adapter supplies its current
 * governed configuration to the same native prerequisite used by deployment;
 * no prior readback, caller assertion, or reader credential is a permit. */
export async function assertHardLimitAuthorityWriterAdmission(input: {
  projectRoot: string;
  registry: RuntimeActionRuleRegistryV1;
  authorityDigest: string;
  publication?: { configPath: string; after: string };
  binding?: BoundProjectPolicyStore;
  env?: NodeJS.ProcessEnv;
  mutationPermit: ProjectAuthorityMutationPermit;
}): Promise<void> {
  const captured = { ...input, registry: structuredClone(input.registry), publication: structuredClone(input.publication), env: structuredClone(input.env) };
  return withHeldProjectAuthorityAccess(input.projectRoot, input.mutationPermit,
    held => assertWriterAdmissionHeld({ ...captured, projectRoot: held.projectRoot, mutationPermit: held }));
}
async function assertWriterAdmissionHeld(input: Parameters<typeof assertHardLimitAuthorityWriterAdmission>[0]): Promise<void> {
  assertReviewedSharedSumRegistry(input.registry);
  if (!input.registry.shared_sum && !input.registry.rules.some(({ compiled }) => compiled.hard_limit)) return;
  const root = path.resolve(input.projectRoot);
  let configPath = path.join(root, SEMANTIC_ACTION_RUNTIME_CONFIG);
  let text: string | undefined;
  if (input.publication) {
    configPath = path.resolve(input.publication.configPath);
    const relative = path.relative(root, configPath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("SEMANTIC_ACTION_CONFIG_PATH_INVALID: writer admission requires this project's configuration.");
    text = input.publication.after;
  } else {
    text = await optionalConfig(configPath);
    if (text === undefined) {
      // Explicit first-activation source only. Never discover ancestor or HOME
      // configuration, or substitute a read connection for a missing writer.
      configPath = path.join(root, "synapsor.runner.json");
      text = await optionalConfig(configPath);
    }
  }
  let raw: Record<string, unknown> = { version: 1, mode: "review" };
  if (text !== undefined) {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("SEMANTIC_ACTION_CONFIG_INVALID: writer admission requires an object configuration.");
    raw = parsed as Record<string, unknown>;
  }
  const review = await executionConfigForReview(root, configPath, raw, input.binding, input.env);
  const config = await projectHardLimitActivationWriterSelectionsHeld({ projectRoot: root, registry: input.registry,
    authorityDigest: input.authorityDigest,
    config: resolveRuntimeConfig(review.config as RuntimeConfig, path.dirname(configPath)), env: input.env }, input.mutationPermit);
  await assertHardLimitWriterSetup({ registry: input.registry,
    config, env: input.env });
}

async function optionalConfig(file: string): Promise<string | undefined> {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
