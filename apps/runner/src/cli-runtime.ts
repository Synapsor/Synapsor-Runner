import { type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { mysqlAdapter } from "@synapsor-runner/mysql";
import { postgresAdapter } from "@synapsor-runner/postgres";
import process from "node:process";


export const adapters = { postgres: postgresAdapter, mysql: mysqlAdapter };

export type RunnerSourceConfig = NonNullable<RuntimeConfig["sources"]>[string];

export type RunnerCapabilityConfig = NonNullable<RuntimeConfig["capabilities"]>[number];

export const runnerProcessStartedAt = new Date(Date.now() - process.uptime() * 1_000).toISOString();


export async function dynamicImportModule<T>(specifier: string): Promise<T> {
  const importer = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<T>;
  return importer(specifier);
}
