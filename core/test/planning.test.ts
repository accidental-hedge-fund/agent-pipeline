// Unit tests for the last30days non-blocking setup hint (#34) — no skill /
// Python required. `gatherCarryForward` is exercised through an injected `run`
// stub so the two empty-brief branches and the disabled fast-path are covered
// deterministically (the repo's testgate.ts uses the same dependency-injection
// seam for external calls).

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  buildSetupHint,
  gatherCarryForward,
  type CarryForwardDeps,
} from "../scripts/stages/planning.ts";
import type { BriefResult } from "../scripts/last30days.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const enabledCfg = {
  last30days: { enabled: true, timeout: 600 },
} as unknown as PipelineConfig;

// Disabled is the default — gatherCarryForward returns before touching any deps.
const disabledCfg = {
  last30days: { enabled: false, timeout: 600 },
} as unknown as PipelineConfig;

/** A `run` stub that records its calls and resolves to a fixed BriefResult. */
function stubRun(result: BriefResult): { deps: CarryForwardDeps; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      run: async (topic: string) => {
        calls.push(topic);
        return result;
      },
    },
  };
}

/** Capture console.log lines emitted during `fn`, restoring the original after. */
async function captureLogs(t: TestContext, fn: () => Promise<void>): Promise<string[]> {
  const logged: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  await fn();
  return logged;
}

// ---------------------------------------------------------------------------
// buildSetupHint — message content (keys, install, link)
// ---------------------------------------------------------------------------

test("buildSetupHint: unavailable mode names install command and data-source keys", () => {
  const hint = buildSetupHint(42, "unavailable");
  assert.match(hint, /#42/);
  assert.match(hint, /npx.*last30days/i);
  assert.match(hint, /data-source keys/i);
  assert.match(hint, /BRAVE_SEARCH_API_KEY/);
  assert.match(hint, /SCRAPECREATORS_API_KEY/);
  assert.match(hint, /last30days-skill/);
});

test("buildSetupHint: no-signal mode names both keys and links to skill setup", () => {
  const hint = buildSetupHint(99, "no-signal");
  assert.match(hint, /#99/);
  assert.match(hint, /BRAVE_SEARCH_API_KEY/);
  assert.match(hint, /SCRAPECREATORS_API_KEY/);
  assert.match(hint, /last30days-skill/);
});

// ---------------------------------------------------------------------------
// gatherCarryForward — branch behavior (4.1 / 4.2 / 4.3)
// ---------------------------------------------------------------------------

test("gatherCarryForward: hint emitted + '' returned when run() is unavailable", async (t) => {
  const { deps, calls } = stubRun({ brief: "", stats: "", success: false, unavailable: true });
  let result = "<unset>";
  const logged = await captureLogs(t, async () => {
    result = await gatherCarryForward(enabledCfg, 42, "test topic", deps);
  });

  assert.equal(result, "");
  assert.deepEqual(calls, ["test topic"], "run() should be called once with the topic");
  const hint = logged.find((m) => m.includes("last30days:"));
  assert.ok(hint, `expected a last30days hint, saw: ${logged.join(" | ")}`);
  assert.match(hint!, /not found/i);
  assert.match(hint!, /npx.*last30days/i);
});

test("gatherCarryForward: hint emitted + '' returned when run() yields no signal", async (t) => {
  // success: true but the brief has no cluster/### markers → hasSignal() is false.
  const { deps } = stubRun({
    brief: "Thin prose with no grouped findings or markdown headings.",
    stats: "",
    success: true,
    unavailable: false,
  });
  let result = "<unset>";
  const logged = await captureLogs(t, async () => {
    result = await gatherCarryForward(enabledCfg, 7, "topic", deps);
  });

  assert.equal(result, "");
  const hint = logged.find((m) => m.includes("last30days:"));
  assert.ok(hint, `expected a last30days hint, saw: ${logged.join(" | ")}`);
  assert.match(hint!, /no usable signal/i);
  assert.match(hint!, /BRAVE_SEARCH_API_KEY/);
});

test("gatherCarryForward: hint emitted + '' returned when run() fails (success: false)", async (t) => {
  const { deps } = stubRun({ brief: "", stats: "", success: false, unavailable: false });
  let result = "<unset>";
  const logged = await captureLogs(t, async () => {
    result = await gatherCarryForward(enabledCfg, 8, "topic", deps);
  });

  assert.equal(result, "");
  const hint = logged.find((m) => m.includes("last30days:") && /no usable signal/i.test(m));
  assert.ok(hint, `expected a no-signal hint, saw: ${logged.join(" | ")}`);
});

test("gatherCarryForward: no hint and run() never called when last30days disabled", async (t) => {
  const { deps, calls } = stubRun({ brief: "", stats: "", success: true, unavailable: false });
  let result = "<unset>";
  const logged = await captureLogs(t, async () => {
    result = await gatherCarryForward(disabledCfg, 42, "test topic", deps);
  });

  assert.equal(result, "");
  assert.deepEqual(calls, [], "run() must not be called when disabled");
  assert.ok(
    !logged.some((m) => m.includes("last30days:")),
    `expected no hint but saw: ${logged.join(" | ")}`,
  );
});
