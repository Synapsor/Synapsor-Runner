import { describe, expect, it } from "vitest";
import { isCompleteCollectionScopeExpression } from "./complete-collection-scope.js";
const allowed = new Map([["tenant_id", "synapsor.tenant_id"], ["principal_id", "synapsor.principal"]]);
const tenant = "(tenant_id)::text = NULLIF(current_setting('synapsor.tenant_id'::text, true), ''::text)";
const principal = "principal_id::text = current_setting('synapsor.principal'::text, true)";
describe("closed complete-collection RLS proof", () => {
  it.each([`${tenant} AND ${principal}`, `((${tenant}) AND (${principal}))`,
    `current_setting('synapsor.principal', true) = "principal_id" AND pg_catalog.current_setting('synapsor.tenant_id', true) = "tenant_id"`,
    `${principal} AND ${tenant} AND ${tenant}`])("proves only exact scope conjunction: %s", expression => {
    expect(isCompleteCollectionScopeExpression(expression, allowed)).toBe(true);
  });
  it.each([`${tenant} OR ${principal}`, `${tenant} AND ${principal} AND state = 'released'`, `${tenant} AND ${principal} AND true`,
    `${tenant} AND ${principal} OR true`, `${tenant} AND ${principal}; SELECT true`, `${tenant} AND ${principal} -- comment`,
    `${tenant} AND NOT (${principal})`, tenant, principal, "true", "", `${tenant} AND ${principal.replace("synapsor.principal", "other.principal")}`,
    `${tenant} AND private.check_scope(principal_id)`, `${tenant} AND ${principal.replace("::text", "::integer")}`,
    `${tenant} AND ${principal.replace("current_setting", "public.current_setting")}`, `${tenant} AND ${principal.replace("true", "false")}`,
    `${tenant} AND "principal_id OR true" = current_setting('synapsor.principal', true)`,
    `${tenant} AND principal_id = current_setting('synapsor.principal OR true', true)`, "(".repeat(40) + tenant + ")".repeat(40)])("refuses incomplete/unknown scope: %s", expression => {
    expect(isCompleteCollectionScopeExpression(expression, allowed)).toBe(false);
  });
});
