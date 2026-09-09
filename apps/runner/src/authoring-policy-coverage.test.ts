import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createTerminalAnalyticsShellIo } from "./analytics-shell.js";
import { createBoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import { newPolicySourceSession, policyTextSnapshot, authoringDestination } from "./authoring-policy-source.js";
import { reviewPolicyCoverage } from "./authoring-policy-coverage.js";
import { AskError, type AskProviderDependencies } from "./model-ask.js";

describe("attached-rules cancellation", () => {
  it.each(["escape", "ctrl-c"])("awaits provider cleanup on %s without coverage retry or publication", async (key) => {
    const readable = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(value: boolean) { this.isRaw = value; } });
    const writable = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 24 });
    writable.resume();
    const chat = createBoundaryAuthoringChat({ io: createTerminalAnalyticsShellIo({ readable, writable, terminal: true }) });
    const conversation = createModelAuthoringConversation(), source = policyTextSnapshot(Buffer.from("Completion requires an applied receipt."), "rules.txt");
    conversation.policySources = newPolicySourceSession();
    conversation.policySources.snapshots = [source]; conversation.policySources.active = source.version;
    conversation.policySources.approvals = [{ digest: source.digest, destination: authoringDestination({ provider: "openai", model: "fixture" }) }];
    const draft = { receipts: "Applied receipt required." }, before = structuredClone({ draft, conversation });
    let entered!: () => void, abortSeen!: () => void, release!: () => void, settled = false;
    const started = new Promise<void>((resolve) => { entered = resolve; }), aborted = new Promise<void>((resolve) => { abortSeen = resolve; }),
      cleanup = new Promise<void>((resolve) => { release = resolve; });
    const requestJson = vi.fn(async ({ signal }: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      signal.addEventListener("abort", abortSeen, { once: true });
      entered(); await aborted; await cleanup;
      // A dependency may report the wrong error during abort. It must not trigger
      // the coverage parser's prose-only retry or overwrite the saved report.
      throw new AskError("ASK_REQUIRED_TOOL_NOT_CALLED", "Late provider failure", 422);
    });
    try {
      const pending = chat.progress("Checking attached rules", () => reviewPolicyCoverage({
        session: { provider: "openai", model: "fixture", conversation, dependencies: { requestJson, signal: chat.signal } },
        source, draft, env: { OPENAI_API_KEY: "test-key" },
      })).finally(() => { settled = true; });
      const refused = expect(pending).rejects.toMatchObject({ code: "ASK_CANCELLED" });
      await started;
      if (key === "escape") readable.emit("keypress", "\u001b", { name: "escape" });
      else readable.write("\u0003");
      await aborted;
      expect(settled).toBe(false);
      release(); await refused;
      expect(requestJson).toHaveBeenCalledOnce();
      expect({ draft, conversation }).toEqual(before);
    } finally { release(); chat.close(); readable.destroy(); writable.destroy(); }
  });
});
