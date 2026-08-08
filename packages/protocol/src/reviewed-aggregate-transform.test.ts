import { describe, expect, it } from "vitest";
import { applyReviewedAggregateTransforms } from "./reviewed-aggregate-transform.js";

describe("reviewed post-suppression aggregate transforms", () => {
  const groups = [
    { region: "east", time: "2026-01-01", value: 10 },
    { region: "east", time: "2026-02-01", value: 20 },
    { region: "east", time: "2026-03-01", value: 30 },
    { region: "west", time: "2026-01-01", value: 5 },
    { region: "west", time: "2026-02-01", value: 15 },
  ];

  it("computes sequential transforms within released partitions", () => {
    const transformed = applyReviewedAggregateTransforms({
      groups,
      transforms: [
        { operation: "running_total", input_field: "value", output_field: "running", partition_fields: ["region"], time_field: "time" },
        { operation: "lag_absolute_change", input_field: "value", output_field: "change", partition_fields: ["region"], time_field: "time" },
        { operation: "lag_percentage_change", input_field: "value", output_field: "change_percent", partition_fields: ["region"], time_field: "time" },
        { operation: "moving_average", input_field: "value", output_field: "moving", partition_fields: ["region"], time_field: "time", window_size: 2 },
      ],
    });
    expect(transformed.map((row) => [row.running, row.change, row.change_percent, row.moving])).toEqual([
      [10, null, null, 10],
      [30, 10, 100, 15],
      [60, 10, 50, 25],
      [5, null, null, 5],
      [20, 10, 200, 10],
    ]);
  });

  it("ranks and computes shares only across the released input rows", () => {
    const transformed = applyReviewedAggregateTransforms({
      groups: groups.slice(0, 3),
      transforms: [
        { operation: "rank", input_field: "value", output_field: "rank", partition_fields: [], direction: "desc" },
        { operation: "share_of_released_total", input_field: "value", output_field: "share", partition_fields: [] },
      ],
    });
    expect(transformed.map((row) => row.rank)).toEqual([3, 2, 1]);
    expect(transformed[0]!.share).toBeCloseTo(100 / 6);
    expect(transformed[1]!.share).toBeCloseTo(100 / 3);
    expect(transformed[2]!.share).toBe(50);
    expect(groups[0]).not.toHaveProperty("rank");
  });

  it("rejects incomplete fixed transform descriptors", () => {
    expect(() => applyReviewedAggregateTransforms({
      groups,
      transforms: [{ operation: "moving_average", input_field: "value", output_field: "moving", partition_fields: [], time_field: "time", window_size: 1 }],
    })).toThrow(/window from 2 through 12/);
    expect(() => applyReviewedAggregateTransforms({
      groups,
      transforms: [{ operation: "running_total", input_field: "value", output_field: "running", partition_fields: [] }],
    })).toThrow(/require exactly one reviewed time field/);
  });
});
