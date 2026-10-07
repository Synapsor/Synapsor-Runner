# Initial Read assistance checkpoint host

This slice removes the inline `persistReadAssistance` coordinator from `boundary-commands.ts`. The producer callback remains `persist(checkpoint, currentBoundary, accepted?)`. The host uses the caller's existing native mutation permit and rollback wrapper. It neither owns a new progress record nor resets producer limits.

Dispatch persists the actual checkpoint before I/O with acknowledgement disabled. Waiting and answered transitions retain exact question/completion/context association, including the existing reviewed relationship exception. An accepted mapping is re-analyzed against the current candidate; its immutable analysis is inert until the same Resume CAS commits the pointer. Confirmed naming testimony is indexed only after that accepted remap. Read-edit's earlier Source append remains separate.

The access adapter delegates native analysis storage, Source append, Resume save and currentness. Property presence distinguishes retaining a checkpoint from clearing it to `undefined`. Native save rejection/uncertainty still propagates through the existing rollback owner; this refactor adds no recovery authority.

Characterization uses existing producer checkpoint and genuine fresh-process Read-to-caller controls. New host controls cover pre-I/O failure, inert analysis after acknowledgement loss, exact candidate/Source drift and actual local transport completion identity. Synthetic catalog facts and mocked mutation ports are labelled in tests; the cold process controls retain their original public stage origin. Independent review and full-suite results belong in the compact external DEV record; this document does not claim installed or activation acceptance.
