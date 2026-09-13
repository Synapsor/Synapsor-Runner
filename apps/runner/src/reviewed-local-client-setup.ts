import fs from "node:fs/promises";
import path from "node:path";
import { createBoundaryReviewInteractiveSession, type BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { readHiddenLocalIdentity, ProviderCredentialInputCancelledError } from "./secret-input.js";
import { localClientRuntimePath, listLocalTestRuntimeProfiles, loadLocalTestRuntimeIdentity,
  localTestRuntimeIdentityContract, retireLocalTestRuntimeProfile, saveLocalTestRuntimeIdentity } from "./local-test-runtime-identity.js";

export type ReviewedLocalClientSelection = { kind: "default" } | { kind: "named"; reference: string } | { kind: "retired"; reference: string } | { kind: "cancelled" };

/** Operator-only local setup. No identity value is returned to the handoff,
 * registry, launch arguments or ordinary output. Review never changes policy. */
export async function reviewLocalClientSetup(input: { projectRoot: string }, dependencies: {
  session?: Pick<BoundaryReviewInteractiveSession, "chooseOption" | "confirm" | "promptText">;
  readIdentity?: (prompt: string) => Promise<string>;
} = {}): Promise<ReviewedLocalClientSelection> {
  const session = dependencies.session ?? createBoundaryReviewInteractiveSession();
  const profiles = await listLocalTestRuntimeProfiles(input.projectRoot);
  const selected = await session.chooseOption?.("Local development client identity", [
    { value: "default", label: "Use the existing default local setup" },
    { value: "create", label: "Review a new named local client revision" },
    ...profiles.filter(p => !p.retired).map(p => ({ value: `select:${p.reference}`, label: `Select ${p.reference}` })),
    ...profiles.filter(p => !p.retired).map(p => ({ value: `retire:${p.reference}`, label: `Retire future launches: ${p.reference}` })),
    { value: "cancel", label: "Back without changing client setup" },
  ]);
  if (selected === "default") return { kind: "default" };
  if (!selected || selected === "cancel") return { kind: "cancelled" };
  const root = await fs.realpath(input.projectRoot);
  if (selected.startsWith("retire:")) {
    const reference = selected.slice(7);
    if (!profiles.some(p => p.reference === reference && !p.retired)) throw new Error("LOCAL_TEST_RUNTIME_REFERENCE_INVALID: select an existing local reference.");
    const accepted = await session.confirm("Retire this exact reference for future launches?", { defaultValue: false, context: [
      "LOCAL DEVELOPMENT ONLY", `Project: ${root}`, `Reference: ${reference}`,
      "Existing connected clients retain their cached identity until you stop them explicitly. This is not immediate revocation.",
      "Client entries are retained but cannot launch this retired reference. They may be removed separately with the existing managed MCP uninstall control.",
      "Approval history, admitted/dispatched work, authority and source rows are unchanged. No refund or requeue.",
    ] });
    if (!accepted) return { kind: "cancelled" };
    await retireLocalTestRuntimeProfile(root, reference);
    return { kind: "retired", reference };
  }
  const { contract, deployment, storage } = await reviewedLocalClientDeployment(root);
  const context = ["LOCAL DEVELOPMENT ONLY — this is not production authentication", `Project: ${root}`,
    `Identity contract: ${contract.project_binding}`, deployment, storage,
    `Reviewed bindings: ${contract.bindings.map(b => `${b.role} (${b.environment})`).join(", ")}`,
    "The selected reference grants no new Read, Action or execution authority. Existing automatic history and allowances are shared.",
    "Identity values stay in private local files; they are not copied into client entries or model conversations."];
  if (selected.startsWith("select:")) {
    const reference = selected.slice(7);
    if (!profiles.some(p => p.reference === reference && !p.retired)) throw new Error("LOCAL_TEST_RUNTIME_REFERENCE_INVALID: select an existing local reference.");
    await loadLocalTestRuntimeIdentity({ projectRoot: root, runtimePath: localClientRuntimePath(reference) });
    if (!await session.confirm("Select this exact reviewed local client revision?", { defaultValue: false,
      context: [...context, `Reference: ${reference}`, "Use a separate client process. Stop/relaunch to change identity; connected clients do not hot-switch."] })) return { kind: "cancelled" };
    return { kind: "named", reference };
  }
  if (selected !== "create") throw new Error("LOCAL_TEST_RUNTIME_REFERENCE_INVALID: unrecognized operator selection.");
  const label = await session.promptText("Local client label (not a person's name or identity value; lowercase letters, digits, hyphens)");
  if (label === undefined) return { kind: "cancelled" };
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(label)) throw new Error("LOCAL_TEST_RUNTIME_REFERENCE_INVALID: use a letter followed by at most 31 lowercase letters, digits or hyphens.");
  if (!await session.confirm("Review private fixture identity values for this local client?", { defaultValue: false,
    context: [...context, `Selected label: ${label}`, "A new immutable revision will be created. Other references and client entries will remain unchanged."] })) return { kind: "cancelled" };
  const values: Record<string, string> = {};
  try {
    for (const binding of contract.bindings) values[binding.environment] = await (dependencies.readIdentity ?? readHiddenLocalIdentity)(
      `Reviewed local ${binding.role} for ${binding.environment} (hidden) [Esc Back]: `);
  } catch (error) { if (error instanceof ProviderCredentialInputCancelledError) return { kind: "cancelled" }; throw error; }
  if (!await session.confirm("Save this exact reviewed identity as a new local client revision?", { defaultValue: false,
    context: [...context, `Selected label: ${label}`, "Confirm the exact hidden values you just entered. Installation is separately reviewed next.",
      "If installation is declined, the reviewed revision remains saved but uninstalled. No existing client is replaced.",
      "To replace values, review a new revision and explicitly stop/relaunch the intended client. Retire the old reference separately if needed."] })) return { kind: "cancelled" };
  const saved = await saveLocalTestRuntimeIdentity({ projectRoot: root, profileName: label, expectedProjectBinding: contract.project_binding,
    bindings: contract.bindings, values });
  return { kind: "named", reference: saved.reference! };
}

/** Non-secret operator review facts; store resolution is identical for every profile. */
export async function reviewedLocalClientDeployment(projectRoot: string) {
  const root = await fs.realpath(projectRoot);
  const contract = await localTestRuntimeIdentityContract(root);
  const { readLocalExploreRuntimeConfig } = await import("./mcp-runtime.js");
  const config = await readLocalExploreRuntimeConfig(root);
  const storePath = path.resolve(root, config?.storage?.sqlite_path ?? ".synapsor/local.db");
  const { openProjectControlPolicies } = await import("./control-policy-store.js");
  const binding = config ? await openProjectControlPolicies({ projectRoot: root, config, storePath }) : undefined;
  let deployment: string;
  try { deployment = binding ? `Shared deployment: ${binding.deployment_id}; repository: ${binding.repository_id}`
    : "Shared deployment: this canonical project's reviewed policy files"; }
  finally { await binding?.close(); }
  const storage = config?.storage?.shared_postgres?.mode === "runtime_store"
    ? `Shared ledger: reviewed PostgreSQL control store (${config.storage.shared_postgres.schema ?? "synapsor_runner"}); no profile namespace`
    : `Shared ledger: ${storePath}; no profile namespace`;
  return { project: root, contract, deployment, storage };
}
