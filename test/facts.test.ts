import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The facts a look and a chat turn share (src/heartbeat/facts.ts factsFor): the same facts for whichever run comes first, each delivered at most once, pending while a run has it, left for the next run when
// the run does not end well; a chat session is told only what changed; a chat turn never starts a routine; the expert's brief carries the look's context.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "facts-test-"));
process.env.TZ = "Europe/Berlin";

const F = await import("../src/heartbeat/facts.ts");
const T = await import("../src/heartbeat/remindtick.ts");
const S = await import("../src/tasks/store.ts");
const { group, owner } = await import("../src/conversation/conversationmodel.ts");
const { settings } = await import("../src/core/settings.ts");
const { recordMessage } = await import("../src/core/messages.ts");
const { peekConvDb, liveConvDb } = await import("../src/core/convdb.ts");
const { runConversation } = await import("../src/run/agent.ts");
const { turnFactsFrom, forgetShown } = await import("../src/run/turncontext.ts");
const { readRecord } = await import("../src/tasks/routines.ts");
const { delegationHook, expertSetup } = await import("../src/run/delegation.ts");

const s = settings as unknown as Record<string, unknown>;
s.quietStartHour = 22;
s.quietEndHour = 7;
s.warm = false;
const NOW = Date.parse("2026-10-22T10:00:00Z"); // 12:00 in Berlin
const MIN = 60_000;
const HOUR = 3_600_000;
let n = 0;
const sc = (key: string): import("../src/tasks/store.ts").Scope => ({ key, zone: "Europe/Berlin", by: "owner", origin: "owner", source: "chat", now: NOW - HOUR });
const pipeline = { enqueue: <X,>(_c: unknown, job: () => Promise<X>) => job(), runTurn: async () => ({ spoke: true }) } as never;
const state = (conv: { convId: string }, id: number) => peekConvDb(conv.convId)!.get<{ state: string }>("SELECT state FROM reminders WHERE item_id = ?", id)?.state;

// A group with one reminder claimed by the tick.
async function claimed(title = "Call Sam") {
  const conv = group(`facts-group-${++n}`);
  const it = S.addItem(sc(conv.key), { title, remindAt: NOW - 2 * MIN, due: "2026-10-22" }).item;
  await T.fireReminders(pipeline, conv, new Date(NOW), { looks: true });
  assert.equal(state(conv, it.id), "claimed");
  return { conv, it };
}
const has = (f: { blocks: string[] }, re: RegExp) => f.blocks.some((b) => re.test(b));

test("a chat turn takes a claimed reminder and, once its reply said something, the look after it is not handed it again", async () => {
  const { conv, it } = await claimed();
  const chat = F.factsFor(conv, new Date(NOW), "chat");
  assert.ok(has(chat, /Reminders due now[\s\S]*Call Sam/), "the chat turn is told");
  chat.done({ ended: true, said: true });
  assert.equal(state(conv, it.id), "sent");
  const look = F.factsFor(conv, new Date(NOW + MIN), "look");
  assert.ok(!has(look, /Reminders due now/), "told once");
  look.done({ ended: true, said: false });
});

test("a run holds what it took: a look in progress keeps a chat turn from the same reminder, and the reverse; a failed run gives it back", async () => {
  const { conv, it } = await claimed();
  const look = F.factsFor(conv, new Date(NOW), "look");
  assert.ok(has(look, /Call Sam/));
  assert.ok(!has(F.factsFor(conv, new Date(NOW), "chat"), /Reminders due now/), "pending in the look: not given to the chat turn too");
  look.done({ ended: false, said: false, abandoned: true });
  const chat = F.factsFor(conv, new Date(NOW), "chat");
  assert.ok(has(chat, /Call Sam/), "the look failed: the next run gets it");
  assert.ok(!has(F.factsFor(conv, new Date(NOW), "look"), /Reminders due now/), "pending in the chat turn: not given to the look");
  chat.done({ ended: false, said: false, abandoned: true }); // a silent or failed turn
  assert.equal(state(conv, it.id), "claimed", "nothing was told");
  const again = F.factsFor(conv, new Date(NOW), "look");
  assert.ok(has(again, /Call Sam/));
  again.done({ ended: true, said: true });
  assert.equal(state(conv, it.id), "sent");
});

test("a group's chat turn gets the group's facts: its reminders, not the owner's welcome, routines or a friend's learned changes", async () => {
  const { conv } = await claimed("Book the room");
  const f = F.factsFor(conv, new Date(NOW), "chat");
  assert.ok(has(f, /Book the room/));
  assert.ok(!f.blocks.concat(f.status).some((b) => /fresh install|notes_changed|meetings_to_prepare|Routines/.test(b)));
  assert.equal(f.routines, "");
  f.done({ ended: false, said: false, abandoned: true });
});

test("routines: a chat turn sees their status and never starts one; the look is handed the due routine and runs it", async () => {
  const conv = { ...owner(), notesDir: mkdtempSync(join(tmpdir(), "facts-notes-")) };
  writeFileSync(join(conv.notesDir, "routine-daily-brief.md"), "---\nwhen: every day at 07:30\n---\nRun the ted-personal-assistant:daily-brief skill and deliver the brief as it says.\n");
  const db = liveConvDb(conv.convId)!;
  db.run("INSERT OR REPLACE INTO routine_runs (name, since) VALUES ('routine-daily-brief', ?)", new Date(2026, 9, 1).getTime());
  const at = new Date(2026, 9, 14, 8, 0);
  const chat = F.factsFor(conv, at, "chat");
  assert.match(chat.status.join("\n"), /Routines, status only[\s\S]*routine-daily-brief: due now/);
  assert.equal(chat.routines, "", "no instruction to run it");
  assert.ok(!has(chat, /Delegate it now/));
  chat.done({ ended: true, said: true });
  assert.equal(readRecord(conv.convId, "routine-daily-brief")?.status, undefined, "the chat turn recorded nothing");
  const look = F.factsFor(conv, at, "look");
  assert.match(look.routines, /routine-daily-brief: due now[\s\S]*Delegate it now: call the Agent tool/);
  look.onDelegate("expert-daily-brief");
  assert.equal(readRecord(conv.convId, "routine-daily-brief")?.status, "started");
  assert.match(F.factsFor(conv, at, "chat").status.join("\n"), /routine-daily-brief: a look started it/, "the chat turn sees it running");
  look.onTool("Agent", { subagent_type: "expert-daily-brief" }, { content: [{ type: "text", text: "the brief" }] });
  look.done({ ended: true, said: true });
  assert.match(F.factsFor(conv, at, "chat").status.join("\n"), /routine-daily-brief: delivered/, "and then that it went out");
});

test("a chat session is told the facts once and again only when they changed (the claimed ones and the information ones apart)", async () => {
  turnFactsFrom((c, now) => F.factsFor(c, now, "chat"));
  const { conv } = await claimed("Water the plants");
  forgetShown(conv.convId);
  const prompts: string[] = [];
  let fail = false;
  const query = ((p: { prompt: string }) => (prompts.push(String(p.prompt)), (async function* () { if (fail) throw new Error("down"); yield { type: "result", subtype: "success", is_error: false, result: "hi", session_id: "fs1", total_cost_usd: 0.01 }; })())) as never;
  const ask = (text: string, at = NOW) => runConversation(conv, { now: new Date(at) }, () => ({ prompt: text }), undefined, { query });
  recordMessage("notice", NOW - 3 * HOUR, "Morning, the sun is out", new Date(NOW), conv.logFile);
  fail = true;
  await assert.rejects(ask("one"), /down/);
  assert.match(prompts[0]!, /Water the plants[\s\S]*one$/);
  assert.equal(peekConvDb(conv.convId)!.get<{ state: string }>("SELECT state FROM reminders")?.state, "claimed", "a failed turn leaves the reminder");
  fail = false;
  await ask("two");
  assert.match(prompts[1]!, /Morning, the sun is out[\s\S]*Water the plants[\s\S]*two$/, "claimed and information facts");
  await ask("three", NOW + MIN);
  assert.equal(prompts[2], "three", "told, delivered, and the information unchanged: nothing more in front");
  recordMessage("notice", NOW + 2 * MIN, "Lunch idea: soup", new Date(NOW), conv.logFile);
  await ask("four", NOW + 3 * MIN);
  assert.match(prompts[3]!, /Lunch idea: soup[\s\S]*four$/);
  assert.doesNotMatch(prompts[3]!, /Water the plants/, "the delivered reminder is not told again");
  turnFactsFrom(undefined);
});

test("the expert's brief carries the look's context after the look's own words; what the judge reads is unchanged", async () => {
  const set = expertSetup(["daily-brief"], "P");
  const briefs: string[] = [];
  const h = delegationHook(set, "background", { onDelegate: (d) => briefs.push(d.brief), context: () => "CONTEXT: Held back and not sent" });
  const out = (await h.hook({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "expert", prompt: "do the brief", description: "x" }, tool_use_id: "t" } as never, "t", { signal: new AbortController().signal })) as unknown as { hookSpecificOutput: { updatedInput: { prompt: string; run_in_background: boolean } } };
  assert.equal(out.hookSpecificOutput.updatedInput.prompt, "do the brief\n\nCONTEXT: Held back and not sent");
  assert.equal(out.hookSpecificOutput.updatedInput.run_in_background, false);
  assert.deepEqual(briefs, ["do the brief"]);
});
