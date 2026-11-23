// Triage Agent — deterministic fix-plan builder (pure logic, no LLM).
// Turns a triaged issue into a step-by-step plan the team can execute.
// Steps adapt to the issue classification, duplicates, assignee and urgency.

export function buildFixPlan({ issue, score, duplicates = [], suggestedAssignee = null }) {
  const steps = [];
  const classification = score?.classification || "task";
  const band = score?.band || "Medium";
  const key = issue?.key || "UNKNOWN";

  steps.push({
    n: 1,
    title: "Reproduce and confirm",
    detail:
      classification === "bug"
        ? `Reproduce the problem from "${issue.summary}" on the current build and record exact steps, expected vs actual behaviour.`
        : `Confirm the scope of "${issue.summary}" with the reporter and agree on acceptance criteria before starting work.`,
    ownerHint: suggestedAssignee?.name || issue?.assignee || "triage owner",
  });

  if (duplicates.length > 0) {
    const top = duplicates[0];
    steps.push({
      n: 2,
      title: "Resolve the duplicate question first",
      detail: top.likelyDuplicate
        ? `${key} looks like a duplicate of ${top.key} (similarity ${top.similarity}). Close as duplicate or merge the discussion there before writing code.`
        : `${key} overlaps with ${top.key} (similarity ${top.similarity}). Link the two issues and check whether the fix for one covers the other.`,
      ownerHint: suggestedAssignee?.name || "triage owner",
    });
  }

  const fixStep = {
    n: steps.length + 1,
    title: classification === "bug" ? "Fix the root cause" : classification === "docs" ? "Write the documentation" : "Implement the change",
    detail:
      classification === "bug"
        ? "Fix at the root cause, not the symptom. Add a regression test that fails before the fix and passes after it."
        : classification === "docs"
          ? "Draft the page, link it from the issue, and ask the reporter to confirm it answers their question."
          : "Implement in small reviewable commits. Keep the change behind the existing tests; add a test for the new behaviour.",
    ownerHint: suggestedAssignee?.name || issue?.assignee || "assigned developer",
  };
  steps.push(fixStep);

  steps.push({
    n: steps.length + 1,
    title: "Verify and close the loop",
    detail: `Verify against the acceptance criteria, then comment the result on ${key} so the reporter can confirm. Update the issue status; do not leave it open without a next action.`,
    ownerHint: suggestedAssignee?.name || issue?.assignee || "assigned developer",
  });

  const urgency = band === "Critical" || band === "High";
  return {
    issueKey: key,
    classification,
    band,
    score: score?.score ?? null,
    suggestedAssignee: suggestedAssignee ? { name: suggestedAssignee.name, score: suggestedAssignee.score } : null,
    duplicatesConsidered: duplicates.length,
    // Critical/High items get a same-day first response; the rest get a next-sprint slot.
    targetResponse: urgency ? "Same working day — first response within 4 hours" : "Next sprint planning — first response within 2 working days",
    steps,
  };
}
