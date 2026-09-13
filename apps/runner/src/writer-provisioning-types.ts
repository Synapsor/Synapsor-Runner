import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import type { SupervisedWriterPostureAssessment } from "./worker-policy.js";

export type WriterProvisioningPlan = {
  version: 1;
  outcome: string;
  outcomes?: string[];
  action_digest: string;
  writer_env: string;
  read_env?: string;
  suggested_role: string;
  engine: string;
  /** Planned existing receipt infrastructure; never evidence that it exists. */
  receipt_setup?: { schema: string; table: string };
  relations: Array<NonNullable<SupervisedWriterPostureAssessment["required_relations"]>[number] & {
    schema: string; table: string;
    policies: NonNullable<SchemaInspection["tables"][number]["row_level_security_policies"]>;
    triggers: NonNullable<SchemaInspection["tables"][number]["write_triggers"]>;
    row_security?: { enabled: boolean | "unknown"; forced: boolean | "unknown" };
    native_uuid_scope_columns?: string[];
  }>;
};
