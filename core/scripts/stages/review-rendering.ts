// Comment building functions for review comments.
// Imports from review-parsing.ts (codec, sentinels, helpers) and review-policy.ts.

import {
  CEILING_DEMOTION_HEADING,
  DELTA_REVIEW_MARKER_PREFIX,
  encodeReviewArtifact,
  extractAllKeysFromComment,
  recurrenceTag,
  REVIEW_MARKER_PREFIX_R1,
  REVIEW_MARKER_PREFIX_R2,
  type ReviewArtifact,
} from "./review-parsing.ts";
import {
  categoryMarker,
  directionMarker,
  findingKey,
  findingPayloadFingerprint,
  formatBlockingSurfacesMarker,
  type PartitionResult,
  type Review1Risk,
  SPEC_DIVERGENCE_CATEGORY,
} from "../review-policy.ts";
import type { PipelineConfig, ReviewFinding, ReviewVerdict } from "../types.ts";

export function cfgFooter(cfg: PipelineConfig | undefined): string {
  return (cfg?.marker_footer ?? "*Automated by Claude Code Pipeline Skill*").trim();
}

/**
 * Format a review comment for round 1 or 2. Accepts two calling conventions:
 *
 * **3-arg form** (tests / simple use): `formatReviewComment(verdict, round, reviewer)` —
 *   `cfgOrVerdict` is the verdict object, no `blockingKeys`/`diffHash`/`review1Risk`.
 *
 * **Full form** (production): `formatReviewComment(cfg, verdict, round, reviewer,
 *   blockingKeys?, diffHash?, review1Risk?)` — cfg carries the marker footer and the
 *   optional extra fields enable the machine-readable sentinels and ReviewArtifact block.
 *
 * When `verdict.commitSha` is present and the call is the full form (cfg supplied),
 * a ReviewArtifact block is appended as the last line after all individual sentinels.
 */
export function formatReviewComment(
  cfgOrVerdict: PipelineConfig | (ReviewVerdict & { _raw?: string }),
  verdictOrRound: (ReviewVerdict & { _raw?: string }) | 1 | 2,
  roundOrReviewer: 1 | 2 | string,
  maybeReviewer?: string,
  blockingKeys?: Set<string>,
  diffHash?: string,
  review1Risk?: Review1Risk,
): string {
  const cfg = maybeReviewer === undefined ? undefined : cfgOrVerdict as PipelineConfig;
  const verdict = maybeReviewer === undefined
    ? cfgOrVerdict as ReviewVerdict & { _raw?: string }
    : verdictOrRound as ReviewVerdict & { _raw?: string };
  const round = maybeReviewer === undefined ? verdictOrRound as 1 | 2 : roundOrReviewer as 1 | 2;
  const reviewer = maybeReviewer === undefined ? roundOrReviewer as string : maybeReviewer;
  const reviewType = round === 1 ? "Standard" : "Adversarial";
  const shortSha = verdict.commitSha ? verdict.commitSha.slice(0, 7) : "";
  const heading = shortSha
    ? `## Review ${round} (${reviewType}) — ${verdict.verdict} (commit ${shortSha})`
    : `## Review ${round} (${reviewType}) — ${verdict.verdict}`;
  const lines = [
    heading,
    `**Reviewer**: ${reviewer}`,
    "",
    verdict.summary,
  ];
  const advisoryOrdinals: number[] = [];
  if (verdict.findings.length > 0) {
    lines.push("", "### Findings");
    verdict.findings.forEach((f, i) => {
      const sev = (f.severity ?? "medium").toUpperCase();
      const loc = f.line_start
        ? `${f.file ?? ""}:${f.line_start}-${f.line_end ?? f.line_start}`
        : f.file ?? "";
      const conf = f.confidence !== undefined ? ` (confidence: ${f.confidence})` : "";
      const cat = f.category ? ` ${categoryMarker(f.category)}` : "";
      const dir =
        f.category === SPEC_DIVERGENCE_CATEGORY && f.spec_divergence_direction
          ? ` ${directionMarker(f.spec_divergence_direction)}`
          : "";
      lines.push("", `**${i + 1}. [${sev}] ${f.title}**${conf} \`override-key: ${findingKey(f)}\`${cat}${dir}`);
      // Machine-readable payload fingerprint, emitted at render time from the
      // structured finding (#391 delta, keys 0fb96f45/b827b914): consumers
      // (fix-stage summaries, disposition matching) read it verbatim instead
      // of reconstructing it from lossy markdown, which truncated multi-line
      // recommendations and mis-keyed colliding findings.
      lines.push(`<!-- finding-fingerprint: ${findingPayloadFingerprint(f)} -->`);
      if (loc) lines.push(`Location: \`${loc}\``);
      if (f.body) lines.push(f.body);
      if (f.recommendation) lines.push(`**Recommendation**: ${f.recommendation}`);
      if (f.blocking === false) advisoryOrdinals.push(i + 1);
    });
  }
  if (verdict._raw) {
    lines.push("", "### Raw Review Output", verdict._raw);
  }
  if (verdict.next_steps?.length) {
    lines.push("", "### Next Steps");
    for (const step of verdict.next_steps) lines.push(`- ${step}`);
  }
  lines.push(cfgFooter(cfg));
  if (blockingKeys !== undefined) {
    lines.push(`<!-- pipeline-blocking-keys: ${[...blockingKeys].sort().join(",")} -->`);
    const blockingFindings = verdict.findings.filter((f) => blockingKeys!.has(findingKey(f)));
    lines.push(formatBlockingSurfacesMarker(blockingFindings));
  }
  if (advisoryOrdinals.length > 0) {
    lines.push(`<!-- pipeline-advisory-ordinals: ${advisoryOrdinals.join(",")} -->`);
  }
  // review1Risk sentinel for round-1 comments (so review-2 can recover the tier).
  if (round === 1 && review1Risk !== undefined) {
    lines.push(`<!-- pipeline-review1-risk: ${review1Risk} -->`);
  }
  // Reviewed-SHA sentinel (#16): appended before the artifact (backward compat).
  if (verdict.commitSha) {
    lines.push("", `<!-- reviewed-sha: ${verdict.commitSha} -->`);
  }
  // Diff-hash sentinel (#228): omitted when not provided.
  if (diffHash) {
    lines.push(`<!-- verdict-diff-hash: ${diffHash} -->`);
  }
  // ReviewArtifact block (#264): the single structured record that supersedes
  // individual sentinels as the primary read path for all gate logic.
  // Appended LAST, after all individual sentinels, when a commit SHA is available.
  if (verdict.commitSha) {
    const artifact: ReviewArtifact = {
      round,
      reviewedSha: verdict.commitSha,
      diffHash: diffHash ?? null,
      blockingKeys: blockingKeys ? [...blockingKeys].sort() : [],
      review1Risk: round === 1 ? (review1Risk ?? null) : null,
    };
    lines.push(encodeReviewArtifact(artifact));
  }
  return lines.join("\n");
}

/**
 * Format a pre-merge delta review comment (#228). Uses DELTA_REVIEW_MARKER_PREFIX
 * so the comment is NOT counted as a full review-2 round by ceiling/recurrence
 * accounting. Still carries the SHA and diff-hash sentinels plus a ReviewArtifact.
 */
export function formatDeltaReviewComment(
  cfg: PipelineConfig,
  verdict: ReviewVerdict & { _raw?: string },
  reviewer: string,
  blockingKeys?: Set<string>,
  diffHash?: string,
): string {
  const shortSha = verdict.commitSha ? verdict.commitSha.slice(0, 7) : "";
  const heading = shortSha
    ? `${DELTA_REVIEW_MARKER_PREFIX} — ${verdict.verdict} (commit ${shortSha})`
    : `${DELTA_REVIEW_MARKER_PREFIX} — ${verdict.verdict}`;
  const lines: string[] = [heading, `**Reviewer**: ${reviewer}`, "", verdict.summary];
  const advisoryOrdinals: number[] = [];
  if (verdict.findings.length > 0) {
    lines.push("", "### Findings");
    for (let i = 0; i < verdict.findings.length; i++) {
      const f = verdict.findings[i];
      const sev = (f.severity ?? "medium").toUpperCase();
      const loc = f.line_start
        ? `${f.file ?? ""}:${f.line_start}-${f.line_end ?? f.line_start}`
        : f.file ?? "";
      const conf = f.confidence !== undefined ? ` (confidence: ${f.confidence})` : "";
      const cat = f.category ? ` ${categoryMarker(f.category)}` : "";
      const dir =
        f.category === SPEC_DIVERGENCE_CATEGORY && f.spec_divergence_direction
          ? ` ${directionMarker(f.spec_divergence_direction)}`
          : "";
      lines.push("", `**${i + 1}. [${sev}] ${f.title}**${conf} \`override-key: ${findingKey(f)}\`${cat}${dir}`);
      // Machine-readable payload fingerprint, emitted at render time from the
      // structured finding (#391 delta, keys 0fb96f45/b827b914): consumers
      // (fix-stage summaries, disposition matching) read it verbatim instead
      // of reconstructing it from lossy markdown, which truncated multi-line
      // recommendations and mis-keyed colliding findings.
      lines.push(`<!-- finding-fingerprint: ${findingPayloadFingerprint(f)} -->`);
      if (loc) lines.push(`Location: \`${loc}\``);
      if (f.body) lines.push(f.body);
      if (f.recommendation) lines.push(`**Recommendation**: ${f.recommendation}`);
      if (f.blocking === false) advisoryOrdinals.push(i + 1);
    }
  }
  if (verdict.next_steps?.length) {
    lines.push("", "### Next Steps");
    for (const step of verdict.next_steps) lines.push(`- ${step}`);
  }
  lines.push(cfgFooter(cfg));
  if (blockingKeys !== undefined) {
    lines.push(`<!-- pipeline-blocking-keys: ${[...blockingKeys].sort().join(",")} -->`);
  }
  if (advisoryOrdinals.length > 0) {
    lines.push(`<!-- pipeline-advisory-ordinals: ${advisoryOrdinals.join(",")} -->`);
  }
  if (verdict.commitSha) {
    lines.push("", `<!-- reviewed-sha: ${verdict.commitSha} -->`);
  }
  if (diffHash) {
    lines.push(`<!-- verdict-diff-hash: ${diffHash} -->`);
  }
  // ReviewArtifact block (#264): delta reviews use round=2, review1Risk=null.
  if (verdict.commitSha) {
    const artifact: ReviewArtifact = {
      round: 2,
      reviewedSha: verdict.commitSha,
      diffHash: diffHash ?? null,
      blockingKeys: blockingKeys ? [...blockingKeys].sort() : [],
      review1Risk: null,
    };
    lines.push(encodeReviewArtifact(artifact));
  }
  return lines.join("\n");
}

/**
 * Audited comment posted when a review produced findings but none block under
 * the active policy — the item advances with findings on the advisory record.
 */
export function advisoryAdvanceComment(
  cfg: PipelineConfig,
  round: 1 | 2,
  reviewer: string,
  partition: PartitionResult,
): string {
  const lines = [
    `## Pipeline: Review ${round} advanced under severity policy`,
    "",
    `**Reviewer**: ${reviewer}`,
    `Findings were produced but none meet the repo's \`review_policy.block_threshold\` ` +
      `(\`${cfg.review_policy.block_threshold}\`, min_confidence ${cfg.review_policy.min_confidence}), ` +
      `so this item advances instead of routing to a fix round.`,
  ];
  if (partition.advisory.length) {
    lines.push("", "### Advisory (below policy — not blocking)");
    for (const { finding, reason } of partition.advisory) {
      lines.push(`- \`${findingKey(finding)}\` **[${(finding.severity ?? "medium").toUpperCase()}]** ${finding.title} — ${reason}`);
    }
  }
  if (partition.overridden.length) {
    lines.push("", "### Overridden (operator-dispositioned — not blocking)");
    for (const entry of partition.overridden) {
      const sev = `**[${(entry.finding.severity ?? "medium").toUpperCase()}]**`;
      if (entry.kind === "scope") {
        lines.push(
          `- [${entry.scopeType}:${entry.scopeValue}] ${sev} ${entry.finding.title} — ${entry.reason}`,
        );
      } else {
        lines.push(`- \`${entry.key}\` ${sev} ${entry.finding.title} — ${entry.disposition}`);
      }
    }
  }
  if (partition.advisory.length) {
    lines.push(
      "",
      "⚠️ The advisory findings above were **not fixed** — review them before merging this PR.",
    );
  }
  lines.push("", cfgFooter(cfg));
  return lines.join("\n");
}

/**
 * Punch-list comment posted when the fix↔review loop stops converging: a review
 * round hit the `max_adversarial_rounds` ceiling, or a blocking finding re-emerged
 * with an unchanged key after a fix round (#133). Parks at `needs-human`. Exported for tests.
 */
export function reviewCeilingComment(
  cfg: PipelineConfig,
  round: 1 | 2,
  reviewer: string,
  partition: PartitionResult,
  cap: number,
  priorReviewComments: { body: string }[],
  trigger: "ceiling" | "recurrence" = "ceiling",
): string {
  const priorKeySets = priorReviewComments.map((c) => extractAllKeysFromComment(c.body));
  const explanation =
    trigger === "recurrence"
      ? `Review ${round} re-emitted blocking finding(s) with an unchanged finding key after a ` +
        `fix round — a proven non-convergence signal. To stop looping, they are recorded as ` +
        `**advisory** and this item is parked at \`needs-human\` — it will NOT auto-advance to ` +
        `ready-to-deploy.`
      : `Review ${round} re-ran ${cap} times and still has ${partition.blocking.length} blocking ` +
        `finding(s). To stop looping, they are recorded as **advisory** and this item is parked at ` +
        `\`needs-human\` — it will NOT auto-advance to ready-to-deploy.`;
  const lines = [
    `## Pipeline: Review ceiling reached — human decision required`,
    "",
    `**Reviewer**: ${reviewer}`,
    explanation,
    "",
    "### Unresolved blocking findings",
  ];
  for (const f of partition.blocking) {
    const key = findingKey(f);
    const loc = f.file ? ` — \`${f.file}${f.line_start ? `:${f.line_start}` : ""}\`` : "";
    lines.push(
      `- **${recurrenceTag(key, priorKeySets)}** \`${key}\` ` +
        `**[${(f.severity ?? "medium").toUpperCase()}]** ${f.title}${loc}`,
    );
  }
  lines.push(
    "",
    "### To resume",
    `- Accept a finding: \`--override "<key>: <reason>"\` (audited) — records the decision and auto-resumes.`,
    `- Or fix the finding(s) by hand and relabel \`pipeline:needs-human\` → \`pipeline:review-${round}\`.`,
    "",
    cfgFooter(cfg),
  );
  return lines.join("\n");
}

/**
 * Audited demotion comment posted at the review ceiling when `ceiling_action` is
 * `demote_and_advance` and all remaining blocking findings are below high severity.
 * Embeds the `<!-- pipeline-ceiling-followup: #N -->` marker for idempotency. Exported for tests.
 */
export function reviewCeilingDemotionComment(
  cfg: PipelineConfig,
  round: 1 | 2,
  reviewer: string,
  partition: PartitionResult,
  cap: number,
  priorReviewComments: { body: string }[],
  followupNumber: number,
): string {
  const priorKeySets = priorReviewComments.map((c) => extractAllKeysFromComment(c.body));
  const lines = [
    CEILING_DEMOTION_HEADING,
    "",
    `**Reviewer**: ${reviewer}`,
    `Review ${round} re-ran ${cap} times and still has ${partition.blocking.length} blocking ` +
      `finding(s), all below **high** severity. Per \`review_policy.ceiling_action: demote_and_advance\`, ` +
      `these findings are demoted to **advisory** and captured in follow-up issue #${followupNumber}. ` +
      `This item advances to pre-merge without human intervention.`,
    "",
    "### Demoted findings (advisory — tracked in follow-up)",
  ];
  for (const f of partition.blocking) {
    const key = findingKey(f);
    const loc = f.file ? ` — \`${f.file}${f.line_start ? `:${f.line_start}` : ""}\`` : "";
    lines.push(
      `- **${recurrenceTag(key, priorKeySets)}** \`${key}\` ` +
        `**[${(f.severity ?? "medium").toUpperCase()}]** ${f.title}${loc}`,
    );
  }
  lines.push(
    "",
    `See #${followupNumber} for the complete deferred finding list.`,
    "",
    "⚠️ The demoted findings were **not fixed** — review them before merging this PR.",
    "",
    cfgFooter(cfg),
    "",
    `<!-- pipeline-ceiling-followup: #${followupNumber} -->`,
  );
  return lines.join("\n");
}

/**
 * Build the body of the single tracked follow-up issue filed when findings are
 * demoted at the review ceiling (#233).
 */
export function buildFollowupIssueBody(
  originalIssue: number,
  demotedFindings: ReviewFinding[],
): string {
  const lines = [
    `Deferred review findings from #${originalIssue}`,
    "",
    `These findings were demoted to advisory at the adversarial review ceiling ` +
      `(\`review_policy.max_adversarial_rounds\`) because they are all below high severity ` +
      `and the pipeline is configured with \`ceiling_action: demote_and_advance\`. ` +
      `They should be reviewed and addressed in a follow-up change.`,
    "",
    "## Deferred findings",
  ];
  for (const f of demotedFindings) {
    const key = findingKey(f);
    const loc = f.file
      ? ` — \`${f.file}${f.line_start ? `:${f.line_start}` : ""}\``
      : "";
    const cat = f.category ? ` (category: ${f.category})` : "";
    lines.push(
      `- \`${key}\` **[${(f.severity ?? "medium").toUpperCase()}]** ${f.title}${cat}${loc}`,
    );
  }
  lines.push(
    "",
    `> Deferred from #${originalIssue} at review ceiling. Do not add a \`pipeline:\` label — ` +
      `this issue tracks follow-up work, not an in-progress pipeline run.`,
  );
  return lines.join("\n");
}

/**
 * Build the body of a follow-up issue update comment posted when demote-and-advance
 * re-enters the ceiling and reuses an existing follow-up (#233 finding 2).
 */
export function buildFollowupUpdateComment(
  originalIssue: number,
  roundNumber: number,
  demotedFindings: ReviewFinding[],
): string {
  const lines = [
    `Additional deferred findings from #${originalIssue} (re-entry at ceiling round ${roundNumber})`,
    "",
    "The item re-entered the review ceiling. The following below-high findings were demoted to advisory in this run:",
    "",
    "## Additional deferred findings",
  ];
  for (const f of demotedFindings) {
    const key = findingKey(f);
    const loc = f.file
      ? ` — \`${f.file}${f.line_start ? `:${f.line_start}` : ""}\``
      : "";
    const cat = f.category ? ` (category: ${f.category})` : "";
    lines.push(
      `- \`${key}\` **[${(f.severity ?? "medium").toUpperCase()}]** ${f.title}${cat}${loc}`,
    );
  }
  lines.push(
    "",
    `> Re-entered from #${originalIssue} at round ${roundNumber} ceiling. Do not add a \`pipeline:\` label.`,
  );
  return lines.join("\n");
}

// Re-export marker constants that callers (e.g. pre_merge.ts) use via this module.
export { REVIEW_MARKER_PREFIX_R1, REVIEW_MARKER_PREFIX_R2, DELTA_REVIEW_MARKER_PREFIX };
