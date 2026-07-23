export { SPEC_VERSION, SUPPORTED_SPEC_VERSIONS } from "./version.js";
export { validateContract, assertValidContract, isNumericProposalField } from "./validate.js";
export { normalizeContract } from "./normalize.js";
export { loadContract } from "./load.js";
export { SynapsorSpecValidationError } from "./errors.js";
export type {
  AgentContextSpec,
  AggregateReadSpec,
  ArgumentSpec,
  CapabilitySpec,
  ContractMetadata,
  EvidenceSpec,
  ExternalActionSpec,
  JsonRecord,
  JsonScalar,
  JsonValue,
  PolicySpec,
  ProposalActionSpec,
  ProposalSpec,
  ProtectedReadAggregateSpec,
  ProtectedReadDimensionSpec,
  ProtectedReadLimitsSpec,
  ProtectedReadMeasureSpec,
  ProtectedReadPredicateSpec,
  ProtectedReadRelationshipSpec,
  ProtectedReadSpec,
  ProtectedReadTimeBucketSpec,
  ProtectedReadValueSpec,
  ReceiptSpec,
  ReplaySpec,
  ResourceSpec,
  ScalarArgumentSpec,
  ObjectArrayArgumentSpec,
  SynapsorContract,
  ValidationIssue,
  ValidationResult,
  WorkflowSpec,
} from "./types.js";
