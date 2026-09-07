import type { SQLInputValue } from "node:sqlite";

export type ControlPolicyScope =
  | { level: "operator" }
  | { level: "tenant"; tenant_id: string }
  | { level: "principal"; tenant_id: string; principal: string };
export type ControlPolicyKind = "read" | "action" | "execution" | "parent" | "delegation" | "management";
export type ControlPolicyKey = { scope: ControlPolicyScope; kind: ControlPolicyKind; name: string };
export type ControlPolicyRevision = ControlPolicyKey & {
  revision_id: string;
  authority_digest: string;
  content: unknown;
  content_digest: string;
};
export type ControlPolicyPointer = ControlPolicyKey & { revision_id: string | null };
export type ControlPolicyScopeSnapshot = {
  epoch: number;
  active: ControlPolicyRevision[];
  drafts: ControlPolicyRevision[];
};
export type ControlPolicyEvent = {
  event_id: string;
  actor: string;
  occurred_at: string;
  receipt: unknown;
};
export type ControlPolicyCommit = {
  deployment_id: string; expected_epoch: number;
  revisions: ControlPolicyRevision[]; active: ControlPolicyPointer[];
  drafts?: ControlPolicyPointer[]; event: ControlPolicyEvent;
};
export type ControlPolicyReadGuard = {
  keys: ControlPolicyKey[];
  authorize: (current: Array<ControlPolicyRevision | undefined>) => void;
};

export type Row = Record<string, unknown>;
export type Statement = { sql: string; values?: SQLInputValue[]; check?: (rows: Row[]) => void };
export type PolicyConnection = {
  table(name: string): string;
  collation: string;
  nowMs: string;
  nowIso: string;
  byteLength(expression: string): string;
  execute(statements: Statement[], mode?: "read" | "write" | "migration"): Promise<Row[][]>;
};
