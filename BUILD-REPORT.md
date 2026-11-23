# Build Report — Triage Agent (Codegeist 2026, Software Teams)

Built 23 Nov 2026 by the build subagent. No auth, deploy, install, submit or
external post was performed — local code + validation only. The main agent owns
deploy / install / demo video / Devpost submission.

## Files delivered

```
~/workspace/work/codegeist/triage-agent/
├── manifest.yml                  rovo:agent + rovo:mcp + 2 rovo:skill + 7 action + 7 function
├── package.json                  @forge/api 8.4.0, devDep yaml ^2.9.1, npm test
├── README.md                     install, usage, architecture, scoring model, demo script
├── BUILD-REPORT.md               this file
├── .gitignore
├── prompts/agent-prompt.md       Rovo agent prompt (deterministic rules, write gate)
├── skills/triage-playbook/       SKILL.md + references/scoring.md
├── skills/issue-analyst/         SKILL.md + references/duplicate-guide.md
├── src/
│   ├── index.js                  7 action handlers
│   ├── jira.js                   Jira REST helpers (POST /search/jql, issue, comments, priority, update)
│   ├── twg.js                    Teamwork Graph client (asUser, curated queries, retries, 200+errors check)
│   ├── scoring.js                normalizeIssue, scoreIssue, bandFor, classifyIssue, findDuplicates, adfToText
│   ├── assignee.js               rankAssignees
│   └── fixplan.js                buildFixPlan
└── test/
    ├── scoring.test.js           16 tests
    ├── assignee.test.js          4 tests
    ├── fixplan.test.js           4 tests
    ├── manifest.test.js          8 tests (local stand-in for forge lint)
    ├── fuzz.test.js              2 tests (300 random issues + hostile fixtures)
    └── handlers.test.js          7 tests (real handlers vs stubbed @forge/api)
```

## Verification results

| Check | Result |
| --- | --- |
| `npm test` | **41/41 pass** (16 scoring + 4 assignee + 4 fixplan + 8 manifest + 2 fuzz + 7 handlers) |
| `node --check src/*.js` | all 6 files OK |
| `forge lint` | **BLOCKED — needs login.** The CLI refuses to run lint without a logged-in session. The manifest parses (the two YAML errors found by the first lint runs were fixed: unquoted `:` in `followUpPrompt` and in the `priority` input description). The equivalent checks run offline in `test/manifest.test.js` and pass: YAML parses, app id is ARI-shaped, runtime `nodejs24.x`, every agent action/skill reference resolves, every action has a function with a matching `export async function` in `src/index.js`, at most one `rovo:mcp` module, its tools are existing read-only actions (no UPDATE action exposed), skill dirs + `SKILL.md` frontmatter valid (name = dir, description 50–1024 chars, body ≤500 lines, `allowed-tools` covers dependencies), scopes cover all called APIs, no unused function. |
| Fuzz (300 seeded random issues + 6 hostile fixtures) | Invariants hold: score always in [0,100], deterministic, breakdown sums to score, duplicates sorted, no crash on null/garbage/future dates/100k-char descriptions/stopword-only summaries |
| Handler wiring (mocked `@forge/api`) | Real handlers run end-to-end against a stub: backlog ranking order + exact score 79 for the fixture bug, triage-issue score/classification/breakdown, duplicate match + `likelyDuplicate` flag, summary open-question extraction, apply-triage PUT payload (priority id + merged labels) and the no-op guard (no PUT when nothing to apply) |

## Design decisions (with reasons)

- **No Forge LLM.** Zero free credits — every call is paid. Scoring is a pure
  function of issue fields, so any reviewer (and the judging panel) can recompute
  a score by hand. Groq free-tier is a stub comment only; no key is wired.
- **Write action is singular and gated.** `apply-triage` is the only UPDATE
  action; the agent prompt requires the user to confirm the exact change first,
  and it is deliberately excluded from `rovo:mcp`.
- **Teamwork Graph via `asUser` only.** `asApp` is not supported by
  `@forge/api` 8.4.0 — verified against the installed package's type definitions.
- **Operation names are `[company]_[operation]`** (`triage_*`), company ≥3 chars,
  operation ≥4 — the platform's naming rule, verified in the docs.
- **Scopes (8)** cover exactly what the actions call, including all five Graph
  scopes; a missing Graph scope silently drops rows, so this was checked twice.
- **Action inputs all carry `title`/`type`/`required`/`description`.**
  `issueKey` is optional on read actions so the agent can use the work item open
  on screen; it is required on `apply-triage`.
- **Manifest `app.id` is a placeholder UUID** (`00000000-0000-4000-8000-000000000000`).
  The real id must be filled in by the main agent from `forge create` /
  `forge register` before deploy. The placeholder is ARI-shaped so local
  validation passes.

## What is NOT yet tested (needs a live site)

1. `forge deploy` + `forge install --demo-site` (needs the main agent's login).
2. Rovo Chat end-to-end: conversation starters, agent picking the right action,
   follow-up prompt behaviour, response size under the ~1 MB practical cap.
3. Teamwork Graph against a real site: whether the curated queries return rows
   for the demo site's data (scopes, user permissions, Graph availability).
4. MCP endpoint live: `https://mcp.atlassian.com/forge/<appId>` from an external
   client, and the admin toggle that enables external exposure (default OFF).
5. `forge lint` itself (login-gated) — run it once after `forge register`
   replaces the placeholder app id.
6. Demo video (<5 min, public YouTube) and Devpost submission (deadline
   **23 Dec 2026 03:00 WIB**).

## Fixes applied during this build

- `forge lint` YAML errors: quoted `followUpPrompt` and the `priority`
  description (unquoted `:` inside a plain scalar).
- `test/handlers.test.js`: `t.mock.module` is not available without the
  `--experimental-test-module-mocks` flag on Node 24 — the test script now sets
  the flag, and the file uses one module mock + a mutable stub variable (a
  per-test re-mock would not re-bind the already-cached `src/index.js`).
- One wrong test expectation (fixture bug scores 79 = High, not Critical) —
  the engine was right, the test was fixed and now asserts the exact score.

## Security / hygiene

- No Atlassian API token was used, copied, printed or stored anywhere in this
  build (no `forge login` / deploy / install / tunnel / register was run).
- No credentials of any kind exist in the repository. `node_modules/` is
  gitignored; the only secret-adjacent file is none.

## v2.5.0 — full-backlog pagination + deterministic tie-break (23 Nov 2026)

Implements the first two "What's next" items from the Devpost draft.

- `src/jira.js`: `searchIssues` gains `startAt` + returns `total`; new
  `searchAllIssues` pages through the whole backlog (100 rows/request,
  `SEARCH_ALL_MAX_PAGES = 10` → max 1000 issues, so a giant backlog cannot
  blow the ~20s Rovo budget). A failed page after the first returns the
  issues fetched so far with `partialError`; `truncated` is set when more
  issues exist than were fetched.
- `src/scoring.js`: new `compareTriageRows` (score desc, then older issue
  first, then smaller key) and `compareIssueKeys` (numeric-aware:
  PROJ-5 < PROJ-37; lexical fallback for zero-padded equals). Scoring
  functions themselves untouched — scores are byte-identical to v2.4.0.
- `src/index.js`: `triageBacklog` uses `searchAllIssues` + `compareTriageRows`
  and reports in `notes` when ties were broken, when ranking is partial,
  or when the backlog was truncated.
- Verification: `npm test` 50/50 (was 41/41; +9 new: 3 comparator unit,
  4 handler incl. 250-issue/3-page mock + truncation + partial failure,
  2 ranking fuzz). Fuzz: 300 seeded random issues — ranking identical
  from two different shuffles, total-order invariants hold, Top-10 score
  multiset identical to the old score-only order (0 score mismatch).
- Independent review: Groq `openai/gpt-oss-120b` (free chain) — verdict
  APPROVE WITH NITS; both functional nits applied (null key → "" instead
  of "null"; zero-padded equal numbers get a lexical fallback). Third nit
  (tie counting) is cosmetic only; the note text is already accurate.
- Suggested version: **v2.5.0** (minor bump — new capability, no breaking
  change to scores or response shape). Not deployed or pushed by this build.
