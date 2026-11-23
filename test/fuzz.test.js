// Fuzz / simulation: the scoring engine must hold its invariants on any
// synthetic issue, including hostile ones (missing fields, weird values).
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeIssue, scoreIssue, bandFor, findDuplicates } from "../src/scoring.js";
import { rankAssignees } from "../src/assignee.js";
import { buildFixPlan } from "../src/fixplan.js";

// Deterministic PRNG so the fuzz run is reproducible.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES = ["Bug", "Task", "Story", "Epic", "Sub-task", "Spike", null, "WeirdType"];
const PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest", null, "Unknown"];
const STATUSES = ["To Do", "In Progress", "Blocked", "Done", "Closed", "In Review", null];
const LABELS = [[], ["blocked"], ["sev1"], ["customer"], ["p0"], ["a", "b"], ["PRODUCTION"], ["urgent", "blocked"]];
const WORDS = ["login", "crash", "button", "export", "api", "timeout", "dark", "mode", "payment", "sync", "🚀", "über", "x"];

function randomIssue(rnd, i) {
  const createdDaysAgo = Math.floor(rnd() * 120);
  const updatedDaysAgo = Math.floor(rnd() * createdDaysAgo);
  const summary = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(" ");
  const fields = {
    summary,
    issuetype: { name: TYPES[Math.floor(rnd() * TYPES.length)] },
    status: { name: STATUSES[Math.floor(rnd() * STATUSES.length)] },
    priority: PRIORITIES[Math.floor(rnd() * PRIORITIES.length)]
      ? { name: PRIORITIES[Math.floor(rnd() * PRIORITIES.length)] }
      : null,
    assignee: rnd() > 0.4 ? { displayName: "Someone", accountId: "u1" } : null,
    reporter: { displayName: "Rep", accountId: "r1" },
    labels: LABELS[Math.floor(rnd() * LABELS.length)],
    components: rnd() > 0.5 ? [{ name: "auth" }] : [],
    created: new Date(Date.now() - createdDaysAgo * 86400000).toISOString(),
    updated: new Date(Date.now() - updatedDaysAgo * 86400000).toISOString(),
    comment: { total: Math.floor(rnd() * 12), comments: [] },
    descriptionText: rnd() > 0.3 ? "Some description text that is long enough to count." : "",
  };
  return { key: `PROJ-${i}`, fields };
}

test("fuzz: 300 random issues hold scoring invariants", () => {
  const rnd = mulberry32(20261123);
  for (let i = 0; i < 300; i++) {
    const raw = randomIssue(rnd, i);
    const norm = normalizeIssue(raw);
    const a = scoreIssue(norm);
    const b = scoreIssue(norm);
    assert.deepEqual(a, b, `non-deterministic score for ${raw.key}`);
    assert.ok(Number.isFinite(a.score) && a.score >= 0 && a.score <= 100, `score out of range: ${a.score}`);
    assert.equal(a.band, bandFor(a.score));
    const sum = a.breakdown.reduce((s, x) => s + x.points, 0);
    assert.equal(sum, a.score, `breakdown sum ${sum} != score ${a.score}`);
    const dup = scoreIssue(norm, { likelyDuplicate: true });
    assert.ok(dup.score <= a.score && dup.score >= 0);
    assert.equal(dup.breakdown.reduce((s, x) => s + x.points, 0), dup.score);
    const cands = Array.from({ length: 5 }, (_, j) => ({ key: `PROJ-X${j}`, summary: "random words here", components: [], labels: [] }));
    const dups = findDuplicates(norm, cands);
    for (let k = 1; k < dups.length; k++) assert.ok(dups[k - 1].similarity >= dups[k].similarity, "duplicates not sorted");
    const plan = buildFixPlan({ issue: norm, score: a, duplicates: dups, suggestedAssignee: null });
    assert.ok(plan.steps.length >= 3);
    plan.steps.forEach((s, idx) => assert.equal(s.n, idx + 1));
  }
});

test("fuzz: adversarial fixtures never crash", () => {
  const hostile = [
    {},
    { key: "X-1" },
    { key: "X-2", fields: null },
    { key: "X-3", fields: { summary: null, issuetype: null, status: null, priority: null, labels: "not-an-array", components: "x", created: "garbage", updated: "garbage", comment: "x" } },
    { key: "X-4", fields: { summary: "🚀🚀🚀", issuetype: { name: "Bug" }, status: { name: "To Do" }, priority: { name: "Highest" }, labels: [], components: [], created: "2999-01-01T00:00:00.000Z", updated: "2999-01-01T00:00:00.000Z", comment: { total: -5 }, descriptionText: "x".repeat(100000) } },
    { key: "X-5", fields: { summary: "the and or of to in", issuetype: { name: "Task" }, status: { name: "Done" }, priority: { name: "Lowest" }, labels: [], components: [], created: "2026-11-23T00:00:00.000Z", updated: "2026-11-23T00:00:00.000Z", comment: { total: 0 }, descriptionText: "" } },
  ];
  for (const raw of hostile) {
    const norm = normalizeIssue(raw);
    const s = scoreIssue(norm);
    assert.ok(s.score >= 0 && s.score <= 100, `hostile ${raw.key} score ${s.score}`);
    assert.doesNotThrow(() => findDuplicates(norm, hostile.map((h) => ({ key: h.key, summary: "test" }))));
    assert.doesNotThrow(() => buildFixPlan({ issue: norm, score: s, duplicates: [], suggestedAssignee: null }));
  }
  assert.deepEqual(rankAssignees(null), []);
  assert.deepEqual(rankAssignees([{ accountId: null, name: null }])[0].name, "Unknown");
});
