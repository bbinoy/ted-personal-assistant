import { test } from "node:test";
import assert from "node:assert/strict";
import type { Verdict } from "../src/autojudge.ts";
import { makeCanUseTool, setChatOwnerMessage } from "../src/permissions.ts";
import { CHAT } from "./util.ts";

const noJudge = async (): Promise<Verdict> => ({ decision: "ask", reason: "test" });
const opts = { signal: new AbortController().signal } as never;

test("a failed approval (no question, unreadable reply) is returned to the agent, never executed, and the re-asks are capped", async () => {
  let asked = 0;
  const canUse = makeCanUseTool(async () => (asked++, { approved: false, failure: "no question could be written" }), "chat", undefined, undefined, noJudge);
  const call = { summary: "Dinner", startTime: "2026-11-20T19:00:00", attendees: ["a@example.com"] };
  const tool = "mcp__claude_ai_Google_Calendar__create_event";
  for (let i = 0; i < 2; i++) {
    const r = (await canUse(tool, call, opts)) as { behavior: string; message: string };
    assert.equal(r.behavior, "deny");
    assert.match(r.message, /could not be confirmed: no question could be written\. Nothing was executed/);
  }
  const capped = (await canUse(tool, call, opts)) as { behavior: string; message: string };
  assert.equal(capped.behavior, "deny");
  assert.match(capped.message, /not asked again/);
  assert.equal(asked, 2, "the owner is not asked a third time");
  assert.equal((await canUse(tool, { ...call, summary: "Lunch" }, opts))!.behavior, "deny"); // a different call is asked on its own
  assert.equal(asked, 3);
});

test("the owner's words come back with a failed reading, so the agent can act on them", async () => {
  const canUse = makeCanUseTool(async () => ({ approved: false, feedback: "sounds fine, hmm", failure: "the owner's reply could not be read as a yes or no" }), "chat", undefined, undefined, noJudge);
  const r = (await canUse("mcp__claude_ai_Google_Calendar__create_event", { summary: "Tea", startTime: "2026-11-21T15:00:00", attendees: ["b@example.com"] }, opts)) as { behavior: string; message: string };
  assert.equal(r.behavior, "deny");
  assert.match(r.message, /sounds fine, hmm/);
});

test("opening a web page: in every place the judge may skip the question for a plain address, and the floor still asks for any other", async () => {
  const auto = async (): Promise<Verdict> => ({ decision: "auto", reason: "the owner asked for it" });
  for (const source of ["chat", "background", "brief", "radar", "handler"] as const) {
    let asked = 0;
    const canUse = makeCanUseTool(async () => (asked++, { approved: true }), source, undefined, "look up the opening hours", auto, undefined, undefined, false, source === "chat" ? CHAT : {});
    setChatOwnerMessage("what are the opening hours of the post office?");
    assert.equal((await canUse("WebFetch", { url: `https://www.example.com/${source}`, prompt: "hours" }, opts))!.behavior, "allow", source);
    assert.equal(asked, 0, `${source}: a plain page that serves the request is not asked about`);
    await canUse("WebFetch", { url: "http://127.0.0.1:8080/x", prompt: "hours" }, opts);
    assert.equal(asked, 1, `${source}: an address the floor refuses is still asked about`);
  }
});
