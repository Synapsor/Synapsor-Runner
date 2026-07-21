---
name: synapsor-safe-action
description: Draft or repair a disabled Synapsor Safe Action when a developer asks to make one application data change safe for an AI agent.
---

# Synapsor Safe Action

Use `/synapsor-protect` for the guided workflow. After Runner scaffolds an
action, read `synapsor/SAFE_ACTION_AGENT.md`; that generated project file is the
canonical, host-neutral instruction source shared with Codex and Claude Code.

The skill may inspect project structure, edit the requested TypeScript action,
and run deterministic validation. It has no activation, approval, apply,
commit, revert, credential, or trusted tenant/principal authority. Leave all
such decisions to the secured Runner Workbench and operator surfaces.
