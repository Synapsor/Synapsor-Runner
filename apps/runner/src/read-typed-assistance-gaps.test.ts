import fs from "node:fs/promises";
import { describe, it, expect, vi } from "vitest";
import { nativeFixture } from "./test-fixtures/native-read-scope.js";
import { loadBoundaryReviewContext } from "./boundary-commands.js";
import { generateModelReadWorkload } from "./read-workload-model.js";
import { READ_SCOPE_PROTOCOL } from "./read-structured-scope.js";

// Before-results at b4a5aa70 are preserved. These controls now require the exact
// typed handler reachability; they do not claim a completed native/public flow.
describe("typed mapping assistance dispatch", () => {
  it.each(["values", "relationship"] as const)("reaches the existing %s handler without granting authority with a real typed inventory", async kind => {
    const f = await nativeFixture();
    try {
      const draft = (await loadBoundaryReviewContext(f.dir)).candidate;
      const valueRequestHandler = vi.fn(async () => undefined);
      const relationshipReviewHandler = vi.fn(async () => undefined);
      const input = kind === "values" ? { value_request: { resource: "work.items", field: "label",
        question: "May the separately reviewed label values be used?", reason: "The requested exact filter needs a separately consented value." } }
        : { relationship_review_request: { resource: "work.items",
          question: "Prepare the missing related business detail path.", reason: "The related business detail needs an inspected link." } };
      const calls: unknown[] = [];
      const error = await generateModelReadWorkload({ name: "typed_assistance", allowedQuestions: [f.input.jobIntent],
        operatorNamingContext: f.input.jobIntent, provider: "openai", model: "controlled", apiKey: "inert-test-key",
        generatedBoundary: draft, egressAcknowledged: true, deferNarration: true, valueRequestHandler, relationshipReviewHandler,
        structuredScope: { protocol: READ_SCOPE_PROTOCOL, current: () => ({ binding: f.binding, ...f.inventory }) },
        dependencies: { requestJson: async request => { calls.push(request.body); return { status: 200, body: { output: [{ type: "function_call",
          name: "runner__submit_read_workloads", call_id: `gap_${calls.length}`, arguments: JSON.stringify(input) }] } }; } },
      }).then(() => undefined, reason => reason);
      expect(error).toBeInstanceOf(Error);
      expect(calls).toHaveLength(1);
      expect(kind === "values" ? valueRequestHandler : relationshipReviewHandler).toHaveBeenCalledOnce();
      expect(kind === "values" ? relationshipReviewHandler : valueRequestHandler).not.toHaveBeenCalled();
      expect(error.message).toContain(kind === "values" ? "AUTHORING_PAUSED" : "READ_RELATIONSHIP_REVIEW_PENDING");
      expect(f.state().read).toBeUndefined(); expect(f.state().operator_questions).toBeUndefined();
    } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
  });
});
