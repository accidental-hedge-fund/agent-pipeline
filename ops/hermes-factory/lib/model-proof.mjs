import * as fs from "node:fs/promises";
import { join } from "node:path";
import { envForRole } from "./config.mjs";
import { requireSuccess, runProcess } from "./runtime.mjs";

export const REQUIRED_EFFECTIVE_GROK_MODEL = "grok-4.5";

export function parseEffectiveGrokModel(stdout) {
  let terminal = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    try {
      const value = JSON.parse(line);
      if (value?.type === "end") terminal = value;
    } catch {}
  }
  if (!terminal || !terminal.modelUsage || typeof terminal.modelUsage !== "object" || Array.isArray(terminal.modelUsage)) {
    throw new Error("Grok did not report an effective model in terminal telemetry");
  }
  const models = Object.keys(terminal.modelUsage);
  if (models.length !== 1) {
    throw new Error(`Grok terminal telemetry reported ${models.length} effective models`);
  }
  if (models[0] !== REQUIRED_EFFECTIVE_GROK_MODEL) {
    throw new Error(`Grok effective model is ${models[0]}, expected ${REQUIRED_EFFECTIVE_GROK_MODEL}`);
  }
  return models[0];
}

export async function probeEffectiveGrokModel(
  config,
  {
    run = runProcess,
    mkdir = fs.mkdir,
    mkdtemp = fs.mkdtemp,
    writeFile = fs.writeFile,
    rm = fs.rm,
    env = process.env,
  } = {},
) {
  await mkdir(join(config.state_dir, "model-probes"), { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(config.state_dir, "model-probes", "probe-"));
  const promptPath = join(dir, "prompt.txt");
  try {
    await writeFile(promptPath, 'Reply with only {"ok":true}. Do not use tools or change files.\n', { mode: 0o600 });
    const args = [
      "--no-auto-update",
      "--prompt-file",
      promptPath,
      "--cwd",
      dir,
      "--output-format",
      "streaming-json",
      "--verbatim",
      "--permission-mode",
      "default",
      "-m",
      REQUIRED_EFFECTIVE_GROK_MODEL,
      "--reasoning-effort",
      "low",
    ];
    const result = await run(config.grok_command, args, {
      cwd: dir,
      env: { ...envForRole(config, "model_probe", env), PIPELINE_HARNESS_TELEMETRY: "on" },
      timeoutMs: 180_000,
      shouldStop: async () => null,
    });
    requireSuccess(result, config.grok_command, args, { definitive: true });
    return {
      requested_model: REQUIRED_EFFECTIVE_GROK_MODEL,
      effective_model: parseEffectiveGrokModel(result.stdout),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
