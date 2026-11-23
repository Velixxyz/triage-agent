import test from "node:test";
import assert from "node:assert/strict";
import { rankAssignees } from "../src/assignee.js";

test("rankAssignees prefers active commenters with low workload", () => {
  const rows = rankAssignees([
    { accountId: "a1", name: "Quiet", commentCount90d: 0, openAssignedCount: 12, sameTeamAsReporter: true },
    { accountId: "a2", name: "Active", commentCount90d: 4, commentedLast14d: true, openAssignedCount: 2, sameTeamAsReporter: true },
    { accountId: "a3", name: "Busy", commentCount90d: 5, openAssignedCount: 25, sameTeamAsReporter: false },
  ]);
  assert.equal(rows[0].name, "Active");
  assert.equal(rows[0].score, 12 + 5 + 5 - 2); // comments 12 + recent 5 + team 5 - workload 2
  assert.ok(rows[0].score > rows[2].score);
});

test("rankAssignees breaks ties by fewer open items, then name", () => {
  const rows = rankAssignees([
    { accountId: "b2", name: "Zed", commentCount90d: 1, openAssignedCount: 5 },
    { accountId: "b1", name: "Amy", commentCount90d: 1, openAssignedCount: 2 },
    { accountId: "b3", name: "Bo", commentCount90d: 1, openAssignedCount: 2 },
  ]);
  assert.equal(rows[0].name, "Amy");
  assert.equal(rows[1].name, "Bo");
  assert.equal(rows[2].name, "Zed");
});

test("rankAssignees handles empty input and missing fields", () => {
  assert.deepEqual(rankAssignees([]), []);
  const rows = rankAssignees([{ name: "NoData" }]);
  assert.equal(rows[0].score, 0);
  assert.equal(rows[0].openAssignedCount, 0);
});

test("rankAssignees rewards continuity for reporter/assignee", () => {
  const rows = rankAssignees(
    [
      { accountId: "r1", name: "Reporter", commentCount90d: 0, openAssignedCount: 0 },
      { accountId: "x1", name: "Stranger", commentCount90d: 0, openAssignedCount: 0 },
    ],
    { reporterAccountId: "r1" },
  );
  assert.equal(rows[0].name, "Reporter");
  assert.ok(rows[0].reasons.some((r) => r.includes("Reporter")));
});
