// Data-fetching helpers for the review stage: plan and summary extraction from
// issue comment threads. No network calls here — these are pure string parsers
// over an already-fetched comments array.

import { findLatestCommentMatching } from "../gh.ts";
import {
  REVIEW_MARKER_PREFIX_R1,
  REVIEW_MARKER_PREFIX_R2,
} from "./review-parsing.ts";

export function extractPlan(comments: { body: string }[]): string {
  const m = findLatestCommentMatching(
    comments.map((c) => ({ ...c, author: "", createdAt: "" })),
    (b) => b.startsWith("## Implementation Plan"),
  );
  return m?.body ?? "(plan not found in comments)";
}

export function extractReview1Summary(comments: { body: string }[]): string {
  const m = findLatestCommentMatching(
    comments.map((c) => ({ ...c, author: "", createdAt: "" })),
    (b) => b.startsWith(REVIEW_MARKER_PREFIX_R1),
  );
  return (m?.body ?? "").slice(0, 2000);
}

/** Latest prior `## Review 2` comment body, for the convergence ratchet. */
export function extractReview2Findings(comments: { body: string }[]): string | undefined {
  const m = findLatestCommentMatching(
    comments.map((c) => ({ ...c, author: "", createdAt: "" })),
    (b) => b.startsWith(REVIEW_MARKER_PREFIX_R2),
  );
  return m?.body ? m.body.slice(0, 2000) : undefined;
}
