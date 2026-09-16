import assert from "node:assert/strict";
import { projectProtectedReadResultForModel } from "../../../packages/mcp-server/src/protected-read-runtime.js";
import type { RuntimeCapabilityConfig } from "../../../packages/mcp-server/src/runtime-types.js";
const capability: RuntimeCapabilityConfig = {
  name: "fixture.inspect", kind: "read", source: "synthetic", target: { schema: "public", table: "fixture", primary_key: "id", tenant_key: "tenant_id" },
  args: { id: { type: "string", required: true } }, lookup: { id_from_arg: "id" },
  visible_columns: ["private_flag"], model_withheld_fields: ["private_flag"],
};
const raw = { data: { rows: [{ private_flag: true }, { private_flag: true }, { private_flag: false }] } };
const result = projectProtectedReadResultForModel(capability, raw);
const cells = (result.value.data as { rows: { private_flag: string }[] }).rows.map(row => row.private_flag);
assert.equal(cells[0], cells[1]); assert.notEqual(cells[0], cells[2]);
assert(cells.every(cell => /^\[withheld:[a-f0-9]{12}:\d+\]$/.test(cell)));
assert.deepEqual(raw.data.rows.map(row => row.private_flag), [true, true, false]);
console.log(JSON.stringify({ surface: "separate named read raw withholding", equal_values_share_token: cells[0] === cells[1], private_analysis_intent_available_in_capability: false,
  verdict: "Current raw-withheld contract preserves equality. Do not globally reinterpret existing named authority; private export requires an explicit reviewed contract distinction." }, null, 2));
