import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { describe, expect, it } from "vitest";
import {
  derivedScopeStartSequence,
  formatDerivedScopeJoinColumns,
  formatDerivedScopePath,
  formatRelationshipJoinColumns,
  formatRelationshipPath,
} from "./derived-scope-display.js";

describe("derived scope display", () => {
  it("renders one-hop and two-hop paths as readable table chains", () => {
    expect(formatDerivedScopePath(scope([
      ["public.order_items", "public.orders"],
    ]))).toBe("order_items -> orders.tenant_id");
    expect(formatDerivedScopePath(scope([
      ["public.order_item_events", "public.order_items"],
      ["public.order_items", "public.orders"],
    ]))).toBe("order_item_events -> order_items -> orders.tenant_id");
  });

  it("preserves non-default schemas and returns the safe ancestor-first add order", () => {
    const value = scope([
      ["audit.order_item_events", "sales.order_items"],
      ["sales.order_items", "sales.orders"],
    ]);
    expect(formatDerivedScopePath(value)).toBe(
      "audit.order_item_events -> sales.order_items -> sales.orders.tenant_id",
    );
    expect(derivedScopeStartSequence(value)).toEqual([
      "sales.orders",
      "sales.order_items",
      "audit.order_item_events",
    ]);
  });

  it("drops a repeated schema and renders the joining columns separately", () => {
    const value = scope([
      ["librarydb.note_flags", "librarydb.event_notes", "event_note_id"],
      ["librarydb.event_notes", "librarydb.loan_events", "loan_event_id"],
      ["librarydb.loan_events", "librarydb.loans", "loan_id"],
    ]);
    expect(formatDerivedScopePath(value)).toBe(
      "note_flags -> event_notes -> loan_events -> loans.tenant_id",
    );
    expect(formatDerivedScopeJoinColumns(value)).toBe(
      "event_note_id -> loan_event_id -> loan_id",
    );
  });

  it("renders reviewed analysis relationships without leading with their path ID", () => {
    const value = {
      source_resource: "librarydb.event_notes",
      target_resource: "librarydb.loans",
      links: [
        {
          source_resource: "librarydb.event_notes",
          target_resource: "librarydb.loan_events",
          source_columns: ["loan_event_id"],
        },
        {
          source_resource: "librarydb.loan_events",
          target_resource: "librarydb.loans",
          source_columns: ["loan_id"],
        },
      ],
    };
    expect(formatRelationshipPath(value)).toBe("event_notes -> loan_events -> loans");
    expect(formatRelationshipJoinColumns(value)).toBe("loan_event_id -> loan_id");
  });

  it("does not mutate the canonical path id or any digest-bound path evidence", () => {
    const value = scope([
      ["public.order_item_events", "public.order_items"],
      ["public.order_items", "public.orders"],
    ]);
    const serialized = JSON.stringify(value);
    const digest = canonicalJsonDigest(value);
    expect(formatDerivedScopePath(value)).toContain("orders.tenant_id");
    expect(value.path_id).toBe("fk_0__fk_1");
    expect(JSON.stringify(value)).toBe(serialized);
    expect(canonicalJsonDigest(value)).toBe(digest);
  });
});

function scope(links: Array<[string, string, string?]>) {
  return {
    path_id: links.map((_, index) => `fk_${index}`).join("__"),
    ancestor_resource: links.at(-1)?.[1] ?? "public.orders",
    ancestor_column: "tenant_id",
    proof: {
      links: links.map(([source_resource, target_resource, sourceColumn]) => ({
        source_resource,
        target_resource,
        ...(sourceColumn ? { source_columns: [sourceColumn] } : {}),
      })),
    },
  };
}
