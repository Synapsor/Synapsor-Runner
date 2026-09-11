import { Lexer, type Token, type Tokens } from "marked";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { stripVTControlCharacters } from "node:util";

type Styles = { bold: (text: string) => string; code: (text: string) => string };
const safe = (text: string) => stripVTControlCharacters(text).replace(/[\u0000-\u001f\u007f-\u009f]/gu, "");

function inline(tokens: Token[], style: Styles): string {
  return tokens.map((token): string => {
    switch (token.type) {
      case "strong": return style.bold(inline((token as Tokens.Strong).tokens, style));
      case "codespan": return style.code(safe((token as Tokens.Codespan).text));
      case "br": return "\n";
      case "html": return /^<br\s*\/?\s*>$/iu.test(token.raw) ? "\n" : safe(token.raw);
      case "escape": return safe((token as Tokens.Escape).text);
      default: return "tokens" in token && Array.isArray(token.tokens)
        ? inline(token.tokens, style)
        : safe("text" in token && typeof token.text === "string" ? token.text : token.raw);
    }
  }).join("");
}

/** Standard pipe tables only. Other Markdown stays on the existing prose/code
 * surface. Parsing never executes HTML or follows model-authored links. */
export function renderTerminalModelTable(source: string, width: number, style: Styles): string[] | undefined {
  const tokens = Lexer.lex(source, { gfm: true });
  if (tokens.length !== 1 || tokens[0]?.type !== "table") return undefined;
  const table = tokens[0] as Tokens.Table;
  // GFM ignores surplus cells. An operator review must not lose those values;
  // retain malformed rows on the literal surface instead.
  if (source.trim().split("\n").slice(2).some((line) => tableCellCount(line) > table.header.length)) return undefined;
  const headers = table.header.map((cell) => inline(cell.tokens, style));
  const rows = table.rows.map((row) => row.map((cell) => inline(cell.tokens, style)));
  const available = Math.max(12, Math.floor(width));
  const wrap = (value: string, columns: number) => wrapAnsi(value, columns, { hard: true, trim: false }).split("\n");
  const widths = headers.map((header, index) => Math.max(8,
    ...[header, ...rows.map((row) => row[index] ?? "")].flatMap((cell) => cell.split("\n").map((line) => stringWidth(line)))));
  const budget = available - 3 * widths.length - 1;
  if (available < 64 || budget < widths.length * 12) {
    const stacked = rows.flatMap((row, rowIndex) => [
      ...(rowIndex ? [""] : []),
      ...headers.flatMap((header, index) => [
        ...wrap(style.bold(header) + ":", available),
        ...wrap(row[index] ?? "", available - 2).map((line) => `  ${line}`),
      ]),
    ]);
    return rows.length ? stacked : headers.flatMap((header) => wrap(style.bold(header), available));
  }
  while (widths.reduce((a, b) => a + b, 0) > budget) {
    const largest = widths.indexOf(Math.max(...widths));
    widths[largest]!--;
  }
  const border = "+" + widths.map((columns) => "-".repeat(columns + 2)).join("+") + "+";
  const rowLines = (row: string[], heading = false) => {
    const cells = widths.map((columns, index) => wrap(row[index] ?? "", columns));
    return Array.from({ length: Math.max(...cells.map((cell) => cell.length)) }, (_, lineIndex) =>
      "| " + cells.map((cell, index) => {
        const value = cell[lineIndex] ?? "";
        const padding = Math.max(0, widths[index]! - stringWidth(value));
        const alignment = heading ? "left" : table.align[index];
        const left = alignment === "right" ? padding : alignment === "center" ? Math.floor(padding / 2) : 0;
        return " ".repeat(left) + (heading ? style.bold(value) : value) + " ".repeat(padding - left);
      }).join(" | ") + " |");
  };
  return [border, ...rowLines(headers, true), border, ...rows.flatMap((row) => rowLines(row)), border];
}

function tableCellCount(line: string): number {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  let count = 1;
  let escaped = false;
  let trailingDelimiter = false;
  for (const char of text) {
    if (escaped) { escaped = false; trailingDelimiter = false; continue; }
    if (char === "\\") { escaped = true; trailingDelimiter = false; continue; }
    trailingDelimiter = char === "|";
    if (trailingDelimiter) count++;
  }
  return count - (trailingDelimiter ? 1 : 0);
}

/** Hold only pipe-led blocks. Prose remains incremental, and fenced examples
 * remain literal. A bounded block that cannot be parsed is emitted losslessly. */
export function createTerminalTableBlocks(input: { prose: (text: string) => void; table: (source: string) => void }) {
  let line = "";
  let prefix = true;
  let capture = false;
  let block = "";
  let fence: string | undefined;
  const flush = () => { if (block) { input.table(block); block = ""; } };
  const finishLine = () => {
    if (capture) block += line + "\n";
    else {
      const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/u);
      if (marker && (!fence || marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim())) {
        fence = fence ? undefined : marker[1];
      }
    }
    line = ""; prefix = true; capture = false;
  };
  return {
    push(text: string) {
      for (const char of text) {
        if (prefix) {
          if (char === " " || char === "\t") { line += char; continue; }
          capture = !fence && char === "|" && line.length <= 3;
          prefix = false;
          if (!capture) { flush(); input.prose(line); }
        }
        if (char === "\n") {
          if (!capture) input.prose(char);
          finishLine();
        } else {
          line += char;
          if (!capture) input.prose(char);
        }
        if (block.length + line.length > 131_072) {
          // Keep all content on oversized/malformed input; never truncate it.
          if (capture) { flush(); input.prose(line); capture = false; }
          line = line.slice(-256);
        }
      }
    },
    finish() {
      if (capture) block += line;
      else if (prefix) { flush(); input.prose(line); }
      flush(); line = ""; capture = false;
    },
  };
}
