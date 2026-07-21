// Run a harness CLI inside a worktree directory, streaming output to the
// console while also capturing it for return.
//
// claude:  claude --print --permission-mode bypassPermissions --verbose --output-format stream-json
//          --include-partial-messages [--model X] [--effort Y] <prompt>
// codex:   codex exec --json --full-auto -C <worktreeDir> [-m X] [-c model_reasoning_effort=Y] <prompt>
//          Set PIPELINE_CODEX_NO_SANDBOX=1 to use Codex's explicit
//          --dangerously-bypass-approvals-and-sandbox mode on externally
//          sandboxed runners where Codex's bubblewrap/userns sandbox cannot start.
//          Set PIPELINE_HARNESS_TELEMETRY=off to restore the pre-#429 plain-text
//          argv (`--output-format text` / no `--json`) for both built-in harnesses.
// custom:  <name> <prompt>   (#40 — a user-configured reviewer CLI)
//
// The two built-in harnesses keep their exact invocation shapes. Any other
// string is treated as a configured reviewer CLI (`review_harness`, #40): it is
// spawned with the prompt as a single positional argument and its stdout is the
// harness output. A custom CLI that cannot be spawned yields a specific, named
// failure in the returned `HarnessResult` — never a thrown "Unknown harness".
//
// #429: the built-in harnesses are invoked in a machine-readable telemetry mode
// so `invoke()` can recover per-call cost/token usage from the CLI's own report
// instead of an operator estimate. `parseHarnessTelemetry` turns the captured
// JSONL back into `{ text, costUsd, usage }`; `HarnessResult.stdout` is set to
// the recovered assistant text so every existing consumer (verdict parsing, fix
// rounds, gates) is unaffected. `makeTelemetryForwardTransform` forwards only
// that assistant text to the terminal as it streams in, never the raw envelope.
//
// Captured stdout/stderr is capped at MAX_OUTPUT to bound memory. Telemetry-mode
// stdout capture keeps the TAIL of the stream rather than the head, because the
// cost/usage-bearing envelope line always arrives last.

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildStageAccountingRecord } from "./accounting.ts";
import { resolveAdapter } from "./harness-adapters/index.ts";
import { makeClaudeForwardTransform } from "./harness-adapters/claude.ts";
import { makeCodexForwardTransform } from "./harness-adapters/codex.ts";
import { MAX_ARG_STRLEN, type AdapterProbe } from "./harness-adapters/types.ts";
import { RUN_SCHEMA_VERSION, appendEvent, emitStageAccounting, type RunStoreDeps } from "./run-store.ts";
import type { Harness, PipelineConfig } from "./types.ts";

export { MAX_ARG_STRLEN };

const MAX_OUTPUT = 100_000; // 100 KB cap on captured output

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * Build the `env` addition for a harness child process carrying run/stage/
 * harness/model identity (#419), so `pipeline papercut --run <run-id> ...`
 * invoked by the agent mid-run can resolve identity without fabricating it.
 * Single-sourced so implementing/fix/review call sites cannot drift.
 *
 * Returns `undefined` when `cfg.papercuts.enabled` is false (the default),
 * so the harness child's environment is completely unchanged from pre-#419
 * behavior on the default path — matching `runCapped`'s "no opts.env → no
 * env key at all" contract.
 */
export function papercutIdentityEnv(
  cfg: PipelineConfig,
  identity: {
    runId: string | null;
    issue: number | null;
    stage: string | null;
    harness: string | null;
    model: string | null;
  },
): NodeJS.ProcessEnv | undefined {
  if (!cfg.papercuts?.enabled) return undefined;
  const env: NodeJS.ProcessEnv = {};
  if (identity.runId != null) env.PIPELINE_RUN_ID = identity.runId;
  if (identity.issue != null) env.PIPELINE_ISSUE = String(identity.issue);
  if (identity.stage != null) env.PIPELINE_STAGE = identity.stage;
  if (identity.harness != null) env.PIPELINE_HARNESS = identity.harness;
  if (identity.model != null) env.PIPELINE_MODEL = identity.model;
  return env;
}

/** Run-store context for recording a `harness_timeout` event at cap-fire time
 *  (#398). Optional: bare `runCapped` callers (`testgate.ts`, `eval.ts`) pass
 *  none, and no event is recorded for them. */
export interface HarnessTimeoutEventContext {
  runDir: string;
  runStoreDeps?: RunStoreDeps;
  stage: string;
}

/**
 * Format a bounded CLI stderr excerpt for inclusion in a blocked-item message.
 * Returns an empty string when there is no stderr to show.
 * Single-sourced so plan-review and review-1/review-2 cannot drift (#40).
 */
export function formatStderrExcerpt(stderr: string, max = 500): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "";
  return (
    `\n\nCLI output:\n\`\`\`\n${trimmed.slice(0, max)}` +
    `${trimmed.length > max ? "\n…(truncated)" : ""}\n\`\`\``
  );
}

/** Per-call cost/token telemetry recovered from a built-in harness's
 *  machine-readable output mode (#429). `usage` is the harness's own raw usage
 *  object, handed to `buildStageAccountingRecord` unmodified — extraction into
 *  the accounting record stays allowlist-only via the existing
 *  `extractUsageAccounting` path, so fields outside that allowlist (session
 *  id, rate-limit info, assistant text) are never persisted. */
export interface HarnessTelemetry {
  text: string | null;
  costUsd: number | null;
  usage: Record<string, unknown> | null;
}

/**
 * Parse a captured telemetry stream from a harness adapter back into
 * `{ text, costUsd, usage }` (#429, generalized to a registry lookup by
 * #431). Pure and never throws — absent, truncated, or non-JSON output
 * yields a null/empty result so callers can fall back to the raw captured
 * stdout and an `unknown` cost source without failing the stage (design.md
 * decision 3). Unregistered harness names (custom reviewer CLIs, #40) yield
 * the empty result, matching pre-#431 behavior exactly.
 *
 * Verified shapes (design.md — confirmed against the installed CLIs):
 *  - claude `--output-format stream-json`: the last `{"type":"result"}` line
 *    carries `result` (final text), `total_cost_usd`, and a `usage` object.
 *  - codex `exec --json`: the last `item.completed` line whose `item.type` is
 *    `"agent_message"` carries the final text; the last `turn.completed` line
 *    carries a `usage` object with token counters and no cost field.
 */
export function parseHarnessTelemetry(harness: string, capturedStdout: string): HarnessTelemetry {
  const adapter = resolveAdapter(harness);
  if (!adapter) return { text: null, costUsd: null, usage: null, resolvedModel: null, throttled: null };
  return adapter.parseTelemetry(capturedStdout);
}

/** Legacy standalone accessor retained for direct unit testing of the
 *  claude/codex live-forwarding transforms (#429). `invoke()` itself uses
 *  each adapter's own `buildInvocation().transformForward` instead of this
 *  name-keyed lookup. Unregistered/other adapter names forward verbatim. */
export function makeTelemetryForwardTransform(harness: string): (chunk: string) => string {
  if (harness === "claude") return makeClaudeForwardTransform();
  if (harness === "codex") return makeCodexForwardTransform();
  return (chunk: string) => chunk;
}

export interface HarnessResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number;
  duration: number; // seconds
  timed_out: boolean;
  spawn_error?: boolean; // true when the process could not be spawned at all
  // True when spawn_error is specifically the pre-spawn oversize-argv refusal
  // (#492) — an argv element exceeded MAX_ARG_STRLEN, so the process was never
  // spawned at all. Distinguishes "this invocation cannot succeed as shaped"
  // from a transient/environmental spawn error such as a missing CLI, even
  // though both set spawn_error: true (so the #39 self-review fallback, which
  // only checks spawn_error, still applies).
  oversize_argv?: boolean;
  // True when the output-capture stream (stdout/stderr) errored before a clean
  // process exit code was observed — e.g. the pipe breaking mid-stream (#384).
  // Distinct from spawn_error: the process itself started successfully.
  capture_error?: boolean;
  // External stage executor evidence (#314). Populated only when the result
  // came from `executors.ts`'s dispatch path (a `stage_executors:` assignment),
  // never for the local claude/codex/custom-reviewer-CLI branches above. Read by
  // accounting/evidence recording so a delegated stage's executor/provider(/model)
  // is recorded alongside the existing harness/model fields.
  executor_name?: string;
  executor_provider?: string; // agent-system: provider id; model-endpoint: base_url
  executor_model?: string; // model-endpoint only
  // Rate-limit/throttle signal recovered from the adapter's own telemetry
  // parsing (#431's HarnessTelemetry.throttled). `null`/absent when the CLI
  // reports no such signal at all — not the same as "not throttled". Used by
  // the eval runner (evals/executor.ts) to distinguish a provider refusal
  // from a genuine treatment outcome (review 2 finding f97442bc).
  throttled?: boolean | null;
  /** model-endpoint response provenance (#434 api-executor-response-provenance).
   *  Populated only for a `model-endpoint` executor invocation; absent for
   *  every other result shape (agent-system, local claude/codex, custom
   *  reviewer CLI). */
  executor_provenance?: import("./types.ts").ModelEndpointProvenance;
}

export interface InvokeOptions {
  /** Per-call wall-clock timeout in seconds. */
  timeoutSec?: number;
  /** Optional model override. Honored by claude (`--model`) and codex (`-m`). Ignored for custom reviewer CLIs. */
  model?: string;
  /**
   * Whether `model` originated from the `"auto"` sentinel rather than an
   * explicit user override (#441). Consulted only by `invokeReviewer`'s
   * per-attempted-harness compatibility guard (`resolveReviewerModelForHarness`
   * in stage-routing.ts); `invoke()` itself ignores this field.
   */
  modelWasAuto?: boolean;
  /** Stream output to process.stderr/stdout in real time. Default true. */
  stream?: boolean;
  /**
   * When true and harness is "claude", passes --permission-mode default instead
   * of bypassPermissions (#21). Ignored for codex (already sandboxed via --full-auto).
   */
  sandbox?: boolean;
  /**
   * When true and harness is "claude", run a lean single-shot generation: append
   * `--tools ""` (disable all built-in tools, so the agent cannot spend turns
   * exploring the cwd) and `--strict-mcp-config` (load zero MCP servers, since no
   * `--mcp-config` is passed). For self-contained prompts (intake/sweep spec
   * generation) this removes the agentic-exploration tail and the MCP-server cold
   * start. Deliberately does NOT use `--bare`, which also skips keychain reads and
   * would break OAuth auth. Ignored for codex and custom reviewer CLIs.
   */
  lean?: boolean;
  /**
   * Per-stage reasoning-effort override (#366). For "codex", passes
   * `-c model_reasoning_effort=<value>`; for "claude", passes `--effort <value>`.
   * Both override the operator's global reasoning-effort config for this call.
   * Silently ignored for custom reviewer CLIs (`review_harness`, #40), which
   * accept neither flag.
   */
  reasoningEffort?: string;
  /**
   * Prompt-delivery channel for an unregistered (custom reviewer, #40) harness
   * name. Ignored for "claude"/"codex" and any other registered adapter, whose
   * own `buildInvocation()` declares its channel. Defaults to `"argv"` — the
   * prompt as a single positional argument, byte-for-byte the pre-#492
   * behavior. `"stdin"` spawns the CLI with no prompt positional and writes
   * the prompt to its standard input instead (#492 — `review_harness`'s
   * opt-in stdin selection).
   */
  promptDelivery?: "argv" | "stdin";
  accounting?: {
    runDir: string;
    runStoreDeps?: RunStoreDeps;
    issue: number;
    stage: string;
    modelSlot?: string | null;
    model?: string | null;
    commandCount?: number;
    subprocessCount?: number;
    usage?: unknown;
    estimatedCostUsd?: number | null;
  };
  /** Additional env vars merged into the child process's environment on top of
   *  process.env (#419 — papercuts.enabled run/stage/harness/model identity, so
   *  `pipeline papercut --run <id> ...` can resolve identity without the agent
   *  fabricating it). Absent by default: no env change from pre-#419 behavior. */
  env?: NodeJS.ProcessEnv;
}

export async function invoke(
  harness: string,
  worktreeDir: string,
  prompt: string,
  opts: InvokeOptions = {},
): Promise<HarnessResult> {
  const stream = opts.stream ?? true;
  const timeoutSec = opts.timeoutSec ?? 1200;

  // #431: dispatch through the adapter registry rather than branching on
  // harness names. A name with no registered adapter takes the unregistered
  // custom-reviewer-CLI path (#40) verbatim: `<cmd> <prompt>` by default.
  const adapter = resolveAdapter(harness);
  let cmd: string;
  let args: string[];
  let cwd: string;
  let captureMode: "head" | "tail" | undefined;
  let transformForward: ((chunk: string) => string) | undefined;
  let stdinPayload: string | undefined;
  let promptFile: { path: string; content: string } | undefined;
  const custom = adapter === null;
  if (adapter) {
    const inv = adapter.buildInvocation({
      prompt,
      worktreeDir,
      model: opts.model,
      effort: opts.reasoningEffort,
      sandbox: opts.sandbox,
      lean: opts.lean,
      env: opts.env,
    });
    cmd = inv.cmd;
    args = inv.args;
    cwd = inv.cwd;
    captureMode = inv.captureMode;
    transformForward = inv.transformForward;
    if (inv.promptDelivery === "stdin") stdinPayload = inv.stdinPayload;
    if (inv.promptDelivery === "file") promptFile = inv.promptFile;
  } else {
    // A user-configured reviewer CLI (`review_harness`, #40). Its
    // prompt-delivery channel defaults to the positional argument (#492 —
    // byte-for-byte the pre-#492 shape); an operator whose CLI reads stdin can
    // opt in via review_harness.prompt_delivery: stdin.
    cmd = harness;
    cwd = worktreeDir;
    if (opts.promptDelivery === "stdin") {
      args = [];
      stdinPayload = prompt;
    } else {
      args = [prompt];
    }
  }

  // #492: materialize a file-channel prompt under the managed worktree root
  // before spawn; always removed after the call completes, spawn or not.
  if (promptFile) await fs.writeFile(promptFile.path, promptFile.content, "utf8");

  const startedAt = new Date();
  let result: HarnessResult;
  try {
    result = await runCapped(cmd, args, cwd, timeoutSec, stream, harness, {
      killProcessGroup: true,
      timeoutEvent: opts.accounting
        ? {
            runDir: opts.accounting.runDir,
            runStoreDeps: opts.accounting.runStoreDeps,
            stage: opts.accounting.stage,
          }
        : undefined,
      env: opts.env,
      // The cost/usage-bearing envelope line always arrives last, so telemetry
      // capture keeps the tail of the stream rather than the head (#429).
      captureMode,
      transformForward,
      stdinPayload,
    });
  } finally {
    // Remove exactly the file this call created (#492), spawn or not.
    if (promptFile) await fs.rm(promptFile.path, { force: true });
  }
  const endedAt = new Date();

  // Recover per-call cost/usage from the captured envelope and reconstruct the
  // final assistant text as `stdout` (#429) — every existing consumer (verdict
  // parsing, fix rounds, gates) sees the same `stdout` shape as plain-text mode.
  // Parsing never throws; an unparseable envelope (or an adapter with no
  // telemetry capability at all) falls back to the raw captured output and
  // leaves accounting at `cost_source: "unknown"`.
  const telemetry = adapter ? adapter.parseTelemetry(result.stdout) : null;
  const finalResult: HarnessResult = {
    ...(telemetry && telemetry.text !== null ? { ...result, stdout: telemetry.text } : result),
    throttled: telemetry?.throttled ?? null,
  };

  if (opts.accounting) {
    const model = opts.accounting.model ?? opts.model ?? null;
    const usage =
      telemetry && (telemetry.costUsd !== null || telemetry.usage !== null)
        ? { total_cost_usd: telemetry.costUsd, usage: telemetry.usage }
        : opts.accounting.usage;
    // Treatment-identity provenance (#431 task 6): populated only for a
    // registered adapter. No per-invocation CLI probe is run here (that
    // would add subprocess overhead to every model call) — cliVersion and
    // providerAuthClass are recorded as unknown rather than fabricated,
    // matching the "unreported provenance is recorded as unknown" contract.
    // resolvedModel/throttled, when the adapter's own telemetry parsing
    // recovered them (review-2 finding 0b0c7e4b), are threaded through here
    // rather than fabricated by each adapter's describeTreatment.
    const treatment = adapter
      ? adapter.describeTreatment(
          { model: opts.model, effort: opts.reasoningEffort },
          { cmd, args, cwd },
          {
            cliVersion: null,
            providerAuthClass: "unknown",
            resolvedModel: telemetry?.resolvedModel ?? null,
            throttled: telemetry?.throttled ?? null,
          } satisfies AdapterProbe,
        )
      : null;
    const record = buildStageAccountingRecord({
      runId: path.basename(opts.accounting.runDir),
      issue: opts.accounting.issue,
      stage: opts.accounting.stage,
      harness,
      modelSlot: opts.accounting.modelSlot ?? null,
      model,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: finalResult.duration * 1000,
      commandCount: opts.accounting.commandCount ?? 1,
      subprocessCount: opts.accounting.subprocessCount ?? 1,
      outcome: harnessOutcome(finalResult),
      blockerKind: finalResult.success ? null : "harness-failure",
      usage,
      estimatedCostUsd: opts.accounting.estimatedCostUsd,
      promptChars: prompt.length,
      promptEstimatedTokens: Math.ceil(prompt.length / 4),
      effort: opts.reasoningEffort ?? null,
      adapter: treatment?.adapter ?? null,
      adapterCliVersion: treatment?.cliVersion ?? null,
      providerAuthClass: treatment?.providerAuthClass ?? null,
      requestedModel: treatment?.requestedModel ?? null,
      resolvedModel: treatment?.resolvedModel ?? null,
      requestedEffort: treatment?.requestedEffort ?? null,
      resolvedEffort: treatment?.resolvedEffort ?? null,
      nativeFlags: treatment?.nativeFlags ?? null,
      fallback: treatment?.fallback ?? null,
      throttled: treatment?.throttled ?? null,
      terminationReason: harnessOutcome(finalResult),
    });
    await emitStageAccounting(
      opts.accounting.runDir,
      record,
      opts.accounting.runStoreDeps,
    ).catch(() => {});
  }
  // #492: an oversize-argv refusal is a distinct, actionable failure — the CLI
  // WAS found, the prompt was simply too large for a positional argument. Name
  // the review_harness remedy instead of the "not found" message below, which
  // would be misleading here.
  if (custom && finalResult.oversize_argv) {
    return {
      ...finalResult,
      stderr: `${finalResult.stderr}\nRemedy: set review_harness.prompt_delivery: stdin for '${harness}' if it reads its prompt from standard input.`,
    };
  }
  // When a configured reviewer CLI cannot be spawned at all (ENOENT / not
  // executable), surface a specific, actionable message that names the CLI —
  // never a bare "Unknown harness". The `spawn_error` flag is preserved so the
  // #39 self-review fallback still triggers in invokeReviewer.
  if (custom && finalResult.spawn_error) {
    return {
      ...finalResult,
      stderr:
        `reviewer CLI '${harness}' not found or not executable — ensure it is installed and on PATH\n` +
        finalResult.stderr,
    };
  }
  return finalResult;
}

function harnessOutcome(result: HarnessResult): string {
  if (result.success) return "success";
  if (result.timed_out) return "timeout";
  if (result.spawn_error) return "spawn_error";
  return "failure";
}

/** Minimal shape of a stream-forward destination (#384, key 84c9859e) —
 *  satisfied by `process.stdout`/`process.stderr` and by test fakes. */
export interface ForwardStream {
  write(text: string): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  off(event: "error", listener: (err: Error) => void): unknown;
}

// Destinations that already carry a permanent 'error' guard (#384 delta
// review round 2, key 0415ec38). A forwarded write's async EPIPE can land
// after this call's own settle() has removed its per-call diagnostic
// listener — Node throws on an 'error' event with zero listeners, which
// would crash the pipeline even though the command already exited 0. This
// permanent, once-per-destination listener absorbs any such late error so a
// stray unhandled event can never surface, independent of exactly when the
// per-call listener is attached or removed.
const permanentlyForwardGuarded = new WeakSet<ForwardStream>();
function ensurePermanentForwardGuard(dest: ForwardStream): void {
  if (permanentlyForwardGuarded.has(dest)) return;
  permanentlyForwardGuarded.add(dest);
  dest.on("error", () => {
    // Intentionally a no-op: this call's own listener (added below) already
    // records the diagnostic for any error that lands while it is active.
    // This permanent listener exists solely so the stream is never left
    // with zero 'error' listeners.
  });
}

export async function runCapped(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutSec: number,
  stream: boolean,
  label: string,
  opts: {
    killProcessGroup?: boolean;
    killGraceSec?: number;
    // Hard secondary deadline (#398), seconds after the SIGKILL point at which
    // runCapped force-resolves `timed_out: true` unconditionally, even if the
    // child's streams never emit `close` and the process-group kill fails.
    // Injectable so tests use a short value; production keeps the 30 s default.
    hardDeadlineSec?: number;
    // Run-store context (#398): when present, a `harness_timeout` event is
    // recorded at the moment the wall-clock cap fires. Absent for bare
    // runCapped callers, which record nothing (unchanged behavior).
    timeoutEvent?: HarnessTimeoutEventContext;
    // Injectable spawn seam (#384): lets tests simulate a capture stream that
    // errors mid-run without a real OS-level pipe fault. Defaults to the real
    // node:child_process spawn.
    spawnFn?: typeof spawn;
    // Injectable forward-destination seam (#384 delta review, key 84c9859e):
    // lets tests simulate the DOWNSTREAM side of the pipe — our own
    // stdout/stderr (terminal-log tee, event-sink socket) — failing while the
    // child command itself succeeds. Defaults to the real process streams.
    forwardTo?: { stdout: ForwardStream; stderr: ForwardStream };
    // Additional env vars to merge into the child's environment on top of
    // process.env (#419 — papercuts.enabled run/stage/harness/model identity).
    // Absent by default: the child inherits process.env unchanged, matching
    // pre-#419 behavior exactly.
    env?: NodeJS.ProcessEnv;
    // How captured stdout is bounded at MAX_OUTPUT (#429). "head" (default,
    // unchanged pre-#429 behavior) keeps the first MAX_OUTPUT chars and stops
    // growing. "tail" keeps the last MAX_OUTPUT chars instead — used for
    // telemetry-mode invocations, whose cost/usage-bearing envelope line
    // always arrives at the END of the stream and must not be dropped.
    captureMode?: "head" | "tail";
    // Transform applied to each stdout chunk before it is forwarded to the
    // terminal, independent of the raw chunk accumulated into the captured
    // buffer (#429). Used in telemetry mode to forward only the assistant
    // text extracted from the JSONL envelope, never the raw envelope lines.
    // Absent by default: chunks are forwarded verbatim, matching pre-#429
    // behavior exactly.
    transformForward?: (chunk: string) => string;
    // Payload to write to the child's standard input, then end the stream
    // (#492). When present, stdio[0] becomes "pipe" instead of "ignore" —
    // this is the ONLY condition under which the child's stdin is opened, so
    // every existing caller with no stdin payload keeps stdin: "ignore"
    // byte-for-byte.
    stdinPayload?: string;
  } = {},
): Promise<HarnessResult> {
  const start = Date.now();

  // #492: pre-spawn oversize-argv guard. Linux's execve() rejects a single
  // argv element larger than MAX_ARG_STRLEN with E2BIG; left unguarded, that
  // surfaces a few seconds later as a bare spawn_error that reads as
  // transient (missing CLI, permissions) when it is neither — retrying the
  // same invocation can never succeed. Refuse before spawning with a named,
  // actionable failure instead.
  for (const arg of args) {
    const byteLength = Buffer.byteLength(arg, "utf8");
    if (byteLength <= MAX_ARG_STRLEN) continue;
    return Promise.resolve({
      success: false,
      stdout: "",
      stderr:
        `[harness ${label}] argument exceeds the OS per-argument limit: this invocation would pass ` +
        `a ${byteLength}-byte argument, but a single command-line argument cannot exceed ` +
        `${MAX_ARG_STRLEN} bytes (Linux MAX_ARG_STRLEN). This is not a transient failure — retrying ` +
        `the same invocation cannot succeed. Deliver this payload via standard input or a file ` +
        `instead of a positional argument.`,
      exit_code: -1,
      duration: 0,
      timed_out: false,
      spawn_error: true,
      oversize_argv: true,
    });
  }

  return new Promise<HarnessResult>((resolvePromise) => {
    const killProcessGroup = opts.killProcessGroup ?? false;
    // Grace period (seconds) between SIGTERM and SIGKILL on timeout. Configurable
    // so tests can use a short value without waiting the full 5 s default.
    const killGraceSec = opts.killGraceSec ?? 5;
    const hardDeadlineSec = opts.hardDeadlineSec ?? 30;
    const spawnImpl = opts.spawnFn ?? spawn;
    // node:child_process spawn() throws SYNCHRONOUSLY for certain argv contents —
    // most notably TypeError [ERR_INVALID_ARG_VALUE] when an argv string contains a
    // NUL byte (U+0000). The reviewer prompt is assembled from reviewed source, so a
    // NUL byte anywhere in it reaches spawn() as an argv entry. Left unguarded, that
    // throw escapes this Promise executor and crashes the whole pipeline process
    // (#393) instead of resolving the same spawn_error HarnessResult the async
    // child.on("error") path below already produces.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(cmd, args, {
        cwd,
        // #492: stdin is opened only when this invocation carries a stdin
        // payload — every other caller keeps stdin: "ignore" byte-for-byte.
        stdio: [opts.stdinPayload !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        // detached creates a new process group so we can kill all descendants on timeout
        ...(killProcessGroup ? { detached: true } : {}),
        // Merge in caller-supplied env additions (#419) on top of the inherited
        // process.env; absent opts.env is a no-op (spread of undefined is {}).
        ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
      });
    } catch (err) {
      const duration = (Date.now() - start) / 1000;
      const message = err instanceof Error ? err.message : String(err);
      const isNulByte =
        (err as { code?: string })?.code === "ERR_INVALID_ARG_VALUE" && /null bytes?/i.test(message);
      const marker = isNulByte ? "NUL byte (U+0000) detected in harness argv payload\n" : "";
      resolvePromise({
        success: false,
        stdout: "",
        stderr: `${marker}[harness ${label}] spawn error: ${message}`,
        exit_code: -1,
        duration,
        timed_out: false,
        spawn_error: true,
      });
      return;
    }
    let stdoutBuf = "";
    let stderrBuf = "";
    let timedOut = false;
    let lastExitCode: number | null = null;
    let settled = false;

    // Downstream forward failures — OUR stdout/stderr breaking (terminal-log
    // tee, event-sink socket), not the child's streams — are diagnostics,
    // never test results: the gate outcome derives solely from the command
    // exit code (#384 delta review, key 84c9859e). On the first failure stop
    // forwarding (capture continues unaffected) and carry a one-line note in
    // the result's stderr. Both delivery shapes are covered: a synchronous
    // throw from write() and an asynchronous 'error' event on the stream.
    const fwd = opts.forwardTo ?? { stdout: process.stdout, stderr: process.stderr };
    let forwardBroken = false;
    let forwardNote = "";
    const onForwardError = (err: Error) => {
      if (forwardBroken) return;
      forwardBroken = true;
      forwardNote =
        `[harness ${label}] stream-forward error (diagnostic; command outcome unaffected): ${err.message}`;
    };
    if (stream) {
      ensurePermanentForwardGuard(fwd.stdout);
      ensurePermanentForwardGuard(fwd.stderr);
      fwd.stdout.on("error", onForwardError);
      fwd.stderr.on("error", onForwardError);
    }
    const safeForward = (dest: ForwardStream, text: string) => {
      if (forwardBroken) return;
      try {
        dest.write(text);
      } catch (err) {
        onForwardError(err instanceof Error ? err : new Error(String(err)));
      }
    };

    // A stdin write/EPIPE failure (#492) is a diagnostic, like a forward-stream
    // failure — never let it masquerade as a gate/verdict outcome; the command's
    // own exit code (or lack of one) still drives the result.
    let stdinNote = "";
    const onStdinError = (err: Error) => {
      if (stdinNote) return;
      stdinNote = `[harness ${label}] stdin write error (diagnostic; command outcome unaffected): ${err.message}`;
    };

    const settle = (result: HarnessResult) => {
      if (settled) return;
      settled = true;
      if (killProcessGroup) {
        process.removeListener("SIGINT", sigintHandler);
        process.removeListener("SIGTERM", sigtermHandler);
      }
      if (stream) {
        fwd.stdout.off("error", onForwardError);
        fwd.stderr.off("error", onForwardError);
      }
      const notes = [forwardNote, stdinNote].filter(Boolean).join("\n");
      if (notes) {
        result = {
          ...result,
          stderr: result.stderr ? `${result.stderr}\n${notes}` : notes,
        };
      }
      resolvePromise(result);
    };

    const killGroup = (signal: NodeJS.Signals) => {
      if (killProcessGroup && child.pid != null) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          // best effort — group may already be dead
        }
      } else {
        try {
          child.kill(signal);
        } catch {
          // best effort
        }
      }
    };

    // Forward parent cancellation signals to the detached process group so harness
    // descendants are not left running when the pipeline process is cancelled.
    const onParentSignal = (sig: NodeJS.Signals) => {
      killGroup(sig);
      process.removeListener("SIGINT", sigintHandler);
      process.removeListener("SIGTERM", sigtermHandler);
      // Re-raise so the parent process terminates with normal signal semantics.
      process.kill(process.pid, sig);
    };
    const sigintHandler = () => onParentSignal("SIGINT");
    const sigtermHandler = () => onParentSignal("SIGTERM");

    if (killProcessGroup) {
      process.on("SIGINT", sigintHandler);
      process.on("SIGTERM", sigtermHandler);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");

      // Record the timeout to the run store at the instant the cap fires — before,
      // and independent of, this promise resolving — so a supervisor tailing
      // events.jsonl can detect a wedge without process introspection (#398).
      // Best-effort and inert when the invocation carries no run-store context.
      if (opts.timeoutEvent) {
        const { runDir, runStoreDeps, stage } = opts.timeoutEvent;
        appendEvent(
          runDir,
          {
            schema_version: RUN_SCHEMA_VERSION,
            type: "harness_timeout",
            at: nowIso(),
            stage,
            timeout_sec: timeoutSec,
          },
          runStoreDeps,
        ).catch(() => {});
      }

      // Hard secondary deadline (#398): a sibling failsafe armed the moment the cap
      // fires — not nested inside the SIGKILL escalation chain below — so runCapped
      // concludes even if a detached grandchild survives SIGKILL and keeps the
      // inherited stdio pipes open (in which case child.stdout/stderr never emit
      // `close`). settle()'s single-resolution guard makes this a no-op once the
      // escalation chain below has already settled, which is the common case, so
      // clean timeouts see no added latency.
      setTimeout(() => {
        const duration = (Date.now() - start) / 1000;
        settle({
          success: false,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          exit_code: lastExitCode ?? -1,
          duration,
          timed_out: true,
        });
      }, (killGraceSec + hardDeadlineSec) * 1000);

      // After the grace period, force-kill any remaining group members and only then
      // resolve — so all descendants are absent from the OS process table before
      // runCapped returns, even if a grandchild ignored SIGTERM.
      setTimeout(() => {
        killGroup("SIGKILL");
        setTimeout(() => {
          const duration = (Date.now() - start) / 1000;
          settle({
            success: false,
            stdout: stdoutBuf,
            stderr: stderrBuf,
            exit_code: lastExitCode ?? -1,
            duration,
            timed_out: true,
          });
        }, 200);
      }, killGraceSec * 1000);
    }, timeoutSec * 1000);

    const captureMode = opts.captureMode ?? "head";
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (captureMode === "tail") {
        stdoutBuf += text;
        if (stdoutBuf.length > MAX_OUTPUT) stdoutBuf = stdoutBuf.slice(stdoutBuf.length - MAX_OUTPUT);
      } else if (stdoutBuf.length < MAX_OUTPUT) {
        stdoutBuf += text;
        if (stdoutBuf.length > MAX_OUTPUT) stdoutBuf = stdoutBuf.slice(0, MAX_OUTPUT);
      }
      if (stream) {
        const forwardText = opts.transformForward ? opts.transformForward(text) : text;
        if (forwardText) safeForward(fwd.stdout, forwardText);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stderrBuf.length < MAX_OUTPUT) {
        stderrBuf += text;
        if (stderrBuf.length > MAX_OUTPUT) stderrBuf = stderrBuf.slice(0, MAX_OUTPUT);
      }
      if (stream) safeForward(fwd.stderr, text);
    });

    // #492: write the stdin payload and end the stream now that stdout/stderr
    // readers are attached, so nothing can be missed before the write.
    if (opts.stdinPayload !== undefined && child.stdin) {
      child.stdin.on("error", onStdinError);
      child.stdin.end(opts.stdinPayload, "utf8");
    }

    // A capture stream erroring mid-run (e.g. the pipe breaking before the
    // process exit is observed) is a tooling failure, not a genuine test
    // result — without this handler an unhandled stream 'error' would throw
    // and crash the pipeline process itself (#384).
    const onCaptureError = (err: Error) => {
      if (settled) return;
      clearTimeout(timer);
      killGroup("SIGTERM");
      const duration = (Date.now() - start) / 1000;
      settle({
        success: false,
        stdout: stdoutBuf,
        stderr: `[harness ${label}] output-capture error: ${err.message}\n${stderrBuf}`,
        exit_code: -1,
        duration,
        timed_out: false,
        capture_error: true,
      });
    };
    child.stdout?.on("error", onCaptureError);
    child.stderr?.on("error", onCaptureError);

    child.on("error", (err) => {
      clearTimeout(timer);
      const duration = (Date.now() - start) / 1000;
      settle({
        success: false,
        stdout: stdoutBuf,
        stderr: `[harness ${label}] spawn error: ${err.message}\n${stderrBuf}`,
        exit_code: -1,
        duration,
        timed_out: false,
        spawn_error: true,
      });
    });

    child.on("close", (code) => {
      lastExitCode = code;
      // When timed out, the direct child exiting is not sufficient — grandchildren
      // that ignored SIGTERM may still be alive. Defer to the SIGKILL timer above.
      if (timedOut) return;
      clearTimeout(timer);
      const duration = (Date.now() - start) / 1000;
      settle({
        success: code === 0,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        exit_code: code ?? -1,
        duration,
        timed_out: false,
      });
    });
  });
}

/** Legacy helper retained for old parser tests and manual harness toggles. */
export function crossHarness(h: Harness): Harness {
  return h === "claude" ? "codex" : "claude";
}
