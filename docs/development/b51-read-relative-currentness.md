# Read acceptance validation clock

The scripted installed Luna flow on `067e4ba8` stopped at
`READ_WORKLOAD_ASSISTANCE_CHECKPOINT_STALE` after a valid Read reply and its
supported same-job recovery. Both replies were handled; nothing was activated.
An offline replay of the producer inputs isolated the mismatch to the normalized
digest and start/end of a rolling 30-day plan. The host's second analysis used a
later clock while requiring full equality with the producer analysis.

Capture one host-owned clock when the producer analyzes a submitted workload.
Use it in every validation pass, and carry it transiently to the checkpoint host
for its exact reanalysis. Keep the complete analysis equality check, current
candidate/Source/permission checks, native Resume CAS and default-No decisions.
The clock is not a tool argument, model claim, persisted format or authority.
Runtime requests continue resolving relative windows at their execution clock.
Custom test generators without a clock retain the existing fresh validation;
they do not receive an inferred anchor or relaxed equality comparison.

The regression advances the clock between native producer and host validation;
before the change it refuses an otherwise valid mapping at the exact observed
acceptance guard. Independent variants cover a different temporal plan and
preserved refusal of changed analysis/candidate inputs.
