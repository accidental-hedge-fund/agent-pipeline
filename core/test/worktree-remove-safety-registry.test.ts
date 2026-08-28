// #759: every production worktree-removal call site is ladder-backed or
// explicitly exempt. Static source scan — no network/git.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../scripts",
);

/** Known production removers and how they are authorized (#759). */
const CALL_SITE_POLICY: Array<{
  file: string;
  /** Substring that identifies the remove call. */
  pattern: RegExp;
  kind: "ladder" | "safe-wrapper" | "exempt";
  note: string;
}> = [
  {
    file: "worktree.ts",
    pattern: /evaluateRemoveSafety\(/,
    kind: "ladder",
    note: "shared ladder definition + removeWorktreeForIssue / reclaim / park",
  },
  {
    file: "worktree.ts",
    pattern: /export async function removeManagedWorktreeSafely/,
    kind: "safe-wrapper",
    note: "single wrapper that always evaluates remove safety once",
  },
  {
    file: "stages/auto_recover.ts",
    pattern: /removeManagedWorktreeSafely|safeRemove/,
    kind: "safe-wrapper",
    note: "auto_recover routes through removeManagedWorktreeSafely",
  },
  {
    file: "stages/deploy_ready.ts",
    pattern: /removeManagedWorktreeSafely|safeRemoveFn/,
    kind: "safe-wrapper",
    note: "deploy_ready routes through removeManagedWorktreeSafely",
  },
  {
    file: "worktree.ts",
    pattern: /releaseWorktreeForParkedIssue/,
    kind: "ladder",
    note: "park release evaluates evaluateRemoveSafety once",
  },
  {
    file: "stages/train.ts",
    pattern: /releaseWorktreeForParkedIssue/,
    kind: "ladder",
    note: "train --merge park-release after proven merge uses shared bound-proof gate",
  },
  {
    file: "pipeline.ts",
    pattern: /removeWorktreeForIssue/,
    kind: "ladder",
    note: "operator --remove-worktree uses removeWorktreeForIssue ladder",
  },
  {
    file: "evals/executor.ts",
    pattern: /removeWorktreeAt|removeWorktreeFn/,
    kind: "exempt",
    note:
      "EXEMPT(#759): eval cell teardown removes ephemeral unique eval paths that are never issue-managed worktrees; not operator/issue recovery surface",
  },
  {
    file: "evals/grading/checks.ts",
    pattern: /removeWorktreeAt|removeWorktreeFn/,
    kind: "exempt",
    note:
      "EXEMPT(#759): grading harness tears down ephemeral fixture worktrees only",
  },
];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listTsFiles(full));
    else if (ent.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("removal call-site policy entries match source", () => {
  for (const site of CALL_SITE_POLICY) {
    const src = readFileSync(path.join(scriptsDir, site.file), "utf8");
    assert.ok(
      site.pattern.test(src),
      `${site.file} must match ${site.pattern} (${site.note})`,
    );
  }
});

test("auto_recover and deploy_ready do not bare-call removeWorktree without safety", () => {
  const auto = readFileSync(path.join(scriptsDir, "stages/auto_recover.ts"), "utf8");
  const deploy = readFileSync(path.join(scriptsDir, "stages/deploy_ready.ts"), "utf8");
  // Must not invoke removeWorktree as the sole removal path without the wrapper.
  assert.match(auto, /removeManagedWorktreeSafely/);
  assert.match(deploy, /removeManagedWorktreeSafely/);
  // The historical unguarded call sites must not reappear as direct production removes.
  assert.doesNotMatch(
    auto,
    /await deps\.removeWorktree\(cfg,\s*issueNumber,\s*wt\.slug\)/,
    "auto_recover must not force-remove without safety wrapper",
  );
  assert.doesNotMatch(
    deploy,
    /await removeWorktree\(cfg,\s*issueNumber,\s*wt\.slug\)/,
    "deploy_ready must not force-remove without safety wrapper",
  );
});

test("train --merge does not invent a path-local worktree remover", () => {
  const train = readFileSync(path.join(scriptsDir, "stages/train.ts"), "utf8");
  assert.match(train, /releaseWorktreeForParkedIssue/);
  const stripped = train
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(
    stripped,
    /git worktree remove/,
    "train must not add a git worktree remove path that bypasses the shared gate",
  );
  assert.doesNotMatch(
    stripped,
    /removeWorktree\s*\(/,
    "train must not call removeWorktree; park-release goes through releaseWorktreeForParkedIssue",
  );
  assert.doesNotMatch(
    train,
    /removeManagedWorktreeSafely/,
    "train park-release uses releaseWorktreeForParkedIssue (same bound-proof gate)",
  );
});

test("parked release evaluates evaluateRemoveSafety exactly once in body", () => {
  const src = readFileSync(path.join(scriptsDir, "worktree.ts"), "utf8");
  const fnStart = src.indexOf("export async function releaseWorktreeForParkedIssue");
  assert.ok(fnStart >= 0);
  const nextExport = src.indexOf("\nexport ", fnStart + 10);
  const body = src.slice(fnStart, nextExport === -1 ? undefined : nextExport);
  const matches = body.match(/evaluateRemoveSafety\(/g) ?? [];
  assert.equal(
    matches.length,
    1,
    `park release must call evaluateRemoveSafety once; found ${matches.length}`,
  );
});

test("no new unguarded production removeWorktree call sites outside registry", () => {
  const files = listTsFiles(scriptsDir);
  const offenders: string[] = [];
  for (const file of files) {
    const rel = path.relative(scriptsDir, file);
    // Definition and internal helpers in worktree.ts are expected.
    if (rel === "worktree.ts") continue;
    if (rel.startsWith("evals/")) continue; // exempted above
    const src = readFileSync(file, "utf8");
    // Flag direct production calls to removeWorktree( that are not type-only.
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.includes("removeWorktree(") && !line.trimStart().startsWith("//")) {
        // Allow type imports, interface fields, and deps defaults.
        if (
          /typeof removeWorktree|removeWorktree\?:|removeWorktree:|=\s*removeWorktree[,;]|import\s*\{[^}]*removeWorktree/.test(
            line,
          )
        ) {
          continue;
        }
        if (/await\s+.*removeWorktree\s*\(/.test(line) || /removeWorktree\s*\(\s*cfg/.test(line)) {
          // Allowed if the file is registered as using the safe wrapper and
          // this is the deps-injected path after safety.
          if (
            rel === "stages/auto_recover.ts" &&
            /deps\.removeWorktree|removeFn/.test(line)
          ) {
            continue;
          }
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `unguarded removeWorktree call sites:\n${offenders.join("\n")}`,
  );
});
