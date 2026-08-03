// Pure unit tests for the README landing-page contract (#855).
// No network, git, or subprocess.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  README_LANDING_MAX_LINES,
  README_REQUIRED_COMPANIONS,
  build793ShapedMonolithicReadme,
  checkReadmeLandingContract,
  countReadmeLines,
  detectFullInventoryShape,
  formatReadmeLandingDiagnostics,
  hasRelativeCompanionLink,
} from "../scripts/readme-landing-contract.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const LEAN_README = [
  "# agent-pipeline",
  "",
  "Lean landing page.",
  "",
  "## Lifecycle",
  "",
  "Sixteen-stage state machine.",
  "",
  "## Where to go next",
  "",
  "| Doc | What |",
  "| --- | --- |",
  "| **[docs/cli.md](docs/cli.md)** | Full CLI command reference |",
  "| **[docs/config.md](docs/config.md)** | Config key reference |",
  "| **[docs/concepts.md](docs/concepts.md)** | Advanced topics |",
  "",
  "**Common commands** (see [docs/cli.md](docs/cli.md) for the full inventory):",
  "",
  "```",
  "pipeline 42",
  "```",
  "",
  "## License",
  "",
  "MIT",
  "",
].join("\n");

describe("countReadmeLines", () => {
  test("empty is 0; wc -l style for trailing newline", () => {
    assert.equal(countReadmeLines(""), 0);
    assert.equal(countReadmeLines("a\n"), 1);
    assert.equal(countReadmeLines("a\nb\n"), 2);
    assert.equal(countReadmeLines("a\nb"), 2);
  });
});

describe("hasRelativeCompanionLink", () => {
  test("accepts relative markdown links with optional ./ and anchors", () => {
    assert.equal(hasRelativeCompanionLink("[x](docs/cli.md)", "docs/cli.md"), true);
    assert.equal(
      hasRelativeCompanionLink("[x](./docs/config.md#keys)", "docs/config.md"),
      true,
    );
    assert.equal(
      hasRelativeCompanionLink("[x](https://example.com/docs/cli.md)", "docs/cli.md"),
      false,
    );
    assert.equal(hasRelativeCompanionLink("docs/cli.md bare", "docs/cli.md"), false);
  });
});

describe("checkReadmeLandingContract", () => {
  test("compliant lean README passes", () => {
    const result = checkReadmeLandingContract(LEAN_README);
    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.length, 0);
    assert.ok(result.lineCount < README_LANDING_MAX_LINES);
  });

  test("over-budget fails with line-budget diagnostic", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    // Ensure companion links so only budget fails
    lines[0] = "# title";
    lines[1] = "[cli](docs/cli.md) [cfg](docs/config.md) [c](docs/concepts.md)";
    const content = lines.join("\n") + "\n";
    assert.ok(countReadmeLines(content) >= 400);
    const result = checkReadmeLandingContract(content);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((d) => d.code === "line-budget"));
    const budget = result.diagnostics.find((d) => d.code === "line-budget");
    assert.ok(budget?.lineCount != null && budget.lineCount >= 400);
    assert.match(formatReadmeLandingDiagnostics(result), /landing-page contract breach/i);
    assert.match(formatReadmeLandingDiagnostics(result), /line-budget/);
  });

  test("missing companion link fails with missing-companion-link", () => {
    const missingConcepts = LEAN_README.replace(
      /docs\/concepts\.md/g,
      "docs/other.md",
    );
    const result = checkReadmeLandingContract(missingConcepts);
    assert.equal(result.ok, false);
    const miss = result.diagnostics.filter((d) => d.code === "missing-companion-link");
    assert.ok(miss.some((d) => d.companion === "docs/concepts.md"));
    assert.match(formatReadmeLandingDiagnostics(result), /docs\/concepts\.md/);
  });

  test("full inventory shape fails even when under line budget", () => {
    // Compact but multi-section inventory (under 400 lines) still fails shape.
    const sections = [
      "## Usage",
      "## Intake sub-command",
      "## Sweep sub-command",
      "## Merge sub-command",
      "## Per-repo config (optional)",
      "## Advanced topics",
      "## Troubleshooting",
    ];
    const body = [
      "# title",
      "[cli](docs/cli.md)",
      "[cfg](docs/config.md)",
      "[concepts](docs/concepts.md)",
      ...sections.flatMap((h) => [h, "", "body", ""]),
    ].join("\n");
    assert.ok(countReadmeLines(body) < README_LANDING_MAX_LINES);
    assert.equal(detectFullInventoryShape(body), true);
    const result = checkReadmeLandingContract(body);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((d) => d.code === "full-inventory-shape"));
  });
});

describe("#793-shaped monolithic append regression", () => {
  test("fixture shaped like the #793 append fails the guard", () => {
    const fixture = build793ShapedMonolithicReadme();
    assert.ok(
      countReadmeLines(fixture) >= README_LANDING_MAX_LINES,
      "fixture must be over budget like #793",
    );
    const result = checkReadmeLandingContract(fixture);
    assert.equal(result.ok, false, "landing-page contract must fail on #793 shape");
    assert.ok(
      result.diagnostics.some((d) => d.code === "line-budget"),
      "must report line-budget",
    );
    // Shape heuristic should also fire on the appended section set.
    assert.ok(
      result.diagnostics.some((d) => d.code === "full-inventory-shape"),
      "must report full-inventory-shape for the monolith section set",
    );
    const text = formatReadmeLandingDiagnostics(result);
    assert.match(text, /README landing-page contract breach/);
  });

  test("regression bites without the guard (proves the assertion path)", () => {
    // If enforcement were deleted (always-ok), this test pattern would fail.
    // We prove the fixture is non-compliant and that ok===false is required.
    const fixture = build793ShapedMonolithicReadme({ appendLines: 2000 });
    const result = checkReadmeLandingContract(fixture);
    assert.notEqual(
      result.ok,
      true,
      "removing or bypassing the guard would leave #793 shape green — this must stay red",
    );
    assert.equal(result.ok, false);
  });
});

describe("repo README artifact (when restored)", () => {
  test("checked-in README.md satisfies the landing-page contract", () => {
    const readmePath = path.join(repoRoot, "README.md");
    assert.ok(fs.existsSync(readmePath), "README.md must exist");
    const content = fs.readFileSync(readmePath, "utf8");
    const result = checkReadmeLandingContract(content);
    assert.equal(
      result.ok,
      true,
      formatReadmeLandingDiagnostics(result) || "README contract failed",
    );
    for (const c of README_REQUIRED_COMPANIONS) {
      assert.ok(
        hasRelativeCompanionLink(content, c),
        `README must link ${c}`,
      );
    }
    assert.ok(
      result.lineCount < README_LANDING_MAX_LINES,
      `README line count ${result.lineCount} must be < ${README_LANDING_MAX_LINES}`,
    );
  });
});
