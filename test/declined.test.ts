import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { clearDeclined, declinedAgo, declinedLine, forgetDeclined, noteDeclined, resetDeclined } from "../src/approvals/declined.ts";
import { judgePrompt, type Verdict } from "../src/approvals/autojudge.ts";
import { factsOf, validateQuestion } from "../src/approvals/questionfacts.ts";
import { settings } from "../src/core/settings.ts";
import { TurnScope } from "../src/approvals/turnscope.ts";
import { readAudit } from "../src/core/audit.ts";

const CREATE = "mcp__claude_ai_Google_Calendar__create_event";
const DELETE = "mcp__claude_ai_Google_Calendar__delete_event";
const opts = { signal: new AbortController().signal } as never;
(settings as { autoApprove: string }).autoApprove = "auto";

const at9 = { summary: "Coffee", startTime: "2026-10-21T09:00:00", endTime: "2026-10-21T10:00:00" };
const at10 = { summary: "Coffee", startTime: "2026-10-21T10:00:00", endTime: "2026-10-21T11:00:00" };

test("a decline matches the same call and a near-equal one, for 30 minutes, in its own conversation", () => {
  resetDeclined();
  const t0 = 1_000_000;
  noteDeclined("owner", CREATE, at10, t0);
  assert.equal(declinedAgo("owner", CREATE, at10, t0 + 60_000), 60_000);
  assert.equal(declinedAgo("owner", CREATE, at9, t0 + 120_000), 120_000, "same title on the same day");
  assert.equal(declinedAgo("owner", CREATE, { ...at9, summary: "Dinner" }, t0), undefined, "another title");
  assert.equal(declinedAgo("owner", CREATE, { ...at9, startTime: "2026-10-22T09:00:00" }, t0), undefined, "another day");
  assert.equal(declinedAgo("owner", DELETE, at10, t0), undefined, "another tool");
  assert.equal(declinedAgo("g1", CREATE, at10, t0), undefined, "another conversation");
  assert.equal(declinedAgo("owner", CREATE, at10, t0 + 30 * 60_000), undefined, "expired");
  noteDeclined("owner", DELETE, { eventId: "abc123" }, t0);
  assert.notEqual(declinedAgo("owner", DELETE, { eventId: "ABC123", calendarId: "primary" }, t0), undefined, "the same id");
  assert.equal(declinedAgo("owner", DELETE, { eventId: "zzz" }, t0), undefined);
  clearDeclined("owner", DELETE, { eventId: "abc123" }, t0);
  assert.equal(declinedAgo("owner", DELETE, { eventId: "abc123" }, t0), undefined, "a yes clears it");
  forgetDeclined("owner");
  assert.equal(declinedAgo("owner", CREATE, at10, t0), undefined, "a new message of the owner's resets");
  assert.match(declinedLine(14 * 60_000), /^The owner declined this action 14 minutes ago\.$/);
});

test("the question must say how long ago the owner declined it", () => {
  const f = factsOf(at9, `Create event\n${declinedLine(14 * 60_000)}`);
  assert.ok(f.must.includes("14 min"));
  assert.equal(validateQuestion("Coffee 21 Oct 09:00-10:00 (declined 14 minutes ago). Go ahead?", { ...f, must: ["14 min"] }), undefined);
  assert.match(validateQuestion("Coffee again?", { ...f, must: ["14 min"] }) ?? "", /missing/);
});

// The incident: declined, then the same create comes back and the judge (misled by an older thumbs-up) says auto.
test("a declined create is never auto-approved by the judge: forced ask, audited as redeclined, the question says so", async () => {
  resetDeclined();
  const conv = "owner-incident";
  const judged: string[] = [];
  const judge = (async (i: { description: string }): Promise<Verdict> => (judged.push(i.description), { decision: "auto", reason: "his thumbs-up answered the proposed 9:00 time" })) as never;
  const asked: string[] = [];
  const answers = [false, false];
  const prov = () => ({ kind: "owner" as const, message: "add coffee tomorrow", earlier: ["Ben reacted 👍"] });
  const approve = async (description: string) => (asked.push(description), { approved: answers.shift()! });
  // the first create is judged ask and the owner says no
  const canAsk = makeCanUseTool(approve, "chat", undefined, (async () => ({ decision: "ask", reason: "mismatch" })) as never, undefined, undefined, false, { provenance: prov, conversation: conv });
  assert.equal((await canAsk(CREATE, at10, opts))!.behavior, "deny");
  assert.notEqual(declinedAgo(conv, CREATE, at10), undefined, "the plain no is on record");
  const canUse = makeCanUseTool(approve, "chat", undefined, judge, undefined, undefined, false, { provenance: prov, conversation: conv });
  // 20 seconds later the same chat agent tries again; the judge says auto
  const again = await canUse(CREATE, { ...at9, description: "x" }, opts);
  assert.equal(again!.behavior, "deny", "asked, and declined again");
  assert.equal(asked.length, 2);
  assert.match(asked[1]!, /The owner declined this action 1 minute ago\./);
  assert.match(judged.at(-1)!, /The owner declined this action 1 minute ago\./, "the judge reads the same line");
  const rows = readAudit((e) => e.decision === "redeclined");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.meta, { minutes: 1, judge: "auto" });
  // a new message of the owner's: the judge's auto stands again
  forgetDeclined(conv);
  assert.equal((await canUse(CREATE, { ...at9, description: "y" }, opts))!.behavior, "allow");
});

test("an approved call clears the decline, a reply (feedback) or silence is no decline", async () => {
  resetDeclined();
  const conv = "owner-clear";
  const out = [{ approved: false, feedback: "make it 9" }, { approved: false, expired: true as const }, { approved: false }, { approved: true }];
  const canUse = makeCanUseTool(async () => out.shift()!, "chat", undefined, (async () => ({ decision: "ask", reason: "x" })) as never, undefined, undefined, false, { provenance: () => ({ kind: "owner", message: "m" }), conversation: conv });
  await canUse(CREATE, at10, opts);
  assert.equal(declinedAgo(conv, CREATE, at10), undefined, "feedback");
  await canUse(CREATE, at10, opts);
  assert.equal(declinedAgo(conv, CREATE, at10), undefined, "expired");
  await canUse(CREATE, at10, opts);
  assert.notEqual(declinedAgo(conv, CREATE, at10), undefined, "a no");
  assert.equal((await canUse(CREATE, at10, opts))!.behavior, "allow");
  assert.equal(declinedAgo(conv, CREATE, at10), undefined, "a yes");
});

test("a reaction on a message from before the owner's latest message is marked for the judge", () => {
  const s = new TurnScope("owner");
  const t = 10_000_000;
  s.wrote(t - 40 * 60_000);
  s.say("Ben reacted 👍", "Shall I put coffee at 9:00?", t - 45 * 60_000); // on a message sent 45 min ago, owner wrote 40 min ago
  s.wrote(t - 5 * 60_000);
  s.say("add the coffee");
  const p = s.read(t) as unknown as { kind: "owner"; message: string; earlier: string[] };
  assert.equal(p.message, "add the coffee");
  assert.match(p.earlier[0]!, /^Ben reacted 👍 \[a reaction answers only the message it was on: this one was on a message from 45 min ago, and .* has written since\]$/);
  const prompt = judgePrompt({ description: "Create event", provenance: { ...p, source: "chat" } });
  assert.match(prompt, /has written since/);
  // a reaction on the newest thing the owner wrote is not marked
  const f = new TurnScope("owner");
  f.wrote(t - 10 * 60_000);
  f.say("Ben reacted 👍", "ok?", t - 2 * 60_000);
  assert.equal((f.read(t) as unknown as { message: string }).message, "Ben reacted 👍");
});
