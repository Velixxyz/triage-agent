// Triage Agent — Rovo action handlers.
//
// Every handler returns plain JSON (never throws): Rovo writes the prose,
// the action returns the facts. Anything partial goes into `notes`, and the
// agent prompt turns that into "this may be incomplete".
// Keep responses small: Rovo actions handle ~1 MB in practice and give up
// after about 20 seconds, so lists are capped and text is truncated.

import { getIssue, searchIssues, searchAllIssues, getRecentComments, personName, priorityIdByName, updateIssue } from "./jira.js";
import { twg, twgAll, Q, userAri, workItemAri } from "./twg.js";
import { normalizeIssue, scoreIssue, findDuplicates, tokenize, compareTriageRows } from "./scoring.js";
import { rankAssignees } from "./assignee.js";
import { buildFixPlan } from "./fixplan.js";

const log = (event, data) => console.log(JSON.stringify({ triage: event, ...data }));

const askerOf = (payload) => payload?.context?.accountId || null;

function issueKeyOf(payload, inputKey) {
  const key = String(inputKey || payload?.context?.jira?.issueKey || "").trim().toUpperCase();
  return key || null;
}

function safeProjectKey(raw) {
  const key = String(raw || "").trim().toUpperCase();
  return /^[A-Z0-9]+$/.test(key) ? key : null;
}

const isOpenStatus = (status) => status && !/^(done|closed|resolved)$/i.test(status);

// --- Teamwork Graph helpers -------------------------------------------------

async function teamsOf(accountId, notes) {
  const r = await twgAll("userTeams", Q.userTeams, { userId: userAri(accountId) }, "atlassianUserInTeams");
  if (!r.ok) notes.push(`teams could not be read: ${r.error}`);
  else if (!r.complete) notes.push("team list may be incomplete");
  return r.nodes.map((t) => ({ id: t.id, name: t.displayName }));
}

async function assignedTo(accountId, notes, maxPages = 1) {
  const r = await twgAll("assignedWork", Q.assignedWork, { userId: userAri(accountId) }, "atlassianUserAssignedJiraWorkItems", maxPages);
  if (!r.ok) notes.push(`assigned work could not be read: ${r.error}`);
  else if (!r.complete) notes.push(`showing the first ${r.nodes.length} assigned work items; there are more`);
  return r.nodes.map((n) => ({ key: n.key, summary: n.summary, status: n.status?.name || null, webUrl: n.webUrl }));
}

// Full assignee suggestion for one issue, from Teamwork Graph:
// recent commenters (90d) + members of the reporter's teams, ranked by
// activity, team overlap and current open workload.
async function suggestAssigneesFor(issue, cloudId, notes) {
  const norm = normalizeIssue(issue);
  const ari = cloudId && issue.id ? workItemAri(cloudId, issue.id) : null;
  const candidates = new Map();
  const add = (c) => {
    if (!c?.accountId) return;
    const prev = candidates.get(c.accountId) || { accountId: c.accountId, name: c.name, commentCount90d: 0 };
    candidates.set(c.accountId, { ...prev, ...c, commentCount90d: Math.max(prev.commentCount90d, c.commentCount90d || 0) });
  };

  // 1. People who commented on this issue in the last 90 days.
  let commenters = [];
  if (ari) {
    const r = await twgAll("workItemComments", Q.workItemComments, { id: ari, since: "P90D" }, "jiraWorkItemComments");
    if (!r.ok) notes.push(`recent commenters could not be read: ${r.error}`);
    else {
      const byAuthor = new Map();
      const now = Date.now();
      for (const c of r.nodes) {
        const id = c.author?.accountId;
        if (!id) continue;
        const row = byAuthor.get(id) || { accountId: id, name: c.author?.name || id, commentCount90d: 0, commentedLast14d: false };
        row.commentCount90d += 1;
        if (c.createdAt && now - Date.parse(c.createdAt) < 14 * 86400000) row.commentedLast14d = true;
        byAuthor.set(id, row);
      }
      commenters = [...byAuthor.values()];
      for (const c of commenters) add(c);
    }
  }

  // 2. Members of the reporter's teams (cap 8), each with their open load.
  const reporterId = norm.reporterAccountId;
  if (reporterId) {
    const teams = await teamsOf(reporterId, notes);
    const members = [];
    for (const t of teams.slice(0, 3)) {
      const m = await twgAll("teamMembers", Q.teamMembers, { teamAri: t.id }, "atlassianTeamMembers", 1);
      if (m.ok) for (const u of m.nodes) members.push(u);
    }
    const unique = [...new Map(members.map((m) => [m.accountId, m])).values()].slice(0, 8);
    const workloads = await Promise.all(unique.map((m) => assignedTo(m.accountId, notes, 1)));
    unique.forEach((m, i) => {
      const open = (workloads[i] || []).filter((w) => isOpenStatus(w.status));
      add({ accountId: m.accountId, name: m.name, openAssignedCount: open.length, sameTeamAsReporter: true });
    });
  }

  // 3. Current assignee + reporter as continuity candidates.
  if (norm.assigneeAccountId) add({ accountId: norm.assigneeAccountId, name: norm.assignee });
  if (reporterId) add({ accountId: reporterId, name: norm.reporter });

  // 4. Measure the open workload of the top commenters too — otherwise a
  //    frequent commenter with 20 open items would look free (count 0).
  const unmeasured = [...candidates.values()]
    .filter((c) => c.openAssignedCount === undefined)
    .sort((a, b) => (b.commentCount90d || 0) - (a.commentCount90d || 0))
    .slice(0, 3);
  const loads = await Promise.all(unmeasured.map((c) => assignedTo(c.accountId, notes, 1)));
  unmeasured.forEach((c, i) => {
    const open = (loads[i] || []).filter((w) => isOpenStatus(w.status));
    c.openAssignedCount = open.length;
  });

  // Fill open counts for commenters we have not measured yet (cap 4 extra calls).
  const ranked = rankAssignees([...candidates.values()], {
    reporterAccountId: reporterId,
    currentAssigneeAccountId: norm.assigneeAccountId,
  });
  return ranked.slice(0, 3);
}

// --- Duplicate search --------------------------------------------------------

async function duplicatesFor(issue, notes) {
  const norm = normalizeIssue(issue);
  const tokens = [...tokenize(`${norm.summary} ${norm.descriptionText}`)].slice(0, 6);
  if (tokens.length === 0) return [];
  const project = safeProjectKey((issue.key || "").split("-")[0]);
  const clauses = tokens.map((t) => `summary ~ "${t}"`).join(" OR ");
  const jql = project ? `project = ${project} AND (${clauses})` : `(${clauses})`;
  const r = await searchIssues(jql, { fields: "summary,labels,components", maxResults: 20 });
  if (!r.ok) {
    notes.push(`duplicate search failed: ${r.error}`);
    return [];
  }
  const candidates = r.issues.map((i) => ({
    key: i.key,
    summary: i.fields.summary,
    descriptionText: "",
    components: (i.fields.components || []).map((c) => c.name),
    labels: i.fields.labels || [],
  }));
  return findDuplicates(norm, candidates);
}

// --- Action 1: triage the backlog -------------------------------------------

export async function triageBacklog(payload) {
  const t0 = Date.now();
  const notes = [];
  try {
    const limit = Math.max(1, Math.min(25, Number(payload?.limit) || 10));
    const projectKey = safeProjectKey(payload?.projectKey);
    // Rank across ALL open issues, not just the most recently updated ones:
    // fetching only `limit` rows with ORDER BY updated DESC silently drops
    // high-scoring stale items (live bug found 23 Nov 2026: MOBL-37 scored
    // 71 but never appeared in the Top 10 because it had not been updated
    // in 991 days). searchAllIssues pages through the whole backlog
    // (100/page, capped at 1000 issues so a giant backlog cannot blow the
    // ~20s action budget); the cap/truncation is reported in `notes`.
    const jql = projectKey
      ? `project = ${projectKey} AND statusCategory != Done`
      : `statusCategory != Done`;
    const r = await searchAllIssues(jql);
    if (!r.ok) return { error: r.error };

    const rows = r.issues.map((raw) => {
      const issue = normalizeIssue(raw);
      const s = scoreIssue(issue);
      const lastCommenter = raw.fields.comment?.comments?.length
        ? raw.fields.comment.comments[raw.fields.comment.comments.length - 1]?.author?.displayName
        : null;
      return {
        key: issue.key,
        summary: (issue.summary || "").slice(0, 120),
        score: s.score,
        band: s.band,
        classification: s.classification,
        topReasons: s.breakdown
          .slice()
          .sort((a, b) => b.points - a.points)
          .slice(0, 3)
          .map((b) => b.reason),
        assignee: issue.assignee,
        lastCommenter: lastCommenter || null,
        status: issue.status,
        ageDays: issue.ageDays,
      };
    });
    rows.sort(compareTriageRows);
    const ranked = rows.slice(0, limit);
    // Ties are broken deterministically (older issue first, then smaller
    // key) — say so in the output when the returned Top N actually had one.
    let ties = 0;
    for (let i = 1; i < ranked.length; i++) if (ranked[i].score === ranked[i - 1].score) ties += 1;
    if (ties > 0) {
      notes.push(`Ties in the Top ${ranked.length} were broken deterministically: older issue first, then smaller key (e.g. PROJ-5 before PROJ-37).`);
    }
    if (r.partialError) {
      notes.push(`Ranking is partial: an issue page failed to load (${r.partialError}).`);
    } else if (r.truncated) {
      notes.push(`Only the first ${r.issues.length} open issues were ranked; the backlog has more${r.total ? ` (${r.total} total)` : ""}.`);
    }
    log("triage-backlog", { ms: Date.now() - t0, project: projectKey, rows: rows.length });
    return {
      project: projectKey,
      consideredCount: rows.length,
      triagedCount: Math.min(limit, rows.length),
      ranked,
      notes: [
        ...notes,
        "Scores are deterministic (priority, age, staleness, type, activity, description, assignment, urgency). Call triage-issue on a key for duplicates and a Teamwork Graph assignee suggestion.",
      ],
    };
  } catch (e) {
    return { error: `Triage failed: ${String(e?.message || e)}` };
  }
}

// --- Action 2: triage one issue ---------------------------------------------

export async function triageIssue(payload) {
  const t0 = Date.now();
  const notes = [];
  try {
    const key = issueKeyOf(payload, payload?.issueKey);
    if (!key) return { error: "Which work item? Give me a key such as PROJ-123." };
    const got = await getIssue(key);
    if (!got.ok) return { error: got.error };
    const duplicates = await duplicatesFor(got.issue, notes);
    const likelyDuplicate = duplicates.some((d) => d.likelyDuplicate);
    const s = scoreIssue(normalizeIssue(got.issue), { likelyDuplicate });
    const assignees = await suggestAssigneesFor(got.issue, payload?.context?.cloudId, notes);
    log("triage-issue", { ms: Date.now() - t0, key, score: s.score, duplicates: duplicates.length });
    return {
      key,
      summary: got.issue.fields.summary,
      score: s.score,
      band: s.band,
      classification: s.classification,
      breakdown: s.breakdown,
      duplicates: duplicates.slice(0, 3),
      suggestedAssignee: assignees[0] || null,
      otherCandidates: assignees.slice(1, 3),
      notes: [...new Set(notes)],
    };
  } catch (e) {
    return { error: `Triage failed: ${String(e?.message || e)}` };
  }
}

// --- Action 3: summarize one issue ------------------------------------------

export async function summarizeIssue(payload) {
  const t0 = Date.now();
  const notes = [];
  try {
    const key = issueKeyOf(payload, payload?.issueKey);
    if (!key) return { error: "Which work item? Give me a key such as PROJ-123." };
    const got = await getIssue(key);
    if (!got.ok) return { error: got.error };
    const norm = normalizeIssue(got.issue);
    const comments = await getRecentComments(key, 5);
    if (!comments.ok) notes.push(comments.error);
    const openQuestions = comments.comments.filter((c) => c.text.trim().endsWith("?")).map((c) => ({ by: c.author, text: c.text.slice(0, 200) }));
    const participants = [...new Set(comments.comments.map((c) => c.author))];
    log("summarize-issue", { ms: Date.now() - t0, key, comments: comments.comments.length });
    return {
      key,
      summary: norm.summary,
      type: norm.type,
      status: norm.status,
      priority: norm.priority,
      assignee: norm.assignee,
      reporter: norm.reporter,
      ageDays: norm.ageDays,
      labels: norm.labels,
      components: norm.components,
      description: (norm.descriptionText || "").slice(0, 800),
      recentComments: comments.comments.map((c) => ({ by: c.author, at: c.created, text: c.text })),
      totalComments: comments.total,
      participants,
      openQuestions,
      notes,
    };
  } catch (e) {
    return { error: `Summary failed: ${String(e?.message || e)}` };
  }
}

// --- Action 4: find duplicates ----------------------------------------------

export async function findDuplicate(payload) {
  const t0 = Date.now();
  const notes = [];
  try {
    const key = issueKeyOf(payload, payload?.issueKey);
    if (!key) return { error: "Which work item? Give me a key such as PROJ-123." };
    const got = await getIssue(key);
    if (!got.ok) return { error: got.error };
    const duplicates = await duplicatesFor(got.issue, notes);
    log("find-duplicate", { ms: Date.now() - t0, key, matches: duplicates.length });
    return { key, summary: got.issue.fields.summary, matches: duplicates.slice(0, 5), notes };
  } catch (e) {
    return { error: `Duplicate search failed: ${String(e?.message || e)}` };
  }
}

// --- Action 5: draft a fix plan --------------------------------------------

export async function draftFixPlan(payload) {
  const t0 = Date.now();
  const notes = [];
  try {
    const key = issueKeyOf(payload, payload?.issueKey);
    if (!key) return { error: "Which work item? Give me a key such as PROJ-123." };
    const got = await getIssue(key);
    if (!got.ok) return { error: got.error };
    const duplicates = await duplicatesFor(got.issue, notes);
    const likelyDuplicate = duplicates.some((d) => d.likelyDuplicate);
    const s = scoreIssue(normalizeIssue(got.issue), { likelyDuplicate });
    const assignees = await suggestAssigneesFor(got.issue, payload?.context?.cloudId, notes);
    const plan = buildFixPlan({
      issue: normalizeIssue(got.issue),
      score: s,
      duplicates,
      suggestedAssignee: assignees[0] || null,
    });
    log("draft-fix-plan", { ms: Date.now() - t0, key, steps: plan.steps.length });
    return { ...plan, notes: [...new Set(notes)] };
  } catch (e) {
    return { error: `Fix plan failed: ${String(e?.message || e)}` };
  }
}

// --- Action 6: suggest an assignee ------------------------------------------

export async function suggestAssignee(payload) {
  const t0 = Date.now();
  const notes = [];
  try {
    const key = issueKeyOf(payload, payload?.issueKey);
    if (!key) return { error: "Which work item? Give me a key such as PROJ-123." };
    const got = await getIssue(key);
    if (!got.ok) return { error: got.error };
    const assignees = await suggestAssigneesFor(got.issue, payload?.context?.cloudId, notes);
    log("suggest-assignee", { ms: Date.now() - t0, key, candidates: assignees.length });
    return { key, summary: got.issue.fields.summary, suggestions: assignees, notes: [...new Set(notes)] };
  } catch (e) {
    return { error: `Assignee suggestion failed: ${String(e?.message || e)}` };
  }
}

// --- Action 7: apply triage (the only write action) --------------------------

export async function applyTriage(payload) {
  const t0 = Date.now();
  try {
    const key = issueKeyOf(payload, payload?.issueKey);
    if (!key) return { error: "Which work item? Give me a key such as PROJ-123." };
    const got = await getIssue(key);
    if (!got.ok) return { error: got.error };
    const norm = normalizeIssue(got.issue);
    const fields = {};
    const applied = {};
    const previous = {};

    if (payload?.priority) {
      const p = await priorityIdByName(payload.priority);
      if (!p.ok) return { error: p.error };
      fields.priority = { id: p.id };
      applied.priority = p.name;
      previous.priority = norm.priority;
    }
    if (payload?.assigneeAccountId) {
      const name = await personName(payload.assigneeAccountId);
      fields.assignee = { accountId: payload.assigneeAccountId };
      applied.assignee = name;
      previous.assignee = norm.assignee;
    }
    if (payload?.addLabels) {
      const extra = String(payload.addLabels)
        .split(",")
        .map((l) => l.trim().toLowerCase().replace(/[^a-z0-9-_]/g, ""))
        .filter(Boolean);
      if (extra.length > 0) {
        const merged = [...new Set([...(norm.labels || []).map((l) => l.toLowerCase()), ...extra])];
        fields.labels = merged;
        applied.labelsAdded = extra;
        previous.labels = norm.labels;
      }
    }
    if (Object.keys(fields).length === 0) {
      return { error: "Nothing to apply: give a priority, an assignee, or labels to add." };
    }
    const updated = await updateIssue(key, fields);
    if (!updated.ok) return { error: updated.error };
    log("apply-triage", { ms: Date.now() - t0, key, applied: Object.keys(applied) });
    return { key, applied, previous, note: "Applied. The issue now carries the triage decision." };
  } catch (e) {
    return { error: `Apply failed: ${String(e?.message || e)}` };
  }
}
