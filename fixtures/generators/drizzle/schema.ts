import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const supportTickets = pgTable("support_tickets", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  customerId: text("customer_id").notNull(),
  subject: text("subject").notNull(),
  status: text("status").notNull(),
  internalNote: text("internal_note"),
  priority: integer("priority").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
