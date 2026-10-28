import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOptions } from "../src/run/agentrun.ts";
import { BrowseGuard } from "../src/modules/browse/browseguard.ts";
import { sanitizeResult, shotCaptions } from "../src/modules/browse/browse.ts";
import { createPipeline, group, owner } from "../src/conversation/conversation.ts";
import { createOutbound } from "../src/conversation/outbound.ts";
import { classify } from "../src/policy/policy.ts";
import { adoptShots, newShotsDir, SHOT_TTL_MS, sweepShots } from "../src/modules/send/shots.ts";
import { sendNow, withSend, type Content } from "../src/modules/send/send.ts";
import { OWNER_KEY } from "../src/core/ownerkey.ts";
import { access } from "./util.ts";
import { FULL_CAPABILITIES } from "@ted-assistant/messenger/testing";
import { BROWSE_RUN, GROUP_CHAT, GROUP_LOOK, OWNER_CHAT, OWNER_LOOK } from "./runkinds.ts";

// send: the model's one way to say something mid-turn (text, voice note, picture, reaction). Text before a tool call is never sent.

const TOOL = "mcp__send__send";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const jpegResponse = (b: Buffer) => ({ content: [{ type: "text", text: "### Result" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b.toString("base64") } }] });

function shotsFrom(files: Buffer[]) {
  const dir = newShotsDir();
  const guard = new BrowseGuard({ mode: "owner", task: "t", outDir: dir, shotsDir: dir });
  for (const f of files) guard.keepShot(jpegResponse(f));
  return guard;
}

test("send_picture: the guard keeps only real jpeg bytes, under names code chooses", () => {
  const g = shotsFrom([JPEG, Buffer.from("not a picture at all"), JPEG]);
  assert.deepEqual(g.kept.map((k) => k.id), ["shot1", "shot2"]);
  assert.equal(new BrowseGuard({ mode: "owner", task: "t", outDir: "/tmp" }).keepShot(jpegResponse(JPEG)), undefined); // no shots folder: nothing kept
});


test("send: manifest and policy: free in a chat turn and in every conversation's look, the same floor", () => {
  assert.equal(access(TOOL, OWNER_CHAT), "free");
  assert.equal(classify(TOOL, { text: "On it." }, OWNER_CHAT), "allow");
  assert.equal(classify(TOOL, { text: "On it." }, GROUP_CHAT), "allow");
  assert.equal(access(TOOL, OWNER_LOOK), "free", "the owner's look: the same tool, the same floor");
  assert.equal(classify(TOOL, { text: "x" }, OWNER_LOOK), "allow");
  assert.equal(classify(TOOL, { text: "x" }, GROUP_LOOK), "allow");
});

test("send: every run of a conversation is given the tool server, the browse worker is not (and the old tools are gone)", () => {
  const base = { systemPrompt: "x", maxTurns: 1, maxBudgetUsd: 1 };
  const servers = (o: Parameters<typeof buildOptions>[1]) => Object.keys(buildOptions(async () => ({ approved: true }), o, undefined).mcpServers ?? {});
  assert.equal(servers({ ...base, kind: OWNER_CHAT, memory: { dir: "/tmp/n" } }).includes("send"), true);
  assert.equal(servers({ ...base, kind: GROUP_CHAT, memory: { dir: "/tmp/n", groupId: "g1" } }).includes("send"), true);
  assert.equal(servers({ ...base, kind: OWNER_LOOK }).includes("send"), true, "the owner's look speaks in her chat");
  assert.equal(servers({ ...base, kind: GROUP_LOOK, groupId: "g1" }).includes("send"), true);
  assert.equal(servers({ ...base, kind: BROWSE_RUN }).includes("send"), false);
  for (const old of ["tell", "picture"]) assert.equal(servers({ ...base, kind: OWNER_CHAT, memory: { dir: "/tmp/n" } }).includes(old), false, old);
  assert.equal(classify("mcp__tell__tell_user", { message: "x" }, GROUP_CHAT), "deny");
  assert.equal(classify("mcp__picture__send_picture", { id: "shot1" }, GROUP_CHAT), "deny");
});

test("send: the sink is found by conversation while the turn runs, and only then", async () => {
  assert.equal(await sendNow("g-x", { text: "hi" }), "Nobody to send it to right now.");
  await withSend("g-x", async () => "ok", async () => assert.equal(await sendNow("g-x", { text: "hi" }), "ok"));
  assert.equal(await sendNow("g-x", { text: "hi" }), "Nobody to send it to right now.");
});

test("send: exactly one kind of content per call; voice goes with text, caption with a picture, react is one emoji", async () => {
  const got: Content[] = [];
  await withSend(OWNER_KEY, async (c) => (got.push(c), "ok"), async () => {
    for (const bad of [{}, { text: "a", react: "👍" }, { text: "a", picture: "shot1" }, { voice: true }, { react: "👍", caption: "x" }, { text: "a", caption: "x" }, { react: "👍👍" }, { react: "hi" }]) {
      assert.notEqual(await sendNow(OWNER_KEY, bad), "ok", JSON.stringify(bad));
    }
    assert.equal(await sendNow(OWNER_KEY, { text: "a", voice: true }), "ok");
    assert.equal(await sendNow(OWNER_KEY, { react: " 👍 " }), "ok");
  });
  assert.deepEqual(got, [{ kind: "text", text: "a", voice: true }, { kind: "reaction", emoji: "👍" }]);
});

test("send: an id of this turn is sent; another id, a path and a traversal are refused; the files go when the turn ends", async () => {
  const g = shotsFrom([JPEG]);
  const sent: Content[] = [];
  let file = "";
  await withSend(OWNER_KEY, async (c) => (sent.push(c), c.kind === "picture" && (file = c.file), "ok"), async () => {
    const shots = adoptShots(OWNER_KEY, g.kept, { shot1: "the seat map" });
    assert.deepEqual(shots.map((s) => [s.id, s.caption]), [["shot1", "the seat map"]]);
    for (const bad of ["shot2", "../shot1", "/etc/passwd", "shot1.jpg", "../../x", "SHOT1"]) assert.match(await sendNow(OWNER_KEY, { picture: bad }), /No screenshot/, bad);
    assert.equal(await sendNow(OWNER_KEY, { picture: "shot1", caption: "Here" }), "ok");
    assert.deepEqual(sent.map((c) => c.kind === "picture" && [c.id, c.caption, c.size > 0]), [["shot1", "Here", true]]);
    assert.equal(existsSync(file), true);
  });
  assert.equal(existsSync(file), false);
  assert.match(await sendNow(OWNER_KEY, { picture: "shot1" }), /Nobody to send/);
});

test("send: another conversation's screenshots are not reachable", async () => {
  const g = shotsFrom([JPEG]);
  await withSend("g-a", async () => "ok", async () => {
    adoptShots("g-a", g.kept, {});
    await withSend("g-b", async () => assert.fail("must not send"), async () => assert.match(await sendNow("g-b", { picture: "shot1" }), /No screenshot available/));
  });
});

test("send: a symlink or a non-jpeg file in place of the screenshot is refused", async () => {
  const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "secret.jpg");
  writeFileSync(outside, JPEG);
  const g = shotsFrom([JPEG, JPEG]);
  await withSend(OWNER_KEY, async () => assert.fail("must not send"), async () => {
    const [a, b] = adoptShots(OWNER_KEY, g.kept, {});
    writeFileSync(a!.file, "GIF89a not a jpeg");
    assert.match(await sendNow(OWNER_KEY, { picture: "shot1" }), /not a jpeg/);
    rmSync(b!.file);
    symlinkSync(outside, b!.file);
    assert.match(await sendNow(OWNER_KEY, { picture: "shot2" }), /cannot be used/);
  });
});

test("send: old screenshot folders are swept after the TTL", () => {
  const dir = newShotsDir();
  sweepShots(Date.now());
  assert.equal(existsSync(dir), true);
  sweepShots(Date.now() + SHOT_TTL_MS + 60_000);
  assert.equal(existsSync(dir), false);
});

test("browse result: captions are cleaned and cut, odd ids dropped", () => {
  const c = shotCaptions({ shots: [{ id: "shot1", caption: "Seat map​" + "x".repeat(300) }, { id: "../x", caption: "bad" }, "junk"] });
  assert.deepEqual(Object.keys(c), ["shot1"]);
  assert.equal(c.shot1!.length <= 120, true);
  assert.equal(sanitizeResult({ status: "done", answer: "a", sources: [], shots: [{ id: "shot9", caption: "x" }] }, "", { steps: 1, commits: 0 }).shots, undefined); // the result names only screenshots code kept
});

function rig(o: { speech?: boolean; foreign?: string; synthFails?: boolean } = {}) {
  const sent: { text: string; attachments?: string[]; groupId?: string; quote?: unknown }[] = [];
  const reacted: { emoji: string; target: unknown; groupId?: string }[] = [];
  const typing: boolean[] = [];
  const spoken: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "voice-"));
  const messenger = {
    name: "fake",
    summary: "fake",
    self: "+1",
    capabilities: { ...FULL_CAPABILITIES, typing: false, readReceipts: false, groups: false, people: false, voice: false }, // Note to Self
    react: async (groupId: string | undefined, target: unknown, emoji: string) => void reacted.push({ emoji, target, groupId }),
    typing: async (_groupId: string | undefined, on: boolean) => void typing.push(!on),
    markRead: async () => {},
    send: async (groupId: string | undefined, m: { text: string; attachments?: { file: string }[]; quote?: unknown }) => (sent.push({ text: m.text, attachments: m.attachments?.map((a) => a.file), groupId, quote: m.quote }), sent.length),
  };
  const record = () => {};
  const pipeline = createPipeline({
    messenger,
    out: createOutbound(messenger, record),
    record,
    run: async () => ({ text: "" }),
    picture: async () => assert.fail("no picture"),
    document: async () => assert.fail("no document"),
    transcript: async () => "",
    speech: {
      ready: () => !!o.speech,
      synth: async (w) => {
        if (o.synthFails) throw new Error("no tts");
        spoken.push(w);
        mkdirSync(join(dir, String(spoken.length)));
        const f = join(dir, String(spoken.length), "v.wav");
        writeFileSync(f, "x");
        return f;
      },
      foreign: async () => o.foreign,
    },
    approvals: { answer: async () => ({ outcome: "none" as const }), answerReaction: () => "ignored" },
    vouch: async () => true,
    isOwner: () => true,
    wait: async () => {},
  });
  return { sent, reacted, typing, spoken, pipeline };
}

const TARGET = { author: "+2", timestamp: 77 };
const sentOf = (r: ReturnType<typeof rig>) => r.sent.map((s) => s.text || (s.attachments ? "<attachment>" : ""));

test("send: a heartbeat run (outside the queue) speaks through the same delivery, counts each piece, and gives a running chat turn its sink back", async () => {
  const r = rig();
  let counted = 0;
  const chatSink: string[] = [];
  await withSend(OWNER_KEY, async (c) => (chatSink.push(c.kind === "text" ? c.text : c.kind), "chat"), async () => {
    const out = await r.pipeline.sendWhile(owner(), async () => {
      assert.match(await sendNow(OWNER_KEY, { text: "Long task: halfway there." }), /Sent\./);
      assert.match(await sendNow(OWNER_KEY, { react: "👍" }), /Nothing to react to/, "no message is being answered in a look");
      return "run result";
    }, () => void counted++);
    assert.equal(out, "run result");
    assert.equal(await sendNow(OWNER_KEY, { text: "back in the chat turn" }), "chat", "the chat turn's own sink is back");
  });
  assert.deepEqual(r.sent.map((s) => s.text), ["Long task: halfway there."]);
  assert.equal(counted, 1, "only what was delivered is counted");
  assert.deepEqual(chatSink, ["back in the chat turn"]);
  assert.match(await sendNow(OWNER_KEY, { text: "x" }), /Nobody to send/, "and nothing is left behind afterwards");
});

test("send: text, voice note, reaction and picture, several in order, then the final reply still goes out; typing resumes after each", async () => {
  const r = rig({ speech: true });
  const g = shotsFrom([JPEG]);
  const told: string[] = [];
  const res = await r.pipeline.runTurn(owner(), {
    announce: false,
    target: TARGET,
    run: async () => {
      adoptShots(OWNER_KEY, g.kept, {});
      told.push(await sendNow(OWNER_KEY, { text: "On it, checking." }));
      told.push(await sendNow(OWNER_KEY, { text: "Spoken words here.", voice: true }));
      told.push(await sendNow(OWNER_KEY, { react: "👍" }));
      told.push(await sendNow(OWNER_KEY, { picture: "shot1", caption: "  The map " }));
      told.push(await sendNow(OWNER_KEY, { text: "[[silent]]" }), await sendNow(OWNER_KEY, { text: "   " }));
      told.push(await sendNow(OWNER_KEY, { text: "A third message, no cap." }));
      return { text: "The result." };
    },
  });
  assert.deepEqual(r.sent.map((s) => [s.text, s.attachments?.length ?? 0]), [["On it, checking.", 0], ["", 1], ["The map", 1], ["A third message, no cap.", 0], ["The result.", 0]]);
  assert.deepEqual(r.spoken, ["Spoken words here."]);
  assert.deepEqual(r.reacted.filter((x) => x.emoji !== "👀").map((x) => [x.emoji, x.target]), [["👍", TARGET]]); // the default target: the message being answered; the final ✅ does not replace it
  assert.deepEqual(told.map((t) => t.slice(0, 7)), ["Sent. C", "Sent as", "Reacted", "Sent sh", "Nothing", "Nothing", "Sent. C"]);
  assert.equal(res.spoke, true);
  assert.equal(r.typing.filter((s) => !s).length >= 6, true);
  assert.equal(r.typing[r.typing.length - 1], true);
});

test("send: the voice language safety net: foreign text, or no speech set up, goes out as text; a failed synth adds the note", async () => {
  for (const o of [{ speech: true, foreign: "de" }, { speech: false }]) {
    const r = rig(o);
    await r.pipeline.runTurn(owner(), { announce: false, run: async () => (await sendNow(OWNER_KEY, { text: "Guten Morgen, wie geht es dir heute?", voice: true }), { text: "[[silent]]" }) });
    assert.deepEqual(r.spoken, [], JSON.stringify(o));
    assert.deepEqual(sentOf(r), ["Guten Morgen, wie geht es dir heute?"], JSON.stringify(o));
  }
  const r = rig({ speech: true, synthFails: true });
  await r.pipeline.runTurn(owner(), { announce: false, run: async () => (await sendNow(OWNER_KEY, { text: "Hello there", voice: true }), { text: "[[silent]]" }) });
  assert.match(r.sent[0]!.text, /^Hello there\n\n\(voice didn't work/);
});

test("send: the final reply keeps its markers and is delivered through the same function, after tool sends", async () => {
  const r = rig({ speech: true });
  await r.pipeline.runTurn(owner(), { announce: false, target: TARGET, run: async () => (await sendNow(OWNER_KEY, { text: "Quick note." }), { text: "[[voice]]Final spoken words" }) });
  assert.deepEqual(r.spoken, ["Final spoken words"]);
  const r2 = rig();
  await r2.pipeline.runTurn(owner(), { announce: false, target: TARGET, run: async () => (await sendNow(OWNER_KEY, { text: "Quick note." }), { text: "[[react: 😂]] Ha." }) });
  assert.deepEqual(sentOf(r2), ["Quick note.", "Ha."]);
  assert.deepEqual(r2.reacted.filter((x) => x.emoji !== "👀").map((x) => x.emoji), ["😂"]);
  const r3 = rig();
  await r3.pipeline.runTurn(owner(), { announce: false, target: TARGET, run: async () => ({ text: "Plain." }) });
  assert.deepEqual(sentOf(r3), ["Plain."]); // no tool call needed
  assert.deepEqual(r3.reacted.filter((x) => x.emoji !== "👀").map((x) => x.emoji), ["✅"]);
});

test("send: a group turn sends everything to that group, with the group's quote rule; a reaction goes on the answered message", async () => {
  const r = rig({ speech: true });
  const g = shotsFrom([JPEG]);
  const quote = { text: "q", author: "+2", timestamp: 77 };
  await r.pipeline.runTurn(group("g1"), {
    announce: false,
    target: TARGET,
    threadUnder: quote as any,
    run: async () => {
      adoptShots("g1", g.kept, {});
      await sendNow("g1", { text: "Checking that for you." });
      await sendNow("g1", { text: "Voice words", voice: true });
      await sendNow("g1", { picture: "shot1" });
      await sendNow("g1", { react: "🙏" });
      return { text: "[[silent]]" };
    },
  });
  assert.deepEqual(r.sent.map((s) => [s.groupId, !!s.quote]), [["g1", true], ["g1", false], ["g1", true]]);
  assert.deepEqual(r.reacted.filter((x) => x.emoji !== "👀").map((x) => [x.emoji, x.groupId]), [["🙏", "g1"]]);
});

test("send: a reaction or wake-up turn is given no way to send", async () => {
  const r = rig();
  for (const kind of [{ reaction: true }, { background: true }]) {
    const g = shotsFrom([JPEG]);
    let told = "";
    await r.pipeline.runTurn(owner(), {
      announce: false,
      target: TARGET,
      ...kind,
      run: async () => {
        adoptShots(OWNER_KEY, g.kept, {});
        told = await sendNow(OWNER_KEY, { picture: "shot1" });
        return { text: "" };
      },
    });
    assert.match(told, /Nobody to send/);
  }
  assert.equal(r.sent.length, 0);
});

test("send: a reaction with nobody to react to says so; the turn still answers", async () => {
  const r = rig();
  let told = "";
  await r.pipeline.runTurn(owner(), { announce: false, run: async () => ((told = await sendNow(OWNER_KEY, { react: "👍" })), { text: "ok" }) });
  assert.match(told, /Nothing to react to/);
  assert.deepEqual(sentOf(r), ["ok"]);
});
