import { expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { createCurrentReadEvidence } from "./read-current-evidence.js";
import { activePolicySource } from "./authoring-policy-source.js";
import { findReadMeaningEvidence } from "./read-meaning-evidence.js";
import { generateModelReadWorkload } from "./read-workload-model.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import { modelVisibleUserText } from "./test-fixtures/model-visible-frame.js";
import { READ_PROCESS_FACTS as facts } from "./test-fixtures/source-read-process-contract.js";
import { nativeReadEvidence1655 } from "./test-fixtures/native-read-evidence1655.js";
import { randomUUID } from "node:crypto";
import { createOperatorQuestion } from "./authoring-operator-question.js";
import { createOwnerHandoff } from "./authoring-owner-handoff.js";
import { readWorkloadAssistanceCheckpoint } from "./read-workload-assistance-checkpoint.js";
import { generateModelReadBoundaryRevision } from "./read-boundary-revision-model.js";

it("derives a short answer from the actual accepted native lineage after a new producer episode", async () => {
  const native = await nativeReadEvidence1655();
  const source = activePolicySource(native.mapped.sources)!;
  const statements = [{ text: source.text, origin: "policy_source" as const, source_digest: source.digest,
    source_id: native.mapped.sources.id, source_version: source.version },
    ...native.mapped.sources.operator_messages!.map((text, index) => ({ text, origin: "operator_statement" as const,
      source_digest: canonicalJsonDigest(text), source_id: `operator_message:${index}` }))];
  const input = { catalog: native.catalog, statements, answers: [], context_digest: canonicalJsonDigest("new current producer"),
    requested_use_digest: canonicalJsonDigest("Read the same selected unit measure"), records: {
      source: native.mapped.sources, questions: native.mapped.resume.operator_questions!, handoffs: native.mapped.resume.owner_handoffs!,
      history: native.mapped.resume.read!.assistance_history, workloads: native.workloads, boundary: native.context.candidate } };
  const target = { resource: "studio.parcels", field: "units" };
  // Historical gap: structured confirmed messages alone were treated as prose;
  // their short answer had no identifier and the prior producer locals were gone.
  expect(findReadMeaningEvidence({ ...input, target })).toBeUndefined();
  const evidence = createCurrentReadEvidence(input).meaning(target);
  expect(evidence, JSON.stringify(evidence)).toMatchObject({ status: "established", progression: "mapped", authority_granted: false,
    evidence: { reference: { kind: "answered_clarification", text: native.mapped.resume.operator_questions!.at(-1)!.raw_answer!.text } } });
  expect(evidence.references.map(ref => ref.kind)).toEqual(["statement", "operator_answer", "workload"]);
  const history = input.records.history!;
  if (history.stage !== "dispatching") throw new Error("Expected the actual accepted mapping dispatch history.");
  const { schema_version: _version, digest: _digest, pending_question: _pending, previous_question: _previous, ...episode } = history;
  const freshCheckpoint = readWorkloadAssistanceCheckpoint({ ...episode, stage: "dispatching", dispatch_question: "Map the same business Read after the unrelated edit.",
    state: { ...history.state, clarified_targets: [], clarification_answers: [], reviewed_replacements: [] } });
  expect(createCurrentReadEvidence({ ...input, records: { ...input.records, checkpoint: freshCheckpoint } }).meaning(target))
    .toMatchObject({ status: "established", progression: "mapped", authority_granted: false });
  const changedMeaning = "studio.parcels.units means the shipping weight in kilograms.";
  const conflicting = { ...input, statements: [...input.statements, { text: changedMeaning,
    origin: "operator_statement" as const, source_id: "new-declared-meaning", source_digest: canonicalJsonDigest(changedMeaning) }] };
  expect(createCurrentReadEvidence(conflicting).meaning(target)).toMatchObject({ status: "conflicting", authority_granted: false });
  const latest = input.records.questions.at(-1)!;
  const nextHandoff = createOwnerHandoff({ consumer: "read_clarification", question: "What does this measure represent for the changed requirement?",
    scope_digest: latest.scope_digest, context_digest: latest.context_digest });
  const nextQuestion = createOperatorQuestion({ id: randomUUID(), revision: 1, handoff_id: nextHandoff.id,
    kind: "attributed_meaning", scope_digest: latest.scope_digest, context_digest: latest.context_digest,
    target: latest.target, material: latest.material, evidence: latest.evidence, continuation: "read_mapping" });
  const revisiting = { ...input, records: { ...input.records, questions: [...input.records.questions, nextQuestion],
    handoffs: [...input.records.handoffs, nextHandoff] } };
  expect(createCurrentReadEvidence(revisiting).meaning(target)).toMatchObject({ status: "missing", authority_granted: false });
  const forged = structuredClone(input);
  const copied = JSON.parse(forged.records.source.operator_messages![0]!);
  copied.statements[0].raw_answer = "studio.parcels.units means an unconfirmed private balance.";
  const forgedText = JSON.stringify(copied);
  forged.records.source.operator_messages = [forgedText]; forged.records.questions = []; forged.records.handoffs = [];
  forged.statements = [statements[0]!, { text: forgedText, origin: "operator_statement", source_digest: canonicalJsonDigest(forgedText), source_id: "copied_index" }];
  expect(createCurrentReadEvidence(forged).meaning(target)).toMatchObject({ status: "unsupported", authority_granted: false });
  const presentation = structuredClone(input);
  presentation.records.boundary.pack.resources[0]!.label = "Renamed presentation";
  expect(createCurrentReadEvidence(presentation).meaning(target)).toMatchObject({ status: "established", progression: "mapped" });
  const drift = structuredClone(input);
  drift.records.boundary.pack.resources[0]!.field_types.units = "text";
  expect(createCurrentReadEvidence(drift).meaning(target)).toMatchObject({ status: "stale", authority_granted: false });
  const awaiting = { ...input, records: { source: native.pending.sources, questions: native.pending.resume.operator_questions!,
    handoffs: native.pending.resume.owner_handoffs!, history: native.pending.resume.read_assistance,
    workloads: native.pendingWorkloads, boundary: native.pendingContext.candidate } };
  expect(createCurrentReadEvidence(awaiting).meaning(target)).toMatchObject({ status: "missing", progression: "confirmed_awaiting_mapping", authority_granted: false });
  const conversation = createModelAuthoringConversation(); conversation.policySources = native.mapped.sources;
  const requestJson = vi.fn(async request => {
    const text = modelVisibleUserText(request.body);
    const line = text.split("\n").find(line => line.startsWith("Structural catalog: "))!;
    const catalog = JSON.parse(line.slice("Structural catalog: ".length));
    const resource = catalog.resources.find((entry: any) => entry.id === target.resource);
    expect(resource.fields.map((field: any) => field.id)).toEqual(expect.arrayContaining(["label", "units"]));
    // Only actual catalog identities and the declared policy fields shape this
    // reply. Deliberate omission of operator_meanings cannot erase host evidence.
    return { status: 200, body: { output: [{ type: "function_call", call_id: "retained-meaning",
      name: "runner__submit_read_workloads", arguments: JSON.stringify({ allowed: [{ id: "parcel_name_count",
        description: "List parcel public name and requested count.", plan: { kind: "rows", resource: resource.id, select: ["label", "units"] } }], forbidden: [] }) }] } };
  });
  const generated = await generateModelReadWorkload({ name: "retained_native_meaning", allowedQuestions: [facts.job],
    operatorNamingContext: facts.job, generatedBoundary: native.context.candidate, provider: "openai", model: "owned-read-offline",
    apiKey: "inert-offline-key", egressAcknowledged: true, conversation, deferNarration: true, dependencies: { requestJson },
    ...{ currentEvidenceRecords: () => input.records } });
  expect(generated.workload.source.meaning_evidence).toEqual(expect.arrayContaining([
    expect.objectContaining({ ...target, reference: expect.objectContaining({ kind: "answered_clarification", text: facts.raw }) }) ]));
  expect(requestJson).toHaveBeenCalledOnce();
  const revisionRequest = vi.fn(async request => {
    const text = modelVisibleUserText(request.body);
    const line = text.split("\n").find(line => line.startsWith("Runner-derived current Read evidence: "))!;
    const meanings = JSON.parse(line.slice("Runner-derived current Read evidence: ".length));
    expect(meanings).toEqual(expect.arrayContaining([expect.objectContaining({ target,
      status: "established", authority_granted: false, evidence: expect.objectContaining({ reference: expect.objectContaining({ text: facts.raw }) }) })]));
    // The change is only the explicitly requested presentation text; the
    // responder has no hidden answer or inherited activation permission.
    return { status: 200, body: { output: [{ type: "function_call", call_id: "retained-revision",
      name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ status: "revision", summary: "Update the requested display label.",
        resource_changes: [{ resource: target.resource, settings: { field_metadata: [{ field: "units", label: "Requested parcel count" }] } }] }) }] } };
  });
  const revision = await generateModelReadBoundaryRevision({ instruction: "Label the selected unit measure Requested parcel count.",
    operatorNamingContext: facts.job, boundary: native.context.candidate, provider: "openai", model: "owned-read-offline",
    apiKey: "inert-offline-key", egressAcknowledged: true, conversation, currentEvidenceRecords: () => input.records,
    dependencies: { requestJson: revisionRequest } });
  expect(revision.policy_changes).toEqual(expect.arrayContaining([expect.objectContaining({ resource: target.resource })]));
  expect(revisionRequest).toHaveBeenCalledOnce();
}, 60_000);
