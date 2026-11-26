# Architecture: AI lead assistant

How the assistant is built, what exists today and what is planned. The task is in [TASK.md](TASK.md), the step-by-step plan in [PLAN.md](PLAN.md). Keep this file in step with the code: every change that adds, moves or changes a component updates it in the same commit.

Status legend: **Built** (in the code and tested), **Planned** (agreed direction, not built yet).

## The flow

```
Sara clicks "Analyze"  (later also: a WhatsApp burst goes quiet for 5 s)
        │
        ▼
API: load lead + messages, scoped to Sara's agency (404 otherwise)          Planned (step 2)
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
Code computes the due date from the timing intent, in the agent's timezone    Planned (step 2)
        │
        ▼
Save the run (assistant_runs); nothing else is written                        Planned (step 2)
        │
        ▼
Web panel / mobile card show it; Approve creates the task once, Reject saves nothing   Planned (steps 2 and 3)
```

## Components

### Built

| File | What it owns |
| --- | --- |
| [api/src/assistant/listing-quality.ts](api/src/assistant/listing-quality.ts) | Gross yield (`annualRentAed / priceAed`), price per sqft, and data warnings: `price_implausible` (outside 300 to 15,000 AED per sqft, e.g. MBR-1023 at AED 21,500), `duplicate_listing` (same area, building, type, bedrooms, size and price as an earlier listing, e.g. MBR-1024 copies MBR-1001), `rent_missing` (not blocking), `yield_implausible` (above 20%). Pure functions, unit tested. |
| [api/src/assistant/tools.ts](api/src/assistant/tools.ts) | The two read-only tools and the trace. `search_listings`: optional area (an enum of the agency's real areas, loaded at run start), type, bedroom and price ranges; agency id and `status: available` are fixed in code. `get_listing`: by id or listing code, any status, description wrapped in `<listing_description>` as untrusted. A tool error is recorded and aborts the run. |
| [api/src/assistant/agent.ts](api/src/assistant/agent.ts) | System prompt, conversation formatting (`<lead_message>` tags, `<`/`>` neutralised, newest messages marked `new="true"`), the `generateText` call, the output schema, the recommendation check (`whyNotRecommendable`), and cost from token usage. Returns `ok: true` with the answer or `ok: false` with an error, never a silent empty result. |
| [api/src/assistant/smoke.ts](api/src/assistant/smoke.ts) | Runs the agent on one seeded lead against the real model and prints the result and trace. Developer tool, not part of the API. |

### Planned

| Step | Component | Direction |
| --- | --- | --- |
| 2 | `assistant_runs` table + migration | One row per run: status, trigger, analysed message ids, requirements, recommendations, summary, price checks, proposed actions (with their status and the created task id), trace, usage and cost, error. JSON columns for what is read and written whole. |
| 2 | Due-date logic | Pure function from the timing intent (`tomorrow`, `weekday`, `after_weekend`, ...) and the message's `sentAt` to `dueAt` in the agent's timezone, with `needsClarification` when it cannot be pinned down. UAE weekend is Saturday and Sunday. |
| 2 | `AssistantModule` (controller + service) | The endpoints in TASK.md's API contract. Approve is idempotent (stores the task id on the action); approve after reject and reject after approve are `409`. |
| 3 | Web `AssistantPanel` | Analyze button, what was understood, ranked listings with reasons, the proposed follow-up with Approve and Reject; the task list reloads after Approve. |
| 3 | Mobile `AssistantPanel` | Shows the latest run for the lead (read-only first). |
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

- A model call aborted by a tool failure does not report its token usage, so that run's cost is recorded as 0.
- `bedrooms` is a single number, as in the API contract. "Studio or 1-bed" is kept as a preference, and the search uses a 0 to 1 range.
