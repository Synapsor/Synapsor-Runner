# MCP Database Access Without Schema Exposure

An agent needs enough structure to ask a legal question, but it does not need
your full database catalog. Runner exposes a reviewed analytical and business
tool catalog instead of raw DDL, unrestricted schema inspection, or arbitrary
identifiers.

## What The Model Receives

- Reviewed resource and field aliases.
- The allowed operation for each field, such as grouping, filtering, counting,
  summing, or time bucketing.
- Reviewed many-to-one relationship aliases and result limits.
- Typed tool schemas for `app.describe_data`, `app.explore_data`, or activated
  named capabilities.

## What Stays Outside The Model

- Database URLs, passwords, grants, and connection tools.
- Kept-out fields, source DDL, unrelated tables, and arbitrary identifiers.
- Trusted tenant and principal values.
- Provider credentials, activation controls, approval, apply, and commit.
- Compiled SQL and SQL parameters.

A field reviewed as Runner-output-only can participate in approved aggregate
operations while its raw values remain absent from hosted-model requests.
Small-cohort suppression and response budgets still apply. A kept-out field is
not available for plans or output at all.

This is not literally zero schema information: the model must see the reviewed
semantic names and legal operations needed to form typed plans. The security
property is that it cannot enumerate or address the unrestricted database
schema.

Start the metadata-only draft and human review:

```bash
npx -y @synapsor/runner start
```

Read [Auto Boundary, Scoped Explore, And Protect](auto-boundary-and-scoped-explore.md)
and [Security Boundary](security-boundary.md) for the exact disclosure model.
