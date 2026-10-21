import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allows } from "../src/policy/capabilities.ts";
import { group as groupConversation, owner } from "../src/conversation/conversationmodel.ts";
import { createDreamer, dreamConversations, dreamPrompt, type Runner } from "../src/conversation/dream.ts";
import { dreamScope, dreamStateFile } from "../src/modules/memory/dreamscope.ts";
import { groupDir, groupLogFile, groupNotesDir } from "../src/conversation/groupstore.ts";
import { readAudit } from "../src/core/audit.ts";
import { createMemoryServer } from "../src/modules/memory/memory-tools.ts";
import { recordMessage } from "../src/core/messages.ts";
import { NOTES_DIR } from "../src/memory/notes.ts";
import { dreamSystem } from "../src/run/persona.ts";
import { preset } from "../src/core/preset.ts";
import { settings } from "../src/core/settings.ts";
import { dataPath, readJson, writeJson } from "../src/core/state.ts";
import { convPaths, OWNER_CONV } from "../src/core/convpaths.ts";

// The ONE dreamer (dream.ts createDreamer): the owner's chat and every group go through the same gates (the `dream` capability, the day guard, the preset's
// minimum of new lines), the same run and the same audit row; only the data differs (dreamscope.ts).

const NOW = new Date("2026-10-14T07:00:00");
const G = (n: number) => `R3JvdXA${n}R3JvdXAxR3JvdXAx`;
const reset = () => {
  rmSync(dataPath(convPaths(OWNER_CONV).dream), { force: true });
  rmSync(dataPath(convPaths(OWNER_CONV).messages), { force: true });
  rmSync(NOTES_DIR, { recursive: true, force: true });
  mkdirSync(NOTES_DIR, { recursive: true });
};
const say = (n: number, file: string) => recordMessage("member", 100 + n, `Eve (a member): we play on Thursdays ${n} ${"x".repeat(20)}`, new Date("2026-10-13T20:00:00Z"), file);
const counting = (): { calls: string[]; run: () => Runner } => {
  const calls: string[] = [];
  return { calls, run: () => async (prompt) => (calls.push(prompt), { ops: [] }) };
};

test("the preset gives the thresholds: 1 line in a direct chat, 3 in a group, 5 groups a night", () => {
  assert.deepEqual(preset().rhythm.dream, { enabled: true, hour: 4, minNewLines: { direct: 1, group: 3 }, maxGroupsPerNight: 5 });
});

test("one dreamer: the owner and the groups, the group threshold and the nightly cap come from the preset", async () => {
  reset();
  const ids = [1, 2, 3, 4, 5, 6, 7].map(G);
  for (const [i, g] of ids.entries()) {
    rmSync(groupDir(g), { recursive: true, force: true });
    rmSync(dataPath(groupLogFile(g)), { force: true });
    groupDir(g, `Group ${i}`);
    for (let n = 0; n < (i === 6 ? 2 : 3); n++) say(n, groupLogFile(g)); // the last group said too little
  }
  recordMessage("owner", 5, "Anna is my sister and her birthday is on 3 March", new Date("2026-10-13T20:00:00Z"));
  const c = counting();
  const d = createDreamer({ conversations: () => dreamConversations(["owner", "group"]), run: c.run });
  await d.run(NOW);
  const groups = c.calls.filter((p) => /the group chat/.test(p));
  assert.equal(c.calls.length, 1 + 5, "the owner, and at most five groups (the sixth group is over the cap, the seventh is quiet)");
  assert.equal(groups.length, 5);
  assert.match(c.calls[0]!, /The notes you keep about /);
  assert.match(groups[0]!, /What the group chat "Group \d" said and did/);
  // the owner's words are evidence in a private chat; a group's members' lines are evidence in a group: the same function, two data
  const rows = readAudit((e) => e.tool === "dream_run");
  assert.equal(rows.length, 6);
  assert.deepEqual([...new Set(rows.map((r) => (r.meta as { kind: string }).kind))].sort(), ["group", "owner"]);
  // the cap is per run (one a night): the sixth group, over it, is still open, the dreamt ones are done for the day
  c.calls.length = 0;
  await d.run(NOW);
  assert.equal(c.calls.length, 1, "the group that was over the cap goes next");
  c.calls.length = 0;
  await d.run(NOW);
  assert.equal(c.calls.length, 0, "the same day: nothing more");
  await d.run(new Date(NOW.getTime() + 86_400_000));
  assert.equal(c.calls.length, 0, "nothing new was said since: left alone (the day is not even marked)");
  for (const n of [9, 10, 11]) say(n, groupLogFile(ids[6]!));
  await d.run(new Date(NOW.getTime() + 2 * 86_400_000));
  assert.equal(c.calls.filter((p) => /the group chat/.test(p)).length, 1, "the group with enough new lines");
});

test("the capability decides: a group is dreamt only while its capability set has `dream` (DREAM=off takes it from everybody)", async () => {
  reset();
  const g = G(8);
  rmSync(groupDir(g), { recursive: true, force: true });
  rmSync(dataPath(groupLogFile(g)), { force: true });
  groupDir(g, "Quiet hours");
  for (let n = 0; n < 4; n++) say(n, groupLogFile(g));
  recordMessage("owner", 7, "I prefer meetings in the afternoon, never before 10", new Date("2026-10-13T20:00:00Z"));
  const f = settings as unknown as { dream: boolean };
  const was = f.dream;
  try {
    f.dream = false;
    assert.equal(allows(owner(), "dream"), false);
    assert.equal(allows({ kind: "group" }, "dream"), false);
    const c = counting();
    await createDreamer({ conversations: () => dreamConversations(["owner", "group"]), run: c.run }).run(NOW);
    assert.deepEqual(c.calls, [], "switched off: no dream for anyone, and the day stays open");
    f.dream = true;
    await createDreamer({ conversations: () => dreamConversations(["owner", "group"]), run: c.run }).run(NOW);
    assert.equal(c.calls.length, 2);
  } finally {
    f.dream = was;
  }
});

test("state files: the owner's stays in state/dream.json, a group's in its folder; a file written by the old dreamers is honoured", async () => {
  reset();
  const g = G(9);
  rmSync(groupDir(g), { recursive: true, force: true });
  rmSync(dataPath(groupLogFile(g)), { force: true });
  groupDir(g, "Old state");
  assert.equal(dreamStateFile(owner()), convPaths(OWNER_CONV).dream);
  assert.equal(dreamStateFile({ kind: "group", groupId: g }), join(groupDir(g), "dream.json"));
  // what the old dreamers had written: a day that is over and the time the last run started
  writeJson(convPaths(OWNER_CONV).dream, { day: "2026-10-13", lastRunAt: "2026-10-13T21:00:00.000Z" });
  writeFileSync(join(groupDir(g), "dream.json"), JSON.stringify({ day: "2026-10-13", lastRunAt: "2026-10-13T21:00:00.000Z" }));
  recordMessage("owner", 5, "old line before the last dream", new Date("2026-10-13T20:00:00Z")); // before lastRunAt: already covered
  for (let n = 0; n < 5; n++) say(n, groupLogFile(g)); // all at 20:00Z, before lastRunAt
  const c = counting();
  const d = createDreamer({ conversations: () => dreamConversations(["owner", "group"]), run: c.run });
  await d.run(NOW);
  assert.deepEqual(c.calls, [], "everything was before the last run");
  recordMessage("owner", 6, "a new thing after the last dream", new Date("2026-10-13T22:00:00Z"));
  await d.run(NOW);
  assert.equal(c.calls.length, 1);
  assert.match(c.calls[0]!, /a new thing after the last dream/);
  assert.doesNotMatch(c.calls[0]!, /old line before/);
  assert.equal(readJson<{ lastRunAt?: string }>(convPaths(OWNER_CONV).dream, {}).lastRunAt, NOW.toISOString());
});

test("one prompt: the same template for the owner, a friend and a group, with their categories from the preset", () => {
  const cats = preset().notes;
  const owned = dreamSystem({ subject: settings.owner, kind: "owner", categories: cats.dream });
  const friend = dreamSystem({ subject: "Mia", kind: "tenant", categories: cats.tenant });
  const group = dreamSystem({ subject: 'the group chat "Football"', kind: "group", categories: cats.group });
  assert.match(owned, new RegExp(`${settings.owner} keeps their notes locally`));
  assert.doesNotMatch(friend, /keeps their notes locally/);
  assert.match(friend, /Mia is a friend of /);
  assert.match(group, /what the group's members wrote/);
  for (const [p, list] of [[owned, cats.dream], [friend, cats.tenant], [group, cats.group]] as const) {
    assert.ok(p.includes(`with a category of ${list.join(", ")}.`), "the categories of that conversation, from the preset");
    assert.match(p, /Every NEW fact or change needs "evidence"/);
  }
  assert.match(dreamPrompt(NOW, "Mia", [], ["[10-13 20:00] Mia: hi"]), /The notes you keep about Mia right now/);
});

test("undo: a conversation that is dreamt can undo its dream with its own memory server (a group here; a friend in tenantloops.test.ts)", async () => {
  reset();
  const g = G(3);
  rmSync(groupDir(g), { recursive: true, force: true });
  rmSync(dataPath(groupLogFile(g)), { force: true });
  groupDir(g, "Undo");
  writeFileSync(join(groupNotesDir(g), "context-old.md"), "---\nname: old\nexpires: 2026-10-01\n---\n\nPitch booked for 1 Oct.\n");
  for (let n = 0; n < 3; n++) say(n, groupLogFile(g));
  const wrote = async () => ({ ops: [{ op: "write", file: "scheduling-games.md", description: "games", text: "Games are on Thursdays.", evidence: "we play on Thursdays" }, { op: "delete", file: "context-old.md", reason: "expired" }] });
  await createDreamer({ conversations: () => [groupConversation(g)], run: () => wrote }).run(NOW);
  assert.deepEqual(readdirSync(groupNotesDir(g)).filter((f) => f !== "MEMORY.md"), ["scheduling-games.md"]);
  const server = createMemoryServer({ notesDir: groupNotesDir(g), groupId: g, dream: dreamScope({ kind: "group", groupId: g }), record() {} }) as unknown as { instance: { _registeredTools: Record<string, { handler: (a: object, x: object) => Promise<{ content: { text: string }[] }> }> } };
  const r = await server.instance._registeredTools.undo_dream!.handler({}, {});
  assert.match(r.content[0]!.text, /Restored 1 notes/);
  assert.deepEqual(readdirSync(groupNotesDir(g)).filter((f) => f !== "MEMORY.md"), ["context-old.md"]);
});

test("one dreamer: a conversation someone is talking to is skipped for now, its day stays open, and it is dreamt once it is quiet", async () => {
  reset();
  recordMessage("owner", 5, "Anna is my sister and her birthday is on 3 March", new Date("2026-10-13T20:00:00Z"));
  const c = counting();
  let busy = true;
  const d = createDreamer({ conversations: () => dreamConversations(["owner"]), run: c.run, busy: () => busy });
  await d.run(NOW);
  assert.equal(c.calls.length, 0, "a turn is running: the notes are not tidied under it");
  busy = false;
  await d.run(NOW);
  assert.equal(c.calls.length, 1, "the day was not used up by the skip");
});
