// Triage Agent — deterministic, explainable priority scoring.
//
// No LLM is involved here: every point comes from a documented rule over
// issue fields, so the same issue always gets the same score and the agent
// can show exactly why. Weights sum to 100; a likely-duplicate finding
// subtracts 10 afterwards (floor 0).
//
//   priority      30   Jira priority (Highest 30 … Lowest 4, none 10)
//   age           15   +2 per full week open, capped at 15
//   staleness     10   +2 per full week without an update, capped at 10
//   type          15   Bug 15, Task/Story 8, Epic 5, Sub-task 5, other 6
//   activity      10   comments 0–8 + blocked label/status 2
//   description    5   usable description (>= 20 chars) present
//   unassigned     5   no assignee yet
//   urgency flag  10   blocked/customer/sev1/production/urgent/p0/critical label
//
// Bands: >= 80 Critical, 60–79 High, 40–59 Medium, 20–39 Low, < 20 Backlog.

export const WEIGHTS = {
  priority: 30,
  age: 15,
  staleness: 10,
  type: 15,
  activity: 10,
  description: 5,
  unassigned: 5,
  urgencyFlag: 10,
};

export const DUPLICATE_PENALTY = 10;

const PRIORITY_POINTS = {
  Highest: 30,
  High: 24,
  Medium: 15,
  Low: 8,
  Lowest: 4,
};

const TYPE_POINTS = {
  Bug: 15,
  Task: 8,
  Story: 8,
  Epic: 5,
  "Sub-task": 5,
};

const URGENCY_LABELS = new Set([
  "blocked",
  "blocker",
  "customer",
  "sev1",
  "sev-1",
  "production",
  "prod",
  "urgent",
  "p0",
  "critical",
  "outage",
]);

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with",
  "when", "after", "before", "not", "no", "is", "are", "was", "were", "be",
  "it", "its", "this", "that", "please", "should", "would", "could", "can",
  "we", "our", "you", "your", "i", "as", "at", "by", "from", "into", "up",
  "down", "out", "over", "under", "again", "then", "than", "but", "so",
]);

export function daysBetween(fromIso, toIso) {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.floor((to - from) / 86400000));
}

function weekPoints(days, cap) {
  return Math.min(cap, Math.floor(days / 7) * 2);
}

function commentPoints(count) {
  if (count <= 0) return 0;
  if (count <= 2) return 3;
  if (count <= 5) return 6;
  return 8;
}

/** Normalize a raw Jira issue (REST shape) into the flat form the scorer uses. */
export function normalizeIssue(issue, nowIso = new Date().toISOString()) {
  const f = issue?.fields || {};
  const labels = Array.isArray(f.labels) ? f.labels.map((l) => String(l)) : [];
  const components = Array.isArray(f.components)
    ? f.components.map((c) => c?.name).filter(Boolean)
    : [];
  return {
    key: issue?.key || null,
    summary: typeof f.summary === "string" ? f.summary : "",
    type: f.issuetype?.name || "Unknown",
    status: f.status?.name || "Unknown",
    priority: f.priority?.name || null,
    assignee: f.assignee?.displayName || null,
    assigneeAccountId: f.assignee?.accountId || null,
    reporter: f.reporter?.displayName || null,
    reporterAccountId: f.reporter?.accountId || null,
    labels,
    components,
    created: f.created || null,
    updated: f.updated || null,
    ageDays: f.created ? daysBetween(f.created, nowIso) : 0,
    staleDays: f.updated ? daysBetween(f.updated, nowIso) : 0,
    commentCount: f.comment?.total ?? (Array.isArray(f.comment?.comments) ? f.comment.comments.length : 0),
    descriptionText: f.descriptionText || "",
  };
}

export function hasUrgencyFlag(issue) {
  const labels = (issue.labels || []).map((l) => l.toLowerCase());
  if (labels.some((l) => URGENCY_LABELS.has(l))) return true;
  return /blocked/i.test(issue.status || "");
}

export function classifyIssue(issue) {
  const type = (issue.type || "").toLowerCase();
  const text = `${issue.summary || ""} ${issue.descriptionText || ""}`.toLowerCase();
  if (type === "bug") return "bug";
  if (type === "epic") return "epic";
  if (type === "sub-task" || type === "subtask") return "sub-task";
  if (/\b(crash\w*|error\w*|fail\w*|exception|broken|regression|bug|500|404|timeout)\b/.test(text)) {
    return "bug";
  }
  if (/\b(doc|docs|documentation|readme|guide)\b/.test(text)) return "docs";
  if (type === "story") return "feature";
  if (type === "task") return "task";
  return "task";
}

/**
 * Score one normalized issue. Returns { score, band, classification, breakdown[] }.
 * breakdown entries: { rule, points, reason } — shown to the user as the "why".
 * `likelyDuplicate` (bool) applies the -10 duplicate penalty.
 */
export function scoreIssue(issue, { likelyDuplicate = false } = {}) {
  const breakdown = [];
  const add = (rule, points, reason) => {
    if (points !== 0) breakdown.push({ rule, points, reason });
  };

  const priorityPoints = issue.priority ? (PRIORITY_POINTS[issue.priority] ?? 10) : 10;
  add("priority", priorityPoints, `Priority ${issue.priority || "unset"} (+${priorityPoints})`);

  const agePoints = weekPoints(issue.ageDays || 0, WEIGHTS.age);
  add("age", agePoints, `Open ${issue.ageDays || 0} day(s) (+${agePoints})`);

  const stalePoints = weekPoints(issue.staleDays || 0, WEIGHTS.staleness);
  add("staleness", stalePoints, `No update for ${issue.staleDays || 0} day(s) (+${stalePoints})`);

  const typePoints = TYPE_POINTS[issue.type] ?? 6;
  add("type", typePoints, `Type ${issue.type} (+${typePoints})`);

  let activityPoints = commentPoints(issue.commentCount || 0);
  const blocked = /blocked/i.test(issue.status || "") || (issue.labels || []).some((l) => l.toLowerCase() === "blocked");
  if (blocked) activityPoints += 2;
  add("activity", activityPoints, `${issue.commentCount || 0} comment(s)${blocked ? ", blocked" : ""} (+${activityPoints})`);

  const descPoints = (issue.descriptionText || "").trim().length >= 20 ? WEIGHTS.description : 0;
  add("description", descPoints, descPoints ? "Description present (+5)" : "No usable description (+0)");

  const unassignedPoints = issue.assignee ? 0 : WEIGHTS.unassigned;
  add("unassigned", unassignedPoints, issue.assignee ? `Assigned to ${issue.assignee} (+0)` : "Unassigned (+5)");

  const urgencyPoints = hasUrgencyFlag(issue) ? WEIGHTS.urgencyFlag : 0;
  add("urgencyFlag", urgencyPoints, urgencyPoints ? "Urgency label present (+10)" : "No urgency label (+0)");

  let score = breakdown.reduce((sum, b) => sum + b.points, 0);
  if (likelyDuplicate) {
    score -= DUPLICATE_PENALTY;
    breakdown.push({ rule: "duplicate", points: -DUPLICATE_PENALTY, reason: "Likely duplicate of another issue (-10)" });
  }
  score = Math.max(0, Math.min(100, score));

  return { score, band: bandFor(score), classification: classifyIssue(issue), breakdown };
}

export function bandFor(score) {
  if (score >= 80) return "Critical";
  if (score >= 60) return "High";
  if (score >= 40) return "Medium";
  if (score >= 20) return "Low";
  return "Backlog";
}

/**
 * Deterministic key order: same project prefix compares numerically on the
 * trailing number (PROJ-5 < PROJ-37); anything else falls back to plain
 * code-unit order. No locale dependence, so the order is identical on
 * every run and every runtime.
 */
export function compareIssueKeys(a, b) {
  const ka = a ? String(a) : "";
  const kb = b ? String(b) : "";
  if (ka === kb) return 0;
  const ma = ka.match(/^(.*?)(\d+)$/);
  const mb = kb.match(/^(.*?)(\d+)$/);
  if (ma && mb && ma[1] === mb[1]) {
    const na = Number(ma[2]);
    const nb = Number(mb[2]);
    if (na !== nb) return na < nb ? -1 : 1;
    // Same number, different zero-padding (PROJ-001 vs PROJ-1): fall back
    // to lexical order so distinct keys never compare equal.
    return ka < kb ? -1 : 1;
  }
  return ka < kb ? -1 : 1;
}

/**
 * Ranking order for triage rows { score, ageDays, key }: highest score
 * first; ties go to the older issue (more days open); remaining ties go
 * to the smaller key. A total order, so the Top 10 is identical on
 * every run instead of depending on fetch order.
 */
export function compareTriageRows(a, b) {
  const scoreDiff = (b?.score || 0) - (a?.score || 0);
  if (scoreDiff !== 0) return scoreDiff;
  const ageDiff = (b?.ageDays || 0) - (a?.ageDays || 0);
  if (ageDiff !== 0) return ageDiff;
  return compareIssueKeys(a?.key, b?.key);
}

/** Tokenize text for duplicate similarity: lowercase words, minus stopwords. */
export function tokenize(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/** Jaccard similarity between two token sets (0–1). */
export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Rank candidate duplicates for one issue. Each candidate: { key, summary, components, labels }.
 * Returns matches sorted by similarity desc, each { key, summary, similarity, sharedTokens, sameComponent }.
 * Threshold 0.35 to list, 0.55+ counts as "likely duplicate".
 */
export function findDuplicates(issue, candidates) {
  const baseTokens = tokenize(`${issue.summary || ""} ${issue.descriptionText || ""}`);
  const baseComponents = new Set((issue.components || []).map((c) => c.toLowerCase()));
  const baseLabels = new Set((issue.labels || []).map((l) => l.toLowerCase()));
  const results = [];
  for (const c of candidates || []) {
    if (!c || c.key === issue.key) continue;
    const tokens = tokenize(`${c.summary || ""} ${c.descriptionText || ""}`);
    let sim = jaccard(baseTokens, tokens);
    const sharedTokens = [...baseTokens].filter((w) => tokens.has(w));
    const sameComponent = (c.components || []).some((x) => baseComponents.has(String(x).toLowerCase()));
    const sameLabel = (c.labels || []).some((x) => baseLabels.has(String(x).toLowerCase()));
    if (sameComponent) sim = Math.min(1, sim + 0.1);
    if (sameLabel) sim = Math.min(1, sim + 0.05);
    if (sim >= 0.35) {
      results.push({
        key: c.key,
        summary: c.summary || "",
        similarity: Math.round(sim * 100) / 100,
        sharedTokens: sharedTokens.slice(0, 8),
        sameComponent,
        likelyDuplicate: sim >= 0.55,
      });
    }
  }
  return results.sort((a, b) => b.similarity - a.similarity);
}

/** Extract plain text from a Jira ADF (Atlassian Document Format) value. Bounded. */
export function adfToText(adf, maxChars = 2000) {
  if (typeof adf === "string") return adf.slice(0, maxChars);
  if (!adf || typeof adf !== "object") return "";
  const parts = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "text" && typeof node.text === "string") parts.push(node.text);
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(adf);
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, maxChars);
}
