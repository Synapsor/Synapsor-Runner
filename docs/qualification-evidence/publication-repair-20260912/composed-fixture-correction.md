# Composed runtime test prerequisites

The sole full suite exited 1, as preserved in full-suite-outcome.md. Twenty
failures reached automatic admission with no corresponding current stored
Action revision. Corrected fixtures retain the exact assertions and guard.

The held execution fixture now prepares a reviewed Read, migrates its exact
encoded initial Action and execution records using validated migration, loads
the real governed Action, and publishes the third outcome via draft and exact
activation confirmation. Existing selected-config, permission, stale and replay
assertions remain unchanged. The delegation composition fixtures retain their
existing mocked authority-loader abstraction, but import a real encoded Action
record and return that actual deployment/name/revision identity. These remain
implementation-only evidence. No approval record is seeded and no pointer is
rewritten outside repository migration/publication operations.

The permissions fixture explicitly establishes and checks 0640 before testing
its preservation. Creation alone obeyed the required 0077 umask and produced
0600; product permission behavior was not changed.

Attempt 01 exposed non-normalized legacy test authority objects. Attempt 02 used
the existing stored-authority parser and passed 56/58, including all 41 runtime,
4 delegation and 3 permissions cases. The remaining two MCP fixtures had empty
review records and failed strict integrity validation. Supplying complete exact
fixture reviews yielded attempt 03: all 10 MCP cases passed, exit 0. Earlier
failed attempts remain saved. Final types 08 exited 0 on the final source.
Types attempt 06 incorrectly invoked Corepack without its installed cache in the
private HOME; the unshared network prevented any registry connection. It is an
environment failure, not a type result. Direct installed tsc attempts 07/08 passed.

No second full suite was run. The failed full result is not replaced by these
focused passes. Product behavior remains b16f92a; this is a separate test change.
