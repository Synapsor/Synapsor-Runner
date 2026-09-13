import { assertBoundaryAuthoringResumeMaterial } from "./boundary-authoring-resume.js";
import type { BoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import type { ModelAuthoringConversation } from "./model-authoring-conversation.js";
import { policyCoverageSection } from "./authoring-policy-coverage.js";
import { reviewSectionLines } from "./read-boundary-review-view.js";
import { activePolicySource, authoringDestination, policyTextLines, policyTextSnapshot, readPolicyTextFile,
  savePolicySources, removePolicySources, type AuthoringDestination, type PolicyTextSnapshot } from "./authoring-policy-source.js";

export function installPolicySourceCommands(input: {
  root: string; chat: BoundaryAuthoringChat; conversation: ModelAuthoringConversation;
  destination: () => AuthoringDestination; onChange: () => Promise<void>;
  hasDraft?: () => boolean;
}): { reviewTransfer(destination: AuthoringDestination): Promise<boolean> } {
  const { chat, conversation } = input;
  const choose = chat.session.chooseOption?.bind(chat.session);
  chat.setSourceAnswerRecorder?.(async (answer) => {
    const sources = conversation.policySources;
    if (!activePolicySource(sources) || !sources) return;
    if (answer.length > 4_000 || (sources.operator_messages?.length ?? 0) >= 64) throw new Error("Source-related history is full (64 messages, 4000 characters each). /rules can remove retained context; nothing was truncated or sent.");
    // Validate before the separate source-history write. Otherwise a refused
    // checkpoint's answer would be reintroduced on every resumed Action edit.
    // The chat's existing answer-refusal path lets the operator correct it.
    assertBoundaryAuthoringResumeMaterial(answer);
    const next = { ...sources, operator_messages: [...(sources.operator_messages ?? []), answer] };
    await savePolicySources(input.root, next);
    Object.assign(sources, next);
    await input.onChange();
  });
  const show = async (source: PolicyTextSnapshot) => {
    await chat.session.showReviewDetails?.(`${source.name} v${source.version}`, [
      `${source.bytes} bytes | ${source.lines} lines | ${source.digest}`,
      ...policyTextLines(source.text).map((line, index) => `${index + 1} | ${line}`),
      "Untrusted business context. This text grants no authority and is never evaluated by the runtime.",
    ]);
  };
  const replace = async (source: PolicyTextSnapshot, target = input.destination()): Promise<boolean> => {
    const session = conversation.policySources!;
    const destination = authoringDestination(target);
    chat.checkpoint("Review attached rules", [
      `${source.name} v${source.version} | ${source.bytes} bytes | ${source.lines} lines (complete)`,
      `Destination: ${destination}`,
      "Sends this text with the reviewed schema, existing draft and business conversation. Prior metadata permission does not cover this new source.",
      "Snapshot retained locally in .synapsor/boundary-authoring/policy-sources (owner-only). /rules can view or permanently remove it; runtime requests never include this source.",
    ]);
    while (true) {
      // Local menu deliberately bypasses model permission narration: unapproved text cannot leave through an explanation request.
      const decision = await choose?.("SEND ATTACHED RULES", [
        { value: "send", label: "Use this complete text with the named model" },
        { value: "view", label: "Preview every line locally" },
        { value: "cancel", label: "Cancel; keep current rules and draft" },
      ], { initialValue: "cancel" });
      if (decision === "view") { await show(source); continue; }
      if (decision !== "send") return false;
      const next = structuredClone(session);
      if (!next.snapshots.some((entry) => entry.version === source.version)) next.snapshots.push(source);
      next.active = source.version;
      if (!next.approvals.some((entry) => entry.digest === source.digest && entry.destination === destination)) next.approvals.push({ digest: source.digest, destination });
      await savePolicySources(input.root, next);
      Object.assign(session, next);
      await input.onChange();
      chat.checkpoint("Rules ready for this conversation", [`${source.name} v${source.version}; previous source versions are retained locally until removed.`,
        "No draft or authority has changed yet. The model must translate and Runner must validate any revision; unsupported rules remain review concerns."]);
      return true;
    }
  };
  chat.setSourceCommandHandler?.(async (command, argument) => {
    if (!choose || !conversation.policySources) throw new Error("Rules attachment requires the interactive model authoring session.");
    const session = conversation.policySources;
    let action = command === "/attach" ? "attach" : "menu";
    if (action === "menu") {
      const source = activePolicySource(session);
      action = await choose("RULES FOR THIS JOB", [
        ...(source ? [{ value: "view", label: `View ${source.name} v${source.version}` },
          { value: "consent", label: "Review transfer to the current model" }] : []),
        ...(session.coverage ? [{ value: "coverage", label: "View recorded source interpretation (may predate the current draft)" }] : []),
        { value: "attach", label: source ? "Replace with another .txt file" : "Attach a .txt file" },
        { value: "paste", label: "Paste rules as a complete text snapshot" },
        ...(session.snapshots.length ? [{ value: "remove", label: "Remove all retained text versions" }] : []),
        { value: "back", label: input.hasDraft?.() ? "Return to the same draft" : "Return to the conversation" },
      ], { initialValue: "back" }) ?? "back";
      if (action === "view" && source) { await show(source); return false; }
      if (action === "coverage" && session.coverage) {
        const reviewedSource = session.snapshots.find((entry) => entry.digest === session.coverage!.source_digest);
        if (reviewedSource) {
          const section = policyCoverageSection(reviewedSource, session.coverage);
          if (chat.session.showReviewSections) await chat.session.showReviewSections(section.title, [
            { id: "summary", title: "Recorded interpretation summary", lines: ["This may predate the current draft. Activation always rechecks the current source and draft.", ...section.lines] },
            ...(section.children ?? []),
          ]);
          else await chat.session.showReviewDetails?.(section.title, reviewSectionLines(section));
        }
        return false;
      }
      if (action === "consent" && source) return replace(source);
    }
    if (action === "remove") {
      const confirm = await choose("REMOVE RETAINED RULES TEXT", [
        { value: "remove", label: "Remove every saved text snapshot for this job" },
        { value: "back", label: "Keep the rules" },
      ], { initialValue: "back", context: ["Saved draft rules remain unchanged. Source excerpts will no longer be reproducible; prior text may remain in provider logs or transcript excerpts. This is not secure erasure or provider deletion."] });
      if (confirm !== "remove") return false;
      await removePolicySources(input.root, session);
      await savePolicySources(input.root, session);
      await input.onChange();
      chat.checkpoint("Rules text removed", ["Saved authority is unchanged. Existing rules are not deleted by removing their source. Prior transcript/provider retention is separate."]);
      return true;
    }
    if (action !== "paste" && action !== "attach") return false;
    const version = Math.max(0, ...session.snapshots.map((source) => source.version)) + 1;
    let source: PolicyTextSnapshot;
    if (action === "paste") {
      const text = await chat.readLiteral?.("Paste complete rules, then Enter (Esc cancels): ");
      if (text === undefined) return false;
      source = policyTextSnapshot(Buffer.from(text, "utf8"), "pasted-rules.txt", version);
    } else {
      const file = argument || await chat.readLiteral?.("Rules .txt path (Esc cancels): ");
      if (!file?.trim()) return false;
      const unquoted = file.trim().replace(/^(?:"(.*)"|'(.*)')$/u, (_match, double: string, single: string) => double ?? single);
      source = await readPolicyTextFile(unquoted, input.root, version);
    }
    return replace(source);
  }, input.hasDraft);
  return { reviewTransfer: async (target) => {
    const sources = conversation.policySources, source = activePolicySource(sources);
    if (!source || sources?.approvals.some((entry) => entry.digest === source.digest && entry.destination === authoringDestination(target))) return true;
    return replace(source, target);
  } };
}
