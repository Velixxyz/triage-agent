// Handler wiring tests: run the real action handlers against a stubbed
// @forge/api (no network, no site). Catches wrong field names, bad JQL
// construction, missing exports and response-shape mistakes.
//
// One module mock for the whole file (module mocking needs the
// --experimental-test-module-mocks flag, see package.json). Each test swaps
// the behaviour of the stub through `jiraStub` before calling a handler.
import test, { mock } from "node:test";
import assert from "node:assert/strict";

const ISSUE_1 = {
  key: "PROJ-1",
  id: "10001",
  fields: {
    summary: "Login page crashes on submit",
    issuetype: { name: "Bug" },
    status: { name: "To Do" },
    priority: { name: "High" },
    assignee: null,
    reporter: { displayName: "Bob", accountId: "rep1" },
    labels: ["production"],
    components: [{ name: "auth" }],
    created: "2026-10-01T00:00:00.000Z",
    updated: "2026-11-20T00:00:00.000Z",
    description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Open login, press submit, app crashes." }] }] },
    comment: { total: 3, comments: [{ author: { displayName: "Ada" }, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Can anyone reproduce this?" }] }] } }] },
  },
};

const ISSUE_2 = {
  key: "PROJ-2",
  id: "10002",
  fields: {
    summary: "Add dark mode toggle",
    issuetype: { name: "Story" },
    status: { name: "To Do" },
    priority: { name: "Low" },
    assignee: { displayName: "Ada", accountId: "a1" },
    reporter: { displayName: "Bob", accountId: "rep1" },
    labels: [],
    components: [{ name: "ui" }],
    created: "2026-11-22T00:00:00.000Z",
    updated: "2026-11-22T00:00:00.000Z",
    description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Users want a dark theme option." }] }] },
    comment: { total: 0, comments: [] },
  },
};

function fakeResponse(status, json) {
  return { status, ok: status >= 200 && status < 300, json: async () => json };
}

// The stub delegates to this variable, so each test can script the fake Jira.
let jiraStub = () => fakeResponse(404, {});
const apiMock = {
  asUser: () => ({
    requestJira: (url, opts) => jiraStub(String(url), opts || {}),
    requestTeamworkGraph: async () => fakeResponse(200, { data: {} }),
  }),
};
const route = (strings, ...vals) =>
  strings.reduce((acc, s, i) => acc + s + (vals[i] !== undefined ? encodeURIComponent(vals[i]) : ""), "");

mock.module("@forge/api", { defaultExport: apiMock, namedExports: { route } });
const handlers = await import("../src/index.js");
const { normalizeIssue, scoreIssue } = await import("../src/scoring.js");

function mockIssue(key, opts = {}) {
  const {
    priority = "Low",
    type = "Story",
    created = "2026-11-22T00:00:00.000Z",
    updated = "2026-11-22T00:00:00.000Z",
    labels = [],
    assignee = { displayName: "Ada", accountId: "a1" },
    summary = "Some work",
    description = "short",
    comments = 0,
  } = opts;
  return {
    key,
    id: key,
    fields: {
      summary,
      issuetype: { name: type },
      status: { name: "To Do" },
      priority: { name: priority },
      assignee,
      reporter: { displayName: "Bob", accountId: "rep1" },
      labels,
      components: [],
      created,
      updated,
      description,
      comment: { total: comments, comments: [] },
    },
  };
}

test("triage-backlog ranks mocked issues, highest score first", async () => {
  jiraStub = (url) => {
    if (url.includes("/rest/api/3/search/jql")) {
      return fakeResponse(200, { issues: [ISSUE_1, ISSUE_2], isLast: true });
    }
    return fakeResponse(404, {});
  };
  const out = await handlers.triageBacklog({ limit: 10 });
  assert.equal(out.triagedCount, 2);
  assert.equal(out.ranked[0].key, "PROJ-1"); // old production bug outranks fresh low story
  assert.ok(out.ranked[0].score > out.ranked[1].score);
  assert.equal(out.ranked[0].score, 79); // 24 priority + 14 age + 15 bug + 6 activity + 5 desc + 5 unassigned + 10 urgency
  assert.equal(out.ranked[0].band, "High");
  assert.ok(out.ranked[0].topReasons.length > 0);
  assert.ok(!out.notes.join(" ").includes("Ties in the Top")); // distinct scores: no tie note
});

test("triage-backlog pages through 250 issues and finds the top scorer on page 3", async () => {
  const allIssues = Array.from({ length: 250 }, (_, i) => mockIssue(`MOBL-${i}`));
  // The star sits at the very end of page 3 (index 249): Highest Bug, old,
  // production label, unassigned, long description, 8 comments.
  allIssues[249] = mockIssue("MOBL-999", {
    priority: "Highest",
    type: "Bug",
    created: "2024-01-01T00:00:00.000Z",
    updated: "2024-01-01T00:00:00.000Z",
    labels: ["production"],
    assignee: null,
    description: "Billing system sends duplicate bills to customers every month.",
    comments: 8,
  });
  const seenStartAt = [];
  jiraStub = (url, opts) => {
    if (url.includes("/rest/api/3/search/jql")) {
      const body = JSON.parse(opts.body || "{}");
      seenStartAt.push(body.startAt || 0);
      const start = body.startAt || 0;
      const page = allIssues.slice(start, start + (body.maxResults || 100));
      const end = start + page.length;
      return fakeResponse(200, { issues: page, isLast: end >= allIssues.length, total: allIssues.length });
    }
    return fakeResponse(404, {});
  };
  const out = await handlers.triageBacklog({ limit: 10 });
  assert.deepEqual(seenStartAt, [0, 100, 200]); // three pages of 100
  assert.equal(out.consideredCount, 250);
  assert.equal(out.ranked[0].key, "MOBL-999");
  assert.equal(out.ranked[0].score, 98); // 30 + 15 + 10 + 15 + 8 + 5 + 5 + 10
  // 0 score mismatch vs the scoring engine directly: same issue, same score.
  const direct = scoreIssue(normalizeIssue(allIssues[249]));
  assert.equal(out.ranked[0].score, direct.score);
  assert.equal(out.ranked[0].band, direct.band);
});

test("triage-backlog breaks ties by age, then key, and says so", async () => {
  // Age/staleness points are capped for all four (created+updated far
  // enough back), so all four score identically — only ageDays and key differ.
  const tied = [
    mockIssue("TIE-37", { created: "2026-08-01T00:00:00.000Z", updated: "2026-08-01T00:00:00.000Z" }),
    mockIssue("TIE-5", { created: "2026-08-01T00:00:00.000Z", updated: "2026-08-01T00:00:00.000Z" }),
    mockIssue("TIE-9", { created: "2026-08-01T00:00:00.000Z", updated: "2026-08-01T00:00:00.000Z" }),
    mockIssue("TIE-100", { created: "2026-06-01T00:00:00.000Z", updated: "2026-06-01T00:00:00.000Z" }),
  ];
  jiraStub = (url) => {
    if (url.includes("/rest/api/3/search/jql")) {
      return fakeResponse(200, { issues: tied, isLast: true, total: 4 });
    }
    return fakeResponse(404, {});
  };
  const out = await handlers.triageBacklog({ limit: 10 });
  assert.ok(out.ranked.every((r) => r.score === out.ranked[0].score), "all four must tie on score");
  // Oldest first (TIE-100, Sep 1), then smaller key numerically (5 < 9 < 37).
  assert.deepEqual(out.ranked.map((r) => r.key), ["TIE-100", "TIE-5", "TIE-9", "TIE-37"]);
  assert.ok(out.notes.some((n) => n.includes("Ties in the Top") && n.includes("older issue first") && n.includes("smaller key")));
});

test("triage-backlog stops at the page cap and reports truncation", async () => {
  const seenStartAt = [];
  jiraStub = (url, opts) => {
    if (url.includes("/rest/api/3/search/jql")) {
      const body = JSON.parse(opts.body || "{}");
      seenStartAt.push(body.startAt || 0);
      const start = body.startAt || 0;
      return fakeResponse(200, {
        issues: Array.from({ length: 100 }, (_, i) => mockIssue(`BIG-${start + i}`)),
        isLast: false,
        total: 1500,
      });
    }
    return fakeResponse(404, {});
  };
  const out = await handlers.triageBacklog({ limit: 10 });
  assert.equal(seenStartAt.length, 10); // SEARCH_ALL_MAX_PAGES
  assert.equal(out.consideredCount, 1000);
  assert.ok(out.notes.some((n) => n.includes("Only the first 1000") && n.includes("1500 total")));
});

test("triage-backlog ranks what it fetched when a later page fails", async () => {
  jiraStub = (url, opts) => {
    if (url.includes("/rest/api/3/search/jql")) {
      const body = JSON.parse(opts.body || "{}");
      if ((body.startAt || 0) === 0) {
        return fakeResponse(200, {
          issues: Array.from({ length: 100 }, (_, i) => mockIssue(`P-${i}`)),
          isLast: false,
          total: 250,
        });
      }
      return fakeResponse(500, { errorMessages: ["boom"] });
    }
    return fakeResponse(404, {});
  };
  const out = await handlers.triageBacklog({ limit: 10 });
  assert.equal(out.consideredCount, 100);
  assert.ok(out.notes.some((n) => n.includes("Ranking is partial")));
});

test("triage-issue returns score, breakdown, duplicates and assignee", async () => {
  jiraStub = (url) => {
    if (url.includes("/rest/api/3/search/jql")) {
      return fakeResponse(200, { issues: [ISSUE_2], isLast: true });
    }
    if (url.includes("/rest/api/3/issue/PROJ-1")) {
      return fakeResponse(200, ISSUE_1);
    }
    return fakeResponse(404, {});
  };
  const out = await handlers.triageIssue({ issueKey: "PROJ-1", context: { cloudId: "cloud-1" } });
  assert.equal(out.key, "PROJ-1");
  assert.ok(out.score >= 60, `expected a high score, got ${out.score}`);
  assert.equal(out.classification, "bug");
  assert.ok(Array.isArray(out.breakdown) && out.breakdown.length > 0);
  assert.ok(Array.isArray(out.duplicates));
  assert.ok(out.suggestedAssignee === null || typeof out.suggestedAssignee.name === "string");
});

test("triage-issue without a key asks for one", async () => {
  jiraStub = () => fakeResponse(404, {});
  const out = await handlers.triageIssue({});
  assert.ok(out.error.includes("key"));
});

test("find-duplicate returns ranked matches", async () => {
  jiraStub = (url) => {
    if (url.includes("/rest/api/3/search/jql")) {
      // A near-identical issue in the same project (different key).
      return fakeResponse(200, { issues: [{ ...ISSUE_1, key: "PROJ-7" }], isLast: true });
    }
    if (url.includes("/rest/api/3/issue/PROJ-1")) {
      return fakeResponse(200, ISSUE_1);
    }
    return fakeResponse(404, {});
  };
  const out = await handlers.findDuplicate({ issueKey: "PROJ-1" });
  assert.equal(out.key, "PROJ-1");
  assert.ok(out.matches.length >= 1, "the near-identical issue should match");
  assert.equal(out.matches[0].key, "PROJ-7");
  assert.ok(out.matches[0].likelyDuplicate);
});

test("summarize-issue returns comments and open questions", async () => {
  jiraStub = (url) => {
    if (url.includes("/rest/api/3/issue/PROJ-1/comment")) {
      return fakeResponse(200, {
        total: 1,
        comments: [
          { author: { displayName: "Ada", accountId: "a1" }, created: "2026-11-21T00:00:00.000Z", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Can anyone reproduce this?" }] }] } },
        ],
      });
    }
    if (url.includes("/rest/api/3/issue/PROJ-1")) {
      return fakeResponse(200, ISSUE_1);
    }
    return fakeResponse(404, {});
  };
  const out = await handlers.summarizeIssue({ issueKey: "PROJ-1" });
  assert.equal(out.key, "PROJ-1");
  assert.equal(out.participants[0], "Ada");
  assert.equal(out.openQuestions.length, 1);
  assert.match(out.openQuestions[0].text, /reproduce/);
});

test("apply-triage applies priority + labels and reports previous values", async () => {
  const seen = [];
  jiraStub = (url, opts) => {
    seen.push({ url, method: opts.method || "GET", body: opts.body });
    if (url.includes("/rest/api/3/priority")) {
      return fakeResponse(200, [
        { id: "1", name: "Highest" },
        { id: "2", name: "High" },
        { id: "3", name: "Medium" },
        { id: "4", name: "Low" },
        { id: "5", name: "Lowest" },
      ]);
    }
    if (url.includes("/rest/api/3/issue/PROJ-1") && (opts.method || "GET") === "PUT") {
      return fakeResponse(204, null);
    }
    if (url.includes("/rest/api/3/issue/PROJ-1")) {
      return fakeResponse(200, ISSUE_1);
    }
    return fakeResponse(404, {});
  };
  const out = await handlers.applyTriage({ issueKey: "PROJ-1", priority: "Highest", addLabels: "triaged" });
  assert.equal(out.applied.priority, "Highest");
  assert.equal(out.previous.priority, "High");
  assert.deepEqual(out.applied.labelsAdded, ["triaged"]);
  const put = seen.find((c) => c.method === "PUT");
  assert.ok(put, "expected a PUT call");
  const sent = JSON.parse(put.body);
  assert.deepEqual(sent.fields.labels.sort(), ["production", "triaged"]);
  assert.equal(sent.fields.priority.id, "1");
});

test("apply-triage with nothing to apply returns an error, no PUT", async () => {
  let puts = 0;
  jiraStub = (url, opts) => {
    if ((opts.method || "GET") === "PUT") puts += 1;
    if (url.includes("/rest/api/3/issue/PROJ-1")) return fakeResponse(200, ISSUE_1);
    return fakeResponse(404, {});
  };
  const out = await handlers.applyTriage({ issueKey: "PROJ-1" });
  assert.ok(out.error.includes("Nothing to apply"));
  assert.equal(puts, 0);
});
