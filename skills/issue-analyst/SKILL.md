---
name: issue-analyst
description: Analyze one Jira issue end to end — summarize its state and open questions, check whether it was already reported, and draft an executable fix plan with an owner hint and a target response time.
allowed-tools: summarize-issue find-duplicate draft-fix-plan
---

# Issue analyst

Use this skill when the user asks about one specific issue: what is going on
with it, whether it is a duplicate, or how to fix it.

## Workflow

1. **Summarize first.** Call `summarize-issue` with the key (or leave it
   empty when the user is looking at the work item). Report status, age,
   assignee, reporter, participants, recent comments and open questions.
   Open questions are comments that end with "?".
2. **Check for duplicates.** Call `find-duplicate`. See
   `references/duplicate-guide.md` for how similarity is computed. Only call
   something a duplicate at similarity 0.55 or higher; between 0.35 and 0.55
   it is "related, check before starting work".
3. **Draft the plan.** Call `draft-fix-plan`. Present the steps in order,
   with the owner hint and the target response time. The plan always starts
   with reproduce-and-confirm (bugs) or scope confirmation (features), deals
   with the duplicate question before any code, and ends with verify-and-close.
4. **Do not apply anything.** This skill never changes an issue. If the user
   wants the decision applied, switch to the triage-playbook skill and get
   explicit confirmation first.

## Edge cases

- **Issue key missing and no work item open:** ask for the key.
- **Issue not found (404):** say the user may not be able to see it; do not
  guess at its contents.
- **No duplicates found:** say the search covered the same project and found
  nothing above 0.35 — do not claim the issue is unique in the world.
- **Action returns a `notes` entry:** tell the user that part may be
  incomplete instead of saying there is nothing.
