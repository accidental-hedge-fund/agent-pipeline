/**
 * Neutral pipeline-internal commit classification (#629).
 *
 * Owns the subject prefixes/patterns and `isPipelineInternalCommit` so pre-merge
 * SHA-gate currency, shipcheck post-verdict revalidation, visual publish, and
 * tests share one source of truth without stage-to-stage FSM coupling
 * (shipcheck must not import pre_merge for classification).
 *
 * This module MUST NOT import from `stages/*`.
 */

/** OpenSpec archive subject prefix. Any headline starting with this is pipeline-internal. */
export const OPENSPEC_ARCHIVE_PREFIX = "chore: archive OpenSpec change(s) for #";

/**
 * Visual-gate artifact-publish subject prefix. Exact match with issue digits
 * (prefix + one or more digits, nothing else) is pipeline-internal.
 */
export const VISUAL_PUBLISH_COMMIT_PREFIX = "chore: publish visual-gate evidence for #";

/**
 * Exact publish-commit subject pattern (#463): the full prescribed subject,
 * `VISUAL_PUBLISH_COMMIT_PREFIX` followed by an issue number and nothing
 * else. Matched in full (not as a prefix) so a developer's own code-changing
 * commit merely starting with the same words does NOT match.
 */
export const VISUAL_PUBLISH_COMMIT_PATTERN = new RegExp(
  `^${VISUAL_PUBLISH_COMMIT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+$`,
);

/**
 * True iff the commit headline is pipeline-internal under the tested runtime
 * contract (#98 / #228 / #463):
 * - OpenSpec archive prefix, or
 * - exact visual-gate artifact-publish subject
 *
 * Docs-update, auto-format, pre-merge auto-fix, salvage, and ordinary
 * developer/fix/feat subjects are NOT pipeline-internal.
 */
export function isPipelineInternalCommit(messageHeadline: string): boolean {
  return (
    messageHeadline.startsWith(OPENSPEC_ARCHIVE_PREFIX) ||
    VISUAL_PUBLISH_COMMIT_PATTERN.test(messageHeadline)
  );
}
