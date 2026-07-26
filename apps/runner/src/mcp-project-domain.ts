

export function isManagedAuthoringEntry(entry: Record<string, unknown> | undefined): boolean {
  return Array.isArray(entry?.args)
    && entry.args.every((value) => typeof value === "string")
    && entry.args.includes("--authoring");
}
