export const TERMINAL_HORIZONTAL_PADDING = 2;
export const TERMINAL_BOTTOM_PADDING = 2;

export function terminalContentWidth(
  columns: number | undefined,
  padding = TERMINAL_HORIZONTAL_PADDING,
): number {
  const terminalWidth = typeof columns === "number" && Number.isFinite(columns)
    ? Math.max(1, Math.floor(columns))
    : 100;
  return Math.max(24, terminalWidth - (padding * 2));
}

export function padTerminalLine(
  value: string,
  padding = TERMINAL_HORIZONTAL_PADDING,
): string {
  if (!value || padding <= 0) return value;
  return `${" ".repeat(padding)}${value}`;
}

export function padTerminalLines(
  values: string[],
  padding = TERMINAL_HORIZONTAL_PADDING,
): string[] {
  return values.map((value) => padTerminalLine(value, padding));
}

export function padTerminalBlock(
  value: string,
  padding = TERMINAL_HORIZONTAL_PADDING,
): string {
  if (!value || padding <= 0) return value;
  return value
    .split("\n")
    .map((line) => padTerminalLine(line, padding))
    .join("\n");
}

/**
 * Wraps text that may contain SGR color sequences without counting those
 * sequences as visible columns. Other terminal controls are rendered inert.
 */
export function wrapStyledTerminalLine(value: string, width: number): string[] {
  const safe = sanitizeStyledTerminalLine(value);
  if (!safe) return [""];
  const tokens = (safe.match(/\u001b\[[0-9;]*m|./gu) ?? []).map((raw) => ({
    raw,
    visible: !raw.startsWith("\u001b["),
  }));
  const lines: string[] = [];
  let current: typeof tokens = [];
  let visible = 0;
  const continuationIndent = styledContinuationIndent(safe, width);
  const continuationPrefix = Array.from({ length: continuationIndent }, () => ({
    raw: " ",
    visible: true,
  }));
  for (const token of tokens) {
    current.push(token);
    if (token.visible) visible += 1;
    if (visible <= width) continue;

    const wordBreak = findStyledWordBreak(current, width);
    const splitAt = wordBreak >= 0
      ? wordBreak
      : styledTokenIndexAfterVisibleWidth(current, width);
    const head = current.slice(0, splitAt);
    current = [
      ...continuationPrefix,
      ...current.slice(splitAt + (wordBreak >= 0 ? 1 : 0)),
    ];
    lines.push(head.map((item) => item.raw).join("").trimEnd());
    visible = current.filter((item) => item.visible).length;
  }
  lines.push(current.map((item) => item.raw).join("").trimEnd());
  return lines;
}

function styledContinuationIndent(value: string, width: number): number {
  const plain = value.replace(/\u001b\[[0-9;]*m/g, "");
  const leading = plain.match(/^ */u)?.[0].length ?? 0;
  const labeledColumn = plain.slice(leading).match(/^\S.{0,18}? {2,}/u);
  const desired = labeledColumn ? leading + labeledColumn[0].length : leading;
  return Math.min(desired, Math.max(0, Math.floor(width / 3)));
}

function findStyledWordBreak(
  tokens: Array<{ raw: string; visible: boolean }>,
  width: number,
): number {
  let visible = 0;
  let candidate = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.visible) continue;
    visible += 1;
    if (visible > width) break;
    if (/\s/u.test(token.raw) && visible >= Math.max(8, Math.floor(width / 2))) {
      candidate = index;
    }
  }
  return candidate;
}

function styledTokenIndexAfterVisibleWidth(
  tokens: Array<{ raw: string; visible: boolean }>,
  width: number,
): number {
  let visible = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    if (!tokens[index]!.visible) continue;
    visible += 1;
    if (visible > width) return index;
  }
  return tokens.length;
}

function sanitizeStyledTerminalLine(value: string): string {
  let safe = "";
  for (let index = 0; index < value.length;) {
    if (value[index] === "\u001b") {
      const sgr = value.slice(index).match(/^\u001b\[[0-9;]*m/);
      if (sgr) {
        safe += sgr[0];
        index += sgr[0].length;
        continue;
      }
      safe += "?";
      index += 1;
      continue;
    }
    const codePoint = value.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    safe += codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
      ? "?"
      : character;
    index += character.length;
  }
  return safe;
}
