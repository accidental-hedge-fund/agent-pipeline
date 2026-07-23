// Legacy goal-loop run import — theme -> DurableBlockerClass mapping (#509).
//
// The full goal-loop-run-import capability (openspec/specs/goal-loop-run-import)
// is not yet implemented; this module carries only the piece #509 requires so
// a future import implementation can translate a legacy run's free-text
// `blocked_theme` onto the typed classification this capability introduces,
// per design.md: "Legacy goal-loop import (loop/import.ts) maps an imported
// theme onto its class, so imported runs remain readable."

import { LoopError, isDurableBlockerClass, type DurableBlockerClass } from "./types.ts";

/** Known legacy goal-loop theme spellings mapped onto their
 *  {@link DurableBlockerClass}. Normalized to lowercase with runs of
 *  whitespace/hyphens collapsed to a single underscore before lookup, so
 *  "Rate Limit", "rate-limit", and "rate_limit" all resolve identically. */
const LEGACY_THEME_ALIASES: Record<string, DurableBlockerClass> = {
  rate_limit: "transient-rate-limit",
  rate_limited: "transient-rate-limit",
  throttled: "transient-rate-limit",
  workflow: "workflow-state",
  workflow_state: "workflow-state",
  ci: "implementation-ci",
  ci_failure: "implementation-ci",
  test_failure: "implementation-ci",
  build_failure: "implementation-ci",
  auth: "environment-auth",
  authentication: "environment-auth",
  environment: "environment-auth",
  spec: "specification-decision",
  specification: "specification-decision",
  decision: "specification-decision",
  product_decision: "specification-decision",
  authority: "missing-authority",
  permission: "missing-authority",
  needs_human: "missing-authority",
  upstream: "upstream-dependency",
  dependency: "upstream-dependency",
  blocked_on_dependency: "upstream-dependency",
  engine_defect: "workflow-engine-defect",
  engine_bug: "workflow-engine-defect",
  goal_loop_defect: "workflow-engine-defect",
};

function normalize(theme: string): string {
  return theme.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** Maps a legacy goal-loop `blocked_theme` onto its {@link DurableBlockerClass}.
 *  A theme that is already a valid class name (a native or already-migrated
 *  run) passes through unchanged. Refuses (LoopError "validation") a theme
 *  with no known mapping rather than guessing a class. */
export function mapLegacyThemeToBlockerClass(theme: string): DurableBlockerClass {
  if (isDurableBlockerClass(theme)) return theme;
  const mapped = LEGACY_THEME_ALIASES[normalize(theme)];
  if (!mapped) {
    throw new LoopError("validation", `legacy blocked theme "${theme}" does not map to any DurableBlockerClass`);
  }
  return mapped;
}
