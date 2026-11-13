import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { group as groupConversation, owner } from "../src/conversation/conversationmodel.ts";
import { createDreamer, dreamPrompt, type Runner } from "../src/conversation/dream.ts";
import { dreamStateConv, writeDream } from "../src/modules/memory/dreamscope.ts";
import { convDb, removeConvDir } from "../src/core/convdb.ts";
import { groupDir, groupLogFile } from "../src/conversation/groupstore.ts";
import { recordMessage } from "../src/core/messages.ts";
import { NOTES_DIR } from "../src/memory/notes.ts";
import { dataPath } from "../src/core/state.ts";
import { convPaths, groupConvId, OWNER_CONV } from "../src/core/convpaths.ts";

// The dream's look back: the last 14 days of the person's lines, the older ones apart from the new, their quotes counting as evidence.

const NOW = new Date("2026-10-14T07:00:00");
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000);
const reset = () => {
  convDb(OWNER_CONV).run("DELETE FROM dream");
  rmSync(dataPath(convPaths(OWNER_CONV).messages), { force: true });
  rmSync(NOTES_DIR, { recursive: true, force: true });
  mkdirSync(NOTES_DIR, { recursive: true });
};

test("older lines come apart from the new ones and their quotes count; nothing new still skips", async () => {
  reset();
  writeDream(dreamStateConv(owner()), { day: "2026-10-12", lastRunAt: at(3).toISOString() });
  recordMessage("owner", 1, "the stay in Valmora starts on the 3rd, not the 24th", at(9));
  recordMessage("chat", 2, "Noted, the 3rd.", at(9));
  recordMessage("owner", 3, "an old line from long ago", at(20));
  const calls: string[] = [];
  const skip: () => Runner = () => async (prompt) => (calls.push(prompt), { ops: [] });
  await createDreamer({ conversations: () => [owner()], run: skip }).run(NOW);
  assert.equal(calls.length, 0, "nothing new since the last dream: skipped");
  recordMessage("owner", 4, "booked the train for Friday", at(1));
  let seen = "";
  const run = (): Runner => async (prompt) => ((seen = prompt), { ops: [{ op: "write", file: "context-valmora-stay.md", description: "Stay", text: "Stay starts on the 3rd.", evidence: "starts on the 3rd, not the 24th" }] });
  await createDreamer({ conversations: () => [owner()], run }).run(NOW);
  assert.ok(seen.indexOf("booked the train") >= 0 && seen.indexOf("booked the train") < seen.indexOf("earlier_conversation"), "the new part comes first, in its own block");
  assert.ok(seen.includes("starts on the 3rd, not the 24th") && seen.includes("assistant (context only): Noted, the 3rd."));
  assert.ok(!seen.includes("long ago"), "beyond 14 days is left out");
  assert.ok(readdirSync(NOTES_DIR).includes("context-valmora-stay.md"), "a quote from an older line is evidence");
});

test("dreamPrompt: the older part is marked and cut from its old end; the new part keeps its room first", () => {
  const newer = ["[10-13 20:00] Mia: new line"];
  const older = Array.from({ length: 2000 }, (_, i) => `[10-01 10:00] Mia: older ${String(i).padStart(4, "0")} ${"y".repeat(30)}`);
  const p = dreamPrompt(NOW, "Mia", [], newer, older);
  assert.match(p, /since the last dream[^]*new line[^]*in the days before the last dream[^]*older 1999/);
  assert.ok(!p.includes("older 0000") && p.includes("older 1999"), "the most recent older lines stay");
  assert.doesNotMatch(dreamPrompt(NOW, "Mia", [], newer), /days before/);
  assert.doesNotMatch(dreamPrompt(NOW, "Mia", [], ["x".repeat(50_000)], older), /days before/, "no room left: the older part is dropped");
});

test("a group's older lines follow the member rule: members' words only", async () => {
  reset();
  const g = "R3JvdXA1R3JvdXAxR3JvdXAx";
  removeConvDir(groupConvId(g));
  rmSync(dataPath(groupLogFile(g)), { force: true });
  groupDir(g, "Look back");
  const conv = groupConversation(g);
  writeDream(dreamStateConv(conv), { day: "2026-10-12", lastRunAt: at(3).toISOString() });
  recordMessage("member", 1, "Eve (a member): we move to Fridays", at(8), groupLogFile(g));
  recordMessage("owner", 2, "private owner words", at(8), groupLogFile(g));
  for (let n = 0; n < 3; n++) recordMessage("member", 10 + n, `Eve (a member): new line ${n}`, at(1), groupLogFile(g));
  let seen = "";
  await createDreamer({ conversations: () => [conv], run: () => async (prompt) => ((seen = prompt), { ops: [] }) }).run(NOW);
  assert.ok(seen.includes("we move to Fridays") && !seen.includes("private owner words"));
});

const writes = (evidence: Record<string, string>) => ({ ops: Object.entries(evidence).map(([file, e]) => ({ op: "write", file, description: "x", text: "A fact the run learnt.", evidence: e })) });

test("a line deleted or edited after the last dream: gone from the older block and from the evidence; assistant text is no evidence", async () => {
  reset();
  writeDream(dreamStateConv(owner()), { day: "2026-10-12", lastRunAt: at(3).toISOString() });
  recordMessage("owner", 1, "we will stay at the lake house in June", at(9));
  recordMessage("owner", 2, "the visit is planned for the 12th of June", at(8));
  recordMessage("chat", 3, "Your dentist suggested the 14th of June for the check-up.", at(8));
  recordMessage("delete", 4, "[a message was deleted by its author]", at(1), undefined, { of: 1 });
  recordMessage("edit", 5, "the visit is planned for the 19th of June", at(1), undefined, { of: 2 });
  recordMessage("owner", 6, "booked the train for Friday", at(1));
  let seen = "";
  const run = (): Runner => async (prompt) => ((seen = prompt), writes({ "style-a.md": "stay at the lake house in June", "style-b.md": "the visit is planned for the 12th of June", "style-c.md": "dentist suggested the 14th of June", "style-d.md": "the visit is planned for the 19th of June" }));
  await createDreamer({ conversations: () => [owner()], run }).run(NOW);
  assert.ok(!seen.includes("lake house") && !seen.includes("12th of June"), "the deleted line and the old text of the edited one are not shown");
  assert.ok(seen.includes("19th of June") && seen.includes("assistant (context only): Your dentist"));
  assert.deepEqual(readdirSync(NOTES_DIR).filter((f) => f.startsWith("style-")), ["style-d.md"], "only the edited text counts as evidence");
});
