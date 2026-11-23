import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeIssue,
  scoreIssue,
  bandFor,
  classifyIssue,
  findDuplicates,
  tokenize,
  jaccard,
  adfToText,
  daysBetween,
  compareIssueKeys,
  compareTriageRows,
} from "../src/scoring.js";

const NOW = "2026-11-23T00:00:00.000Z";

function jiraIssue(overrides = {}) {
  return {
    key: "PROJ-1",
    fields: {
      summary: "Login page crashes on submit",
      issuetype: { name: "Bug" },
      status: { name: "To Do" },
      priority: { name: "High" },
      assignee: { displayName: "Ada", accountId: "a1" },
      reporter: { displayName: "Bob", accountId: "b1" },
      labels: [],
      components: [{ name: "auth" }],
      created: "2026-11-20T00:00:00.000Z",
      updated: "2026-11-22T00:00:00.000Z",
      comment: { total: 2, comments: [] },
      descriptionText: "Steps to reproduce: open login, press submit, app crashes.",
      ...overrides,
    },
  };
}

test("daysBetween handles valid and invalid dates", () => {
  assert.equal(daysBetween("2026-11-20T00:00:00.000Z", NOW), 3);
  assert.equal(daysBetween("not-a-date", NOW), 0);
  assert.equal(daysBetween(NOW, "2026-11-20T00:00:00.000Z"), 0); // never negative
});

test("score is deterministic for the same issue", () => {
  const a = scoreIssue(normalizeIssue(jiraIssue(), NOW));
  const b = scoreIssue(normalizeIssue(jiraIssue(), NOW));
  assert.deepEqual(a, b);
});

test("priority drives the biggest swing", () => {
  const high = scoreIssue(normalizeIssue(jiraIssue({ priority: { name: "Highest" } }), NOW));
  const low = scoreIssue(normalizeIssue(jiraIssue({ priority: { name: "Lowest" } }), NOW));
  assert.equal(high.score - low.score, 26); // 30 - 4
});

test("missing priority scores as 10, not zero", () => {
  const r = scoreIssue(normalizeIssue(jiraIssue({ priority: null }), NOW));
  assert.equal(r.breakdown.find((b) => b.rule === "priority").points, 10);
});

test("old stale unassigned bug scores Critical", () => {
  const r = scoreIssue(
    normalizeIssue(
      jiraIssue({
        priority: { name: "Highest" },
        created: "2026-09-01T00:00:00.000Z",
        updated: "2026-09-10T00:00:00.000Z",
        assignee: null,
        labels: ["production"],
        comment: { total: 8, comments: [] },
      }),
      NOW,
    ),
  );
  assert.equal(r.band, "Critical");
  assert.ok(r.score >= 80 && r.score <= 100);
});

test("fresh low-priority task with no description scores Low/Backlog", () => {
  const r = scoreIssue(
    normalizeIssue(
      jiraIssue({
        issuetype: { name: "Task" },
        priority: { name: "Lowest" },
        created: "2026-11-23T00:00:00.000Z",
        updated: "2026-11-23T00:00:00.000Z",
        assignee: { displayName: "Ada", accountId: "a1" },
        comment: { total: 0, comments: [] },
        descriptionText: "",
        summary: "Rename a button",
      }),
      NOW,
    ),
  );
  // type Task 8 + priority 4 + desc 0 + assigned 0 = 12
  assert.equal(r.score, 12);
  assert.equal(r.band, "Backlog");
});

test("empty issue object does not crash and scores in range", () => {
  const r = scoreIssue(normalizeIssue({}, NOW));
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.equal(r.classification, "task");
});

test("duplicate penalty subtracts 10 and floors at 0", () => {
  const base = scoreIssue(normalizeIssue(jiraIssue(), NOW));
  const dup = scoreIssue(normalizeIssue(jiraIssue(), NOW), { likelyDuplicate: true });
  assert.equal(dup.score, base.score - 10);
  const tiny = scoreIssue(normalizeIssue(jiraIssue({ priority: { name: "Lowest" }, issuetype: { name: "Task" } }), NOW), {
    likelyDuplicate: true,
  });
  assert.ok(tiny.score >= 0);
});

test("bands cover the full range", () => {
  assert.equal(bandFor(100), "Critical");
  assert.equal(bandFor(80), "Critical");
  assert.equal(bandFor(79), "High");
  assert.equal(bandFor(60), "High");
  assert.equal(bandFor(59), "Medium");
  assert.equal(bandFor(40), "Medium");
  assert.equal(bandFor(39), "Low");
  assert.equal(bandFor(20), "Low");
  assert.equal(bandFor(19), "Backlog");
  assert.equal(bandFor(0), "Backlog");
});

test("classification uses type first, then keywords", () => {
  assert.equal(classifyIssue({ type: "Bug", summary: "x", descriptionText: "" }), "bug");
  assert.equal(classifyIssue({ type: "Task", summary: "App crashes on startup", descriptionText: "" }), "bug");
  assert.equal(classifyIssue({ type: "Task", summary: "Update the README docs", descriptionText: "" }), "docs");
  assert.equal(classifyIssue({ type: "Story", summary: "Add export button", descriptionText: "" }), "feature");
  assert.equal(classifyIssue({ type: "Epic", summary: "Q1 platform work", descriptionText: "" }), "epic");
});

test("tokenize drops stopwords and short words", () => {
  const t = tokenize("The login page crashes when the user submits the form");
  assert.ok(!t.has("the"));
  assert.ok(!t.has("when"));
  assert.ok(t.has("login"));
  assert.ok(t.has("crashes"));
  assert.ok(t.has("submits"));
});

test("jaccard is 0 for disjoint sets and 1 for identical", () => {
  assert.equal(jaccard(new Set(["a", "b"]), new Set(["c"])), 0);
  assert.equal(jaccard(new Set(["a", "b"]), new Set(["a", "b"])), 1);
  assert.equal(jaccard(new Set(), new Set(["a"])), 0);
});

test("findDuplicates ranks true duplicates first and skips self", () => {
  const issue = normalizeIssue(jiraIssue(), NOW);
  const candidates = [
    { key: "PROJ-1", summary: "Login page crashes on submit", components: ["auth"], labels: [] },
    {
      key: "PROJ-7",
      summary: "Login page crashes on submit",
      descriptionText: "Steps to reproduce: open login, press submit, app crashes.",
      components: ["auth"],
      labels: [],
    },
    { key: "PROJ-8", summary: "Login page crashes when submitting credentials", components: ["auth"], labels: [] },
    { key: "PROJ-9", summary: "Dark mode toggle for settings page", components: ["ui"], labels: [] },
  ];
  const out = findDuplicates(issue, candidates);
  assert.equal(out[0].key, "PROJ-7");
  assert.ok(out[0].likelyDuplicate);
  assert.ok(out[0].similarity >= 0.55);
  // Related but not identical: listed, but not flagged as a likely duplicate.
  const mid = out.find((d) => d.key === "PROJ-8");
  assert.ok(mid);
  assert.ok(mid.similarity >= 0.35 && mid.similarity < 0.55);
  assert.equal(mid.likelyDuplicate, false);
  assert.ok(!out.some((d) => d.key === "PROJ-1"));
  assert.ok(!out.some((d) => d.key === "PROJ-9"));
});

test("findDuplicates returns empty for unrelated candidates", () => {
  const issue = normalizeIssue(jiraIssue(), NOW);
  const out = findDuplicates(issue, [
    { key: "PROJ-9", summary: "Dark mode toggle for settings page", components: ["ui"], labels: [] },
  ]);
  assert.equal(out.length, 0);
});

test("adfToText extracts text and bounds length", () => {
  const adf = {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }] },
      { type: "paragraph", content: [{ type: "text", text: "Second line" }] },
    ],
  };
  assert.equal(adfToText(adf), "Hello world Second line");
  assert.equal(adfToText("plain string"), "plain string");
  assert.equal(adfToText(null), "");
  assert.equal(adfToText({ type: "doc", content: [{ type: "text", text: "x".repeat(5000) }] }).length, 2000);
});

test("urgency labels and blocked status raise the score", () => {
  const plain = scoreIssue(normalizeIssue(jiraIssue(), NOW));
  const urgent = scoreIssue(normalizeIssue(jiraIssue({ labels: ["sev1"] }), NOW));
  assert.equal(urgent.score - plain.score, 10);
  const blocked = scoreIssue(normalizeIssue(jiraIssue({ status: { name: "Blocked" } }), NOW));
  assert.ok(blocked.score > plain.score);
});

test("compareIssueKeys orders numbers numerically within a project", () => {
  assert.ok(compareIssueKeys("PROJ-5", "PROJ-37") < 0); // 5 < 37, not "37" < "5"
  assert.ok(compareIssueKeys("PROJ-37", "PROJ-5") > 0);
  assert.equal(compareIssueKeys("PROJ-5", "PROJ-5"), 0);
  assert.equal(compareIssueKeys("PROJ-05", "PROJ-5"), -1); // same number, different padding: lexical fallback
  assert.ok(compareIssueKeys("AAA-1", "BBB-1") < 0);
  assert.ok(compareIssueKeys("PROJ-X", "PROJ-Y") < 0);
  assert.equal(compareIssueKeys(null, null), 0);
  assert.ok(compareIssueKeys(null, "PROJ-1") < 0);
});

test("compareTriageRows: score first, then older, then smaller key", () => {
  const row = (key, score, ageDays) => ({ key, score, ageDays });
  // Score dominates everything.
  assert.ok(compareTriageRows(row("A-1", 80, 1), row("A-2", 70, 900)) < 0);
  // Equal score: older issue first.
  assert.ok(compareTriageRows(row("A-1", 50, 90), row("A-2", 50, 5)) < 0);
  assert.ok(compareTriageRows(row("A-2", 50, 5), row("A-1", 50, 90)) > 0);
  // Equal score and age: smaller key first, numerically.
  assert.ok(compareTriageRows(row("MOBL-5", 50, 10), row("MOBL-37", 50, 10)) < 0);
  assert.ok(compareTriageRows(row("MOBL-37", 50, 10), row("MOBL-5", 50, 10)) > 0);
  assert.equal(compareTriageRows(row("MOBL-5", 50, 10), row("MOBL-5", 50, 10)), 0);
  // Missing fields do not crash and behave as 0 / empty key.
  assert.equal(compareTriageRows({}, {}), 0);
  assert.ok(compareTriageRows({ score: 10 }, { score: 10, ageDays: 5 }) > 0);
});

test("compareTriageRows is a total order: shuffled input sorts identically", () => {
  const rows = [
    { key: "MOBL-37", score: 71, ageDays: 991 },
    { key: "MOBL-5", score: 50, ageDays: 3 },
    { key: "MOBL-51", score: 55, ageDays: 40 },
    { key: "MOBL-32", score: 55, ageDays: 40 },
    { key: "MOBL-8", score: 55, ageDays: 12 },
    { key: "MOBL-20", score: 53, ageDays: 900 },
  ];
  const sorted = [...rows].sort(compareTriageRows).map((r) => r.key);
  // 71 first; the three 55s: older (40d) before 12d, then MOBL-32 before MOBL-51 by key.
  assert.deepEqual(sorted, ["MOBL-37", "MOBL-32", "MOBL-51", "MOBL-8", "MOBL-20", "MOBL-5"]);
  const reversed = [...rows].reverse().sort(compareTriageRows).map((r) => r.key);
  assert.deepEqual(reversed, sorted);
});
