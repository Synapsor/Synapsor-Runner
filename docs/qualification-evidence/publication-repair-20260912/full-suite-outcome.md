# Full stable suite result

The sole stable full-suite run on 3be534f completed at 2026-09-13T01:06:26Z
with exit 1: 291 files passed, 4 failed, 21 skipped; 6,097 tests passed,
21 failed, 461 skipped. Full log, JSON, exact source manifest and exit status
are retained beside this report. No second full suite is planned.

Seventeen failures use heldExecutionFixture without a stored Action revision.
Two mcp-runtime-execution-config tests and one semantic-action-delegation test
have the same unbacked mocked-Action prerequisite. The new guard correctly
refuses those missing current revisions. Their original source is preserved.
The test-only correction imports exact encoded Action records through their
existing migration setup. The held execution fixture additionally uses real
reviewed Read and Action loading/publication. Delegation composition fixtures
retain their existing mocks, tied to the actual imported revision identities;
they are implementation fixtures, not installed public-path qualification.

The remaining model-output-config failure expected mode 0640, but creation under
required umask 0077 made the initial mode 0600. Establishing and asserting 0640
with chmod before testing preservation corrects setup, not product permissions.
All original assertions remain. Subsequent focused results are separate from
this failed full suite; none can retroactively turn this result into a pass.

Required publication tests and corrected concurrent-migration tests passed in
the full run. Stage A is not passed; Stage B remains NOT STARTED.
