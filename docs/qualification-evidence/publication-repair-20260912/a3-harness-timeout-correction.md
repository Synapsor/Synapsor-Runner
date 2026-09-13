# A3 source-hold measurement correction

Installed attempt 1 is preserved in its original owned collection directory and
E/installed/collection-attempt1. Both workers returned TRANSACTION_FAILED receipts,
with no source change (sum 60000 instead of expected 90000). The PostgreSQL log
identifies statement timeouts while locking portfolios, PID 1173 at 01:35:33.401Z
and PID 1177 at 01:35:41.813Z. This is concrete harness timing evidence: the new
measurement held the blocker until the second worker FINISHED, beyond the existing
three-second statement bound. The first query wait was observed at 01:35:30.422Z;
the second worker did not finish until 01:35:42.631Z. The initial annotation claiming
it completed while a successful first effect remained held is not a valid result.

Correct the launcher measurement to acknowledge the second PROCESS SPAWN and
release the owner immediately after a host snapshot (bounded 1500ms launch wait),
not after worker completion. Preserve every source-cap, receipt and row assertion,
request delivery, worker concurrency and database timeout. This demonstrates
process overlap and the first actual database wait; it does not imply overlapping
effect transactions. Record actual outcomes before claiming further ordering.

A fresh collection_02 owned copy and separate insurance_stagea_collection_02 DB
reuse the same 40-row fixture/schema/policy. No failed store or queue is reused;
normal requests and human reviews establish its history. No product code or
frozen installation is changed. The second existing A3 schedule slot is used.
