import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPipeline, owner } from "../src/conversation/conversation.ts";
import { createOutbound } from "../src/conversation/outbound.ts";
import { startDeadline } from "../src/core/deadline.ts";
import { noteSleep } from "../src/core/sleep.ts";
import { createVoiceLanguage } from "../src/conversation/lang.ts";
import { VOICE_FAILED_NOTE } from "../src/conversation/voicereply.ts";
import { FULL_CAPABILITIES } from "@ted-assistant/messenger/testing";
import type { SynthLimits } from "@ted-assistant/speech/tts";

// The overall deadline of a voice reply (VOICE_TIMEOUT_SECONDS): fake clock, fake engine, fake messenger. Over it the engine is aborted, a stale file is never sent, the words go out as text.

function rig(o: { synth: (limits: SynthLimits | undefined, file: () => string) => Promise<string>; sendVoice?: () => Promise<void>; foreign?: (words: string, conversation: string) => Promise<string | undefined> }) {
  const sent: string[] = [];
  const voices: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "voicedl-"));
  const clock = { t: 1_000_000, m: 5_000, tick: undefined as (() => void) | undefined, stopped: 0, advance(ms: number) { this.t += ms; this.m += ms; } }; // t: the Date clock, m: the monotonic one (it stands still while the Mac sleeps)
  const messenger = {
    name: "fake",
    summary: "fake",
    self: "+1",
    capabilities: { ...FULL_CAPABILITIES, typing: false, readReceipts: false, groups: false, people: false, voice: true },
    react: async () => {},
    typing: async () => {},
    markRead: async () => {},
    send: async (_g: string | undefined, m: { text: string; attachments?: { file: string }[] }) => {
      if (m.attachments?.length) {
        await o.sendVoice?.();
        voices.push(m.attachments[0]!.file);
      } else sent.push(m.text);
      return 1;
    },
  };
  let files = 0;
  const makeFile = () => {
    const d = join(dir, String(++files));
    mkdirSync(d);
    const f = join(d, "v.m4a");
    writeFileSync(f, "x");
    return f;
  };
  const pipeline = createPipeline({
    messenger,
    out: createOutbound(messenger, () => {}, { pauseMs: 0 }),
    record: () => {},
    run: async () => ({ text: "" }),
    picture: async () => assert.fail("no picture"),
    document: async () => assert.fail("no document"),
    transcript: async () => "",
    speech: {
      ready: () => true,
      synth: (_w, _c, limits) => o.synth(limits, makeFile),
      foreign: o.foreign ?? (async () => undefined),
      timeoutMs: 75_000,
      deadline: (ms) => startDeadline(ms, { now: () => clock.t, mono: () => clock.m, setInterval: (f) => ((clock.tick = f), 1), clearInterval: () => void clock.stopped++ }),
    },
    approvals: { answer: async () => ({ outcome: "none" as const }), answerReaction: () => "ignored" },
    vouch: async () => true,
    isOwner: () => true,
    wait: async () => {},
  });
  return { pipeline, sent, voices, clock, makeFile };
}

async function say(r: ReturnType<typeof rig>, words = "Good morning, you have two meetings today."): Promise<string[]> {
  const logged: string[] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    await r.pipeline.runTurn(owner(), { announce: false, run: async () => ({ text: `[[voice]] ${words}` }) });
  } finally {
    console.error = err;
  }
  return logged;
}

test("voice deadline: the normal path is unchanged: one voice note, no text, no log line, the watch ended", async () => {
  const r = rig({ synth: async (_l, file) => file() });
  const logged = await say(r);
  assert.equal(r.voices.length, 1);
  assert.deepEqual(r.sent, []);
  assert.deepEqual(logged, []);
  assert.equal(r.clock.stopped >= 1, true);
});

test("voice deadline: when it runs out the engine is aborted, the words go out as text with the note, and one line says why", async () => {
  let limits: SynthLimits | undefined;
  const r = rig({
    synth: (l) => {
      limits = l;
      return new Promise((_res, rej) => l!.signal!.addEventListener("abort", () => rej(l!.signal!.reason), { once: true })); // like a child process killed on abort
    },
  });
  const turn = say(r);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(limits!.remainingMs!(), 75_000);
  r.clock.advance(76_000);
  r.clock.tick!();
  const logged = await turn;
  assert.equal(limits!.signal!.aborted, true);
  assert.deepEqual(r.voices, []);
  assert.deepEqual(r.sent, ["Good morning, you have two meetings today.", VOICE_FAILED_NOTE]); // (the note is its own message)
  assert.deepEqual(logged.filter((l) => l.startsWith("voice")), ["voice skipped: took longer than 75 s, sending text"]);
});

test("voice deadline: a file that arrives after the deadline is never sent, and its folder is deleted", async () => {
  let file = "";
  const r = rig({
    synth: async (_l, make) => {
      r.clock.advance(80_000); // the clock moved on while it worked (no poll ran in between)
      return (file = make());
    },
  });
  const logged = await say(r);
  assert.deepEqual(r.voices, [], "the stale file is not handed to the messenger");
  assert.equal(r.sent.length, 2); // the words and the note
  assert.match(r.sent[0]!, /Good morning/);
  assert.equal(existsSync(dirname(file)), false);
  assert.deepEqual(logged.filter((l) => l.startsWith("voice")), ["voice skipped: took longer than 75 s, sending text"]);
});

test("voice deadline: a slow upload is covered too, and an engine error that is not the deadline keeps its own line", async () => {
  const slow = rig({ synth: async (_l, file) => file(), sendVoice: () => new Promise(() => {}) });
  const turn = say(slow);
  await new Promise((res) => setTimeout(res, 20));
  slow.clock.advance(76_000);
  slow.clock.tick!();
  assert.deepEqual((await turn).filter((l) => l.startsWith("voice")), ["voice skipped: took longer than 75 s, sending text"]);
  assert.equal(slow.sent.length, 2);
  const broken = rig({ synth: async () => { throw new Error("no tts"); } });
  assert.deepEqual(await say(broken), ["voice reply failed, sending text: no tts"]);
  assert.match(broken.sent[1]!, /voice didn't work/);
});

// The language check runs under the same deadline, and a check that fails does not cost the voice.

test("voice language: a detection that fails still speaks (the voice's language is assumed, one log line); a hanging one is cut by the deadline", async () => {
  const foreign = createVoiceLanguage(["en"], async () => { throw new Error("haiku timeout"); }, console);
  const r = rig({ synth: async (_l, file) => file(), foreign });
  const logged = await say(r, "Good morning, you have two meetings today and the first one is at ten thirty.");
  assert.equal(r.voices.length, 1);
  assert.deepEqual(r.sent, []);
  assert.deepEqual(logged, ["voice: the language of the reply could not be told, speaking it as en"]);
  const hang = rig({ synth: async () => assert.fail("not reached"), foreign: () => new Promise(() => {}) });
  const turn = say(hang);
  await new Promise((res) => setTimeout(res, 20));
  hang.clock.advance(76_000);
  hang.clock.tick!();
  assert.deepEqual((await turn).filter((l) => l.startsWith("voice")), ["voice skipped: took longer than 75 s, sending text"]);
  assert.deepEqual(hang.sent, ["Good morning, you have two meetings today.", VOICE_FAILED_NOTE]);
  const german = rig({ synth: async () => assert.fail("not reached"), foreign: async () => "de" });
  assert.deepEqual(await say(german), ["voice skipped: reply looks de, the voice speaks en; sending text"]);
  assert.deepEqual(german.sent, ["Good morning, you have two meetings today."], "a foreign language is plain text, no note");
});

// A sleeping Mac: the Date clock runs on while the monotonic one stands still.

test("voice sleep: a sleep during synthesis is noticed by the deadline's own check, the engine is aborted and the words go out as text", async () => {
  let limits: SynthLimits | undefined;
  const r = rig({
    synth: (l) => {
      limits = l;
      return new Promise((_res, rej) => l!.signal!.addEventListener("abort", () => rej(l!.signal!.reason), { once: true }));
    },
  });
  const turn = say(r);
  await new Promise((res) => setTimeout(res, 20));
  r.clock.t += 18 * 60_000; // the lid was closed for 18 minutes: the monotonic clock did not move
  r.clock.m += 1000;
  r.clock.tick!(); // the first poll after the wake-up
  const logged = await turn;
  assert.equal(limits!.signal!.aborted, true);
  assert.deepEqual(r.voices, []);
  assert.match(r.sent[0]!, /^Good morning/);
  assert.deepEqual(logged.filter((l) => l.startsWith("voice")), ["voice skipped: the Mac slept, sending text"]);
});

test("voice sleep: a file that finishes in the moment of the wake-up is stale and never sent; a sleep in the upload is covered too", async () => {
  let file = "";
  const r = rig({
    synth: async (_l, make) => {
      r.clock.t += 18 * 60_000; // (no poll ran: the work simply finished first)
      return (file = make());
    },
  });
  assert.deepEqual((await say(r)).filter((l) => l.startsWith("voice")), ["voice skipped: the Mac slept, sending text"]);
  assert.deepEqual(r.voices, []);
  assert.equal(existsSync(dirname(file)), false);
  const up = rig({ synth: async (_l, make) => make(), sendVoice: () => new Promise(() => {}) });
  const turn = say(up);
  await new Promise((res) => setTimeout(res, 20));
  up.clock.t += 18 * 60_000;
  up.clock.tick!();
  assert.deepEqual((await turn).filter((l) => l.startsWith("voice")), ["voice skipped: the Mac slept, sending text"]);
  assert.equal(up.sent.length, 2);
});

test("voice sleep: the shared signal of the tick aborts a synthesis in flight; one that starts after the wake-up is unaffected", async () => {
  const r = rig({ synth: (l) => new Promise((_res, rej) => l!.signal!.addEventListener("abort", () => rej(l!.signal!.reason), { once: true })) });
  const turn = say(r);
  await new Promise((res) => setTimeout(res, 20));
  noteSleep();
  assert.deepEqual((await turn).filter((l) => l.startsWith("voice")), ["voice skipped: the Mac slept, sending text"]);
  const after = rig({ synth: async (_l, file) => file() });
  assert.deepEqual(await say(after), []);
  assert.equal(after.voices.length, 1);
});

test("deadline: jitter is not a sleep, time left counts the larger clock, and a sleep is told from an expiry", () => {
  const c = { t: 0, m: 0, tick: () => {} };
  const env = (tick?: boolean) => ({ now: () => c.t, mono: () => c.m, parent: new AbortController().signal, setInterval: (f: () => void) => (tick && (c.tick = f), 1), clearInterval: () => {} });
  const d = startDeadline(75_000, env(true));
  c.t += 3000;
  c.m += 1000; // two seconds of drift
  c.tick();
  assert.equal(d.signal.aborted, false);
  assert.equal(d.remainingMs(), 72_000);
  c.t += 72_000;
  c.m += 72_000;
  assert.throws(() => d.check(), (x: { kind: string }) => x.kind === "timeout");
  const e = startDeadline(75_000, env());
  c.t += 600_000;
  c.m += 1000;
  assert.throws(() => e.check(), (x: { kind: string }) => x.kind === "slept");
  assert.equal(e.remainingMs(), 0);
});

// The regression of 22-23 Oct: the late-file clean-up ran before the reply's own file was recorded and deleted it, so every voice reply failed with
// "voice.m4a (No such file or directory)" and went out as text. A file that is made in time must still exist when the messenger reads it.
test("a voice file made in time is still on disk when the messenger sends it, and is removed afterwards", async () => {
  let made = "";
  let existedAtSend = false;
  const r = rig({
    synth: async (_l, file) => (made = file()),
    sendVoice: async () => void (existedAtSend = existsSync(made)),
  });
  const logged = await say(r);
  assert.equal(existedAtSend, true, "the file is there when the messenger reads it");
  assert.deepEqual(r.voices, [made], "sent as a voice note");
  assert.equal(logged.some((l) => /voice reply failed|No such file/.test(l)), false, logged.join("\n"));
  assert.equal(existsSync(dirname(made)), false, "removed after the send");
});
