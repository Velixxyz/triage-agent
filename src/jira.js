// Jira Cloud REST API helpers (all calls run as the user chatting with Rovo,
// so results are permission-filtered to what that person can already see).
import api, { route } from "@forge/api";
import { adfToText } from "./scoring.js";

export const ISSUE_FIELDS = [
  "summary",
  "issuetype",
  "status",
  "priority",
  "assignee",
  "reporter",
  "labels",
  "components",
  "created",
  "updated",
  "description",
  "comment",
].join(",");

/** Read one issue by key. Returns { ok, issue, error }. */
export async function getIssue(issueKey) {
  const res = await api
    .asUser()
    .requestJira(route`/rest/api/3/issue/${issueKey}?fields=${ISSUE_FIELDS}`);
  if (res.status === 404) return { ok: false, error: `${issueKey} does not exist or you cannot see it.` };
  if (!res.ok) return { ok: false, error: `Could not read ${issueKey} (${res.status}).` };
  const issue = await res.json();
  // Flatten the ADF description once, so the scorer sees plain text.
  issue.fields.descriptionText = adfToText(issue.fields.description, 2000);
  return { ok: true, issue };
}

/**
 * Search issues with JQL (POST /rest/api/3/search/jql — the current v3 API;
 * GET /search is deprecated). Returns { ok, issues, isLast, total, error }.
 * `startAt` pages through large result sets (maxResults caps at 100/page).
 */
export async function searchIssues(jql, { fields = ISSUE_FIELDS, maxResults = 25, startAt = 0 } = {}) {
  // POST /search/jql expects `fields` as an ARRAY of strings; a
  // comma-separated string is rejected with 400 (live bug found 23 Nov 2026:
  // every duplicate search failed until this was fixed).
  const fieldList = Array.isArray(fields)
    ? fields
    : String(fields).split(",").map((f) => f.trim()).filter(Boolean);
  const res = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jql, fields: fieldList, maxResults, startAt }),
  });
  if (!res.ok) return { ok: false, issues: [], error: `Issue search failed (${res.status}).` };
  const data = await res.json();
  const issues = Array.isArray(data.issues) ? data.issues : [];
  for (const issue of issues) {
    issue.fields.descriptionText = adfToText(issue.fields.description, 500);
  }
  return {
    ok: true,
    issues,
    isLast: data.isLast !== false,
    total: typeof data.total === "number" ? data.total : null,
  };
}

// Safety cap for full-backlog fetches: 10 pages x 100 rows = 1000 issues.
// Rovo actions give up after ~20s, so an unbounded loop over a 10k-issue
// backlog would time out instead of ranking anything.
export const SEARCH_ALL_MAX_PAGES = 10;

/**
 * Fetch ALL issues matching a JQL, page by page (100 rows per request).
 * Returns { ok, issues, total, truncated, pages, partialError, error }.
 * `truncated` means more issues exist than were fetched (cap hit); the
 * caller must say so. A failed page AFTER the first does not throw the
 * ranking away: already-fetched issues are returned with `partialError`.
 */
export async function searchAllIssues(jql, { fields = ISSUE_FIELDS, pageSize = 100 } = {}) {
  const all = [];
  let total = null;
  let pages = 0;
  let lastIsLast = false;
  let partialError = null;
  for (let page = 0; page < SEARCH_ALL_MAX_PAGES; page++) {
    const startAt = page * pageSize;
    const r = await searchIssues(jql, { fields, maxResults: pageSize, startAt });
    if (!r.ok) {
      if (pages === 0) return { ok: false, issues: [], error: r.error };
      partialError = r.error;
      break;
    }
    pages += 1;
    all.push(...r.issues);
    if (typeof r.total === "number") total = r.total;
    lastIsLast = r.isLast;
    if (r.isLast || r.issues.length === 0) break;
    if (total !== null && all.length >= total) break;
  }
  const truncated = total !== null
    ? all.length < total
    : pages === SEARCH_ALL_MAX_PAGES && !lastIsLast;
  return { ok: true, issues: all, total, truncated, pages, partialError };
}

/** Recent comments on an issue, newest first. Returns { ok, comments, total, error }. */
export async function getRecentComments(issueKey, maxResults = 5) {
  const res = await api
    .asUser()
    .requestJira(route`/rest/api/3/issue/${issueKey}/comment?maxResults=${maxResults}&orderBy=-created`);
  if (!res.ok) return { ok: false, comments: [], total: 0, error: `Could not read comments (${res.status}).` };
  const data = await res.json();
  const comments = (Array.isArray(data.comments) ? data.comments : []).map((c) => ({
    author: c.author?.displayName || "Unknown",
    authorAccountId: c.author?.accountId || null,
    created: c.created,
    text: adfToText(c.body, 600),
  }));
  return { ok: true, comments, total: data.total ?? comments.length };
}

/** Resolve a Jira user by name or email. Returns { ok, accountId, name, error }. */
export async function findPerson(text) {
  const res = await api.asUser().requestJira(route`/rest/api/3/user/search?query=${text}&maxResults=5`);
  if (!res.ok) return { ok: false, error: `User search failed (${res.status}).` };
  const users = (await res.json()).filter((u) => u.accountType === "atlassian" && u.active);
  if (users.length === 0) return { ok: false, error: `No active person matches "${text}".` };
  if (users.length > 1) {
    return { ok: false, error: `"${text}" matches ${users.length} people: ${users.map((u) => u.displayName).join(", ")}. Ask which one.` };
  }
  return { ok: true, accountId: users[0].accountId, name: users[0].displayName };
}

export async function personName(accountId) {
  const res = await api.asUser().requestJira(route`/rest/api/3/user?accountId=${accountId}`);
  return res.ok ? (await res.json()).displayName : accountId;
}

/** Resolve a priority name (Highest/High/…) to its site-specific id. */
export async function priorityIdByName(name) {
  const res = await api.asUser().requestJira(route`/rest/api/3/priority`);
  if (!res.ok) return { ok: false, error: `Could not list priorities (${res.status}).` };
  const list = await res.json();
  const found = list.find((p) => p.name.toLowerCase() === String(name).toLowerCase());
  if (!found) return { ok: false, error: `No priority named "${name}". Available: ${list.map((p) => p.name).join(", ")}.` };
  return { ok: true, id: found.id, name: found.name };
}

/**
 * Apply field updates to an issue. `fields` is the Jira fields object
 * (e.g. { priority: { id }, assignee: { accountId }, labels: [...] }).
 */
export async function updateIssue(issueKey, fields) {
  const res = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) return { ok: false, error: `Could not update ${issueKey} (${res.status}).` };
  return { ok: true };
}
