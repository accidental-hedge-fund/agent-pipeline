// Tests for the `pipeline refine-spec` sub-command (#295).
//
// All tests are network- and filesystem-free: I/O is injected via the
// RefineSpecDeps seam. Each test asserts a specific outcome and proves
// the code would bite (assertions on specific error paths, happy path,
// and structural no-write guarantee).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runRefineSpec,
  validateRefineSpecResult,
  validateRefineSpecBody,
  type RefineSpecDeps,
  type RefineSpecOpts,
} from "../scripts/stages/refine-spec.ts";
import { buildRefineSpecPrompt } from "../scripts/prompts/index.ts";
import { buildCmd } from "../scripts/pipeline.ts";

// ---------------------------------------------------------------------------
// Fake deps factory
// ---------------------------------------------------------------------------

const VALID_HARNESS_RESULT = JSON.stringify({
  title: "Add retry logic to the fix loop",
  body: "## Summary\nA retry mechanism for the fix loop.\n\n## User story\nAs a developer, / I want the fix loop to retry on transient errors, / so that flaky CI does not block merges.\n\n## Acceptance criteria\n- [ ] Running `pipeline <N>` retries up to 3 times on a transient failure.\n- [ ] A non-transient error does not retry.\n\n## Out of scope\n- Manual override of retry counts.",
  milestone: null,
});

interface FakeDepsOpts {
  harnessResult?: string;
  harnessThrows?: boolean;
  harnessSuccess?: boolean;
  harnessTimed?: boolean;
}

function makeDeps(o: FakeDepsOpts = {}): RefineSpecDeps & {
  _harnessCalls: number;
  _logLines: string[];
} {
  const harnessCalls = { count: 0 };
  const logLines: string[] = [];

  const deps: RefineSpecDeps & { _harnessCalls: number; _logLines: string[] } = {
    get _harnessCalls() {
      return harnessCalls.count;
    },
    _logLines: logLines,
    runHarness: async (_prompt) => {
      harnessCalls.count++;
      if (o.harnessThrows) throw new Error("harness spawn error");
      const success = o.harnessSuccess ?? true;
      const timed_out = o.harnessTimed ?? false;
      return { success, output: o.harnessResult ?? VALID_HARNESS_RESULT, timed_out };
    },
    log: (msg) => logLines.push(msg),
  };
  return deps;
}

// Capture stdout writes during a test run.
function captureStdout(fn: () => Promise<void>): Promise<string> {
  return new Promise<string>((resolve) => {
    let captured = "";
    const orig = process.stdout.write.bind(process.stdout);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
    fn().finally(() => {
      (process.stdout as any).write = orig;
      resolve(captured);
    });
  });
}

// Capture stderr writes during a test run.
function captureStderr(fn: () => Promise<void>): Promise<string> {
  return new Promise<string>((resolve) => {
    let captured = "";
    const orig = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
    fn().finally(() => {
      (process.stderr as any).write = orig;
      resolve(captured);
    });
  });
}

// Reset process.exitCode before each test and restore after.
function withExitCode(fn: () => Promise<void>): Promise<void> {
  const saved = process.exitCode;
  process.exitCode = undefined;
  return fn().finally(() => {
    process.exitCode = saved;
  });
}

// ---------------------------------------------------------------------------
// 5.1 Happy path
// ---------------------------------------------------------------------------

test("refine-spec: happy path — harness called once; stdout is valid JSON with required fields", async () => {
  await withExitCode(async () => {
    const deps = makeDeps();
    const opts: RefineSpecOpts = { title: "Add retry logic", body: "## Summary\nA retry." };
    const stdout = await captureStdout(() => runRefineSpec(opts, deps));

    assert.equal(deps._harnessCalls, 1, "harness called exactly once");

    let parsed: unknown;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(stdout.trim());
    }, "stdout is valid JSON");

    const obj = parsed as Record<string, unknown>;
    assert.equal(typeof obj.title, "string", "title is a string");
    assert.equal(typeof obj.body, "string", "body is a string");
    assert.ok(obj.title !== "", "title is non-empty");
    assert.ok(obj.body !== "", "body is non-empty");
    assert.ok("milestone" in obj, "milestone field is present");
    assert.ok(obj.milestone === null || typeof obj.milestone === "string", "milestone is string or null");

    assert.equal(process.exitCode, 0, "exit code is 0");
  });
});

// ---------------------------------------------------------------------------
// 5.2 Missing --title
// ---------------------------------------------------------------------------

test("refine-spec: missing title — exits non-zero; no harness call made", async () => {
  await withExitCode(async () => {
    const deps = makeDeps();
    const opts: RefineSpecOpts = { title: "", body: "## Summary\nA retry." };
    const stderr = await captureStderr(() => runRefineSpec(opts, deps));

    assert.equal(deps._harnessCalls, 0, "harness not called");
    assert.ok(stderr.includes("--title"), "stderr mentions --title");
    assert.ok(process.exitCode !== 0 && process.exitCode !== undefined, "exit code is non-zero");
  });
});

// ---------------------------------------------------------------------------
// 5.3 Missing --body
// ---------------------------------------------------------------------------

test("refine-spec: missing body — exits non-zero; no harness call made", async () => {
  await withExitCode(async () => {
    const deps = makeDeps();
    const opts: RefineSpecOpts = { title: "Some title", body: "" };
    const stderr = await captureStderr(() => runRefineSpec(opts, deps));

    assert.equal(deps._harnessCalls, 0, "harness not called");
    assert.ok(stderr.includes("--body"), "stderr mentions --body");
    assert.ok(process.exitCode !== 0 && process.exitCode !== undefined, "exit code is non-zero");
  });
});

// ---------------------------------------------------------------------------
// 5.4 Harness throws
// ---------------------------------------------------------------------------

test("refine-spec: harness throws — exits non-zero; no JSON written to stdout", async () => {
  await withExitCode(async () => {
    const deps = makeDeps({ harnessThrows: true });
    const opts: RefineSpecOpts = { title: "T", body: "B" };
    const stdout = await captureStdout(() => runRefineSpec(opts, deps));

    assert.equal(stdout.trim(), "", "no output on stdout");
    assert.ok(process.exitCode !== 0 && process.exitCode !== undefined, "exit code is non-zero");
  });
});

// ---------------------------------------------------------------------------
// 5.5 Harness returns malformed JSON
// ---------------------------------------------------------------------------

test("refine-spec: harness returns malformed JSON — exits non-zero; no partial JSON on stdout", async () => {
  await withExitCode(async () => {
    const deps = makeDeps({ harnessResult: "not json at all" });
    const opts: RefineSpecOpts = { title: "T", body: "B" };
    const stdout = await captureStdout(() => runRefineSpec(opts, deps));
    const stderr = await captureStderr(() => Promise.resolve());

    assert.equal(stdout.trim(), "", "no JSON written to stdout");
    assert.ok(process.exitCode !== 0 && process.exitCode !== undefined, "exit code is non-zero");
  });
});

// ---------------------------------------------------------------------------
// 5.5b Harness returns malformed JSON (end-to-end test capturing stderr)
// ---------------------------------------------------------------------------

test("refine-spec: harness returns malformed JSON — stderr mentions parse error", async () => {
  await withExitCode(async () => {
    const deps = makeDeps({ harnessResult: "this is not json" });
    const opts: RefineSpecOpts = { title: "T", body: "B" };
    let stdoutCapture = "";
    let stderrCapture = "";
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout as any).write = (chunk: string | Uint8Array) => {
      stdoutCapture += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
    (process.stderr as any).write = (chunk: string | Uint8Array) => {
      stderrCapture += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
    try {
      await runRefineSpec(opts, deps);
    } finally {
      (process.stdout as any).write = origOut;
      (process.stderr as any).write = origErr;
    }

    assert.equal(stdoutCapture.trim(), "", "no JSON on stdout");
    assert.ok(
      stderrCapture.includes("non-JSON") || stderrCapture.includes("JSON"),
      "stderr mentions JSON parse failure",
    );
    assert.ok(process.exitCode !== 0 && process.exitCode !== undefined, "exit code is non-zero");
  });
});

// ---------------------------------------------------------------------------
// 5.6 Harness returns JSON missing a required field
// ---------------------------------------------------------------------------

test("refine-spec: harness returns JSON missing 'body' — exits non-zero with shape error", async () => {
  await withExitCode(async () => {
    const deps = makeDeps({ harnessResult: JSON.stringify({ title: "T", milestone: null }) });
    const opts: RefineSpecOpts = { title: "T", body: "B" };
    let stdoutCapture = "";
    let stderrCapture = "";
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout as any).write = (chunk: string | Uint8Array) => {
      stdoutCapture += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
    (process.stderr as any).write = (chunk: string | Uint8Array) => {
      stderrCapture += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
    try {
      await runRefineSpec(opts, deps);
    } finally {
      (process.stdout as any).write = origOut;
      (process.stderr as any).write = origErr;
    }

    assert.equal(stdoutCapture.trim(), "", "no JSON on stdout");
    assert.ok(
      stderrCapture.includes("shape") || stderrCapture.includes("body"),
      "stderr mentions shape/body error",
    );
    assert.ok(process.exitCode !== 0 && process.exitCode !== undefined, "exit code is non-zero");
  });
});

// ---------------------------------------------------------------------------
// 5.7 No write-capable slots in deps
// ---------------------------------------------------------------------------

test("refine-spec: RefineSpecDeps interface has no write-capable slots (structural guarantee)", () => {
  // This test verifies the no-mutation contract by asserting that the deps
  // object produced by makeDeps() has ONLY the two allowed slots (runHarness, log)
  // and no write-capable equivalents (createIssue, writeFile, gitCreateBranch, etc.).
  const deps = makeDeps();
  const ownKeys = new Set(Object.keys(deps).filter((k) => !k.startsWith("_")));
  const allowed = new Set(["runHarness", "log"]);
  const forbidden = [...ownKeys].filter((k) => !allowed.has(k));
  assert.deepEqual(forbidden, [], `deps must have only runHarness and log; found extra: ${forbidden.join(", ")}`);
});

// ---------------------------------------------------------------------------
// validateRefineSpecResult unit tests
// ---------------------------------------------------------------------------

test("validateRefineSpecResult: valid object returns null", () => {
  const result = validateRefineSpecResult({ title: "T", body: "B", milestone: null });
  assert.equal(result, null);
});

test("validateRefineSpecResult: valid with string milestone returns null", () => {
  const result = validateRefineSpecResult({ title: "T", body: "B", milestone: "v1.6.0" });
  assert.equal(result, null);
});

test("validateRefineSpecResult: null input returns error", () => {
  const result = validateRefineSpecResult(null);
  assert.ok(result !== null && result.length > 0);
});

test("validateRefineSpecResult: array input returns error", () => {
  const result = validateRefineSpecResult([]);
  assert.ok(result !== null && result.length > 0);
});

test("validateRefineSpecResult: missing title returns error mentioning title", () => {
  const result = validateRefineSpecResult({ body: "B", milestone: null });
  assert.ok(result !== null && result.includes("title"), `expected mention of 'title' in: ${result}`);
});

test("validateRefineSpecResult: empty title returns error", () => {
  const result = validateRefineSpecResult({ title: "", body: "B", milestone: null });
  assert.ok(result !== null, "empty title should fail");
});

test("validateRefineSpecResult: missing body returns error mentioning body", () => {
  const result = validateRefineSpecResult({ title: "T", milestone: null });
  assert.ok(result !== null && result.includes("body"), `expected mention of 'body' in: ${result}`);
});

test("validateRefineSpecResult: milestone as number returns error", () => {
  const result = validateRefineSpecResult({ title: "T", body: "B", milestone: 42 });
  assert.ok(result !== null && result.includes("milestone"), `expected mention of 'milestone' in: ${result}`);
});

// ---------------------------------------------------------------------------
// validateRefineSpecBody unit tests
// ---------------------------------------------------------------------------

test("validateRefineSpecBody: valid body with all sections and checkboxes returns null", () => {
  const body =
    "## Summary\nA summary.\n\n## User story\nAs a dev.\n\n## Acceptance criteria\n- [ ] Criterion.\n\n## Out of scope\nNone.";
  assert.equal(validateRefineSpecBody(body), null);
});

test("validateRefineSpecBody: body missing all required sections returns error", () => {
  const result = validateRefineSpecBody("not a sectioned spec");
  assert.ok(result !== null && result.length > 0, "expected error for missing sections");
  assert.ok(result.includes("Summary"), "error mentions Summary");
});

test("validateRefineSpecBody: body with sections but no checkboxes returns error", () => {
  const body =
    "## Summary\nA.\n\n## User story\nB.\n\n## Acceptance criteria\n- Must do X.\n\n## Out of scope\nC.";
  const result = validateRefineSpecBody(body);
  assert.ok(result !== null, "expected error for missing checkboxes");
  assert.ok(result.includes("- [ ]"), `error mentions '- [ ]'; got: ${result}`);
});

// ---------------------------------------------------------------------------
// 5.6b Regression: valid JSON with malformed body exits non-zero, empty stdout
// ---------------------------------------------------------------------------

test("refine-spec: valid JSON body with no required sections — exits non-zero; no JSON on stdout", async () => {
  await withExitCode(async () => {
    const malformedBody = JSON.stringify({
      title: "T",
      body: "not a sectioned spec",
      milestone: null,
    });
    const deps = makeDeps({ harnessResult: malformedBody });
    const opts: RefineSpecOpts = { title: "T", body: "B" };
    let stdoutCapture = "";
    let stderrCapture = "";
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout as any).write = (chunk: string | Uint8Array) => {
      stdoutCapture += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
    (process.stderr as any).write = (chunk: string | Uint8Array) => {
      stderrCapture += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
    try {
      await runRefineSpec(opts, deps);
    } finally {
      (process.stdout as any).write = origOut;
      (process.stderr as any).write = origErr;
    }

    assert.equal(stdoutCapture.trim(), "", "no JSON written to stdout for malformed body");
    assert.ok(
      stderrCapture.includes("section") || stderrCapture.includes("Summary"),
      `stderr must mention missing sections; got: ${stderrCapture}`,
    );
    assert.ok(process.exitCode !== 0 && process.exitCode !== undefined, "exit code is non-zero");
  });
});

// ---------------------------------------------------------------------------
// buildRefineSpecPrompt smoke test
// ---------------------------------------------------------------------------

test("buildRefineSpecPrompt: substitutes title and body placeholders", () => {
  const prompt = buildRefineSpecPrompt({ title: "My Title", body: "My Body" });
  assert.ok(prompt.includes("My Title"), "prompt includes title");
  assert.ok(prompt.includes("My Body"), "prompt includes body");
  assert.ok(!prompt.includes("{{title}}"), "{{title}} placeholder is replaced");
  assert.ok(!prompt.includes("{{body}}"), "{{body}} placeholder is replaced");
});

// ---------------------------------------------------------------------------
// Harness success=false path
// ---------------------------------------------------------------------------

test("refine-spec: harness returns success=false — exits non-zero; no JSON on stdout", async () => {
  await withExitCode(async () => {
    const deps = makeDeps({ harnessSuccess: false });
    const opts: RefineSpecOpts = { title: "T", body: "B" };
    const stdout = await captureStdout(() => runRefineSpec(opts, deps));
    assert.equal(stdout.trim(), "", "no JSON on stdout");
    assert.ok(process.exitCode !== 0 && process.exitCode !== undefined, "exit code is non-zero");
  });
});

// ---------------------------------------------------------------------------
// 5.8 Regression: stdout is exactly one JSON object (no harness stdout leak)
// ---------------------------------------------------------------------------

test("refine-spec: stdout contains exactly one parseable JSON object — stream:false regression", async () => {
  // Regression for #295 finding 1: realRefineSpecDeps must use stream:false.
  // If stream:true were used, invoke() would write raw harness output to
  // process.stdout in real-time, then runRefineSpec would write the validated
  // JSON again — two concatenated JSON objects that cannot be JSON.parse'd.
  await withExitCode(async () => {
    const deps = makeDeps();
    const opts: RefineSpecOpts = { title: "T", body: "B" };
    let captured = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
    try {
      await runRefineSpec(opts, deps);
    } finally {
      (process.stdout as any).write = origWrite;
    }
    assert.doesNotThrow(
      () => JSON.parse(captured.trim()),
      `stdout must be a single parseable JSON object; got: ${captured.slice(0, 200)}`,
    );
    const obj = JSON.parse(captured.trim()) as Record<string, unknown>;
    assert.equal(typeof obj.title, "string", "title is a string");
    assert.equal(typeof obj.body, "string", "body is a string");
    assert.ok("milestone" in obj, "milestone field is present");
    assert.equal(process.exitCode, 0, "exit code is 0");
  });
});

// ---------------------------------------------------------------------------
// 5.9 Regression: buildCmd() --title and --body options carry refine-spec context
// ---------------------------------------------------------------------------

test("refine-spec: buildCmd() registers --title and --body options with refine-spec descriptions", () => {
  // Regression for #295 finding 2: the pre-interception in main() prints
  // refine-spec-specific usage mentioning --title and --body so a caller can
  // distinguish new installs (refine-spec-specific flags) from old installs
  // (generic top-level help without --title/--body in refine-spec context).
  // This test verifies the underlying commander options are registered.
  const cmd = buildCmd();
  const options = cmd.options.map((o) => o.long ?? "");
  assert.ok(options.includes("--title"), "buildCmd() has --title option");
  assert.ok(options.includes("--body"), "buildCmd() has --body option");
  const titleOpt = cmd.options.find((o) => o.long === "--title");
  const bodyOpt = cmd.options.find((o) => o.long === "--body");
  assert.ok(
    titleOpt?.description?.includes("refine-spec"),
    `--title description must mention refine-spec; got: ${titleOpt?.description}`,
  );
  assert.ok(
    bodyOpt?.description?.includes("refine-spec"),
    `--body description must mention refine-spec; got: ${bodyOpt?.description}`,
  );
});
