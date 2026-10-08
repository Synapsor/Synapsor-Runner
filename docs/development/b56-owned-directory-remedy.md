# B56: actionable local runtime directory refusal

Base: `0ff5474f` (unofficial candidate4 preview). This change only adds an operator remedy to the existing group/other-writable directory error when `lstat` has proved a real, nonsymlink directory and a known current UID owns it. It does not reorder or relax checks, change permissions, create authority, or alter any file format. Unknown/different ownership and unsafe private identity files receive no directory chmod hint. Mode0755 remains accepted as before.

The suggested command uses `chmod 700 --` with the exact canonical directory as one POSIX single-quoted argument. It is advice, not an action Runner executes. The test parses that argument using a harmless shell argument printer; it never executes the remedy. Existing fixture-only mode setup is retained. This is not a recursive ownership/permissions fix or a policy/activation change.

Characterization `d952bdf7`: native types0; five new bounded controls4PASS/1FAIL, the sole expected failure is missing remediation text. Initial test-only optional-getuid typing failure is preserved. After-change `d0da8e33`: all26 permission tests PASS, native types0, all owned processes closed. `b56-owned-dir-remedy/DEV-RECORD.json` records exact commands and original output references. Main review remains pending.
