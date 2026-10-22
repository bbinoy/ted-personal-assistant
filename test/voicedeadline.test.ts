import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPipeline, owner } from "../src/conversation/conversation.ts";
import { createOutbound } from "../src/conversation/outbound.ts";
import { startDeadline } from "../src/core/deadline.ts";
import { VOICE_FAILED_NOTE } from "../src/conversation/voicereply.ts";
import { FULL_CAPABILITIES } from "@ted-assistant/messenger/testing";
import type { SynthLimits } from "@ted-assistant/speech/tts";

// The overall deadline of a voice reply (VOICE_TIMEOUT_SECONDS): fake clock, fake engine, fake messenger. Over it the engine is aborted, a stale file is never sent, the words go out as text.

function rig(o: { synth: (limits: SynthLimits | undefined, file: () => string) => Promise<string>; sendVoice?: () => Promise<void> }) {
  const sent: string[] = [];
  const voices: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "voicedl-"));
  const clock = { t: 1_000_000, tick: undefined as (() => void) | undefined, stopped: 0 };
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
    out: createOutbound(messenger, () => {}),
    record: () => {},
    run: async () => ({ text: "" }),
    picture: async () => assert.fail("no picture"),
    document: async () => assert.fail("no document"),
    transcript: async () => "",
    speech: {
      ready: () => true,
      synth: (_w, _c, limits) => o.synth(limits, makeFile),
      foreign: async () => undefined,
      timeoutMs: 75_000,
      deadline: (ms) => startDeadline(ms, { now: () => clock.t, setInterval: (f) => ((clock.tick = f), 1), clearInterval: () => void clock.stopped++ }),
    },
    approvals: { answer: async () => ({ outcome: "none" as const }), answerReaction: () => "ignored" },
    vouch: async () => true,
    isOwner: () => true,
    admitGroup: async () => {},
    wait: async () => {},
  });
  return { pipeline, sent, voices, clock, makeFile };
}

async function say(r: ReturnType<typeof rig>): Promise<string[]> {
  const logged: string[] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    await r.pipeline.runTurn(owner(), { announce: false, run: async () => ({ text: "[[voice]] Good morning, you have two meetings today." }) });
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
  r.clock.t += 76_000;
  r.clock.tick!();
  const logged = await turn;
  assert.equal(limits!.signal!.aborted, true);
  assert.deepEqual(r.voices, []);
  assert.deepEqual(r.sent, [`Good morning, you have two meetings today.\n\n${VOICE_FAILED_NOTE}`]);
  assert.deepEqual(logged.filter((l) => l.startsWith("voice")), ["voice skipped: took longer than 75 s, sending text"]);
});

test("voice deadline: a file that arrives after the deadline is never sent, and its folder is deleted", async () => {
  let file = "";
  const r = rig({
    synth: async (_l, make) => {
      r.clock.t += 80_000; // the clock moved on while it worked (no poll ran in between)
      return (file = make());
    },
  });
  const logged = await say(r);
  assert.deepEqual(r.voices, [], "the stale file is not handed to the messenger");
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0]!, /Good morning/);
  assert.equal(existsSync(dirname(file)), false);
  assert.deepEqual(logged.filter((l) => l.startsWith("voice")), ["voice skipped: took longer than 75 s, sending text"]);
});

test("voice deadline: a slow upload is covered too, and an engine error that is not the deadline keeps its own line", async () => {
  const slow = rig({ synth: async (_l, file) => file(), sendVoice: () => new Promise(() => {}) });
  const turn = say(slow);
  await new Promise((res) => setTimeout(res, 20));
  slow.clock.t += 76_000;
  slow.clock.tick!();
  assert.deepEqual((await turn).filter((l) => l.startsWith("voice")), ["voice skipped: took longer than 75 s, sending text"]);
  assert.equal(slow.sent.length, 1);
  const broken = rig({ synth: async () => { throw new Error("no tts"); } });
  assert.deepEqual(await say(broken), ["voice reply failed, sending text: no tts"]);
  assert.match(broken.sent[0]!, /voice didn't work/);
});
