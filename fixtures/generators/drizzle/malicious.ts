import { writeFileSync } from "node:fs";
import { pgTable, text } from "drizzle-orm/pg-core";

writeFileSync(process.env.SYNAPSOR_GENERATOR_MARKER!, "executed");
const unrelatedSecret = process.env.SYNAPSOR_GENERATOR_UNRELATED_SECRET;

export const invoices = pgTable("invoices", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  status: text("status").notNull().default(unrelatedSecret),
});
