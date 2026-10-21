import { test } from "node:test";
import assert from "node:assert/strict";
import { failedLooksCheck, sleepCheck } from "../src/doctor.ts";
import type { HeartbeatRow } from "../src/heartbeat/rows.ts";

// `npm run doctor`: "laptop can sleep" (battery power) and the heartbeat's own failed looks of the last 6 hours. Only reads; nothing changes a system setting.

type Seen = [boolean | "warn", string, string];
const collect = () => {
  const seen: Seen[] = [];
  return { seen, line: ((ok: boolean | "warn", name: string, detail = "") => void seen.push([ok, name, detail])) as never };
};
const BATT = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t87%; discharging; 5:12 remaining present: true\n";
const AC = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t100%; charged; 0:00 remaining present: true\n";
const DESKTOP = "Now drawing from 'AC Power'\n";
const SLEEP_ON = "System-wide power settings:\n SleepDisabled\t\t0\n";
const SLEEP_OFF = "System-wide power settings:\n SleepDisabled\t\t1\n";
const pmset = (batt: string | undefined, all = SLEEP_ON) => (args: string[]) => (args.join(" ") === "-g batt" ? batt : args.join(" ") === "-g" ? all : undefined);

test("laptop can sleep: a warning on battery power, with the way out; fine on power, on a desktop, or with sleep switched off", () => {
  const warn = collect();
  sleepCheck(warn.line, pmset(BATT));
  assert.equal(warn.seen.length, 1);
  assert.equal(warn.seen[0]![0], "warn");
  assert.equal(warn.seen[0]![1], "laptop can sleep");
  assert.match(warn.seen[0]![2], /on battery power: the Mac sleeps when the lid is closed .*caffeinate.*docs\/SETUP\.md "Keep it running"/);

  for (const [name, p, ok, text] of [
    ["on power", pmset(AC), true, /on power; closing the lid still sleeps it/],
    ["a desktop", pmset(DESKTOP), true, /no battery/],
    ["battery with sleep off", pmset(BATT, SLEEP_OFF), true, /sleep switched off/],
    ["power with sleep off", pmset(AC, SLEEP_OFF), true, /on power, sleep switched off/],
  ] as const) {
    const c = collect();
    sleepCheck(c.line, p);
    assert.deepEqual([c.seen[0]![0], c.seen.length], [ok, 1], name);
    assert.match(c.seen[0]![2], text, name);
  }
  const none = collect();
  sleepCheck(none.line, pmset(undefined)); // not a Mac
  assert.deepEqual(none.seen, []);
});

const AT = new Date("2026-10-21T12:00:00Z");
const row = (hoursAgo: number, outcome: HeartbeatRow["outcome"]): HeartbeatRow => ({ at: new Date(AT.getTime() - hoursAgo * 3600_000).toISOString(), kind: "owner", night: false, message: false, nextCheckMinutes: 30, costUsd: 0, toolCalls: 0, archived: 0, delegations: 0, outcome });

test("failing looks: a warning from three failed or timed-out rows in the last 6 hours, with the likely causes in one sentence; older rows and good ones do not count", () => {
  const bad = collect();
  failedLooksCheck(bad.line, [row(7, "failed"), row(5, "failed"), row(4, "timeout"), row(3, "timeout"), row(1, "silent"), row(0.5, "posted")], AT);
  assert.deepEqual(bad.seen.map((s) => [s[0], s[1]]), [["warn", "looks failing in the last 6 hours"]]);
  assert.equal(bad.seen[0]![2], '3 of 5 look(s) failed or timed out (2 timed out); likely causes: the Mac sleeping, no network, or the usage limit (npm run heartbeat-report; docs/SETUP.md "Keep it running")');
  const ok = collect();
  failedLooksCheck(ok.line, [row(5, "failed"), row(4, "timeout"), row(1, "silent"), row(8, "failed"), row(9, "failed")], AT);
  assert.deepEqual(ok.seen, [[true, "looks failing in the last 6 hours", "2 of 3 look(s) failed"]]);
  const none = collect();
  failedLooksCheck(none.line, [], AT);
  assert.deepEqual(none.seen, [[true, "looks failing in the last 6 hours", "0 of 0 look(s) failed"]]);
});
