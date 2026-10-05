# Reader currentness during saved business review

The independent P3-N3 test changed only the owned PostgreSQL reader's UPDATE
grant at the public default-No “Run a new bounded model review?” screen. Its
role fingerprint changed while its schema fingerprint stayed equal. Runner
still invoked the model decoder once. The inert callback prevented HTTP and
provider calls; no source rows or authority changed. This is a currentness
failure, not a completed review or observed private row-value disclosure.

Two added public controller regressions reproduce the consent-wait gap for
same-principal UPDATE posture and schema drift. Before the repair both fail:
the decoder count advances from 12 to 13. Their oracles require refusal before
another decoder call or coverage episode allocation, exact Source and disabled
authority preservation, and no activation. These are informed regressions;
the Tester separately sealed an undisclosed variant before the repair.

Both native guided and saved Review callers now provide a fresh reader check
to the shared prepared-review path. It compares engine, schema fingerprint and
role fingerprint with the captured review inspection. It never replaces the
captured evidence with changed metadata or writer-enriched inspection. Checks
run after human waits, before each initial or structural-correction submission,
after the provider returns, and before final result/ownership persistence,
including cached report reuse and Back from ownership. A mismatch leaves the
review pending and preserves earlier attempts.

External metadata reads stay outside project authority mutation locks. The
existing Source, resume, selected authority, retained-history and candidate
guards are rechecked under their ordinary permits for persistence. No new
execution, writeback, model-facing approval or database authority is introduced.
This is a fresh-inspection fence, not a database lock held across a remote
provider call. Provider errors and unknown/partial generations retain their
existing recovery rules.

Validation: the complete public review file passes 19 cases, including the two
consent regressions and role changes during a received response and client Back.
Seven complete prepared-review caller files pass 264 cases. All 283 pass with
zero failures or skips; typecheck, runner build and bundle freshness pass. The
independent real-grant recheck and new presealed variant remain pending on this
candidate. The final unfiltered suite has not run.
