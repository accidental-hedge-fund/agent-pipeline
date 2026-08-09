// Shared grammar + parity tests for #905 (capabilities
// `declared-dependency-grammar`, loop/roadmap lexical parity).
// Zero network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDeclaredDependencyIds } from "../scripts/declared-dependency-grammar.ts";
import { findTextualDepCandidates } from "../scripts/roadmap/depgraph.ts";
import type { InventoryItem } from "../scripts/roadmap/types.ts";
import { LEXICAL_FIXTURE_ROWS } from "./fixtures/declared-deps/lexical-fixtures.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("shared lexical fixtures: grammar produces expected ids", () => {
  for (const row of LEXICAL_FIXTURE_ROWS) {
    const got = parseDeclaredDependencyIds(row.text, row.selfId);
    assert.deepEqual(
      got,
      [...row.expected],
      `fixture "${row.name}": expected ${JSON.stringify(row.expected)}, got ${JSON.stringify(got)}`,
    );
  }
});

test("shared lexical fixtures: loop and roadmap paths yield identical lexical sets", () => {
  for (const row of LEXICAL_FIXTURE_ROWS) {
    const loopIds = parseDeclaredDependencyIds(row.text, row.selfId);

    // Roadmap path: build a synthetic inventory that includes every mentioned
    // id so inventory filtering does not drop refs — parity is on lexical sets.
    const mentioned = new Set<number>();
    for (const id of loopIds) mentioned.add(Number(id));
    const selfNum = row.selfId ? Number(row.selfId) : 999_001;
    mentioned.add(selfNum);
    // Ensure unrelated bare refs that grammar correctly ignores are still in
    // inventory if present, so we prove they still do not become candidates.
    for (const m of row.text.matchAll(/#(\d+)/g)) {
      mentioned.add(Number(m[1]));
    }

    const items: InventoryItem[] = [...mentioned].map((n) => ({
      issue: {
        number: n,
        title: n === selfNum ? "depender" : `issue ${n}`,
        body: n === selfNum ? row.text : "",
        labels: [],
        url: "",
        state: "open",
      },
      touched_files: [],
    }));

    const candidates = findTextualDepCandidates(items);
    const roadmapPrereqs = candidates
      .filter(([, depender]) => depender === selfNum)
      .map(([prereq]) => String(prereq))
      .sort((a, b) => Number(a) - Number(b));
    const loopSorted = [...loopIds].sort((a, b) => Number(a) - Number(b));
    // When selfId filters self-refs, roadmap also filters self via grammar + inventory.
    assert.deepEqual(
      roadmapPrereqs,
      loopSorted,
      `parity "${row.name}": loop=${JSON.stringify(loopSorted)} roadmap=${JSON.stringify(roadmapPrereqs)}`,
    );
  }
});

test("multi-reference body produces multiple textual candidates (roadmap AC)", () => {
  const items: InventoryItem[] = [
    {
      issue: {
        number: 10,
        title: "depender",
        body: "Depends on: #5, #6",
        labels: [],
        url: "",
        state: "open",
      },
      touched_files: [],
    },
    {
      issue: { number: 5, title: "a", body: "", labels: [], url: "", state: "open" },
      touched_files: [],
    },
    {
      issue: { number: 6, title: "b", body: "", labels: [], url: "", state: "open" },
      touched_files: [],
    },
  ];
  const candidates = findTextualDepCandidates(items);
  assert.ok(candidates.some(([p, d]) => p === 5 && d === 10));
  assert.ok(candidates.some(([p, d]) => p === 6 && d === 10));
});

test("unrelated prose does not create textual candidates (roadmap AC)", () => {
  const items: InventoryItem[] = [
    {
      issue: {
        number: 1,
        title: "a",
        body: "See #42 in the design doc",
        labels: [],
        url: "",
        state: "open",
      },
      touched_files: [],
    },
    {
      issue: { number: 42, title: "b", body: "", labels: [], url: "", state: "open" },
      touched_files: [],
    },
  ];
  assert.deepEqual(findTextualDepCandidates(items), []);
});

test("captured #890–#903 fixture matches the exact declared graph", () => {
  const raw = readFileSync(
    join(here, "fixtures/declared-deps/issues-890-903.json"),
    "utf8",
  );
  const fixture = JSON.parse(raw) as {
    issues: Array<{ number: number; title: string; body: string }>;
    expected_raw_edges: Record<string, string[]>;
  };

  const byId = new Map<string, string[]>();
  for (const issue of fixture.issues) {
    const id = String(issue.number);
    const text = `${issue.title}\n${issue.body}`;
    byId.set(id, parseDeclaredDependencyIds(text, id));
  }

  for (const [id, expected] of Object.entries(fixture.expected_raw_edges)) {
    const got = byId.get(id) ?? [];
    assert.deepEqual(
      got,
      expected,
      `#${id}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`,
    );
  }

  // Explicit AC anchors for the multi-ref completeness bug.
  assert.deepEqual(byId.get("900"), ["899", "662"]);
  assert.ok(byId.get("900")!.includes("899"), "in-set #899");
  assert.ok(byId.get("900")!.includes("662"), "external #662");
});

test("captured #890–#903: roadmap textual candidates agree for in-set edges", () => {
  const raw = readFileSync(
    join(here, "fixtures/declared-deps/issues-890-903.json"),
    "utf8",
  );
  const fixture = JSON.parse(raw) as {
    issues: Array<{ number: number; title: string; body: string }>;
    expected_raw_edges: Record<string, string[]>;
  };

  const items: InventoryItem[] = fixture.issues.map((issue) => ({
    issue: {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: [],
      url: "",
      state: "open",
    },
    touched_files: [],
  }));
  // Inventory is only #890–#903; external #662 / #905 / #906 / #907 drop.
  const inventory = new Set(fixture.issues.map((i) => i.number));
  const candidates = findTextualDepCandidates(items);

  for (const issue of fixture.issues) {
    const id = String(issue.number);
    const expectedInSet = (fixture.expected_raw_edges[id] ?? [])
      .map(Number)
      .filter((n) => inventory.has(n) && n !== issue.number)
      .sort((a, b) => a - b);
    const got = candidates
      .filter(([, d]) => d === issue.number)
      .map(([p]) => p)
      .sort((a, b) => a - b);
    assert.deepEqual(
      got,
      expectedInSet,
      `roadmap in-set for #${id}: expected ${JSON.stringify(expectedInSet)}, got ${JSON.stringify(got)}`,
    );
  }

  // #900 → #899 in-set; #662 external (not a textual candidate in this inventory).
  assert.ok(candidates.some(([p, d]) => p === 899 && d === 900));
  assert.ok(!candidates.some(([p, d]) => p === 662 && d === 900));
});
