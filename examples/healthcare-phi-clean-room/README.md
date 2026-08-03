# Harbor Health clean-room fixture

This synthetic Next.js + Prisma + PostgreSQL application models a multi-tenant
care-coordination service. Care managers use bounded operational analytics to
understand discharge outcomes without exposing patient identity, contact,
insurance, diagnosis, or clinical-note fields to an agent.

The fixture deliberately includes:

- tenant scope through `hospital_id`;
- principal scope through `care_manager_id`;
- PostgreSQL row-level security on every useful relation;
- reviewed many-to-one unit and discharge-reason relationships;
- PHI fields that Auto Boundary must keep out before source rows are read;
- another care manager and another hospital;
- small cohorts for suppression;
- a stored prompt-injection payload in a model-visible status label.

It is synthetic test data only. It is not medical guidance and contains no real
patient information.
