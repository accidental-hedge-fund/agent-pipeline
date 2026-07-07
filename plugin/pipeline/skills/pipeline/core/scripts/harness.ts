// Run a harness CLI inside a worktree directory, streaming output to the
// console while also capturing it for return.
//
// claude:  claude --print --permission-mode bypassPermissions --output-format text [--model X] [--effort Y] <prompt>
// codex:   codex exec --full-auto -C <worktreeDir> [-c model_reasoning_effort=Y] <prompt>
//          Set PIPELINE_CODEX_NO_SANDBOX=1 to use Codex's explicit
//          --dangerously-bypass-approvals-and-sandbox mode on externally
//          sandboxed runners where Codex's bubblewrap/userns sandbox cannot start.
// custom:  <name> <prompt>   (#40 — a user-configured reviewer CLI)
//
// The two built-in harnesses keep their exact invocation shapes. Any other
// string is treated as a configured reviewer CLI (`review_harness`, #40): it is
// spawned with the prompt as a single positional argument and its stdout is the
// harness output. A custom CLI that cannot be spawned yields a specific, named
// failure in the returned `HarnessResult` — never a thrown "Unknown harness".
//
// Captured stdout/stderr is capped at MAX_OUTPUT to bound memory.

import { spawn } from "node:child_process";
import * as path from "node:path";
import { buildStageAccountingRecord } from "./accounting.ts";
import { emitStageAccounting, type RunStoreDeps } from "./run-store.ts";
import type { Harness } from "./types.ts";

const MAX_OUTPUT = 100_000; // 100 KB cap on captured output

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

export interface HarnessResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number;
  duration: number; // seconds
  timed_out: boolean;
  spawn_error?: boolean; // true when the process could not be spawned at all
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
}

export interface InvokeOptions {
  /** Per-call wall-clock timeout in seconds. */
  timeoutSec?: number;
  /** Optional model override. Currently only honored by claude. */
  model?: string;
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
}

export async function invoke(
  harness: string,
  worktreeDir: string,
  prompt: string,
  opts: InvokeOptions = {},
): Promise<HarnessResult> {
  const stream = opts.stream ?? true;
  const timeoutSec = opts.timeoutSec ?? 1200;

  let cmd: string;
  let args: string[];
  let custom = false;
  if (harness === "claude") {
    cmd = "claude";
    const permMode = opts.sandbox ? "default" : "bypassPermissions";
    args = ["--print", "--permission-mode", permMode, "--output-format", "text"];
    if (opts.lean) {
      // Lean single-shot generation. `--tools` is variadic, so its empty value
      // ("" = disable all tools) is placed immediately before `--strict-mcp-config`
      // (a flag) — never before the trailing prompt positional, which the variadic
      // would otherwise swallow.
      args.push("--tools", "", "--strict-mcp-config");
    }
    if (opts.model) args.push("--model", opts.model);
    if (opts.reasoningEffort) args.push("--effort", opts.reasoningEffort);
    args.push(prompt);
  } else if (harness === "codex") {
    cmd = "codex";
    const noSandbox = process.env.PIPELINE_CODEX_NO_SANDBOX === "1";
    args = [
      "exec",
      noSandbox ? "--dangerously-bypass-approvals-and-sandbox" : "--full-auto",
      "-C",
      worktreeDir,
    ];
    if (opts.reasoningEffort) args.push("-c", `model_reasoning_effort=${opts.reasoningEffort}`);
    args.push(prompt);
  } else {
    // A user-configured reviewer CLI (`review_harness`, #40). Invoke it with the
    // prompt as a single positional argument; its stdout is the verdict output
    // (parsed by parseStructuredVerdict, exactly like a built-in reviewer).
    cmd = harness;
    args = [prompt];
    custom = true;
  }

  const startedAt = new Date();
  const result = await runCapped(cmd, args, worktreeDir, timeoutSec, stream, harness, { killProcessGroup: true });
  const endedAt = new Date();
  if (opts.accounting) {
    const model = opts.accounting.model ?? opts.model ?? null;
    const record = buildStageAccountingRecord({
      runId: path.basename(opts.accounting.runDir),
      issue: opts.accounting.issue,
      stage: opts.accounting.stage,
      harness,
      modelSlot: opts.accounting.modelSlot ?? null,
      model,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: result.duration * 1000,
      commandCount: opts.accounting.commandCount ?? 1,
      subprocessCount: opts.accounting.subprocessCount ?? 1,
      outcome: harnessOutcome(result),
      blockerKind: result.success ? null : "harness-failure",
      usage: opts.accounting.usage,
      estimatedCostUsd: opts.accounting.estimatedCostUsd,
      promptChars: prompt.length,
      promptEstimatedTokens: Math.ceil(prompt.length / 4),
    });
    await emitStageAccounting(
      opts.accounting.runDir,
      record,
      opts.accounting.runStoreDeps,
    ).catch(() => {});
  }
  // When a configured reviewer CLI cannot be spawned at all (ENOENT / not
  // executable), surface a specific, actionable message that names the CLI —
  // never a bare "Unknown harness". The `spawn_error` flag is preserved so the
  // #39 self-review fallback still triggers in invokeReviewer.
  if (custom && result.spawn_error) {
    return {
      ...result,
      stderr:
        `reviewer CLI '${harness}' not found or not executable — ensure it is installed and on PATH\n` +
        result.stderr,
    };
  }
  return result;
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
    // Injectable spawn seam (#384): lets tests simulate a capture stream that
    // errors mid-run without a real OS-level pipe fault. Defaults to the real
    // node:child_process spawn.
    spawnFn?: typeof spawn;
    // Injectable forward-destination seam (#384 delta review, key 84c9859e):
    // lets tests simulate the DOWNSTREAM side of the pipe — our own
    // stdout/stderr (terminal-log tee, event-sink socket) — failing while the
    // child command itself succeeds. Defaults to the real process streams.
    forwardTo?: { stdout: ForwardStream; stderr: ForwardStream };
  } = {},
): Promise<HarnessResult> {
  const start = Date.now();
  return new Promise<HarnessResult>((resolvePromise) => {
    const killProcessGroup = opts.killProcessGroup ?? false;
    // Grace period (seconds) between SIGTERM and SIGKILL on timeout. Configurable
    // so tests can use a short value without waiting the full 5 s default.
    const killGraceSec = opts.killGraceSec ?? 5;
    const spawnImpl = opts.spawnFn ?? spawn;
    const child = spawnImpl(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // detached creates a new process group so we can kill all descendants on timeout
      ...(killProcessGroup ? { detached: true } : {}),
    });
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
      if (forwardNote) {
        result = {
          ...result,
          stderr: result.stderr ? `${result.stderr}\n${forwardNote}` : forwardNote,
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

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stdoutBuf.length < MAX_OUTPUT) {
        stdoutBuf += text;
        if (stdoutBuf.length > MAX_OUTPUT) stdoutBuf = stdoutBuf.slice(0, MAX_OUTPUT);
      }
      if (stream) safeForward(fwd.stdout, text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stderrBuf.length < MAX_OUTPUT) {
        stderrBuf += text;
        if (stderrBuf.length > MAX_OUTPUT) stderrBuf = stderrBuf.slice(0, MAX_OUTPUT);
      }
      if (stream) safeForward(fwd.stderr, text);
    });

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
