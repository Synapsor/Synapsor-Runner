import {
  assertValidContract,
  normalizeContract,
  type AgentContextSpec,
  type CapabilitySpec,
  type PolicySpec,
  type ResourceSpec,
  type SynapsorContract,
  type WorkflowSpec,
} from "@synapsor/spec";

export type SynapsorContractDefinition = Omit<SynapsorContract, "spec_version" | "kind">;

/** Preserve editor inference for a canonical resource definition. */
export function defineResource<const T extends ResourceSpec>(resource: T): T {
  return resource;
}

/** Preserve editor inference for trusted context bindings resolved outside model input. */
export function defineAgentContext<const T extends AgentContextSpec>(context: T): T {
  return context;
}

/** Preserve editor inference for a canonical read, aggregate, proposal, or external capability. */
export function defineCapability<const T extends CapabilitySpec>(capability: T): T {
  return capability;
}

/** Preserve editor inference for a canonical workflow declaration. */
export function defineWorkflow<const T extends WorkflowSpec>(workflow: T): T {
  return workflow;
}

/** Preserve editor inference for a canonical policy declaration. */
export function definePolicy<const T extends PolicySpec>(policy: T): T {
  return policy;
}

/**
 * Build and validate the same language-neutral contract consumed by the JSON,
 * SQL-like DSL, local Runner, and Cloud registry paths.
 */
export function defineContract<const T extends SynapsorContractDefinition>(
  definition: T,
): SynapsorContract & T {
  const contract = {
    ...definition,
    spec_version: "0.1" as const,
    kind: "SynapsorContract" as const,
  } as SynapsorContract & T;
  assertValidContract(contract);
  return contract;
}

/** Validate and normalize a code-first definition into canonical contract JSON shape. */
export function compileContract(definition: SynapsorContractDefinition | SynapsorContract): SynapsorContract {
  const contract = "spec_version" in definition
    ? definition as SynapsorContract
    : defineContract(definition);
  assertValidContract(contract);
  return normalizeContract(contract);
}

/** Serialize normalized canonical JSON for review, version control, or Runner loading. */
export function contractJson(
  definition: SynapsorContractDefinition | SynapsorContract,
  indentation = 2,
): string {
  if (!Number.isInteger(indentation) || indentation < 0 || indentation > 8) {
    throw new Error("contract JSON indentation must be an integer from 0 to 8");
  }
  return `${JSON.stringify(compileContract(definition), null, indentation)}\n`;
}

export type {
  AgentContextSpec,
  CapabilitySpec,
  PolicySpec,
  ResourceSpec,
  SynapsorContract,
  WorkflowSpec,
} from "@synapsor/spec";
