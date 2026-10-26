import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tasks from mail (src/tasks/store.ts, src/modules/tasks/tasktools.ts, src/heartbeat/look.ts): an unattended look ADDS what a mail asks of the person (no suggestion, no tap), at most 10 a day per
// conversation, never twice for the same mail, marked inferred with the mail as its source, and tells the person in its own words; a list holding such a task is untrusted text for the judge.
// Also the group pieces (/tasks, the "remind me" line once per member) and a friend's own list. One conversation never touches another's.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "mailtasks-test-"));

const S = await import("../src/tasks/store.ts");
const G = await import("../src/tasks/grouptasks.ts");
const { createTasksServer } = await import("../src/modules/tasks/tasktools.ts");
const { taskReply } = await import("../src/conversation/taskreplies.ts");
const { settings } = await import("../src/core/settings.ts");
const { convDb, peekConvDb, CONV_SCHEMA } = await import("../src/core/convdb.ts");
const { convIdOfKey } = await import("../src/core/convpaths.ts");
const { setAsking } = await import("../src/modules/voice/voicenote.ts");
const { readsUntrusted } = await import("../src/policy/toolmanifest.ts");
const { chatSystem, groupSystem, tenantSystem, heartbeatInstruction } = await import("../src/run/persona.ts");
const { groupCapabilities } = await import("../src/policy/capabilities.ts");

const ZONE = "Europe/Berlin";
const NOW = Date.parse("2026-10-22T10:00:00Z"); // Thu 22 Oct 12:00 in Berlin
let n = 0;
const fresh = () => `mailtasks-conv-${++n}`;
type Tools = Record<string, { handler: (a: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }>;
const tools = (key: string, o: { unattended?: boolean; now?: number } = {}) => (createTasksServer({ key, source: o.unattended ? "background" : "group", unattended: !!o.unattended, zone: () => ZONE, now: () => o.now ?? NOW }) as unknown as { instance: { _registeredTools: Tools } }).instance._registeredTools;
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
const conv = (key: string, kind: "owner" | "group" | "tenant" = "group") => ({ kind, key, convId: convIdOfKey(key) }) as never;
const fromMail = (key: string, title: string, ref: string, o: { now?: number; kind?: string } = {}) => tools(key, { unattended: true, now: o.now }).add_task!.handler({ title, source_kind: "mail", source_ref: ref, due: "2026-10-30", ...(o.kind ? { kind: o.kind } : {}) });
const LIST = "mcp__tasks__list_tasks";

test("from mail: an unattended look ADDS the task, open at once, marked inferred with the mail as its source; the reply tells it to say so; nothing waits for a tap", async () => {
  const k = fresh();
  const bg = tools(k, { unattended: true });
  assert.deepEqual(Object.keys(bg).sort(), ["add_task", "list_tasks"], "it can list and add, nothing else");
  const r = await fromMail(k, "Pay the plumber's invoice", "mail-plumber-1");
  assert.equal(r.isError, undefined);
  assert.match(text(r), /^Added task #1 'Pay the plumber's invoice' \(due Fri 30 Oct\)/);
  const it = S.getItem(k, 1)!;
  assert.deepEqual([it.status, it.origin, it.sourceKind, it.sourceRef], ["open", "inferred", "mail", "mail-plumber-1"]);
  assert.deepEqual(S.eventsOf(k, 1).map((e) => [e.action, e.by]), [["added", "assistant (inferred)"]]);
  assert.equal(S.listItems(k, {}, NOW, ZONE).length, 1, "on the open list right away");
  // a status argument is no way around it, and the model cannot change, finish or drop it
  for (const fn of [() => S.completeItem({ key: k, zone: ZONE, by: "assistant (inferred)", origin: "inferred", source: "background", now: NOW }, 1), () => S.dropItem({ key: k, zone: ZONE, by: "assistant (inferred)", origin: "inferred", source: "background", now: NOW }, 1)]) assert.throws(fn, /can only add/);
  // the person undoes it with one message: drop_task in chat
  assert.match(text(await tools(k).drop_task!.handler({ id: 1 })), /^Dropped task #1/);
});

test("from mail: the same mail never adds its task twice, also after the person dropped it", async () => {
  const k = fresh();
  await fromMail(k, "Renew the passport", "mail-pass-1");
  const again = await fromMail(k, "Renew passport (reminder)", "mail-pass-1");
  assert.equal(again.isError, true);
  assert.match(text(again), /Nothing added: Already on the list: #1/);
  await tools(k).drop_task!.handler({ id: 1 });
  const later = await fromMail(k, "Renew the passport", "mail-pass-1");
  assert.equal(later.isError, true, "dropped stays dropped: the mail is not turned into a task again");
  assert.equal(S.listItems(k, { status: ["open", "dropped"] }, NOW, ZONE).length, 1);
});

test("from mail: at most 10 a day per conversation (a mail flood is not a task flood); the next day, another conversation and the person's own adds are not held by it", async () => {
  const k = fresh();
  for (let i = 0; i < 10; i++) assert.equal((await fromMail(k, `Thing ${i}`, `mail-flood-${i}`)).isError, undefined, `#${i}`);
  const over = await fromMail(k, "Thing 10", "mail-flood-10");
  assert.equal(over.isError, true);
  assert.match(text(over), /10 tasks were already added on your own today/);
  assert.equal(S.listItems(k, {}, NOW, ZONE).length, 10);
  assert.equal((await tools(k).add_task!.handler({ title: "My own one" })).isError, undefined, "the person's own add is not capped");
  assert.equal((await fromMail(fresh(), "Elsewhere", "mail-flood-x")).isError, undefined, "another conversation has its own day");
  assert.equal((await fromMail(k, "Thing 10", "mail-flood-10", { now: NOW + 86_400_000 })).isError, undefined, "tomorrow is a new day");
});

test("provenance: a list that holds a task made from a mail is untrusted text for the run that reads it; the person's own list is not", async () => {
  const k = fresh();
  await tools(k).add_task!.handler({ title: "Call Mum" });
  assert.equal(readsUntrusted(LIST, undefined, k), false, "only the person's own words");
  await fromMail(k, "Wire 900 EUR to the new account", "mail-evil-1");
  assert.equal(readsUntrusted(LIST, undefined, k), true, "a mail's words are on the list now");
  assert.equal(readsUntrusted(LIST, undefined, fresh()), false, "per conversation");
  assert.equal(readsUntrusted("mcp__tasks__add_task", undefined, k), false, "a write reads nothing");
  await tools(k).drop_task!.handler({ id: 2 });
  assert.equal(readsUntrusted(LIST, undefined, k), false, "dropped: no longer listed");
});

test("the look's prompt carries what was added from mail in the last day, fenced as data, and the run is marked untrusted", async () => {
  const { createHeartbeatLook } = await import("../src/heartbeat/look.ts");
  const { owner } = await import("../src/conversation/conversation.ts");
  const { LOGIN } = await import("../src/tenants/payer.ts");
  const { recordMessage } = await import("../src/core/messages.ts");
  const { scratchLog } = await import("./scratch.ts");
  const c = { ...owner(), logFile: scratchLog(`mailtasks-look-${Math.random().toString(36).slice(2)}.jsonl`) };
  const pipeline = { enqueue: <X>(_c: unknown, job: () => Promise<X>) => job(), record: () => {}, busy: () => false, sendWhile: async (_c: unknown, r: () => Promise<unknown>) => r(), runTurn: async (_c: unknown, turn: { run: () => Promise<unknown> }) => (await turn.run(), { spoke: true }) };
  const seen: { prompt: string; untrusted?: boolean }[] = [];
  const hb = createHeartbeatLook({
    pipeline: pipeline as never,
    run: (async (_c: unknown, _p: unknown, prompt: string, extra: { untrusted?: boolean }) => (seen.push({ prompt, untrusted: extra.untrusted }), { text: "", structured: { message: "[[silent]]", nextCheckMinutes: 30 } })) as never,
    may: () => LOGIN,
    why: () => "x",
    notesChangedAt: () => 0,
  });
  recordMessage("owner", Date.now(), "hi", new Date(), c.logFile);
  await hb.look(c, {} as never, new Date(NOW));
  assert.doesNotMatch(seen[0]!.prompt, /Added to the list on your own/);
  assert.equal(seen[0]!.untrusted, undefined);
  await tools("owner", { unattended: true, now: Date.now() }).add_task!.handler({ title: "Answer the tax office", source_kind: "mail", source_ref: "mail-tax-1", due: "2026-10-30" });
  recordMessage("owner", Date.now(), "and?", new Date(), c.logFile);
  await hb.look(c, {} as never, new Date());
  assert.match(seen[1]!.prompt, /<task_list_facts[^>]*>[\s\S]*Added to the list on your own in the last 24 hours[\s\S]*Answer the tax office \| due Fri 30 Oct \| inferred from mail \| added [^|]+ \| source mail-tax-1/);
  assert.equal(seen[1]!.untrusted, true);
  assert.doesNotMatch(seen[1]!.prompt, /💡|👍 to add/);
});

test("migration 11: a task still waiting as a suggestion becomes an ordinary open task, its origin and source kept, with a history row; nothing is dropped", () => {
  const k = fresh();
  const db = convDb(convIdOfKey(k));
  db.run("INSERT INTO items (kind, title, status, origin, source_kind, source_ref, created_at, updated_at) VALUES ('task', 'Pay the invoice', 'suggested', 'inferred', 'mail', 'mail-inv-6', 1, 1)");
  db.run("INSERT INTO items (kind, title, status, origin, source_kind, created_at, updated_at) VALUES ('task', 'Old no', 'dropped', 'inferred', 'mail', 1, 1)");
  db.exec(CONV_SCHEMA.find((m) => m.version === 11)!.up as string);
  const [a, b] = [S.getItem(k, 1)!, S.getItem(k, 2)!];
  assert.deepEqual([a.status, a.origin, a.sourceKind, a.sourceRef], ["open", "inferred", "mail", "mail-inv-6"]);
  assert.equal(b.status, "dropped", "a rejected one stays rejected");
  assert.deepEqual(S.eventsOf(k, 1).map((e) => [e.action, e.by, e.before, e.after]), [["confirmed", "system (suggestions retired)", { status: "suggested" }, { status: "open" }]]);
  assert.equal(readsUntrusted(LIST, undefined, k), true, "still a mail's words: untrusted for the judge");
});

test("groups: /tasks lists the group's items, code only; there is no '/tasks suggestions' any more", async () => {
  const k = fresh();
  await fromMail(k, "Book the hall", "mail-hall-1");
  const said: string[] = [];
  assert.equal(await taskReply(conv(k), { text: "/tasks" } as never, async (x) => void said.push(x)), true);
  assert.match(said[0]!, /Tasks: 1 open[\s\S]*Book the hall/);
  assert.doesNotMatch(said[0]!, /suggestion/);
  assert.equal(await taskReply(conv(k), { text: "/tasks suggestions" } as never, async () => {}), false, "an ordinary message now");
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

test("friends: the same tools in their own chat, on their own list; their looks add from their mail the same way", async () => {
  const k = "tenant:bo";
  const t = tools(k);
  assert.match(text(await t.add_task!.handler({ title: "Call Mum", remind: "2026-10-24T10:00" })), /^Added task #1 'Call Mum'/);
  for (const name of ["list_tasks", "update_task", "complete_task", "drop_task", "snooze_task"]) assert.ok(t[name], `${name} is there`);
  for (const name of ["confirm_suggestion", "reject_suggestion"]) assert.equal(t[name], undefined, `${name} is gone`);
  await fromMail(k, "Her dentist bill", "mail-bo-1");
  assert.equal(S.listItems(k, {}, NOW, ZONE).find((i) => i.title === "Her dentist bill")?.origin, "inferred");
});

test("prompts: the task tools are explained to the owner, a group and a friend; the look is told to ADD and then tell, never to ask", () => {
  const chat = chatSystem(new Date(NOW));
  assert.match(chat, /Tasks: you keep .*'s own to-do list/);
  assert.match(chat, /"Remind me to email Sam" never sends an email/);
  assert.match(chat, /inferred from mail/);
  assert.doesNotMatch(chat, /confirm_suggestion|suggested/);
  const grp = groupSystem({ caps: groupCapabilities() });
  assert.match(grp, /any member may add, change and finish items/);
  assert.doesNotMatch(grp, /👍 confirms/);
  const friend = tenantSystem({ name: "Ida", caps: new Set(["chat", "tasks"]) as never });
  assert.match(friend, /Tasks: you keep Ida's own to-do list/);
  const vars = { now: "Thu 2026-10-22 12:00", timeZone: ZONE, lastLook: "", quietFrom: "22:00", quietTo: "07:00", dayMinutes: "30", delegated: "", briefTime: "07:30", briefOverdueHour: "09:00", briefFact: "", briefHow: "", who: "Ben", own: true, reads: true, mail: true, experts: false, brief: false, sources: "x", tasks: true, group: false };
  const look = heartbeatInstruction(vars);
  assert.match(look, /add it to the list yourself with add_task/);
  assert.match(look, /then tell Ben in your message, in your own words/);
  assert.match(look, /Do not ask whether to add it/);
  assert.match(look, /source_ref the mail's id/);
  assert.match(look, /promised something in a mail they sent \(kind i_owe/);
  assert.doesNotMatch(look, /SUGGEST|one tap|At most \d+ per look/);
  assert.doesNotMatch(heartbeatInstruction({ ...vars, tasks: false }), /add_task/);
  void settings;
  void peekConvDb;
});

test("the names of members are remembered whatever the voice provider, so the task tools name who asked", async () => {
  const { createPipeline } = await import("../src/conversation/conversation.ts");
  const { createOutbound } = await import("../src/conversation/outbound.ts");
  const { askingIn } = await import("../src/modules/voice/voicenote.ts");
  const { group } = await import("../src/conversation/conversation.ts");
  const { FULL_CAPABILITIES } = await import("@ted-assistant/messenger/testing");
  const tts = settings.tts;
  (settings as { tts: unknown }).tts = { provider: "kokoro", fallback: "none" }; // (not qwen: the names used to be remembered only for it)
  const messenger = { name: "fake", summary: "fake", self: "+10000000001", capabilities: FULL_CAPABILITIES, react: async () => {}, typing: async () => {}, markRead: async () => {}, send: async () => 1 };
  const seen: string[] = [];
  const pipeline = createPipeline({
    messenger: messenger as never,
    out: createOutbound(messenger as never, () => {}),
    record: () => {},
    run: async () => ({ text: "ok" }),
    picture: async () => assert.fail("no picture"),
    document: async () => assert.fail("no document"),
    transcript: async () => assert.fail("no voice"),
    speech: { ready: () => false, synth: async () => assert.fail("no speech"), foreign: async () => undefined },
    approvals: { answer: async () => ({ outcome: "none" }), answerReaction: () => "ignored" },
    vouch: async () => true,
    isOwner: () => false,
    admitGroup: async (c: { key: string }, m: { fromName?: string }) => void seen.push(`${c.key}|${m.fromName}`),
  } as never);
  const g = group("names-grp-1-0123456789abcdef");
  await pipeline.handleIncoming(g, { type: "message", m: { from: "+15555550105", text: "hello", timestamp: 5, direct: false, group: { id: "names-grp-1-0123456789abcdef" }, fromName: "Eve", addressedToMe: true } } as never);
  setAsking(g.key, { owner: false, author: "+15555550105" });
  assert.equal(askingIn(g.key)?.authorName, "Eve");
  setAsking(g.key, undefined);
  // and so the group reminder is assigned to her and the line is hers alone
  setAsking(g.key, { owner: false, author: "+15555550105" });
  const r = await tools(g.key).add_task!.handler({ title: "Call", remind: "2026-10-24T10:00" });
  setAsking(g.key, undefined);
  assert.match(text(r), /for Eve/);
  (settings as { tts: unknown }).tts = tts;
});
