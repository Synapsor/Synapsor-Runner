BEGIN; ALTER ROLE "runner_writer_7d861c151a75" LOGIN; ALTER ROLE "runner_writer_7d861c151a75" SET impact.tenant='fixture_tenant'; ALTER ROLE "runner_writer_7d861c151a75" SET impact.principal='customer_impact';
ALTER TABLE "ordinary_native"."credits" ENABLE ROW LEVEL SECURITY; ALTER TABLE "ordinary_native"."credits" FORCE ROW LEVEL SECURITY;
 CREATE POLICY impact_select ON "ordinary_native"."credits" FOR SELECT TO "runner_writer_7d861c151a75" USING (tenant_id=nullif(current_setting('impact.tenant',true),'') AND principal_id=nullif(current_setting('impact.principal',true),''));
 
 CREATE POLICY impact_update ON "ordinary_native"."credits" FOR UPDATE TO "runner_writer_7d861c151a75" USING (tenant_id=nullif(current_setting('impact.tenant',true),'') AND principal_id=nullif(current_setting('impact.principal',true),'')) WITH CHECK (tenant_id=nullif(current_setting('impact.tenant',true),'') AND principal_id=nullif(current_setting('impact.principal',true),''));
COMMIT;