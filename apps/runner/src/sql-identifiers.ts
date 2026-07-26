

export function quoteSqlIdentifier(identifier: string, engine: "postgres" | "mysql"): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`unsafe ${engine} identifier: ${identifier}`);
  }
  return engine === "postgres" ? `"${identifier}"` : `\`${identifier}\``;
}
