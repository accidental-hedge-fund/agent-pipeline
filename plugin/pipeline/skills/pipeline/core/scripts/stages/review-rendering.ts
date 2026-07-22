// Comment building functions for review comments.
// Imports from review-parsing.ts (codec, sentinels, helpers) and review-policy.ts.

import {
  attestPipelineComment,
  CEILING_DEMOTION_HEADING,
  DELTA_REVIEW_MARKER_PREFIX,
  encodeReviewArtifact,
  extractAllKeysFromComment,
  hashReviewBody,
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
  surfaceKey,
  type AlternativeReinstatementMatch,
  type PartitionResult,
  type ReversalMatch,
  type Review1Risk,
  SPEC_DIVERGENCE_CATEGORY,
} from "../review-policy.ts";
import type { ChurnResult } from "../review-history.ts";
import type { PipelineConfig, ReviewFinding, ReviewVerdict } from "../types.ts";

export function cfgFooter(cfg: PipelineConfig | undefined): string {
  return (cfg?.marker_footer ?? "*Automated by Claude Code Pipeline Skill*").trim();
}

/** Truncate a finding title to 120 characters for the `blockingFindings` artifact
 *  extension (#389 task 1.2) — mirrors the digest render cap so the stored and
 *  rendered titles never diverge. */
function truncateTitleFor389(title: string): string {
  return title.length > 120 ? title.slice(0, 120) : title;
}

/** Build the `ReviewArtifact.blockingFindings` extension array (#389) from a
 *  round's blocking findings, keyed/surfaced identically to the existing
 *  `pipeline-blocking-surfaces` marker. Carries `confidence` and
 *  `rejectedAlternatives` (#483) when the reviewer supplied them, so a later
 *  round's digest can check a new recommendation against what THIS round
 *  required removed — omitted (not defaulted to 0/[]) when absent so the
 *  digest can tell "not reported" apart from "reported as empty". */
function buildBlockingFindingsExtension(
  findings: ReviewFinding[],
): Array<{ key: string; surface: string | null; severity: string; title: string; confidence?: number; rejectedAlternatives?: string[] }> {
  return findings.map((f) => {
    const entry: { key: string; surface: string | null; severity: string; title: string; confidence?: number; rejectedAlternatives?: string[] } = {
      key: findingKey(f),
      surface: surfaceKey(f),
      severity: f.severity ?? "medium",
      title: truncateTitleFor389(f.title),
    };
    if (typeof f.confidence === "number" && Number.isFinite(f.confidence)) entry.confidence = f.confidence;
    if (f.rejected_alternatives && f.rejected_alternatives.length > 0) entry.rejectedAlternatives = f.rejected_alternatives;
    return entry;
  });
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
 *
 * `reversalDemotions` (#389, optional): a `findingKey -> ReversalMatch` map
 * for findings `partitionFindings` demoted with reason
 * `reversal-unacknowledged`. Each such finding's line renders a
 * `REVERSAL-UNACKNOWLEDGED` tag naming the specific settled finding it
 * re-raises (key + title) and the round that settled it (#464), so the
 * demotion is visible on the finding itself rather than only in the separate
 * advisory-advance comment.
 */
export function formatReviewComment(
  cfgOrVerdict: PipelineConfig | (ReviewVerdict & { _raw?: string }),
  verdictOrRound: (ReviewVerdict & { _raw?: string }) | 1 | 2,
  roundOrReviewer: 1 | 2 | string,
  maybeReviewer?: string,
  blockingKeys?: Set<string>,
  diffHash?: string,
  review1Risk?: Review1Risk,
  reversalDemotions?: Map<string, ReversalMatch>,
  alternativeDemotions?: Map<string, AlternativeReinstatementMatch>,
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
      const reversalMatch = reversalDemotions?.get(findingKey(f));
      const reversalTag = reversalMatch
        ? ` \`REVERSAL-UNACKNOWLEDGED: re-raises ${reversalMatch.settledKey} "${reversalMatch.settledTitle}" settled in round ${reversalMatch.settledRound}\``
        : "";
      const alternativeMatch = alternativeDemotions?.get(findingKey(f));
      const alternativeTag = alternativeMatch
        ? ` \`SETTLED-ALTERNATIVE-REINSTATED: reinstates "${alternativeMatch.matchedAlternative}" rejected by ${alternativeMatch.settledKey} settled in round ${alternativeMatch.settledRound}\``
        : "";
      lines.push("", `**${i + 1}. [${sev}] ${f.title}**${conf} \`override-key: ${findingKey(f)}\`${cat}${dir}${reversalTag}${alternativeTag}`);
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
    const bodyHash = hashReviewBody(lines.join("\n"));
    const artifact: ReviewArtifact = {
      round,
      reviewedSha: verdict.commitSha,
      diffHash: diffHash ?? null,
      blockingKeys: blockingKeys ? [...blockingKeys].sort() : [],
      review1Risk: round === 1 ? (review1Risk ?? null) : null,
      bodyHash,
    };
    if (blockingKeys !== undefined) {
      artifact.blockingFindings = buildBlockingFindingsExtension(
        verdict.findings.filter((f) => blockingKeys.has(findingKey(f))),
      );
    }
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
  reversalDemotions?: Map<string, ReversalMatch>,
  alternativeDemotions?: Map<string, AlternativeReinstatementMatch>,
  churn?: ChurnResult,
): string {
  const shortSha = verdict.commitSha ? verdict.commitSha.slice(0, 7) : "";
  const heading = shortSha
    ? `${DELTA_REVIEW_MARKER_PREFIX} — ${verdict.verdict} (commit ${shortSha})`
    : `${DELTA_REVIEW_MARKER_PREFIX} — ${verdict.verdict}`;
  const lines: string[] = [heading, `**Reviewer**: ${reviewer}`, "", verdict.summary];
  if (churn?.suspected) {
    lines.push(
      "",
      "⚠️ **SUSPECTED CHURN**: every blocking finding in this round sits on a settled axis at " +
        "confidence below that axis's prior maximum:",
      ...churn.axes.map(
        (a) => `- \`${a.surface}\` — prior max confidence ${a.priorMaxConfidence}, this round ${a.newConfidence}`,
      ),
    );
  }
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
      const reversalMatch = reversalDemotions?.get(findingKey(f));
      const reversalTag = reversalMatch
        ? ` \`REVERSAL-UNACKNOWLEDGED: re-raises ${reversalMatch.settledKey} "${reversalMatch.settledTitle}" settled in round ${reversalMatch.settledRound}\``
        : "";
      const alternativeMatch = alternativeDemotions?.get(findingKey(f));
      const alternativeTag = alternativeMatch
        ? ` \`SETTLED-ALTERNATIVE-REINSTATED: reinstates "${alternativeMatch.matchedAlternative}" rejected by ${alternativeMatch.settledKey} settled in round ${alternativeMatch.settledRound}\``
        : "";
      lines.push("", `**${i + 1}. [${sev}] ${f.title}**${conf} \`override-key: ${findingKey(f)}\`${cat}${dir}${reversalTag}${alternativeTag}`);
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
    const bodyHash = hashReviewBody(lines.join("\n"));
    const artifact: ReviewArtifact = {
      round: 2,
      reviewedSha: verdict.commitSha,
      diffHash: diffHash ?? null,
      blockingKeys: blockingKeys ? [...blockingKeys].sort() : [],
      review1Risk: null,
      bodyHash,
    };
    if (blockingKeys !== undefined) {
      artifact.blockingFindings = buildBlockingFindingsExtension(
        verdict.findings.filter((f) => blockingKeys.has(findingKey(f))),
      );
    }
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
  return attestPipelineComment("review-advance-severity", lines.join("\n"));
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
  return attestPipelineComment("review-ceiling", lines.join("\n"));
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
  return attestPipelineComment("review-ceiling-demotion", lines.join("\n"));
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

/**
 * A blocking delta finding reconstructed from the durable `blockingFindings`
 * digest/artifact entries at the pre-merge delta-round ceiling (#483) — NOT a
 * fresh `ReviewFinding`, since no reviewer runs at the ceiling. Carries the
 * finding's ALREADY-COMPUTED stable key verbatim (never recomputed via
 * `findingKey`, which would require the original `line_start` this entry does
 * not carry and would silently mint a key an operator's `--override` could
 * never match).
 */
export interface DeltaCeilingFinding {
  key: string;
  surface: string | null;
  severity: string;
  title: string;
}

/**
 * Ceiling comment posted when a pre-merge item's durable delta-round count has
 * reached `review_policy.max_delta_rounds` (#483) and `ceiling_action` is
 * `park` (or a high/critical finding hard-parks regardless of
 * `ceiling_action`). Deliberately does NOT start with `DELTA_REVIEW_MARKER_PREFIX`
 * so it is never itself counted as a further delta round by `countDeltaRounds`.
 * Exported for tests.
 */
export function deltaRoundCeilingComment(
  cfg: PipelineConfig,
  observed: number,
  cap: number,
  ceilingAction: "park" | "demote_and_advance",
  blockingFindings: DeltaCeilingFinding[],
): string {
  const lines = [
    "## Pipeline: Pre-merge delta round ceiling reached — human decision required",
    "",
    `Pre-merge delta review has run ${observed} round(s), reaching the configured ` +
      `\`review_policy.max_delta_rounds\` cap of ${cap}. Per \`ceiling_action: ${ceilingAction}\`, no further ` +
      `delta review will run for this item; it is recorded as advisory and parked at \`needs-human\` — it ` +
      `will NOT auto-advance to ready-to-deploy.`,
    "",
    "### Unresolved blocking delta findings",
  ];
  for (const f of blockingFindings) {
    const loc = f.surface ? ` — \`${f.surface}\`` : "";
    lines.push(`- \`${f.key}\` **[${f.severity.toUpperCase()}]** ${f.title}${loc}`);
  }
  lines.push(
    "",
    "### To resume",
    `- Accept a finding: \`--override "<key>: <reason>"\` (audited) — records the decision and auto-resumes.`,
    `- Or fix the finding(s) by hand.`,
    "",
    cfgFooter(cfg),
  );
  return attestPipelineComment("delta-round-ceiling", lines.join("\n"));
}

/**
 * Audited demotion comment posted when a pre-merge item's durable delta-round
 * count has reached `review_policy.max_delta_rounds`, `ceiling_action` is
 * `demote_and_advance`, and every outstanding blocking delta finding is below
 * high severity (#483). Mirrors `reviewCeilingDemotionComment`'s idempotency
 * marker. Does NOT start with `DELTA_REVIEW_MARKER_PREFIX` for the same reason
 * as {@link deltaRoundCeilingComment}. Exported for tests.
 */
export function deltaRoundCeilingDemotionComment(
  cfg: PipelineConfig,
  observed: number,
  cap: number,
  demotedFindings: DeltaCeilingFinding[],
  followupNumber: number,
): string {
  const lines = [
    "## Pipeline: Pre-merge delta round ceiling — findings demoted and deferred",
    "",
    `Pre-merge delta review has run ${observed} round(s), reaching the configured ` +
      `\`review_policy.max_delta_rounds\` cap of ${cap}, with all remaining blocking finding(s) below ` +
      `**high** severity. Per \`ceiling_action: demote_and_advance\`, these findings are demoted to ` +
      `**advisory** and captured in follow-up issue #${followupNumber}. This item advances without human ` +
      `intervention.`,
    "",
    "### Demoted findings (advisory — tracked in follow-up)",
  ];
  for (const f of demotedFindings) {
    const loc = f.surface ? ` — \`${f.surface}\`` : "";
    lines.push(`- \`${f.key}\` **[${f.severity.toUpperCase()}]** ${f.title}${loc}`);
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
  return attestPipelineComment("delta-round-ceiling-demotion", lines.join("\n"));
}

/**
 * Body of the single tracked follow-up issue filed when delta findings are
 * demoted at the pre-merge delta-round ceiling (#483). Mirrors
 * `buildFollowupIssueBody`, but over {@link DeltaCeilingFinding} (stored keys,
 * not recomputed) since no fresh `ReviewFinding` exists at the ceiling.
 */
export function buildDeltaFollowupIssueBody(
  originalIssue: number,
  demotedFindings: DeltaCeilingFinding[],
): string {
  const lines = [
    `Deferred pre-merge delta review findings from #${originalIssue}`,
    "",
    `These findings were demoted to advisory at the pre-merge delta-round ceiling ` +
      `(\`review_policy.max_delta_rounds\`) because they are all below high severity ` +
      `and the pipeline is configured with \`ceiling_action: demote_and_advance\`. ` +
      `They should be reviewed and addressed in a follow-up change.`,
    "",
    "## Deferred findings",
  ];
  for (const f of demotedFindings) {
    const loc = f.surface ? ` — \`${f.surface}\`` : "";
    lines.push(`- \`${f.key}\` **[${f.severity.toUpperCase()}]** ${f.title}${loc}`);
  }
  lines.push(
    "",
    `> Deferred from #${originalIssue} at the pre-merge delta-round ceiling. Do not add a ` +
      `\`pipeline:\` label — this issue tracks follow-up work, not an in-progress pipeline run.`,
  );
  return lines.join("\n");
}

/**
 * Update comment appended to an existing delta-ceiling follow-up issue when
 * the item re-enters the delta-round ceiling again (#483). Mirrors
 * `buildFollowupUpdateComment` over {@link DeltaCeilingFinding}.
 */
export function buildDeltaFollowupUpdateComment(
  originalIssue: number,
  observed: number,
  demotedFindings: DeltaCeilingFinding[],
): string {
  const lines = [
    `Additional deferred pre-merge delta findings from #${originalIssue} (re-entry at delta-round ceiling, observed ${observed})`,
    "",
    "The item re-entered the pre-merge delta-round ceiling. The following below-high findings were demoted to advisory in this run:",
    "",
    "## Additional deferred findings",
  ];
  for (const f of demotedFindings) {
    const loc = f.surface ? ` — \`${f.surface}\`` : "";
    lines.push(`- \`${f.key}\` **[${f.severity.toUpperCase()}]** ${f.title}${loc}`);
  }
  lines.push(
    "",
    `> Re-entered from #${originalIssue} at the pre-merge delta-round ceiling (observed ${observed}). Do not add a \`pipeline:\` label.`,
  );
  return lines.join("\n");
}

// Re-export marker constants that callers (e.g. pre_merge.ts) use via this module.
export { REVIEW_MARKER_PREFIX_R1, REVIEW_MARKER_PREFIX_R2, DELTA_REVIEW_MARKER_PREFIX };
