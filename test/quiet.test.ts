import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { owner } from "../src/conversation/conversationmodel.ts";
import { commandReply, parseCommand, parseQuiet, statusText, untilTime } from "../src/conversation/ownercommands.ts";
import { clearQuiet, isQuiet, quietOn, quietText, quietValue, setQuiet } from "../src/conversation/quiet.ts";
import { settings } from "../src/core/settings.ts";
import { dataPath } from "../src/core/state.ts";
import { isPaused } from "../src/core/pause.ts";
import { resetHeld, noticeOwner, ownerNotices, releaseHeld, submitPost } from "../src/heartbeat/notices.ts";
import { groupConvId, instancePaths, OWNER_CONV } from "../src/core/convpaths.ts";

const s = settings as unknown as Record<string, unknown>;
s.quietStartHour = 22;
s.quietEndHour = 7;
s.maxUnpromptedPerDay = 6;
s.digestMinutes = [12 * 60 + 30, 18 * 60 + 30];
s.digestMaxItems = 8;

const NOW = new Date(2026, 9, 14, 14, 30, 20); // 14:30 local
const ownerConv = { kind: "owner", key: "owner", convId: OWNER_CONV } as const;
const friendConv = { kind: "tenant", key: "tenant:x", convId: "friend-x" } as const;
const groupConv = { kind: "group", key: "g", convId: groupConvId("g") } as const;
const clean = () => {
  clearQuiet(ownerConv);
  resetHeld(owner());
  rmSync(dataPath(instancePaths().paused), { force: true });
};
const Z = "UTC";

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
  assert.equal(parseQuiet("/status", NOW, Z), undefined);
  assert.notEqual(untilTime("2h", NOW, Z), "usage");
});

test("the zone counts: 'until 18:00' is 18:00 in the zone given", () => {
  const berlin = parseQuiet("/quiet until 18:00", new Date(Date.UTC(2026, 9, 14, 12, 0)), "Europe/Berlin"); // 14:00 CEST
  assert.equal(berlin?.kind === "quiet" && berlin.until, new Date(Date.UTC(2026, 9, 14, 16, 0)).toISOString());
});

test("quietOn: no file is not quiet, '' is until /unquiet, a time is until then, a time nobody can read is not quiet", () => {
  assert.equal(quietOn(undefined, NOW), false);
  assert.equal(quietOn("", NOW), true);
  assert.equal(quietOn(new Date(NOW.getTime() + 60_000).toISOString(), NOW), true);
  assert.equal(quietOn(new Date(NOW.getTime() - 60_000).toISOString(), NOW), false);
  assert.equal(quietOn("garbage", NOW), false);
});

test("/quiet and /unquiet: the owner's chat and a friend's own chat, never a group; /quiet leaves /pause alone", () => {
  clean();
  const set: string[] = [];
  const deps = { now: () => NOW, setQuiet: (c: { key: string }, u: string) => void set.push(`${c.key}:${u}`), clearQuiet: (c: { key: string }) => void set.push(`${c.key}:cleared`) };
  assert.match(commandReply(ownerConv, "/quiet 2h", deps)!, /^Quiet until 16:30\./);
  assert.match(commandReply(friendConv, "/quiet", deps)!, /until you say \/unquiet/);
  assert.match(commandReply(friendConv, "/unquiet", deps)!, /^Back to normal/);
  assert.equal(commandReply(groupConv, "/quiet 2h", deps), undefined);
  assert.equal(commandReply(groupConv, "/unquiet", deps), undefined);
  assert.match(commandReply(ownerConv, "/quiet banana", deps)!, /\/quiet 2h.*\/unquiet/);
  assert.match(commandReply(friendConv, "/quiet banana", deps)!, /\/unquiet/);
  assert.deepEqual(set, [`owner:${new Date(NOW.getTime() + 7_200_000).toISOString()}`, "tenant:x:", "tenant:x:cleared"]);
  assert.equal(commandReply(friendConv, "/pause 2h", deps), undefined, "pause stays the owner's");
  assert.equal(isPaused(NOW), false);
});

test("the switch is a file per conversation: set, read, expire, clear; /status shows it", () => {
  clean();
  assert.equal(commandReply(ownerConv, "/quiet 2h", { now: () => NOW }) !== undefined, true);
  assert.equal(isQuiet(ownerConv, NOW), true);
  assert.equal(isQuiet(ownerConv, new Date(NOW.getTime() + 2 * 3_600_000 + 60_000)), false, "the time has come");
  assert.equal(quietText(ownerConv, NOW, Z), "quiet until 16:30");
  assert.match(statusText({ quiet: "quiet until 16:30", spentUsd: 0, limitUsd: 20, approvals: 0, down: [] }), /Running \(not paused\)\.\nQuiet: quiet until 16:30 \(held items go out in the digest\)\.\nBudget/);
  assert.doesNotMatch(statusText({ spentUsd: 0, limitUsd: 20, approvals: 0, down: [] }), /Quiet/);
  commandReply(ownerConv, "/quiet", { now: () => NOW });
  assert.equal(quietValue(ownerConv), "");
  assert.equal(quietText(ownerConv, NOW), "quiet until you say /unquiet");
  assert.match(commandReply(ownerConv, "/unquiet", { now: () => NOW })!, /^Back to normal/);
  assert.equal(quietValue(ownerConv), undefined);
  clean();
});

test("while quiet: unprompted posts and notices are held (urgent goes), the heartbeat's cap is untouched, and the digest goes out when quiet ends", async () => {
  clean();
  const c = owner();
  const told: string[] = [];
  ownerNotices.sendTo((t) => told.push(t));
  setQuiet(ownerConv, new Date(NOW.getTime() + 2 * 3_600_000).toISOString());
  assert.equal(submitPost(c, "mail from the bank about your card", false, NOW), "held", "14:30 is no quiet hour: /quiet holds");
  assert.equal(submitPost(c, "the dentist moved to Friday?", false, NOW), "held");
  assert.equal(submitPost(c, "fire at the neighbours", true, NOW), "post", "urgent goes");
  noticeOwner("My login expired. On the Mac, run `claude auth login`.", NOW);
  assert.deepEqual(told, [], "the notice is held too");
  noticeOwner("urgent notice", NOW, { urgent: true });
  assert.deepEqual(told, ["urgent notice"]);
  const sent: string[] = [];
  const pipeline = { enqueue: <T>(_c: unknown, job: () => Promise<T>) => job(), runTurn: async (_c: unknown, t: any) => (sent.push((await t.run()).text), { spoke: true }) } as any;
  assert.equal(await releaseHeld(pipeline, c, new Date(NOW.getTime() + 3_600_000)), false, "still quiet an hour later");
  const after = new Date(NOW.getTime() + 2 * 3_600_000 + 60_000);
  assert.equal(await releaseHeld(pipeline, c, after), true, "quiet is over: one digest");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /^A few things I held back:\nNeeds you\n- the dentist moved to Friday\?\nFYI\n- mail from the bank about your card\nSystem\n- My login expired/);
  // /unquiet ends it at once
  setQuiet(ownerConv, "");
  assert.equal(submitPost(c, "later news", false, NOW), "held");
  clearQuiet(ownerConv);
  assert.equal(await releaseHeld(pipeline, c, NOW), true);
  assert.equal(sent[1], "later news");
  ownerNotices.sendTo(undefined);
  clean();
});
