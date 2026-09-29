# Stream completion and content refusal — 2026-09-29 UTC

The existing native adapters remain the protocol boundary. A terminal model refusal is not a successful tool result. A complete stream that reports its output limit must not be confused with a network interruption; a subsequent physical truncation still wins over a terminal-looking event. No retry allowance is obtained from content refusal.

Official OpenRouter [streaming documentation](https://openrouter.ai/docs/api_reference/streaming) describes Chat finish reasons, the final usage chunk and DONE frame. It also distinguishes mid-stream provider errors from successful output. The local repair drains bounded content-error responses rather than throwing before that evidence is read. No universal marker is imposed on other adapters.

Official OpenAI [streaming guidance](https://developers.openai.com/api/docs/guides/streaming-responses) and [deployment checklist](https://developers.openai.com/api/docs/guides/deployment-checklist) distinguish response.completed, response.failed and response.incomplete. The known terminal incomplete event is rejected as incomplete content; it never becomes an accepted partial tool call. A provider/transport failure without adequate completion evidence remains stopped.

Observed local controls are separate from documentation: tester source029 reproduced the clean Chat length refusal being recorded as C; Main019 retained four failing controls, and Main020 passed their corrected distinction plus affected normal-output tests. No provider inference or historical-cause inference follows from these synthetic fixtures.
