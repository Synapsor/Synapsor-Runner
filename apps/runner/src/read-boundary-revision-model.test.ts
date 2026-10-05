import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery, validateAuthoringTransportState, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { secureAskJsonRequest } from "./model-ask.js";
import { describe, expect, it, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  DEFAULT_REVIEWED_EXPLORATION_BUDGETS,
  type ExplorationBoundaryDraft,
} from "./auto-boundary.js";
import type { AskProviderDependencies } from "./model-ask.js";
import { ReadPrerequisiteCatalogTooLargeError, type ReviewedReadCurrentStatePrerequisite } from "./read-prerequisite.js";
import { parseReadPolicySettings } from "./read-boundary-policy-revision.js";
import { explorationBoundaryCandidateDigest } from "./auto-boundary.js";
import type { ReviewedReadRelationship } from "./read-relationship-review.js";
import {
  generateModelReadBoundaryRevision,
  readBoundaryRevisionCatalog,
} from "./read-boundary-revision-model.js";

function privatePrerequisite(): ReviewedReadCurrentStatePrerequisite {
  const source = { schema: "school", table: "private_admissions" };
  const fields = { tenant_column: "institution_id", principal_column: "student_id", state_column: "status",
    effective_from_column: "effective_from", effective_until_column: "effective_until" };
  return { schema_version: "synapsor.read-current-state-prerequisite.v1", source,
    subject: { tenant_column: fields.tenant_column, principal_column: fields.principal_column, unique_constraint: "one_student" },
    current_state: { state_column: fields.state_column, positive_state: "admitted", effective_from_column: fields.effective_from_column,
      effective_until_column: fields.effective_until_column, interval: "[effective_from,effective_until)", clock: "database_utc" },
    semantic_consent: { source_description: "Authoritative current admission", positive_state_description: "Admitted during the effective interval", confirmed: true },
    dependency: { schema_version: "synapsor.read-prerequisite-dependency.v1", source, fields, unique_constraint: "one_student",
      positive_state: "admitted", clock: "database_utc", fingerprint: `sha256:${"a".repeat(64)}` },
  };
}

describe("model-assisted Read Boundary field exposure revisions", () => {
  it.each([false, true])("stages a host-reviewed relationship without accepting model joins (also privacy: %s)", async privacy => {
    const draft = boundary();
    draft.pack.resources.push({ ...structuredClone(draft.pack.resources[0]!), id: "public.customers", table: "customers" });
    const before = structuredClone(draft);
    const reviewed: ReviewedReadRelationship = { schema_version: "synapsor.reviewed-read-relationship.v1",
      candidate_digest: explorationBoundaryCandidateDigest(draft), resource: "public.orders",
      relationship_id: "orders_private_customer_fk", relationship_fingerprint: `sha256:${"e".repeat(64)}` };
    const reviewRelationship = vi.fn(async () => reviewed), validateRevision = vi.fn(async () => undefined);
    let calls = 0;
    const result = await generateModelReadBoundaryRevision({ instruction: "Restore each order's reviewed customer link and preserve privacy.",
      provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: draft, egressAcknowledged: true,
      reviewRelationship, validateRevision, dependencies: { requestJson: async request => {
        calls++;
        const payload = calls === 1 ? { relationship_review_request: {
          from_resource: "public.orders", to_resource: "public.customers", reason: "Restore the requested exact association." },
        } : { resource_changes: privacy ? [{ resource: "public.orders", field_exposure: [{ field: "id", exposure: "runner_only" }] }] : [] };
        const body = request.body as { tools: Array<{ parameters: object }> };
        expect(new Ajv2020({ strict: false }).compile(body.tools[0]!.parameters)(payload)).toBe(true);
        expect(JSON.stringify(request.body)).not.toContain(reviewed.relationship_id);
        expect(JSON.stringify(request.body)).not.toContain(reviewed.relationship_fingerprint);
        return { status: 200, body: { output: [{ type: "function_call", call_id: `relationship_${calls}`,
          name: "runner__submit_read_boundary_revision", arguments: JSON.stringify(payload) }] } };
      } } });
    expect(calls).toBe(2);
    expect(reviewRelationship).toHaveBeenCalledExactlyOnceWith({ from_resource: "public.orders", to_resource: "public.customers", reason: "Restore the requested exact association." });
    expect(validateRevision).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reviewed_relationship: reviewed,
      policy_changes: [{ resource: "public.orders", settings: { relationship_ids: [reviewed.relationship_id] } }] }));
    expect(result).toMatchObject({ reviewed_relationship: reviewed, authority_granted: false, source_database_changed: false });
    expect(result.changes.length).toBe(privacy ? 1 : 0);
    expect(draft).toEqual(before);
  });

  it.each(["declined", "privacy", "vocabulary", "unknown_target", "forged_proof", "repeat"])("refuses unavailable relationship review without saving (%s)", async failure => {
    const draft = boundary();
    draft.pack.resources.push({ ...structuredClone(draft.pack.resources[0]!), id: "public.customers", table: "customers" });
    const before = structuredClone(draft);
    const reviewed: ReviewedReadRelationship = { schema_version: "synapsor.reviewed-read-relationship.v1",
      candidate_digest: explorationBoundaryCandidateDigest(draft), resource: "public.orders",
      relationship_id: "orders_private_customer_fk", relationship_fingerprint: `sha256:${"e".repeat(64)}` };
    const reviewRelationship = vi.fn(async () => failure === "declined" ? undefined : reviewed);
    const validateRevision = vi.fn(async () => undefined);
    await expect(generateModelReadBoundaryRevision({ instruction: "Restore the reviewed customer association.",
      provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: draft, egressAcknowledged: true,
      privacyOnly: failure === "privacy", vocabularyOnly: failure === "vocabulary", reviewRelationship, validateRevision,
      dependencies: { requestJson: async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "unavailable_path",
        name: "runner__submit_read_boundary_revision", arguments: JSON.stringify(failure === "forged_proof"
          ? { reviewed_relationship: reviewed, resource_changes: [] }
          : { relationship_review_request: { from_resource: "public.orders",
            to_resource: failure === "unknown_target" ? "public.secret" : "public.customers", reason: "Restore a path." } }),
      }] } }) } })).rejects.toThrow(failure === "declined" ? /READ_RELATIONSHIP_REVIEW_PENDING/ : /READ_BOUNDARY_REVISION_NOT_SUBMITTED/);
    expect(reviewRelationship).toHaveBeenCalledTimes(["declined", "repeat"].includes(failure) ? 1 : 0);
    expect(validateRevision).not.toHaveBeenCalled();
    expect(draft).toEqual(before);
  });

  it.each([
    [undefined, "clarification reason is missing; provide text of 1-500 characters."],
    [17, "clarification reason must be text of 1-500 characters; received number."],
    ["   ", "clarification reason is empty; provide text of 1-500 characters."],
    ["x".repeat(501), "clarification reason is 501 characters; maximum is 500. Shorten this text without changing the requested revision."],
  ])("distinguishes malformed clarification text and sends the exact repair to the model (%s)", async (reason, message) => {
    const draft = boundary(), before = structuredClone(draft);
    let calls = 0;
    const clarificationHandler = vi.fn();
    const result = await generateModelReadBoundaryRevision({ instruction: "Keep internal IDs private.",
      provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: draft, egressAcknowledged: true,
      clarificationHandler, dependencies: { requestJson: async request => {
        calls++;
        if (calls === 2) expect(JSON.stringify(request.body)).toContain(message);
        return { status: 200, body: { output: [{ type: "function_call", call_id: `repair_text_${calls}`,
          name: "runner__submit_read_boundary_revision", arguments: JSON.stringify(calls === 1
            ? { clarification_request: { question: "Which identifiers should remain private?", reason } }
            : { resource_changes: [{ resource: "public.orders", field_exposure: [{ field: "id", exposure: "runner_only" }] }] }),
        }] } };
      } } });
    expect(result).toMatchObject({ correction_used: true, authority_granted: false });
    expect(calls).toBe(2);
    expect(clarificationHandler).not.toHaveBeenCalled();
    expect(draft).toEqual(before);
  });

  it("recovers an unnecessary oversized private check through clarification, never by inventing admission", async () => {
    const draft = boundary(), before = structuredClone(draft);
    const reviewPrivatePrerequisite = vi.fn(async () => { throw new ReadPrerequisiteCatalogTooLargeError(); });
    const clarificationHandler = vi.fn(async () => ({ state: "answered" as const, answer: "Only hide internal IDs. Keep existing scope; no new status requirement." }));
    const validateRevision = vi.fn(async () => undefined);
    let calls = 0;
    const result = await generateModelReadBoundaryRevision({ instruction: "Keep internal IDs private for signed-in customers.",
      provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: draft, egressAcknowledged: true,
      reviewPrivatePrerequisite, clarificationHandler, validateRevision, dependencies: { requestJson: async request => {
        calls++;
        if (calls === 2) expect(JSON.stringify(request.body)).toContain("READ_PREREQUISITE_CATALOG_TOO_LARGE");
        const payload = calls === 1 ? { private_prerequisite_request: { reason: "Current customer access." } }
          : calls === 2 ? { clarification_request: { question: "Is there a new current-status requirement, or only field privacy?", reason: "The requested status mapping was not available." } }
            : { resource_changes: [{ resource: "public.orders", field_exposure: [{ field: "id", exposure: "runner_only" }] }] };
        return { status: 200, body: { output: [{ type: "function_call", call_id: `recover_${calls}`,
          name: "runner__submit_read_boundary_revision", arguments: JSON.stringify(payload) }] } };
      } } });
    expect(calls).toBe(3);
    expect(reviewPrivatePrerequisite).toHaveBeenCalledOnce();
    expect(clarificationHandler).toHaveBeenCalledOnce();
    expect(validateRevision).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ correction_used: true, authority_granted: false, changes: [expect.objectContaining({ field: "id", after: "runner_only" })] });
    expect(result.read_prerequisite).toBeUndefined();
    expect(draft).toEqual(before);
  });

  it("does not retry a rejected private source review indefinitely or mask a stale host revision", async () => {
    for (const failure of [new ReadPrerequisiteCatalogTooLargeError(), new Error("READ_PREREQUISITE_REVIEW_STALE")]) {
      const reviewPrivatePrerequisite = vi.fn(async () => { throw failure; });
      const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "repeat_private",
        name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ private_prerequisite_request: { reason: "Admission is required." } }) }] } }));
      await expect(generateModelReadBoundaryRevision({ instruction: "Require admission for reads.", provider: "openai", model: "gpt-test",
        apiKey: "test-key", boundary: boundary(), egressAcknowledged: true, reviewPrivatePrerequisite, dependencies: { requestJson } }))
        .rejects.toThrow(failure instanceof ReadPrerequisiteCatalogTooLargeError ? /not available again/ : /READ_PREREQUISITE_REVIEW_STALE/);
      expect(reviewPrivatePrerequisite).toHaveBeenCalledOnce();
      expect(requestJson.mock.calls.length).toBe(failure instanceof ReadPrerequisiteCatalogTooLargeError ? 2 : 1);
    }
  });
  it("does not disclose a saved private mapping in an ordinary field edit catalog", async () => {
    const draft = boundary();
    draft.read_prerequisite = privatePrerequisite();
    const catalog = readBoundaryRevisionCatalog(draft);
    expect(catalog.current_private_access_condition).toMatchObject({ configured: true, fingerprint: expect.any(String) });
    expect(JSON.stringify(catalog)).not.toContain("private_admissions");
    await generateModelReadBoundaryRevision({ instruction: "Keep IDs private.", provider: "anthropic", model: "other-provider",
      apiKey: "test-key", boundary: draft, egressAcknowledged: true, dependencies: { requestJson: async request => {
        expect(JSON.stringify(request.body)).not.toContain("private_admissions");
        return { status: 200, body: { id: "field_edit", type: "message", role: "assistant", model: "other-provider",
          content: [{ type: "tool_use", id: "private_fields", name: "runner__submit_read_boundary_revision",
            input: { resource_changes: [{ resource: "public.orders", field_exposure: [{ field: "id", exposure: "runner_only" }] }] } }],
          stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } } };
      } } });
  });
  it("maps private Read evidence through the host before submitting a combined disabled revision", async () => {
    const prerequisite = privatePrerequisite();
    const reviewPrivatePrerequisite = vi.fn(async () => prerequisite);
    const validateRevision = vi.fn(async () => undefined);
    const draft = boundary(), before = structuredClone(draft);
    let calls = 0;
    const result = await generateModelReadBoundaryRevision({ instruction: "Require current admission for every read; keep internal IDs private.",
      provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: draft, egressAcknowledged: true,
      reviewPrivatePrerequisite, validateRevision,
      dependencies: { requestJson: async request => {
        calls++;
        const body = request.body as { tools: Array<{ name: string; parameters: object }> };
        const payload = calls === 1 ? { private_prerequisite_request: { reason: "Every read requires authoritative current admission." } }
          : { resource_changes: [{ resource: "public.orders", field_exposure: [{ field: "id", exposure: "runner_only" }] }] };
        expect(new Ajv2020({ strict: false }).compile(body.tools[0]!.parameters)(payload)).toBe(true);
        if (calls === 1) expect(JSON.stringify(request.body)).not.toContain("private_admissions");
        else expect(JSON.stringify(request.body)).toContain("private_admissions");
        return { status: 200, body: { output: [{ type: "function_call", call_id: `private_${calls}`,
          name: "runner__submit_read_boundary_revision", arguments: JSON.stringify(payload),
        }] } };
      } },
    });
    expect(calls).toBe(2);
    expect(reviewPrivatePrerequisite).toHaveBeenCalledOnce();
    expect(validateRevision).toHaveBeenCalledWith(expect.objectContaining({ read_prerequisite: prerequisite, changes: [expect.objectContaining({ field: "id", after: "runner_only" })] }));
    expect(result).toMatchObject({ read_prerequisite: prerequisite, authority_granted: false, source_query_executed: false, correction_used: false });
    expect(draft).toEqual(before);
  });

  it.each([false, true])("accepts an empty resource diff only with a host-reviewed private check (mapped: %s)", async mapped => {
    let calls = 0;
    const run = generateModelReadBoundaryRevision({ instruction: "Allow reads only during current admission.",
      provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: boundary(), egressAcknowledged: true,
      reviewPrivatePrerequisite: async () => privatePrerequisite(),
      dependencies: { requestJson: async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: `empty_${++calls}`,
        name: "runner__submit_read_boundary_revision", arguments: JSON.stringify(mapped && calls === 1
          ? { private_prerequisite_request: { reason: "Current admission required." } } : { resource_changes: [] }),
      }] } }) },
    });
    if (mapped) await expect(run).resolves.toMatchObject({ changes: [], read_prerequisite: privatePrerequisite(), authority_granted: false });
    else await expect(run).rejects.toThrow("resource_changes");
    expect(calls).toBe(2);
  });

  it("preserves the previous draft when private evidence review is declined", async () => {
    const draft = boundary(), before = structuredClone(draft);
    const validateRevision = vi.fn();
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "pending",
      name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ private_prerequisite_request: { reason: "Admission is required for reads." } }),
    }] } }));
    await expect(generateModelReadBoundaryRevision({ instruction: "Require admission before reads.",
      provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: draft, egressAcknowledged: true,
      reviewPrivatePrerequisite: async () => undefined, validateRevision, dependencies: { requestJson },
    })).rejects.toThrow("READ_PREREQUISITE_REVIEW_PENDING");
    expect(requestJson).toHaveBeenCalledOnce();
    expect(validateRevision).not.toHaveBeenCalled();
    expect(draft).toEqual(before);
  });

  it.each([true, false])("keeps the confirmed private check through a bounded field correction (fixed: %s)", async fixed => {
    const reviewPrivatePrerequisite = vi.fn(async () => privatePrerequisite());
    let calls = 0;
    const validateRevision = vi.fn(async () => {
      if (calls === 2 || !fixed) throw new Error("The requested private field still has a model filter operation.");
    });
    const draft = boundary(), before = structuredClone(draft);
    const run = generateModelReadBoundaryRevision({ instruction: "Require current admission and keep IDs private.",
      provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: draft, egressAcknowledged: true,
      reviewPrivatePrerequisite, validateRevision, dependencies: { requestJson: async request => {
        calls++;
        if (calls === 3) {
          expect(JSON.stringify(request.body)).toContain("requested private field still has a model filter operation");
          expect(JSON.stringify(request.body)).toContain("private_admissions");
        }
        return { status: 200, body: { output: [{ type: "function_call", call_id: `repair_${calls}`,
          name: "runner__submit_read_boundary_revision", arguments: JSON.stringify(calls === 1
            ? { private_prerequisite_request: { reason: "Admission required." } }
            : { resource_changes: [{ resource: "public.orders", field_exposure: [{ field: "id", exposure: "runner_only" }] }] }),
        }] } };
      } },
    });
    if (fixed) await expect(run).resolves.toMatchObject({ correction_used: true, read_prerequisite: privatePrerequisite() });
    else await expect(run).rejects.toThrow("requested private field still has a model filter operation");
    expect(calls).toBe(3);
    expect(reviewPrivatePrerequisite).toHaveBeenCalledOnce();
    expect(draft).toEqual(before);
    expect(validateRevision).toHaveBeenLastCalledWith(expect.objectContaining({ read_prerequisite: privatePrerequisite() }));
  });

  it("does not accept a model-invented private check or offer source review during vocabulary-only edits", async () => {
    const reviewPrivatePrerequisite = vi.fn(async () => privatePrerequisite());
    await expect(generateModelReadBoundaryRevision({ instruction: "Name the status.", vocabularyOnly: true,
      provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: boundary(), egressAcknowledged: true,
      reviewPrivatePrerequisite, dependencies: { requestJson: async request => {
        expect(JSON.stringify((request.body as { tools: unknown[] }).tools)).not.toContain("private_prerequisite_request");
        return { status: 200, body: { output: [{ type: "function_call", call_id: "invented",
          name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ resource_changes: [], read_prerequisite: privatePrerequisite() }),
        }] } };
      } },
    })).rejects.toThrow("Unexpected Read revision property");
    expect(reviewPrivatePrerequisite).not.toHaveBeenCalled();
  });
  it("accepts explicit resource exclusion without allowing restoration or mixed field edits", async () => {
    const draft = boundary(), before = structuredClone(draft);
    const catalog = readBoundaryRevisionCatalog(draft).resources[0]!;
    expect(parseReadPolicySettings({ exclude: true }, catalog)).toEqual({ exclude: true });
    for (const settings of [{ exclude: false }, { exclude: true, selectable_fields: [] }, { include: true }]) {
      expect(() => parseReadPolicySettings(settings, catalog)).toThrow();
    }
    let calls = 0;
    const result = await generateModelReadBoundaryRevision({ instruction: "Remove order information from customer Read access entirely, including counts.",
      provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: draft,
      egressAcknowledged: true, dependencies: { requestJson: async request => {
        if (++calls > 1) expect(JSON.stringify(request.body)).toContain("Omit field_exposure");
        return { status: 200, body: { output: [{ type: "function_call", call_id: `exclude_${calls}`,
          name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ resource_changes: [{ resource: "public.orders",
            settings: { exclude: true }, ...(calls === 1 ? { field_exposure: [{ field: "id", exposure: "kept_out" }] } : {}),
          }] }),
        }] } };
      } } });
    expect(result).toMatchObject({ changes: [], policy_changes: [{ resource: "public.orders", settings: { exclude: true } }],
      correction_used: true, authority_granted: false });
    expect(draft).toEqual(before);
  });

  it("rejects exclusion bundled with relationship authority and accepts one explicit correction", async () => {
    let calls = 0;
    const result = await generateModelReadBoundaryRevision({
      instruction: "Make institutions unavailable for Read because no own-registration entry path exists.",
      provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: boundary(), egressAcknowledged: true,
      dependencies: { requestJson: async request => {
        calls += 1;
        if (calls === 2) {
          expect(JSON.stringify(request.body)).toContain("exclude must be true and used alone");
          expect(JSON.stringify(request.body)).toContain("Do not repeat it");
        }
        return { status: 200, body: { output: [{ type: "function_call", call_id: `exclude_relationship_${calls}`,
          name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ resource_changes: [{ resource: "public.orders",
            settings: calls === 1 ? { exclude: true, relationship_only: true } : { exclude: true },
          }] }),
        }] } };
      } },
    });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ changes: [], policy_changes: [{ resource: "public.orders", settings: { exclude: true } }],
      correction_used: true, authority_granted: false, source_database_changed: false });
  });

  it("does not turn a guided field privacy repair into removal of business information", async () => {
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "too_broad",
      name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ resource_changes: [{ resource: "public.orders", settings: { exclude: true } }] }),
    }] } }));
    await expect(generateModelReadBoundaryRevision({ instruction: "Keep internal fields private while retaining business information.",
      privacyOnly: true, provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: boundary(),
      egressAcknowledged: true, dependencies: { requestJson } })).rejects.toThrow("general access revision");
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("corrects a selectable list that conflicts with an exclusion (new exclusion: %s)", async newlyExcluded => {
    let calls = 0;
    const field = newlyExcluded ? "id" : "secret_note";
    const validateRevision = vi.fn(async () => undefined);
    const result = await generateModelReadBoundaryRevision({ instruction: "Keep the private field excluded while changing the row selection list.",
      provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: boundary(), egressAcknowledged: true, validateRevision,
      dependencies: { requestJson: async request => {
        if (++calls > 1) expect(JSON.stringify(request.body)).toContain(`public.orders.${field} is kept out`);
        return { status: 200, body: { output: [{ type: "function_call", call_id: `exclude_conflict_${calls}`,
          name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ resource_changes: [{ resource: "public.orders",
            field_exposure: [{ field, exposure: "kept_out" }], settings: { selectable_fields: ["status", ...(calls === 1 ? [field] : [])] },
          }] }),
        }] } };
      } } });
    expect(calls).toBe(2);
    expect(validateRevision).toHaveBeenCalledOnce();
    expect(result.policy_changes).toEqual([{ resource: "public.orders", settings: { selectable_fields: ["status"] } }]);
    expect(result.authority_granted).toBe(false);
  });

  it.each(["partial", "noop"])("corrects an incomplete vocabulary-only repair including its opaque table (%s)", async attempt => {
    const draft = boundary(), resource = draft.pack.resources[0]!;
    resource.id = "public.r19"; resource.table = "r19";
    for (const field of ["c03", "c04", "c05", "c06", "c07"]) {
      resource.field_types[field] = "text"; resource.selectable_fields.push(field);
      resource.field_metadata ??= {}; resource.field_metadata[field] = { label: `Reviewed ${field}` };
    }
    const before = structuredClone(draft), validateRevision = vi.fn();
    let calls = 0;
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "table_vocabulary",
      name: "runner__submit_read_boundary_revision", arguments: JSON.stringify(++calls === 1
        ? attempt === "partial" ? { resource_changes: [{ resource: "public.r19", settings: { field_metadata: [{ field: "c03", label: "Shipment number" }] } }] }
          : { status: "already_satisfied", resource_changes: [{ resource: "public.r19", field_exposure: [{ field: "status", exposure: "model_and_runner" }] }] }
        : { resource_changes: [{ resource: "public.r19", settings: { metadata: { label: "Shipment requests" } } }] }) }] } }));
    const result = await generateModelReadBoundaryRevision({ instruction: "Complete the missing reviewed vocabulary.",
      operatorNamingContext: "public.r19 contains shipment requests.", vocabularyOnly: true, provider: "openai", model: "gpt-test",
      apiKey: "test-key", boundary: draft, egressAcknowledged: true, dependencies: { requestJson }, validateRevision });
    expect(requestJson).toHaveBeenCalledTimes(2); expect(result.correction_used).toBe(true);
    expect(JSON.stringify(requestJson.mock.calls[1])).toContain("READ_VOCABULARY_INCOMPLETE");
    expect(validateRevision).toHaveBeenCalledOnce();
    expect(result.policy_changes).toEqual([{ resource: "public.r19", settings: { metadata: { label: "Shipment requests" } } }]);
    expect(result.authority_granted).toBe(false); expect(draft).toEqual(before);
  });

  it.each(["partial", "noop", "clear_table", "clear_field", "empty_field_metadata"])("refuses persistently incomplete vocabulary without a validation or activation claim (%s)", async failure => {
    const draft = boundary(), resource = draft.pack.resources[0]!;
    resource.id = "public.r19"; resource.table = "r19";
    resource.field_types.c03 = "text"; resource.selectable_fields.push("c03");
    if (failure === "clear_table") resource.label = "Shipment requests";
    if (failure === "clear_field") resource.field_metadata = { c03: { label: "Shipment number" } };
    const before = structuredClone(draft), validateRevision = vi.fn();
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "incomplete_vocabulary",
      name: "runner__submit_read_boundary_revision", arguments: JSON.stringify(failure === "noop"
        ? { status: "already_satisfied", resource_changes: [{ resource: resource.id, field_exposure: [{ field: "status", exposure: "model_and_runner" }] }] }
        : { resource_changes: [{ resource: resource.id, settings: {
          metadata: { label: failure === "clear_table" ? null : "Shipment requests" },
          ...(failure !== "partial" ? { field_metadata: [{ field: "c03", ...(failure === "empty_field_metadata" ? {} : { label: failure === "clear_field" ? null : "Shipment number" }) }] } : {}),
        } }] }) }] } }));
    await expect(generateModelReadBoundaryRevision({ instruction: "Complete the missing reviewed vocabulary.", vocabularyOnly: true,
      provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: draft, egressAcknowledged: true,
      dependencies: { requestJson }, validateRevision })).rejects.toThrow("READ_VOCABULARY_INCOMPLETE");
    expect(requestJson).toHaveBeenCalledTimes(2); expect(validateRevision).not.toHaveBeenCalled();
    expect(JSON.stringify(requestJson.mock.calls[1])).toContain("Rejected revision submission"); expect(draft).toEqual(before);
  });

  it.each(["answered", "declined"])("delivers a genuine naming question from the bounded vocabulary correction (%s)", async decision => {
    const draft = boundary(), resource = draft.pack.resources[0]!;
    resource.id = "public.r19"; resource.table = "r19";
    const before = structuredClone(draft), validateRevision = vi.fn();
    const clarificationHandler = vi.fn().mockResolvedValue({ state: decision, answer: "This view contains shipment requests." });
    let calls = 0;
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "vocabulary_question",
      name: "runner__submit_read_boundary_revision", arguments: JSON.stringify(++calls === 2
        ? { clarification_request: { question: "Which business records are in this view?", reason: "The supplied job does not explain public.r19." } }
        : { resource_changes: [{ resource: resource.id, settings: calls === 1
          ? { field_metadata: [{ field: "status", label: "Lifecycle" }] } : { metadata: { description: "Shipment requests" } } }] }) }] } }));
    const result = generateModelReadBoundaryRevision({ instruction: "Name this view without guessing its business meaning.", vocabularyOnly: true,
      provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: draft, egressAcknowledged: true,
      dependencies: { requestJson }, validateRevision, clarificationHandler });
    if (decision === "answered") await expect(result).resolves.toMatchObject({ correction_used: true, authority_granted: false,
      changes: [], policy_changes: [{ resource: resource.id, settings: { metadata: { description: "Shipment requests" } } }] });
    else await expect(result).rejects.toThrow("READ_BOUNDARY_REVISION_CLARIFICATION_DECLINED");
    expect(calls).toBe(decision === "answered" ? 3 : 2); expect(clarificationHandler).toHaveBeenCalledOnce();
    expect(validateRevision).toHaveBeenCalledTimes(decision === "answered" ? 1 : 0); expect(draft).toEqual(before);
  });

  it.each(["unknown_resource", "unknown_field", "stale"])("keeps vocabulary repair bound to the exact current catalog (%s)", async failure => {
    const draft = boundary(), resource = draft.pack.resources[0]!;
    resource.id = "public.r19"; resource.table = "r19";
    const validateRevision = vi.fn();
    const requestJson = vi.fn(async () => {
      if (failure === "stale") draft.budgets.max_rows = 1;
      return { status: 200, body: { output: [{ type: "function_call", call_id: "exact_vocabulary",
        name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ resource_changes: [{
          resource: failure === "unknown_resource" ? "public.r19_private" : resource.id,
          settings: { metadata: { label: "Shipment requests" },
            ...(failure === "unknown_field" ? { field_metadata: [{ field: "status_private", label: "Lifecycle" }] } : {}),
          },
        }] }) }] } };
    });
    const result = generateModelReadBoundaryRevision({ instruction: "Name the shipment request view.", vocabularyOnly: true,
      provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: draft, egressAcknowledged: true, dependencies: { requestJson }, validateRevision });
    if (failure === "stale") await expect(result).rejects.toMatchObject({ code: "ASK_AUTHORITY_CHANGED" });
    else await expect(result).rejects.toThrow(failure === "unknown_resource" ? "not an exact resource" : "Unknown or repeated metadata field");
    expect(validateRevision).not.toHaveBeenCalled(); expect(requestJson).toHaveBeenCalledTimes(failure === "stale" ? 1 : 2);
  });

  it("completes table and public field vocabulary without exposing private fields or replacing reviewed metadata", async () => {
    const draft = boundary(), resource = draft.pack.resources[0]!;
    resource.id = "public.r19"; resource.table = "r19";
    resource.field_types.c03 = "text"; resource.selectable_fields.push("c03");
    resource.field_metadata = { c03: { description: "Reviewed shipment number" }, status: { label: "Lifecycle" } };
    resource.field_types.c99 = "text"; resource.kept_out_fields.push("c99");
    resource.model_withheld_fields = ["id"];
    const before = structuredClone(draft), validateRevision = vi.fn();
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "complete_vocabulary",
      name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ resource_changes: [{ resource: resource.id,
        settings: { metadata: { description: "Shipment requests" }, field_metadata: [{ field: "c03", label: "Shipment number" }] },
      }] }) }] } }));
    const result = await generateModelReadBoundaryRevision({ instruction: "Name this shipment request view and its shipment number.", vocabularyOnly: true,
      provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: draft, egressAcknowledged: true, dependencies: { requestJson }, validateRevision });
    expect(result).toMatchObject({ changes: [], correction_used: false, model_exposure_expansions: 0, authority_granted: false, source_query_executed: false });
    expect(validateRevision).toHaveBeenCalledOnce(); expect(draft).toEqual(before);
  });

  it.each(["metadata", "access", "limit", "operations", "relationships", "scope", "private_exposure"])("keeps a vocabulary repair metadata-only (%s)", async (attempt) => {
    const draft = boundary(), before = structuredClone(draft);
    let calls = 0;
    const requestJson = vi.fn(async (request) => {
      calls++;
      expect(JSON.stringify(request)).toContain("vocabulary-only");
      return { status: 200, body: { output: [{ type: "function_call", call_id: "vocabulary",
        name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ resource_changes: [{ resource: "public.orders",
          ...(attempt === "access" && calls === 1 ? { field_exposure: [{ field: "status", exposure: "runner_only" }] } : {}),
          ...(attempt === "private_exposure" && calls === 1 ? { field_exposure: [{ field: "secret_note", exposure: "model_and_runner" }] } : {}),
          settings: { field_metadata: [{ field: "status", label: "Order lifecycle", description: "The operator identified the order lifecycle status." }],
            ...(attempt === "limit" && calls === 1 ? { max_rows: 20 } : {}),
            ...(attempt === "operations" && calls === 1 ? { filterable_fields: [] } : {}),
            ...(attempt === "relationships" && calls === 1 ? { relationship_ids: [] } : {}),
            ...(attempt === "scope" && calls === 1 ? { relationship_only: true } : {}),
          },
        }] }),
      }] } };
    });
    const result = await generateModelReadBoundaryRevision({ instruction: "Name the order lifecycle status using the supplied meaning.",
      vocabularyOnly: true, provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: draft,
      egressAcknowledged: true, dependencies: { requestJson } });
    expect(result.changes).toEqual([]);
    expect(result.policy_changes).toEqual([{ resource: "public.orders", settings: { field_metadata: [
      { field: "status", label: "Order lifecycle", description: "The operator identified the order lifecycle status." },
    ] } }]);
    expect(result.correction_used).toBe(attempt !== "metadata");
    expect(calls).toBe(attempt === "metadata" ? 1 : 2);
    expect(draft).toEqual(before);
    expect(result.authority_granted).toBe(false);
  });

  it.each([true, false])("advertises valid exposure combinations and precisely corrects an irrelevant operation option (recovers: %s)", async (recovers) => {
    const draft = boundary(), before = structuredClone(draft);
    let calls = 0;
    const requestJson: NonNullable<AskProviderDependencies["requestJson"]> = async (request) => {
      calls += 1;
      const payload = { status: "revision", resource_changes: [{ resource: "public.orders", field_exposure: [
        { field: "status", exposure: "model_and_runner", ...(!recovers || calls === 1 ? { model_operations: "none" } : {}) },
        { field: "id", exposure: "runner_only", model_operations: "none" },
      ] }] };
      const body = request.body as { tools: Array<{ name: string; parameters: object }> };
      const tool = body.tools.find((item) => item.name === "runner__submit_read_boundary_revision")!;
      const validate = new Ajv2020({ strict: false }).compile(tool.parameters);
      expect(validate(payload)).toBe(recovers && calls > 1);
      const valid = structuredClone(payload);
      delete valid.resource_changes[0]!.field_exposure[0]!.model_operations;
      expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
      if (calls > 1) {
        expect(JSON.stringify(request.body)).toContain("public.orders.status");
        expect(JSON.stringify(request.body)).toContain("omit model_operations entirely");
      }
      return { status: 200, body: { output: [{ type: "function_call", call_id: `attempt_${calls}`,
        name: "runner__submit_read_boundary_revision", arguments: JSON.stringify(payload) }] } };
    };
    const result = generateModelReadBoundaryRevision({ instruction: "Keep order status customer-facing and IDs private.",
      privacyOnly: true, provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: draft,
      egressAcknowledged: true, dependencies: { requestJson } });
    if (recovers) await expect(result).resolves.toMatchObject({ correction_used: true,
      changes: [{ field: "id", after: "runner_only", model_operations: "none" }],
      confirmed_fields: [{ field: "status", after: "model_and_runner" }], authority_granted: false });
    else await expect(result).rejects.toThrow("public.orders.status: model_operations");
    expect(calls).toBe(2);
    expect(draft).toEqual(before);
  });

  it.each([false, true])("reconciles explicitly confirmed visible fields without inventing access changes (partial: %s)", async (partial) => {
    const draft = boundary(), before = structuredClone(draft);
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "reconcile",
      name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ status: partial ? "revision" : "already_satisfied",
        resource_changes: [{ resource: "public.orders", field_exposure: [
          { field: "status", exposure: "model_and_runner", rationale: "Customer-facing information remains visible." },
          ...(partial ? [{ field: "id", exposure: "runner_only", model_operations: "none" }] : []),
        ] }],
      }),
    }] } }));
    const result = await generateModelReadBoundaryRevision({ instruction: "Customers should see order status. Keep internal IDs private.",
      privacyOnly: true, provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: draft,
      egressAcknowledged: true, dependencies: { requestJson } });
    expect(result.confirmed_fields).toMatchObject([{ resource: "public.orders", field: "status", before: "model_and_runner", after: "model_and_runner" }]);
    expect(result.checked_catalog_digest).toBe(readBoundaryRevisionCatalog(draft).digest);
    expect(result.changes).toHaveLength(partial ? 1 : 0);
    if (partial) expect(result.changes[0]).toMatchObject({ field: "id", after: "runner_only" });
    expect(result.correction_used).toBe(false);
    expect(result.authority_granted).toBe(false);
    expect(requestJson).toHaveBeenCalledOnce();
    expect(draft).toEqual(before);
  });

  it("refuses a claimed no-op when any requested field is not in that state", async () => {
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "not_satisfied",
      name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ status: "already_satisfied",
        resource_changes: [{ resource: "public.orders", field_exposure: [{ field: "id", exposure: "runner_only" }] }],
      }),
    }] } }));
    await expect(generateModelReadBoundaryRevision({ instruction: "Keep internal IDs private.",
      privacyOnly: true, provider: "openai", model: "gpt-test", apiKey: "test-key", boundary: boundary(),
      egressAcknowledged: true, dependencies: { requestJson } })).rejects.toThrow("not already satisfied");
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])("corrects private-access expansion during a narrow privacy review (recovers: %s)", async (recovers) => {
    const draft = boundary(), before = structuredClone(draft);
    const requests: string[] = [];
    const validateRevision = vi.fn(async () => undefined);
    const operation = generateModelReadBoundaryRevision({
      instruction: "Keep internal identifiers private. Preserve exclusions and customer-facing information.",
      privacyOnly: true, provider: "openai", model: "gpt-test", apiKey: "test-only", boundary: draft, egressAcknowledged: true,
      validateRevision,
      dependencies: { requestJson: async (request) => {
        requests.push(JSON.stringify(request));
        return { status: 200, body: { output: [{ type: "function_call", call_id: "privacy",
          name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ resource_changes: [{ resource: "public.orders",
            field_exposure: ["id", ...(!recovers || requests.length === 1 ? ["tenant_id"] : [])]
              .map((field) => ({ field, exposure: "runner_only" })),
          }] }),
        }] } };
      } },
    });
    if (recovers) {
      const result = await operation;
      expect(result.changes).toMatchObject([{ field: "id", after: "runner_only" }]);
      expect(result.changes).toHaveLength(1);
      expect(result.correction_used).toBe(true);
      expect(validateRevision).toHaveBeenCalledOnce();
    } else {
      await expect(operation).rejects.toThrow("Privacy-only review cannot grant new access to public.orders.tenant_id");
      expect(validateRevision).not.toHaveBeenCalled();
    }
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("Preserve existing exclusions and omit these grants");
    expect(draft).toEqual(before);
  });
  it("omits already private unselected identifiers instead of adding private selection grants", async () => {
    const draft = boundary();
    const resource = draft.pack.resources[0]!;
    resource.selectable_fields = resource.selectable_fields.filter((field) => field !== "id");
    const before = structuredClone(draft);
    const result = await generateModelReadBoundaryRevision({
      instruction: "Keep internal IDs private and retain useful customer references.",
      provider: "openai", model: "gpt-test", apiKey: "test-only", boundary: draft, egressAcknowledged: true,
      dependencies: { requestJson: async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "privacy",
        name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ resource_changes: [{ resource: "public.orders",
          field_exposure: [{ field: "id", exposure: "runner_only" }],
        }] }),
      }] } }) },
    });
    expect(result.changes).toEqual([]);
    expect(draft).toEqual(before);
    expect(result.authority_granted).toBe(false);
  });

  it("retains an explicit private decision when accompanying settings newly allow row selection", async () => {
    const draft = boundary();
    const selected = [...draft.pack.resources[0]!.selectable_fields];
    draft.pack.resources[0]!.selectable_fields = selected.filter((field) => field !== "id");
    const result = await generateModelReadBoundaryRevision({
      instruction: "Allow private selection of the ID for this Read draft, never send it to the agent.",
      provider: "openai", model: "gpt-test", apiKey: "test-only", boundary: draft, egressAcknowledged: true,
      dependencies: { requestJson: async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "privacy",
        name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ resource_changes: [{ resource: "public.orders",
          field_exposure: [{ field: "id", exposure: "runner_only" }], settings: { selectable_fields: selected },
        }] }),
      }] } }) },
    });
    expect(result.changes).toMatchObject([{ field: "id", after: "runner_only", model_operations: "none" }]);
    expect(result.policy_changes?.[0]?.settings.selectable_fields).toContain("id");
  });
  it("does not classify business policy names as private controls and reports actual return authority", () => {
    const draft = boundary();
    const resource = draft.pack.resources[0]!;
    Object.assign(resource.field_types, { data_policy: "text", target_data_policy: "text", eligibility_terms: "text", x17: "text", created_at: "timestamp" });
    resource.selectable_fields.push("data_policy", "target_data_policy", "eligibility_terms");
    const catalog = readBoundaryRevisionCatalog(draft).resources[0]!;
    for (const name of ["data_policy", "target_data_policy", "eligibility_terms", "x17"]) {
      expect(catalog.fields.find((field) => field.id === name)!.roles).not.toContain("private_policy_candidate");
    }
    expect(catalog.fields.find((field) => field.id === "created_at")).toMatchObject({ raw_return: false, model_operations: [] });
    expect(catalog.fields.find((field) => field.id === "auto_approval_eligible")!.roles).toContain("private_policy_candidate");
  });

  it("can remove inference operations from an already raw-withheld field without changing raw visibility", async () => {
    const draft = boundary();
    draft.pack.resources[0]!.model_withheld_fields = ["status"];
    const result = await generateModelReadBoundaryRevision({
      instruction: "Keep status entirely private; remove model analysis but retain Runner verification.",
      provider: "openai", model: "gpt-test", apiKey: "test-only", boundary: draft, egressAcknowledged: true,
      dependencies: { requestJson: async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "privacy",
        name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ resource_changes: [{ resource: "public.orders",
          field_exposure: [{ field: "status", exposure: "runner_only", model_operations: "none" }],
        }] }),
      }] } }) },
    });
    expect(result.changes).toMatchObject([{ before: "runner_only", after: "runner_only", field: "status", model_operations: "none" }]);
  });
  it("corrects a Runner-only decision that also removes the field from selectable_fields", async () => {
    const original = boundary();
    const before = structuredClone(original);
    const requests: string[] = [];
    const validateRevision = vi.fn(async () => undefined);
    const result = await generateModelReadBoundaryRevision({
      instruction: "Keep internal database IDs private but available to Runner; retain customer references.",
      provider: "openai", model: "gpt-test", apiKey: "test-only", boundary: original, egressAcknowledged: true,
      validateRevision,
      dependencies: { requestJson: async (request) => {
        requests.push(JSON.stringify(request));
        return { status: 200, body: { output: [{ type: "function_call", call_id: "privacy",
          name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ resource_changes: [{
            resource: "public.orders", field_exposure: [{ field: "id", exposure: "runner_only" }],
            ...(requests.length === 1 ? { settings: { selectable_fields: ["status"] } } : {}),
          }] }),
        }] } };
      } },
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("public.orders.id is marked runner_only, but settings.selectable_fields removes Runner's access");
    expect(validateRevision).toHaveBeenCalledOnce();
    expect(result.correction_used).toBe(true);
    expect(result.changes).toMatchObject([{ field: "id", after: "runner_only" }]);
    expect(result.policy_changes).toBeUndefined();
    expect(original).toEqual(before);
  });

  it.each([true, false])("validates the complete candidate before acceptance (correction succeeds: %s)", async (recovers) => {
    const requests: string[] = [];
    const validateRevision = vi.fn(async () => {
      if (!recovers || validateRevision.mock.calls.length === 1) {
        throw new Error("Reviewed model-withheld decision for public.orders.id was not reflected in the disabled candidate.");
      }
    });
    const result = generateModelReadBoundaryRevision({
      instruction: "Keep internal IDs private without losing Runner verification fields.",
      provider: "openai", model: "gpt-test", apiKey: "test-only", boundary: boundary(), egressAcknowledged: true,
      validateRevision,
      dependencies: { requestJson: async (request) => {
        requests.push(JSON.stringify(request));
        return { status: 200, body: { output: [{ type: "function_call", call_id: "privacy",
          name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ resource_changes: [{
            resource: "public.orders", field_exposure: [{ field: "id", exposure: "runner_only" }],
          }] }),
        }] } };
      } },
    });
    if (recovers) await expect(result).resolves.toMatchObject({ correction_used: true, authority_granted: false });
    else await expect(result).rejects.toThrow("Reviewed model-withheld decision for public.orders.id");
    expect(requests).toHaveLength(2);
    expect(validateRevision).toHaveBeenCalledTimes(2);
    expect(requests[1]).toContain("Reviewed model-withheld decision for public.orders.id");
  });

  it("refuses a correction that drops the failed private-field decision", async () => {
    let attempt = 0;
    const validateRevision = vi.fn(async () => undefined);
    await expect(generateModelReadBoundaryRevision({
      instruction: "Keep IDs and versions private and available to Runner.",
      provider: "openai", model: "gpt-test", apiKey: "test-only", boundary: boundary(), egressAcknowledged: true,
      validateRevision,
      dependencies: { requestJson: async () => {
        attempt += 1;
        return { status: 200, body: { output: [{ type: "function_call", call_id: "privacy",
          name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ resource_changes: [{ resource: "public.orders",
            field_exposure: (attempt === 1 ? ["id", "version"] : ["version"]).map((field) => ({ field, exposure: "runner_only" })),
            ...(attempt === 1 ? { settings: { selectable_fields: ["status", "version"] } } : {}),
          }] }),
        }] } };
      } },
    })).rejects.toThrow("correction dropped the Runner-only decision for public.orders.id");
    expect(attempt).toBe(2);
    expect(validateRevision).not.toHaveBeenCalled();
  });

  it("retains the exact 36-field privacy diff without hiding business references or discarding private facts", async () => {
    const reviewed = boundary();
    const names = ["accounts", "memberships", "subscribers", "subscriptions", "lines", "usage", "invoices", "payments", "preferences", "cases", "notes", "offers"];
    reviewed.pack.resources = names.map((table) => {
      const resource = structuredClone(reviewed.pack.resources[0]!);
      return { ...resource, id: `telecom.${table}`, schema: "telecom", table,
        field_types: { ...resource.field_types, invoice_number: "text", case_number: "text" },
        selectable_fields: [...resource.selectable_fields, "invoice_number", "case_number"] };
    });
    const before = structuredClone(reviewed);
    const fields = ["id", "version", "auto_approval_eligible"];
    const result = await generateModelReadBoundaryRevision({
      instruction: "Keep useful customer information visible, but keep internal IDs, versions and approval controls private. Runner still needs them. Preserve invoice and case numbers, rules and limits.",
      provider: "openai", model: "gpt-5.6-terra", apiKey: "test-only", boundary: reviewed, egressAcknowledged: true,
      dependencies: { requestJson: async () => ({ status: 200, body: { output: [{
        type: "function_call", call_id: "privacy", name: "runner__submit_read_boundary_revision",
        arguments: JSON.stringify({ resource_changes: reviewed.pack.resources.map((resource) => ({
          resource: resource.id, field_exposure: fields.map((field) => ({ field, exposure: "runner_only" })),
        })) }),
      }] } }) },
    });
    expect(result.changes.map(({ resource, field, before, after }) => ({ resource, field, before, after })))
      .toEqual(reviewed.pack.resources.flatMap((resource) => fields.map((field) => ({
        resource: resource.id, field, before: "model_and_runner", after: "runner_only",
      }))));
    expect(result.changes).toHaveLength(36);
    expect(result.policy_changes ?? []).toEqual([]);
    expect(result.changes.some((change) => ["invoice_number", "case_number", "tenant_id", "principal_id"].includes(change.field))).toBe(false);
    expect(reviewed).toEqual(before);
    expect(result.authority_granted).toBe(false);
  });

  it("edits bounded operations, labels and limits without broadening trusted authority", async () => {
    const result = await generateModelReadBoundaryRevision({
      instruction: "Allow filtering status, label it Order status, and cap results at 20 rows.",
      provider: "openai", model: "gpt-test", apiKey: "test-only", boundary: boundary(), egressAcknowledged: true,
      dependencies: { requestJson: async () => ({ status: 200, body: { output: [{
        type: "function_call", call_id: "revision", name: "runner__submit_read_boundary_revision",
        arguments: JSON.stringify({ resource_changes: [{ resource: "public.orders", settings: {
          filterable_fields: ["status"], max_rows: 20, field_metadata: [{ field: "status", label: "Order status" }],
        } }] }),
      }] } }) },
    });
    expect(result.changes).toEqual([]);
    expect(result.policy_changes).toEqual([{ resource: "public.orders", settings: {
      filterable_fields: ["status"], max_rows: 20, field_metadata: [{ field: "status", label: "Order status" }],
    } }]);
    expect(result.authority_granted).toBe(false);
    const resource = readBoundaryRevisionCatalog(boundary()).resources[0]!;
    for (const setting of [
      { tenant_key: "status" }, { max_rows: 1e12 }, { max_rows: 0 },
      { filterable_fields: ["tenant_id"] }, { selectable_fields: ["invented"] },
      { relationship_ids: ["invented_path"] }, { field_metadata: [{ field: "invented", label: "Meaning" }] },
    ]) expect(() => parseReadPolicySettings(setting, resource)).toThrow();
  });

  it.each(["openai", "anthropic"] as const)(
    "accepts one exact %s revision while granting no authority",
    async (provider) => {
      const requests: Array<Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]> = [];
      const payload = {
        summary: "Keep internal controls private while retaining business fields.",
        resource_changes: [{
          resource: "public.orders",
          field_exposure: [
            { field: "id", exposure: "runner_only", rationale: "Use an opaque object reference." },
            { field: "version", exposure: "runner_only", rationale: "Keep conflict state private." },
            { field: "auto_approval_eligible", exposure: "runner_only", rationale: "Private policy fact." },
          ],
        }],
      };
      const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
        requests.push(request);
        return provider === "openai"
          ? {
              status: 200,
              body: {
                output: [{
                  type: "function_call",
                  call_id: "call_read_revision",
                  name: "runner__submit_read_boundary_revision",
                  arguments: JSON.stringify(payload),
                }],
              },
            }
          : {
              status: 200,
              body: {
                content: [{
                  type: "tool_use",
                  id: "toolu_read_revision",
                  name: "runner__submit_read_boundary_revision",
                  input: payload,
                }],
              },
            };
      });

      const result = await generateModelReadBoundaryRevision({
        instruction: "Keep raw internal identifiers, conflict versions, and private approval facts with Runner.",
        provider,
        model: provider === "openai" ? "gpt-5.6-terra" : "claude-test",
        boundary: boundary(),
        env: { TEST_PROVIDER_KEY: "provider-test-key" },
        apiKeyEnv: "TEST_PROVIDER_KEY",
        egressAcknowledged: true,
        dependencies: { requestJson },
      });

      expect(result).toMatchObject({
        provider,
        model_exposure_expansions: 0,
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      });
      expect(result.changes.map(({ resource, field, before, after }) => ({ resource, field, before, after })))
        .toEqual([
          { resource: "public.orders", field: "id", before: "model_and_runner", after: "runner_only" },
          { resource: "public.orders", field: "version", before: "model_and_runner", after: "runner_only" },
          { resource: "public.orders", field: "auto_approval_eligible", before: "model_and_runner", after: "runner_only" },
        ]);
      expect(requestJson).toHaveBeenCalledOnce();
      const body = JSON.stringify(requests[0]!.body);
      expect(body).toContain("runner__submit_read_boundary_revision");
      expect(body).toContain("internal_identifier_candidate");
      expect(body).toContain("conflict_or_version_guard");
      expect(body).toContain("private_policy_candidate");
      expect(body).not.toContain("provider-test-key");
      expect(body).not.toContain("tenant-acme");
      expect(body).not.toContain("principal-maya");
    },
  );

  it("rejects a trusted-scope exposure and permits one bounded correction", async () => {
    let attempt = 0;
    const requestJson = vi.fn(async () => {
      attempt += 1;
      const payload = attempt === 1
        ? {
            resource_changes: [{
              resource: "public.orders",
              field_exposure: [{ field: "tenant_id", exposure: "model_and_runner" }],
            }],
          }
        : {
            resource_changes: [{
              resource: "public.orders",
              field_exposure: [{ field: "id", exposure: "runner_only" }],
            }],
          };
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_read_revision_${attempt}`,
            name: "runner__submit_read_boundary_revision",
            arguments: JSON.stringify(payload),
          }],
        },
      };
    });

    const result = await generateModelReadBoundaryRevision({
      instruction: "Keep internal scope and identity fields private.",
      provider: "openai",
      model: "gpt-5.6-terra",
      boundary: boundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      dependencies: { requestJson },
    });

    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(result.correction_used).toBe(true);
    expect(result.changes).toEqual([
      expect.objectContaining({ field: "id", after: "runner_only" }),
    ]);
  });

  it("rejects a no-op submission and accepts only one corrected exact change", async () => {
    let attempt = 0;
    const requestJson = vi.fn(async () => {
      attempt += 1;
      const payload = attempt === 1
        ? {
            resource_changes: [{
              resource: "public.orders",
              field_exposure: [{ field: "status", exposure: "model_and_runner" }],
            }],
          }
        : {
            resource_changes: [{
              resource: "public.orders",
              field_exposure: [{ field: "secret_note", exposure: "runner_only" }],
            }],
          };
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_read_noop_${attempt}`,
            name: "runner__submit_read_boundary_revision",
            arguments: JSON.stringify(payload),
          }],
        },
      };
    });

    const result = await generateModelReadBoundaryRevision({
      instruction: "Retain the private note for Runner verification without returning it to the model.",
      provider: "openai",
      model: "gpt-5.6-terra",
      boundary: boundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      dependencies: { requestJson },
    });

    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      correction_used: true,
      model_exposure_expansions: 0,
      changes: [{
        resource: "public.orders",
        field: "secret_note",
        before: "kept_out",
        after: "runner_only",
      }],
    });
  });

  it("publishes structural role hints without rows or trusted identity values", () => {
    const catalog = readBoundaryRevisionCatalog(boundary());
    const resource = catalog.resources[0]!;
    expect(resource.fields.find((field) => field.id === "id")?.roles).toEqual(
      expect.arrayContaining(["record_identity", "internal_identifier_candidate"]),
    );
    expect(resource.fields.find((field) => field.id === "tenant_id")?.roles).toContain("trusted_scope");
    expect(resource.fields.find((field) => field.id === "version")?.roles).toContain("conflict_or_version_guard");
    expect(resource.fields.find((field) => field.id === "auto_approval_eligible")?.roles)
      .toContain("private_policy_candidate");
    expect(catalog.trust).toEqual({
      raw_rows_included: false,
      observed_values_included: false,
      trusted_identity_values_included: false,
      activation_available: false,
      source_query_available: false,
      source_write_available: false,
    });
    expect(JSON.stringify(catalog)).not.toContain("tenant-acme");
    expect(JSON.stringify(catalog)).not.toContain("principal-maya");
  });
});

function boundary(): ExplorationBoundaryDraft {
  const hash = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}` as `sha256:${string}`;
  return {
    schema_version: "synapsor.exploration-boundary.v1",
    activation: "disabled_unreviewed",
    deployment_profile: "staging",
    source: "local_postgres",
    compiler_version: "1.8.0",
    spec_version: "1.11.0",
    reporting_timezone: "UTC",
    trusted_context: {
      provider: "environment",
      tenant_env: "SYNAPSOR_TENANT_ID",
      principal_env: "SYNAPSOR_PRINCIPAL",
    },
    generation_lock_fingerprint: hash("1"),
    role_posture_fingerprint: hash("2"),
    pack: {
      name: "reviewed_staging",
      resources: [{
        id: "public.orders",
        schema: "public",
        table: "orders",
        primary_key: "id",
        tenant_key: "tenant_id",
        principal_key: "principal_id",
        field_types: {
          id: "uuid",
          tenant_id: "text",
          principal_id: "text",
          status: "text",
          version: "integer",
          auto_approval_eligible: "boolean",
          secret_note: "text",
        },
        field_enums: { status: ["open", "closed"] },
        selectable_fields: ["id", "status", "version", "auto_approval_eligible"],
        filterable_fields: { status: ["eq", "neq", "in"] },
        sortable_fields: ["status"],
        groupable_fields: ["status"],
        aggregate_measures: [],
        aggregate_measure_functions: {},
        count_distinct_fields: ["status"],
        time_bucket_fields: {},
        kept_out_fields: ["tenant_id", "principal_id", "secret_note"],
        relationships: [],
        minimum_cohort_size: 5,
        suppression_aware_totals: true,
      }],
    },
    budgets: structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS),
    unresolved_decisions: [],
  };
}

it('retains the actual prerequisite request before nesting and resumes without repeating its parent turn', async () => {
  let checkpoint: any, calls = 0;
  const common = { instruction: 'Require current admission before every read.', provider: 'openai' as const, model: 'gpt-test',
    apiKey: 'test-key', boundary: boundary(), egressAcknowledged: true,
    onCheckpoint: async (next: unknown) => { if (next) checkpoint = structuredClone(next); },
    dependencies: { requestJson: async () => ({ status: 200, body: { output: [{ type: 'function_call', call_id: `nested_${++calls}`,
      name: 'runner__submit_read_boundary_revision', arguments: JSON.stringify(calls === 1
        ? { private_prerequisite_request: { reason: 'Current admission is required.' } } : { resource_changes: [] }) }] } }) } };
  await expect(generateModelReadBoundaryRevision({ ...common, reviewPrivatePrerequisite: async () => undefined })).rejects.toThrow('READ_PREREQUISITE_REVIEW_PENDING');
  expect(checkpoint?.pending_question.kind).toBe('private_prerequisite'); expect(calls).toBe(1);
  await expect(generateModelReadBoundaryRevision({ ...common, resumeCheckpoint: checkpoint,
    reviewPrivatePrerequisite: async () => privatePrerequisite(), revalidateStagedSelections: async () => undefined })).resolves.toMatchObject({ read_prerequisite: privatePrerequisite() });
  expect(calls).toBe(2);
});

it('saves the real parent completion before the private prerequisite callback', async () => {
  let cp: any, state: AuthoringTransportState = { version: 1, operations: [] };
  const body = { output: [{ type: 'function_call', call_id: 'parent-prerequisite', name: 'runner__submit_read_boundary_revision',
    arguments: JSON.stringify({ private_prerequisite_request: { reason: 'Current admission is required.' } }) }] };
  const server = createServer(async (req, res) => { for await (const _chunk of req) {} res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`);
  const host = { available: () => true, read: () => state, current: async () => canonicalJsonDigest('parent-prerequisite-native-origin'),
    write: async (next: AuthoringTransportState) => { validateAuthoringTransportState(next); state = structuredClone(next); } };
  try {
    await expect(withAuthoringGenerationRecovery(() => { configureAuthoringGenerationRecovery(host);
      return generateModelReadBoundaryRevision({ instruction: 'Require current admission before every read.', provider: 'openai', model: 'gpt-test', apiKey: 'test-key',
        boundary: boundary(), egressAcknowledged: true, onCheckpoint: async next => { cp = structuredClone(next); },
        dependencies: { requestJson: request => secureAskJsonRequest({ ...request, endpoint, scope: 'custom_loopback' }) },
        reviewPrivatePrerequisite: async (_request, controls) => {
          const op = state.operations.at(-1)!; expect(op.state).toBe('handled');
          expect(cp.pending_question.kind).toBe('private_prerequisite'); expect(cp.pending_question).not.toHaveProperty('question');
          expect(controls.parentCompletion).toEqual(cp.pending_question.completion);
          expect(controls.parentCompletion).toEqual({ operation_id: op.id, request_digest: op.request_digest,
            context_digest: op.context_digest, response_digest: canonicalJsonDigest(body) });
          return undefined;
        } });
    })).rejects.toThrow('READ_PREREQUISITE_REVIEW_PENDING');
    expect(state.operations).toHaveLength(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('fences a failed parent checkpoint before any nested callback', async () => {
  const nested = vi.fn();
  await expect(generateModelReadBoundaryRevision({ instruction: 'Require current admission.', provider: 'openai', model: 'gpt-test', apiKey: 'test-key',
    boundary: boundary(), egressAcknowledged: true, reviewPrivatePrerequisite: nested,
    dependencies: { requestJson: async () => ({ status: 200, body: { output: [{ type: 'function_call', call_id: 'parent', name: 'runner__submit_read_boundary_revision',
      arguments: JSON.stringify({ private_prerequisite_request: { reason: 'Current admission is required.' } }) }] } }) },
    onCheckpoint: async () => { throw new Error('parent CAS refused'); } })).rejects.toThrow('parent CAS refused');
  expect(nested).not.toHaveBeenCalled();
});

it('revalidates a decided parent selection on Resume without repeating the nested review', async () => {
  let cp: any; const nested = vi.fn(async () => privatePrerequisite()), revalidate = vi.fn(async () => undefined);
  const initial = vi.fn(async () => ({ status: 200, body: { output: [{ type: 'function_call', call_id: 'parent', name: 'runner__submit_read_boundary_revision',
    arguments: JSON.stringify({ private_prerequisite_request: { reason: 'Current admission is required.' } }) }] } }));
  const common = { instruction: 'Require current admission.', provider: 'openai' as const, model: 'gpt-test', apiKey: 'test-key', boundary: boundary(), egressAcknowledged: true, reviewPrivatePrerequisite: nested };
  await expect(generateModelReadBoundaryRevision({ ...common, dependencies: { requestJson: initial }, onCheckpoint: async next => {
    cp = structuredClone(next); if (next?.stage === 'decided') throw new Error('saved selection');
  } })).rejects.toThrow('saved selection');
  expect(initial).toHaveBeenCalledTimes(1); expect(nested).toHaveBeenCalledTimes(1);
  const follow = vi.fn(async () => ({ status: 200, body: { output: [{ type: 'function_call', call_id: 'followup', name: 'runner__submit_read_boundary_revision',
    arguments: JSON.stringify({ resource_changes: [] }) }] } }));
  await expect(generateModelReadBoundaryRevision({ ...common, resumeCheckpoint: cp, revalidateStagedSelections: async () => { throw new Error('actual Source drift'); },
    dependencies: { requestJson: follow } })).rejects.toThrow('actual Source drift');
  expect(follow).not.toHaveBeenCalled();
  await expect(generateModelReadBoundaryRevision({ ...common, resumeCheckpoint: cp, revalidateStagedSelections: revalidate,
    dependencies: { requestJson: follow } })).resolves.toMatchObject({ read_prerequisite: privatePrerequisite() });
  expect(nested).toHaveBeenCalledTimes(1); expect(revalidate).toHaveBeenCalledTimes(1); expect(follow).toHaveBeenCalledTimes(1);
});
