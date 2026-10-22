import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Task suggestions and the task tools in chat (src/tasks/suggest.ts, src/conversation/taskreplies.ts): one message per look, a 👍 or a quoted "1 yes" answers it, expiry keeps the history,
// the cap per look, a group's "remind me" line once per member, a friend's own list, and one conversation never answering for another.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "suggest-test-"));

const S = await import("../src/tasks/store.ts");
const G = await import("../src/tasks/suggest.ts");
const { createTasksServer } = await import("../src/modules/tasks/tasktools.ts");
const R = await import("../src/conversation/taskreplies.ts");
const { taskReaction, taskReply } = R;
const { settings } = await import("../src/core/settings.ts");
const { peekConvDb } = await import("../src/core/convdb.ts");
const { convIdOfKey } = await import("../src/core/convpaths.ts");
const { setAsking } = await import("../src/modules/voice/voicenote.ts");
const { chatSystem, groupSystem, tenantSystem, heartbeatInstruction } = await import("../src/run/persona.ts");
const { groupCapabilities } = await import("../src/policy/capabilities.ts");

const ZONE = "Europe/Berlin";
const NOW = Date.parse("2026-10-22T10:00:00Z"); // Thu 22 Oct 12:00 in Berlin
let n = 0;
const fresh = () => `suggest-conv-${++n}`;
type Tools = Record<string, { handler: (a: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }>;
const tools = (key: string, o: { unattended?: boolean } = {}) => (createTasksServer({ key, source: o.unattended ? "background" : "group", unattended: !!o.unattended, zone: () => ZONE, now: () => NOW }) as unknown as { instance: { _registeredTools: Tools } }).instance._registeredTools;
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
const conv = (key: string, kind: "owner" | "group" | "tenant" = "group") => ({ kind, key, convId: convIdOfKey(key) }) as never;

// A runtime that records what would be sent, with a timestamp per message.
function runtime(o: { holding?: boolean } = {}) {
  const sent: string[] = [];
  let ts = 1_000;
  G.setSuggestRuntime({ send: async (_c, t) => (sent.push(t), (ts += 10)), holding: () => !!o.holding });
  return sent;
}
const said: string[] = [];
const answerer = (who?: string) => ({ say: async (t: string) => void said.push(t), who, zone: ZONE, now: NOW });
const suggest = async (key: string, ...titles: string[]) => {
  const bg = tools(key, { unattended: true });
  for (const [i, title] of titles.entries()) await bg.add_task!.handler({ title, source_kind: "mail", source_ref: `mail-${key}-${title}-${i}`, due: "2026-10-23" });
};
const status = (key: string, id: number) => S.getItem(key, id)!.status;

test("suggestions: a look's new suggestions go out as ONE numbered message, and are not offered twice", async () => {
  const sent = runtime();
  const k = fresh();
  await suggest(k, "Reply to Rebecca re budget", "Send Sam the deck");
  assert.equal(await G.offerSuggestions(conv(k, "owner"), new Date(NOW), ZONE), "sent");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /^💡 2 things I noticed \(mail\):\n1\. Reply to Rebecca re budget \(due Fri 23 Oct\)\n2\. Send Sam the deck \(due Fri 23 Oct\)\n\n👍 to add all, or reply '1 yes', '2 no'\.$/);
  assert.equal(await G.offerSuggestions(conv(k, "owner"), new Date(NOW), ZONE), "none", "listed once");
  await suggest(k, "Third thing");
  assert.equal(await G.offerSuggestions(conv(k, "owner"), new Date(NOW), ZONE), "sent");
  assert.match(sent[1]!, /^💡 One thing I noticed/, "only the new one");
});

test("suggestions: i_owe and owed_to_me lines say who owes whom; a group is told that anyone's 👍 counts", () => {
  const items = [
    { id: 1, kind: "owed_to_me", title: "the contract", person: "Sam", due: "2026-10-30", sourceKind: "mail" },
    { id: 2, kind: "i_owe", title: "the deck", person: "Sam", sourceKind: "mail" },
  ] as never;
  const m = G.suggestionMessage(items, NOW, ZONE, true);
  assert.match(m, /1\. the contract \(Sam owes you, due Fri 30 Oct\)\n2\. the deck \(you owe Sam\)/);
  assert.match(m, /👍 from anyone to add all/);
});

test("suggestions: a 👍 on the message adds all it listed, once", async () => {
  const sent = runtime();
  void sent;
  const k = fresh();
  await suggest(k, "A", "B");
  await G.offerSuggestions(conv(k), new Date(NOW), ZONE);
  said.length = 0;
  assert.equal(await taskReaction(conv(k), { emoji: "👍", targetTimestamp: 999 } as never, async () => {}), false, "another message");
  assert.equal(await taskReaction(conv(k), { emoji: "❤️", targetTimestamp: 1010 } as never, async () => {}), false, "not a thumb");
  assert.equal(await taskReaction(conv(k), { emoji: "👍", targetTimestamp: 1010, isRemove: true } as never, async () => {}), false, "taken away");
  assert.equal(await R.reactSuggestions(conv(k), { emoji: "👍", targetTimestamp: 1010 }, answerer("Mia")), true);
  assert.deepEqual([status(k, 1), status(k, 2)], ["open", "open"]);
  assert.match(said[0]!, /^✅ Added: A; B\.$/);
  const h = peekConvDb(convIdOfKey(k))!.all<{ by: string; action: string }>("SELECT by, action FROM task_events WHERE action = 'confirmed' ORDER BY id");
  assert.deepEqual(h.map((e) => e.by), ["Mia", "Mia"], "the history says who tapped");
  said.length = 0;
  assert.equal(await R.reactSuggestions(conv(k), { emoji: "👍", targetTimestamp: 1010 }, answerer()), true, "a second 👍 is not a chat turn");
  assert.deepEqual(said, []);
});

test("suggestions: a quoted reply confirms or drops the numbers named: all, some, none", async () => {
  runtime();
  const k = fresh();
  await suggest(k, "One", "Two", "Three");
  await G.offerSuggestions(conv(k), new Date(NOW), ZONE);
  const quote = { timestamp: 1010 };
  const reply = (t: string) => taskReply(conv(k), { text: t, quote, fromName: "Mia" } as never, async (x) => void said.push(x));
  said.length = 0;
  assert.equal(await reply("1 yes, 3 no"), true);
  assert.deepEqual([status(k, 1), status(k, 2), status(k, 3)], ["open", "suggested", "dropped"]);
  assert.match(said[0]!, /✅ Added: One\. Dropped: Three\./);
  assert.equal(S.eventsOf(k, 3).at(-1)!.action, "rejected");
  assert.equal(await reply("1 yes but make it friday"), false, "free words are an ordinary message");
  assert.equal(await reply("thanks"), false, "none of it: no suggestion changes");
  assert.equal(status(k, 2), "suggested");
  said.length = 0;
  assert.equal(await reply("5 yes"), true, "a number that is not listed gets a sentence, nothing is done");
  assert.match(said[0]!, /There is no #5/);
  assert.equal(status(k, 2), "suggested");
  said.length = 0;
  assert.equal(await reply("all yes"), true);
  assert.deepEqual([status(k, 2), status(k, 3)], ["open", "dropped"], "the dropped one stays dropped; 1 was already open");
  assert.match(said[0]!, /#1, #3 were already handled/);
});

test("suggestions: a bare yes quoting the message means all of them; a bare no only a single suggestion", async () => {
  runtime();
  const k = fresh();
  await suggest(k, "X", "Y");
  await G.offerSuggestions(conv(k), new Date(NOW), ZONE);
  said.length = 0;
  const reply = (t: string, ts = 1010) => taskReply(conv(k), { text: t, quote: { timestamp: ts } } as never, async (x) => void said.push(x));
  assert.equal(await reply("no"), true);
  assert.match(said[0]!, /Which ones\?/);
  assert.equal(status(k, 1), "suggested");
  assert.equal(await reply("yes", 55), false, "quoting some other message answers nothing");
  assert.equal(await reply("yes"), true);
  assert.deepEqual([status(k, 1), status(k, 2)], ["open", "open"]);
  await suggest(k, "Z");
  await G.offerSuggestions(conv(k), new Date(NOW), ZONE);
  assert.equal(await reply("no", 1020), true);
  assert.equal(status(k, 3), "dropped");
});

test("suggestions: nobody answers: after SUGGESTION_DAYS they are dropped, rejected by expiry, never deleted; the same mail is not suggested again", async () => {
  runtime();
  const k = fresh();
  await suggest(k, "Old", "Fresh");
  const db = peekConvDb(convIdOfKey(k))!;
  db.run("UPDATE items SET created_at = ? WHERE id = 1", NOW - 8 * 86_400_000);
  assert.equal(G.expireSuggestions(k, NOW, ZONE), 1);
  assert.deepEqual([status(k, 1), status(k, 2)], ["dropped", "suggested"]);
  const last = S.eventsOf(k, 1).at(-1)!;
  assert.deepEqual([last.action, last.by], ["rejected", "expiry"]);
  assert.equal(db.num("SELECT COUNT(*) FROM items"), 2, "kept");
  const again = await tools(k, { unattended: true }).add_task!.handler({ title: "Old", source_kind: "mail", source_ref: `mail-${k}-Old-0` });
  assert.equal(again.isError, true, "the dedupe by source ref still holds");
  assert.equal(settings.suggestionDays, 7);
  // the look's hook does the same: an offer after the days also expires
  db.run("UPDATE items SET created_at = ? WHERE id = 2", NOW - 9 * 86_400_000);
  assert.equal(await G.offerSuggestions(conv(k), new Date(NOW), ZONE), "none");
  assert.equal(status(k, 2), "dropped");
});

test("suggestions: in quiet hours nothing is sent and the items stay unasked for the next look", async () => {
  const sent = runtime({ holding: true });
  const k = fresh();
  await suggest(k, "Night");
  assert.equal(await G.offerSuggestions(conv(k), new Date(NOW), ZONE), "held");
  assert.deepEqual(sent, []);
  assert.equal(G.unasked(k).length, 1);
  runtime({ holding: false });
  assert.equal(await G.offerSuggestions(conv(k), new Date(NOW), ZONE), "sent");
});

test("suggestions: at most SUGGESTIONS_PER_LOOK per look, enforced by the tool, and a new look starts again", async () => {
  const k = fresh();
  assert.equal(settings.suggestionsPerLook, 5);
  const was = settings.suggestionsPerLook;
  (settings as { suggestionsPerLook: number }).suggestionsPerLook = 2;
  try {
    const look1 = tools(k, { unattended: true });
    assert.equal((await look1.add_task!.handler({ title: "a1" })).isError, undefined);
    assert.equal((await look1.add_task!.handler({ title: "a2" })).isError, undefined);
    const third = await look1.add_task!.handler({ title: "a3" });
    assert.equal(third.isError, true);
    assert.match(text(third), /No more suggestions in this look \(2 at most\)/);
    assert.equal(S.listItems(k, { status: "suggested" }, NOW, ZONE).length, 2);
    assert.equal((await tools(k, { unattended: true }).add_task!.handler({ title: "a3" })).isError, undefined, "the next look");
    assert.equal((await look1.add_task!.handler({ title: "a1" })).isError, true, "a duplicate is not counted as an extra");
  } finally {
    (settings as { suggestionsPerLook: number }).suggestionsPerLook = was;
  }
});

test("groups: any member's 👍 or reply answers; /tasks lists the group's items, code only", async () => {
  runtime();
  const k = fresh();
  await suggest(k, "Book the hall");
  await G.offerSuggestions(conv(k), new Date(NOW), ZONE);
  said.length = 0;
  assert.equal(await taskReply(conv(k), { text: "/tasks suggestions" } as never, async (x) => void said.push(x)), true);
  assert.match(said[0]!, /1 suggestion .*Book the hall/s);
  assert.equal(await taskReaction(conv(k), { emoji: "👍", targetTimestamp: 1010, fromName: "Ben" } as never, async (x) => void said.push(x)), true);
  assert.equal(status(k, 1), "open");
  assert.equal(S.eventsOf(k, 1).at(-1)!.by, "Ben");
  said.length = 0;
  assert.equal(await taskReply(conv(k), { text: "/tasks" } as never, async (x) => void said.push(x)), true);
  assert.match(said[0]!, /Tasks: 1 open[\s\S]*Book the hall/);
  assert.equal(await taskReply(conv(k, "owner"), { text: "/tasks" } as never, async () => {}), false, "the owner's /tasks is the owner command path, not this one");
  assert.equal(G.groupTasksReply(conv(k), "please /tasks", ZONE), undefined, "exactly the command");
});

test("groups: 'Sam by Friday' sets the assignee; 'remind me' makes a GROUP task for that member and the line is said once per member", async () => {
  const k = fresh();
  setAsking(k, { owner: false, author: "+491", authorName: "Mia" });
  const t = tools(k);
  const by = await t.add_task!.handler({ title: "Bring the cake", assignee: "Sam", due: "2026-10-23" });
  assert.match(text(by), /for Sam/);
  assert.doesNotMatch(text(by), /Saved for the group/, "no reminder, no line");
  const r1 = await t.add_task!.handler({ title: "Call the venue", remind: "2026-10-23T15:00" });
  assert.match(text(r1), /for Mia/, "assigned to whoever said it");
  assert.match(text(r1), /"Saved for the group\. For a private reminder, message me directly\."/);
  const r2 = await t.add_task!.handler({ title: "Email the band", remind: "2026-10-24T15:00" });
  assert.doesNotMatch(text(r2), /Saved for the group/, "once per member");
  setAsking(k, { owner: false, author: "+492", authorName: "Ben" });
  assert.match(text(await t.add_task!.handler({ title: "Pack chairs", remind: "2026-10-24T10:00" })), /Saved for the group/);
  setAsking(k, undefined);
  assert.equal(S.getItem(k, 2)!.origin, "member");
  assert.equal(peekConvDb(convIdOfKey(k))!.num("SELECT COUNT(*) FROM group_remind_noted"), 2, "persisted, not in memory");
  // a friend's and the owner's chat never get the group line
  const own = tools("tenant:ida");
  assert.doesNotMatch(text(await own.add_task!.handler({ title: "Mine", remind: "2026-10-24T10:00" })), /Saved for the group/);
});

test("friends: the same tools and the same one-tap answers in their own chat, on their own list", async () => {
  runtime();
  const k = "tenant:bo";
  const t = tools(k);
  assert.match(text(await t.add_task!.handler({ title: "Call Mum", remind: "2026-10-24T10:00" })), /^Added task #1 'Call Mum'/);
  for (const name of ["list_tasks", "update_task", "complete_task", "drop_task", "snooze_task", "confirm_suggestion", "reject_suggestion"]) assert.ok(t[name], `${name} is there`);
  await suggest(k, "Her suggestion");
  await G.offerSuggestions(conv(k, "tenant"), new Date(NOW), ZONE);
  assert.equal(await R.reactSuggestions(conv(k, "tenant"), { emoji: "👍", targetTimestamp: 1010 }, answerer()), true);
  const it = S.listItems(k, { status: "open" }, NOW, ZONE).find((i) => i.title === "Her suggestion")!;
  assert.equal(it.status, "open");
  assert.equal(S.eventsOf(k, it.id).at(-1)!.by, "friend");
});

test("isolation: an answer in one conversation touches only that conversation's suggestions", async () => {
  runtime();
  const a = fresh();
  const b = fresh();
  await suggest(a, "In A");
  await suggest(b, "In B");
  await G.offerSuggestions(conv(a), new Date(NOW), ZONE); // ts 1010
  await G.offerSuggestions(conv(b), new Date(NOW), ZONE); // ts 1020
  assert.equal(G.isSuggestionMessage(a, 1020), false);
  assert.equal(await R.reactSuggestions(conv(a), { emoji: "👍", targetTimestamp: 1020 }, answerer()), false, "B's message means nothing in A");
  assert.deepEqual([status(a, 1), status(b, 1)], ["suggested", "suggested"]);
  assert.equal(await R.reactSuggestions(conv(a), { emoji: "👍", targetTimestamp: 1010 }, answerer()), true);
  assert.deepEqual([status(a, 1), status(b, 1)], ["open", "suggested"]);
});

test("the confirm is the person's: a mail or a note can only add a suggestion; nothing but the reply makes it open", async () => {
  const k = fresh();
  const bg = tools(k, { unattended: true });
  assert.deepEqual(Object.keys(bg).sort(), ["add_task", "list_tasks"]);
  const r = await bg.add_task!.handler({ title: "Wire the money", status: "open", source_kind: "mail", source_ref: "evil" });
  assert.match(text(r), /^Suggested task/);
  assert.equal(status(k, 1), "suggested");
});

test("prompts: the task tools are explained to the owner, a group and a friend; the look is told to suggest, with the cap", () => {
  const chat = chatSystem(new Date(NOW));
  assert.match(chat, /Tasks: you keep .*'s own to-do list/);
  assert.match(chat, /never sends an email|never sends mail|"Remind me to email Sam" never sends an email/);
  assert.match(chat, /Done with the licence|"Done with the licence"/);
  const grp = groupSystem({ caps: groupCapabilities() });
  assert.match(grp, /any member may add, change and finish items/);
  assert.match(grp, /Sam by Friday/);
  assert.doesNotMatch(chat, /any member may add/);
  const friend = tenantSystem({ name: "Ida", caps: new Set(["chat", "tasks"]) as never });
  assert.match(friend, /Tasks: you keep Ida's own to-do list/);
  const look = heartbeatInstruction({ now: "Thu 2026-10-22 12:00", timeZone: ZONE, lastLook: "", quietFrom: "22:00", quietTo: "07:00", dayMinutes: "30", delegated: "", briefTime: "07:30", briefOverdueHour: "09:00", briefFact: "", briefHow: "", who: "Ben", own: true, reads: true, mail: true, experts: false, brief: false, sources: "x", tasks: true, group: false });
  assert.match(look, /SUGGEST tasks with the add_task tool/);
  assert.match(look, /promised something in a mail they sent \(kind i_owe/);
  assert.match(look, /someone owes Ben something \(kind owed_to_me/);
  assert.match(look, /At most 5 per look/);
  assert.doesNotMatch(heartbeatInstruction({ now: "x", timeZone: ZONE, lastLook: "", quietFrom: "22:00", quietTo: "07:00", dayMinutes: "30", delegated: "", briefTime: "07:30", briefOverdueHour: "09:00", briefFact: "", briefHow: "", who: "Ben", own: true, reads: true, mail: true, experts: false, brief: false, sources: "x", tasks: false, group: false }), /SUGGEST tasks/);
});

test("the look: what the run suggested goes out as one message at the end of the look, after the run and not during it", async () => {
  const { createHeartbeatLook } = await import("../src/heartbeat/look.ts");
  const { owner } = await import("../src/conversation/conversation.ts");
  const { LOGIN } = await import("../src/tenants/payer.ts");
  const { recordMessage } = await import("../src/core/messages.ts");
  const { scratchLog } = await import("./scratch.ts");
  const sent = runtime();
  const c = { ...owner(), logFile: scratchLog(`suggest-look-${Math.random().toString(36).slice(2)}.jsonl`) };
  const pipeline = { enqueue: <X>(_c: unknown, job: () => Promise<X>) => job(), record: () => {}, busy: () => false, sendWhile: async (_c: unknown, r: () => Promise<unknown>) => r(), runTurn: async (_c: unknown, turn: { run: () => Promise<unknown> }) => (await turn.run(), { spoke: true }) };
  let during = -1;
  const hb = createHeartbeatLook({
    pipeline: pipeline as never,
    run: (async () => {
      await tools("owner", { unattended: true }).add_task!.handler({ title: "Answer the tax office", source_kind: "mail", source_ref: "mail-tax-1", due: "2026-10-30" });
      during = sent.length;
      return { text: "", structured: { message: "[[silent]]", nextCheckMinutes: 30 } };
    }) as never,
    may: () => LOGIN,
    why: () => "x",
    notesChangedAt: () => 0,
  });
  recordMessage("owner", Date.now(), "hi", new Date(), c.logFile);
  assert.equal(await hb.look(c, {} as never, new Date(NOW)), "silent");
  assert.equal(during, 0, "nothing is sent while the run works");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /^💡 One thing I noticed \(mail\):\n1\. Answer the tax office \(due Fri 30 Oct\)/);
});
