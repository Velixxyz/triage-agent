# Triage Agent

A Forge **Rovo agent** that triages Jira issues with a **deterministic, explainable
priority score** — no LLM calls, no hidden model, every point of the score has a
reason you can read. Built for **Atlassian Codegeist 2026** (Software Teams),
targeting the **Best Agents (Rovo)** and **Best app with Atlassian MCP** bonuses.

Ask it in Rovo Chat: *"Triage the backlog"*, *"How urgent is PROJ-123?"*,
*"Who should work on this?"* — or call the same logic from any MCP client
(Claude, Cursor, VS Code) through the exposed MCP endpoint.

## What it does

| Action | What you get |
| --- | --- |
| `triage-backlog` | Ranked backlog (top 25) with score, band, classification and reasons per issue |
| `triage-issue` | Score + full reason breakdown + duplicate check + assignee suggestion for one issue |
| `summarize-issue` | Status, age, participants, last 5 comments, open questions |
| `find-duplicate` | Jaccard-similarity ranking of likely duplicates in the same project |
| `draft-fix-plan` | Numbered fix plan: reproduce → dedupe → root-cause fix → verify → close, with owner hint and response-time target |
| `suggest-assignee` | Ranked owner candidates from Teamwork Graph (commenters, teammates, workload) |
| `apply-triage` | The only write action: set priority / assignee / labels — **only after you confirm the exact change** |

`rovo:mcp` exposes the six read-only actions as MCP tools. `apply-triage` is
deliberately **not** an MCP tool: an external client can read and recommend, but
only a human confirming in Rovo Chat can change an issue.

## The scoring model (deterministic, total 100)

| Factor | Points | Rule |
| --- | --- | --- |
| Priority | 30 | Highest 30, High 24, Medium 15, Low 8, Lowest 4, unset 10 |
| Age | 15 | +2 per week since created, capped at 15 |
| Staleness | 10 | +2 per week since last updated, capped at 10 |
| Type | 15 | Bug 15, Task/Story 8, Epic 5, Sub-task 5, other 6 |
| Activity | 10 | Comments 0–8 (+2 per comment) + 2 if blocked |
| Description | 5 | 5 if the description is at least 20 characters |
| Unassigned | 5 | 5 if nobody owns it yet |
| Urgency flag | 10 | 10 if a label or the status says blocked / customer / sev1 / production / urgent / p0 / critical / outage |
| Duplicate penalty | −10 | −10 when the issue is a likely duplicate of another (floor 0) |

Bands: **≥80 Critical, 60–79 High, 40–59 Medium, 20–39 Low, <20 Backlog.**
Classification is type-first (a Bug is a bug), then keyword fallback
(crash/error/fail/exception/broken/regression → bug, doc → docs).

Why deterministic instead of an LLM? Forge LLM has **zero free credits** — every
call is paid. A scoring function that any reviewer can recompute by hand is also
exactly what a triage meeting needs: the number is a claim the team can argue
with, not a black box. (A Groq free-tier call is noted as a future option in
`src/index.js` — it is a stub, no key is wired in.)

## Architecture

```
Rovo Chat ──► rovo:agent (prompt + 2 skills + 7 actions)
                    │  actions resolve in src/index.js
                    ├─► src/jira.js      Jira REST (search JQL, issue, comments, priority, update)
                    ├─► src/scoring.js   normalizeIssue / scoreIssue / findDuplicates (pure, tested)
                    ├─► src/assignee.js  rankAssignees (pure, tested)
                    ├─► src/fixplan.js   buildFixPlan (pure, tested)
                    └─► src/twg.js       Teamwork Graph client (asUser, curated queries, retries)
MCP client ─► rovo:mcp ──► same 6 read-only actions
```

- **Jira REST** uses `POST /rest/api/3/search/jql` (the GET `/search` endpoint is
  deprecated), `GET /rest/api/3/issue/{key}`, comments, user search and priorities.
- **Teamwork Graph** uses `api.asUser().requestTeamworkGraph` only (`asApp` is not
  supported by `@forge/api` 8.4.0). Curated queries only — raw Cypher is rejected
  by the platform. Max 25 rows per page; transient errors (429/502/503/504)
  retry up to 3× with backoff. The Graph sometimes answers HTTP 200 with an
  `errors` array — the client always checks it. A missing scope silently drops
  rows, so every object type used is declared in `manifest.yml`.
- **Rovo limits respected:** ~20 s per action, ~1 MB practical response size
  (backlog capped at 25 issues, comments at 5, search pages at 20 candidates).

## Install (for the person deploying)

Prerequisites: Node 20+ and the Forge CLI (`npm install -g @forge/cli`).

```bash
# 1. Register the app and put the real id into manifest.yml
#    (replace the 00000000-... placeholder under app.id)
forge register

# 2. Install dependencies and validate locally (no login needed)
npm install
npm test            # 41 tests: scoring, manifest, fuzz, handler wiring

# 3. Deploy and install on a free 90-day Forge demo site
#    (a developer Free-plan site does NOT show Rovo Chat)
forge site provision
forge deploy
forge install --demo-site
```

`forge lint` needs a Forge login; the same checks run offline via
`npm test` (see `test/manifest.test.js` — manifest cross-references, skill
frontmatter, scope coverage, handler exports).

## Try it (demo script, ~3 minutes)

1. Open Rovo Chat on the demo site, say **"Triage the backlog"** — the agent
   lists the top issues ranked, each with its band and the top 3 reasons.
2. Pick the top one: **"How urgent is PROJ-123?"** — full score breakdown,
   duplicate verdict, suggested owner.
3. **"Is PROJ-123 a duplicate?"** — the similarity-ranked list with the
   likely-duplicate threshold (≥0.55) called out.
4. **"Draft a fix plan for PROJ-123"** — numbered plan with owner and
   response-time target.
5. **"Who should work on it?"** — candidates with reasons and open workload.
6. **"Apply it"** — the agent shows the exact change (priority/assignee/labels)
   and waits for your yes before writing anything.
7. From an MCP client (Claude Desktop / Cursor), connect
   `https://mcp.atlassian.com/forge/<appId>` and call `triage-backlog` — the
   same ranking, outside Jira. (MCP exposure is off by default; a site admin
   enables it.)

## Project layout

```
manifest.yml                  rovo:agent + rovo:mcp + 2 skills + 7 actions + functions
src/index.js                  action handlers (the only file that touches Forge APIs)
src/jira.js                   Jira REST helpers
src/twg.js                    Teamwork Graph client
src/scoring.js                deterministic scoring + duplicate detection
src/assignee.js               assignee ranking
src/fixplan.js                fix-plan builder
prompts/agent-prompt.md       the Rovo agent prompt
skills/triage-playbook/       SKILL.md + references/scoring.md
skills/issue-analyst/         SKILL.md + references/duplicate-guide.md
test/                         scoring / assignee / fixplan / manifest / fuzz / handlers
```

## Known limits

- Teamwork Graph data is only as complete as the site's scopes and the user's
  permissions; missing rows are reported as notes, never silently invented.
- Duplicate detection is token-overlap (Jaccard), not semantic — it catches
  reworded reports only when they share vocabulary.
- The agent answers in the language of the conversation; issue text is read
  as-is (ADF flattened to plain text).
- `forge lint` and deploy/install need a logged-in Forge CLI; local validation
  (`npm test`) covers everything that can be checked without a site.
