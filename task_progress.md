# Task progress

Every task from [TASK.md](TASK.md), in the order it must be built, with what is done. The design for each step is in [PLAN.md](PLAN.md).

**Legend:** `[x]` done and tested · `[~]` started, not finished · `[ ]` not started · `[-]` skipped on purpose (say why in NOTES.md)

**Now working on:** Step 1 done and checked, waiting for the OK to commit. Next: design of step 2 (run storage, endpoints, due dates)
**Time box:** started 13:45, ends 17:45 (Asia/Dubai, 2026-11-26). Last 20 minutes are for the wrap-up (section F).

---

## Required

### A. Core assistant (TASK.md parts 1 to 5)

**Part 1. Understands the message**

- [x] Zod schema for requirements: locations, bedrooms, budget, type, intent, preferences (`api/src/assistant/agent.ts`)
- [x] System prompt with rules for areas, budget ("around X"), intent
- [x] Checked with the real model on Karim's message (smoke script); also Alex and Hala (Arabic)
- [x] Fixed: model invented a "lake view" preference from the area name (Hala); prompt now limits preferences to what the lead wrote

**Part 2. Uses tools**

- [x] `search_listings`: agency and `available` fixed in code, area is an enum of the agency's areas (`api/src/assistant/tools.ts`)
- [x] `get_listing`: by id or code, any status, description wrapped as untrusted
- [x] Every tool call recorded in the trace (input, output or error, duration)
- [~] A failing tool stops the run (never "nothing found"): code written, not yet run with a failing tool (eval case pending)
- [x] Checked with the real model (smoke script): search_listings on Karim and Alex, get_listing on Hala's MBR-1013

**Part 3. Decides**

- [x] Gross yield, price per sqft, data warnings for typo prices, duplicates, unrealistic yields (`api/src/assistant/listing-quality.ts`, 6 unit tests)
- [x] Code re-checks every recommendation: seen by a tool, same agency, `available` now, fits the requirements
- [x] Ranking and reasons checked on a real run (Karim: MBR-1001, 1007, 1002, 1003 by yield, then 1022 with no rent; MBR-1023 typo and MBR-1024 duplicate left out and named in the summary)

**Part 4. Proposes an action (nothing saved until approved)**

- [x] Model returns the timing intent only ("tomorrow", "after_weekend", "unclear", ...)
- [ ] Code computes `dueAt` in the agent's timezone from the message's `sentAt`, with unit tests (incl. `TZ=UTC`)
- [ ] Unclear timing gives `dueAt: null` and a `needsClarification` reason
- [ ] Run storage: entity + migration (requirements, recommendations, summary, actions, trace, cost)
- [ ] `POST /leads/:leadId/assistant/runs` (optional `messageId`, default latest inbound)
- [ ] `GET /leads/:leadId/assistant/runs` (newest first)
- [ ] `GET /leads/:leadId/assistant/runs/:runId`
- [ ] `POST .../actions/:actionId/approve` creates the task, returns `{ action, task, warnings }`
- [ ] `POST .../actions/:actionId/reject` saves nothing, returns `{ action }`
- [ ] Error codes: other agency `404`, unknown `messageId` `404`, no inbound message `422`
- [ ] Approve twice gives the same task (one task); reject twice `200`; approve after reject or reject after approve `409`
- [ ] Failed run answers `201` with `status: "failed"`, `error`, and all fields empty
- [ ] e2e tests for the endpoints and error codes

**Part 5. Web and mobile**

- [ ] Web panel (`web/src/app/leads/[id]/page.tsx`): start a run, show requirements, recommendations, summary
- [ ] Web panel: proposed follow-up with Approve and Reject; approved task shows in the Tasks list
- [ ] Mobile card (`mobile/src/app/leads/[id].tsx`): shows the latest run for the lead
- [ ] Mobile Approve and Reject (bonus)

### B. Rules the assistant must follow (each needs an eval or a test)

- [~] Lead messages and listing text are data, not instructions (prompt and wrapping done; eval pending)
- [~] Only the agent's own agency (tools close over `agencyId`; e2e test pending)
- [~] Only real, available listings; nothing fits means nothing recommended (code re-check done; eval pending)

- [ ] No side effects without approval (running creates no task, changes no lead, message or property)
- [ ] Dates in the agent's timezone, UAE weekend is Saturday and Sunday

- [~] Failures are reported as failed, not "nothing found" (code done; eval pending)

### C. Evals (required)

- [ ] One command runs them (e.g. `pnpm -C api eval`)
- [ ] Case: pulling out the right requirements
- [ ] Case: matching the right properties
- [ ] Case: no suitable property
- [ ] Case: unclear follow-up date
- [ ] Case: prompt injection
- [ ] Case: a tool failing
- [ ] Case: choosing the right tool
- [ ] Case: no action without approval
- [ ] One case per part 6 to 10 that gets built
- [ ] Same verdicts twice on a fresh `pnpm db:reset`
- [ ] Prints a pass/fail report and saves each case's trace

### D. Then, in this order (parts 6 to 10)

**Part 6. WhatsApp: the assistant runs on its own**

- [ ] Runs once the lead has been quiet for 5 seconds: one run per burst, reading every message
- [ ] A retried `messageId` is never saved twice, never analysed twice
- [ ] Messages from one number go to one lead, even when they arrive at the same moment
- [ ] Webhook answers within 2 seconds, never waits for the AI
- [ ] Only webhook messages start runs on their own (`POST /leads/:id/messages` and the button work as before)
- [ ] At most one run in progress per lead; button during a run gives `409`
- [ ] A WhatsApp run is listed as `running` from the moment it starts
- [ ] Shown on the web panel
- [ ] Eval case

**Part 7. "Is this a good price?"**

- [ ] Price check for every recommended listing and every listing the lead names by code
- [ ] Comparables: same area, type, bedrooms, sold in the 365 days before the message
- [ ] Price per sqft against the median; under 5 sales `not_enough_data`, more than 10% under `below_market`, more than 10% over `above_market`, else `fair`
- [ ] Untrustworthy sales left out (rule written in NOTES.md)
- [ ] Summary agrees with the verdict
- [ ] Shown on the web panel
- [ ] Eval case

**Part 8. Pick the right agent**

- [ ] Only when the lead has no agent
- [ ] Same agency, not on leave, covers a requested area (any area if none), speaks the lead's language (Arabic letters in latest message means `ar`)
- [ ] Fewest open leads; tie goes to the name first alphabetically
- [ ] Nobody fits: suggest nobody, say why in the summary
- [ ] Approving assigns the lead; lead already has an agent gives `409`
- [ ] Shown on the web panel
- [ ] Eval case

**Part 9. Approvals check again**

- [ ] Follow-up whose listings are no longer `available`: save the task, warn with each listing code
- [ ] Agent suggestion whose agent is on leave now, or lead has an agent now: `409`, nothing changes
- [ ] `warnings` is `[]` when nothing changed
- [ ] Shown on the web panel
- [ ] Eval case

**Part 10. Spending limit per agency**

- [x] Cost computed from token usage (`costOf` in `agent.ts`)
- [ ] Reserve USD 0.50 before the first model call, safe when many runs start at once
- [ ] On finish, replace the reservation with the real cost (charge in full if over)
- [ ] Button: `429` and no run saved when the budget can't cover it
- [ ] WhatsApp run: saved as `failed` with an `error` saying why
- [ ] Shown on the web panel
- [ ] Eval case

### E. Also

- [ ] Existing endpoints and response shapes still work (`pnpm check` green)
- [ ] `.env` files stay out of git
- [ ] Committed as we go

### F. Wrap-up (last 20 minutes)

- [ ] `NOTES.md` at the root: what was built, main decisions, what is missing or weak, how to run evals, code brought in
- [ ] Fresh `pnpm db:reset`, run the evals, leave the report in the repo
- [ ] Commit everything; `git status` clean
- [ ] API starts with `TZ=UTC pnpm dev:api`
- [ ] Session history ready to show (`~/.claude/projects/`)

---

## Extras (stretch list, only after everything above works and is committed)

**1. Background runs**

- [ ] `POST ...runs?async=true` answers `202` with `status: "running"`
- [ ] `GET` the run shows tool calls so far
- [ ] Web panel shows steps as they happen
- [ ] A run cut off by a restart ends `failed` with a reason
- [ ] Second run during a run gives `409`

**2. Ask about your data**

- [ ] `POST /assistant/ask` returns `{ answer, sql, rows }`
- [ ] Database enforces: agency's rows only, read only, 5 second timeout (not the prompt)
- [ ] At most 200 rows

**3. Nothing lost in a crash**

- [ ] A saved message whose run never finished is analysed once when the API is back

**4. Pick the model with your evals**

- [ ] Evals on at least two Claude models
- [ ] `evals/model-comparison.md`: pass rate per case, time and cost per run, which model to ship and why

---

## Log

Newest last. One line per finished step or commit.

- 14:37 Starter project committed (`first commit`).
- 14:55 Step 1 code written (listing-quality, tools, agent); typecheck and unit tests pass; not committed yet.
- 15:01 Step 1 checked with the real model on Karim, Alex (injection ignored and reported) and Hala (Arabic, code lookup): 10 to 18 s, USD 0.06 to 0.07 per run. Prompt fix for invented preferences. Added ARCHITECTURE.md; merged CLAUDE.md. Not committed yet.
