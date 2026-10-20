import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIEF_INSTRUCTIONS, briefInstructions, runBriefAttempt } from "../src/brief.ts";
import { heartbeatDetail, mailCheck, requiredSkills } from "../src/doctor.ts";
import { mailbirdCheck } from "../src/modules/runtime.ts";
import { startHeartbeat, type MailSource } from "../src/heartbeat.ts";
import { LAST_BRIEF, missingSetup, setupItems } from "../src/notes.ts";
import { backgroundSystem, briefSystem, chatContext, chatSystem, ownerGateDefaults, radarSystem } from "../src/persona.ts";
import { hiddenTools } from "../src/policy.ts";
import { offeredSkills } from "../src/profiles.ts";
import { loadSettings, settings } from "../src/settings.ts";
import { dataPath, readJson } from "../src/state.ts";

// MAIL_PROVIDER: mailbird is the default and behaves exactly as before (test/default-prompts.test.ts pins its prompts); none is chat only.

test("settings: MAIL_PROVIDER defaults to mailbird, accepts none, accepts gmail, rejects anything else", () => {
  const d = loadSettings({});
  assert.equal(d.mailProvider, "mailbird");
  assert.equal(d.mail, true);
  assert.ok(!d.hiddenConnectors.includes("mcp__mailbird"), "the default keeps Mailbird visible");
  assert.equal(loadSettings({ MAIL_PROVIDER: "mailbird" }).mail, true);
  assert.equal(loadSettings({ MAIL_PROVIDER: "" }).mailProvider, "mailbird");
  const none = loadSettings({ MAIL_PROVIDER: "none" });
  assert.equal(none.mailProvider, "none");
  assert.equal(none.mail, false);
  assert.ok(none.hiddenConnectors.includes("mcp__mailbird"), "without mail the Mailbird server is hidden from the model");
  assert.ok(none.hiddenConnectors.includes("mcp__claude_ai_Gmail"), "the usual hidden connectors stay hidden");
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

test("heartbeat without mail: no mail client is made, nothing is triaged, liveness is written, one start-up line", async () => {
  await withMail(false, async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      const timers: (() => void)[] = [];
      let made = 0;
      const touched: string[] = [];
      const forbidden = new Proxy({}, { get: (_t, name) => () => (touched.push(String(name)), assert.fail("the mail client was used")) }) as unknown as MailSource;
      const ran: string[] = [];
      const hb = startHeartbeat(
        {
          alert: async () => touched.push("alert") as unknown as void,
          handle: () => void touched.push("handle"),
          briefDue: () => false,
          onTick: () => void ran.push("jobs"), // wake-ups, the brief and the radar start from here and need no mail check
        },
        { newMail: () => (made++, forbidden), setTimeout: (f) => void timers.push(f), setInterval: (f) => void timers.push(f) },
      );
      assert.equal(made, 0, "no Mailbird is constructed");
      assert.equal(timers.length, 2);
      assert.ok(lines.includes("mail: off (MAIL_PROVIDER=none)"));
      const before = lines.length;
      timers[0]!();
      await new Promise((r) => setTimeout(r, 20));
      timers[1]!();
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(ran, ["jobs", "jobs"], "the tick jobs still start");
      assert.deepEqual(touched, []);
      assert.equal(lines.length, before, "nothing is logged per tick");
      const beat = readJson<{ lastTickAt?: string }>("state/heartbeat.json", {});
      assert.ok(beat.lastTickAt && Date.now() - Date.parse(beat.lastTickAt) < 5000, "doctor sees the heartbeat ticking");
      void hb;
    } finally {
      console.log = log;
    }
  });
});

test("heartbeat with mail still makes its client (the default is unchanged)", async () => {
  await withMail(true, async () => {
    const log = console.log;
    console.log = () => {};
    try {
      let made = 0;
      const fake = { inboxes: async () => [], call: async () => [], close: async () => {} } as unknown as MailSource;
      startHeartbeat({ alert: async () => {}, handle: () => {}, briefDue: () => false, onTick: () => {} }, { newMail: () => (made++, fake), setTimeout: () => {}, setInterval: () => {} });
      assert.equal(made, 1);
    } finally {
      console.log = log;
    }
  });
});

const BRIEF_TEXT = "## 🎯 Focus\n\n- **Ship the thing**\n\n## 📅 Today\n\n- 10:00 standup";

function attempt(delivery: "email" | "signal", text: string, tool?: unknown) {
  const calls = { sent: [] as string[], completed: 0, notified: 0 };
  const log = console.log;
  console.log = () => {};
  const done = runBriefAttempt(
    {
      run: async (_p, onToolSuccess) => (tool !== undefined && onToolSuccess("mcp__mailbird__send_self_briefing", tool), { text, costUsd: 0.5 }),
      sendBrief: async (md) => void calls.sent.push(md),
      notify: async () => void calls.notified++,
      delivery,
    },
    "prompt",
    1,
    () => void calls.completed++,
  ).finally(() => (console.log = log));
  return done.then((outcome) => ({ outcome, ...calls }));
}

test("brief without mail: the final text is the brief, marked complete, sent as the Signal summary, saved as memory", async () => {
  const r = await attempt("signal", `${BRIEF_TEXT}\n\nROUTINE_COMPLETE`);
  assert.equal(r.outcome, "delivered");
  assert.equal(r.completed, 1);
  assert.deepEqual(r.sent, [BRIEF_TEXT]);
  assert.equal(readFileSync(dataPath(LAST_BRIEF), "utf8"), BRIEF_TEXT);
});

test("brief without mail: no marker, or only the marker, is incomplete (retried by the existing rules, not delivered)", async () => {
  for (const text of [BRIEF_TEXT, "ROUTINE_COMPLETE", "  \nROUTINE_COMPLETE\n"]) {
    const r = await attempt("signal", text);
    assert.equal(r.outcome, "incomplete", text);
    assert.equal(r.completed + r.sent.length, 0);
  }
});

test("brief with mail (the default): the final text alone does not complete it, the email tool must have run", async () => {
  const noTool = await attempt("email", `${BRIEF_TEXT}\n\nROUTINE_COMPLETE`);
  assert.equal(noTool.outcome, "incomplete");
  assert.equal(noTool.completed + noTool.sent.length, 0);
  const withTool = await attempt("email", "ROUTINE_COMPLETE", { markdownBody: BRIEF_TEXT });
  assert.equal(withTool.outcome, "delivered");
  assert.deepEqual(withTool.sent, [BRIEF_TEXT]);
});

test("brief instructions: the mail ones are unchanged, the chat-only ones name no mail tool", () => {
  assert.equal(briefInstructions(true), BRIEF_INSTRUCTIONS);
  assert.match(BRIEF_INSTRUCTIONS, /send_self_briefing/);
  const none = briefInstructions(false);
  assert.doesNotMatch(none, /send_self_briefing|mailbird:/i);
  assert.match(none, /ROUTINE_COMPLETE/);
});

test("doctor without mail: 'mail: off' is OK, Mailbird is never contacted, no mail skill is required, the heartbeat line is fine", async () => {
  const lines: [unknown, string, string | undefined][] = [];
  const line = (ok: boolean | "warn", what: string, detail?: string) => void lines.push([ok, what, detail]);
  await mailCheck(line, false, async () => assert.fail("must not connect"));
  assert.deepEqual(lines, [[true, "mail: off", "MAIL_PROVIDER=none, chat only"]]);
  assert.ok(!requiredSkills(false).includes("mailbird"));
  assert.ok(requiredSkills(true).includes("mailbird"));
  assert.equal(heartbeatDetail({ lastTickAt: "2026-10-12T09:00:00Z" }, 3.2, false, false, () => "x"), "last tick 3 min ago; mail off");
  assert.equal(heartbeatDetail({ lastTickAt: "2026-10-12T09:00:00Z" }, 3.2, false, true, () => "x"), "last tick 3 min ago; last new mail none yet");
  assert.equal(heartbeatDetail({}, Infinity, false, false, () => "x"), "no tick recorded yet");
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
  const all = offeredSkills(true);
  const none = offeredSkills(false);
  assert.equal(all.length, 12);
  assert.deepEqual(none, all.filter((s) => !/:mailbird/.test(s)));
  assert.equal(none.length, 10);
});

test("prompts without mail: no mail skill, tool or reply-draft text; the one 'no email here' sentence is there", () => {
  const down = [] as const;
  const missing = missingSetup([], [], false);
  const prompts = {
    chat: chatSystem(new Date("2026-10-12T09:00:00"), false),
    brief: briefSystem("MEMORY", missing, down, false),
    radar: radarSystem("MEMORY", missing, down, false),
    background: backgroundSystem("MEMORY", missing, down, false),
  };
  const sentence = /There is no email in this setup[^\n]*?mail is off here\./;
  for (const [name, p] of Object.entries(prompts)) {
    assert.match(p, sentence, name);
    const rest = p.replace(sentence, "");
    assert.doesNotMatch(rest, /mailbird|Reply ready|send_message_now|update_draft|get_message|draft|inbox|by email|email drafts|writes email/i, `${name} still talks about mail`);
    assert.doesNotMatch(rest, /ted-personal-assistant:mailbird/, name);
    assert.match(rest, /ted-personal-assistant:daily-brief/, name); // the other skills are still listed
  }
  assert.doesNotMatch(prompts.chat, /how you write|voice \(how/i);
  const context = chatContext({ lastBrief: "yesterday's brief", missing, down, pings: ["10:00 an alert"] }, false)!; // what moved out of the chat's system prompt
  assert.match(context, /Signal only got a short version/);
  assert.doesNotMatch(context, /mailbird|Reply ready|send_message_now|update_draft|get_message|inbox|by email|email drafts|writes email|handled mail/i);
  const gate = ownerGateDefaults({ briefHour: 7, backstopHour: 9, radarMinutes: 180, radar: true, minGapMinutes: 60, mail: false });
  assert.doesNotMatch(gate, /mail/i);
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
