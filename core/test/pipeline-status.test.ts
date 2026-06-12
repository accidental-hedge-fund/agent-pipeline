// Tests for #115: `--status` surfaces the needs-human punch-list (unresolved
// blocking-finding count + resume steps), not just the bare stage line.
//
// Covers the pure helper `needsHumanPunchlist` (ceiling present → count + hint;
// absent → null; multiple → last wins) and the `runStatus` integration
// (needs-human enriches, every other stage is byte-identical — regression guard).
// No real network/git: IO is injected via the `RunStatusDeps` seam.

import { test } from "node:test";
import assert from "node:assert/strict";
import { needsHumanPunchlist, runStatus, type RunStatusDeps } from "../scripts/pipeline.ts";
import type { PipelineConfig } from "../scripts/types.ts";

type Comment = { author: string; body: string; createdAt: string };

/** A well-formed ceiling comment, mirroring review.ts's `reviewCeilingComment`. */
function ceilingComment(opts: { round: 1 | 2; findings: string[]; createdAt?: string }): Comment {
  const lines = [
    "## Pipeline: Review ceiling reached — human decision required",
    "",
    "**Reviewer**: codex",
    `Review ${opts.round} re-ran 3 times and still has ${opts.findings.length} blocking ` +
      "finding(s). To stop looping, they are recorded as **advisory** and this item is parked " +
      "at `needs-human` — it will NOT auto-advance to ready-to-deploy.",
    "",
    "### Unresolved blocking findings",
    ...opts.findings.map((f) => `- ${f}`),
    "",
    "### To resume",
    "- Accept a finding: comment `--override \"<key>: <reason>\"` (audited), then relabel " +
      `\`pipeline:needs-human\` → \`pipeline:review-${opts.round}\`.`,
    `- Or fix the finding(s) by hand and relabel \`pipeline:needs-human\` → \`pipeline:review-${opts.round}\`.`,
    "",
    "*Automated by Claude Code Pipeline Skill*",
  ];
  return { author: "pipeline-bot", body: lines.join("\n"), createdAt: opts.createdAt ?? "2026-06-10T00:00:00Z" };
}

const TWO_FINDINGS = [
  "`abc123` **[HIGH]** Null deref in foo — `src/foo.ts:42`",
  "`def456` **[MEDIUM]** Missing test for bar",
];

// ---------------------------------------------------------------------------
// 3.1 helper: well-formed ceiling comment → count + resume hint
// ---------------------------------------------------------------------------

test("needsHumanPunchlist: well-formed ceiling comment returns the finding count + resume hint", () => {
  const out = needsHumanPunchlist([ceilingComment({ round: 2, findings: TWO_FINDINGS })]);
  assert.ok(out !== null, "expected a punch-list string, got null");
  assert.match(out, /2 unresolved blocking findings/, `count missing; got:\n${out}`);
  // Resume hint: override + fix-by-hand + relabel to the round the comment names.
  assert.match(out, /--override "<key>: <reason>"/, `override hint missing; got:\n${out}`);
  assert.match(out, /fix it by hand/, `fix-by-hand hint missing; got:\n${out}`);
  assert.match(out, /pipeline:needs-human` → `pipeline:review-2/, `relabel hint missing; got:\n${out}`);
});

test("needsHumanPunchlist: a single finding is reported with singular wording", () => {
  const out = needsHumanPunchlist([ceilingComment({ round: 2, findings: [TWO_FINDINGS[0]] })]);
  assert.ok(out !== null);
  assert.match(out, /1 unresolved blocking finding\b/, `expected singular 'finding'; got:\n${out}`);
  assert.doesNotMatch(out, /1 unresolved blocking findings/, `should not pluralize for count 1; got:\n${out}`);
});

test("needsHumanPunchlist: only the `### Unresolved blocking findings` bullets are counted, not `### To resume`", () => {
  // The ceiling comment's `### To resume` section also has `- ` bullets; they must not be counted.
  const out = needsHumanPunchlist([ceilingComment({ round: 2, findings: TWO_FINDINGS })]);
  assert.ok(out !== null);
  assert.match(out, /2 unresolved blocking findings/, `resume bullets leaked into the count; got:\n${out}`);
});

// ---------------------------------------------------------------------------
// 3.2 helper: no ceiling comment → null
// ---------------------------------------------------------------------------

test("needsHumanPunchlist: returns null when no ceiling comment is present", () => {
  const comments: Comment[] = [
    { author: "alice", body: "## Pipeline: Blocked\nsomething", createdAt: "2026-06-10T00:00:00Z" },
    { author: "bob", body: "just a human comment", createdAt: "2026-06-10T01:00:00Z" },
    { author: "carol", body: "## Review 2 by codex\n...", createdAt: "2026-06-10T02:00:00Z" },
  ];
  assert.equal(needsHumanPunchlist(comments), null);
});

test("needsHumanPunchlist: returns null for an empty comment list", () => {
  assert.equal(needsHumanPunchlist([]), null);
});

// ---------------------------------------------------------------------------
// 3.3 helper: multiple ceiling comments → last one wins
// ---------------------------------------------------------------------------

test("needsHumanPunchlist: with multiple ceiling comments, uses the latest (highest index) for the count", () => {
  const comments: Comment[] = [
    ceilingComment({ round: 2, findings: TWO_FINDINGS, createdAt: "2026-06-10T00:00:00Z" }),
    { author: "human", body: "fixed one of them", createdAt: "2026-06-10T01:00:00Z" },
    // Latest ceiling: round 1, a single remaining finding.
    ceilingComment({ round: 1, findings: [TWO_FINDINGS[0]], createdAt: "2026-06-10T02:00:00Z" }),
  ];
  const out = needsHumanPunchlist(comments);
  assert.ok(out !== null);
  // Count comes from the LAST ceiling comment, not the first.
  assert.match(out, /1 unresolved blocking finding\b/, `should use the last ceiling's count; got:\n${out}`);
  // Resume target is always review-2 regardless of which round hit the ceiling.
  assert.match(out, /pipeline:review-2/, `resume target must always be review-2; got:\n${out}`);
});

// Regression for finding e8b1f0b4: a round-1 ceiling comment must not emit review-1 as the resume
// target. The regex in the old ceilingResumeLabel() matched the first pipeline:review-N in the
// body, which could be review-1 from finding prose or the To resume section of a round-1 comment.
test("needsHumanPunchlist: a round-1 ceiling comment always emits pipeline:review-2 as the resume target", () => {
  // The round-1 ceiling comment body contains "pipeline:review-1" in its "To resume" section.
  const out = needsHumanPunchlist([ceilingComment({ round: 1, findings: TWO_FINDINGS })]);
  assert.ok(out !== null);
  assert.match(out, /pipeline:review-2/, `resume target must be review-2, not review-1; got:\n${out}`);
  assert.doesNotMatch(out, /pipeline:review-1/, `must not emit review-1 as resume target; got:\n${out}`);
});

// ---------------------------------------------------------------------------
// #133: RECURRING / NEW tags on the punch-list finding lines, re-derived from
// the prior Review-N verdict comments in the same comment list.
// ---------------------------------------------------------------------------

const KEY_REC = "deadbeef";
const KEY_NEW = "0badf00d";

/** A Review-N verdict comment carrying the given finding keys in the
 *  `override-key:` token form `formatReviewComment` renders. */
function verdictComment(round: 1 | 2, keys: string[], createdAt: string): Comment {
  const lines = [
    `## Review ${round} (Adversarial) — needs-attention (commit abcdef0)`,
    "**Reviewer**: codex",
    "",
    "summary",
    "",
    "### Findings",
    ...keys.map((k, i) => `**${i + 1}. [HIGH] finding ${i}** (confidence: 0.9) \`override-key: ${k}\``),
  ];
  return { author: "pipeline-bot", body: lines.join("\n"), createdAt };
}

test("needsHumanPunchlist (#133): findings with prior-round history are tagged RECURRING (n rounds)", () => {
  const comments: Comment[] = [
    verdictComment(2, [KEY_REC], "2026-06-12T00:00:00Z"),
    verdictComment(2, [KEY_REC], "2026-06-12T01:00:00Z"),
    // The triggering verdict (nearest Review comment before the ceiling): its
    // keys ARE the punch-list and must NOT count toward n.
    verdictComment(2, [KEY_REC, KEY_NEW], "2026-06-12T02:00:00Z"),
    ceilingComment({
      round: 2,
      findings: [
        `**RECURRING (2 rounds)** \`${KEY_REC}\` **[HIGH]** Race in cache — \`src/cache.ts:7\``,
        `**NEW** \`${KEY_NEW}\` **[HIGH]** Fresh bug`,
      ],
      createdAt: "2026-06-12T03:00:00Z",
    }),
  ];
  const out = needsHumanPunchlist(comments);
  assert.ok(out !== null);
  assert.match(out, /- RECURRING \(2 rounds\) `deadbeef`/, `expected RECURRING (2 rounds); got:\n${out}`);
  assert.match(out, /- NEW `0badf00d`/, `expected NEW for the fresh key; got:\n${out}`);
  assert.match(out, /2 unresolved blocking findings/, `count must still be derived; got:\n${out}`);
});

test("needsHumanPunchlist (#133): a key present only in the TRIGGERING verdict is NEW (trigger exclusion)", () => {
  // Without excluding the verdict that triggered the park, every punch-list key
  // would count once and everything would read RECURRING (1 rounds).
  const comments: Comment[] = [
    verdictComment(2, [KEY_NEW], "2026-06-12T00:00:00Z"),
    ceilingComment({
      round: 2,
      findings: [`**NEW** \`${KEY_NEW}\` **[HIGH]** Fresh bug`],
      createdAt: "2026-06-12T01:00:00Z",
    }),
  ];
  const out = needsHumanPunchlist(comments);
  assert.ok(out !== null);
  assert.match(out, /- NEW `0badf00d`/, `got:\n${out}`);
  assert.doesNotMatch(out, /RECURRING/, `the triggering verdict must not count; got:\n${out}`);
});

test("needsHumanPunchlist (#133): legacy untagged finding lines are tagged from prior-round history", () => {
  const comments: Comment[] = [
    verdictComment(2, [KEY_REC], "2026-06-12T00:00:00Z"),
    verdictComment(2, [KEY_REC], "2026-06-12T01:00:00Z"), // trigger
    ceilingComment({
      round: 2,
      findings: [`\`${KEY_REC}\` **[HIGH]** Old-format line — \`src/x.ts:1\``],
      createdAt: "2026-06-12T02:00:00Z",
    }),
  ];
  const out = needsHumanPunchlist(comments);
  assert.ok(out !== null);
  assert.match(out, /- RECURRING \(1 rounds\) `deadbeef`/, `legacy line must be re-derived; got:\n${out}`);
});

test("needsHumanPunchlist (#133): tags are not doubled when re-reading an already-tagged line", () => {
  const out = needsHumanPunchlist([
    ceilingComment({ round: 2, findings: [`**NEW** \`${KEY_NEW}\` **[HIGH]** Fresh bug`] }),
  ]);
  assert.ok(out !== null);
  assert.match(out, /- NEW `0badf00d`/, `got:\n${out}`);
  assert.doesNotMatch(out, /NEW \*\*NEW\*\*|NEW NEW/, `tag must be stripped before re-tagging; got:\n${out}`);
});

test("needsHumanPunchlist (#133): a finding line with no parseable key is tagged NEW by default", () => {
  // `abc123` is only 6 hex chars — not a valid finding key — and prior history
  // exists, so only the key-less default can produce NEW here.
  const comments: Comment[] = [
    verdictComment(2, [KEY_REC], "2026-06-12T00:00:00Z"),
    verdictComment(2, [KEY_REC], "2026-06-12T01:00:00Z"),
    ceilingComment({ round: 2, findings: [TWO_FINDINGS[0]], createdAt: "2026-06-12T02:00:00Z" }),
  ];
  const out = needsHumanPunchlist(comments);
  assert.ok(out !== null);
  assert.match(out, /- NEW `abc123`/, `unparseable key must default to NEW; got:\n${out}`);
});

test("needsHumanPunchlist (#133): no prior Review-N comments at all → every finding tagged NEW", () => {
  const out = needsHumanPunchlist([ceilingComment({ round: 2, findings: TWO_FINDINGS })]);
  assert.ok(out !== null);
  const findingLines = out.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(findingLines.length, 2, `got:\n${out}`);
  for (const l of findingLines) assert.match(l, /^- NEW /, `got line: ${l}`);
});

// ---------------------------------------------------------------------------
// runStatus integration — capture console.log via injected IO (no real gh)
// ---------------------------------------------------------------------------

const CFG = { repo: "acme/repo", domain: "test" } as unknown as PipelineConfig;

function detailAt(stage: string, comments: Comment[]) {
  return {
    number: 115,
    type: "issue" as const,
    title: "Surface the needs-human punch-list",
    body: "",
    state: "open" as const,
    url: "https://github.com/acme/repo/issues/115",
    labels: [`pipeline:${stage}`],
    comments,
  };
}

async function captureStatus(stage: string, comments: Comment[]): Promise<string[]> {
  const deps: RunStatusDeps = {
    getIssueDetail: async () => detailAt(stage, comments),
    getPrForIssue: async () => null,
  };
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await runStatus(CFG, 115, deps);
  } finally {
    console.log = orig;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 3.4 runStatus: non-needs-human stage output is byte-identical (regression guard)
// ---------------------------------------------------------------------------

test("runStatus: a non-needs-human stage prints exactly the pre-change lines, even with a ceiling comment present", async () => {
  // A ceiling comment is present, but the stage is review-2 → it must NOT be
  // parsed into a punch-list; output is identical to the pre-#115 behavior.
  const lines = await captureStatus("review-2", [ceilingComment({ round: 2, findings: TWO_FINDINGS })]);
  assert.deepEqual(lines, [
    "#115 — Surface the needs-human punch-list",
    "State: open",
    "Stage: review-2",
    "Blocked: no",
    "Repo: acme/repo  domain=test",
    "PR: (none)",
    "URL: https://github.com/acme/repo/issues/115",
    // The ceiling comment still surfaces via the existing "Last pipeline event" line — unchanged behavior.
    "Last pipeline event: ## Pipeline: Review ceiling reached — human decision required  (2026-06-10T00:00:00Z)",
  ]);
  // And explicitly: no punch-list enrichment for a non-needs-human stage.
  assert.ok(!lines.some((l) => l.startsWith("Needs human:")), "punch-list must not appear for non-needs-human");
});

// ---------------------------------------------------------------------------
// runStatus: needs-human stage IS enriched with the punch-list
// ---------------------------------------------------------------------------

test("runStatus: a needs-human stage with a ceiling comment appends the punch-list (count + resume steps)", async () => {
  const lines = await captureStatus("needs-human", [ceilingComment({ round: 2, findings: TWO_FINDINGS })]);
  assert.equal(lines[2], "Stage: needs-human");
  const text = lines.join("\n");
  assert.match(text, /Needs human: 2 unresolved blocking findings/, `count missing; got:\n${text}`);
  assert.match(text, /--override "<key>: <reason>"/, `override hint missing; got:\n${text}`);
  assert.match(text, /pipeline:needs-human` → `pipeline:review-2/, `relabel hint missing; got:\n${text}`);
});

test("runStatus: a needs-human stage with NO ceiling comment prints a graceful fallback and does not throw", async () => {
  // No ceiling comment at all → the helper returns null and runStatus prints a fallback.
  const lines = await captureStatus("needs-human", [
    { author: "human", body: "some unrelated note", createdAt: "2026-06-10T00:00:00Z" },
  ]);
  assert.equal(lines[2], "Stage: needs-human");
  const text = lines.join("\n");
  assert.match(text, /no Pipeline: Review ceiling reached comment was found/, `fallback missing; got:\n${text}`);
  assert.match(text, /pipeline:needs-human` → `pipeline:review-2/, `fallback resume hint missing; got:\n${text}`);
});
