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
  key: keyof BoundaryMapOperationFlags;
}> = [
  { label: "Return value", key: "return_value" },
  { label: "Filter", key: "filter" },
  { label: "Sort", key: "sort" },
  { label: "Group / band", key: "group" },
  { label: "Numeric measure", key: "measure" },
  { label: "Missing-data measure", key: "presence" },
  { label: "Distinct count", key: "distinct" },
  { label: "Time bucket", key: "time" },
];

export function renderBoundaryMapFieldMatrix(
  rows: BoundaryMapFieldRow[],
  options: { width: number; indent?: string } = { width: 96 },
): string[] {
  if (!rows.length) return [];
  const indent = options.indent ?? "";
  const contentWidth = Math.max(32, options.width - indent.length);
  return contentWidth >= 72
    ? renderWideTable(rows, contentWidth, indent)
    : renderNarrowTable(rows, contentWidth, indent);
}

export function boundaryMapOperationLegend(): string[] {
  return [
    "Access: Model + Runner may return reviewed values to the model; Runner only keeps raw output local or tokenized but does not hide inferences from reviewed operations; Kept out is unavailable.",
    "Reviewed operations are listed by name. Any operation omitted from a field is unavailable. Analysis only permits the listed operations without raw return. No Read ops establishes no private Action use; that requires separate evidence.",
  ];
}

export function renderBoundaryMapTable(
  headers: string[],
  rows: string[][],
  options: { widths: number[]; indent?: string; rowSeparators?: boolean },
): string[] {
  return renderAsciiTable(
    headers,
    rows,
    options.widths,
    options.indent ?? "",
    options.rowSeparators ?? true,
  );
}

function renderWideTable(
  rows: BoundaryMapFieldRow[],
  contentWidth: number,
  indent: string,
): string[] {
  const tableContentWidth = contentWidth - 13;
  const typeWidth = 13;
  const accessWidth = 14;
  const fieldWidth = Math.min(22, Math.max(
    12,
    tableContentWidth - typeWidth - accessWidth - 20,
  ));
  const operationWidth = tableContentWidth - fieldWidth - typeWidth - accessWidth;
  const lines = renderAsciiTable(
    ["Field", "Database type", "Access", "Reviewed operations"],
    rows.map((row) => [
      row.field,
      row.data_type,
      boundaryMapFieldAccessLabel(row),
      packOperationLabels(row, operationWidth).join("\n") || "None",
    ]),
    [fieldWidth, typeWidth, accessWidth, operationWidth],
    indent,
  );
  const notes = rows.filter((row) => row.note);
  if (!notes.length) return lines;
  const notesContentWidth = contentWidth - 7;
  const notesFieldWidth = Math.min(22, Math.max(12, Math.floor(notesContentWidth * 0.28)));
  return [
    ...lines,
    indent + "Reviewer notes",
    ...renderAsciiTable(
      ["Field", "Review note"],
      notes.map((row) => [row.field, row.note!]),
      [notesFieldWidth, notesContentWidth - notesFieldWidth],
      indent,
    ),
  ];
}

function renderNarrowTable(
  rows: BoundaryMapFieldRow[],
  contentWidth: number,
  indent: string,
): string[] {
  const tableContentWidth = contentWidth - 7;
  const propertyWidth = contentWidth >= 42
    ? 19
    : Math.max(12, Math.floor(tableContentWidth * 0.46));
  const valueWidth = tableContentWidth - propertyWidth;
  const tableRows = rows.flatMap((row) => [
    ["Field", row.field],
    ["Database type", row.data_type],
    ["Access", boundaryMapFieldAccessLabel(row)],
    ["Reviewed operations", packOperationLabels(row, valueWidth).join("\n") || "None"],
    ...(row.note ? [["Review note", row.note]] : []),
  ]);
  return renderAsciiTable(
    ["Property", "Reviewed value"],
    tableRows,
    [propertyWidth, valueWidth],
    indent,
  );
}

function reviewedOperationLabels(row: BoundaryMapFieldRow): string[] {
  return operationColumns
    .filter((operation) => row.operations[operation.key])
    .map((operation) => operation.label);
}

function packOperationLabels(row: BoundaryMapFieldRow, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const label of reviewedOperationLabels(row)) {
    const candidate = current ? `${current}, ${label}` : label;
    if (current && candidate.length > width) {
      lines.push(current);
      current = label;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function boundaryMapFieldAccessLabel(row: BoundaryMapFieldRow): string {
  if (row.access === "KEPT") return "Kept out";
  if (!Object.values(row.operations).some(Boolean)) return "No Read ops";
  if (!row.operations.return_value) return "Analysis only";
  return row.access === "RUNNER" ? "Runner only" : "Model + Runner";
}

function renderAsciiTable(
  headers: string[],
  rows: string[][],
  widths: number[],
  indent: string,
  rowSeparators = true,
): string[] {
  const border = indent + "+" + widths.map((width) => "-".repeat(width + 2)).join("+") + "+";
  const lines = [border, ...renderAsciiRow(headers, widths, indent), border];
  for (const row of rows) {
    lines.push(...renderAsciiRow(row, widths, indent));
    if (rowSeparators) lines.push(border);
  }
  if (!rowSeparators) lines.push(border);
  return lines;
}

function renderAsciiRow(values: string[], widths: number[], indent: string): string[] {
  const wrapped = widths.map((width, index) => wrapCell(values[index] ?? "", width));
  const height = Math.max(...wrapped.map((cell) => cell.length));
  return Array.from({ length: height }, (_, lineIndex) =>
    indent + "| " + wrapped.map((cell, index) =>
      (cell[lineIndex] ?? "").padEnd(widths[index]!)).join(" | ") + " |");
}

function wrapCell(value: string, width: number): string[] {
  return value.split("\n").flatMap((part) => wrapCellLine(part, width));
}

function wrapCellLine(value: string, width: number): string[] {
  let remaining = value.trim();
  if (!remaining) return [""];
  const lines: string[] = [];
  while (remaining.length > width) {
    const candidate = remaining.slice(0, width + 1);
    const wordBreak = candidate.lastIndexOf(" ");
    const identifierBreak = candidate.lastIndexOf("_");
    const schemaBreak = candidate.lastIndexOf(".") + 1;
    const splitAt = !remaining.includes(" ")
      && schemaBreak > 0
      && remaining.length - schemaBreak <= width
      ? schemaBreak
      : wordBreak > 0
      ? wordBreak
      : identifierBreak > 0
        ? identifierBreak + 1
        : width;
    lines.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  lines.push(remaining);
  return lines;
}

/** Decisions use typed catalog roles and reviewed operation flags, never this wording. */
export function boundaryMapFieldReview(
  roles: readonly string[], access: BoundaryMapFieldRow["access"],
  operations: BoundaryMapOperationFlags,
): { note?: string; review_required: boolean } {
  const labels: string[] = [];
  if (roles.includes("trusted_scope")) labels.push("trusted scope");
  if (roles.includes("record_identity")) labels.push("record identity");
  else if (roles.includes("internal_identifier_candidate")) labels.push("possible internal identifier");
  if (roles.includes("relationship_key")) labels.push("relationship key");
  if (roles.includes("conflict_or_version_guard")) labels.push("possible conflict/version guard");
  if (roles.includes("private_policy_candidate")) labels.push("possible private policy fact");
  if (!labels.length) return { review_required: false };
  const summary = labels.join(", ");
  if (access !== "KEPT" && !Object.values(operations).some(Boolean)) return {
    review_required: false, note: `No reviewed Read operations; ${summary}. Private Action use is not established by this Read view.` };
  if (access !== "KEPT" && !operations.return_value) return {
    review_required: true, note: `REVIEW: model analysis of ${summary}; raw values are not returned` };
  if (access === "MODEL") return {
    review_required: true, note: `REVIEW: model-facing ${summary}; prefer Runner only unless raw values are intentionally required by the agent` };
  if (access === "RUNNER") return { review_required: false,
    note: `Runner-only ${summary}${roles.includes("record_identity") || roles.includes("internal_identifier_candidate") ? "; model uses opaque obj_* references" : ""}` };
  return { review_required: false, note: `Kept out ${summary}; unavailable to model and Runner reads` };
}

export function describeInspectedBoundaryField(resource: string, field: {
  name: string; data_type: string; enum_values?: readonly string[];
}): string {
  return `${field.name} - ${field.data_type} column of ${resource}`
    + (field.enum_values?.length ? ` (database-declared values: ${field.enum_values.join(", ")})` : "");
}
