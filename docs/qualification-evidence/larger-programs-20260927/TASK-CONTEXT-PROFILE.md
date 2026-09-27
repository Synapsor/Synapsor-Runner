# Task context measurement contract

This package measures product-controlled JSON after the provider adapter's last transformation. It does not rewrite a native client's history, reduce disclosure checks, infer model tokenization from bytes, or manage spending. The trusted authoring dependency can opt into `contextMeasurement` and reuse one `createTaskContextMeter()` across a journey. The observer is outside the request body. Existing callers without it keep their request and response behavior.

The meter returns numbers and fixed labels. It retains at most 4,096 SHA-256 unit identities by default (configurable 1–16,384); it stores neither source text nor responses. When identity tracking fills, new/repeated-unit measurements become unknown while byte/call counters continue. It never resets disclosure, correction or financial counters.

JSON is syntax-validated, then component measurements use slices of the original UTF-8 encoding. Legal Unicode escapes and whitespace remain distinct for byte identity. Re-serializing parsed values is insufficient for this contract. Invalid UTF-8 and duplicate keys in an object that must be partitioned refuse measurement with a fixed diagnostic; the meter neither rewrites nor interprets ambiguous input. Independent C01 exposed this distinction and its original failing evidence is retained.

| Field | Meaning and limits |
|---|---|
| `encoded_utf8_bytes` | Actual supplied final JSON encoding, including UTF-8 and escaping; not JavaScript string length. |
| `static_instruction_bytes` | Encoded `system`/`instructions` values and complete system/developer conversation units. |
| `schema_bytes` | Encoded `tools` value. |
| `conversation_bytes` | Encoded `messages`/`input` excluding those system/developer units; includes array delimiters. |
| `framing_and_other_bytes` | Exact remainder: field names, separators, remaining root values and any captured whitespace. The four partitions sum to the supplied encoding. |
| New/repeated conversation bytes | Byte-identical JSON-encoded non-system units seen by this meter, not semantic redundancy, relevance or provider cache hits. |
| Completed response bytes | Parsed completed JSON encoding. SSE framing and transport bytes require separate capture. Partial streamed output is not a completed response. |
| MCP text/structured rendering bytes | Each available representation, with a separate indication that at least one JSON text block equals structured content. No representation is discarded. |
| `provider_request_observations` | Prepared bodies observed, including pre-send failures. `actual_provider_sends` remains null: only the transport ledger/capture establishes sends. |
| `mcp_tool_calls` | Observed `tools/call` requests; different from provider sends and catalog declarations. |
| Usage/cost/time | Only explicitly supplied finite nonnegative API usage and measured elapsed time. Missing values remain unknown; zero remains zero. No local token or cost estimate is invented. |

The request observation occurs after `stream:true` is encoded and after the unchanged product body bound, before destination resolution/HTTP dispatch. A preparation observer failure or cancelled lifetime sends nothing. A response observer failure occurs after an already observed provider response and must not be treated as free or as permission to retry.

`task-context-transport.test.ts` exercises actual local Responses and OpenRouter encoders, normal SSE assembly, required inert tool handling, exact encoded sizes, supplied usage, observer refusal and cancellation. Replies are DERIVED/local; these tests establish neither remote schema admission nor real-model completion.

## Historical measurements

The original inert native growth capture consists of 16 existing encoded requests: peak **388,320 bytes**, sum **3,494,878 bytes**. Main passively replayed those exact bytes through this meter. The tester independently attributed growth to synthetic assistant narration and 15 actual `app.describe_actions` callbacks. This capture contains no source-row enumeration. Its synthetic token values are not real provider usage. No new model, MCP or SQL call was issued for this analysis.

Closed Lane A has 43 historical real request bodies: peak **85,137 bytes**, sum **2,733,934 bytes**. It is a separate eight-turn comparison, not another sample of the 388,320-byte capture. Cross-turn byte identity does not establish semantic relevance or cache savings. The original tester's component categories differ from this meter where it groups system/developer conversation units as instructions; raw totals agree.

Restricted exact input paths/hashes and numerical observations are in the raw `main-context/MAIN-PASSIVE-CONTEXT-PROFILE-002.json`, replayed after the C01 original-encoding repair. The earlier001 profile and its original component claims remain preserved; raw request totals agree. Full client JSONL transcripts were not loaded into a model. Historical captures remain immutable. Final installed measurements and real-model results are pending; these historical numbers are not predicted limits for Lane C.

An owned public-produced disabled50 program supplied a current whole-source coverage measurement. Its actual secure Responses encoder sent **465,272 UTF-8 bytes** to an isolated local capture boundary: instructions31,301, tools73,546, conversation360,210 and framing215. The source and all50 Actions remained in the prepared request. A labelled local HTTP400 stopped generation; it establishes no remote admission, review save or BUSINESS completion. Version001's missing logical-store prerequisite and002's pre-stream adapter measurement are separately preserved. The replayable namespace recipe and measurements are in `main-context/coverage-size-003.*` and `OWNED-COVERAGE-SIZE-003.json`. This finite sample fits the existing request/schema bounds; a different sealed program must be measured independently.

## Context preservation and acceptance

The full original source, early exceptions, applicable shared requirements, current operation, attributed decisions, unresolved duties and immediate correction parent remain authoritative inputs. A digest, routing summary or unit progress display cannot replace unknown-relevance source. Host-derived program progress may avoid repeating redundant machine metadata, but outside records remain host-owned and complete-program validation remains mandatory. Any reconstruction must be self-contained or use the exact saved canonical records through existing currentness/CAS checks.

Final acceptance must distinguish byte/profile validity, public program capability, complete coverage, provider admission and actual model workflow completion. The numerical hook alone proves none of the later layers. No product-controlled measurement claims to intercept or repair arbitrary external client history.
