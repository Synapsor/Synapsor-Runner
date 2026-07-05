---
name: MCP audit report
about: Share a redacted MCP database audit finding
title: "[MCP audit]: "
labels: mcp-audit
assignees: ""
---

## Runner and environment

- Synapsor Runner version:
- Node version:
- OS:

## Command run

```bash
synapsor-runner audit ...
```

## Redacted MCP tool manifest

Paste the relevant tool names, descriptions, and input/output schema shape.
Remove database URLs, passwords, API keys, bearer tokens, private keys, cookies,
customer data, and any values that could grant access to a system.

```json
{}
```

## Expected risk

What risk did you expect the audit to flag or ignore?

## Actual risk

What did the audit report?

## Credential exposure check

Did the command output expose database credentials, bearer tokens, private keys,
or other secrets?

- [ ] No
- [ ] Yes, details redacted above

