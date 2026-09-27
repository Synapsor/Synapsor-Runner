import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { onboard } from "./guided-start.js";
import { structuredBoundaryAuthoringCommand } from "./boundary-structured-authoring.js";
import { loadBoundaryReviewContext } from "./boundary-commands.js";
import { actionRuleModelDraftFromAuthority } from "./action-rule-draft.js";
import { buildActionRuleAuthoringCatalog } from "./action-rule-authoring.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { generateModelActionRuleDraft } from "./action-rule-model.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import { newPolicySourceSession, policyTextSnapshot, authoringDestination, savePolicySources, loadPolicySources } from "./authoring-policy-source.js";
import { reviewVerifiedActionAuthority, verifiedActionAuthoritySections } from "./verified-action-review.js";
import { createBoundaryAuthoringChat } from './boundary-authoring-chat.js';
import type { AnalyticsShellIo } from './analytics-shell.js';
import { explorationBoundaryCandidateDigest } from "./auto-boundary.js";
import { loadActionRuleIntentSkeletons } from "./action-rule-intent-skeleton.js";
import { readActionRuleAuthorityDraft } from "./action-rule-authority.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { assertCompleteSelectedActionProgram, readSavedActionJobReview } from "./saved-action-job-review.js";
import { ownedProgramDraft, ownedProgramInspection } from "./test-fixtures/owned-authoring-program.js";

/** Component public authoring fixture: ordinary draft compiler/save producer,
 * host saved agenda, canonical completion gate. No activation or installed claim. */
describe("owned complete public structured program", () => {
  it("assembles fifty via existing twelve-change submissions, restarts, refuses partial completion and retains late37 edit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-studio-fifty-"));
    const inspect = async () => ownedProgramInspection();
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output += String(chunk); return true; });
    const previous = process.env.OWNED_STUDIO_READ_URL;
    process.env.OWNED_STUDIO_READ_URL = "postgresql://fixture.invalid/not-used";
    try {
      expect(await onboard(["db", "--project-root", root, "--from-env", "OWNED_STUDIO_READ_URL", "--schema", "studio", "--json"],
        { interactive: false, schemaInspector: inspect })).toBe(0);
      const run = (args: string[]) => structuredBoundaryAuthoringCommand(["--project-root", root, ...args], inspect);
      const selected = Array.from({ length: 50 }, (_, i) => `Pack parcel type ${i + 1} using bounded caller units and human review.`);
      let context = await loadBoundaryReviewContext(root);
      let binding = { boundary_name: context.candidate.pack.name, generation_lock_fingerprint: context.candidate.generation_lock_fingerprint,
        schema_fingerprint: context.lock.schema_fingerprint, role_posture_fingerprint: context.lock.role_posture_fingerprint };
      let state = buildBoundaryAuthoringResumeState({ binding, stage: "action_drafting", jobIntent: "Pack all fifty selected parcel types with human review.",
        provider: "openai", model: "owned-offline", action: { intent: selected[0]!, intents: selected, strategy: "rule_derived" } });
      await writeBoundaryAuthoringResumeState(root, state, { expectedRevisionDigest: null });
      let firstUnitDraft: Awaited<ReturnType<typeof readActionRuleAuthorityDraft>>;
      for (let start = 0; start < 50; start += 12) {
        output = "";
        expect(await run(["--export-draft", `draft-${start}.json`, "--json"]), output).toBe(0);
        const request = JSON.parse(await fs.readFile(path.join(root, `draft-${start}.json`), "utf8"));
        expect(request.schema_version).toBe("synapsor.boundary-draft-input.v2");
        request.read.resources = [{ resource_id: "studio.parcels", include: true, tenant_key: "tenant_id", principal_key: "principal_id", row_identity: "parcel_id",
          selectable_fields: ["label", "units", "available", "version"], keep_out_fields: ["internal_note"], withhold_from_model_fields: ["available", "version"], private_model_fields: ["available", "version"] }];
        request.actions.push(...Array.from({ length: Math.min(12, 50 - start) }, (_, i) => ownedProgramDraft(start + i + 1)));
        await fs.writeFile(path.join(root, `draft-${start}.json`), JSON.stringify(request), { mode: 0o600 });
        output = ""; expect(await run(["--draft", `draft-${start}.json`, "--json"]), output).toBe(0);
        context = await loadBoundaryReviewContext(root);
        const draft = (await readActionRuleAuthorityDraft(root, `${context.candidate.pack.name}_rules`))!;
        expect(draft.authority.rules).toHaveLength(Math.min(start + 12, 50));
        if (start === 0) firstUnitDraft = draft;
        binding = { boundary_name: context.candidate.pack.name, generation_lock_fingerprint: context.candidate.generation_lock_fingerprint,
          schema_fingerprint: context.lock.schema_fingerprint, role_posture_fingerprint: context.lock.role_posture_fingerprint };
        const expectedRevisionDigest = state.revision_digest;
        state = buildBoundaryAuthoringResumeState({ binding, previous: state, stage: start + 12 >= 50 ? "authority_review" : "action_drafting",
          jobIntent: state.job_intent, provider: "openai", model: "owned-offline", action: { intent: selected[0]!, intents: selected,
            completed_outcomes: Array.from({ length: Math.min(start + 12, 50) }, (_, i) => ownedProgramDraft(i + 1).outcome), strategy: "rule_derived" } });
        await writeBoundaryAuthoringResumeState(root, state, { expectedRevisionDigest });
        expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: state });
        expect((await readSavedActionJobReview({ projectRoot: root, boundaryName: binding.boundary_name,
          currentOutcomes: draft.authority.rules.map(rule => rule.rule.outcome) })).completeProgram?.draftsComplete).toBe(start + 12 >= 50);
        if (start + 12 < 50) await expect(assertCompleteSelectedActionProgram({ projectRoot: root, draft })).rejects.toThrow("AUTHORING_PROGRAM_NOT_READY");
        else await expect(assertCompleteSelectedActionProgram({ projectRoot: root, draft })).resolves.toBeUndefined();
      }
      expect(firstUnitDraft!.authority.rules).toHaveLength(12);
      await expect(assertCompleteSelectedActionProgram({ projectRoot: root, draft: firstUnitDraft! })).rejects.toThrow("AUTHORING_PROGRAM_NOT_READY");
      output = ""; expect(await run(["--export-draft", "edit.json", "--json"]), output).toBe(0);
      const exportedText = await fs.readFile(path.join(root, "edit.json"), "utf8");
      const request = JSON.parse(exportedText);
      expect(Buffer.byteLength(exportedText)).toBeLessThanOrEqual(512 * 1024);
      expect(request.actions).toHaveLength(50);
      const full = (await readActionRuleAuthorityDraft(root, `${context.candidate.pack.name}_rules`))!;
      const beforeInventory = JSON.stringify(full);
      const inventorySections = verifiedActionAuthoritySections(full, 100).find(section => section.id === 'outcomes')!.children ?? [];
      expect(inventorySections).toHaveLength(7);
      expect(inventorySections.flatMap(section => section.lines.flatMap(line => line.match(/studio\.pack_parcel_\d+/gu) ?? [])))
        .toEqual(full.authority.action_boundary.rules.map(rule => rule.outcome));
      for (const [index, section] of inventorySections.entries()) {
        expect(section.lines.join('\n')).toContain(`Page ${index + 1}/7`);
        expect(section.lines.join('\n')).toContain(full.digest);
        expect(section.lines.flatMap(line => line.match(/studio\.pack_parcel_\d+/gu) ?? [])).toHaveLength(index === 6 ? 2 : 8);
      }
      // Exercise the ordinary confirmation/details adapter. Inspection returns
      // to the same default-No choice and neither calls a model nor mutates it.
      const sections = verifiedActionAuthoritySections(full, 100);
      const inventoryChoices = ['__view_runner_details__', 'section:0',
        ...inventorySections.flatMap((_, index) => [`section:${index + 1}`, 'section:0', 'back']), 'back', 'back', 'no'];
      const inspected: string[][] = [];
      const io: AnalyticsShellIo = { read: async () => undefined,
        choose: async choice => {
          if (choice.options.some(option => option.value === 'yes')) expect(choice.initialValue).toBe('no');
          const value = inventoryChoices.shift();
          expect(choice.options.some(option => option.value === value), `Actual menu must expose ${value}`).toBe(true);
          return value;
        },
        review: async (_title, lines) => { inspected.push([...lines]); },
        write: () => undefined, writeChunk: () => undefined, setStatus: () => undefined,
        clearStatus: () => undefined, isTerminal: () => true, columns: () => 100,
        onInterrupt: () => () => undefined, close: () => undefined };
      const chat = createBoundaryAuthoringChat({io, color: false});
      const guide = vi.fn(async () => { throw new Error('Inspection must remain local.'); });
      chat.setPermissionGuide!(guide);
      expect(await chat.session.confirmActivation!('Activate verified Action Boundary "studio"?', {
        context: ['Review the complete candidate.'], exactDetails: {title: 'EXACT ACTION BOUNDARY',
          summaryTitle: 'ACTION REVIEW', sections, lines: ['Full candidate retained.']},
      })).toBe(false);
      chat.close();
      expect(inspected).toHaveLength(7); expect(inventoryChoices).toHaveLength(0);
      expect(guide).not.toHaveBeenCalled(); expect(JSON.stringify(full)).toBe(beforeInventory);
      const builtCatalog = buildActionRuleAuthoringCatalog({ boundary: context.candidate, inspection: ownedProgramInspection(), retainedCatalog: full.authority.catalog });
      const skeletons = await loadActionRuleIntentSkeletons({ projectRoot: root, binding, builtCatalog,
        readBoundaryDigest: explorationBoundaryCandidateDigest(context.candidate),
        preparedDrafts: request.actions.map((draft: any) => ({ outcome: draft.outcome, digest: canonicalJsonDigest(draft), draft })) });
      const reconstructed = request.action_skeletons.map((entry: any) => {
        const { candidates_ref, continuation, ...rest } = entry;
        expect(candidates_ref).toBe("/action_skeleton_candidates");
        const { draft_ref, ...exact } = continuation;
        return { ...rest, candidates: request.action_skeleton_candidates,
          continuation: draft_ref ? { ...exact, draft: request.actions[Number(draft_ref.slice("/actions/".length))] } : continuation };
      });
      expect(reconstructed).toEqual(skeletons.skeletons);
      for (const fault of ["missing", "foreign", "wrong", "stale", "json_string"]) {
        const invalid = structuredClone(request);
        if (fault === "missing") delete invalid.action_skeleton_candidates;
        if (fault === "foreign") invalid.action_skeletons[0].candidates_ref = "file:///outside.json";
        if (fault === "wrong") invalid.action_skeletons[0].continuation.draft_ref = "/actions/49";
        if (fault === "stale") invalid.action_skeletons[0].continuation.digest = `sha256:${"0".repeat(64)}`;
        if (fault === "json_string") invalid.action_skeleton_candidates = JSON.stringify(invalid.action_skeleton_candidates);
        await fs.writeFile(path.join(root, `${fault}.json`), JSON.stringify(invalid));
        output = "";
        expect(await run(["--draft", `${fault}.json`, "--dry-run", "--json"]), output).toBe(2);
        expect(output).toMatch(/REFERENCE|must be an object/);
        expect((await readActionRuleAuthorityDraft(root, full.authority.name))!.digest).toBe(full.digest);
      }
      const tooManyChanges = structuredClone(request);
      for (const changed of tooManyChanges.actions.slice(0, 13)) { changed.inputs[0].maximum = 8; changed.effect.allowed_fields[0].maximum = 8; }
      await fs.writeFile(path.join(root, "thirteen-changes.json"), JSON.stringify(tooManyChanges));
      output = ""; expect(await run(["--draft", "thirteen-changes.json", "--json"]), output).toBe(2);
      expect(output).toContain("STRUCTURED_DRAFT_WORK_UNIT_TOO_LARGE");
      expect((await readActionRuleAuthorityDraft(root, full.authority.name))!.digest).toBe(full.digest);
      const late = request.actions.find((draft: { outcome: string }) => draft.outcome === "studio.pack_parcel_37");
      late.effect.allowed_fields[0].maximum = 7; late.inputs[0].maximum = 7;
      await fs.writeFile(path.join(root, "edit.json"), JSON.stringify(request), { mode: 0o600 });
      output = ""; expect(await run(["--draft", "edit.json", "--json"]), output).toBe(0);
      const edited = (await readActionRuleAuthorityDraft(root, `${context.candidate.pack.name}_rules`))!;
      expect(edited.authority.rules).toHaveLength(50);
      expect(edited.authority.rules.find(rule => rule.rule.outcome === late.outcome)!.effect_envelope.allowed_fields[0]!.maximum).toBe(7);
      await expect(assertCompleteSelectedActionProgram({ projectRoot: root, draft: edited })).resolves.toBeUndefined();
      const sources = newPolicySourceSession();
      const source = policyTextSnapshot(Buffer.from([
        "EARLY EXCEPTION: unavailable parcels are always refused, including routine units.",
        "GLOBAL: every selected Action requires human parcel review; automatic allowances, if configured, must share nine overall and two per tenant over one rolling day.",
        ...selected.map((intent, index) => `${index + 1}. ${intent}`),
        "OUTSIDE: external audit ownership remains unresolved and must never be asserted verified by a model answer.",
      ].join("\n")), "owned-studio-complete-rules.txt");
      sources.snapshots = [source]; sources.active = source.version;
      sources.operator_messages = ["The source register is authoritative for parcel availability. External audit ownership stays pending."];
      const session = { provider: "openai" as const, model: "owned-offline", apiKey: "offline-placeholder" };
      sources.approvals = [{ digest: source.digest, destination: authoringDestination(session) }];
      await savePolicySources(root, sources);
      const ownerDecisions = [{ decision_id: canonicalJsonDigest("studio availability scope"), applicability_digest: canonicalJsonDigest("current studio register fields"),
        question: "Is the availability register authoritative for these parcel Actions?", answer: "The owner confirms this exact register; external audit remains unanswered." }];
      const previousRevision = state.revision_digest;
      state = buildBoundaryAuthoringResumeState({ binding, previous: state, stage: "authority_review", jobIntent: state.job_intent,
        provider: session.provider, model: session.model, policySourceSession: sources.id, readPrerequisiteDecisions: ownerDecisions });
      await writeBoundaryAuthoringResumeState(root, state, { expectedRevisionDigest: previousRevision });
      const restarted = await readBoundaryAuthoringResumeState(root, binding);
      expect(restarted.status).toBe("ready"); if (restarted.status !== "ready") throw new Error("owned restart unavailable");
      if (process.env.OWNED_STUDIO_EVIDENCE_DIRECTORY) {
        await fs.cp(root, process.env.OWNED_STUDIO_EVIDENCE_DIRECTORY, { recursive: true, force: false, errorOnExist: true });
      }
      const conversation = createModelAuthoringConversation(restarted.value.conversation);
      conversation.policySources = await loadPolicySources(root, restarted.value.policy_source_session!);
      const existingDraft = actionRuleModelDraftFromAuthority({ authority: edited.authority, outcome: late.outcome,
        review: edited.reviews.find(review => review.outcome === late.outcome)!, preserveVerificationFields: true });
      const prepared = edited.authority.rules.map(rule => actionRuleModelDraftFromAuthority({ authority: edited.authority, outcome: rule.rule.outcome,
        review: edited.reviews.find(review => review.outcome === rule.rule.outcome)!, preserveVerificationFields: true }));
      const next = structuredClone(existingDraft); next.inputs![0]!.maximum = 6; next.effect.allowed_fields[0]!.maximum = 6;
      const { schema_version: _version, verification, effect, approval, ...rule } = next;
      const call = (name: string, args: any) => ({ status: 200, body: { output: [{ type: "function_call", call_id: name, name: name.replaceAll(".", "__"), arguments: JSON.stringify(args) }] } });
      const steps = [call("runner.submit_verification_boundary_draft", { status: "draft", ...verification, changed_fields: [] }),
        call("runner.submit_effect_envelope_draft", { status: "draft", ...effect, changed_fields: ["allowed_fields"] }),
        call("runner.submit_action_rule_draft", { status: "draft", ...rule, changed_fields: ["inputs"] }),
        call("runner.submit_approval_policy_draft", { status: "draft", ...approval, changed_fields: [] }),
        call("runner.validate_action_draft", {}),
        { status: 200, body: { output: [{ type: "message", content: [{ type: "output_text", text: "The disabled edit is prepared. External duties are not verified." }] }] } }];
      const encodedSizes: number[] = [];
      const result = await generateModelActionRuleDraft({ session: { ...session, conversation, dependencies: { requestJson: async request => {
        const encoded = JSON.stringify(request.body); encodedSizes.push(Buffer.byteLength(encoded));
        const allStrings = (value: any): string[] => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(allStrings) : [];
        const texts = allStrings(request.body).join("\n");
        expect(texts).toContain(JSON.stringify(source.text));
        expect(texts).toContain("EARLY EXCEPTION"); expect(texts).toContain("nine overall and two per tenant");
        expect(texts).toContain(ownerDecisions[0]!.answer);
        expect(texts).toContain('"current_intent_index":36'); expect(texts).toContain('"index":5');
        expect(texts).toContain("External audit ownership stays pending");
        expect(texts).toContain(selected[49]!); expect(texts).toContain(prepared[0]!.outcome);
        if (!steps.length) throw new Error("Unexpected correction in owned coherent producer response");
        return steps.shift()!;
      } } }, intent: "Reduce only parcel type37 units maximum from seven to six. Keep all other conditions and global review duties.",
        operatorJob: restarted.value.job_intent, existingDraft, preparedDrafts: prepared, reservedOutcomes: prepared.map(draft => draft.outcome),
        pendingIntents: ["Reduce only parcel type37 units maximum from seven to six. Keep all other conditions and global review duties."],
        programContext: { selected_intents: selected, current_intent_index: 36, binding: restarted.value.binding,
          resume_revision: restarted.value.revision_digest, owner_decisions: restarted.value.read_prerequisite_decisions!,
          unresolved: ["External audit ownership stays pending", ...selected.slice(37)] },
        builtCatalog, readBoundary: context.candidate, readBoundaryDigest: explorationBoundaryCandidateDigest(context.candidate), egressAcknowledged: true });
      expect(result.compiled.draft.effect.allowed_fields[0]!.maximum).toBe(6);
      expect(result.compiled.draft.approval).toEqual(existingDraft.approval);
      expect(result).toMatchObject({ authority_granted: false, source_database_changed: false });
      expect(steps).toEqual([]); expect(encodedSizes).toHaveLength(6); expect(Math.max(...encodedSizes)).toBeLessThan(1024 * 1024);
      if (process.env.OWNED_STUDIO_REQUEST_SUMMARY) await fs.writeFile(process.env.OWNED_STUDIO_REQUEST_SUMMARY, JSON.stringify({
        origin: "OWNED_OFFLINE_ACTUAL_ENCODER_COMPONENT", schema_version: "helper.authoring-program-encoder.v1", source_digest: source.digest,
        complete_selected_intents: selected.length, current_intent_index: 36, requests: encodedSizes.map((bytes, index) => ({ index, utf8_body_bytes: bytes })),
        limits: { request_bytes: 1024 * 1024, export_bytes: 512 * 1024 }, export_utf8_bytes: Buffer.byteLength(exportedText),
        full_source_early_exception_global_scope_decisions_and_unresolved_items_asserted_each_request: true,
        simulated_dependency_calls: encodedSizes.length, provider_calls: 0, source_calls: 0, installed_acceptance: false,
        valid_disabled_twelve_companion_digest: firstUnitDraft!.digest, valid_complete_fifty_digest: full.digest, late37_edit_digest: edited.digest,
      }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      expect((await loadPolicySources(root, sources.id)).operator_messages).toEqual(sources.operator_messages);
      await expect(assertCompleteSelectedActionProgram({ projectRoot: root, draft: edited })).rejects.toThrow("Full attached source coverage");
      const visited: string[] = [], exactOutcomeDetails: string[] = [];
      let menuVisits = 0, searchDone = false, detailDone = false;
      const confirmation = vi.fn(async () => false);
      const notice = await reviewVerifiedActionAuthority({ projectRoot: root, boundaryName: binding.boundary_name, draft: edited,
        session: { confirm: confirmation, confirmActivation: confirmation,
          chooseResource: async () => undefined, editFieldTiers: async () => undefined,
          promptText: async () => "pack_parcel_37", chooseOption: async (title, options, settings) => {
            if (title === "VERIFIED ACTION BOUNDARY") return menuVisits++ === 0 ? "inventory" : "back";
            if (title === "COMPLETE ACTION INVENTORY") {
              const names = options.filter(option => option.value.startsWith("outcome:"));
              expect(names.length).toBeLessThanOrEqual(8);
              if (!searchDone) {
                visited.push(...names.map(option => option.value.slice("outcome:".length)));
                if (options.some(option => option.value === "next")) return "next";
                searchDone = true; return "search";
              }
              if (!detailDone) { expect(names).toHaveLength(1); return names[0]!.value; }
              return "back";
            }
            if (title === "EXACT ACTION OUTCOME") { detailDone = true; exactOutcomeDetails.push(...settings!.context!); return "back"; }
            throw new Error(`Unexpected owned operator review: ${title}`);
          } } });
      expect(new Set(visited)).toEqual(new Set(edited.authority.rules.map(rule => rule.rule.outcome)));
      expect(exactOutcomeDetails.join("\n")).toContain("OUTCOME  studio.pack_parcel_37");
      expect(exactOutcomeDetails.join("\n")).not.toContain("OUTCOME  studio.pack_parcel_1\n");
      expect(exactOutcomeDetails.join("\n")).toContain(edited.digest);
      expect(confirmation).not.toHaveBeenCalled(); expect(notice.tone).toBe("warning");
    } finally {
      stdout.mockRestore(); if (previous === undefined) delete process.env.OWNED_STUDIO_READ_URL; else process.env.OWNED_STUDIO_READ_URL = previous;
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
