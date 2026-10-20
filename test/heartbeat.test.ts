import { test } from "node:test";
import assert from "node:assert/strict";
import { sleep } from "./util.ts";
const tick = () => sleep(10);
import { startHeartbeat, startJobs, type MailSource } from "../src/heartbeat.ts";
import { settings } from "../src/settings.ts";

// The heartbeat's mail check and the tick jobs (wake-ups, dream, brief, radar) are independent: a failing or hanging one
// never keeps another from running.


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
      radar: () => void ran.push("radar"),
    });
    await tick();
  } finally {
    console.error = was;
  }
  assert.deepEqual(ran, ["wake", "brief", "radar"]);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => /throws: tick failed: sync boom/.test(e)) && errors.some((e) => /rejects: tick failed: async boom/.test(e)));
});

test("heartbeat: a failing mail check does not skip the tick jobs, and a hanging job does not block the mail check", async () => {
  const s = settings as unknown as Record<string, unknown>;
  const was = { quietStartHour: s.quietStartHour, quietEndHour: s.quietEndHour };
  Object.assign(s, { quietStartHour: 0, quietEndHour: 0 }); // never "night" for this test
  const timers: (() => void)[] = [];
  let inboxCalls = 0;
  const mail: MailSource = {
    inboxes: async () => (inboxCalls++, Promise.reject(new Error("Mailbird is down"))),
    call: async () => assert.fail("not reached"),
    close: async () => {},
  } as unknown as MailSource;
  const ran: string[] = [];
  const quiet = console.error;
  const errors: string[] = [];
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  const log = console.log;
  console.log = () => {};
  try {
    const hb = startHeartbeat(
      {
        alert: async () => {},
        handle: () => {},
        briefDue: () => false,
        onTick: () => startJobs({
          wake: () => void ran.push("wake"),
          dream: () => { throw new Error("dream broke"); },
          brief: () => new Promise(() => {}), // takes "minutes"
          radar: async () => void ran.push("radar"),
        }),
      },
      { mail, setTimeout: (f) => void timers.push(f), setInterval: (f) => void timers.push(f) },
    );
    assert.equal(timers.length, 2); // the first-tick timer and the interval, both ours
    timers[0]!(); // the timer fires
    await tick();
    assert.equal(inboxCalls, 1, "the mail check ran (and failed)");
    assert.deepEqual(ran, ["wake", "radar"], "a failing mail check, a throwing job and a hanging job skipped nothing");
    assert.ok(errors.some((e) => /heartbeat error: Mailbird is down/.test(e)));
    timers[1]!(); // the next tick: mail still tried, jobs still start (the hanging brief is simply started again)
    await tick();
    assert.equal(inboxCalls, 2);
    assert.deepEqual(ran, ["wake", "radar", "wake", "radar"]);
    void hb;
  } finally {
    console.error = quiet;
    console.log = log;
    Object.assign(s, was);
  }
});

// The alert is written by the notice writer from the facts; when that fails the template still goes out.
for (const [name, write, expected] of [
  ["a written alert is sent", async () => "Dana is waiting on your signature.", /^Dana is waiting/],
  ["a failing writer still alerts with the template", async (): Promise<string> => { throw new Error("boom"); }, /^📥 1 email needs you:/],
] as const) {
  test(`heartbeat: ${name}`, async () => {
    const s = settings as unknown as Record<string, unknown>;
    const was = { quietStartHour: s.quietStartHour, quietEndHour: s.quietEndHour, mail: s.mail };
    Object.assign(s, { quietStartHour: 0, quietEndHour: 0, mail: true });
    const { writeJson, readJson } = await import("../src/state.ts");
    const seenBefore = readJson("state/seen.json", undefined);
    writeJson("state/seen.json", { seededAt: "2026-01-01T00:00:00.000Z", keys: {} });
    const row = { conversationId: "c1", subject: "Contract", lastSender: "Dana", receivedAtUtc: "2026-10-14T09:00:00", lastMessageId: 7 };
    const mail = {
      inboxes: async () => [{ email: "me@x.org", folderId: "f", senderName: "Me" }],
      call: async (n: string) => (n === "list_conversations" ? [row] : { body: "please sign", from: { displayName: "Dana", email: "d@x.org" } }),
      close: async () => {},
    } as unknown as MailSource;
    const sent: string[] = [];
    const log = console.log;
    console.log = () => {};
    try {
      const hb = startHeartbeat(
        { alert: async (t) => void sent.push(t), write, handle: () => {}, briefDue: () => false, onTick: () => {} },
        { mail, triage: async (m) => m.map(() => ({ label: "act_now" as const, kind: "personal_or_work" as const, reason: "waiting", protected: false })), setTimeout: () => 0, setInterval: () => 0 },
      );
      await hb.mailCheck();
    } finally {
      console.log = log;
      Object.assign(s, was);
      writeJson("state/seen.json", seenBefore ?? { keys: {} });
    }
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, expected);
  });
}

test("heartbeat: a usage limit leaves the mail unseen, so the next tick classifies it", async () => {
  const { failure } = await import("../src/errors.ts"); // (the cooldown is noted where the call fails)
  const { writeJson, readJson } = await import("../src/state.ts");
  const s = settings as unknown as Record<string, unknown>;
  const was = { quietStartHour: s.quietStartHour, quietEndHour: s.quietEndHour, mail: s.mail };
  Object.assign(s, { quietStartHour: 0, quietEndHour: 0, mail: true });
  const seenBefore = readJson("state/seen.json", undefined);
  writeJson("state/seen.json", { seededAt: "2026-01-01T00:00:00.000Z", keys: {} });
  const row = { conversationId: "c1", subject: "Contract", lastSender: "Dana", receivedAtUtc: "2026-10-14T09:00:00", lastMessageId: 7 };
  const mail = {
    inboxes: async () => [{ email: "me@x.org", folderId: "f", senderName: "Me" }],
    call: async (n: string) => (n === "list_conversations" ? [row] : { body: "please sign", from: { displayName: "Dana", email: "d@x.org" } }),
    close: async () => {},
  } as unknown as MailSource;
  let calls = 0;
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const hb = startHeartbeat(
      { alert: async () => {}, handle: () => {}, briefDue: () => false, onTick: () => {} },
      { mail, triage: async () => { calls++; throw failure("rate_limit", "success"); }, setTimeout: () => 0, setInterval: () => 0 },
    );
    const { coolingDown, resetCooldown } = await import("../src/cooldown.ts");
    await hb.mailCheck();
    assert.ok(coolingDown(), "the limit starts the cooldown");
    await hb.mailCheck();
    assert.equal(calls, 1, "no model call while cooling down");
    resetCooldown();
    await hb.mailCheck();
    assert.equal(calls, 2, "tried again once the cooldown is over: the mail stayed unseen");
  } finally {
    console.log = log;
    console.error = err;
    Object.assign(s, was);
    writeJson("state/seen.json", seenBefore ?? { keys: {} });
  }
});
