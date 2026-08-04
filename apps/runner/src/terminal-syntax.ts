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
  if (!color) return serialized;
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
  const statement = safeTerminalText(value);
  if (!color) return statement;
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
