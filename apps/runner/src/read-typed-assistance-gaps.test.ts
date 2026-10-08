import fs from "node:fs/promises";
import { describe, it, expect, vi } from "vitest";
import { nativeFixture } from "./test-fixtures/native-read-scope.js";
import { loadBoundaryReviewContext } from "./boundary-commands.js";
import { generateModelReadWorkload } from "./read-workload-model.js";
import { READ_SCOPE_PROTOCOL } from "./read-structured-scope.js";

// Characterization only: these retained assistance capabilities are not yet
// reachable through the strict mapping protocol. They are open gaps, not passes
// for successful assistance or justification to drop their old safety controls.
describe("current typed mapping assistance reachability gaps", () => {
  it.each(["values", "relationship"] as const)("characterizes the unreachable existing %s handler with a real typed inventory", async kind => {
    const f = await nativeFixture();
    try {
      const draft = (await loadBoundaryReviewContext(f.dir)).candidate;
      const valueRequestHandler = vi.fn(async () => ({ state: "without_values" as const }));
      const relationshipReviewHandler = vi.fn(async () => undefined);
      const input = kind === "values" ? { value_request: { resource: "work.items", field: "label",
        question: "May the separately reviewed label values be used?", reason: "The requested exact filter needs a separately consented value." } }
        : { clarification_request: { resource: "work.items", category: "relationship_support",
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
      expect(calls).toHaveLength(2); expect(valueRequestHandler).not.toHaveBeenCalled(); expect(relationshipReviewHandler).not.toHaveBeenCalled();
      expect(JSON.stringify(calls[1])).toContain("READ_SCOPE_PROTOCOL_INVALID");
      expect(f.state().read).toBeUndefined(); expect(f.state().operator_questions).toBeUndefined();
    } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
  });
});
