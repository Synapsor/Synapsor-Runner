# Lane C harness v5 — response privacy before delivery

This version supersedes proposed v4 only in the qualification harness. Frozen Runner f20, request encoding, provider settings, tasks and product limits are unchanged. Budget v3 and count v2 retain the owner136 contract in CONTRACT-v4.md; count v2 imports the v5 shared validators without changing its endpoint semantics.

Independent probe684 demonstrated that v4 forwarded an SSE chunk containing a dummy credential before inspecting the completed response. This is a preserved synthetic harness privacy failure, with zero real provider requests. It is not a Runner product result or a real credential exposure.

V5 buffers the bounded upstream response (existing 8 MiB ceiling), checks the complete body and forwarded headers for the configured credential/private-value denylist, and persists usage accounting before delivering client headers or bytes. A known private value stops both lanes, including when missing usage also requires an uncertain-cost hold. It returns a safe local refusal, withholds unsafe raw capture and identifiers, and preserves a redacted capture and response digest. Normal responses retain the exact status and body/SSE bytes; no model content is repaired or substituted. Delivery is delayed until the whole response is checked, within the unchanged request timeout. This is a finite known-value guard, not a universal semantic privacy proof.

Main executed 20 ledger/proxy and 10 count controls on v5, then eight focused response controls including missing-usage privacy stop. These are DERIVED local tests. Independent reprobe and actual installed-to-guard integration remain required before joint paid preflight. Previous v4 records, probe684 and source checkpoint138 are immutable historical evidence.
