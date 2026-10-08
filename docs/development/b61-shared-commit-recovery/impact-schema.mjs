/** Fresh declared structural clones. No historical SQL, seeds or credentials
 * are executed. The Luna version triggers and FK/effect column types retain
 * the reviewed actual recipe; membership policies are newly scoped fixtures. */
export function schemaSql(family,facts) {
 if(family==='ordinary_update')return `CREATE SCHEMA ordinary_native;
 CREATE TABLE ordinary_native.credits(id text PRIMARY KEY,tenant_id text NOT NULL,principal_id text NOT NULL,amount_cents integer NOT NULL,version integer NOT NULL);
 INSERT INTO ordinary_native.credits VALUES ('credit_impact','${facts.tenant}','${facts.principal}',1000,7),('sibling','${facts.tenant}','${facts.principal}',1100,3),('foreign','other_tenant','other_principal',1200,2);
 CREATE TABLE ordinary_native.unrelated(sentinel_id text PRIMARY KEY,value text NOT NULL);
 INSERT INTO ordinary_native.unrelated VALUES ('preserve_me','original value');`;
 if(family==='anchored_insert')return `CREATE SCHEMA enquiry_native;
 CREATE TYPE enquiry_native.customer_status AS ENUM ('active','inactive');
 CREATE TYPE enquiry_native.enquiry_status AS ENUM ('queued','closed');
 CREATE TABLE enquiry_native.customers(customer_id varchar(64) COLLATE "C" PRIMARY KEY,tenant_id varchar(64) COLLATE "C" NOT NULL,display_label varchar(64) NOT NULL,status enquiry_native.customer_status NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>=1),UNIQUE(tenant_id,customer_id));
 CREATE TABLE enquiry_native.enquiries(enquiry_id varchar(128) COLLATE "C" PRIMARY KEY,tenant_id varchar(64) COLLATE "C" NOT NULL,customer_id varchar(64) COLLATE "C" NOT NULL,external_ref varchar(64) COLLATE "C" NOT NULL CHECK(char_length(external_ref) BETWEEN 1 AND 64),message varchar(160) COLLATE "C" NOT NULL CHECK(char_length(message) BETWEEN 1 AND 160),status enquiry_native.enquiry_status NOT NULL DEFAULT 'queued',created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),UNIQUE(tenant_id,customer_id,external_ref),FOREIGN KEY(tenant_id,customer_id) REFERENCES enquiry_native.customers(tenant_id,customer_id) NOT DEFERRABLE);
 CREATE TABLE enquiry_native.enquiry_audit(enquiry_id varchar(128) COLLATE "C" PRIMARY KEY,tenant_id varchar(64) COLLATE "C" NOT NULL,customer_id varchar(64) COLLATE "C" NOT NULL,external_ref varchar(64) COLLATE "C" NOT NULL,message varchar(160) COLLATE "C" NOT NULL,observed_at timestamptz NOT NULL DEFAULT transaction_timestamp());
 CREATE FUNCTION enquiry_native.audit_enquiry() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$ BEGIN INSERT INTO enquiry_native.enquiry_audit(enquiry_id,tenant_id,customer_id,external_ref,message) VALUES(NEW.enquiry_id,NEW.tenant_id,NEW.customer_id,NEW.external_ref,NEW.message); RETURN NEW; END $body$;
 REVOKE ALL ON FUNCTION enquiry_native.audit_enquiry() FROM PUBLIC;
 CREATE TRIGGER append_enquiry_audit AFTER INSERT ON enquiry_native.enquiries FOR EACH ROW EXECUTE FUNCTION enquiry_native.audit_enquiry();
 INSERT INTO enquiry_native.customers(customer_id,tenant_id,display_label,status,version) VALUES ('${facts.principal}','${facts.tenant}','New Impact Customer','active',7),('other_customer','${facts.tenant}','Other Customer','active',3),('foreign_customer','other_tenant','Foreign Customer','active',4);
 CREATE TABLE enquiry_native.unrelated(sentinel_id text PRIMARY KEY,value text NOT NULL);
 INSERT INTO enquiry_native.unrelated VALUES ('preserve_me','original value');`;
 if(family!=='luna_atomic')throw new Error('Unknown fresh fixture family');
 return `CREATE SCHEMA telecom;
 CREATE TYPE telecom.plan_code AS ENUM('family_premium','starter','unlimited','unlimited_plus');
 CREATE TYPE telecom.plan_offer_status AS ENUM('accepted','active','withdrawn');
 CREATE TABLE telecom.accounts(account_id uuid PRIMARY KEY);
 CREATE TABLE telecom.impact_memberships(account_id uuid NOT NULL REFERENCES telecom.accounts,principal_id uuid NOT NULL,can_manage boolean NOT NULL,PRIMARY KEY(account_id,principal_id));
 CREATE TABLE telecom.subscriptions(subscription_id uuid PRIMARY KEY,account_id uuid NOT NULL UNIQUE REFERENCES telecom.accounts,plan_code telecom.plan_code NOT NULL,plan_display_name text NOT NULL,base_monthly_cents integer NOT NULL CHECK(base_monthly_cents>=0),included_lines smallint NOT NULL CHECK(included_lines>=1),data_policy text NOT NULL,international_day_pass boolean NOT NULL DEFAULT false,effective_from date NOT NULL,contract_end_date date,updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,UNIQUE(account_id,subscription_id));
 CREATE TABLE telecom.plan_change_offers(plan_offer_id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES telecom.accounts,subscription_id uuid NOT NULL,source_plan_code telecom.plan_code NOT NULL,target_plan_code telecom.plan_code NOT NULL,target_plan_display_name text NOT NULL,target_base_monthly_cents integer NOT NULL CHECK(target_base_monthly_cents BETWEEN 1000 AND 50000),target_included_lines smallint NOT NULL CHECK(target_included_lines>=1),target_data_policy text NOT NULL,target_international_day_pass boolean NOT NULL,target_effective_from date NOT NULL,status telecom.plan_offer_status NOT NULL DEFAULT 'active',auto_approval_eligible boolean NOT NULL DEFAULT false,customer_explanation text NOT NULL CHECK(length(customer_explanation) BETWEEN 1 AND 500),valid_from timestamptz NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,UNIQUE(account_id,plan_offer_id),UNIQUE(account_id,subscription_id,target_plan_code),FOREIGN KEY(account_id,subscription_id) REFERENCES telecom.subscriptions(account_id,subscription_id),CHECK(source_plan_code<>target_plan_code),CHECK(expires_at>valid_from));
 CREATE FUNCTION telecom.luna_demo_advance_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.version:=OLD.version+1; RETURN NEW; END $$;
 CREATE TRIGGER luna_demo_subscriptions_version BEFORE UPDATE ON telecom.subscriptions FOR EACH ROW EXECUTE FUNCTION telecom.luna_demo_advance_version();
 CREATE TRIGGER luna_demo_plan_change_offers_version BEFORE UPDATE ON telecom.plan_change_offers FOR EACH ROW EXECUTE FUNCTION telecom.luna_demo_advance_version();
 INSERT INTO telecom.accounts VALUES('${facts.tenant}'),('e1111111-1111-4111-8111-111111111111');
 INSERT INTO telecom.impact_memberships VALUES('${facts.tenant}','${facts.principal}',true);
 INSERT INTO telecom.subscriptions(subscription_id,account_id,plan_code,plan_display_name,base_monthly_cents,included_lines,data_policy,effective_from,version) VALUES('${facts.subscription}','${facts.tenant}','starter','Fictional Starter',2700,1,'fictional starter data','2026-01-01',7),('e3333333-3333-4333-8333-333333333333','e1111111-1111-4111-8111-111111111111','starter','Foreign Starter',2600,1,'foreign data','2026-01-01',2);
 INSERT INTO telecom.plan_change_offers(plan_offer_id,account_id,subscription_id,source_plan_code,target_plan_code,target_plan_display_name,target_base_monthly_cents,target_included_lines,target_data_policy,target_international_day_pass,target_effective_from,customer_explanation,valid_from,expires_at,version) VALUES('${facts.offer}','${facts.tenant}','${facts.subscription}','starter','unlimited_plus','Fictional Impact Plus',5300,2,'fictional unlimited data',true,'2026-10-08','Declared new synthetic impact offer','2026-01-01','2099-01-01',4);
 CREATE TABLE telecom.unrelated(sentinel_id text PRIMARY KEY,value text NOT NULL);
 INSERT INTO telecom.unrelated VALUES ('preserve_me','original value');`;
}
export function policySql(role,family,facts,relations) {
 const tenant=family==='luna_atomic'?'account_id':'tenant_id';
 const principal=family==='anchored_insert'?'customer_id':'principal_id';
 const match=family==='luna_atomic'?`${tenant}=nullif(current_setting('impact.tenant',true),'')::uuid AND nullif(current_setting('impact.principal',true),'')::uuid='${facts.principal}'::uuid`
  :`${tenant}=nullif(current_setting('impact.tenant',true),'') AND ${principal}=nullif(current_setting('impact.principal',true),'')`;
 return `BEGIN; ALTER ROLE "${role}" LOGIN; ALTER ROLE "${role}" SET impact.tenant='${facts.tenant}'; ALTER ROLE "${role}" SET impact.principal='${facts.principal}';\n`+
 relations.map(r=>`ALTER TABLE "${r.schema}"."${r.table}" ENABLE ROW LEVEL SECURITY; ALTER TABLE "${r.schema}"."${r.table}" FORCE ROW LEVEL SECURITY;
 CREATE POLICY impact_select ON "${r.schema}"."${r.table}" FOR SELECT TO "${role}" USING (${match});
 ${r.privileges.includes('insert')?`CREATE POLICY impact_insert ON "${r.schema}"."${r.table}" FOR INSERT TO "${role}" WITH CHECK (${match});`:''}
 ${r.privileges.includes('update')?`CREATE POLICY impact_update ON "${r.schema}"."${r.table}" FOR UPDATE TO "${role}" USING (${match}) WITH CHECK (${match});`:''}`).join('\n')+'\nCOMMIT;';
}
