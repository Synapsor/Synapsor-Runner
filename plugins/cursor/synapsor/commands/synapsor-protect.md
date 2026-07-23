---
name: synapsor-protect
description: Draft and validate one disabled Synapsor Safe Action for an existing application.
---

# Protect one application data action

Turn the developer's requested business action into one disabled, deterministic
Synapsor Safe Action. This command drafts authority for human review; it never
activates an action or approves, applies, commits, or reverts source data.

1. Ask for the action name and one-sentence intended business effect if they are
   not already explicit. Work on one action only.
2. Confirm that `synapsor.runner.json` exists. If it does not, stop and direct
   the developer to the Runner own-database onboarding. Do not invent source,
   tenant, principal, credential, or writeback authority.
3. Inspect project schema/ORM/OpenAPI/test files and the reviewed Runner config.
   Never print environment-variable values, connect to an unapproved database,
   execute project code for discovery, or treat names as security authority.
4. Run the pinned Runner scaffold with a shell-safe action identifier and the
   developer's exact intent:

   `npx -y -p @synapsor/runner@1.6.1 synapsor-runner start --action <action_name> --description "<reviewed intent>"`

5. Read `synapsor/SAFE_ACTION_AGENT.md` and follow it as the canonical safety
   instruction source. Edit only the generated file under `synapsor/actions/`.
   Keep the action concise and preserve every unresolved authority question
   until the developer supplies a reviewed answer.
6. Run the project formatter for the action file, then run:

   `npx -y -p @synapsor/runner@1.6.1 synapsor-runner action validate <generated-action.ts> --json`

7. Fix deterministic diagnostics without weakening tenant/principal scope,
   visibility, bounds, conflict handling, approval, or executor authority.
8. Report the disabled draft digest, exact generated tests, pending live tests,
   and unresolved authority. Do not claim the action is active.
9. Tell the developer to open the secured localhost Workbench personally, run
   the non-mutating staging preview, review the exact Data PR and digest, and
   activate it there. There is intentionally no `action activate` CLI or MCP
   tool.

Never modify `.synapsor/active`, the active contract reference, Cursor MCP
configuration, runtime credentials, approval identity, or source data. Never
add raw SQL, generic database tools, model-visible approval/apply tools, or a
command that bypasses the Workbench confirmation.
