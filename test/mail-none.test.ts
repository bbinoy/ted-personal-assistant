import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { heartbeatDetail, mailCheck, requiredSkills } from "../src/doctor.ts";
import { mailbirdCheck } from "../src/modules/runtime.ts";
import { HEARTBEAT_KEY, startHeartbeat } from "../src/heartbeat/heartbeat.ts";
import { missingSetup, setupItems } from "../src/modules/index.ts";
import { chatContext, chatSystem } from "../src/run/persona.ts";
import { hiddenTools } from "../src/policy/policy.ts";
import { ownerSkills } from "../src/modules/skills.ts";
import { loadSettings, settings } from "../src/core/settings.ts";
import { kvGet } from "../src/core/instancedb.ts";

// MAIL_PROVIDER: mailbird is the default and behaves exactly as before (test/default-prompts.test.ts pins its prompts); none is chat only.

test("settings: MAIL_PROVIDER defaults to mailbird, accepts none, accepts gmail, rejects anything else", () => {
  const d = loadSettings({});
  assert.equal(d.mailProvider, "mailbird");
  assert.equal(d.mail, true);
  assert.ok(!hiddenTools([], d).includes("mcp__mailbird"), "the default keeps Mailbird visible");
  assert.equal(loadSettings({ MAIL_PROVIDER: "mailbird" }).mail, true);
  assert.equal(loadSettings({ MAIL_PROVIDER: "" }).mailProvider, "mailbird");
  const none = loadSettings({ MAIL_PROVIDER: "none" });
  assert.equal(none.mailProvider, "none");
  assert.equal(none.mail, false);
  assert.ok(hiddenTools([], none).includes("mcp__mailbird"), "without mail the Mailbird server is hidden from the model");
  assert.ok(hiddenTools([], none).includes("mcp__claude_ai_Gmail"), "the usual hidden connectors stay hidden");
  assert.equal(loadSettings({ MAIL_PROVIDER: "gmail" }).mailProvider, "gmail"); // test/gmail.test.ts covers the rest
  assert.throws(() => loadSettings({ MAIL_PROVIDER: "imap" }), /MAIL_PROVIDER must be one of none, mailbird, gmail \(got "imap"\)/);
  assert.ok(hiddenTools(["mcp__mailbird__get_message"], none).includes("mcp__mailbird"));
});

// Runs `f` with the mail provider switched (settings is read at call time everywhere that matters) and the night rule off.
async function withMail<T>(mail: boolean, f: () => Promise<T> | T): Promise<T> {
  const s = settings as unknown as Record<string, unknown>;
  const was = { mail: s.mail, mailProvider: s.mailProvider, quietStartHour: s.quietStartHour, quietEndHour: s.quietEndHour };
  Object.assign(s, { mail, mailProvider: mail ? "mailbird" : "none", quietStartHour: 0, quietEndHour: 0 });
  try {
    return await f();
  } finally {
    Object.assign(s, was);
  }
}

test("heartbeat tick without mail: the jobs start and the liveness line is written", async () => {
  await withMail(false, async () => {
    const log = console.log;
    console.log = () => {};
    try {
      const timers: (() => void)[] = [];
      const ran: string[] = [];
      const hb = startHeartbeat(
        { onTick: () => void ran.push("jobs") }, // wake-ups and the brief start from here and need no mail check
        { setTimeout: (f) => void timers.push(f), setInterval: (f) => void timers.push(f) },
      );
      assert.equal(timers.length, 2);
      timers[0]!();
      await new Promise((r) => setTimeout(r, 20));
      timers[1]!();
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(ran, ["jobs", "jobs"], "the tick jobs still start");
      const beat = kvGet<{ lastTickAt?: string }>(HEARTBEAT_KEY, {});
      assert.ok(beat.lastTickAt && Date.now() - Date.parse(beat.lastTickAt) < 5000, "doctor sees the heartbeat ticking");
      void hb;
    } finally {
      console.log = log;
    }
  });
});

test("the brief's delivery sentence is in the chat's and the expert's prompt: the mail provider's own, or the chat alone without mail", async () => {
  const { chatSystem, expertSystem } = await import("../src/run/persona.ts");
  await withMail(true, () => {
    assert.match(chatSystem(true), /How to deliver the daily brief: .*send_self_briefing/);
    assert.match(expertSystem("", { mail: true }), /How to deliver the daily brief: .*send_self_briefing/, "the expert that sends the brief sees it");
  });
  await withMail(false, () => {
    const none = expertSystem("", { mail: false });
    assert.doesNotMatch(none, /send_self_briefing|mailbird:/i);
    assert.match(none, /How to deliver the daily brief: there is no email in this setup, so your final answer is the whole brief itself/);
  });
});

test("doctor without mail: 'mail: off' is OK, Mailbird is never contacted, no mail skill is required, the heartbeat line is fine", async () => {
  const lines: [unknown, string, string | undefined][] = [];
  const line = (ok: boolean | "warn", what: string, detail?: string) => void lines.push([ok, what, detail]);
  await mailCheck(line, false, async () => assert.fail("must not connect"));
  assert.deepEqual(lines, [[true, "mail: off", "MAIL_PROVIDER=none, chat only"]]);
  assert.ok(!requiredSkills(false).includes("mail") && !requiredSkills(false).includes("mailbird"));
  assert.ok(requiredSkills(true).includes("mail") && requiredSkills(true).includes("mailbird"));
  assert.equal(heartbeatDetail({ lastTickAt: "2026-10-12T09:00:00Z" }, 3.2, undefined, () => "x"), "last tick 3 min ago; last look none yet");
  assert.equal(heartbeatDetail({ lastTickAt: "2026-10-12T09:00:00Z" }, 3.2, "2026-10-12T09:00:00Z", () => "x"), "last tick 3 min ago; last look x");
  assert.equal(heartbeatDetail({}, Infinity, undefined, () => "x"), "no tick recorded yet");
  // With mail, a reachable client is OK and an unreachable one still FAILS.
  lines.length = 0;
  await mailbirdCheck(line, async () => 2);
  await mailbirdCheck(line, async () => { throw new Error("no ~/.claude.json"); });
  assert.deepEqual(lines.map((l) => l[0]), [true, false]);
});

test("doctor: `npm run doctor` with MAIL_PROVIDER=none and no Mailbird anywhere reports mail off and checks nothing of Mailbird", () => {
  // The real command in a child with an empty home and data dir. Other checks (signal-cli, launchd) may FAIL on a bare machine;
  // what matters is that mail is reported as off and Mailbird is never mentioned.
  const r = spawnSync(process.execPath, ["--conditions=workspace-source", "src/cli.ts", "doctor"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { PATH: "/usr/bin:/bin", // no claude, no signal-cli: nothing real is started
      HOME: mkdtempSync(join(tmpdir(), "doctor-home-")), MAIL_PROVIDER: "none", HARNESS_DATA_DIR: mkdtempSync(join(tmpdir(), "doctor-data-")) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.match(r.stdout, /ok +mail: off +\(MAIL_PROVIDER=none, chat only\)/, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /Mailbird MCP/);
  assert.doesNotMatch(r.stdout, /skill mailbird/);
  assert.match(r.stdout, /ok +skill daily-brief \(bundled\)/);
});

test("offered skills: without mail the two mail skills are gone, the rest are unchanged", () => {
  const all = ownerSkills(true);
  const none = ownerSkills(false);
  assert.equal(all.length, 15);
  assert.deepEqual(none, all.filter((s) => !/:mail(bird)?$/.test(s)));
  assert.equal(none.length, 13);
});

test("prompts without mail: no mail skill, tool or reply-draft text; the one 'no email here' sentence is there", () => {
  const missing = missingSetup([], [], false);
  const prompts = {
    chat: chatSystem(false),
  };
  const sentence = /There is no email in this setup[^\n]*?mail is off here\./;
  for (const [name, p] of Object.entries(prompts)) {
    assert.match(p, sentence, name);
    const rest = p.replace(sentence, "");
    assert.doesNotMatch(rest, /mailbird|Reply ready|send_message_now|update_draft|get_message|draft|inbox|by email|email drafts|writes email/i, `${name} still talks about mail`);
    assert.doesNotMatch(rest, /ted-personal-assistant:mail/, name);
    assert.match(rest, /ted-personal-assistant:daily-brief/, name); // the other skills are still listed
  }
  assert.doesNotMatch(prompts.chat, /how you write|voice \(how/i);
  const context = chatContext({ missing }, false)!; // what moved out of the chat's system prompt
  assert.doesNotMatch(context, /mailbird|Reply ready|send_message_now|update_draft|get_message|inbox|by email|email drafts|writes email|handled mail/i);
});

test("setup items without mail: the writing-voice item (email drafts) is not asked for, the rest are", () => {
  const all = missingSetup([], [], true);
  const none = missingSetup([], [], false);
  assert.equal(all.length, setupItems().length);
  assert.deepEqual(none, all.filter((l) => !/email drafts/.test(l)));
  assert.equal(none.length, setupItems().length - 1);
  assert.ok(none.every((l) => !/mail|writ/i.test(l)));
  // Connector gaps still drop their own items.
  assert.equal(missingSetup([], ["notion"], false).length, 1);
});
