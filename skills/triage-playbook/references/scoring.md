# Scoring reference

The triage score is deterministic — same issue, same score, same reasons.
Weights sum to 100; a likely duplicate subtracts 10 afterwards (floor 0).

| Rule | Max | How it is computed |
| --- | --- | --- |
| priority | 30 | Highest 30, High 24, Medium 15, Low 8, Lowest 4, unset 10 |
| age | 15 | +2 per full week the issue has been open, capped at 15 |
| staleness | 10 | +2 per full week without an update, capped at 10 |
| type | 15 | Bug 15, Task 8, Story 8, Epic 5, Sub-task 5, other 6 |
| activity | 10 | Comments: 0 → 0, 1–2 → 3, 3–5 → 6, 6+ → 8; +2 if blocked |
| description | 5 | 5 when a usable description (>= 20 chars) exists, else 0 |
| unassigned | 5 | 5 when nobody is assigned yet, else 0 |
| urgency flag | 10 | 10 when a label says blocked, customer, sev1, production, urgent, p0, critical or outage — or the status contains "blocked" |
| duplicate | −10 | Applied when a likely duplicate (similarity >= 0.55) is found |

## Bands

- 80–100 Critical — same-day first response
- 60–79 High — this week
- 40–59 Medium — next sprint
- 20–39 Low — backlog, review monthly
- 0–19 Backlog — keep, do not schedule

## Classification

The issue type decides first (Bug, Epic, Sub-task). Otherwise keywords in the
summary and description decide: crash/error/fail/exception/broken/regression →
bug; doc/docs/documentation → docs; Story → feature; anything else → task.
