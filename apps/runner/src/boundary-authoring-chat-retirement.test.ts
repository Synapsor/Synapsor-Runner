import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { createBoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import { presentReadScopeInteraction } from "./authoring-question-presenter.js";
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

describe("B64 CP08 current exact record before direct decision", () => {
  it("associates all 26 literal Read scope facts with /diff after direct default-No decline", async () => {
    const literal = Array.from({ length: 26 }, (_, n) => `exact current scope fact ${n}: 漢字 😀 e\u0301`);
    const reads = ["/diff", "stop"];
    const writes: string[] = [];
    const choose = vi.fn<NonNullable<AnalyticsShellIo["choose"]>>(async () => "no");
    const io: AnalyticsShellIo = { read: async () => reads.shift(), choose,
      write: value => { writes.push(value); }, columns: () => 100, onInterrupt: () => () => {}, close: () => {} };
    const chat = createBoundaryAuthoringChat({ io, color: false });
    const digest = canonicalJsonDigest("current owner binding");
    const binding = { question_id: randomUUID(), question_revision: 1, question_digest: digest,
      context_digest: digest, scope_digest: digest, snapshot_digest: digest };
    const view = { kind: "readback" as const, binding, lines: literal, defaultValue: false };
    const before = structuredClone(view);
    try {
      expect(await presentReadScopeInteraction({ view, session: chat.session }))
        .toEqual({ kind: "decision", binding, accepted: false });
      expect(view).toEqual(before);
      expect(choose).toHaveBeenCalledOnce();
      expect(choose.mock.calls[0]![0].initialValue).toBe("no");
      const displayed = writes.join("\n");
      for (const line of literal) expect(displayed).toContain(line);
      const diffStart = writes.length;
      await chat.readOperator!();
      await writeFile(join(tmpdir(), "cp08-owned-transcript.json"), JSON.stringify({ writes, binding, literal }, null, 2));
      const diff = writes.slice(diffStart).join("\n");
      for (const line of literal) expect(diff).toContain(line);
      expect(writes.join("\n")).toMatch(/latest reviewed record/i);
    } finally { chat.close(); }
  });

  it.each([
    { ending: "no", lines: ["Current complete literal fact: e\u0301", "Current unresolved caveat: 漢字"] },
    { ending: undefined, lines: ["Current complete literal fact: e\u0301", "Current unresolved caveat: 漢字"] },
    { ending: "no", lines: [] },
    { ending: undefined, lines: [] },
  ])("binds supplied exact choice details over prior or compact context before decline/cancel ($ending, $lines)", async ({ ending, lines }) => {
    const writes: string[] = [];
    const reads = ["/diff", "stop"];
    const choose = vi.fn<NonNullable<AnalyticsShellIo["choose"]>>(async () => ending);
    const io: AnalyticsShellIo = { read: async () => reads.shift(), choose,
      write: value => { writes.push(value); }, columns: () => 100, onInterrupt: () => () => {}, close: () => {} };
    const chat = createBoundaryAuthoringChat({ io, color: false });
    const exactDetails = { title: "記録 😀", lines };
    const before = structuredClone(exactDetails);
    chat.rememberDetails("Previous unrelated page", ["Unrelated retained destination"]);
    try {
      expect(await chat.session.chooseOption!("Continue?", [{ value: "no", label: "No" }], {
        decisionKind: "business_review", initialValue: "no", context: ["Compact choice context"], exactDetails,
      })).toBe(ending);
      expect(exactDetails).toEqual(before);
      expect(choose).toHaveBeenCalledOnce();
      expect(choose.mock.calls[0]![0].initialValue).toBe("no");
      const diffStart = writes.length;
      await chat.readOperator!();
      const diff = writes.slice(diffStart).join("\n");
      expect(diff).toMatch(/latest reviewed record/i);
      expect(diff).toContain(exactDetails.title);
      for (const line of exactDetails.lines) expect(diff).toContain(line);
      expect(diff).not.toContain("Compact choice context");
      expect(diff).not.toContain("Unrelated retained destination");
    } finally { chat.close(); }
  });
});
