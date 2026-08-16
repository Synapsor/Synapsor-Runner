import process from "node:process";

type TerminalOutput = {
  isTTY?: boolean;
};

const sqlKeywords = new Set([
  "ADD", "ALL", "ALTER", "AND", "AS", "ASC", "BEGIN", "BETWEEN", "BY",
  "CASCADE", "CASE", "CHECK", "COLUMN", "COMMIT", "CONFLICT", "CONSTRAINT",
  "CREATE", "CROSS", "CURRENT_DATE", "CURRENT_TIMESTAMP", "DATABASE", "DEFAULT",
  "DELETE", "DESC", "DISTINCT", "DO", "DROP", "ELSE", "END", "EXCEPT", "EXISTS",
  "EXECUTE", "EXPLAIN", "FALSE", "FILTER", "FOR", "FOREIGN", "FROM", "FULL", "FUNCTION",
  "GRANT", "GROUP", "HAVING",
  "IF", "IGNORE", "ILIKE", "IN", "INDEX", "INNER", "INSERT", "INTERSECT", "INTO",
  "IS", "JOIN", "KEY", "LEFT", "LIKE", "LIMIT", "LOCK", "MATERIALIZED", "NOT", "NULL",
  "NULLS", "OFFSET", "ON", "ONLY", "OR", "ORDER", "OUTER", "OWNER", "PARTITION",
  "OVER", "PRECEDING", "PRIMARY", "PROCEDURE", "REFERENCES", "RENAME", "REPLACE",
  "RESTRICT", "RETURNING", "REVOKE", "RIGHT", "ROLE", "ROLLBACK", "ROW", "ROWS", "SCHEMA",
  "SELECT", "SEQUENCE", "SET", "TABLE",
  "TEMP", "TEMPORARY", "THEN", "TO", "TRANSACTION", "TRIGGER", "TRUE", "UNION", "UNIQUE",
  "UPDATE", "USAGE", "USE", "USING", "VALUES", "VIEW", "WHEN", "WHERE", "WINDOW", "WITH",
]);

const sqlFunctions = new Set([
  "ABS", "AVG", "CAST", "CEIL", "COALESCE", "CONCAT", "COUNT", "DATE_TRUNC",
  "FLOOR", "GREATEST", "LEAST", "LOWER", "MAX", "MIN", "NOW", "NULLIF", "ROUND", "SUM",
  "UPPER",
]);

const sqlTypes = new Set([
  "BIGINT", "BIGSERIAL", "BINARY", "BIT", "BLOB", "BOOLEAN", "CHAR", "CHARACTER",
  "DATE", "DATETIME", "DECIMAL", "DOUBLE", "ENUM", "FLOAT", "INET", "INT", "INTEGER",
  "INTERVAL", "JSON", "JSONB", "LONGTEXT", "MEDIUMINT", "NUMERIC", "REAL", "SERIAL",
  "SMALLINT", "TEXT", "TIME", "TIMESTAMP", "TIMESTAMPTZ", "TINYINT", "UUID", "VARBINARY",
  "VARCHAR",
]);

const sqlToken = /(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)[\s\S]*?\1|--[^\n]*|\/\*[\s\S]*?\*\/|"(?:""|[^"\n])*"|`(?:``|[^`\n])*`|\[(?:]]|[^\]\n])*\]|'(?:''|\\.|[^'\\])*'|\$\d+|:[A-Za-z_][A-Za-z0-9_]*|\?|[A-Za-z_][A-Za-z0-9_$]*|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

type SqlDisplayToken = {
  kind: "word" | "quoted" | "string" | "number" | "placeholder" | "punctuation" | "operator" | "comment";
  value: string;
};

export function terminalSyntaxColorEnabled(
  output: TerminalOutput = process.stdout,
): boolean {
  return output.isTTY === true && !("NO_COLOR" in process.env);
}

export function safeTerminalText(value: string): string {
  return escapeTerminalControls(value, true);
}

export function safeTerminalCellText(value: string): string {
  return escapeTerminalControls(value, false);
}

export function renderTerminalJson(value: unknown, color = false, indent = 2): string {
  const serialized = safeTerminalText(JSON.stringify(value, null, indent) ?? "null");
  return color ? highlightTerminalJson(serialized) : serialized;
}

export function renderTerminalJsonFrame(
  value: unknown,
  options: {
    title: string;
    color?: boolean;
    columns?: number;
  },
): string {
  const serialized = renderTerminalJson(value, false);
  return renderTerminalSyntaxFrame(serialized, {
    title: options.title,
    color: options.color,
    columns: options.columns,
    highlight: highlightTerminalJson,
  });
}

export function renderTerminalToolName(value: string, color = false): string {
  const safe = safeTerminalText(value);
  if (!color) return safe;
  const segments = safe.split(".");
  if (segments.length === 1) return style("1;32", safe);
  return segments.map((segment, index) =>
    `${index > 0 ? style("2", ".") : ""}${style(index === segments.length - 1 ? "1;32" : "36", segment)}`,
  ).join("");
}

export function renderTerminalFact(
  label: string,
  value: string | number | boolean,
  options: {
    color?: boolean;
    tone?: "value" | "identifier" | "success" | "warning" | "danger" | "muted";
    labelTone?: "heading" | "muted";
  } = {},
): string {
  const safeLabel = safeTerminalText(label);
  const safeValue = safeTerminalText(String(value));
  if (!options.color) return `${safeLabel}: ${safeValue}`;
  const valueCode = {
    value: "1",
    identifier: "36",
    success: "1;32",
    warning: "1;33",
    danger: "1;31",
    muted: "2",
  }[options.tone ?? "value"];
  const labelCode = options.labelTone === "muted" ? "2" : "1;36";
  return `${style(labelCode, `${safeLabel}:`)} ${style(valueCode, safeValue)}`;
}

export function renderTerminalSectionHeading(label: string, color = false): string {
  const safe = safeTerminalText(label.toUpperCase());
  return color ? style("1;36", safe) : safe;
}

function highlightTerminalJson(serialized: string): string {
  const token = /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}\[\],:]/g;
  return serialized.replace(token, (match, offset: number) => {
    if (match.startsWith('"')) {
      const isKey = /^\s*:/.test(serialized.slice(offset + match.length));
      return style(isKey ? "1;36" : "1;32", match);
    }
    if (/^-?\d/.test(match)) return style("1;33", match);
    if (match === "true" || match === "false") return style("1;35", match);
    return style("2", match);
  });
}

export function renderTerminalSql(value: string, color = false): string {
  const statement = formatSqlForTerminal(safeTerminalText(value));
  return color ? highlightTerminalSql(statement) : statement;
}

export function renderTerminalSqlFrame(
  value: string,
  options: {
    title: string;
    metadata?: string[];
    color?: boolean;
    columns?: number;
  },
): string {
  const statement = renderTerminalSql(value, false);
  return renderTerminalSyntaxFrame(statement, {
    title: options.title,
    metadata: options.metadata,
    color: options.color,
    columns: options.columns,
    highlight: highlightTerminalSql,
  });
}

export function renderTerminalCommandFrame(
  commands: string[],
  options: {
    title: string;
    metadata?: string[];
    color?: boolean;
    columns?: number;
  },
): string {
  return renderTerminalSyntaxFrame(commands.join("\n"), {
    title: options.title,
    metadata: options.metadata,
    color: options.color,
    columns: options.columns,
    highlight: highlightTerminalCommand,
  });
}

function renderTerminalSyntaxFrame(
  bodyValue: string,
  options: {
    title: string;
    metadata?: string[];
    color?: boolean;
    columns?: number;
    highlight: (value: string) => string;
  },
): string {
  const bodyValueSafe = safeTerminalText(bodyValue);
  const metadata = (options.metadata ?? []).map(safeTerminalText);
  const safeTitle = safeTerminalText(options.title);
  const availableWidth = Math.max(24, Math.min(100, (options.columns ?? 100) - 2));
  const naturalWidth = Math.max(
    24,
    safeTitle.length + 6,
    ...bodyValueSafe.split("\n").map((line) => line.length + 4),
    ...metadata.map((line) => line.length + 4),
  );
  const frameWidth = Math.min(availableWidth, naturalWidth);
  const innerWidth = frameWidth - 4;
  const bodyLines = bodyValueSafe.split("\n").flatMap((line) =>
    wrapTerminalFrameLine(line, innerWidth));
  const metadataLines = metadata.flatMap((line) => wrapTerminalFrameLine(line, innerWidth));
  const body = bodyLines.map((line) => framedTerminalLine(
    options.color ? options.highlight(line) : line,
    line.length,
    innerWidth,
  ));
  const footer = metadataLines.map((line) => framedTerminalLine(
    options.color ? highlightTerminalMetadata(line) : line,
    line.length,
    innerWidth,
  ));
  return [
    titledTerminalBorder(safeTitle, frameWidth),
    ...body,
    ...(footer.length > 0 ? [plainTerminalBorder(frameWidth), ...footer] : []),
    plainTerminalBorder(frameWidth),
  ].join("\n");
}

function highlightTerminalMetadata(value: string): string {
  const separator = value.indexOf(":");
  if (separator < 0) return style("1", value);
  return `${style("1;36", value.slice(0, separator + 1))}${style("1", value.slice(separator + 1))}`;
}

function highlightTerminalCommand(value: string): string {
  const token = /'(?:'\\''|[^'])*'|<[^>]+>|--[A-Za-z0-9][A-Za-z0-9-]*|^[A-Za-z0-9][A-Za-z0-9._-]*/g;
  return value.replace(token, (match, offset: number) => {
    if (offset === 0) return style("1;32", match);
    if (match.startsWith("--")) return style("1;36", match);
    if (match.startsWith("<")) return style("1;33", match);
    if (match.startsWith("'")) return style("1;35", match);
    return match;
  });
}

function highlightTerminalSql(statement: string): string {
  return statement.replace(sqlToken, (match) => {
    const upper = match.toUpperCase();
    if (match.startsWith("--") || match.startsWith("/*")) return style("2", match);
    if ((match.startsWith("$") && match.endsWith("$") && !/^\$\d+$/.test(match))
      || match.startsWith("'")) return style("1;35", match);
    if (match.startsWith('"') || match.startsWith("`") || match.startsWith("[")) {
      return style("1;32", match);
    }
    if (match === "?" || /^\$\d+$/.test(match) || /^:[A-Za-z_]/.test(match)) {
      return style("1;33", match);
    }
    if (/^-?\d/.test(match)) return style("1;33", match);
    if (sqlFunctions.has(upper)) return style("1;34", match);
    if (sqlTypes.has(upper)) return style("1;35", match);
    if (sqlKeywords.has(upper)) return style("1;36", match);
    return match;
  });
}

function titledTerminalBorder(title: string, width: number): string {
  const maximum = Math.max(1, width - 6);
  const shown = title.length > maximum
    ? `${title.slice(0, Math.max(1, maximum - 3))}...`
    : title;
  return `+-- ${shown} ${"-".repeat(Math.max(0, width - shown.length - 6))}+`;
}

function plainTerminalBorder(width: number): string {
  return `+${"-".repeat(Math.max(0, width - 2))}+`;
}

function framedTerminalLine(
  rendered: string,
  visibleLength: number,
  innerWidth: number,
): string {
  return `| ${rendered}${" ".repeat(Math.max(0, innerWidth - visibleLength))} |`;
}

function wrapTerminalFrameLine(value: string, width: number): string[] {
  if (value.length <= width) return [value];
  const initialIndent = value.match(/^\s*/)?.[0] ?? "";
  const continuationIndent = `${initialIndent}  `.slice(0, Math.max(0, width - 1));
  const lines: string[] = [];
  let remaining = value;
  while (remaining.length > width) {
    const candidate = remaining.slice(0, width + 1);
    const wordBreak = candidate.lastIndexOf(" ");
    const currentIndent = remaining.match(/^\s*/)?.[0].length ?? 0;
    const splitAt = wordBreak > currentIndent
      ? wordBreak
      : width;
    lines.push(remaining.slice(0, splitAt).trimEnd());
    remaining = `${continuationIndent}${remaining.slice(splitAt).trimStart()}`;
  }
  lines.push(remaining);
  return lines;
}

function formatSqlForTerminal(statement: string): string {
  const tokens = tokenizeSqlForDisplay(statement);
  const firstWord = tokens.find((token) => token.kind !== "comment")?.value.toUpperCase();
  if (firstWord !== "SELECT") return statement;

  const lines: string[] = [];
  let current: SqlDisplayToken[] = [];
  let currentIndent = 0;
  let depth = 0;
  let clause: "select" | "from" | "where" | "group" | "order" | "having" | "join" | "on" | "other" = "other";

  const flush = () => {
    if (!current.length) return;
    lines.push(`${"  ".repeat(currentIndent)}${joinSqlDisplayTokens(current)}`);
    current = [];
  };
  const clauseLine = (label: string, indent = 1) => {
    flush();
    lines.push(label);
    currentIndent = indent;
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const upper = token.value.toUpperCase();

    if (token.kind === "comment") {
      flush();
      lines.push(`${"  ".repeat(currentIndent)}${token.value}`);
      continue;
    }
    if (token.value === "(") {
      current.push(token);
      depth += 1;
      continue;
    }
    if (token.value === ")") {
      depth = Math.max(0, depth - 1);
      current.push(token);
      continue;
    }

    if (depth === 0 && upper === "SELECT") {
      clauseLine("SELECT");
      clause = "select";
      continue;
    }
    if (depth === 0 && upper === "FROM") {
      clauseLine("FROM");
      clause = "from";
      continue;
    }
    if (depth === 0 && upper === "WHERE") {
      clauseLine("WHERE");
      clause = "where";
      continue;
    }
    if (depth === 0 && upper === "HAVING") {
      clauseLine("HAVING");
      clause = "having";
      continue;
    }
    if (depth === 0 && upper === "GROUP" && tokenWord(tokens[index + 1], "BY")) {
      clauseLine("GROUP BY");
      clause = "group";
      index += 1;
      continue;
    }
    if (depth === 0 && upper === "ORDER" && tokenWord(tokens[index + 1], "BY")) {
      clauseLine("ORDER BY");
      clause = "order";
      index += 1;
      continue;
    }
    const join = depth === 0 ? sqlJoinAt(tokens, index) : undefined;
    if (join) {
      clauseLine(join.label);
      clause = "join";
      index += join.consumed - 1;
      continue;
    }
    if (depth === 0 && upper === "ON") {
      clauseLine("ON");
      clause = "on";
      continue;
    }
    if (depth === 0 && (upper === "LIMIT" || upper === "OFFSET" || upper === "FETCH" || upper === "RETURNING")) {
      flush();
      currentIndent = 0;
      current = [token];
      clause = "other";
      continue;
    }
    if (depth === 0 && upper === "UNION") {
      flush();
      const all = tokenWord(tokens[index + 1], "ALL");
      lines.push(all ? "UNION ALL" : "UNION");
      if (all) index += 1;
      currentIndent = 0;
      clause = "other";
      continue;
    }
    if (depth === 0 && (upper === "AND" || upper === "OR")
      && (clause === "where" || clause === "having" || clause === "on")) {
      flush();
      currentIndent = 1;
      current = [token];
      continue;
    }

    current.push(token);
    if (depth === 0 && token.value === ","
      && (clause === "select" || clause === "from" || clause === "group" || clause === "order")) {
      flush();
      currentIndent = 1;
    }
    if (depth === 0 && token.value === ";") {
      flush();
      if (index < tokens.length - 1) lines.push("");
      currentIndent = 0;
      clause = "other";
    }
  }
  flush();
  return lines.join("\n");
}

function tokenizeSqlForDisplay(statement: string): SqlDisplayToken[] {
  const tokens: SqlDisplayToken[] = [];
  let index = 0;
  const push = (kind: SqlDisplayToken["kind"], end: number) => {
    tokens.push({ kind, value: statement.slice(index, end) });
    index = end;
  };

  while (index < statement.length) {
    const rest = statement.slice(index);
    const character = statement[index]!;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (rest.startsWith("--")) {
      const end = statement.indexOf("\n", index + 2);
      push("comment", end === -1 ? statement.length : end);
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = statement.indexOf("*/", index + 2);
      push("comment", end === -1 ? statement.length : end + 2);
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      let end = index + 1;
      while (end < statement.length) {
        if (statement[end] === quote) {
          if (statement[end + 1] === quote) {
            end += 2;
            continue;
          }
          end += 1;
          break;
        }
        if (quote === "'" && statement[end] === "\\" && end + 1 < statement.length) {
          end += 2;
          continue;
        }
        end += 1;
      }
      push(quote === "'" ? "string" : "quoted", end);
      continue;
    }
    if (character === "[") {
      let end = index + 1;
      while (end < statement.length) {
        if (statement[end] === "]") {
          if (statement[end + 1] === "]") {
            end += 2;
            continue;
          }
          end += 1;
          break;
        }
        end += 1;
      }
      push("quoted", end);
      continue;
    }
    if (character === "$") {
      const placeholder = rest.match(/^\$\d+/)?.[0];
      if (placeholder) {
        push("placeholder", index + placeholder.length);
        continue;
      }
      const delimiter = rest.match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (delimiter) {
        const close = statement.indexOf(delimiter, index + delimiter.length);
        push("string", close === -1 ? statement.length : close + delimiter.length);
        continue;
      }
    }
    const namedPlaceholder = rest.match(/^:[A-Za-z_][A-Za-z0-9_]*/)?.[0];
    if (namedPlaceholder) {
      push("placeholder", index + namedPlaceholder.length);
      continue;
    }
    if (character === "?") {
      push("placeholder", index + 1);
      continue;
    }
    const word = rest.match(/^[A-Za-z_][A-Za-z0-9_$]*/)?.[0];
    if (word) {
      push("word", index + word.length);
      continue;
    }
    const number = rest.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0];
    if (number) {
      push("number", index + number.length);
      continue;
    }
    const operator = rest.match(/^(?:->>|#>>|::|>=|<=|<>|!=|\|\||->|#>|:=|[-+*/%=<>])/u)?.[0];
    if (operator) {
      push("operator", index + operator.length);
      continue;
    }
    if (/[(),.;]/.test(character)) {
      push("punctuation", index + 1);
      continue;
    }
    push("operator", index + 1);
  }
  return tokens;
}

function joinSqlDisplayTokens(tokens: SqlDisplayToken[]): string {
  let output = "";
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const previous = tokens[index - 1];
    if (previous && sqlDisplayTokenNeedsSpace(previous, token)) output += " ";
    output += token.value;
  }
  return output;
}

function sqlDisplayTokenNeedsSpace(previous: SqlDisplayToken, current: SqlDisplayToken): boolean {
  if ([",", ")", ";", "."].includes(current.value)) return false;
  if (["(", "."].includes(previous.value)) return false;
  if (current.value === "::" || previous.value === "::") return false;
  if (current.value === "(") {
    const upper = previous.value.toUpperCase();
    return previous.kind !== "word" || [
      "IN", "EXISTS", "NOT", "OVER", "FILTER", "VALUES", "USING",
    ].includes(upper);
  }
  if (current.kind === "string" && previous.kind === "word"
    && ["E", "N", "X", "B", "U&"].includes(previous.value.toUpperCase())) return false;
  if (previous.kind === "operator" || current.kind === "operator") return true;
  return true;
}

function tokenWord(token: SqlDisplayToken | undefined, expected: string): boolean {
  return token?.kind === "word" && token.value.toUpperCase() === expected;
}

function sqlJoinAt(
  tokens: SqlDisplayToken[],
  index: number,
): { label: string; consumed: number } | undefined {
  if (tokenWord(tokens[index], "JOIN")) return { label: "JOIN", consumed: 1 };
  for (const modifier of ["INNER", "CROSS"] as const) {
    if (tokenWord(tokens[index], modifier) && tokenWord(tokens[index + 1], "JOIN")) {
      return { label: `${modifier} JOIN`, consumed: 2 };
    }
  }
  for (const modifier of ["LEFT", "RIGHT", "FULL"] as const) {
    if (!tokenWord(tokens[index], modifier)) continue;
    if (tokenWord(tokens[index + 1], "JOIN")) {
      return { label: `${modifier} JOIN`, consumed: 2 };
    }
    if (tokenWord(tokens[index + 1], "OUTER") && tokenWord(tokens[index + 2], "JOIN")) {
      return { label: `${modifier} OUTER JOIN`, consumed: 3 };
    }
  }
  return undefined;
}

function escapeTerminalControls(value: string, preserveNewlines: boolean): string {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (character) => preserveNewlines && character === "\n"
      ? "\n"
      : `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function style(codes: string, value: string): string {
  return `\u001b[${codes}m${value}\u001b[0m`;
}
