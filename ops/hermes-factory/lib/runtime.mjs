import { spawn } from "node:child_process";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

export async function runProcess(
  command,
  args,
  {
    cwd,
    env = {},
    input = null,
    timeoutMs = 60_000,
    stopGraceMs = 10_000,
    shouldStop = async () => null,
    onHeartbeat = async () => {},
    onStdoutLine = async () => {},
    heartbeatMs = 900_000,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stopped = null;
    let timedOut = false;
    let checking = false;
    let killTimer = null;
    let stdoutRemainder = "";
    let stdoutCallbacks = Promise.resolve();

    const capture = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      return next.length > MAX_CAPTURE_BYTES ? next.slice(next.length - MAX_CAPTURE_BYTES) : next;
    };
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout = capture(stdout, text);
      const combined = stdoutRemainder + text;
      const lines = combined.split(/\r?\n/);
      stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) {
        stdoutCallbacks = stdoutCallbacks.then(() => onStdoutLine(line)).catch(() => {});
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr = capture(stderr, chunk);
    });
    child.on("error", reject);

    if (input != null) {
      child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
    }

    const terminate = (reason) => {
      if (stopped) return;
      stopped = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), stopGraceMs);
      killTimer.unref?.();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate("command timeout");
    }, timeoutMs);
    timeout.unref?.();

    const stopPoll = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const reason = await shouldStop();
        if (reason) terminate(reason);
      } catch {
        terminate("control check failed");
      } finally {
        checking = false;
      }
    }, 1000);
    stopPoll.unref?.();

    const heartbeat = setInterval(() => {
      Promise.resolve(onHeartbeat()).catch(() => {});
    }, heartbeatMs);
    heartbeat.unref?.();

    child.on("close", async (code, signal) => {
      clearTimeout(timeout);
      clearInterval(stopPoll);
      clearInterval(heartbeat);
      if (killTimer) clearTimeout(killTimer);
      if (stdoutRemainder) {
        stdoutCallbacks = stdoutCallbacks.then(() => onStdoutLine(stdoutRemainder)).catch(() => {});
      }
      await stdoutCallbacks;
      resolve({
        code: code ?? (signal ? 1 : 0),
        signal: signal ?? null,
        stdout,
        stderr,
        stopped,
        timed_out: timedOut,
      });
    });
  });
}

export class CommandError extends Error {
  constructor(message, { command, code, definitive = false, stopped = null } = {}) {
    super(message);
    this.name = "CommandError";
    this.command = command;
    this.code = code;
    this.definitive = definitive;
    this.stopped = stopped;
  }
}

export function commandName(command, args = []) {
  return [command, ...args].map((part) => String(part)).join(" ");
}

export function requireSuccess(result, command, args, { definitive = false } = {}) {
  if (result.stopped) {
    throw new CommandError(`command stopped: ${result.stopped}`, {
      command: commandName(command, args),
      code: result.code,
      stopped: result.stopped,
    });
  }
  if (result.code !== 0) {
    throw new CommandError(`command failed with exit ${result.code}`, {
      command: commandName(command, args),
      code: result.code,
      definitive,
    });
  }
  return result;
}

export function parseLastJsonObject(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value && typeof value === "object") return value;
    } catch {}
  }
  throw new Error("command output did not contain a JSON object");
}
