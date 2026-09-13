# Package report references

Offline attempt 1 stopped at verify-local-runner.sh, exit 1. The unchanged
package Markdown checker found four relative links from two packaged summary
documents to deliberately excluded qualification-evidence files. Those links
were added in closure commit 779b2dc after the preceding package qualification.

Preserve the exact failing log and prior summary bytes. The documentation-only
correction labels these as repository-only evidence paths, which remain exact
and available in the checkout. No report finding is removed, no evidence is
added to the public package, and no checker or package behavior is weakened.
This corrects the delivery format of earlier reports, not a new product feature.
Resume only the four remaining package checks in the second declared attempt;
the six completed checks keep their original exit statuses and are not repeated.
