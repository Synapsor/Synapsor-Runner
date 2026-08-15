import { describe, expect, it } from "vitest";
import {
  boundaryMapOperationLegend,
  renderBoundaryMapFieldMatrix,
  type BoundaryMapFieldRow,
} from "./boundary-map-presentation.js";

describe("boundary map field matrix", () => {
  it("makes one-operation differences visible in aligned ASCII columns at 80 characters", () => {
    const lines = renderBoundaryMapFieldMatrix(rows(), { width: 80, indent: "  " });
    const source = lines.find((line) => line.includes("note_source"))!;
    const sentiment = lines.find((line) => line.includes("sentiment"))!;

    expect(lines[0]).toContain("RET FLT SRT GRP MEA PRE DST TIM");
    expect(source).toMatch(/Y\s+Y\s+Y\s+Y\s+-\s+Y\s+Y\s+-\s+MODEL/);
    expect(sentiment).toMatch(/Y\s+Y\s+Y\s+Y\s+-\s+Y\s+-\s+-\s+MODEL/);
    expect(source.indexOf("Y", source.indexOf("note_source"))).toBe(
      sentiment.indexOf("Y", sentiment.indexOf("sentiment")),
    );
    expect(lines.every((line) => line.length <= 80)).toBe(true);
    expect(lines.join("\n")).not.toMatch(/[●·✓→]/u);
  });

  it("falls back to a readable two-line field layout on narrow terminals", () => {
    const lines = renderBoundaryMapFieldMatrix(rows(), { width: 44 });
    expect(lines).toContain("  ops  R:Y F:Y S:Y G:Y");
    expect(lines).toContain("       M:- P:Y D:Y T:-");
    expect(lines.every((line) => line.length <= 44)).toBe(true);
    expect(boundaryMapOperationLegend().join(" ")).toContain("RET return");
  });
});

function rows(): BoundaryMapFieldRow[] {
  const operations = {
    return_value: true,
    filter: true,
    sort: true,
    group: true,
    measure: false,
    presence: true,
    distinct: true,
    time: false,
  };
  return [
    {
      field: "note_source",
      data_type: "enum",
      access: "MODEL",
      operations,
    },
    {
      field: "sentiment",
      data_type: "enum",
      access: "MODEL",
      operations: { ...operations, distinct: false },
    },
  ];
}
