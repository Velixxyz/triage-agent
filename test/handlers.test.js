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
