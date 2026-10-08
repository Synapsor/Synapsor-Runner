import { expect, it, vi } from "vitest";
import { promptJobFirstActionIntents, selectUnplannedActionIntents } from "./authoring-action-entry.js";

it.each(["Propose creating a request", "Explain what approve and cancel mean", "Afficher les rendez-vous"])(
  "manual Action selection never infers its default from words: %s", async intent => {
    const confirm = vi.fn(async (_prompt, options) => { expect(options.defaultValue).toBe(false); return true; });
    expect(await promptJobFirstActionIntents({ confirm } as any, intent)).toEqual([intent]);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

it.each([false, undefined])("manual No/cancel preserves the choice: %s", async decision => {
  expect(await promptJobFirstActionIntents({ confirm: async () => decision } as any, "change everything"))
    .toEqual(decision === false ? [] : undefined);
});
it("missing typed planning refuses without falling back to a prompt or English dispatch", async () => {
  const confirm = vi.fn(), promptText = vi.fn();
  await expect(selectUnplannedActionIntents({ jobFirst: true, modelChat: true,
    session: { confirm, promptText } as any, jobIntent: "Create and approve a change" }))
    .rejects.toThrow("AUTHORING_TYPED_ACTION_PLAN_REQUIRED");
  expect(confirm).not.toHaveBeenCalled(); expect(promptText).not.toHaveBeenCalled();
});
