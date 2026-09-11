import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { listSupportedReadCurrentStatePrerequisiteCandidates, listReadCurrentStatePrerequisiteSources,
  ReadPrerequisiteCatalogTooLargeError, type SupportedReadCurrentStatePrerequisiteCandidate } from "./read-prerequisite.js";
import { readPrerequisiteEvidenceReviewSections, reviewReadPrerequisiteMetadata, reviewReadPrerequisiteSelection } from "./read-prerequisite-consent.js";
import type { ModelReadPrerequisiteConfirmationRequest } from "./read-prerequisite-model.js";
import { terminalContentWidth, wrapStyledTerminalLine } from "./terminal-layout.js";
import { createBoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import type { AnalyticsShellIo } from "./analytics-shell.js";

vi.mock("./read-prerequisite.js", async importOriginal => ({
  ...await importOriginal<typeof import("./read-prerequisite.js")>(),
  listSupportedReadCurrentStatePrerequisiteCandidates: vi.fn(), listReadCurrentStatePrerequisiteSources: vi.fn(),
}));

describe("private Read prerequisite metadata consent", () => {
  const candidate: SupportedReadCurrentStatePrerequisiteCandidate = {
    source: { schema: "school", table: "private_admissions" },
    subject: { tenant_column: "institution_id", principal_column: "student_id", unique_constraint: "exact_student" },
    current_state: { state_column: "private_state", positive_states: ["admitted", "withdrawn"],
      effective_from_column: "effective_from", effective_until_column: "effective_until",
      interval: "[effective_from,effective_until)", clock: "database_utc" },
    rls_required: true, catalog_descriptions: { source: "Registrar evidence; not customer data." },
  };
  beforeEach(() => vi.mocked(listSupportedReadCurrentStatePrerequisiteCandidates).mockReset().mockReturnValue([structuredClone(candidate)]));
  const input = (selection: string | undefined) => ({ inspection: {} as SchemaInspection, boundary: {} as ExplorationBoundaryDraft,
    modelLabel: "openai[gpt-5.6-terra]", assertCurrent: vi.fn(async () => {}),
    session: { chooseOption: vi.fn(async () => selection) } as unknown as BoundaryReviewInteractiveSession,
  });

  function mapping(): ModelReadPrerequisiteConfirmationRequest {
    const { catalog_descriptions: _descriptions, rls_required: _rls, current_state, ...source } = structuredClone(candidate);
    const { positive_states: _states, ...current } = current_state;
    const selection = { ...source, current_state: { ...current, positive_state: "admitted" } };
    return { candidate: structuredClone(candidate), candidate_id: canonicalJsonDigest(candidate), selection,
      metadata_digest: canonicalJsonDigest([candidate]), selection_digest: canonicalJsonDigest(selection),
      source_description: "Registrar-managed current admission, private to Runner.",
      positive_state_description: "Admitted during the effective UTC interval." };
  }

  it.each(["question", "revise", "pending", "confirm"])("keeps exact mapping review and %s on the real chat surface", async path => {
    const original = mapping(), before = structuredClone(original);
    const question = "Use the authoritative effective start, not the maintenance timestamp. Keep the existing rules.";
    const selections = ["__view_runner_details__", path === "question" ? "__ask_boundary_model__" : path];
    const write = vi.fn(), review = vi.fn(async () => undefined), rememberAnswer = vi.fn(async () => {});
    const guide = vi.fn(async () => { throw new Error("No explanation-only model may claim to revise the mapping"); });
    const io: AnalyticsShellIo = {
      read: async () => question, readWithEscape: async () => question, readConversation: async () => question,
      choose: async choice => {
        expect(choice.options.map(option => option.label)).toContain("Correct this mapping with the model");
        return selections.shift();
      }, review, write, close: () => {}, isTerminal: () => true, columns: () => 80,
      setStatus: () => {}, clearStatus: () => {}, onInterrupt: () => () => {},
    };
    const chat = createBoundaryAuthoringChat({ io, color: false });
    chat.setPermissionGuide!(guide);
    const assertCurrent = vi.fn(async () => {});
    try {
      const result = await reviewReadPrerequisiteSelection({ mapping: original, session: chat.session, assertCurrent, rememberAnswer });
      expect(review).toHaveBeenCalledOnce();
      expect(JSON.stringify(review.mock.calls)).toContain(original.selection_digest);
      expect(JSON.stringify(review.mock.calls)).toContain("institution_id");
      expect(guide).not.toHaveBeenCalled();
      expect(original).toEqual(before);
      if (path === "question" || path === "revise") {
        expect(result).toEqual({ state: "revise", instruction: question });
        expect(rememberAnswer).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("explained or corrected"), question);
      } else if (path === "pending") {
        expect(result).toEqual({ state: "pending" });
        expect(rememberAnswer).not.toHaveBeenCalled();
      } else {
        expect(result).toEqual({ state: "confirmed", operator_evidence: `Use this exact private access condition: ${original.selection_digest}` });
        expect(rememberAnswer).toHaveBeenCalledOnce();
      }
      expect(selections).toEqual([]);
    } finally { chat.close(); }
  });

  it.each([false, true])("truthfully labels an earlier questioned mapping (changed=%s)", async changed => {
    const current = mapping();
    current.previous_selection = structuredClone(current.selection);
    if (changed) current.previous_selection.current_state.effective_from_column = "maintenance_date";
    const args = input("pending");
    const rememberAnswer = vi.fn(async () => {});
    expect(await reviewReadPrerequisiteSelection({ mapping: current, ...args, rememberAnswer })).toEqual({ state: "pending" });
    const options = vi.mocked(args.session.chooseOption!).mock.calls[0]![2];
    expect(options?.context?.join(" ")).toContain(changed ? "Revised mapping" : "Mapping unchanged");
    expect(rememberAnswer).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   "])("keeps an abandoned mapping correction pending (%s)", async answer => {
    const args = input("revise"), rememberAnswer = vi.fn(async () => {});
    args.session.promptText = vi.fn(async () => answer);
    expect(await reviewReadPrerequisiteSelection({ mapping: mapping(), ...args, rememberAnswer })).toEqual({ state: "pending" });
    expect(rememberAnswer).not.toHaveBeenCalled();
  });

  it.each(["x".repeat(8001), "postgresql://reader:secret@localhost/private", "Answer\u0007"])("refuses unsafe correction before retaining it in conversation history", async answer => {
    const args = input("revise"), rememberAnswer = vi.fn(async () => {});
    args.session.promptText = vi.fn(async () => answer);
    await expect(reviewReadPrerequisiteSelection({ mapping: mapping(), ...args, rememberAnswer })).rejects.toThrow("READ_PREREQUISITE_MODEL_INVALID");
    expect(rememberAnswer).not.toHaveBeenCalled();
  });

  it.each(["before_menu", "after_menu", "after_question", "after_history"])("refuses stale mapping review at %s", async phase => {
    const args = input("revise"), rememberAnswer = vi.fn(async () => {});
    args.session.promptText = vi.fn(async () => "Correct the effective date; do not change the existing policy.");
    const failAt = ["before_menu", "after_menu", "after_question", "after_history"].indexOf(phase) + 1;
    let checks = 0;
    args.assertCurrent.mockImplementation(async () => { if (++checks === failAt) throw new Error("READ_BOUNDARY_REVISION_CHANGED"); });
    await expect(reviewReadPrerequisiteSelection({ mapping: mapping(), ...args, rememberAnswer })).rejects.toThrow("READ_BOUNDARY_REVISION_CHANGED");
    expect(rememberAnswer).toHaveBeenCalledTimes(phase === "after_history" ? 1 : 0);
  });

  it("returns only the fully reviewed metadata, with no new private names in pre-consent narration", async () => {
    const args = input("allow");
    const result = await reviewReadPrerequisiteMetadata(args);
    expect(result).toMatchObject({ candidates: [candidate], metadata_digest: expect.stringMatching(/^sha256:/u) });
    const [, , options] = vi.mocked(args.session.chooseOption!).mock.calls[0]!;
    const exact = options?.exactDetails;
    expect(exact?.sections?.flatMap(section => section.lines).join(" ")).toContain("private_state");
    expect(exact?.sections?.flatMap(section => section.lines).join(" ")).toContain("withdrawn");
    expect(exact?.lines.join(" ")).not.toContain("private_state");
    expect(exact?.lines.join(" ")).not.toContain('"source"');
    expect(JSON.stringify({ context: options?.context, explanation: options?.explanationContext })).not.toContain("private_admissions");
    expect(options).toMatchObject({ initialValue: "pending", requireExplicitSelection: true });
    expect(args.assertCurrent).toHaveBeenCalledTimes(2);
  });

  it("lets the operator narrow an oversized catalog locally, then review every selected tuple before transfer", async () => {
    vi.mocked(listSupportedReadCurrentStatePrerequisiteCandidates).mockImplementationOnce(() => { throw new ReadPrerequisiteCatalogTooLargeError(); });
    vi.mocked(listReadCurrentStatePrerequisiteSources).mockReturnValue([candidate.source, { schema: "school", table: "other_private_source" }]);
    const args = input("allow");
    vi.mocked(args.session.chooseOption!).mockResolvedValueOnce("0").mockResolvedValueOnce("allow");
    const result = await reviewReadPrerequisiteMetadata(args);
    expect(result?.candidates).toEqual([candidate]);
    expect(result?.metadata_digest).toBe(canonicalJsonDigest([candidate]));
    expect(listSupportedReadCurrentStatePrerequisiteCandidates).toHaveBeenLastCalledWith(args.inspection, args.boundary, { source: candidate.source });
    const [title, choices, options] = vi.mocked(args.session.chooseOption!).mock.calls[0]!;
    expect(title).toContain("AUTHORITATIVE");
    expect(choices).toHaveLength(3);
    expect(options).toMatchObject({ initialValue: "pending", requireExplicitSelection: true, explainOnRequest: false });
    const review = vi.mocked(args.session.chooseOption!).mock.calls[1]![2];
    expect(JSON.stringify(review?.exactDetails)).toContain("private_admissions");
    expect(JSON.stringify(review?.exactDetails)).not.toContain("other_private_source");
    expect(args.assertCurrent).toHaveBeenCalledTimes(3);
  });

  it("keeps source narrowing pending without granting metadata permission", async () => {
    vi.mocked(listSupportedReadCurrentStatePrerequisiteCandidates).mockImplementationOnce(() => { throw new ReadPrerequisiteCatalogTooLargeError(); });
    vi.mocked(listReadCurrentStatePrerequisiteSources).mockReturnValue([candidate.source]);
    const args = input("pending");
    expect(await reviewReadPrerequisiteMetadata(args)).toBeUndefined();
    expect(args.session.chooseOption).toHaveBeenCalledOnce();
    expect(listSupportedReadCurrentStatePrerequisiteCandidates).toHaveBeenCalledOnce();
  });

  it("keeps the real chat source picker and exact metadata local even when the operator asks about permission", async () => {
    vi.mocked(listSupportedReadCurrentStatePrerequisiteCandidates).mockImplementationOnce(() => { throw new ReadPrerequisiteCatalogTooLargeError(); });
    vi.mocked(listReadCurrentStatePrerequisiteSources).mockReturnValue([candidate.source, { schema: "school", table: "other_private_source" }]);
    const selections = ["0", "__view_runner_details__", "section:0", "back", "__ask_boundary_model__", "pending"];
    const guide = vi.fn(async () => "This permission lets me help map extra structural metadata. It does not grant access to records.");
    const review = vi.fn(async () => undefined);
    const choices: string[][] = [];
    const io: AnalyticsShellIo = {
      read: async () => "Why is this permission needed?",
      readWithEscape: async () => "Why is this permission needed?",
      readConversation: async () => "Why is this permission needed?",
      choose: async choice => {
        choices.push(choice.options.map(option => option.label));
        if (choices.length === 1) expect(guide).not.toHaveBeenCalled();
        return selections.shift();
      },
      review, write: () => {}, close: () => {}, isTerminal: () => true, columns: () => 100,
      setStatus: () => {}, clearStatus: () => {}, onInterrupt: () => () => {},
    };
    const chat = createBoundaryAuthoringChat({ io, color: false });
    chat.setPermissionGuide!(guide);
    try {
      const args = { ...input("pending"), session: chat.session };
      expect(await reviewReadPrerequisiteMetadata(args)).toBeUndefined();
      expect(choices[0]).toContain("school.private_admissions");
      expect(choices[0]).not.toContain("Ask the model before deciding");
      expect(review).toHaveBeenCalled();
      expect(JSON.stringify(review.mock.calls)).toContain("private_state");
      expect(guide).toHaveBeenCalledOnce();
      const sent = JSON.stringify(guide.mock.calls);
      for (const privateName of ["private_admissions", "other_private_source", "private_state", "withdrawn", "exact_student"]) {
        expect(sent).not.toContain(privateName);
      }
      expect(args.assertCurrent).toHaveBeenCalledTimes(2);
    } finally { chat.close(); }
  });

  it("reviews the exact terminal-sanitized metadata payload without truncation", async () => {
    vi.mocked(listSupportedReadCurrentStatePrerequisiteCandidates).mockReturnValue([{
      ...candidate,
      catalog_descriptions: { source: "Registrar\u001b[2J evidence" },
    }]);
    const args = input("allow");
    const result = await reviewReadPrerequisiteMetadata(args);
    expect(result?.candidates[0]!.catalog_descriptions.source).toBe("Registrar\\u001b[2J evidence");
    expect(result?.metadata_digest).toBe(canonicalJsonDigest(result!.candidates));
    const [, , options] = vi.mocked(args.session.chooseOption!).mock.calls[0]!;
    expect(options?.exactDetails?.lines.join("\n")).not.toContain("\u001b");
  });

  it.each([undefined, "pending"])("returns no metadata when the operator leaves the source pending (%s)", async selection => {
    const args = input(selection);
    expect(await reviewReadPrerequisiteMetadata(args)).toBeUndefined();
    expect(args.assertCurrent).toHaveBeenCalledOnce();
  });

  it("explains missing evidence without pretending authentication proves the business requirement", async () => {
    vi.mocked(listSupportedReadCurrentStatePrerequisiteCandidates).mockReturnValue([]);
    const args = input("allow");
    await expect(reviewReadPrerequisiteMetadata(args)).rejects.toThrow("authentication and related records are not substitutes");
    expect(args.session.chooseOption).not.toHaveBeenCalled();
  });

  it("rejects oversized metadata without truncation or transfer", async () => {
    vi.mocked(listSupportedReadCurrentStatePrerequisiteCandidates).mockReturnValue([{ ...candidate, catalog_descriptions: { source: "x".repeat(65536) } }]);
    const args = input("allow");
    await expect(reviewReadPrerequisiteMetadata(args)).rejects.toThrow("Nothing was truncated or sent");
    expect(args.session.chooseOption).not.toHaveBeenCalled();
  });

  it("refuses stale authority after the permission decision", async () => {
    const args = input("allow");
    args.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Read changed"));
    await expect(reviewReadPrerequisiteMetadata(args)).rejects.toThrow("Read changed");
  });

  it("groups source descriptions once while retaining every reviewed candidate tuple at narrow terminal widths", () => {
    const candidates = Array.from({ length: 20 }, (_, index): SupportedReadCurrentStatePrerequisiteCandidate => ({
      ...structuredClone(candidate),
      subject: {
        tenant_column: index % 2 ? "student_id" : "institution_id",
        principal_column: index % 2 ? "institution_id" : "student_id",
        unique_constraint: `institution_student_unique_${index % 2}`,
      },
      current_state: {
        ...structuredClone(candidate.current_state),
        state_column: `admission_status_${index % 2}`,
        effective_from_column: `effective_from_${index % 3}`,
        effective_until_column: `effective_until_${index % 3}`,
        positive_states: index % 2 ? ["current", "admitted"] : ["admitted", "current"],
      },
      catalog_descriptions: {
        source: "Registrar admission status. Structural metadata only.",
        state: "The recorded admission state.",
        effective_from: "UTC interval start.",
        effective_until: "UTC interval end.",
      },
    }));
    candidates[0]!.current_state.positive_states = ["admitted, conditional", "current status"];
    const sections = readPrerequisiteEvidenceReviewSections(candidates);
    expect(sections).toHaveLength(1);
    const lines = sections[0]!.lines;
    expect(lines.filter(line => line.startsWith("Source:")).length).toBe(1);
    expect(lines.filter(line => line.startsWith("Status field admission_status_")).length).toBe(2);
    expect(lines.filter(line => line.startsWith("Effective-start field effective_from_")).length).toBe(3);
    expect(lines.filter(line => line.startsWith("Effective-end field effective_until_")).length).toBe(3);
    expect(lines.filter(line => line.startsWith("Candidate "))).toHaveLength(20);
    expect(lines.find(line => line.startsWith("Candidate 1:"))).toContain(
      'orientation tenant=institution_id, principal=student_id; unique=institution_student_unique_0; status=admission_status_0 allowlist=["admitted, conditional", "current status"]; effective=[effective_from_0, effective_until_0) UTC; RLS required=yes.',
    );
    for (const index of Array.from({ length: 20 }, (_, item) => item + 1)) {
      expect(lines).toContainEqual(expect.stringContaining(`Candidate ${index}:`));
    }
    expect(lines).toContain("Complete reviewed tuples for this source: 20 of 20.");
    expect(lines.join("\n")).not.toContain('"source"');

    const width = terminalContentWidth(40);
    const rendered = lines.flatMap(line => wrapStyledTerminalLine(line, width));
    expect(rendered.every(line => line.length <= width)).toBe(true);
    expect(rendered.join("").replace(/\s/gu, "")).toBe(lines.join("").replace(/\s/gu, ""));
  });
});
