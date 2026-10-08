import { describe, expect, it } from "vitest";
import { mysqlGrantPosture } from "./index.js";
describe("independent MySQL effective grant scope",()=>{
  it.each([['archive_%','archive_2026'],['archive_','archiveX']])("does not silently certify unresolved database-pattern authority %s",(pattern,schema)=>{
    const posture=mysqlGrantPosture([`GRANT UPDATE ON \`${pattern}\`.* TO 'writer'@'localhost'`],[{schema,table:'extra'}]);
    expect(!posture.verified || posture.elevated || posture.relations[`${schema}.extra`]?.update===true).toBe(true);
  });
  it("retains exact extra-schema table column grants independently of similar names",()=>{
    const posture=mysqlGrantPosture(["GRANT UPDATE (`private`) ON `archive_2026`.`extra` TO 'writer'@'localhost'"],[{schema:'archive_2026',table:'extra'},{schema:'archiveX2026',table:'extra'}]);
    expect(posture.verified).toBe(true);expect(posture.column_privileges['archive_2026.extra']?.update).toEqual(['private']);expect(posture.column_privileges['archiveX2026.extra']?.update).toBeUndefined();
  });
});
