type Node = { kind: "column" | "setting" | "string"; value: string }
  | { kind: "true" }
  | { kind: "eq" | "and"; left: Node; right: Node };
type Token = { kind: "word" | "identifier" | "string" | "symbol"; value: string };

/** Closed expression grammar, not a general SQL-equivalence claim. Unknown syntax fails closed. */
export function isCompleteCollectionScopeExpression(expression: string, allowed: Map<string, string>): boolean {
  if (expression.length > 16_384) return false;
  const tokens: Token[] = [];
  const lexer = /\s+|'(?:''|[^'])*'|"(?:""|[^"])*"|[a-zA-Z_][a-zA-Z_0-9$]*|::|[=().,]/gy;
  let offset = 0;
  while (offset < expression.length) {
    lexer.lastIndex = offset;
    const match = lexer.exec(expression);
    if (!match || tokens.length > 512) return false;
    offset = lexer.lastIndex;
    const value = match[0];
    if (/^\s/.test(value)) continue;
    tokens.push(value.startsWith("'") ? { kind: "string", value: value.slice(1, -1).replaceAll("''", "'") }
      : value.startsWith('"') ? { kind: "identifier", value: value.slice(1, -1).replaceAll('""', '"') }
      : /^[a-zA-Z_]/.test(value) ? { kind: "word", value: value.toLowerCase() }
      : { kind: "symbol", value });
  }
  let cursor = 0;
  let depth = 0;
  const take = (value: string) => {
    const token = tokens[cursor];
    if (token && token.kind !== "string" && token.kind !== "identifier" && token.value === value) { cursor++; return true; }
    return false;
  };
  const require = (value: string) => { if (!take(value)) throw new Error("Unsupported scope syntax"); };
  function atom(): Node {
    if (++depth > 32) throw new Error("Scope expression is too deep");
    let result: Node;
    if (take("(")) { result = conjunction(); require(")"); }
    else {
      const token = tokens[cursor++];
      if (!token) throw new Error("Missing scope operand");
      if (token.kind === "string") result = { kind: "string", value: token.value };
      else if (token.kind === "identifier") result = { kind: "column", value: token.value };
      else if (token.kind === "word") {
        let name = token.value;
        if (name === "pg_catalog" && take(".")) {
          const qualified = tokens[cursor++];
          if (qualified?.kind !== "word" || qualified.value !== "current_setting") throw new Error("Unreviewed function");
          name = qualified.value;
        }
        if (take("(")) {
          if (name === "current_setting") {
            const setting = atom(); require(","); const missing = atom(); require(")");
            if (setting.kind !== "string" || missing.kind !== "true") throw new Error("Unreviewed setting call");
            result = { kind: "setting", value: setting.value };
          } else if (name === "nullif") {
            const setting = atom(); require(","); const empty = atom(); require(")");
            if (setting.kind !== "setting" || empty.kind !== "string" || empty.value !== "") throw new Error("Unreviewed null handling");
            result = setting;
          } else throw new Error("Unreviewed function");
        } else result = name === "true" ? { kind: "true" } : { kind: "column", value: name };
      } else throw new Error("Unsupported operand");
    }
    while (take("::")) {
      if (take("pg_catalog")) require(".");
      require("text");
      if (result.kind !== "column" && result.kind !== "setting" && result.kind !== "string") throw new Error("Unsupported cast");
    }
    depth--;
    return result;
  }
  function equality(): Node {
    const left = atom();
    return take("=") ? { kind: "eq", left, right: atom() } : left;
  }
  function conjunction(): Node {
    let result = equality();
    while (take("and")) result = { kind: "and", left: result, right: equality() };
    return result;
  }
  const covered = new Set<string>();
  function prove(node: Node): boolean {
    if (node.kind === "and") return prove(node.left) && prove(node.right);
    if (node.kind !== "eq") return false;
    const column = node.left.kind === "column" ? node.left : node.right.kind === "column" ? node.right : undefined;
    const setting = node.left.kind === "setting" ? node.left : node.right.kind === "setting" ? node.right : undefined;
    if (!column || !setting || allowed.get(column.value) !== setting.value) return false;
    covered.add(column.value);
    return true;
  }
  try {
    const node = conjunction();
    return cursor === tokens.length && prove(node) && covered.size === allowed.size && allowed.size > 0;
  } catch { return false; }
}
