import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  askIntentCheckModeForBoundary,
  askIntentCheckModesForBoundaries,
  deleteAskIntentCheckPreference,
  renameAskIntentCheckPreference,
  setAskIntentCheckMode,
} from "./ask-intent-preferences.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("local Ask intent-check preferences", () => {
  it("defaults every boundary to balanced without creating authority state", async () => {
    const root = await temporaryRoot();
    await expect(askIntentCheckModeForBoundary(root, "reviewed_staging"))
      .resolves.toBe("balanced");
    await expect(fs.access(path.join(root, ".synapsor/ask-preferences.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists independent per-boundary modes in a private file", async () => {
    const root = await temporaryRoot();
    await setAskIntentCheckMode({
      projectRoot: root,
      boundaryName: "operations",
      mode: "boundary_only",
      now: new Date("2026-08-20T12:00:00.000Z"),
    });

    await expect(askIntentCheckModesForBoundaries(root, ["operations", "finance"]))
      .resolves.toEqual({ operations: "boundary_only", finance: "balanced" });
    const filePath = path.join(root, ".synapsor/ask-preferences.json");
    const stored = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({
      schema_version: "synapsor.ask-preferences.v1",
      boundaries: {
        operations: {
          intent_check_mode: "boundary_only",
          updated_at: "2026-08-20T12:00:00.000Z",
        },
      },
    });
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("moves and removes preferences with boundary lifecycle changes", async () => {
    const root = await temporaryRoot();
    await setAskIntentCheckMode({
      projectRoot: root,
      boundaryName: "before",
      mode: "boundary_only",
    });
    await renameAskIntentCheckPreference({
      projectRoot: root,
      previousName: "before",
      nextName: "after",
    });
    expect(await askIntentCheckModesForBoundaries(root, ["before", "after"]))
      .toEqual({ before: "balanced", after: "boundary_only" });
    await deleteAskIntentCheckPreference(root, "after");
    await expect(askIntentCheckModeForBoundary(root, "after")).resolves.toBe("balanced");
  });

  it("fails closed on malformed or unsupported preferences", async () => {
    const root = await temporaryRoot();
    await fs.mkdir(path.join(root, ".synapsor"), { recursive: true });
    const filePath = path.join(root, ".synapsor/ask-preferences.json");
    await fs.writeFile(filePath, "not json\n");
    await expect(askIntentCheckModeForBoundary(root, "reviewed_staging"))
      .rejects.toThrow(/not valid JSON.*kept the question-to-plan check enabled/i);

    await fs.writeFile(filePath, JSON.stringify({
      schema_version: "synapsor.ask-preferences.v1",
      boundaries: {
        reviewed_staging: {
          intent_check_mode: "unchecked",
          updated_at: new Date().toISOString(),
        },
      },
    }));
    await expect(askIntentCheckModeForBoundary(root, "reviewed_staging"))
      .rejects.toThrow(/preference.*invalid.*kept the question-to-plan check enabled/i);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ask-intent-"));
  roots.push(root);
  return root;
}
