# Freeze preflight correction

First freeze stopped before creating installed/ because credential-free HOME
omitted the host's global Git ignore and exposed the existing untracked .claude/
directory. Host git status was clean. The directory is unrelated and outside the
runner package's explicit file list; no contents were read, changed or committed.
The first helper and complete error log are retained in the owned frozen/
freeze-attempt1 directory. The corrected helper accepts only empty status or
that exact single untracked directory and records it in the manifest. Every
tracked change and every other untracked path still stops the freeze. No product
source or permission check was modified. No earlier installation was replaced.
