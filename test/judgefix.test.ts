import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeOf } from "../src/approvals/turnscope.ts";
import { standing } from "./util.ts";
import { judgeAction, judgePrompt, mayFix, notifyNote, parseVerdict, agreement, type Verdict } from "../src/approvals/autojudge.ts";
import { readAudit } from "../src/core/audit.ts";
import { SYSTEM } from "../src/approvals/approvaljudge.ts";
import { setDraftReader } from "../src/modules/mailbird/module.ts";
import { makeCanUseTool, type CallGuard } from "../src/approvals/permissions.ts";
import { settings } from "../src/core/settings.ts";
import { CHAT } from "./util.ts";

const CAL = "mcp__claude_ai_Google_Calendar__";
const opts = { signal: new AbortController().signal } as never;
type Out = { behavior: string; message?: string; updatedInput?: unknown };
const flight = (extra: Record<string, unknown> = {}) => ({ summary: "Flight LHR-ZRH", startTime: "2026-10-31T17:10:00", endTime: "2026-10-31T20:00:00", timeZone: "Europe/Zurich", description: "Departs 17:10 London time, lands 20:00 Zurich time", ...extra });
const mode = (m: typeof settings.autoApprove) => void ((settings as { autoApprove: string }).autoApprove = m);
const scripted = (...v: Verdict[]) => { const q = [...v]; const seen: string[] = []; return { seen, fn: async (i: { description: string }): Promise<Verdict> => (seen.push(i.description), q.shift() ?? { decision: "ask", reason: "none left" }) }; };
const fix = (reason = "end 20:00 is Zurich time but the zone is Europe/Zurich for both") => ({ decision: "fix" as const, reason });
const rows = (tool: string, decision: string) => readAudit((e) => e.tool === tool && e.decision === decision);

test("fix verdicts: a reason is required, anything unknown stays ask", () => {
  assert.deepEqual(parseVerdict({ decision: "fix", reason: "  end time contradicts the zone " }), { decision: "fix", reason: "end time contradicts the zone" });
  for (const bad of [{ decision: "fix" }, { decision: "fix", reason: "" }, { decision: "fix", reason: "   " }, { decision: "fix", reason: 5 }, { decision: "FIX", reason: "x" }, { decision: "repair", reason: "x" }, { decision: ["fix"], reason: "x" }]) assert.equal(parseVerdict(bad).decision, "ask", JSON.stringify(bad));
  assert.equal(parseVerdict({ decision: "auto", reason: "" }).decision, "auto");
  assert.equal(agreement([{ judge: "fix", ownerApproved: true }]).judgedAskOwnerApproved, 1);
});

test("the guard list: payments, mail sends, deletes, shares and guard steps never fix", () => {
  assert.equal(mayFix(`${CAL}create_event`), true);
  assert.equal(mayFix(`${CAL}update_event`), true);
  for (const t of ["mcp__mailbird__send_message_now", "mcp__claude_ai_Gmail__send_message", "mcp__claude_ai_Gmail__reply", "mcp__claude_ai_Gmail__forward", `${CAL}delete_event`, "mcp__claude_ai_Google_Drive__trash_file", "mcp__claude_ai_Google_Drive__share_file", `${CAL}respond_to_event`]) assert.equal(mayFix(t), false, t);
  assert.equal(mayFix("mcp__browser__browser_click", { guardStep: true }), false);
  assert.equal(mayFix("mcp__browser__browser_type", { payment: true }), false);
});

test("the prompt names the third verdict, its examples and the places it never applies", () => {
  for (const part of ["auto, ask or fix", "Choose fix, instead of ask", "17:10 London time", "Thursday when the email says Tuesday", "payments, logins, anything sent to other people, deletions"]) assert.ok(SYSTEM.includes(part), part);
});

test("the flight case: fix denies with the hint, asks nobody, runs nothing; the corrected call is judged auto and runs", async () => {
  mode("auto");
  scopeOf("owner").say("add my return flight to my calendar");
  const j = scripted(fix(), { decision: "auto", reason: "matches" });
  let asked = 0;
  const canUse = makeCanUseTool(async () => (asked++, { approved: false }), "chat", undefined, j.fn, undefined, undefined, false, CHAT);
  const first = (await canUse(`${CAL}create_event`, flight(), opts)) as Out;
  assert.equal(first.behavior, "deny");
  assert.equal(first.updatedInput, undefined);
  assert.match(first.message!, /^Not run, nobody was asked: ".*Zurich.*"\. Correct the arguments and call the tool again, once\. If you cannot tell the right value, ask .* in chat instead of guessing\.$/);
  assert.equal(asked, 0);
  const fixed = flight({ startTime: "2026-10-31T17:10:00+00:00", endTime: "2026-10-31T20:00:00+01:00" });
  const second = (await canUse(`${CAL}create_event`, fixed, opts)) as Out;
  assert.equal(second.behavior, "allow");
  assert.equal(asked, 0);
  assert.equal(j.seen.length, 2, "the corrected call is judged like any new call");
  const r = rows(`${CAL}create_event`, "judge-fix").at(-1)!;
  assert.equal((r.meta as { count: number }).count, 1);
  assert.match(String((r.meta as { reason: string }).reason), /Zurich/);
});

test("at most 2 fixes per tool per run, then ask; the same arguments again ask at once", async () => {
  mode("auto");
  scopeOf("owner").say("add my flight");
  const j = scripted(fix(), fix(), fix("a third"));
  let asked = 0;
  const canUse = makeCanUseTool(async () => (asked++, { approved: false }), "chat", undefined, j.fn, undefined, undefined, false, CHAT);
  const a = flight(), b = flight({ summary: "b" }), c = flight({ summary: "c" });
  assert.equal(((await canUse(`${CAL}create_event`, a, opts)) as Out).message?.startsWith("Not run"), true);
  assert.equal(((await canUse(`${CAL}create_event`, b, opts)) as Out).message?.startsWith("Not run"), true);
  assert.equal(asked, 0);
  assert.match(((await canUse(`${CAL}create_event`, c, opts)) as Out).message!, /declined/, "the third is asked");
  assert.equal(asked, 1);
  // a fresh run starts at zero; byte-identical arguments are never fixed twice
  const j2 = scripted(fix(), fix());
  const run2 = makeCanUseTool(async () => (asked++, { approved: false }), "chat", undefined, j2.fn, undefined, undefined, false, CHAT);
  assert.equal(((await run2(`${CAL}create_event`, flight({ summary: "d" }), opts)) as Out).message?.startsWith("Not run"), true);
  assert.match(((await run2(`${CAL}create_event`, flight({ summary: "d" }), opts)) as Out).message!, /declined/);
  assert.equal(asked, 2);
  assert.ok(rows(`${CAL}create_event`, "judge-ask").some((e) => (e.meta as { fix?: string }).fix === "fix-cap"));
  assert.ok(rows(`${CAL}create_event`, "judge-ask").some((e) => (e.meta as { fix?: string }).fix === "same-arguments"));
});

test("a fix for a send, a delete or a guard step is downgraded to ask", async () => {
  mode("auto");
  scopeOf("owner").say("send it");
  setDraftReader(async () => ({ to: ["jessica@example.com"], cc: [], subject: "s", body: "b" }) as never);
  let asked = 0;
  const ask = async () => (asked++, { approved: false });
  const send = makeCanUseTool(ask, "chat", undefined, scripted(fix()).fn, undefined, undefined, false, CHAT);
  assert.match(((await send("mcp__mailbird__send_message_now", { messageId: 9100, confirm: true }, opts)) as Out).message!, /declined/);
  assert.equal(asked, 1);
  const guard: CallGuard = { decide: async () => ({ kind: "ask", judge: true, description: "Browser: confirm this step" }) };
  const step = makeCanUseTool(ask, "browse", undefined, scripted(fix()).fn, guard, undefined, false, { provenance: standing("order") });
  assert.match(((await step("mcp__browser__browser_click", { target: "e1" }, opts)) as Out).message!, /declined/);
  assert.equal(asked, 2);
  assert.equal(rows("mcp__mailbird__send_message_now", "judge-fix").length, 0);
});

test("AUTO_APPROVE=off: the judge is not called at all, so there is nothing to fix; the owner is asked", async () => {
  mode("off");
  scopeOf("owner").say("add my flight");
  let asked = 0;
  const j = scripted(fix());
  const canUse = makeCanUseTool(async () => (asked++, { approved: true }), "chat", undefined, j.fn, undefined, undefined, false, CHAT);
  assert.equal(((await canUse(`${CAL}create_event`, flight({ summary: "off" }), opts)) as Out).behavior, "allow");
  assert.equal(asked, 1);
  assert.equal(j.seen.length, 0);
  mode("auto");
});

test("follow-through: the judge is told the notification facts and the guidance for a location fill-in", async () => {
  assert.match(SYSTEM, /Follow-through is auto/);
  assert.match(SYSTEM, /Balboa course/);
  assert.match(SYSTEM, /booking number added to the description/);
  assert.match(SYSTEM, /Still ask for changing attendees or guests/);
  assert.match(SYSTEM, /changing the time or day of .*'s own event follows the own-calendar rule/);
  const update = { eventId: "e1", location: "Club Silbando Saal 1, Förrlibuckstrasse 62, 8005 Zürich" };
  assert.match(notifyNote(`${CAL}update_event`, update), /names no guests; this call asks for no notifications/);
  assert.match(notifyNote(`${CAL}update_event`, { ...update, attendees: ["a@example.com"], sendUpdates: "all" }), /names guests; sendUpdates=all/);
  assert.equal(notifyNote("mcp__mailbird__send_message_now", {}), "");
  mode("auto");
  scopeOf("owner").say("where is the Balboa course?");
  const j = scripted({ decision: "auto", reason: "fills in the place he asked about" });
  let asked = 0;
  const canUse = makeCanUseTool(async () => (asked++, { approved: false }), "chat", undefined, j.fn, undefined, undefined, false, CHAT);
  assert.equal(((await canUse(`${CAL}update_event`, update, opts)) as Out).behavior, "allow");
  assert.equal(asked, 0);
  assert.match(j.seen[0]!, /Notifies: this call names no guests/);
  assert.match(judgePrompt({ description: j.seen[0]!, provenance: { kind: "owner", message: "where is the Balboa course?" } }), /Förrlibuckstrasse/);
  assert.equal((await judgeAction({ description: "x", provenance: { kind: "owner", message: "add my flight" } }, async () => ({ decision: "fix", reason: "times" }))).decision, "fix");
});
