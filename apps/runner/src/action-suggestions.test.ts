import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACTION_SUGGESTION_VERSION } from "./action-design.js";
import {
  importActionSuggestion,
  listActionSuggestions,
  readActionSuggestion,
  recordActionSuggestionReview,
} from "./action-suggestions.js";
import type { GuidedActionOptions } from "./guided-action.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("bounded Safe Action suggestion records", () => {
  it("stores an immutable non-authoritative suggestion and marks it stale after boundary drift", async () => {
    const root = await temporaryRoot();
    const options = actionOptions("a");
    const value = validSuggestion();
    const imported = await importActionSuggestion({
      projectRoot: root,
      value,
      options,
      now: "2026-08-20T10:00:00.000Z",
    });
    expect(imported).toMatchObject({
      state: "suggested",
      authority_granted: false,
      source_database_changed: false,
      current_assessment: { authority_granted: false },
    });
    expect(await listActionSuggestions({ projectRoot: root, options })).toHaveLength(1);

    const stale = await readActionSuggestion({
      projectRoot: root,
      suggestionId: imported.suggestion_id,
      options: actionOptions("b"),
    });
    expect(stale.state).toBe("stale");
    expect(stale.stale_reason).toMatch(/Boundary digest changed/);
    expect(stale.authority_granted).toBe(false);
  });

  it("imports the same immutable suggestion idempotently without changing its first-seen time", async () => {
    const root = await temporaryRoot();
    const options = actionOptions("b");
    const first = await importActionSuggestion({
      projectRoot: root,
      value: validSuggestion(),
      options,
      now: "2026-08-20T10:00:00.000Z",
    });
    const repeated = await importActionSuggestion({
      projectRoot: root,
      value: validSuggestion(),
      options,
      now: "2026-08-20T11:00:00.000Z",
    });
    expect(repeated.suggestion_id).toBe(first.suggestion_id);
    expect(repeated.imported_at).toBe("2026-08-20T10:00:00.000Z");
    expect(await listActionSuggestions({ projectRoot: root, options })).toHaveLength(1);
  });

  it("records human review as a disabled revision without claiming activation", async () => {
    const root = await temporaryRoot();
    const options = actionOptions("c");
    const imported = await importActionSuggestion({ projectRoot: root, value: validSuggestion(), options });
    const firstReview = await recordActionSuggestionReview({
      projectRoot: root,
      suggestion: imported,
      capability: "orders.propose_close",
      contractDigest: `sha256:${"d".repeat(64)}`,
      now: "2026-08-20T10:05:00.000Z",
    });
    const repeatedReview = await recordActionSuggestionReview({
      projectRoot: root,
      suggestion: imported,
      capability: "orders.propose_close",
      contractDigest: `sha256:${"d".repeat(64)}`,
      now: "2026-08-20T11:05:00.000Z",
    });
    expect(repeatedReview.reviewed_at).toBe(firstReview.reviewed_at);
    const reviewed = await readActionSuggestion({
      projectRoot: root,
      suggestionId: imported.suggestion_id,
      options,
    });
    expect(reviewed).toMatchObject({
      state: "reviewed",
      review: {
        capability: "orders.propose_close",
        authority_activated: false,
        source_database_changed: false,
      },
    });
    await expect(recordActionSuggestionReview({
      projectRoot: root,
      suggestion: imported,
      capability: "orders.propose_archive",
      contractDigest: `sha256:${"e".repeat(64)}`,
    })).rejects.toThrow(/REVIEW_IMMUTABLE/);
  });

  it("rejects a review sidecar that is not bound to the exact suggestion digest", async () => {
    const root = await temporaryRoot();
    const options = actionOptions("d");
    const imported = await importActionSuggestion({ projectRoot: root, value: validSuggestion(), options });
    await recordActionSuggestionReview({
      projectRoot: root,
      suggestion: imported,
      capability: "orders.propose_close",
      contractDigest: `sha256:${"d".repeat(64)}`,
    });
    const reviewFile = path.join(root, ".synapsor", "action-suggestions", `${imported.suggestion_id}.review.json`);
    const review = JSON.parse(await fs.readFile(reviewFile, "utf8"));
    review.suggestion_digest = `sha256:${"f".repeat(64)}`;
    await fs.writeFile(reviewFile, `${JSON.stringify(review, null, 2)}\n`);
    await expect(readActionSuggestion({
      projectRoot: root,
      suggestionId: imported.suggestion_id,
      options,
    })).rejects.toThrow(/REVIEW_INVALID/);
  });

  it("rejects a direct read when the requested filename contains another valid suggestion", async () => {
    const root = await temporaryRoot();
    const options = actionOptions("f");
    const first = await importActionSuggestion({ projectRoot: root, value: validSuggestion(), options });
    const second = await importActionSuggestion({
      projectRoot: root,
      options,
      value: { ...validSuggestion(), intent: "Allow support to propose archiving one exact reviewed order." },
    });
    const suggestionRoot = path.join(root, ".synapsor", "action-suggestions");
    await fs.copyFile(
      path.join(suggestionRoot, `${second.suggestion_id}.json`),
      path.join(suggestionRoot, `${first.suggestion_id}.json`),
    );
    await expect(readActionSuggestion({
      projectRoot: root,
      suggestionId: first.suggestion_id,
      options,
    })).rejects.toThrow(/RECORD_TAMPERED/);
  });

  it("rejects a review sidecar with unsafe capability metadata", async () => {
    const root = await temporaryRoot();
    const options = actionOptions("1");
    const imported = await importActionSuggestion({ projectRoot: root, value: validSuggestion(), options });
    await recordActionSuggestionReview({
      projectRoot: root,
      suggestion: imported,
      capability: "orders.propose_close",
      contractDigest: `sha256:${"d".repeat(64)}`,
    });
    const reviewFile = path.join(root, ".synapsor", "action-suggestions", `${imported.suggestion_id}.review.json`);
    const review = JSON.parse(await fs.readFile(reviewFile, "utf8"));
    review.capability = "orders.propose_close\nforged";
    await fs.writeFile(reviewFile, `${JSON.stringify(review, null, 2)}\n`);
    await expect(readActionSuggestion({
      projectRoot: root,
      suggestionId: imported.suggestion_id,
      options,
    })).rejects.toThrow(/REVIEW_INVALID/);
  });

  it("imports structurally blocked suggestions for audit but never presents them as reviewable", async () => {
    const root = await temporaryRoot();
    const blocked = await importActionSuggestion({
      projectRoot: root,
      options: actionOptions("e"),
      value: {
        ...validSuggestion(),
        operation: "delete",
        fields: ["tenant_id"],
      },
    });
    expect(blocked.state).toBe("blocked");
    expect(blocked.current_assessment.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining("cascading reference"),
      expect.stringContaining("tenant_id"),
      expect.stringContaining("Delete suggestions cannot name patch fields"),
    ]));
    await expect(recordActionSuggestionReview({
      projectRoot: root,
      suggestion: blocked,
      capability: "unsafe.delete",
      contractDigest: `sha256:${"f".repeat(64)}`,
    })).rejects.toThrow(/NOT_REVIEWABLE/);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-action-suggestion-"));
  roots.push(root);
  return root;
}

function validSuggestion() {
  return {
    schema_version: ACTION_SUGGESTION_VERSION,
    intent: "Allow support to propose closing one exact reviewed order.",
    operation: "update",
    resource: "public.orders",
    fields: ["status"],
    suggested_by: { kind: "model", provider: "openai", model: "gpt-5.6-luna" },
  };
}

function actionOptions(digestCharacter: string): GuidedActionOptions {
  return {
    boundary_digest: `sha256:${digestCharacter.repeat(64)}`,
    source: "local_postgres",
    deployment_profile: "staging",
    resources: [{
      id: "public.orders",
      schema: "public",
      table: "orders",
      primary_key: "id",
      tenant_key: "tenant_id",
      writable_fields: [{ name: "status", data_type: "text", enum_values: ["open", "closed"], nullable: false, required_for_insert: true }],
      structurally_eligible_fields: [{ name: "status", data_type: "text", enum_values: ["open", "closed"], nullable: false, required_for_insert: true }],
      conflict_candidates: ["version"],
      insert_dedup_candidates: ["request_id"],
      kept_out_fields: ["tenant_id"],
      operation_availability: {
        update: { available: true, reason: "Available with an exact conflict guard." },
        insert: { available: true, reason: "Available with deduplication." },
        delete: { available: false, reason: "Delete is blocked by a cascading reference." },
      },
    }],
    blocked_resources: [],
    safe_defaults: {},
  };
}
