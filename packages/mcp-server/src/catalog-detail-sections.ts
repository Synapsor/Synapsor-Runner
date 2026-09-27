import { McpRuntimeError } from "./runtime-errors.js";

export const CONTRACT_SECTION_INDEX = "@sections";

export type ContractUnit = { key: string; value: unknown };
export type ContractSection = { section: string; representation: "array" | "object" | "value"; items: ContractUnit[] };
export type ContractDocument = { revision: string; bytes: number; sections: ContractSection[] };
export type ContractNavigation = {
  subject: string; revision: string; complete_contract: false; complete_section_index: boolean;
  sections: Array<{ section: string; representation: ContractSection["representation"]; item_count: number;
    next_call: { tool: string; arguments: Record<string, unknown> } }>;
  reconstruction: string;
};
export type ContractSectionPage = {
  subject: string; revision: string; section: string; representation: ContractSection["representation"];
  item?: string; items: ContractUnit[]; complete_section: boolean;
};

/** Decompose only the already authorized MODEL projection. A unit remains an
 * entire value: enums, constraints and companion effects are never string-sliced
 * or silently omitted. These are public metadata units, not source records. */
export function contractSections(value: Record<string, unknown>, unitBytes: number, workBytes: number): Omit<ContractDocument, "revision"> {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > workBytes) throw new McpRuntimeError("CATALOG_DETAIL_WORK_LIMIT",
    "The reviewed contract exceeds the bounded detail-preparation work limit. No metadata was truncated or authority changed; ask the operator to inspect its reviewed contract scope.");
  const sections = Object.entries(value).map(([section, content]): ContractSection => ({ section,
    representation: Array.isArray(content) ? "array" : isObject(content) ? "object" : "value",
    items: Array.isArray(content) ? content.map((item, index) => ({ key: String(index), value: item }))
      : isObject(content) ? Object.entries(content).map(([key, item]) => ({ key, value: item }))
        : [{ key: section, value: content }],
  }));
  for (const section of sections) for (const item of section.items) {
    const measured = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (measured > unitBytes) throw new McpRuntimeError("CATALOG_CONTRACT_TOO_LARGE",
      "An indivisible reviewed metadata item exceeds the disclosure limit. No constraints were truncated. No value or enum was sliced. No smaller supported subdetail exists for this item; ask the operator to review its exact metadata scope. Do not guess permissions.",
      { kind: "indivisible_item", section: section.section, measured_bytes: measured, limit_bytes: unitBytes, retryable: false });
  }
  return { bytes, sections };
}

export function selectContractItems(section: ContractSection, item?: string): ContractUnit[] {
  if (item === undefined) return section.items;
  // Array position is an explicit public continuation key. A canonical public
  // field/input id or name is also accepted, only if it identifies ONE unit.
  const found = section.items.filter(unit => unit.key === item || (section.representation === "array" && isObject(unit.value)
    && (unit.value.id === item || unit.value.name === item)));
  if (found.length !== 1) throw new McpRuntimeError("CATALOG_ENTRY_UNAVAILABLE",
    "That exact item is not available unambiguously in this current permitted contract section.");
  return found;
}
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
