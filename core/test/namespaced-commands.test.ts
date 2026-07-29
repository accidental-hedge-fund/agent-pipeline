// Host-surface drift-guard tests (#273).
//
// Covers:
//   7.5  The generated plugin/pipeline/commands/ directory contains exactly the
//        operations defined by the namespaced-command-surface spec — no more,
//        no less, and no pipeline:run entry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load as yamlLoad } from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
// core/test/ → ../../ = repo root, then plugin/pipeline/commands/
const COMMANDS_DIR = join(__dirname, "..", "..", "plugin", "pipeline", "commands");

// Canonical operation names per the namespaced-command-surface spec.
// run is intentionally absent — it is an undocumented alias only.
const EXPECTED_OPERATIONS = new Set([
  "status",
  "unblock",
  "override",
  "summary",
  "doctor",
  "init",
  "cleanup",
  "intake",
  "sweep",
  "triage",
  "merge",
  "release",
  "roadmap",
  "logs",
  "loop",
]);

// ---------------------------------------------------------------------------
// 7.5a  Every expected operation has a generated command file
// ---------------------------------------------------------------------------

test("namespaced-commands 7.5a: plugin/pipeline/commands/ exists and contains exactly the expected operations", () => {
  let files: string[];
  try {
    files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".md"));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    assert.fail(
      `plugin/pipeline/commands/ does not exist — run \`node scripts/build.mjs\` and commit the output. (${e.message})`,
    );
  }

  // Extract operation names: "pipeline:status.md" → "status"
  const actualOps = new Set(
    files.map((f) => {
      const match = /^pipeline:(.+)\.md$/.exec(f);
      assert.ok(match, `Unexpected file name format in commands dir: ${f}`);
      return match[1];
    }),
  );

  // Every expected op must be present
  for (const expected of EXPECTED_OPERATIONS) {
    assert.ok(
      actualOps.has(expected),
      `Missing command file: pipeline:${expected}.md — run \`node scripts/build.mjs\` and commit`,
    );
  }

  // No extra files beyond the expected set
  for (const actual of actualOps) {
    assert.ok(
      EXPECTED_OPERATIONS.has(actual),
      `Unexpected command file: pipeline:${actual}.md — remove it from OPERATION_SURFACE or add it to the spec`,
    );
  }
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

test("namespaced-commands 7.5b2: renderCodexCommand produces entries for every Claude operation", async () => {
  // Safe to import now that build.mjs has an ESM main guard (Finding 1 fix).
  const buildMjs = await import("../../scripts/build.mjs");
  const { OPERATION_SURFACE, renderCodexCommand } = buildMjs;

  for (const op of OPERATION_SURFACE) {
    const content = renderCodexCommand(op);
    assert.ok(typeof content === "string" && content.length > 0, `renderCodexCommand returned empty for operation ${op.name}`);
    assert.ok(content.includes(`pipeline:${op.name}`), `renderCodexCommand output missing pipeline:${op.name}`);
    // Must be valid YAML — at minimum it must contain the interface key
    assert.ok(content.includes("interface:"), `renderCodexCommand output for ${op.name} missing 'interface:' key`);
  }

  // Codex operation names must match the Claude expected set
  const codexNames = new Set(OPERATION_SURFACE.map((op) => op.name));
  for (const expected of EXPECTED_OPERATIONS) {
    assert.ok(codexNames.has(expected), `OPERATION_SURFACE missing operation: ${expected} (Codex would be missing it too)`);
  }
  for (const actual of codexNames) {
    if (actual === "run") continue; // run is undocumented alias; excluded from both surfaces
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

test("namespaced-commands 7.5b3: loop wrapper drives in-repo, never delegates to an external goal-loop skill", async () => {
  const buildMjs = await import("../../scripts/build.mjs");
  const { OPERATION_SURFACE, renderClaudeCommand, renderCodexCommand } = buildMjs;

  const loopOp = OPERATION_SURFACE.find((op: { name: string }) => op.name === "loop");
  assert.ok(loopOp, "OPERATION_SURFACE is missing the `loop` operation");

  const claude = renderClaudeCommand(loopOp, "~/.claude/skills/pipeline");
  const codex = renderCodexCommand(loopOp);

  for (const [surface, content] of [["claude", claude], ["codex", codex]] as const) {
    // The run is driven in-repo; no wrapper may instruct external delegation.
    assert.ok(
      !/goal-loop/i.test(content),
      `loop ${surface} wrapper references an external goal-loop skill (internalized in #512): ${content}`,
    );
    assert.ok(
      !/delegate/i.test(content),
      `loop ${surface} wrapper still instructs delegation — the loop runs in-repo: ${content}`,
    );
    // And it must never miscite the run-start preflight check name.
    assert.ok(
      !/loop:contract-coherence/.test(content),
      `loop ${surface} wrapper miscites the run-start check; it is loop:store-schema-compatibility: ${content}`,
    );
  }

  // The Claude wrapper must positively describe in-repo supervisor execution.
  assert.ok(
    /in-repo/i.test(claude) && /supervisor/i.test(claude),
    `loop Claude wrapper should describe the in-repo loop supervisor: ${claude}`,
  );

  // #665: multi-item durable drive must not claim "completes in seconds" / "No Monitor".
  assert.ok(
    !/completes in seconds/i.test(claude),
    `loop Claude wrapper must not claim multi-item drive completes in seconds: ${claude}`,
  );
  assert.ok(
    !/No Monitor needed/i.test(claude),
    `loop Claude wrapper must not claim No Monitor is needed for multi-item drive: ${claude}`,
  );
  assert.ok(
    /loop_run_handoff/.test(claude) && /events/.test(claude),
    `loop Claude wrapper should document early handoff run_id + events path: ${claude}`,
  );
});

// ---------------------------------------------------------------------------
// 7.5b4  Loop packaging is long-running + event-followed — never the shared
//        fast template that claims "completes in seconds" and forbids Monitor
//        (#668 / loop-skill-event-orchestration).
// ---------------------------------------------------------------------------

test("namespaced-commands 7.5b4: loop Claude command is long-running, not seconds/no-Monitor", async () => {
  const buildMjs = await import("../../scripts/build.mjs");
  const { OPERATION_SURFACE, renderClaudeCommand } = buildMjs;

  const loopOp = OPERATION_SURFACE.find(
    (op: { name: string; fast?: boolean; inRepoLoop?: boolean }) => op.name === "loop",
  ) as { name: string; fast?: boolean; inRepoLoop?: boolean } | undefined;
  assert.ok(loopOp, "OPERATION_SURFACE is missing the `loop` operation");
  assert.equal(loopOp.fast, false, "loop must not be classified as the shared fast template (#668)");
  assert.equal(loopOp.inRepoLoop, true, "loop must keep inRepoLoop packaging");

  const claude = renderClaudeCommand(loopOp, "~/.claude/skills/pipeline");

  // Forbidden fast-path falsehoods (case-insensitive substring match).
  assert.ok(
    !/completes in seconds/i.test(claude),
    `loop Claude command must not claim "completes in seconds": ${claude}`,
  );
  assert.ok(
    !/no background process or monitor needed/i.test(claude),
    `loop Claude command must not forbid Monitor/background process: ${claude}`,
  );

  // Positive long-running / event-follow orchestration signals.
  assert.ok(
    /long-running/i.test(claude),
    `loop Claude command should state multi-item drive/resume is long-running: ${claude}`,
  );
  assert.ok(
    /event/i.test(claude) && (/follow/i.test(claude) || /Monitor/i.test(claude)),
    `loop Claude command should instruct event following / Monitor: ${claude}`,
  );
  assert.ok(
    /run_id/i.test(claude),
    `loop Claude command should mention run_id handoff: ${claude}`,
  );
  // --audit may remain documented as synchronous; must not redefine drive/resume.
  assert.ok(
    /--audit/i.test(claude),
    `loop Claude command should still note --audit as a short/sync mode: ${claude}`,
  );

  // Generated plugin mirror must match the same classification after build.
  const pluginLoopPath = join(COMMANDS_DIR, "pipeline:loop.md");
  let pluginBody: string;
  try {
    pluginBody = readFileSync(pluginLoopPath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    assert.fail(
      `plugin/pipeline/commands/pipeline:loop.md missing — run \`node scripts/build.mjs\` (${e.message})`,
    );
  }
  assert.ok(
    !/completes in seconds/i.test(pluginBody),
    `plugin pipeline:loop.md must not claim "completes in seconds": ${pluginBody}`,
  );
  assert.ok(
    !/no background process or monitor needed/i.test(pluginBody),
    `plugin pipeline:loop.md must not forbid Monitor: ${pluginBody}`,
  );
  assert.ok(
    /long-running/i.test(pluginBody) || /event/i.test(pluginBody),
    `plugin pipeline:loop.md should describe long-running / event-follow orchestration: ${pluginBody}`,
  );
});

test("namespaced-commands 7.5b4b: true-fast peers may still use the shared seconds/no-Monitor template", async () => {
  const buildMjs = await import("../../scripts/build.mjs");
  const { OPERATION_SURFACE, renderClaudeCommand } = buildMjs;

  for (const name of ["status", "doctor"] as const) {
    const op = OPERATION_SURFACE.find((o: { name: string }) => o.name === name);
    assert.ok(op, `OPERATION_SURFACE is missing \`${name}\``);
    const body = renderClaudeCommand(op, "~/.claude/skills/pipeline");
    assert.ok(
      /completes in seconds/i.test(body),
      `${name} should still use the shared fast template (seconds): ${body}`,
    );
    assert.ok(
      /no background process or monitor needed/i.test(body),
      `${name} should still use the shared fast template (no Monitor): ${body}`,
    );
  }
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
    // Allowed only when nested in a terminal-aware wrapper (while/read + exit 0
    // on loop_run_stopped) that owns the tail process.
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
      const terminalAware =
        /\bexit 0\b/.test(fence) &&
        (/\bwhile\b/.test(fence) || /\bread\b/.test(fence)) &&
        /loop_run_stopped/.test(fence);
      if (!terminalAware) {
        assert.fail(
          `${skillPath} documents bare tail -F on events.jsonl without terminal-aware ownership (must exit 0 after loop_run_stopped): ${line}`,
        );
      }
    }
    // Must explicitly forbid bare tail or document terminal-aware ownership.
    assert.ok(
      /bare `?tail -F`?|do \*\*not\*\* use a bare `?tail|owns and terminates its tail|terminal-aware/i.test(
        body,
      ),
      `${skillPath} must forbid bare tail -F or require terminal-aware tail ownership (#699)`,
    );
  }

  // LOOP_ORCH_NOTE (command packaging) must also require same-turn stop language.
  // Checked via rendered Claude command after import of build.mjs.
});

test("namespaced-commands 7.5b6b: LOOP_ORCH_NOTE requires same-turn stop + follows stopped (#699)", async () => {
  const buildMjs = await import("../../scripts/build.mjs");
  const { OPERATION_SURFACE, renderClaudeCommand } = buildMjs;
  const loopOp = OPERATION_SURFACE.find((op: { name: string }) => op.name === "loop");
  assert.ok(loopOp);
  const claude = renderClaudeCommand(loopOp, "~/.claude/skills/pipeline");
  assert.ok(
    /loop_run_stopped/i.test(claude),
    `loop command packaging must mention loop_run_stopped: ${claude}`,
  );
  assert.ok(
    /same turn|same-turn|in the same/i.test(claude) || /stop.*follow/i.test(claude),
    `loop command packaging must instruct stop of follows on terminal: ${claude}`,
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

// ---------------------------------------------------------------------------
// 7.5c  Each command file starts with YAML front-matter referencing its operation name
// ---------------------------------------------------------------------------

test("namespaced-commands 7.5c: each command file's front-matter slug matches its file name", () => {
  let files: string[];
  try {
    files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    // Missing dir is already caught by 7.5a; skip this check so error message is clean
    return;
  }

  for (const file of files) {
    const match = /^pipeline:(.+)\.md$/.exec(file);
    if (!match) continue;
    const opName = match[1];
    const content = readFileSync(join(COMMANDS_DIR, file), "utf8");
    // The generated file should reference the operation name in its Invoke line.
    // summary uses --summary rather than a positional, so we check the op name appears anywhere.
    assert.ok(
      content.includes(opName),
      `${file}: content should reference the operation name "${opName}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7.5d  Every command file's YAML frontmatter parses without error (#273 review-2)
// ---------------------------------------------------------------------------

test("namespaced-commands 7.5d: every command file's YAML frontmatter is valid and parseable", () => {
  let files: string[];
  try {
    files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    // Missing dir caught by 7.5a; skip here to keep error messages clean
    return;
  }

  for (const file of files) {
    const content = readFileSync(join(COMMANDS_DIR, file), "utf8");
    // Extract the YAML frontmatter block (between the first two `---` lines)
    const match = /^---\n([\s\S]*?)\n---/m.exec(content);
    assert.ok(match, `${file}: no YAML frontmatter found`);
    const frontmatter = match[1];
    let parsed: unknown;
    assert.doesNotThrow(() => {
      parsed = yamlLoad(frontmatter);
    }, `${file}: frontmatter failed YAML parsing`);
    assert.ok(
      parsed !== null && typeof parsed === "object",
      `${file}: frontmatter parsed to a non-object`,
    );
    const fm = parsed as Record<string, unknown>;
    assert.ok(typeof fm["description"] === "string", `${file}: frontmatter missing 'description' key`);
  }
});
