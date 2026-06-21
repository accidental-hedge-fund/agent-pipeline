// Thin re-export facade for the review stage. The monolithic implementation has
// been split into four focused modules; this file re-exports everything from
// them so existing import sites (`pre_merge.ts`, tests) need no import-path
// changes.
//
//   review-parsing.ts    — sentinels, codec, ReviewArtifact, parse helpers
//   review-rendering.ts  — comment formatting (formatReviewComment, etc.)
//   review-acquisition.ts — plan/summary extraction from issue comment threads
//   review-routing.ts    — advanceReview main loop + AdvanceReviewDeps seam

export * from "./review-parsing.ts";
export * from "./review-rendering.ts";
export * from "./review-acquisition.ts";
export * from "./review-routing.ts";

// Backward-compat named object for tests that import _internals.
import { extractPlan, extractReview1Summary } from "./review-acquisition.ts";
export const _internals = { extractPlan, extractReview1Summary };
