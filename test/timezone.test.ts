import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A conversation's own clock (src/timezone.ts): the pure helpers, the friend's tenant.json setting and the places that read it (the clock line, the heartbeat
// instruction, the day a note expires on). The default is the owner's, the Mac's.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "timezone-test-"));

const Z = await import("../src/timezone.ts");
const { clockLine } = await import("../src/brief.ts");
const { lastLookText, lookInstruction, lookPrompt } = await import("../src/heartbeat/look.ts");
const { lookerOf } = await import("../src/heartbeat/scope.ts");
const { readNotes } = await import("../src/notes.ts");
const { localDay } = await import("../src/pause.ts");
const T = await import("../src/tenants/tenants.ts");
const { group, owner, tenant, zoneOf } = await import("../src/conversationmodel.ts");
const { describeTenants } = await import("../src/tenants/tenanttools.ts");

// 23:30 UTC on 20 October 2026: still Tuesday in New York (19:30), already Wednesday in Lisbon (00:30, summer time until the 25th) and Auckland (12:30).
const AT = new Date("2026-10-20T23:30:00Z");

test("clockIn: the same instant is a different day and hour in each zone, to the minute", () => {
  assert.deepEqual([Z.dayIn(AT, "America/New_York"), Z.timeIn(AT, "America/New_York")], ["2026-10-20", "19:30"]);
  assert.deepEqual([Z.dayIn(AT, "Europe/Lisbon"), Z.timeIn(AT, "Europe/Lisbon")], ["2026-10-21", "00:30"]);
  assert.deepEqual([Z.dayIn(AT, "Pacific/Auckland"), Z.timeIn(AT, "Pacific/Auckland")], ["2026-10-21", "12:30"]);
  assert.equal(Z.clockIn(AT, "Europe/Lisbon").weekday, 3, "Wednesday");
  assert.equal(Z.clockIn(AT, "America/New_York").weekday, 2, "Tuesday");
  assert.deepEqual(Z.dayAt(AT, 1, "Europe/Lisbon"), { weekday: 4, date: "2026-10-22" });
  assert.deepEqual(Z.dayAt(new Date("2026-12-31T12:00:00Z"), 1, "UTC"), { weekday: 5, date: "2027-01-01" }, "year rollover");
});

test("clockIn: midnight is hour 0, not 24, and a clock change does not move the calendar", () => {
  assert.equal(Z.clockIn(new Date("2026-10-21T00:05:00Z"), "UTC").hour, 0);
  assert.equal(Z.dayAt(new Date("2026-10-24T23:30:00Z"), 1, "Europe/Lisbon").date, "2026-10-26"); // 00:30 on the 25th, the day the clocks go back: +1 is the 26th
  assert.equal(Z.dayAt(new Date("2026-10-24T12:00:00Z"), 1, "Europe/Lisbon").date, "2026-10-25");
});

test("isZone: only a zone the runtime knows", () => {
  assert.ok(Z.isZone("Europe/Lisbon") && Z.isZone("UTC"));
  assert.ok(!Z.isZone("Mars/Olympus") && !Z.isZone("") && !Z.isZone(undefined) && !Z.isZone(7) && !Z.isZone("x".repeat(80)));
});

test("quiet hours are the conversation's own: 23:30 in the owner's zone is noon elsewhere", () => {
  assert.equal(Z.inQuietHours(AT, 22, 7, "America/New_York"), false); // 19:30
  assert.equal(Z.inQuietHours(AT, 22, 7, "Europe/Lisbon"), true); // 00:30
  assert.equal(Z.inQuietHours(AT, 22, 7, "Pacific/Auckland"), false); // 12:30
  const at = (h: number) => new Date(Date.UTC(2026, 9, 12, h, 30));
  assert.deepEqual([23, 3, 7, 12, 22].map((h) => Z.inQuietHours(at(h), 22, 7, "UTC")), [true, true, false, false, true], "wraps midnight");
  assert.deepEqual([3, 6].map((h) => Z.inQuietHours(at(h), 1, 5, "UTC")), [true, false], "a same-day window");
});

test("the clock line and the heartbeat instruction carry the conversation's zone, not the Mac's", () => {
  const line = clockLine(AT, "Europe/Lisbon");
  assert.match(line, /it is now Wednesday 2026-10-21 00:30 \(Europe\/Lisbon\)/);
  assert.match(line, /Yesterday was Tuesday 2026-10-20\. Tomorrow is Thursday 2026-10-22\. The day after is Friday 2026-10-23/);
  assert.match(clockLine(AT, "America/New_York"), /it is now Tuesday 2026-10-20 19:30 \(America\/New_York\)/);

  const text = lookInstruction(AT, "2026-10-20T20:00:00Z", { ...lookerOf(owner()), zone: "Pacific/Auckland" }); // 09:00 the same day, there
  assert.match(text, /It is Wednesday 2026-10-21 12:30 \(Pacific\/Auckland,/);
  assert.match(text, /Your last look was at 09:00\./);
  assert.match(lookPrompt(AT, text, [], "Pacific/Auckland"), /^CURRENT TIME: it is now Wednesday 2026-10-21 12:30 \(Pacific\/Auckland\)/);
  assert.match(lastLookText("2026-10-19T20:00:00Z", AT, "Pacific/Auckland"), /an earlier day/);
  assert.doesNotMatch(lastLookText("2026-10-20T20:00:00Z", AT, "Pacific/Auckland"), /an earlier day/);
});

test("a note's expiry day is the conversation's own day: the status note of 'today' in Lisbon is gone in New York's evening", () => {
  const dir = mkdtempSync(join(tmpdir(), "tz-notes-"));
  writeFileSync(join(dir, "context-trip.md"), "---\nexpires: 2026-10-20\n---\nTrip until today\n");
  assert.deepEqual(readNotes(AT, dir, "America/New_York").map((n) => n.file), ["context-trip.md"], "still the 20th in New York");
  assert.deepEqual(readNotes(AT, dir, "Europe/Lisbon"), [], "already the 21st in Lisbon");
  assert.equal(localDay(AT, "Europe/Lisbon"), "2026-10-21");
  assert.equal(localDay(new Date(2026, 0, 5, 0, 0)), "2026-01-05", "no zone: the Mac's day, as before");
});

test("a friend's time zone lives in her tenant.json; a group and the owner have the Mac's", () => {
  const made = T.mintInvite("zone")!;
  const rec = T.redeemInvite(made.code, { aci: "00000000-0000-4000-8000-0000000000aa", name: "Ana" })!;
  const ctx = T.tenantContext(rec);
  assert.equal(zoneOf(tenant(rec.id)), Z.systemZone(), "migration-free: nothing set means the owner's zone");
  assert.equal(zoneOf(owner()), Z.systemZone());
  assert.equal(zoneOf(group("g-zone")), Z.systemZone());

  writeFileSync(ctx.configFile, JSON.stringify({ language: "Portuguese", dailyBudgetUsd: 3 }));
  assert.equal(T.setTimeZone(rec.id, "Europe/Lisbon")?.id, rec.id);
  assert.equal(zoneOf(tenant(rec.id)), "Europe/Lisbon");
  const stored = JSON.parse(readFileSync(ctx.configFile, "utf8"));
  assert.deepEqual(stored, { language: "Portuguese", dailyBudgetUsd: 3, timeZone: "Europe/Lisbon" }, "the other overrides are kept");
  assert.ok(describeTenants().some((l) => l.startsWith(rec.id) && l.includes("time zone Europe/Lisbon")));

  assert.throws(() => T.setTimeZone(rec.id, "Mars/Olympus"), /not a time zone/);
  assert.equal(zoneOf(tenant(rec.id)), "Europe/Lisbon", "a bad value changes nothing");
  assert.equal(T.setTimeZone("owner", "Europe/Lisbon"), undefined, "the owner's record has none: the Mac's is hers");
  assert.equal(T.setTimeZone("nobody", "UTC"), undefined);

  T.setTimeZone(rec.id, undefined);
  assert.equal(zoneOf(tenant(rec.id)), Z.systemZone());
  assert.deepEqual(JSON.parse(readFileSync(ctx.configFile, "utf8")), { language: "Portuguese", dailyBudgetUsd: 3 });

  writeFileSync(ctx.configFile, JSON.stringify({ timeZone: "Not/AZone" }));
  assert.equal(zoneOf(tenant(rec.id)), Z.systemZone(), "a damaged value falls back to the owner's zone instead of failing the look");
});
