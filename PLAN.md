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

Agreed 15:20. Two ideas taken from qm's run store: proposed actions in their own table (status changes on its own row, so approve is one conditional update), and a partial unique index so a lead never has two `running` runs (needed by part 6).

- [x] Entities + migration: `assistant_runs` (lead, agency, message ids, trigger, status, error, requirements, recommendations, summary, price checks, trace, usage, cost) and `assistant_actions` (run, type, status, payload, task id). Partial unique index `assistant_runs(lead_id) WHERE status = 'running'` (written by hand in the migration).
- [x] `due-date.ts`: timing intent + message `sentAt` + timezone to `dueAt` (default 10:00 local) or `needsClarification`. UAE weekend Saturday and Sunday. 10 unit tests, passing under `TZ=UTC` and `TZ=America/Los_Angeles`.
- [x] `AssistantModule`: `POST /leads/:leadId/assistant/runs` (sync, 201), `GET` list (newest first) and one, `approve`, `reject`. 404 for another agency, 404 unknown `messageId`, 400 malformed, 422 no inbound message.
- [x] Approve: `UPDATE ... WHERE status = 'pending_approval'` in a transaction with the task insert; only the winner creates the task; a repeat returns the same task; approve after reject and reject after approve are 409.
- [x] A failed run answers 201 with `status: "failed"`, `error` and empty fields.
- [x] 6 e2e tests (`test/assistant.e2e-spec.ts`) with a scripted stand-in model (`MockLanguageModelV3`, no API cost). Also checked live with curl on Karim: 201 in 16 s, two approves at the same moment and a third gave one task.
- Recommendations carry the listing facts the UI shows (reference, title, price, yield, status): extra fields, the contract allows them.

## Step 3: web panel, then mobile card

Built in parallel by a second agent (web/ and mobile/ only), against the API contract in TASK.md.

- [x] Web `AssistantPanel`: Analyze button (shows it takes about 15 s), latest run loaded on open, requirements, ranked listings with reasons and facts, summary, follow-up with due date in the agent's timezone, Approve and Reject; Tasks list reloads after Approve; clear messages for 409, 422, 429 and failed runs; polls a `running` run every 2 s.
- [x] Mobile `AssistantPanel`: latest run for the lead, Refresh, Run analysis, Approve and Reject (bonus done).
- [x] Component tests: web 4 new (8 total), mobile 1 new (3 total). Reviewed the web panel's effects and error paths by hand.
- [ ] Clicked through in the browser by the developer.

## Step 3b: live progress and a card UI

Agreed 15:30 after the developer's first click-through: the panel showed only "Analyzing..." for 15 s, and the result read as a wall of text. This is stretch item 1 (background runs) pulled forward, because part 6 needs the same background-run machinery.

- [x] API: `POST /leads/:leadId/assistant/runs?async=true` answers 202 with the run in `status: "running"`; without `async=true` nothing changes. The run row is created in the request (so 404, 422 and 409 stay immediate), the agent then runs in its own forked entity manager.
- [x] API: the run's `trace` is saved after every tool call (`onTrace`), so `GET` the run shows the tool calls so far. Live check: 202 at 0 s, `search_listings` visible at 3 s, completed at 16 s.
- [x] API: at startup (`onApplicationBootstrap`), runs left `running` by a restart or crash end `failed` with "The API restarted before this run finished." Assumes one API instance.
- [x] e2e tests: 202 then completed with its trace; 409 for a second run while one runs; the restart sweep. 8 assistant e2e tests, 29 e2e in total, all green.
- [x] Web (second agent): Analyze uses `async=true`, polls every second, shows live steps from the trace (`AssistantSteps.tsx`); result in cards (what the lead wants as tags, one card per listing with rank, price, yield badge and reason, summary card, follow-up card with due date and Approve/Reject, collapsible "How it decided"). 10 web tests and typecheck green; step labels checked against the API's trace fields.
- [ ] Developer click-through of the new panel.

## Step 4: evals

Agreed 15:50. Built by a second agent in `api/evals/` only, in parallel with step 3b.

Design: `pnpm -C api eval` runs Jest (ts-jest keeps Nest's decorator metadata) with `TZ=UTC`, like the graders. Global setup resets `challenge_test`, never the dev database. The real Nest app runs in-process with the **real model**, and every case goes through the real endpoints as Sara (or Omar), so it covers controller, service, agent, tools and Postgres. Cases run one at a time. Checks are plain assertions on facts (listings, fields, dates, counts, trace), never on wording, so verdicts repeat. A tool failure is faked in the eval only (`jest.spyOn` on `PropertiesService.prototype.search`). Every run also gets an API contract check. Output: pass/fail table, `api/evals/results/report.md`, one trace file per case in `api/evals/results/traces/`.

- [ ] `api/evals/harness.ts`: app boot, login, start run, DB snapshots, check collector, report writer
- [ ] `api/evals/assistant.eval.ts`: 15 cases (requirements x3, matching, no fit x2, dates x3, injection in message and in listing, tool failure, right tool, no action without approval, other agency)
- [ ] `api/evals/jest-evals.json` and `eval` script in `api/package.json`
- [ ] Full run, then a second run with the same verdicts
- [ ] One case per part 6 to 10, added as each part is built
- Found by the evals and fixed: run 1 (16:19) was 17/18. On "tomorrow" sent at 01:30 on a Saturday (Dubai), the model marked the timing unclear ("Saturday or Sunday?"), so `dueAt` was null and the case expected Sunday. Not a timezone bug: the date code was never reached. Fix: one prompt rule in `agent.ts`, "tomorrow" is always the calendar day after the message's date, even after midnight or on a weekend, and is never unclear. Run 2 (16:26): 18/18, USD 0.92, 155 s. The Jev branch needs the same line before its eval runs.

## Step 5 onward: parts 6 to 10

To be agreed, one at a time.
