---
name: triage-playbook
description: Run a Jira triage session end to end — rank the open backlog with deterministic scores, drill into the top items for duplicates and Teamwork Graph assignee suggestions, and apply the agreed decision only after the user confirms it.
allowed-tools: triage-backlog triage-issue suggest-assignee apply-triage
---

# Triage playbook

Use this skill when the user wants to triage work: rank a backlog, decide what
comes first, or work through the top items one by one.

## Workflow

1. **Rank the backlog.** Call `triage-backlog` (project key when the user
   names one, otherwise leave it empty). Present the ranked list top first:
   score, band, classification and the top two reasons per item. Show at most
   the top 10 in chat.
2. **Drill into the top items.** For the top 3–5 items, call `triage-issue`
   on each key. This adds duplicate detection and a Teamwork Graph assignee
   suggestion (recent commenters + the reporter's team + open workload).
   Report likely duplicates (similarity 0.55 or higher) and the suggested
   assignee with reasons.
3. **Confirm, then apply.** Never call `apply-triage` until the user has
   explicitly confirmed the exact change (priority, assignee, labels). After
   applying, report what changed and what the previous values were.

## Tools used

Each tool declared in this skill's manifest dependencies, and how it is used:

- `triage-backlog` — ranks the open backlog with deterministic scores (step 1).
- `triage-issue` — drills into one item: full breakdown, duplicate detection,
  and a Teamwork Graph assignee suggestion (step 2).
- `suggest-assignee` — suggests an owner for an issue from Teamwork Graph data
  (recent commenters, reporter's team, open workload), used in step 2 when the
  user asks who should own an item.
- `apply-triage` — applies the agreed change to an issue, only after the user
  has explicitly confirmed the exact change (step 3).

## How the score works

See `references/scoring.md` for the full weights table. The score is
deterministic: priority (30), age (15), staleness (10), type (15), activity
(10), description (5), unassigned (5), urgency flag (10); a likely duplicate
subtracts 10. Bands: 80+ Critical, 60–79 High, 40–59 Medium, 20–39 Low,
under 20 Backlog.

## Edge cases

- **Empty backlog:** say so plainly; do not invent items.
- **Action returns a `notes` entry:** tell the user that part may be
  incomplete instead of saying there is nothing.
- **No suggested assignee:** the team may be empty or unreadable — say that,
  and suggest the reporter as the fallback owner.
- **apply-triage with nothing to apply:** the action returns an error; ask
  the user what exactly should change.
