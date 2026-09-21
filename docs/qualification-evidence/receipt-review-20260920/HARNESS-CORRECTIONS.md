# Retained setup/test corrections

- focused-association-1: two test setup errors (unknown-source variation did not match the actual underscore/space spelling; local OpenRouter test model lacked publisher prefix). Original2fail/59pass retained; fixed test inputs only. focused-association-2 passed121/2opt-in skips.
- types-focused: test assertion needed non-null indexing; fixed types only, no assertion weakened. Later types-stable passed.
- First development program comparator omitted new dev-A from its owned-root allowlist. Capture succeeded; read-only comparison initially refused. Added dev-A to the task-only list and reran; source/control unchanged.
- First DEV archival command found no new owned-final-states parent and exited before any archive/stop. Corrected helper to create its parent beneath the verified task root; no previous state was replaced. Archives created before stopping only labelled DEV containers.

These are setup/measurement issues, not product or public-review failures. No provider retry, payload replacement, policy change or budget reset resulted.
