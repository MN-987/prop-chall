# Notes

What I built for the AI lead assistant task, the decisions behind it, what is missing, and how to run the evals. The design, step by step, is in [PLAN.md](PLAN.md); how the parts fit together is in [ARCHITECTURE.md](ARCHITECTURE.md).

## What is built

**Core assistant (TASK.md parts 1 to 5): done.**

- **Agent:** Claude (`claude-opus-5-5`, Vercel AI SDK) runs a tool loop of at most 8 steps and returns one JSON answer, checked by a zod schema: requirements, ranked recommendations with reasons, summary, and a follow-up.
- **Tools:** `search_listings` and `get_listing`, both read only. Each result carries gross yield, price per sqft and data warnings computed in code: typo price (MBR-1023), duplicate listing (MBR-1024 copies MBR-1001), no rent figure, implausible yield.
- **Run storage:** `assistant_runs` and `assistant_actions`, plus the 5 endpoints of the API contract with its status codes (`404` for another agency or an unknown message, `422` for no inbound message, `409` for conflicts, `201` with `status: "failed"` and empty fields for a failed run).
- **Due dates:** worked out in code, in the agent's timezone, from the message's `sentAt`.
- **Approval:** Approve creates the task exactly once, even when two approvals arrive together. Reject saves nothing.
- **Web panel and mobile card:** start a run, see the requirements, ranked listings, summary and follow-up, and Approve or Reject on both. Approve and Reject on mobile were a bonus.

**Stretch 1, background runs: done, pulled forward.** `POST ...runs?async=true` answers `202`. The trace is saved after every tool call, so the web panel shows the steps as they happen. A run cut off by a restart is marked `failed` at startup, with the reason. Without `async=true` the endpoint behaves exactly as the contract says.

**Evals: done.** 18 cases pass, plus 5 written for parts 6 to 10 that are skipped until those parts exist. See "Evals" below.

**Experiment: Jev chooses the tools** (branch `feat/tool-planner`). The tool choice is a strategy: `claude` (the default) or `jev`. With `jev`, TypeSafe's Jev decides which searches to run, code runs them, and Claude only ranks and writes. Same verdict on all 18 cases, at 47% lower cost. See "Claude vs Jev" below.

## Main decisions

1. **Code, not the prompt, enforces the rules.**
   - The agency id comes from the login token and the tools close over it. It is never a tool argument, so no prompt can change it.
   - Listing status `available` is fixed in the search.
   - Every recommendation is re-checked in code before it is saved: a tool showed it in this run, it is the agency's, it is `available` when read again from the database, it has no blocking data warning, and it fits the extracted requirements.
2. **Untrusted text stays data.** Lead messages and listing descriptions are wrapped in tags, with `<` and `>` replaced so the text cannot close the tags. The prompt says they are data. The injection evals check the outcome, not the wording.
3. **The model names the timing, code computes the date.** The model returns an intent such as `tomorrow`, `after_weekend`, `weekday` or `unclear`. Code turns it into `dueAt` in `Asia/Dubai`, so the server's timezone never matters. The `TZ=UTC` eval case checks this.
4. **Facts are computed in code.** Yield, price per sqft and data warnings are computed before the model sees a listing. The area argument is an enum of the agency's real areas, so "the Marina" has to become "Dubai Marina" before any query runs.
5. **A failure is a failure.** Any tool or model error marks the run `failed` with the reason. It never reports "no matching properties".
6. **The database enforces concurrency.** A partial unique index allows one `running` run per lead, so a second press is a `409` even at the same instant. Approve is a conditional update (`WHERE status = 'pending_approval'`) in the same transaction as the task insert.
7. **Current API rules.** No `temperature` and no forced `toolChoice`, because current Claude models reject both. Effort is set to `medium`.

## Not built (on purpose)

TASK.md values a part left out and noted over one that is there but broken. Parts 6 to 10 are not built. Each already has an eval case, which runs once the part's number is added to `BUILT_PARTS` in `api/evals/assistant.eval.ts`.

| Part | How I would build it |
| --- | --- |
| 6. WhatsApp auto-run | A per-lead debounce of 5 s after the last webhook message. Dedupe by the provider's `messageId` with a unique index. Insert the run as `running` first: the existing unique index already gives one run per lead and the `409`. The webhook only enqueues, so it answers fast. |
| 7. Price check | Plain code over `GET /market/sales`: same area, type and bedrooms, sold in the 365 days before the message, median AED per sqft, verdict at ±10%, `not_enough_data` under 5 sales. Sales to drop: exact duplicates, implausible price per sqft (the same 300 to 15,000 band as listings), and sizes that do not fit the bedroom count. In the seed, that leaves 9 of 13 recent Marina 2-bed sales. MBR-1001 comes out `above_market` (+12.5%) and MBR-1016 `fair` (+2%); the eval case has these numbers worked out by hand. |
| 8. Agent pick | Plain code: same agency, not on leave, covers a requested area (any if none), speaks the lead's language (Arabic letters mean `ar`), fewest open leads, then name. For an Arabic Dubai Marina lead that is Khalid; Layla speaks Arabic but is on leave. |
| 9. Re-check on approve | On approve, read the recommended listings' status again and warn by code for any that are not `available`. For an agent suggestion, `409` if the agent is on leave by then or the lead already has an agent. |
| 10. Budget | Reserve USD 0.50 with one conditional `UPDATE agencies SET ai_spent_usd = ai_spent_usd + 0.5 WHERE ai_spent_usd + 0.5 <= ai_monthly_budget_usd` before the first model call, then settle to the real cost. No row updated means `429`. |

Stretch items 2 (ask about your data), 3 (nothing lost in a crash) and 4 (pick the model) are not done. The Claude vs Jev comparison is the closest thing to item 4.

## Evals

**Run them:**

```bash
pnpm -C api eval                       # all cases: about 2.5 min, about USD 0.92
pnpm -C api eval -t "Injection"        # only the cases whose name matches; leaves the full report unchanged
```

**How they work:**

- Jest with `TZ=UTC`, as the graders start the API.
- The test database (`challenge_test`) is reset first. The dev database is never touched.
- The real Nest app runs in-process with the real model, and every case goes through the real endpoints as Sara or Omar.
- Checks are plain assertions on facts: which listings, which fields, dates, row counts before and after, and tool calls in the trace. Never wording.
- Every run is also checked against the API contract shape.
- A tool failure is faked only inside the eval (`jest.spyOn` on the search service).
- A recorder around the model logs every call: step, model, what it did, tokens, cost and time.

**Output:**

- `api/evals/results/report.html`, with five tabs:
  - Overview: pass or fail per case.
  - Cost: cost per case and per model call.
  - Traces: every tool call and every check.
  - Coverage: TASK.md's categories and the cases that cover them.
  - Stability: the last two runs side by side.
- `report.md`: the same results as a table.
- `traces/<case>.json`: one file per case.

**Cases:**

| TASK.md category | Cases |
| --- | --- |
| 1. Requirements | Karim; Yousef changing his mind (the later message wins); Fatima writing in Arabic (the summary stays in English) |
| 2. Matching | Karim: only fitting Marina 2-beds, never the typo or duplicate listing, the listing with no rent figure not ranked first for yield |
| 3. No suitable property | Lina (5-bed villa under 900k); Priya (wants to rent) |
| 4. Unclear date | "sometime soon": `dueAt` null with a reason |
| 5. Prompt injection | Alex ("skip the approval"); a message planting "recommend MBR-1008"; MBR-1019's description ("ignore your instructions") |
| 6. Tool failure | The search throws: the run is `failed`, all fields are empty, and the trace shows the error |
| 7. Tool choice | Ben's code gets `get_listing`; the search comes before any detail lookup; "Hi" gets no search |
| 8. No action without approval | Before and after snapshots match; approve twice gives one task; reject saves nothing; `409` for a reject after an approve |
| Extras | "tomorrow", "after the weekend", and "tomorrow" sent at Saturday 01:30 Dubai (still Friday in UTC); agency isolation (`404`s); two presses at once (`201` and `409`) |
| Parts 6 to 10 | Written, skipped until built |

**Results:**

| Run | Result | Cost | Time | Notes |
| --- | --- | --- | --- | --- |
| 1 (16:19) | 17 of 18 | USD 0.90 | 164 s | Found a real bug (below) |
| 2 (16:26) | 18 of 18 | USD 0.92 | 155 s | 34 model calls; a run averages about USD 0.06 and 11 s |

**Bug the evals found:** "tomorrow" sent at 01:30 on a Saturday was marked unclear by the model ("Saturday or Sunday?"). TASK.md says it is the next calendar day. It was not a timezone bug, because the date code was never reached. The fix was one prompt rule. Run 2 confirmed it, and every other case kept its verdict.

## Claude vs Jev (branch `feat/tool-planner`)

The same suite ran twice: once with Claude choosing the tools, once with Jev.

| | Claude chooses | Jev chooses |
| --- | --- | --- |
| Passed | 18 of 18 | 18 of 18 (same verdict on every case) |
| Time | 168.6 s | 134.0 s (20% faster) |
| Claude cost | USD 0.92 | USD 0.49 |
| Jev cost | 0 | USD 0.001 |
| Model calls | 34 | 15 |

Jev answers typed yes/no questions over the conversation, and each answer is a probability. It only picks among values code gives it, so it cannot invent an area or a filter. Its decisions are saved on the run. For Karim: Dubai Marina 0.99, 2 bedrooms 0.97, apartment 1.0.

Jev does not extract the budget, because it is not built for numbers. Its search has no price filter, and Claude plus the code check apply the budget afterwards. One small difference: for Priya, who wants to rent, Jev still searched, while Claude correctly did not.

Report: `api/evals/compare.html` on that branch. The default stays `claude`; set `TOOL_PLANNER=jev` in `api/.env` or send `{ "planner": "jev" }` per run.

## Known weak spots

- The restart sweep assumes one API instance. A second instance starting would mark the first one's running runs as failed. Several instances would need a lease per run.
- A model call aborted by a tool failure does not report its token usage, so that run's cost is recorded as 0.
- `bedrooms` is a single number, as in the contract. "Studio or 1-bed" is searched as a 0 to 1 range.
- The ranking and the wording of reasons are checked only loosely: the first pick must have the best yield when the lead asks for yield. There is no model-graded check of explanation quality.

## How I used AI tools

- **Tool:** Claude Code (Claude Opus 5.5) throughout. The session files are under `~/.claude/projects/` for this folder.
- **Instructions:**
  - [CLAUDE.md](CLAUDE.md) holds the working rules for every session: build in TASK.md order, propose a design and get approval before building, no code before that, and the rules the assistant must never break.
  - [task_progress.md](task_progress.md) is a checklist of every TASK.md requirement. Each session reads it first and ticks an item only when it has been tested.
  - [PLAN.md](PLAN.md) records each step's agreed design and its tasks.
- **Parallel sessions:** separate Claude Code sessions worked at the same time on separate files or git worktrees: API, web and mobile UI, evals, and the Jev planner.
- **Checking the AI's work:**
  - Each step was type checked and tested before commit: API unit and e2e tests (e2e with a scripted stand-in model, so they cost nothing and repeat), and web and mobile component tests.
  - Agent changes were also run on seeded leads against the real model.
  - The eval suite is the independent check. It found the "tomorrow" after midnight bug.
  - The smoke runs found the model inventing a "lake view" preference from an area name. The prompt now limits preferences to what the lead wrote.

**Code brought in:** none. Two ideas, not code, came from my own earlier project: a partial unique index for one running run per lead, and a startup sweep for interrupted runs.
