import { sqlDisplayFormatterScript } from "./terminal-syntax.js";

export type WorkbenchSyntaxTokenKind =
  | "comment"
  | "identifier"
  | "keyword"
  | "number"
  | "operator"
  | "plain"
  | "punctuation"
  | "string"
  | "whitespace";

export type WorkbenchSyntaxToken = {
  kind: WorkbenchSyntaxTokenKind;
  text: string;
};

const synapsorDslKeywordValues = [
  "ABSOLUTE",
  "ACTION",
  "ADVANCE",
  "AFTER",
  "AGENT",
  "AGGREGATE",
  "ALLOW",
  "AND",
  "APP",
  "APPROVAL",
  "APPROVALS",
  "APPROVE",
  "ARG",
  "ASC",
  "AUTO",
  "AVG",
  "BATCH",
  "BEFORE",
  "BIND",
  "BINDING",
  "BOOL",
  "BOOLEAN",
  "BOUND",
  "BOUNDARY",
  "BY",
  "BYTES",
  "CAPABILITY",
  "CELLS",
  "CHECKPOINT",
  "CLOUD_SESSION",
  "CLOUD",
  "COMPARE",
  "CONFLICT",
  "CONTEXT",
  "COUNT",
  "CREATE",
  "DATABASE",
  "DAY",
  "DEDUP",
  "DELETE",
  "DELTA",
  "DESC",
  "DESCRIPTION",
  "DIFFERENCING",
  "DIGEST",
  "DIMENSION",
  "DIRECT",
  "DISTINCT",
  "END",
  "ENUM",
  "ENV",
  "ENVIRONMENT",
  "EQ",
  "EVERY",
  "EVIDENCE",
  "EXCLUDE",
  "EXECUTOR",
  "EXTRACTED",
  "FALSE",
  "FIELD",
  "FILTER",
  "FIXED",
  "FROM",
  "GENERATED",
  "GENERATION",
  "GROUP",
  "GROUPS",
  "GT",
  "GTE",
  "GUARD",
  "HANDLER",
  "HINT",
  "HTTP_CLAIM",
  "IN",
  "INCREMENT",
  "INSERT",
  "INTEGER",
  "ITEM",
  "ITEMS",
  "KEEP",
  "KEY",
  "LENGTH",
  "LIMIT",
  "LIMITS",
  "LINK",
  "LOCK",
  "LOOKUP",
  "LT",
  "LTE",
  "MAX",
  "MEASURE",
  "MIN",
  "MINUTE",
  "MONTH",
  "MS",
  "NEQ",
  "NON",
  "NONE",
  "NULL",
  "NUMBER",
  "OBJECT",
  "OF",
  "ON",
  "ONLY",
  "ORDER",
  "OUT",
  "PATCH",
  "PER",
  "PRIMARY",
  "PRINCIPAL",
  "PROPOSAL",
  "PROPOSE",
  "PROTECTED",
  "QUERIES",
  "RANGE",
  "RATE",
  "READ",
  "REFERENCES",
  "RELATIONSHIP",
  "REQUIRE",
  "REQUIRED",
  "RETURNS",
  "REVERSIBLE",
  "ROLE",
  "ROW",
  "ROWS",
  "SCOPE",
  "SELECT",
  "SESSION",
  "SET",
  "SIZE",
  "SOURCE",
  "SQL",
  "STATIC_DEV",
  "STEP",
  "STRING",
  "SUM",
  "SUPERVISED",
  "TENANT",
  "TEXT",
  "TIME",
  "TIMEOUT",
  "TO",
  "TOP",
  "TOTAL",
  "TRANSITION",
  "TRUE",
  "TRUSTED",
  "UNMATCHED",
  "UPDATE",
  "USING",
  "VERSION",
  "WEAK",
  "WEEK",
  "WHEN",
  "WHERE",
  "WORKER",
  "WORKFLOW",
  "WRITE",
  "WRITEBACK",
] as const;

const synapsorDslKeywords = new Set<string>(synapsorDslKeywordValues);

export const WORKBENCH_SYNTAX_CSS = `
    .syntax-block{position:relative;padding-top:32px;white-space:pre;tab-size:2}
    .syntax-block::before{content:attr(data-language-label);position:absolute;top:8px;right:10px;color:var(--muted);font:700 10px/1.2 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-transform:uppercase}
    .syntax-code{display:block;min-width:max-content;color:var(--text,var(--ink));font:inherit;line-height:inherit}
    .syntax-token.keyword{color:#006d77;font-weight:750}.syntax-token.identifier{color:#234a8a}.syntax-token.string{color:#8a3d00}.syntax-token.number{color:#7554a3}.syntax-token.comment{color:#627176;font-style:italic}.syntax-token.operator{color:#9b2c2c;font-weight:700}.syntax-token.punctuation{color:var(--muted)}
    @media(prefers-color-scheme:dark){.syntax-token.keyword{color:#70ded0}.syntax-token.identifier{color:#9fc3ff}.syntax-token.string{color:#ffc07a}.syntax-token.number{color:#d6b2ff}.syntax-token.comment{color:#95a7aa}.syntax-token.operator{color:#ff9d96}}
`;

export function tokenizeSynapsorDsl(
  sourceInput: string,
  keywordSet: ReadonlySet<string> = synapsorDslKeywords,
): WorkbenchSyntaxToken[] {
  const source = String(sourceInput);
  const tokens: WorkbenchSyntaxToken[] = [];
  let index = 0;

  const push = (kind: WorkbenchSyntaxTokenKind, end: number): void => {
    tokens.push({ kind, text: source.slice(index, end) });
    index = end;
  };

  while (index < source.length) {
    const rest = source.slice(index);
    const whitespace = rest.match(/^\s+/)?.[0];
    if (whitespace) {
      push("whitespace", index + whitespace.length);
      continue;
    }
    if (source.startsWith("--", index)) {
      const newline = source.indexOf("\n", index + 2);
      push("comment", newline === -1 ? source.length : newline);
      continue;
    }
    if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      push("comment", close === -1 ? source.length : close + 2);
      continue;
    }
    const quote = source[index];
    if (quote === "'" || quote === "\"") {
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") {
          cursor = Math.min(source.length, cursor + 2);
          continue;
        }
        if (source[cursor] === quote) {
          if (source[cursor + 1] === quote) {
            cursor += 2;
            continue;
          }
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      push("string", cursor);
      continue;
    }
    const number = rest.match(/^-?\d+(?:\.\d+)?/)?.[0];
    if (number) {
      push("number", index + number.length);
      continue;
    }
    const word = rest.match(/^[A-Za-z_][A-Za-z0-9_$]*/)?.[0];
    if (word) {
      push(keywordSet.has(word.toUpperCase()) ? "keyword" : "identifier", index + word.length);
      continue;
    }
    const operator = rest.match(/^(?:->|<=|>=|!=|==|\.\.|[=<>])/u)?.[0];
    if (operator) {
      push("operator", index + operator.length);
      continue;
    }
    if ("()[]{},.;:+*/".includes(source[index] ?? "")) {
      push("punctuation", index + 1);
      continue;
    }
    push("plain", index + 1);
  }
  return tokens;
}

export function tokenizeJson(sourceInput: string): WorkbenchSyntaxToken[] {
  const source = String(sourceInput);
  const tokens: WorkbenchSyntaxToken[] = [];
  let index = 0;

  const push = (kind: WorkbenchSyntaxTokenKind, end: number): void => {
    tokens.push({ kind, text: source.slice(index, end) });
    index = end;
  };

  while (index < source.length) {
    const rest = source.slice(index);
    const whitespace = rest.match(/^\s+/)?.[0];
    if (whitespace) {
      push("whitespace", index + whitespace.length);
      continue;
    }
    if (source[index] === "\"") {
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") {
          cursor = Math.min(source.length, cursor + 2);
          continue;
        }
        if (source[cursor] === "\"") {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      const after = source.slice(cursor).match(/^\s*/)?.[0].length ?? 0;
      const isProperty = source[cursor + after] === ":";
      push(isProperty ? "identifier" : "string", cursor);
      continue;
    }
    const number = rest.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0];
    if (number) {
      push("number", index + number.length);
      continue;
    }
    const literal = rest.match(/^(?:true|false|null)\b/)?.[0];
    if (literal) {
      push("keyword", index + literal.length);
      continue;
    }
    if ("{}[],:".includes(source[index] ?? "")) {
      push("punctuation", index + 1);
      continue;
    }
    push("plain", index + 1);
  }
  return tokens;
}

export function workbenchSyntaxScript(): string {
  return `
    ${sqlDisplayFormatterScript()}
    const synapsorDslKeywords=new Set(${JSON.stringify(synapsorDslKeywordValues)});
    const tokenizeSynapsorDsl=${tokenizeSynapsorDsl.toString()};
    const tokenizeJson=${tokenizeJson.toString()};
    function renderSyntaxCode(target,sourceInput,language){
      const host=typeof target==="string"?document.getElementById(target):target;
      if(!host)return;
      const rawSource=String(sourceInput??"");
      const source=String(language||"").toLowerCase()==="sql"
        ?formatSqlForDisplay(rawSource)
        :rawSource;
      const label=language==="synapsor-dsl"?"Synapsor DSL":String(language||"Code");
      host.classList.add("syntax-block");
      host.setAttribute("data-language-label",label);
      const fallback=()=>{
        const code=document.createElement("code");
        code.className="syntax-code";
        code.textContent=source;
        host.replaceChildren(code);
      };
      try{
        const code=document.createElement("code");
        code.className="syntax-code language-synapsor-dsl";
        code.setAttribute("aria-label",label+" source");
        const tokens=String(language||"").toLowerCase()==="json"
          ?tokenizeJson(source)
          :tokenizeSynapsorDsl(source,synapsorDslKeywords);
        for(const token of tokens){
          if(token.kind==="whitespace"||token.kind==="plain"){
            code.append(document.createTextNode(token.text));
            continue;
          }
          const span=document.createElement("span");
          span.className="syntax-token "+token.kind;
          span.textContent=token.text;
          code.append(span);
        }
        if(code.textContent!==source)throw new Error("Syntax preview changed source text.");
        host.replaceChildren(code);
      }catch(_error){
        fallback();
      }
    }
  `;
}
