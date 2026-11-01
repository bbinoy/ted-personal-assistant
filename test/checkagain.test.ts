import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// check_again (ledger.ts pullLook): any run pulls the conversation's next look forward, with a reason the look is told. Real log files in a temporary folder.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "checkagain-"));

const { pullLook, lookState, lookWhy, recordWake } = await import("../src/conversation/ledger.ts");
const { ledgerEntries } = await import("../src/core/messages.ts");
const { convIdOfKey, convPaths } = await import("../src/core/convpaths.ts");
const { recordMessage } = await import("../src/core/messages.ts");

const T0 = new Date("2026-10-20T09:00:00Z");
const min = (m: number) => new Date(T0.getTime() + m * 60_000);
const KEYS: Record<string, string> = { owner: "owner", group: "g-check-again", friend: "tenant:friend1" };

function book(key: string, nextInMin: number) {
  const file = convPaths(convIdOfKey(KEYS[key])).messages;
  recordWake({ record: (_c, kind, _ts, text) => recordMessage(kind, T0.getTime(), text, T0, file) }, {} as never, nextInMin, T0, (m) => Number(m));
  return () => lookState(ledgerEntries(file));
}

for (const key of ["owner", "group", "friend"]) {
  test(`check_again (${key}): earlier than booked books now+m with the reason, and the look is told it`, () => {
    const state = book(key, 60);
    assert.match(pullLook(KEYS[key], 10, "  Anna's reply \n to the invite ", T0), /^Booked/);
    const st = state();
    assert.equal(st.wake?.next, min(10).toISOString());
    assert.equal(st.wake?.why, "Anna's reply to the invite");
    assert.equal(lookWhy(st, min(9)), undefined);
    assert.equal(lookWhy(st, min(10)), "You asked to check again: Anna's reply to the invite");
  });
}

test("check_again: later than booked changes nothing; below 2 minutes is 2; above 120 is 120", () => {
  const state = book("owner", 30);
  const before = state().wake;
  assert.match(pullLook("owner", 45, "later", T0), /^No change/);
  assert.deepEqual(state().wake, before);
  assert.match(pullLook("owner", 1, "soon", T0), /^Booked/);
  assert.equal(state().wake?.next, min(2).toISOString());
  const far = book("group", 500);
  pullLook(KEYS.group, 9999, "far", T0);
  assert.equal(far().wake?.next, min(120).toISOString());
});

test("check_again: at most 4 pulls an hour per conversation; an hour later it works again", () => {
  KEYS.capped = "tenant:friend2";
  const state = book("capped", 120);
  for (const m of [10, 9, 8, 7]) assert.match(pullLook(KEYS.capped, m, "x", T0), /^Booked/, `pull to ${m}`);
  assert.match(pullLook(KEYS.capped, 3, "x", T0), /^Not booked: you already pulled/);
  assert.equal(state().wake?.next, min(7).toISOString());
  const file = convPaths(convIdOfKey(KEYS.capped)).messages;
  recordMessage("wake", min(61).getTime(), JSON.stringify({ next: min(181).toISOString(), looked: min(61).toISOString() }), min(61), file); // a look booked its next one
  assert.match(pullLook(KEYS.capped, 3, "later", min(62)), /^Booked/);
});
