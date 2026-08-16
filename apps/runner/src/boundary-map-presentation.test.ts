import { describe, expect, it } from "vitest";
import {
  boundaryMapOperationLegend,
  renderBoundaryMapFieldMatrix,
  type BoundaryMapFieldRow,
} from "./boundary-map-presentation.js";

describe("boundary map field matrix", () => {
  it("renders plain-language reviewed operations in a bordered table at 80 characters", () => {
    const lines = renderBoundaryMapFieldMatrix(rows(), { width: 80, indent: "  " });
    const sourceIndex = lines.findIndex((line) => line.includes("note_source"));
    const sentimentIndex = lines.findIndex((line) => line.includes("sentiment"));
    const source = lines.slice(sourceIndex, sentimentIndex).join(" ");
    const sentiment = lines.slice(sentimentIndex).join(" ");

    expect(lines[0]).toMatch(/^  \+-+\+-+\+-+\+-+\+$/u);
    expect(lines.join("\n")).toContain("Database type");
    expect(lines.join("\n")).toContain("Reviewed operations");
    expect(source).toContain("Return value");
    expect(source).toContain("Group / band");
    expect(source).toContain("Missing-data measure");
    expect(source).toContain("Distinct count");
    expect(sentiment).not.toContain("Distinct count");
    expect(lines.every((line) => line.length <= 80)).toBe(true);
    expect(lines.join("\n")).not.toMatch(/\b(?:RET|FLT|SRT|GRP|MEA|PRE|DST|TIM)\b/u);
  });

  it("uses a bordered property table with full names on narrow terminals", () => {
    const lines = renderBoundaryMapFieldMatrix(rows(), { width: 44 });
    const rendered = lines.join("\n");
    expect(lines[0]).toMatch(/^\+-+\+-+\+$/u);
    expect(rendered).toContain("Reviewed value");
    expect(rendered).toContain("Reviewed operations");
    expect(rendered).toContain("Missing-data");
    expect(rendered).toContain("measure");
    expect(lines.every((line) => line.length <= 44)).toBe(true);
    expect(boundaryMapOperationLegend().join(" ")).toContain("Any operation omitted");
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
