// Thin re-export facade for the pre-merge stage (#628). The monolithic
// implementation has been split into focused domain modules; this file
// re-exports everything from them so existing import sites
// (`pipeline-run.ts`, tests, and related callers) need no import-path changes.
//
//   pre-merge-shared.ts           — preMergeBlocked, recordPreMergeGateResult
//   pre-merge-autofix.ts          — performPreMergeAutoFix + pure autofix helpers
//   pre-merge-sha-gate.ts         — enforceReviewShaGate, ShaGateDeps, currency, notices
//   pre-merge-openspec-archive.ts — maybeArchiveOpenspec, active-change guard
//   pre-merge-ci-gate.ts          — CI recovery markers + failure / zero-run paths
//   pre-merge-conflict-rebase.ts  — merge-conflict recovery, rebase helpers
//   pre-merge-routing.ts          — advance, advancePolling, AdvancePreMergeOpts/Deps

export * from "./pre-merge-shared.ts";
export * from "./pre-merge-autofix.ts";
export * from "./pre-merge-sha-gate.ts";
export * from "./pre-merge-openspec-archive.ts";
export * from "./pre-merge-ci-gate.ts";
export * from "./pre-merge-conflict-rebase.ts";
export * from "./pre-merge-routing.ts";

// Backward-compat re-exports that previously lived in the monolith.
export {
  enforceSpecConsistencyGuard,
  specDeltaIsStale,
  type FixCommit,
  type SpecConsistencyDeps,
} from "../openspec-consistency.ts";
export { isPipelineInternalCommit, OPENSPEC_ARCHIVE_PREFIX } from "../pipeline-commits.ts";
