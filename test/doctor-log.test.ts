import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slowestStepsCheck, toolsMissingCheck } from "../src/doctor.ts";

// `npm run doctor`: two lines read from logs/agent.log: tools that were not available (24 h) and the slowest steps (7 days). Log lines carry a time but no date (logwindow.ts).

type Seen = [boolean | "warn", string, string];
const collect = () => {
  const seen: Seen[] = [];
  return { seen, line: ((ok: boolean | "warn", name: string, detail = "") => void seen.push([ok, name, detail])) as never };
};
const write = (lines: string[]): string => {
  const f = join(mkdtempSync(join(tmpdir(), "doctor-log-")), "agent.log");
  writeFileSync(f, lines.join("\n") + "\n");
  return readFileSync(f, "utf8");
};
const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime();
const ago = (h: number) => new Date(NOW - h * 3600_000).toTimeString().slice(0, 8) + ".000";

test("tools not available: ok at none; a warning naming the tools (names only) for the last 24 hours, older lines not counted", () => {
  const a = collect();
  toolsMissingCheck(a.line, write([`${ago(1)} INF run: ok`]), NOW, NOW);
  assert.deepEqual(a.seen.map((s) => s[0]), [true]);
  const b = collect();
  toolsMissingCheck(b.line, write([`${ago(4)} ERR run: tool not available: mcp__c__d`, `${ago(3)} ERR run: tool not available: mcp__a__b`, `${ago(2)} ERR run: tool not available: mcp__a__b`, `${ago(1)} x`]), NOW, NOW);
  assert.equal(b.seen[0]![0], "warn");
  assert.match(b.seen[0]![2], /3 call\(s\).*mcp__a__b x2, mcp__c__d x1/);
});

test("slowest steps: owner median and slowest, slowest judge task, share cold; ok unless the median owner turn is over a minute", () => {
  const c = collect();
  slowestStepsCheck(c.line, write([
    `${ago(5)} timing owner settle=1 first=2 run=3 total=4000`,
    `${ago(4)} timing owner settle=1 first=2 run=3 total=9000`,
    `${ago(3)} timing owner settle=1 first=2 run=3 total=6000`,
    `${ago(3)} timing judge approve cold prompt=10 init=5 total=1200`,
    `${ago(2)} timing judge approve warm prompt=10 init=5 total=800`,
    `${ago(2)} timing judge sweep warm prompt=10 init=5 total=3000`,
    `${ago(1)} timing judge approve warm prompt=10 total=700`,
    `${ago(1)} timing gate warm prompt=1 total=99999`,
  ]), NOW, NOW);
  assert.deepEqual(c.seen, [[true, "slowest steps (7 days)", "owner turns (3): median 6000 ms, slowest 9000 ms; judge (4 calls): slowest sweep 3000 ms, 25% cold"]]);
  const d = collect();
  slowestStepsCheck(d.line, write([`${ago(1)} timing owner run=1 total=70000`]), NOW, NOW);
  assert.equal(d.seen[0]![0], "warn");
  const e = collect();
  slowestStepsCheck(e.line, write(["x"]), NOW, NOW);
  assert.deepEqual(e.seen, [[true, "slowest steps (7 days)", "no timing lines yet"]]);
});
