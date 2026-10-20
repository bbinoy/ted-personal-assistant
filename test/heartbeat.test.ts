import { test } from "node:test";
import assert from "node:assert/strict";
import { sleep } from "./util.ts";
const tick = () => sleep(10);
import { createMailCheck, startHeartbeat, startJobs, type MailContext, type MailSource } from "../src/heartbeat.ts";
import { settings } from "../src/settings.ts";
import { readJson, writeJson } from "../src/state.ts";

// The heartbeat tick and the jobs it starts (wake-ups, dream, brief, the friends' mail checks) are independent: a failing or hanging one never keeps another from
// running. The mail check below is a friend's (mailloops.ts): the owner's own proactive work is the heartbeat run (test/heartbeatrun.test.ts).

test("startJobs: a job that throws (sync or async) or never finishes does not stop the others", async () => {
  const ran: string[] = [];
  const errors: string[] = [];
  const was = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    startJobs({
      throws: () => { throw new Error("sync boom"); },
      rejects: async () => { throw new Error("async boom"); },
      hangs: () => new Promise(() => {}), // a slow job: never awaited
      wake: () => void ran.push("wake"),
      brief: async () => void ran.push("brief"),
      mail: () => void ran.push("mail"),
    });
    await tick();
  } finally {
    console.error = was;
  }
  assert.deepEqual(ran, ["wake", "brief", "mail"]);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => /throws: tick failed: sync boom/.test(e)) && errors.some((e) => /rejects: tick failed: async boom/.test(e)));
});

test("heartbeat: the tick starts its jobs, a throwing or hanging job skips nothing, and the liveness line is written (also at night)", async () => {
  const timers: (() => void)[] = [];
  const ran: string[] = [];
  const quiet = console.error;
  const log = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    const hb = startHeartbeat(
      {
        onTick: () => startJobs({
          wake: () => void ran.push("wake"),
          dream: () => { throw new Error("dream broke"); },
          brief: () => new Promise(() => {}), // takes "minutes"
          mail: async () => void ran.push("mail"),
        }),
      },
      { setTimeout: (f) => void timers.push(f), setInterval: (f) => void timers.push(f) },
    );
    assert.equal(timers.length, 2); // the first-tick timer and the interval, both ours
    timers[0]!();
    await tick();
    assert.deepEqual(ran, ["wake", "mail"]);
    assert.ok(readJson<{ lastTickAt?: string }>("state/heartbeat.json", {}).lastTickAt, "proof of life for doctor");
    timers[1]!();
    await tick();
    assert.deepEqual(ran, ["wake", "mail", "wake", "mail"]);
    void hb;
  } finally {
    console.error = quiet;
    console.log = log;
  }
});

// A friend's mail check: her files, a fake small model, a fake mailbox.
const row = { conversationId: "c1", subject: "Contract", lastSender: "Dana", receivedAtUtc: "2026-10-14T09:00:00", lastMessageId: 7 };
const mailbox = {
  inboxes: async () => [{ email: "me@x.org", folderId: "f", senderName: "Me" }],
  call: async (n: string) => (n === "list_conversations" ? [row] : { body: "please sign", from: { displayName: "Dana", email: "d@x.org" } }),
  close: async () => {},
} as unknown as MailSource;
const context = (name: string, triage: MailContext["triage"], blocked: () => boolean = () => false): MailContext => ({
  files: { seen: `state/${name}-seen.json`, liveness: `state/${name}-live.json` },
  triage,
  record: () => {},
  handler: () => false,
  blocked,
});
const quietHours = <T>(f: () => Promise<T>): Promise<T> => {
  const s = settings as unknown as Record<string, unknown>;
  const was = { quietStartHour: s.quietStartHour, quietEndHour: s.quietEndHour };
  Object.assign(s, { quietStartHour: 0, quietEndHour: 0 }); // never "night" for this test
  return f().finally(() => Object.assign(s, was));
};

test("a friend's mail check: an act_now mail goes out as the plain template alert", () =>
  quietHours(async () => {
    writeJson("state/alert-seen.json", { seededAt: "2026-01-01T00:00:00.000Z", keys: {} });
    const sent: string[] = [];
    const log = console.log;
    console.log = () => {};
    try {
      const check = createMailCheck(mailbox, context("alert", async (m) => m.map(() => ({ label: "act_now" as const, kind: "personal_or_work" as const, reason: "waiting", protected: false }))), { alert: async (t) => void sent.push(t), handle: () => {} });
      await check();
    } finally {
      console.log = log;
    }
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /^📥 1 email needs you:/);
  }));

test("a friend's mail check: a usage limit leaves the mail unseen, so the next tick classifies it", () =>
  quietHours(async () => {
    const { failure } = await import("../src/errors.ts"); // (the cooldown is noted where the call fails)
    const { coolingDown, resetCooldown } = await import("../src/cooldown.ts");
    writeJson("state/limit-seen.json", { seededAt: "2026-01-01T00:00:00.000Z", keys: {} });
    let calls = 0;
    const log = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      const check = createMailCheck(mailbox, context("limit", async () => { calls++; throw failure("rate_limit", "success"); }, () => coolingDown()), { alert: async () => {}, handle: () => {} });
      await check();
      assert.ok(coolingDown(), "the limit starts the cooldown");
      await check();
      assert.equal(calls, 1, "no model call while cooling down");
      resetCooldown();
      await check();
      assert.equal(calls, 2, "tried again once the cooldown is over: the mail stayed unseen");
    } finally {
      console.log = log;
      console.error = err;
    }
  }));
