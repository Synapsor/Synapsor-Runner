# Changelog

## 0.1.0-beta.1 (prepared, not published)

- Introduces the separately installable `synapsor` Cloud CLI without adding
  database connectivity or MCP serving to the Cloud client.
- Adds secure browser/device login, profiles, human/service/Runner credential
  separation, project selection, entitlement status, scoped API-key and Runner
  token administration, and one-time mode-`0600` secret-file output.
- Adds canonical context, capability, workflow, and contract authoring plus
  validation, semantic diff, immutable push/version/activation/rollback, and
  source-bound credential-free Runner bundle download.
- Adds project-scoped proposal review, activity, metadata-only evidence,
  receipts, replay, and export commands over the same versioned APIs and policy
  checks used by the Cloud UI.
- Keeps `synapsor-runner cloud push` supported through the same typed client,
  canonical digest, idempotency, credential resolver, endpoint, and stable
  error contract as `synapsor contracts push`.
- Remains a design-partner beta. It does not claim enterprise GA, a managed
  Runner fleet, multi-region durability, SSO/SCIM completeness, or hosted
  customer database credentials.
