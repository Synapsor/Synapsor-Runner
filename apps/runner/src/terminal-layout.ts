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
