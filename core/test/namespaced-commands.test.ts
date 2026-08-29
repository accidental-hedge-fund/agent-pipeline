// Host-surface drift-guard tests (#273, #1048).
//
// Covers:
//   7.5  OPERATION_SURFACE is the verb catalog. Hosts exec `pipeline <verb>`.
//        Build/install do not emit a per-verb command pack.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const COMMANDS_DIR = join(REPO_ROOT, "plugin", "pipeline", "commands");
const HOST_SKILL_PATHS = [
  join(REPO_ROOT, "hosts", "claude", "SKILL.md"),
  join(REPO_ROOT, "hosts", "codex", "SKILL.md"),
  join(REPO_ROOT, "hosts", "opencode", "SKILL.md"),
  join(REPO_ROOT, "hosts", "omp", "SKILL.md"),
];

// Canonical operation names per the namespaced-command-surface spec.
// run is intentionally absent — it is an undocumented alias only.
const EXPECTED_OPERATIONS = new Set([
  "status",
  "unblock",
  "override",
  "recover-parked",
  "summary",
  "doctor",
  "init",
  "cleanup",
  "intake",
  "decompose",
  "sweep",
  "triage",
  "merge",
  "merge-queue",
  "release",
  "roadmap",
  "logs",
  "loop",
]);

// ---------------------------------------------------------------------------
// 7.5a  Every expected operation remains in the shared CLI catalog
// ---------------------------------------------------------------------------

test("namespaced-commands 7.5a: OPERATION_SURFACE catalogs expected ops; no slash-command tree", async () => {
  const buildMjs = await import("../../scripts/build.mjs");
  const { OPERATION_SURFACE } = buildMjs;
  const catalog = new Set(OPERATION_SURFACE.map((op: { name: string }) => op.name));
  for (const expected of EXPECTED_OPERATIONS) {
    assert.ok(catalog.has(expected), `OPERATION_SURFACE missing catalog entry: ${expected}`);
  }
  for (const actual of catalog) {
    if (actual === "run") continue;
    assert.ok(
      EXPECTED_OPERATIONS.has(actual),
      `OPERATION_SURFACE has unexpected operation: ${actual}`,
    );
  }

  // Generate-into-temp is covered in scripts/build.test.mjs; here assert the
  // committed plugin tree is not a slash-command pack.
  const files = existsSync(COMMANDS_DIR)
    ? readdirSync(COMMANDS_DIR).filter((f) => f.startsWith("pipeline:") && f.endsWith(".md"))
    : [];
  assert.deepEqual(files, [], "plugin/pipeline/commands/ must not contain pipeline:*.md");
});

test("namespaced-commands 7.5a2: live surfaces advertise direct CLI verbs only", () => {
  const truthfulSurfacePaths = [
    ...HOST_SKILL_PATHS,
    join(REPO_ROOT, "CLAUDE.md"),
    join(REPO_ROOT, "README.md"),
    join(REPO_ROOT, "docs", "concepts.md"),
    join(REPO_ROOT, "core", "scripts", "pipeline.ts"),
  ];

  for (const surfacePath of truthfulSurfacePaths) {
    const content = readFileSync(surfacePath, "utf8");
    assert.doesNotMatch(
      content,
      /(?:\/|\$)pipeline:[a-z]/,
      `${surfacePath} must not advertise a removed per-verb host token`,
    );
  }

  for (const skillPath of HOST_SKILL_PATHS) {
    const content = readFileSync(skillPath, "utf8");
    assert.doesNotMatch(
      content,
      /First-ever invocation runs `npm install`/,
      `${skillPath} must not claim the launcher uses npm install`,
    );
    assert.match(content, /best-effort `npm ci`/, `${skillPath} must document installer prewarm`);
    assert.match(
      content,
      /first non-version launcher invocation\s+retries `npm ci`/,
      `${skillPath} must document first-run dependency self-heal`,
    );
    assert.match(content, /failed retry exits non-zero/, `${skillPath} must document fail-closed retry`);
  }

  const ompSkill = readFileSync(join(REPO_ROOT, "hosts", "omp", "SKILL.md"), "utf8");
  assert.doesNotMatch(
    ompSkill,
    /generated mirror\s+of\s+`core\/`/i,
    "OMP development guidance must not restore the retired core mirror",
  );
  assert.match(
    ompSkill,
    /product install path is the\s+pipeline CLI plus host SKILL/,
    "OMP development guidance must name the CLI plus host SKILL contract",
  );
});

// ---------------------------------------------------------------------------
// 7.5b  No pipeline:run host command exists (run is undocumented alias only)
// ---------------------------------------------------------------------------

test("namespaced-commands 7.5b: no pipeline:run.md command file exists", () => {
  let files: string[];
  try {
    files = readdirSync(COMMANDS_DIR);
  } catch {
    // If commands dir doesn't exist, run isn't there either — pass
    files = [];
  }
  assert.equal(
    files.includes("pipeline:run.md"),
    false,
    "pipeline:run.md must not exist — run is an undocumented alias, not a surface command",
  );
});

// ---------------------------------------------------------------------------
// 7.5b2  Codex and Claude operation sets are symmetric (both from OPERATION_SURFACE)
// ---------------------------------------------------------------------------

test("namespaced-commands 7.5b2: OPERATION_SURFACE is the shared catalog; no yaml agents generated", async () => {
  const buildMjs = await import("../../scripts/build.mjs");
  const { OPERATION_SURFACE, renderCodexCommand } = buildMjs;
  assert.equal(renderCodexCommand, undefined, "renderCodexCommand must not be exported");
  const names = new Set(OPERATION_SURFACE.map((op: { name: string }) => op.name));
  for (const expected of EXPECTED_OPERATIONS) {
    assert.ok(names.has(expected), `OPERATION_SURFACE missing operation: ${expected}`);
  }
  for (const actual of names) {
    if (actual === "run") continue;
    assert.ok(EXPECTED_OPERATIONS.has(actual), `OPERATION_SURFACE has unexpected operation: ${actual}`);
  }
});

// ---------------------------------------------------------------------------
// 7.5b3  The `loop` wrapper describes the in-repo supervisor — never external
//        goal-loop delegation (regression for the v1.26.0 internalization, #512).
//        The stale wrapper told the invoking agent to "delegate to the installed
//        goal-loop skill", contradicting the shipped in-repo supervisor and
//        causing a wrong external-skill invocation.
// ---------------------------------------------------------------------------

test("namespaced-commands 7.5b3: host SKILL loop guidance drives in-repo, never an external goal-loop skill", () => {
  const hostSkills = [
    join(REPO_ROOT, "hosts", "claude", "SKILL.md"),
    join(REPO_ROOT, "hosts", "codex", "SKILL.md"),
  ];
  for (const skillPath of hostSkills) {
    const content = readFileSync(skillPath, "utf8");
    assert.ok(
      !/delegate to the installed goal-loop/i.test(content),
      `${skillPath} must not instruct external goal-loop delegation`,
    );
    assert.ok(
      !/loop:contract-coherence/.test(content),
      `${skillPath} must not miscite loop:contract-coherence`,
    );
    assert.ok(
      /in-repo/i.test(content) && /supervisor/i.test(content),
      `${skillPath} should describe the in-repo loop supervisor`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7.5b4  Loop packaging is long-running + event-followed — never the shared
//        fast template that claims "completes in seconds" and forbids Monitor
//        (#668 / loop-skill-event-orchestration).
// ---------------------------------------------------------------------------

test("namespaced-commands 7.5b4: loop SKILL packaging is long-running; generator writes no pipeline:loop.md", async () => {
  const buildMjs = await import("../../scripts/build.mjs");
  const { OPERATION_SURFACE } = buildMjs;

  const loopOp = OPERATION_SURFACE.find(
    (op: { name: string; fast?: boolean; inRepoLoop?: boolean }) => op.name === "loop",
  ) as { name: string; fast?: boolean; inRepoLoop?: boolean } | undefined;
  assert.ok(loopOp, "OPERATION_SURFACE is missing the `loop` operation");
  assert.equal(loopOp.fast, false, "loop must not be classified as the shared fast template (#668)");
  assert.equal(loopOp.inRepoLoop, true, "loop must keep inRepoLoop packaging");

  const claudeSkill = readFileSync(join(REPO_ROOT, "hosts", "claude", "SKILL.md"), "utf8");
  const driveSection = claudeSkill.includes("### 4b. Orchestration pattern for `pipeline loop`")
    ? claudeSkill.slice(claudeSkill.indexOf("### 4b. Orchestration pattern for `pipeline loop`"))
    : claudeSkill;
  assert.ok(
    /long-running/i.test(driveSection),
    "host SKILL must state multi-item drive/resume is long-running",
  );
  assert.equal(
    existsSync(join(COMMANDS_DIR, "pipeline:loop.md")),
    false,
    "scripts/build.mjs must not write plugin/pipeline/commands/pipeline:loop.md",
  );
});

test("namespaced-commands 7.5b4b: true-fast peers may still note seconds; no slash files emitted", async () => {
  const buildMjs = await import("../../scripts/build.mjs");
  const { OPERATION_SURFACE } = buildMjs;
  const skill = readFileSync(join(REPO_ROOT, "hosts", "claude", "SKILL.md"), "utf8");

  for (const name of ["status", "doctor"] as const) {
    const op = OPERATION_SURFACE.find((o: { name: string; fast?: boolean }) => o.name === name) as
      | { name: string; fast?: boolean }
      | undefined;
    assert.ok(op, `OPERATION_SURFACE is missing \`${name}\``);
    assert.equal(op.fast, true, `${name} stays a fast catalog entry`);
    assert.equal(
      existsSync(join(COMMANDS_DIR, `pipeline:${name}.md`)),
      false,
      `generator must not emit pipeline:${name}.md`,
    );
  }
  assert.ok(
    /completes in seconds/i.test(skill),
    "SKILL or CLI docs MAY still note that true-fast verbs complete in seconds",
  );
});

// #699: host loop orchestration must stop run-scoped follows on terminal in the
// same turn; dual-follow must exit; one-liners must not claim unconditional
// "no auto-exit on terminal" without documenting until-terminal default.
// Bare `tail -F …events.jsonl` is forbidden as a documented follow command —
// it never exits on loop_run_stopped (zombie-follow failure mode).
test("namespaced-commands 7.5b6: host loop skill stop-on-terminal + dual-follow exit (#699)", () => {
  const repoRoot = join(__dirname, "..", "..");
  const hostSkills = [
    join(repoRoot, "hosts", "claude", "SKILL.md"),
    join(repoRoot, "hosts", "codex", "SKILL.md"),
  ];
  for (const skillPath of hostSkills) {
    const body = readFileSync(skillPath, "utf8");
    assert.ok(
      /loop_run_stopped/i.test(body),
      `${skillPath} must mention loop_run_stopped`,
    );
    // Orchestration semantics: same-turn stop of run-scoped follows on terminal
    // (loop_run_stopped and/or supervisor exit) — not unscoped "same turn" alone.
    assert.ok(
      /(?:loop_run_stopped|supervisor(?: process)? exit)[\s\S]{0,500}(?:same turn|same-turn|in the same harness turn)|(?:same turn|same-turn|in the same harness turn)[\s\S]{0,500}(?:loop_run_stopped|supervisor)/i.test(
        body,
      ),
      `${skillPath} must require same-turn stop of run-scoped follows on loop_run_stopped / supervisor exit (#699)`,
    );
    assert.ok(
      /follows stopped|follow.*stopped/i.test(body),
      `${skillPath} final summary must include follows-stopped confirmation (#699)`,
    );
    assert.ok(
      /exit 0|exit with code 0|exits 0/i.test(body),
      `${skillPath} dual-follow / multi-stream guidance must exit 0 on terminal (#699)`,
    );
    // Forbidden: primary one-liner that claims unconditional no-auto-exit without
    // documenting until-terminal default-on.
    const oneLiners = body
      .split("\n")
      .filter((l) => /loop logs/.test(l) && /--follow|-f\b/.test(l));
    for (const line of oneLiners) {
      if (/no auto-exit on terminal/i.test(line) && !/until-terminal/i.test(line)) {
        assert.fail(
          `${skillPath} loop logs one-liner claims unconditional no auto-exit without until-terminal docs: ${line}`,
        );
      }
    }
    assert.ok(
      /until-terminal|exits on loop_run_stopped|exit.*loop_run_stopped/i.test(body),
      `${skillPath} must document until-terminal / exit-on-loop_run_stopped for loop logs follow (#699)`,
    );
    // Forbidden: bare `tail -F` on events.jsonl as a standalone follow command.
    // Allowed only when nested in a terminal-aware wrapper that (1) exit 0s on
    // loop_run_stopped AND (2) explicitly tracks + TERM/KILLs the tail child.
    // Process substitution + bare exit 0 orphans tail -F (zombie follow).
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/^\s*tail\s+(?:-n\s+\+1\s+)?-F\s+/.test(line) || !/events\.jsonl/.test(line)) {
        continue;
      }
      // Standalone fence line: the whole code-fence command is only `tail -F …`
      // (no while/read ownership on surrounding lines of the same fence).
      let fenceStart = i;
      while (fenceStart > 0 && !/^```/.test(lines[fenceStart - 1]!)) fenceStart--;
      let fenceEnd = i;
      while (fenceEnd < lines.length - 1 && !/^```/.test(lines[fenceEnd + 1]!)) fenceEnd++;
      const fence = lines.slice(fenceStart, fenceEnd + 1).join("\n");
      const hasExit =
        /\bexit 0\b/.test(fence) &&
        (/\bwhile\b/.test(fence) || /\bread\b/.test(fence)) &&
        /loop_run_stopped/.test(fence);
      // Child teardown: tracked PID + kill -TERM / kill -KILL (not process-sub alone).
      const hasChildTeardown =
        /TAIL_PID|tail_pid/.test(fence) &&
        /kill\s+-TERM|kill\s+-KILL|kill\s+-\$?TERM|kill\s+-\$?KILL/.test(fence);
      // Process-sub alone is explicitly insufficient (#699 review-2 f7ea742f).
      const processSubOnly =
        /<\s*<\s*\(\s*tail\b/.test(fence) && !hasChildTeardown;
      if (!hasExit || !hasChildTeardown || processSubOnly) {
        assert.fail(
          `${skillPath} documents tail -F on events.jsonl without explicit child teardown ` +
            `(must track TAIL_PID, kill -TERM/-KILL, and exit 0 after loop_run_stopped; ` +
            `process substitution + exit 0 alone is not enough): ${line}`,
        );
      }
    }
    // Must explicitly forbid bare tail or document terminal-aware ownership with
    // child teardown (not process-sub / exit-0-only).
    assert.ok(
      /bare `?tail -F`?|do \*\*not\*\* use a bare `?tail|TERM\/KILL|kill -TERM|explicit(?:ly)? track|child teardown|terminal-aware/i.test(
        body,
      ),
      `${skillPath} must forbid bare tail -F or require explicit tail child teardown (#699)`,
    );
    // Guard: process-sub + exit 0 alone must not be presented as sufficient ownership.
    assert.ok(
      !/owns tail via process substitution/i.test(body),
      `${skillPath} must not claim process substitution owns/terminates tail (#699 f7ea742f)`,
    );
    // Forbidden: mktemp -u as a live shell command for FIFO paths (TOCTOU
    // clobber / data-loss hazard). Comments that name the ban are fine.
    // Safe pattern: mktemp -d private dir, mkfifo inside it, abort if mkfifo fails.
    for (const codeLine of body.split("\n")) {
      const trimmed = codeLine.trim();
      if (trimmed.startsWith("#")) continue; // prose / shell comment
      if (/\bmktemp\s+-u\b/.test(trimmed)) {
        assert.fail(
          `${skillPath} documents mktemp -u as live code (TOCTOU FIFO clobber hazard; use mktemp -d + mkfifo inside) (#699 de4df498): ${trimmed}`,
        );
      }
    }
    // When a raw dual-follow fence uses mkfifo, require private-dir + fail-closed mkfifo.
    const skillLines = body.split("\n");
    for (let i = 0; i < skillLines.length; i++) {
      const line = skillLines[i]!;
      if (!/\bmkfifo\b/.test(line)) continue;
      let fenceStart = i;
      while (fenceStart > 0 && !/^```/.test(skillLines[fenceStart - 1]!)) fenceStart--;
      let fenceEnd = i;
      while (fenceEnd < skillLines.length - 1 && !/^```/.test(skillLines[fenceEnd + 1]!)) {
        fenceEnd++;
      }
      const fence = skillLines.slice(fenceStart, fenceEnd + 1).join("\n");
      const hasPrivateDir = /\bmktemp\s+-d\b/.test(fence);
      const abortsOnMkfifoFail =
        /mkfifo\s+"?\$[A-Za-z_][A-Za-z0-9_]*"?\s*\|\|/.test(fence) ||
        /mkfifo[^\n]*\|\|\s*\{/.test(fence) ||
        /mkfifo[^\n]*\|\|\s*exit/.test(fence);
      if (!hasPrivateDir || !abortsOnMkfifoFail) {
        assert.fail(
          `${skillPath} raw-follow mkfifo fence must use mktemp -d and abort if mkfifo fails (#699 de4df498): ${line}`,
        );
      }
    }
  }
});

// #725: single-issue advance §4 must require re-attach after cancelled/lost
// follow, treat cancelled wait as non-terminal, and document run-store
// re-attach path (status + logs --events --follow + summary).
test("namespaced-commands 7.5b7: host advance skill re-attach + cancelled-wait-not-terminal (#725)", () => {
  const repoRoot = join(__dirname, "..", "..");
  const hostSkills = [
    join(repoRoot, "hosts", "claude", "SKILL.md"),
    join(repoRoot, "hosts", "codex", "SKILL.md"),
  ];
  for (const skillPath of hostSkills) {
    const body = readFileSync(skillPath, "utf8");

    // (a) re-attach / re-arm after cancelled or interrupted follow before terminal
    assert.ok(
      /re-?attach|re-?arm/i.test(body),
      `${skillPath} must require re-attach/re-arm after lost advance follow (#725)`,
    );
    assert.ok(
      /(?:cancelled|interrupted|timed-?out|lost)[\s\S]{0,400}(?:re-?attach|re-?arm)|(?:re-?attach|re-?arm)[\s\S]{0,400}(?:cancelled|interrupted|timed-?out|lost)/i.test(
        body,
      ),
      `${skillPath} must tie re-attach to cancelled/interrupted/lost follow (#725)`,
    );
    assert.ok(
      /same turn|same-turn|in the same harness turn/i.test(body),
      `${skillPath} must require same-turn re-attach for advance follow recovery (#725)`,
    );

    // (b) cancelled wait is not a terminal pipeline outcome
    assert.ok(
      /(?:cancelled|interrupted|timed-?out).{0,120}(?:not|≠|is not).{0,40}terminal|not a terminal pipeline outcome/i.test(
        body,
      ),
      `${skillPath} must state cancelled wait is not a terminal pipeline outcome (#725)`,
    );
    assert.ok(
      /stop watching|must \*\*not\*\* be treated as|must not be treated as/i.test(body),
      `${skillPath} must forbid treating cancelled wait as stop-watching (#725)`,
    );

    // (c) run-store re-attach path: status + logs --events --follow + summary
    assert.ok(
      /status\s+<N>|status <N>|pipeline status/i.test(body),
      `${skillPath} re-attach path must include status <N> (#725)`,
    );
    assert.ok(
      /logs\s+<run-id>\s+--events\s+--follow|logs <run-id> --events --follow/i.test(body),
      `${skillPath} re-attach path must include logs <run-id> --events --follow (#725)`,
    );
    assert.ok(
      /summary\s+<[^>\n]*run-id[^>\n]*>/i.test(body),
      `${skillPath} re-attach path must include a summary selector with run-id (#725)`,
    );

    // Advance events follow documents until-terminal default on run_complete
    assert.ok(
      /until-terminal|exits 0 after a run_complete|exit 0 after a run_complete|exits 0 on run_complete/i.test(
        body,
      ),
      `${skillPath} must document until-terminal / exit-on-run_complete for advance logs follow (#725)`,
    );

    // Forbidden: advance logs one-liner that claims unconditional no-auto-exit
    // without documenting until-terminal / run_complete default.
    const oneLiners = body
      .split("\n")
      .filter(
        (l) =>
          /logs\s/.test(l) &&
          /--events/.test(l) &&
          /--follow|-f\b/.test(l) &&
          !/loop logs/.test(l),
      );
    for (const line of oneLiners) {
      if (/no auto-exit on terminal/i.test(line) && !/until-terminal|run_complete/i.test(line)) {
        assert.fail(
          `${skillPath} advance logs one-liner claims unconditional no auto-exit without until-terminal docs: ${line}`,
        );
      }
    }
  }
});

test("namespaced-commands 7.5b6b: host SKILL loop packaging requires same-turn stop + follows stopped (#699)", () => {
  const claude = readFileSync(join(REPO_ROOT, "hosts", "claude", "SKILL.md"), "utf8");
  assert.ok(/loop_run_stopped/i.test(claude), "loop SKILL packaging must mention loop_run_stopped");
  assert.ok(
    /same turn|same-turn|in the same/i.test(claude) || /stop.*follow/i.test(claude),
    "loop SKILL packaging must instruct stop of follows on terminal",
  );
});

// #668 pre-merge: skill lock discovery must not use unanchored grep of $LOOP_PID
// (pid 123 matching lock pid 12345).
test("namespaced-commands 7.5b5: host loop skill ownership is exact PID, not grepped prefix", () => {
  const repoRoot = join(__dirname, "..", "..");
  const hostSkills = [
    join(repoRoot, "hosts", "claude", "SKILL.md"),
    join(repoRoot, "hosts", "codex", "SKILL.md"),
  ];
  // Forbidden: grep matching "\"pid\":$LOOP_PID" which prefix-matches 12345 when LOOP_PID=123.
  const badGrep = /grep\s+-q\s+"\\"pid\\"[^"]*\$LOOP_PID/;
  for (const path of hostSkills) {
    const body = readFileSync(path, "utf8");
    assert.ok(
      !badGrep.test(body),
      `${path} must not use unanchored grep of $LOOP_PID against lock.json (#668)`,
    );
    assert.ok(
      /lock_owned_by_launcher|numeric identity only|exact integer/i.test(body),
      `${path} should document exact/numeric lock ownership (#668)`,
    );
    assert.ok(
      /LOOP_START|starttime|launcher_instance_alive|PID reuse/i.test(body),
      `${path} should bind discovery to process starttime against PID reuse (#668)`,
    );
    assert.ok(
      /lstart|Darwin|macOS|portable/i.test(body) && /proc/i.test(body),
      `${path} should document Linux /proc and Darwin/portable starttime backends (#668)`,
    );
    assert.ok(
      /mktemp/i.test(body),
      `${path} should use mktemp for per-invocation loop result files (#668)`,
    );
    assert.ok(
      !/pipeline-loop-\$\.out|pipeline-loop-\$\.err|pipeline-loop-\$\$\.out/i.test(body),
      `${path} must not use colliding /tmp/pipeline-loop-$ paths (#668)`,
    );
  }
});

test("namespaced-commands 7.5c: status is a CLI catalog verb, not a required slash file", async () => {
  const buildMjs = await import("../../scripts/build.mjs");
  const { OPERATION_SURFACE } = buildMjs;
  const status = OPERATION_SURFACE.find((op: { name: string }) => op.name === "status");
  assert.ok(status, "catalog must list status");
  assert.equal(existsSync(join(COMMANDS_DIR, "pipeline:status.md")), false);
});
