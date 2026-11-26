# Architecture: AI lead assistant

How the assistant is built, what exists today and what is planned. The task is in [TASK.md](TASK.md), the step-by-step plan in [PLAN.md](PLAN.md). Keep this file in step with the code: every change that adds, moves or changes a component updates it in the same commit.

Status legend: **Built** (in the code and tested), **Planned** (agreed direction, not built yet).

## The flow

```
Sara clicks "Analyze"  (later also: a WhatsApp burst goes quiet for 5 s)
        │
        ▼
API: load lead + messages, scoped to Sara's agency (404 otherwise)          Built
        │
        ▼
Agent loop (Claude via Vercel AI SDK, at most 8 steps)                       Built
   reads the conversation as untrusted data
   calls tools ──► search_listings ──► PropertiesService.search (agency + available fixed in code)
               └─► get_listing     ──► Property by id or code, agency fixed in code
   every call goes into the trace
        │
        ▼
JSON answer, checked by a zod schema                                          Built
        │
        ▼
Code checks every recommendation (seen in this run, same agency,              Built
available now, no blocking data warning, fits the extracted requirements)
        │
        ▼
Code computes the due date from the timing intent, in the agent's timezone    Built
        │
        ▼
Save the run (assistant_runs, assistant_actions); nothing else is written     Built
        │
        ▼
Web panel / mobile card show it; Approve creates the task once, Reject saves nothing   Built
```

## Components

### Built

| File | What it owns |
| --- | --- |
| [api/src/assistant/listing-quality.ts](api/src/assistant/listing-quality.ts) | Gross yield (`annualRentAed / priceAed`), price per sqft, and data warnings: `price_implausible` (outside 300 to 15,000 AED per sqft, e.g. MBR-1023 at AED 21,500), `duplicate_listing` (same area, building, type, bedrooms, size and price as an earlier listing, e.g. MBR-1024 copies MBR-1001), `rent_missing` (not blocking), `yield_implausible` (above 20%). Pure functions, unit tested. |
| [api/src/assistant/tools.ts](api/src/assistant/tools.ts) | The two read-only tools and the trace. `search_listings`: optional area (an enum of the agency's real areas, loaded at run start), type, bedroom and price ranges; agency id and `status: available` are fixed in code. `get_listing`: by id or listing code, any status, description wrapped in `<listing_description>` as untrusted. A tool error is recorded and aborts the run. |
| [api/src/assistant/agent.ts](api/src/assistant/agent.ts) | System prompt, conversation formatting (`<lead_message>` tags, `<`/`>` neutralised, newest messages marked `new="true"`), the `generateText` call, the output schema, the recommendation check (`whyNotRecommendable`), and cost from token usage. Returns `ok: true` with the answer or `ok: false` with an error, never a silent empty result. |
| [api/src/assistant/smoke.ts](api/src/assistant/smoke.ts) | Runs the agent on one seeded lead against the real model and prints the result and trace. Developer tool, not part of the API. |
| [api/src/entities/assistant-run.entity.ts](api/src/entities/assistant-run.entity.ts) | `assistant_runs`: one row per run (lead, agency, analysed message and message ids, trigger, status, error, requirements, recommendations, summary, price checks, trace, usage, cost, model). JSON columns for what is read and written whole. A partial unique index `(lead_id) WHERE status = 'running'` lets the database refuse a second running run for a lead, even when two start at once (idea taken from qm's run store). |
| [api/src/entities/assistant-action.entity.ts](api/src/entities/assistant-action.entity.ts) | `assistant_actions`: one row per proposed action (type, status, payload, created task). Its status changes on its own row, so approving is one conditional update. |
| [api/src/assistant/due-date.ts](api/src/assistant/due-date.ts) | Timing intent + message `sentAt` + agent timezone to `dueAt` (ISO with offset, 10:00 local by default) or `needsClarification`. Calendar arithmetic in UTC on plain dates, so the server's own timezone never matters. "After the weekend" is the next Monday (UAE weekend Saturday and Sunday); a named weekday is the next one after the message. |
| [api/src/assistant/assistant.service.ts](api/src/assistant/assistant.service.ts), [assistant.controller.ts](api/src/assistant/assistant.controller.ts), [assistant.dto.ts](api/src/assistant/assistant.dto.ts) | The endpoints of TASK.md's contract. A run is inserted as `running` first (a unique-index violation is the `409`), then the agent runs, then the row becomes `completed` or `failed`. The conversation the agent reads stops at the analysed message. Approve runs `UPDATE ... WHERE status = 'pending_approval'` and creates the task in the same transaction; whoever loses the race, or repeats, gets the same task. The model is injected (`ASSISTANT_LANGUAGE_MODEL`) so tests use a scripted stand-in. |
| Background runs (stretch 1, pulled forward) | `POST ...runs?async=true` answers 202 once the run row exists; the agent continues in a forked entity manager and saves the trace after every tool call (`onTrace` in tools.ts), so `GET` the run shows progress. At startup, `onApplicationBootstrap` ends any run still `running` as failed ("The API restarted before this run finished"). Without `async=true`, POST waits and answers 201 as the contract says. |
| [web/src/components/AssistantPanel.tsx](web/src/components/AssistantPanel.tsx) | Loads the latest run, Analyze button, requirements, ranked listings with price and yield, summary, price checks, proposed actions with Approve and Reject, polling of a `running` run, plain messages for 409, 422, 429 and failed runs. Reloads tasks and lead after a decision. |
| [mobile/src/components/AssistantPanel.tsx](mobile/src/components/AssistantPanel.tsx) | The same result in a compact card, with Refresh, Run analysis, Approve and Reject. |

### Planned

| Step | Component | Direction |
| --- | --- | --- |
| 4 | Eval suite (`pnpm -C api eval`) | At least 8 cases with plain assertions on facts and side effects, trace saved per case, pass/fail report. |
| 6 | WhatsApp auto-runs | Debounce of 5 s per lead after the last webhook message; dedupe by provider `messageId`; one run per lead at a time (`409`); the run is listed as `running` from its start. Design to be agreed. |
| 7 | Price check | Plain code over recorded sales (same area, type, bedrooms, last 365 days before the message), median AED per sqft, bad sales filtered. Design to be agreed. |
| 8 | Agent suggestion | Plain code: same agency, not on leave, covers a requested area, speaks the language (Arabic letters in the latest message means Arabic), fewest open leads, then name. Design to be agreed. |
| 9 | Re-check on approve | Warnings for listings no longer available; `409` for an agent on leave or a lead assigned since. |
| 10 | Budget | Reserve USD 0.50 atomically before the first model call, settle to the real cost after. `429` when it does not fit. |

## Security

1. **Agency scoping.** The agency id comes from the login token and is closed over by the tools; it is not a tool argument, so a prompt cannot change it. Every query filters by it.
2. **Validated tool arguments.** Each tool has a zod schema (area enum, type enum, integer ranges, listing code pattern). Invalid arguments are rejected before any query; queries go through the existing services, which use parameterised SQL and escape LIKE patterns.
3. **Read-only tools.** No tool writes. The only write is Approve, a separate endpoint called by Sara.
4. **Untrusted text.** Lead messages and listing descriptions are wrapped in tags and the prompt says they are data, never instructions. Angle brackets inside them are replaced so they cannot close the tags.
5. **Output check in code.** A recommendation survives only if a tool showed it in this run, it belongs to the agency, it is `available` when re-read from the database, it has no blocking data warning and it fits the extracted requirements.

## Model and cost

- Model `claude-opus-5-5` through `@ai-sdk/anthropic` (override with `ASSISTANT_MODEL`). Effort `medium`. No `temperature` and no forced tool choice: current models reject both.
- Measured on seeded leads: about 10 to 18 s and USD 0.06 to 0.07 per run, about 10k input and 1.5k output tokens.
- Prompt caching: not enabled yet. The stable prefix (system prompt and tools) is below the size where caching pays off; revisit if the prompt grows.

## Known limits

- The restart sweep assumes one API instance: a second instance starting would end the first one's running runs. Several instances would need a lease per run with an expiry, as qm's run store has.

- A model call aborted by a tool failure does not report its token usage, so that run's cost is recorded as 0.
- `bedrooms` is a single number, as in the API contract. "Studio or 1-bed" is kept as a preference, and the search uses a 0 to 1 range.
