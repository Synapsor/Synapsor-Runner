import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it, vi } from "vitest";
import { onboard } from "./guided-start.js";
import { inspectActionProject, inspectActionProjectHeld } from "./action-tui.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";
import { ownedProgramInspection } from "./test-fixtures/owned-authoring-program.js";
const offline = vi.hoisted(() => ({ calls: 0, inspection: undefined as unknown }));
vi.mock("@synapsor-runner/schema-inspector", async original => ({
  ...await original<typeof import("@synapsor-runner/schema-inspector")>(),
  inspectDatabase: async () => { offline.calls++; return structuredClone(offline.inspection); },
}));

it("the actual Action metadata reader joins its owner's access instead of reacquiring Entry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-action-inspection-held-"));
  await fs.chmod(root, 0o700);
  const inspection = ownedProgramInspection(); offline.inspection = inspection; offline.calls = 0;
  vi.stubEnv("HELD_METADATA_ONLY_URL", "postgresql://fixture.invalid/never-opened");
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    await onboard(["db", "--project-root", root, "--from-env", "HELD_METADATA_ONLY_URL", "--schema", "studio", "--json"],
      { interactive: false, schemaInspector: async () => structuredClone(inspection) });
    const actual = await withProjectAuthorityMutation(root, permit => inspectActionProjectHeld(root, permit));
    expect(actual).toEqual(inspection); expect(offline.calls).toBe(1);
    await expect(withProjectAuthorityMutation(root, permit => inspectActionProject(root))).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_REQUIRED" });
    await expect(inspectActionProjectHeld(root, {} as never)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
    expect(offline.calls).toBe(1);
  } finally { output.mockRestore(); vi.unstubAllEnvs(); }
});
