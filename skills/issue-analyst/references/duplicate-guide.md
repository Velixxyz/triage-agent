# Duplicate guide

Duplicate detection is deterministic token matching, not an LLM judgement.

## How it works

1. The issue summary and description are tokenized: lowercase words longer
   than 2 characters, minus a small English stopword list.
2. Candidates come from a JQL search in the same project: issues whose
   summary contains any of the top 6 significant tokens.
3. Similarity is the Jaccard index of the two token sets (shared tokens /
   all distinct tokens), plus 0.10 when the issues share a component and
   0.05 when they share a label.

## Thresholds

- **>= 0.55 — likely duplicate.** Treat as the same problem: close as a
  duplicate or merge the discussion before writing code. Triage subtracts
  10 points from the score.
- **0.35–0.55 — related.** Link the two issues and check whether one fix
  covers both. Do not close anything.
- **< 0.35 — not listed.** The candidate is not shown at all.

## Limits

- Only the same project is searched, and at most 20 candidates are ranked.
- Different wording of the same problem can score below 0.35; the check is a
  safety net, not a proof of uniqueness.
- The issue itself is always excluded from its own candidates.
