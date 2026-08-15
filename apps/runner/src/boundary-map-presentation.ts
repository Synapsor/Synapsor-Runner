export type BoundaryMapOperationFlags = {
  return_value: boolean;
  filter: boolean;
  sort: boolean;
  group: boolean;
  measure: boolean;
  presence: boolean;
  distinct: boolean;
  time: boolean;
};

export type BoundaryMapFieldRow = {
  field: string;
  data_type: string;
  access: "MODEL" | "RUNNER" | "KEPT";
  operations: BoundaryMapOperationFlags;
  note?: string;
};

const operationColumns: Array<{
  label: string;
  compact: string;
  key: keyof BoundaryMapOperationFlags;
}> = [
  { label: "RET", compact: "R", key: "return_value" },
  { label: "FLT", compact: "F", key: "filter" },
  { label: "SRT", compact: "S", key: "sort" },
  { label: "GRP", compact: "G", key: "group" },
  { label: "MEA", compact: "M", key: "measure" },
  { label: "PRE", compact: "P", key: "presence" },
  { label: "DST", compact: "D", key: "distinct" },
  { label: "TIM", compact: "T", key: "time" },
];

export function renderBoundaryMapFieldMatrix(
  rows: BoundaryMapFieldRow[],
  options: { width: number; indent?: string } = { width: 96 },
): string[] {
  if (!rows.length) return [];
  const indent = options.indent ?? "";
  const contentWidth = Math.max(32, options.width - indent.length);
  return contentWidth >= 72
    ? renderWideMatrix(rows, contentWidth, indent)
    : renderCompactMatrix(rows, contentWidth, indent);
}

export function boundaryMapOperationLegend(): string[] {
  return [
    "Y = reviewed; - = unavailable. MODEL may return values to the model; RUNNER keeps raw output local or tokenized; KEPT is unavailable.",
    "RET return | FLT filter | SRT sort | GRP group or band | MEA numeric measure | PRE missing-data measure | DST distinct count | TIM time bucket",
  ];
}

function renderWideMatrix(
  rows: BoundaryMapFieldRow[],
  contentWidth: number,
  indent: string,
): string[] {
  const includeNote = contentWidth >= 90;
  const typeWidth = contentWidth >= 108 ? 13 : 10;
  const accessWidth = 6;
  const flagsWidth = operationColumns.reduce((total, column) => total + column.label.length, 0)
    + operationColumns.length - 1;
  const noteWidth = includeNote ? Math.min(24, Math.max(18, Math.floor(contentWidth * 0.2))) : 0;
  const separators = includeNote ? 8 : 6;
  const fieldWidth = Math.max(
    10,
    contentWidth - typeWidth - accessWidth - flagsWidth - noteWidth - separators,
  );
  const header = [
    fitCell("FIELD", fieldWidth),
    fitCell("TYPE", typeWidth),
    operationColumns.map((column) => column.label).join(" "),
    fitCell("ACCESS", accessWidth),
    ...(includeNote ? [fitCell("NOTE", noteWidth)] : []),
  ].join("  ").trimEnd();
  const lines = [indent + header];
  for (const row of rows) {
    lines.push(indent + [
      fitCell(row.field, fieldWidth),
      fitCell(row.data_type, typeWidth),
      operationColumns.map((column) => row.operations[column.key] ? "Y".padEnd(3) : "-".padEnd(3))
        .join(" ")
        .trimEnd(),
      fitCell(row.access, accessWidth),
      ...(includeNote ? [fitCell(row.note ?? "", noteWidth)] : []),
    ].join("  ").trimEnd());
  }
  const notes = rows.filter((row) => row.note && (!includeNote || row.note.length > noteWidth));
  if (notes.length) {
    if (!includeNote || notes.some((row) => row.note!.length > noteWidth)) {
      lines.push(
        indent + "NOTES",
        ...notes.map((row) => `${indent}  ${row.field}: ${row.note}`),
      );
    }
  }
  return lines;
}

function renderCompactMatrix(
  rows: BoundaryMapFieldRow[],
  contentWidth: number,
  indent: string,
): string[] {
  const typeWidth = Math.min(10, Math.max(7, Math.floor(contentWidth * 0.22)));
  const accessWidth = 6;
  const fieldWidth = Math.max(10, contentWidth - typeWidth - accessWidth - 4);
  const lines = [
    indent + [
      fitCell("FIELD", fieldWidth),
      fitCell("TYPE", typeWidth),
      fitCell("ACCESS", accessWidth),
    ].join("  ").trimEnd(),
  ];
  for (const row of rows) {
    lines.push(indent + [
      fitCell(row.field, fieldWidth),
      fitCell(row.data_type, typeWidth),
      fitCell(row.access, accessWidth),
    ].join("  ").trimEnd());
    const flags = operationColumns.map((column) =>
      `${column.compact}:${row.operations[column.key] ? "Y" : "-"}`);
    if (contentWidth >= 48) {
      lines.push(`${indent}  ops  ${flags.join(" ")}`);
    } else {
      lines.push(`${indent}  ops  ${flags.slice(0, 4).join(" ")}`);
      lines.push(`${indent}       ${flags.slice(4).join(" ")}`);
    }
    if (row.note) lines.push(`${indent}  note ${row.note}`);
  }
  return lines;
}

function fitCell(value: string, width: number): string {
  if (value.length <= width) return value.padEnd(width);
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}
