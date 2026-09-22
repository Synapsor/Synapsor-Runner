# Read-only reviewer handoff

Run from the canonical repository. These commands only inspect archived/captured evidence. They do not restore a live queue, contact a provider or repeat an effect.

```bash
cd '/home/sandesh-tiwari/Desktop/C++/synapsor-runner'
node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/scoped-disclosure-repair-aa3a454-20260921/frozen/freeze-repair.mjs' --verify
python3 docs/qualification-evidence/case-b-numeric-completion-20260921/inspect-sealed-evidence.py \
  --start '/home/sandesh-tiwari/Desktop/Synapsor Tutorials/test-1.8.0/independent-phase-review-20260921/sealed-checkpoints/tester-B-final/native-counterexample-final/whole-project-home.tgz' \
  --final '/home/sandesh-tiwari/Desktop/Synapsor Tutorials/test-1.8.0/independent-phase-review-20260921/case-b-known-edit-continuation-20260921-attempt2/checkpoints/final-state-v1/whole-project-home.tgz' \
  --capture '/home/sandesh-tiwari/Desktop/Synapsor Tutorials/test-1.8.0/independent-phase-review-20260921/case-b-known-edit-continuation-20260921-attempt2/captures/mcp-protocol-live-001.jsonl' \
  --capture '/home/sandesh-tiwari/Desktop/Synapsor Tutorials/test-1.8.0/independent-phase-review-20260921/case-b-known-edit-continuation-20260921-attempt2/captures/mcp-protocol-live-002.jsonl' \
  --capture '/home/sandesh-tiwari/Desktop/Synapsor Tutorials/test-1.8.0/independent-phase-review-20260921/case-b-known-edit-continuation-20260921-attempt2/captures/mcp-protocol-live-003.jsonl'
```

Expected: all original complete rows retained across seven historical record tables; 2 describe_data, 2 explore_data, 3 describe_actions and 5 request_change calls; all twelve text/structured results equal. This does **not** establish a full per-replay control/config comparison. The source comparison and distinct receipt-hash recomputation records are indexed separately. The source hash uses ordinary JSON.stringify insertion order; the control receipt core uses canonical sorted JSON.

Main personally ran these read-only checks; tester personally ran the public operational sequence. The tester’s `harness/` and `captures/terminal-*.log` preserve exact public commands and observations. Do not blindly execute those scripts: their labelled containers have been removed, publication/effect are already consumed, and final Review has a funding prerequisite. The original reports are immutable; any new assessment needs a separate output.

`INDEPENDENT-REVIEW.json` identifies the sealed tester report/result/index and final manifest. `EVIDENCE-INDEX.json` seals this main report, script and selected raw readbacks. Hashes for the main index and delivery commit are in external `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/case-b-numeric-completion-ddae38b-20260921/DELIVERY.json`, written after commit to avoid a circular hash.

For another account, read `RESUME-HANDOFF.md` and the current external handoff first. Resolve actual Git HEAD, then inspect DELIVERY.json; do not resume from the historical zero counters in PLAN.md. No product code/build/suite changed in this assignment. All previous stable gates remain exact-build historical evidence, not personally rerun qualification.
