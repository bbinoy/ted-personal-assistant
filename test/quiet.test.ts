import { test } from "node:test";
import assert from "node:assert/strict";
import { owner } from "../src/conversation/conversationmodel.ts";
import { commandReply, parseCommand, statusText } from "../src/conversation/ownercommands.ts";
import { parseUntil, untilOn, untilWords } from "../src/core/until.ts";
import { clearQuiet, isQuiet, quietText, quietValue, setQuiet } from "../src/conversation/quiet.ts";
import { settings } from "../src/core/settings.ts";
import { clearPause, isPaused } from "../src/core/pause.ts";
import { systemZone } from "../src/core/timezone.ts";
import { heldWaiting, resetHeld, submitPost, takeHeld } from "../src/heartbeat/notices.ts";
import { friendConvId, groupConvId, OWNER_CONV } from "../src/core/convpaths.ts";
import { addTenant, ensureOwner } from "../src/tenants/tenants.ts";

// A friend is a registered person: what her chat may do comes from her capabilities (policy/capabilities.ts), not from a label on the conversation.
ensureOwner({ number: "+15555550114" });
const friend = addTenant({ aci: "11111111-2222-4333-8444-666666666666", name: "Xia" })!;
const friendConv = { kind: "tenant", key: `tenant:${friend.id}`, convId: friendConvId(friend.id), tenantId: friend.id } as const;


const s = settings as unknown as Record<string, unknown>;
s.quietStartHour = 22;
s.quietEndHour = 7;
s.maxUnpromptedPerDay = 6;

const NOW = new Date(2026, 9, 14, 14, 30, 20); // 14:30 local
const ownerConv = { kind: "owner", key: "owner", convId: OWNER_CONV } as const;
const groupConv = { kind: "group", key: "g", convId: groupConvId("g") } as const;
const clean = () => {
  clearQuiet(ownerConv);
  resetHeld(owner());
  clearPause();
};
const Z = systemZone(); // the machine's zone: NOW is local time

test("parseQuiet: a span, a clock time (today's or tomorrow's), bare /quiet, /unquiet, usage, and nothing inside a sentence", () => {
  const two = parseCommand("/quiet 2h", NOW);
  assert.equal(two?.kind === "quiet" && two.until, new Date(NOW.getTime() + 2 * 3_600_000).toISOString());
  assert.match(two?.kind === "quiet" ? two.text : "", /^Quiet until 16:30\..*urgent.*\/unquiet to undo\.$/);
  const eve = parseCommand("/Quiet  until 18:00", NOW);
  assert.equal(eve?.kind === "quiet" && new Date(eve.until).getTime(), new Date(2026, 9, 14, 18, 0, 0).getTime());
  const next = parseCommand("/quiet until 9", NOW);
  assert.equal(next?.kind === "quiet" && new Date(next.until).getTime(), new Date(2026, 9, 15, 9, 0, 0).getTime(), "9:00 has passed: tomorrow");
  assert.match(next?.kind === "quiet" ? next.text : "", /09:00 tomorrow/);
  const bare = parseCommand("/quiet", NOW);
  assert.equal(bare?.kind === "quiet" && bare.until, "");
  assert.match(bare?.kind === "quiet" ? bare.text : "", /until you say \/unquiet/);
  assert.deepEqual(parseCommand("/unquiet", NOW), { kind: "unquiet" });
  for (const bad of ["/quiet soon", "/quiet 0h", "/quiet 2x", "/quiet until 25:00", "/quiet until 2026-12-24"]) assert.deepEqual(parseCommand(bad, NOW), { kind: "quiet-usage" }, bad);
  for (const t of ["quiet", "please /quiet", "/quiet! now", "/quietly", "/unquiet 2h", "be quiet"]) assert.equal(parseCommand(t, NOW), undefined, t);
});

test("the zone counts: 'until 18:00' is 18:00 in the zone given", () => {
  const berlin = parseCommand("/quiet until 18:00", new Date(Date.UTC(2026, 9, 14, 12, 0)), "Europe/Berlin"); // 14:00 CEST
  assert.equal(berlin?.kind === "quiet" && berlin.until, new Date(Date.UTC(2026, 9, 14, 16, 0)).toISOString());
});

test("/pause and /quiet parse and format through the one until function (core/until.ts)", () => {
  for (const arg of [undefined, "2h", "30m", "1d", "until 18:00", "until 9", "soon", "0h", "until 25:00", "2026-12-24"]) {
    const r = parseUntil(arg, NOW, Z);
    for (const kind of ["pause", "quiet"] as const) {
      const c = parseCommand(arg === undefined ? `/${kind}` : `/${kind} ${arg}`, NOW, Z);
      if (r === "usage") assert.deepEqual(c, { kind: `${kind}-usage` }, `${kind} ${arg}`);
      else assert.ok(c?.kind === kind && c.until === r.until && c.text.includes(r.when), `${kind} ${arg}`);
    }
  }
  assert.equal(untilWords("", Z), "until you switch it off");
  assert.equal(untilWords(new Date(2026, 9, 14, 16, 30).toISOString(), Z), "until 16:30");
});

test("untilOn: no value is off, '' is until switched off, a time is until then; a value nobody can read follows the switch (pause: on, quiet: off)", () => {
  assert.equal(untilOn(undefined, NOW, true), false);
  assert.equal(untilOn("", NOW, false), true);
  assert.equal(untilOn(new Date(NOW.getTime() + 60_000).toISOString(), NOW, false), true);
  assert.equal(untilOn(new Date(NOW.getTime() - 60_000).toISOString(), NOW, true), false);
  assert.equal(untilOn("garbage", NOW, false), false);
  assert.equal(untilOn("garbage", NOW, true), true);
  assert.equal(untilOn(42, NOW, true), true);
});

test("/quiet and /unquiet: the owner's chat, a friend's own chat and a group (each its own); /quiet leaves /pause alone", () => {
  clean();
  const set: string[] = [];
  const deps = { now: () => NOW, setQuiet: (c: { key: string }, u: string) => void set.push(`${c.key}:${u}`), clearQuiet: (c: { key: string }) => void set.push(`${c.key}:cleared`) };
  assert.match(commandReply(ownerConv, "/quiet 2h", deps)!, /^Quiet until 16:30\./);
  assert.match(commandReply(friendConv, "/quiet", deps)!, /until you say \/unquiet/);
  assert.match(commandReply(friendConv, "/unquiet", deps)!, /^Back to normal/);
  assert.match(commandReply(groupConv, "/quiet 2h", deps)!, /^Quiet until 16:30\./);
  assert.match(commandReply(groupConv, "/unquiet", deps)!, /^Back to normal/);
  assert.match(commandReply(ownerConv, "/quiet banana", deps)!, /\/quiet 2h.*\/unquiet/);
  assert.match(commandReply(friendConv, "/quiet banana", deps)!, /\/unquiet/);
  assert.deepEqual(set, [`owner:${new Date(NOW.getTime() + 7_200_000).toISOString()}`, `tenant:${friend.id}:`, `tenant:${friend.id}:cleared`, `g:${new Date(NOW.getTime() + 7_200_000).toISOString()}`, "g:cleared"]);
  assert.equal(commandReply(friendConv, "/pause 2h", deps), undefined, "pause stays the owner's");
  assert.equal(isPaused(NOW), false);
});

test("the switch is a file per conversation: set, read, expire, clear; /status shows it", () => {
  clean();
  assert.equal(commandReply(ownerConv, "/quiet 2h", { now: () => NOW }) !== undefined, true);
  assert.equal(isQuiet(ownerConv, NOW), true);
  assert.equal(isQuiet(ownerConv, new Date(NOW.getTime() + 2 * 3_600_000 + 60_000)), false, "the time has come");
  assert.equal(quietText(ownerConv, NOW, Z), "quiet until 16:30");
  assert.match(statusText({ quiet: "quiet until 16:30", spentUsd: 0, limitUsd: 20, approvals: 0, down: [] }), /Running \(not paused\)\.\nQuiet: quiet until 16:30 \(held items are looked at again when it ends\)\.\nBudget/);
  assert.doesNotMatch(statusText({ spentUsd: 0, limitUsd: 20, approvals: 0, down: [] }), /Quiet/);
  commandReply(ownerConv, "/quiet", { now: () => NOW });
  assert.equal(quietValue(ownerConv), "");
  assert.equal(quietText(ownerConv, NOW), "quiet until you switch it off");
  assert.match(commandReply(ownerConv, "/unquiet", { now: () => NOW })!, /^Back to normal/);
  assert.equal(quietValue(ownerConv), undefined);
  clean();
});

test("while quiet: unprompted posts are held (urgent goes), the heartbeat's cap is untouched, and when quiet ends the look is due and gets them all", () => {
  clean();
  const c = owner();
  setQuiet(ownerConv, new Date(NOW.getTime() + 2 * 3_600_000).toISOString());
  assert.equal(submitPost(c, "mail from the bank about your card", false, NOW), "held", "14:30 is no quiet hour: /quiet holds");
  assert.equal(submitPost(c, "the dentist moved to Friday?", false, NOW), "held");
  assert.equal(submitPost(c, "fire at the neighbours", true, NOW), "post", "urgent goes");
  assert.equal(heldWaiting(c, new Date(NOW.getTime() + 3_600_000)), false, "still quiet an hour later");
  const after = new Date(NOW.getTime() + 2 * 3_600_000 + 60_000);
  assert.equal(heldWaiting(c, after), true, "quiet is over: the look is due");
  const taken = takeHeld(c, after);
  assert.deepEqual(taken.held.map((h) => h.text), ["the dentist moved to Friday?", "mail from the bank about your card"]);
  taken.done();
  // /unquiet ends it at once
  setQuiet(ownerConv, "");
  assert.equal(submitPost(c, "later news", false, NOW), "held");
  clearQuiet(ownerConv);
  assert.deepEqual(takeHeld(c, NOW).held.map((h) => h.text), ["later news"]);
  clean();
});
