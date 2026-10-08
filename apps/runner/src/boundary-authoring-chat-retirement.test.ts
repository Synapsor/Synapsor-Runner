import { describe, expect, it, vi } from "vitest";
import { createBoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import type { AnalyticsShellIo } from "./analytics-shell.js";

function fixture() {
  const writes: string[] = [];
  const choose = vi.fn<NonNullable<AnalyticsShellIo["choose"]>>(async () => "no");
  const io: AnalyticsShellIo = { read: async () => "an exact answer", choose,
    write: value => { writes.push(value); }, columns: () => 100, onInterrupt: () => () => {}, close: () => {} };
  const chat = createBoundaryAuthoringChat({ io, color: false });
  const guide = vi.fn(async (_input: import("./boundary-authoring-chat.js").BoundaryAuthoringPermissionGuideInput) => "Optional explanation.");
  chat.setPermissionGuide!(guide);
  return { chat, guide, writes, choose };
}

describe("B64 chat routing does not infer typed decisions from English", () => {
  it.each(["Review the WRITE label?", "Does APPROVAL mean the team name?", "GRANT is the identifier?"])(
    "keeps an untyped business confirmation local: %s", async prompt => {
      const f = fixture();
      expect(await f.chat.session.confirm(prompt)).toBe(false);
      expect(f.guide).not.toHaveBeenCalled();
      expect(f.choose.mock.calls[0]?.[0].initialValue).toBe("no");
      f.chat.close();
    });
  it("does not make exact review details an implicit disclosure permission", async () => {
    const f = fixture();
    await f.chat.session.chooseOption!("Inspect saved business decision", [{ value: "no", label: "Return" }], {
      exactDetails: { title: "Exact record", lines: ["Unchanged stored answer"] } });
    expect(f.guide).not.toHaveBeenCalled();
    f.chat.close();
  });
  it("keeps explicit typed permission routing independent of its title", async () => {
    const f = fixture();
    await f.chat.session.confirm("Continuer?", { decisionKind: "disclosure" });
    expect(f.guide).toHaveBeenCalledOnce();
    expect(f.choose.mock.calls[0]?.[0].initialValue).toBe("no");
    f.chat.close();
  });
  it("does not attribute a host question to the model from its heading", async () => {
    const f = fixture();
    await f.chat.session.promptText("Which business state?", { context: ["MODEL QUESTION"] });
    expect(f.writes.join("\n")).not.toContain("model>");
    expect(f.writes.join("\n")).toContain("runner>");
    f.chat.close();
  });
});

describe("B64 chat presentation never derives provenance or omissions from prose", () => {
  it("does not promote an untyped context line into a model turn", async () => {
    const f = fixture();
    await f.chat.session.promptText("What changed?", { context: ["Model rationale: these are the operator's literal words."] });
    expect(f.writes.join("\n")).not.toContain("model>");
    expect(f.writes.join("\n")).toContain("Model rationale: these are the operator's literal words.");
    f.chat.close();
  });
  it.each(["runner", "streamRunner"] as const)("does not suppress the supplied %s record because its title sounds complete", async method => {
    const f = fixture();
    await f.chat[method]("READ REVIEW COMPLETE - NOT ACTIVE", ["The source effect remains unknown; inspect the receipt."]);
    expect(f.writes.join("\n")).toContain("The source effect remains unknown; inspect the receipt.");
    f.chat.close();
  });
  it("does not promote an Action message line into model provenance", async () => {
    const f = fixture();
    await f.chat.actionPrompter.message("Exact operator record", ["Model rationale: literal business label"]);
    expect(f.writes.join("\n")).not.toContain("model>");
    expect(f.writes.join("\n")).toContain("Model rationale: literal business label");
    f.chat.close();
  });
});


describe("B64 Action consent uses the caller's typed context and exact default", () => {
  it("does not infer permission from an ACTIVATE title or a back value", async () => {
    const f = fixture();
    await f.chat.actionPrompter.choose("ACTIVATE is a business label", [
      { value: "no", label: "Chosen business state" }, { value: "back", label: "Another state" },
    ], [], "no");
    expect(f.guide).not.toHaveBeenCalled();
    expect(f.choose.mock.calls[0]?.[0]).toMatchObject({ title: "ACTIVATE is a business label", initialValue: "no" });
    f.chat.close();
  });
  it("routes non-English typed consent and retains the exact caller default", async () => {
    const f = fixture();
    await f.chat.actionPrompter.choose("Continuer?", [
      { value: "yes", label: "Oui" }, { value: "no", label: "Pas maintenant" },
    ], ["Exact supplied context"], "no", { decisionKind: "disclosure" });
    expect(f.guide).toHaveBeenCalledOnce();
    expect(f.guide.mock.calls[0]?.[0]).toMatchObject({ decisionKind: "disclosure" });
    expect(f.choose.mock.calls[0]?.[0].initialValue).toBe("no");
    f.chat.close();
  });
  it.each([undefined, "missing", "disabled"])("leaves typed permission unresolved for default %s", async initialValue => {
    const f = fixture();
    expect(await f.chat.actionPrompter.choose("Continuer?", [
      { value: "yes", label: "Oui" }, { value: "disabled", label: "Unavailable", disabled: true },
    ], [], initialValue, { decisionKind: "activation" })).toBeUndefined();
    expect(f.choose).not.toHaveBeenCalled();
    expect(f.guide).not.toHaveBeenCalled();
    f.chat.close();
  });
});
