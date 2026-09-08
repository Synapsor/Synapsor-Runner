import { wrapStyledTerminalLine } from "./terminal-layout.js";

/** A compact key/value table; small terminals keep the label above its value. */
export function renderReviewFacts(rows: ReadonlyArray<readonly [string, string]>, width: number): string[] {
  const columns = Number.isFinite(width) ? Math.max(24, Math.floor(width)) : 96;
  const labelWidth = Math.max(...rows.map(([label]) => Array.from(label).length), 0);
  return rows.flatMap(([label, value]) => {
    const stacked = columns < 72 || labelWidth > columns / 3;
    const indent = stacked ? 2 : labelWidth + 2;
    const values = value.split(/\r?\n/u).flatMap((line) =>
      wrapStyledTerminalLine(" ".repeat(indent) + line, columns));
    if (stacked) return [...wrapStyledTerminalLine(label + ":", columns), ...values];
    return [label.padEnd(labelWidth) + "  " + values[0]!.slice(indent), ...values.slice(1)];
  });
}
