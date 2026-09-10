import { createHash } from "node:crypto";

/** Canonical ordinary-loop identity for one resolved explicit work list. */
export function workListRunId(
  repo: string,
  engine: "claude" | "codex",
  issues: readonly string[],
): string {
  const hash = createHash("sha256").update(`${repo}:${engine}:${issues.join(",")}`).digest("hex").slice(0, 16);
  return `loop-${hash}`;
}
