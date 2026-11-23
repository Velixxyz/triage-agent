// Triage Agent — deterministic assignee ranking (pure logic, no API calls).
//
// Candidates come from Teamwork Graph / Jira (recent commenters on the issue,
// members of the reporter's teams). Ranking is a transparent points model:
//
//   commentActivity   +3 per comment on this issue in the last 90 days (cap +15)
//   recentCommenter   +5 if they commented in the last 14 days
//   sameTeam          +5 if they share a team with the reporter
//   workload          -1 per open assigned work item (floor -10)
//   alreadyInvolved   +4 if they are the current assignee or reporter
//                       (continuity beats reassignment when the score ties)
//
// Ties break by: higher score, then fewer open items, then name.

export function rankAssignees(candidates, { reporterAccountId = null, currentAssigneeAccountId = null } = {}) {
  const rows = (candidates || []).map((c) => {
    let score = 0;
    const reasons = [];
    const comments = c.commentCount90d || 0;
    const commentPoints = Math.min(15, comments * 3);
    if (commentPoints > 0) {
      score += commentPoints;
      reasons.push(`${comments} comment(s) on this issue (+${commentPoints})`);
    }
    if (c.commentedLast14d) {
      score += 5;
      reasons.push("Commented in the last 14 days (+5)");
    }
    if (c.sameTeamAsReporter) {
      score += 5;
      reasons.push("Same team as reporter (+5)");
    }
    const openCount = c.openAssignedCount ?? 0;
    const workloadPenalty = -Math.min(10, openCount);
    score += workloadPenalty;
    reasons.push(`${openCount} open item(s) (${workloadPenalty})`);
    if (c.accountId && (c.accountId === reporterAccountId || c.accountId === currentAssigneeAccountId)) {
      score += 4;
      reasons.push(c.accountId === currentAssigneeAccountId ? "Current assignee (+4)" : "Reporter (+4)");
    }
    return {
      accountId: c.accountId || null,
      name: c.name || "Unknown",
      score,
      openAssignedCount: openCount,
      commentCount90d: comments,
      sameTeamAsReporter: Boolean(c.sameTeamAsReporter),
      reasons,
    };
  });
  rows.sort((a, b) => b.score - a.score || a.openAssignedCount - b.openAssignedCount || a.name.localeCompare(b.name));
  return rows;
}
