# Privacy Policy — Triage Agent

Last updated: 23 November 2026

Triage Agent is a Forge app (a Rovo agent) for Jira, built for Atlassian Codegeist 2026 by endruw idn. This policy explains what data the app touches.

## What the app accesses

When you ask Triage Agent to triage a backlog or an issue, it reads Jira data through the Jira REST API with your authorization: issue summaries, descriptions, priorities, statuses, types, reporters, assignees, and activity timestamps. It also queries Teamwork Graph for team membership and current open-item counts to suggest an owner.

## What the app stores

Nothing. Triage Agent has no database and uses no persistent storage. Issue data is processed transiently to compute a score and a reply, then discarded. No personal data is stored by the app.

## What the app shares

The app's read-only triage tools are also exposed as MCP tools, so an MCP client you connect can call the same read-only actions. The app sends no data to any third party, runs no analytics or tracking, and shows no ads.

## Uninstalling

Uninstalling the app removes its access to your Jira data. Since the app stores nothing, there is no retained data to delete.

## Contact

Questions about this policy: endruwidn@gmail.com.
