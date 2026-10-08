import { describe, expect, it, vi } from "vitest";
import {
  presentMetadataEgress, showPolicyAttachmentPreview, showPolicyAttachmentTransfer,
  choosePolicyAttachmentTransfer, showPolicyAttachmentReady, choosePolicyAttachmentReview,
  type MetadataEgressView, type PolicyAttachmentView,
} from "./authoring-question-presenter.js";

describe("stateless egress presentation", () => {
  it.each([false, true, undefined])("returns the literal metadata decision without consuming a permission (%s)", async accepted => {
    for (const privateRead of [undefined, { mappingLines: ['{"source":"private_registry",', '"meaning":"Current recorded eligibility"}'], fingerprint: "synthetic-fingerprint" }]) {
      const view: MetadataEgressView = { providerLabel: "Synthetic provider/model", destination: "https://provider.example/v1", privateRead };
      const before = structuredClone(view), rememberDetails = vi.fn();
      const confirm = vi.fn(async (_question: string, options: { defaultValue?: boolean; context?: string[] }) => {
        expect(options.defaultValue).toBe(false);
        const exact = rememberDetails.mock.calls[0]![1] as string[];
        expect(exact).toContain(`Destination: ${view.destination}`);
        expect(options.context).toContain(`Destination: ${view.destination}`);
        if (privateRead) {
          expect(exact).toEqual(expect.arrayContaining(privateRead.mappingLines));
          expect(exact.join("\n")).toContain(privateRead.fingerprint);
          expect(options.context?.join("\n")).not.toContain(privateRead.fingerprint);
        } else expect(exact.join("\n")).not.toContain("synthetic-fingerprint");
        return accepted;
      });
      expect(await presentMetadataEgress({ view, session: { confirm }, chat: { rememberDetails } })).toBe(accepted);
      expect(confirm).toHaveBeenCalledOnce(); expect(rememberDetails).toHaveBeenCalledOnce(); expect(view).toEqual(before);
    }
  });

  it("binds the metadata disclosure kind and exact payload record even without a chat object", async () => {
    const view: MetadataEgressView = { providerLabel: "Display-only label", destination: "reviewed destination",
      privateRead: { mappingLines: ["Complete declared mapping"], fingerprint: "exact mapping fingerprint" } };
    const confirm = vi.fn(async (_prompt: string, options?: Parameters<import("./boundary-cli-picker.js").BoundaryReviewInteractiveSession["confirm"]>[1]) => {
      expect(options?.decisionKind).toBe("disclosure");
      expect(options?.defaultValue).toBe(false);
      expect(options?.exactDetails?.lines).toEqual(expect.arrayContaining([
        `Provider: ${view.providerLabel}`, `Destination: ${view.destination}`,
        ...view.privateRead!.mappingLines, `Private Read metadata fingerprint: ${view.privateRead!.fingerprint}`,
      ]));
      return false;
    });
    expect(await presentMetadataEgress({ view, session: { confirm } })).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("renders all host-supplied lines locally without altering their whitespace or identity", async () => {
    const view: PolicyAttachmentView = { name: "Synthetic rules.txt", version: 2, bytes: 37, lines: 3,
      digest: "synthetic-snapshot-digest", textLines: ["First rule.", "  Exact second rule.  ", ""] };
    const before = structuredClone(view), showReviewDetails = vi.fn(async () => {}), checkpoint = vi.fn();
    await showPolicyAttachmentPreview({ view, session: { showReviewDetails } });
    const [title, lines] = showReviewDetails.mock.calls[0] as unknown as [string, string[]];
    expect(title).toContain(view.name); expect(title).toContain("v2");
    expect(lines).toEqual(expect.arrayContaining(["1 | First rule.", "2 |   Exact second rule.  ", "3 | "]));
    expect(lines.join("\n")).toContain(view.digest);
    showPolicyAttachmentTransfer({ view, destination: "exact named model destination", chat: { checkpoint } });
    expect(checkpoint.mock.calls[0]![1]).toContain("Destination: exact named model destination");
    showPolicyAttachmentReady({ view, chat: { checkpoint } });
    expect(checkpoint).toHaveBeenCalledTimes(2); expect(view).toEqual(before);
  });

  it.each([undefined, "cancel", "view", "send", "unexpected"])("returns local attachment choice without a default acceptance (%s)", async choice => {
    const chooseOption = vi.fn(async (_title: string, _choices: unknown, options: unknown) => {
      expect(options).toEqual({ initialValue: "cancel" }); return choice;
    });
    expect(await choosePolicyAttachmentTransfer({ chooseOption })).toBe(choice);
    expect(chooseOption).toHaveBeenCalledOnce();
  });

  it.each([undefined, "continue", "review"])("keeps optional review a separate default-Continue decision (%s)", async choice => {
    const chooseOption = vi.fn(async (_title: string, _choices: unknown, options: unknown) => {
      expect(options).toEqual({ initialValue: "continue", reviewOnly: true }); return choice;
    });
    expect(await choosePolicyAttachmentReview({ chooseOption })).toBe(choice);
  });
});
