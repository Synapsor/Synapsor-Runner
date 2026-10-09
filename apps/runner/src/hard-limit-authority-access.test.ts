import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ACTION_RULE_REGISTRY_VERSION, type RuntimeActionRuleRegistryV1 } from "@synapsor-runner/action-rules";
import { canonicalJsonDigest as digest } from "@synapsor-runner/protocol";
import { assertHardLimitAuthorityWriterAdmission } from "./hard-limit-authority-admission.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function project() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "writer-admission-access-")); roots.push(root); return root; }
// Empty registry exercises the no-requirement branch only; it is not a positive publication/readiness proof.
const registry: RuntimeActionRuleRegistryV1 = { schema_version: ACTION_RULE_REGISTRY_VERSION, name: "empty", digest: digest("empty"), rules: [], approval_classes: [] };
it("requires live held access even when the registry has no hard-limit requirements", async () => {
  const projectRoot = await project(), other = await project();
  let expired!: ProjectAuthorityMutationPermit;
  const input = { projectRoot, registry, authorityDigest: registry.digest };
  await withProjectAuthorityMutation(projectRoot, async permit => {
    expired = permit;
    await expect(assertHardLimitAuthorityWriterAdmission({ ...input, mutationPermit: permit })).resolves.toBeUndefined();
    await expect(assertHardLimitAuthorityWriterAdmission({ ...input, projectRoot: other, mutationPermit: permit }))
      .rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
  });
  for (const mutationPermit of [expired, undefined, JSON.parse(JSON.stringify(expired))]) {
    await expect(assertHardLimitAuthorityWriterAdmission({ ...input, mutationPermit: mutationPermit as ProjectAuthorityMutationPermit }))
      .rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
  }
});
