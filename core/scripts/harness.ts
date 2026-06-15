// Run a harness CLI inside a worktree directory, streaming output to the
// console while also capturing it for return.
//
// claude:  claude --print --permission-mode bypassPermissions --output-format text [--model X] <prompt>
// codex:   codex exec --full-auto -C <worktreeDir> <prompt>
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
}

export interface InvokeOptions {
  /** Per-call wall-clock timeout in seconds. */
  timeoutSec?: number;
  /** Optional model override. Currently only honored by claude. */
  model?: string;
  /** Stream output to process.stderr/stdout in real time. Default true. */
  stream?: boolean;
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
    args = ["--print", "--permission-mode", "bypassPermissions", "--output-format", "text"];
    if (opts.model) args.push("--model", opts.model);
    args.push(prompt);
  } else if (harness === "codex") {
    cmd = "codex";
    args = ["exec", "--full-auto", "-C", worktreeDir, prompt];
  } else {
    // A user-configured reviewer CLI (`review_harness`, #40). Invoke it with the
    // prompt as a single positional argument; its stdout is the verdict output
    // (parsed by parseStructuredVerdict, exactly like a built-in reviewer).
    cmd = harness;
    args = [prompt];
    custom = true;
  }

  const result = await runCapped(cmd, args, worktreeDir, timeoutSec, stream, harness);
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

export async function runCapped(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutSec: number,
  stream: boolean,
  label: string,
  opts: { killProcessGroup?: boolean } = {},
): Promise<HarnessResult> {
  const start = Date.now();
  return new Promise<HarnessResult>((resolve) => {
    const killProcessGroup = opts.killProcessGroup ?? false;
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // detached creates a new process group so we can kill all descendants on timeout
      ...(killProcessGroup ? { detached: true } : {}),
    });
    let stdoutBuf = "";
    let stderrBuf = "";
    let timedOut = false;

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

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      // Hard kill the process group if still alive after 5s.
      setTimeout(() => killGroup("SIGKILL"), 5000);
    }, timeoutSec * 1000);

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stdoutBuf.length < MAX_OUTPUT) {
        stdoutBuf += text;
        if (stdoutBuf.length > MAX_OUTPUT) stdoutBuf = stdoutBuf.slice(0, MAX_OUTPUT);
      }
      if (stream) process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stderrBuf.length < MAX_OUTPUT) {
        stderrBuf += text;
        if (stderrBuf.length > MAX_OUTPUT) stderrBuf = stderrBuf.slice(0, MAX_OUTPUT);
      }
      if (stream) process.stderr.write(text);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      const duration = (Date.now() - start) / 1000;
      resolve({
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
      clearTimeout(timer);
      const duration = (Date.now() - start) / 1000;
      resolve({
        success: code === 0 && !timedOut,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        exit_code: code ?? -1,
        duration,
        timed_out: timedOut,
      });
    });
  });
}

/** Legacy helper retained for old parser tests and manual harness toggles. */
export function crossHarness(h: Harness): Harness {
  return h === "claude" ? "codex" : "claude";
}
