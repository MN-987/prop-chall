# Plan: AI lead assistant

Working plan for the 4-hour task in [TASK.md](TASK.md). Each step is agreed before it is built, and ticked when it is done and tested.

## Decisions agreed

| Topic | Decision |
| --- | --- |
| Order | Strict TASK.md order: core assistant (parts 1 to 5), evals, then parts 6, 7, 8, 9, 10. Last 20 minutes: NOTES.md, fresh `db:reset`, eval run, final commit. |
| Way of working | Claude writes the code one step at a time; each step's design is approved first, then its tasks go here, then it is built and tested before the commit. |
| AI library | Vercel AI SDK (`ai` + `@ai-sdk/anthropic`), model `claude-opus-5-5`. No `temperature` (rejected by current models); no forced tool choice (rejected); thinking is always on, depth set by `effort`. |
| Agent shape | The model calls our tools itself (agent loop, at most 8 steps), then returns one JSON answer checked by a zod schema. |
| Security | Agency id comes from the login token and is closed over by the tools, never a tool argument. Tools only read. Tool arguments are validated by zod before any query. Lead messages and listing descriptions are wrapped as untrusted data. Code re-checks every recommended listing (exists, same agency, `available`, data not broken) before saving. |
| Areas | At run start code loads the agency's distinct listing areas; the `area` tool argument is an enum of exactly those names. |
| Dates | The model only names the intent ("tomorrow", "after the weekend", unclear); code computes `dueAt` in the agent's timezone from the message's `sentAt`. |
| Failures | Any tool error or model error makes the run `failed`, never "nothing found". |

## Step 1: tools and agent loop

- [x] `api/src/assistant/listing-quality.ts`: gross yield, price per sqft, data warnings (implausible price per sqft, duplicate of an earlier listing, no rent figure). Unit tests.
- [x] `api/src/assistant/tools.ts`: `search_listings` (area enum, type, bedrooms and price ranges; agency and `available` fixed in code; reuses `PropertiesService.search`) and `get_listing` (by id or listing code, any status, description marked untrusted). Every call recorded in the trace with input, output or error, and duration.
- [x] `api/src/assistant/agent.ts`: system prompt, lead messages as untrusted data, `generateText` with the tools and a zod output schema, token usage returned. Code re-checks every recommendation (seen by a tool in this run, same agency, available now, fits the extracted requirements).
- [x] Smoke script `pnpm -C api exec tsx src/assistant/smoke.ts <lead name>`. Checked by hand: Karim (5 listings ranked by yield, MBR-1023 typo and MBR-1024 duplicate left out, "tomorrow"), Alex (injection ignored and reported, no JVC studio or 1-bed so nothing recommended), Hala (Arabic, MBR-1013 read by code). About 10 to 18 s and USD 0.06 to 0.07 per run.
- Found and fixed: the model added a "lake view" preference for Hala from the area name. The prompt now limits preferences to what the lead wrote.

## Step 2: run storage and endpoints

To be agreed.

## Step 3: web panel, then mobile card

To be agreed.

## Step 4: evals

To be agreed.

## Step 5 onward: parts 6 to 10

To be agreed, one at a time.
