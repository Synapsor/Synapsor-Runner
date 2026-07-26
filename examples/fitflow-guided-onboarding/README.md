# FitFlow Guided Onboarding Fixture

FitFlow is a synthetic multi-tenant fitness application used to verify the
Runner 1.6.4 first-time developer journey.

Its live PostgreSQL schema contains 41 relations: six seeded core relations,
34 realistic surrounding application subsystems, and one readiness marker.
The broader catalog proves that review by exception can narrow a real
application-sized schema to a small active agent pack without blind bulk
approval.

The fixture deliberately separates two reviewed authority packs:

- `organization_analytics`: organization-scoped, aggregate-only analysis over
  check-ins and locations;
- `trainer_members`: exact member reads and proposal-first member updates,
  restricted to the assigned trainer.

The source includes planted fields that must never become visible by default:
`payment_method`, `home_address`, and `medical_waiver_notes`.

The PostgreSQL fixture provides separate roles:

- `fitflow_analytics_reader`: read-only, organization-scoped analytics;
- `fitflow_trainer_reader`: read-only, organization and trainer scoped;
- `fitflow_writer`: guarded member updates under the same trusted scope;
- `fitflow_setup`: development/staging receipt-table setup only.

Start the database:

```bash
docker compose up -d --wait postgres
```

Use the organization analytics role for the first onboarding journey:

```bash
export DATABASE_URL='postgresql://fitflow_analytics_reader:fitflow_analytics_reader_password@127.0.0.1:55463/fitflow'
export SYNAPSOR_TENANT_ID='org-fitflow'
npx -y @synapsor/runner start --from-env DATABASE_URL
```

Use only synthetic data. The fixture is not a production deployment template.
