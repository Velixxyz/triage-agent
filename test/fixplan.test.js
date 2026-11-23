import test from "node:test";
import assert from "node:assert/strict";
import { buildFixPlan } from "../src/fixplan.js";

test("buildFixPlan for a bug includes reproduce + duplicate step when duplicates exist", () => {
  const plan = buildFixPlan({
    issue: { key: "PROJ-1", summary: "Login crashes", assignee: "Ada" },
    score: { classification: "bug", band: "High", score: 72 },
    duplicates: [{ key: "PROJ-7", similarity: 0.8, likelyDuplicate: true }],
    suggestedAssignee: { name: "Ada", score: 12 },
  });
  assert.equal(plan.issueKey, "PROJ-1");
  assert.equal(plan.classification, "bug");
  assert.equal(plan.steps[0].title, "Reproduce and confirm");
  assert.ok(plan.steps.some((s) => s.title.includes("duplicate")));
  assert.ok(plan.steps.some((s) => s.title.includes("root cause")));
  assert.equal(plan.targetResponse, "Same working day — first response within 4 hours");
  assert.equal(plan.duplicatesConsidered, 1);
});

test("buildFixPlan for a low-priority feature has no duplicate step and slower target", () => {
  const plan = buildFixPlan({
    issue: { key: "PROJ-2", summary: "Add export button", assignee: null },
    score: { classification: "feature", band: "Low", score: 25 },
    duplicates: [],
    suggestedAssignee: null,
  });
  assert.equal(plan.steps.length, 3);
  assert.ok(!plan.steps.some((s) => s.title.includes("duplicate")));
  assert.equal(plan.targetResponse, "Next sprint planning — first response within 2 working days");
  assert.equal(plan.suggestedAssignee, null);
});

test("buildFixPlan for docs adapts the fix step", () => {
  const plan = buildFixPlan({
    issue: { key: "PROJ-3", summary: "Document the API", assignee: null },
    score: { classification: "docs", band: "Medium", score: 45 },
    duplicates: [],
    suggestedAssignee: null,
  });
  assert.ok(plan.steps.some((s) => s.title.includes("documentation")));
});

test("buildFixPlan step numbers are sequential", () => {
  const plan = buildFixPlan({
    issue: { key: "PROJ-1", summary: "x", assignee: null },
    score: { classification: "bug", band: "Critical", score: 90 },
    duplicates: [{ key: "PROJ-7", similarity: 0.9, likelyDuplicate: true }],
    suggestedAssignee: null,
  });
  plan.steps.forEach((s, i) => assert.equal(s.n, i + 1));
});
