import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../src/core/paths.ts";

process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "forget-"));

const { settings } = await import("../src/core/settings.ts");
const { convPaths, conversationsDir, groupConvId, friendConvId, instancePaths } = await import("../src/core/convpaths.ts");
const { groupDir, recordGroup } = await import("../src/conversation/groupstore.ts");
const { forgetGroup, forgetFriend, resolveGroup } = await import("../src/conversation/forget.ts");
const { holdVoiceNote, voiceNotes, resetVoiceNotes } = await import("../src/modules/voice/voicenote.ts");
const { recordCost, groupSpentToday } = await import("../src/core/budget.ts");
const { markCapNotice, capNoticeDue, markNoticeAt, lastNoticeAt } = await import("../src/core/capnotice.ts");
const { addPending, openItems } = await import("../src/approvals/pending.ts");
const T = await import("../src/tenants/tenants.ts");
const { recordDone, readDone } = await import("../src/intake/intakelinks.ts");
const { scopeRoot, saveVoice } = await import("@ted-assistant/speech/tts");

const attachments = mkdtempSync(join(tmpdir(), "forget-att-"));
const GA = "Zm9yZ2V0LUE=";
const GB = "Zm9yZ2V0LUI=";
const NOW = 1_700_000_000_000;

// A group as the running agent makes one: its folder with notes and history, a cloned voice, a voice note, a pending approval, today's spend and the notice marks.
function group(id: string, name: string, tag: string) {
  const dir = groupDir(id, name);
  const p = convPaths(groupConvId(id));
  writeFileSync(join(p.notes, "context-x.md"), `${tag} note`);
  recordGroup(id, "member", NOW, `${tag}: hello`);
  saveVoice(scopeRoot(conversationsDir(), groupConvId(id)), "kid", { wav: new Uint8Array([1]), text: "t", meta: { created: "x", source: "voice note", seconds: 3 } }, 5);
  writeFileSync(join(attachments, `${tag}.aac`), "audio");
  holdVoiceNote(id, { ts: NOW, id: `${tag}.aac`, size: 5, by: "+1", snippet: "hi" }, NOW);
  addPending(id, { tool: "t", input: { a: tag }, label: "l", question: "q?", footer: "f", source: "group" }, NOW);
  recordCost(1.25, groupConvId(id), "chat");
  markCapNotice(`group:${groupConvId(id)}`);
  markCapNotice(`group-budget:${groupConvId(id)}`);
  markNoticeAt(`warn:${groupConvId(id)}`);
  return { id, dir, p };
}

test("forget group: its folder, voice-note audio, spend and notice marks go; another group's stay; running it again finds nothing left", () => {
  resetVoiceNotes();
  const a = group(GA, "Family", "a");
  const b = group(GB, "Work", "b");
  assert.equal(openItems(GA).length, 1);
  const r = forgetGroup("Family", { attachmentsDir: attachments });
  assert.ok(!("error" in r));
  assert.equal(r.conv, groupConvId(GA));
  assert.equal(existsSync(a.dir), false, "its folder: notes, history, session, pending, voices");
  assert.equal(existsSync(join(attachments, "a.aac")), false, "the audio signal-cli saved for its voice note");
  assert.equal(voiceNotes(GA, NOW).length, 0);
  assert.equal(groupSpentToday(GA), 0);
  assert.equal(capNoticeDue(`group:${groupConvId(GA)}`), true, "its notice mark is gone");
  assert.equal(lastNoticeAt(`warn:${groupConvId(GA)}`), undefined);
  for (const w of ["voice-note index", "folder", "voice-note audio", "spend", "notice marks"]) assert.ok(r.removed.some((x) => x.includes(w)), w);
  assert.deepEqual(r.failed, []);
  // the other group is untouched
  assert.equal(existsSync(b.dir), true);
  assert.equal(existsSync(join(b.p.notes, "context-x.md")), true);
  assert.equal(existsSync(join(attachments, "b.aac")), true);
  assert.equal(voiceNotes(GB, NOW).length, 1);
  assert.equal(groupSpentToday(GB), 1.25);
  assert.equal(capNoticeDue(`group:${groupConvId(GB)}`), false);
  assert.equal(openItems(GB).length, 1);
  // again, by the folder name: nothing is left and nothing fails
  const again = forgetGroup(groupConvId(GA), { attachmentsDir: attachments });
  assert.ok(!("error" in again));
  assert.deepEqual([again.removed, again.failed], [[], []]);
  assert.equal(existsSync(b.dir), true);
});

test("forget group: found by its name (any case) or its folder name; an unknown or ambiguous name is an error, not a guess", () => {
  resetVoiceNotes();
  group("Zm9yZ2V0LUM=", "Twin", "c");
  group("Zm9yZ2V0LUQ=", "twin", "d");
  const dup = resolveGroup("TWIN");
  assert.ok("error" in dup && /Several groups.*group-[0-9a-f]{16}/.test(dup.error));
  const none = resolveGroup("nobody");
  assert.ok("error" in none && /No group called "nobody"/.test(none.error));
  assert.ok(existsSync(convPaths(groupConvId("Zm9yZ2V0LUM=")).dir) && existsSync(convPaths(groupConvId("Zm9yZ2V0LUQ=")).dir), "an error removes nothing");
  assert.deepEqual(resolveGroup(groupConvId("Zm9yZ2V0LUM=")), { conv: groupConvId("Zm9yZ2V0LUM="), name: "Twin", id: "Zm9yZ2V0LUM=" });
  assert.ok("error" in forgetGroup("../etc"), "a path is never a name");
  assert.ok(!("error" in forgetGroup(groupConvId("Zm9yZ2V0LUM="), { attachmentsDir: attachments })));
  assert.equal(existsSync(convPaths(groupConvId("Zm9yZ2V0LUQ=")).dir), true);
});

test("forget friend: her registry entry, folder (voices, pending, history), audio, marks and notice marks; the owner and another friend stay", async () => {
  resetVoiceNotes();
  (settings as { tenants: boolean }).tenants = true;
  const mk = (n: number, name: string) => T.addTenant({ aci: `${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111`, name })!;
  const gone = mk(1, "Gina");
  const stay = mk(2, "Hal");
  for (const rec of [gone, stay]) {
    const p = convPaths(friendConvId(rec.id));
    writeFileSync(join(p.notes, "context-p.md"), "note");
    saveVoice(scopeRoot(conversationsDir(), friendConvId(rec.id)), "her", { wav: new Uint8Array([1]), text: "t", meta: { created: "x", source: "voice note", seconds: 3 } }, 5);
    writeFileSync(join(attachments, `${rec.id}.aac`), "audio");
    holdVoiceNote(`tenant:${rec.id}`, { ts: NOW, id: `${rec.id}.aac`, size: 5, by: "+1", snippet: "hi" }, NOW);
    addPending(`tenant:${rec.id}`, { tool: "t", input: { a: rec.id }, label: "l", question: "q?", footer: "f", source: "group" }, NOW);
    recordDone(rec.id, "google", [{ name: "token", chars: 3 }]);
    markCapNotice(`friend:${rec.id}`);
  }
  const r = await forgetFriend(gone.id, { attachmentsDir: attachments, secrets: [async () => 3] });
  assert.ok(r?.registry);
  assert.equal(existsSync(convPaths(friendConvId(gone.id)).dir), false, "her whole folder");
  assert.equal(existsSync(join(attachments, `${gone.id}.aac`)), false);
  assert.equal(readDone(gone.id, "google"), undefined);
  assert.equal(capNoticeDue(`friend:${gone.id}`), true);
  assert.ok(r.removed.some((x) => /secret-store items \(3\)/.test(x)));
  assert.equal(T.tenantById(gone.id), undefined);
  // the other friend and the owner's registry record
  assert.equal(existsSync(convPaths(friendConvId(stay.id)).notes), true);
  assert.equal(existsSync(join(attachments, `${stay.id}.aac`)), true);
  assert.ok(readDone(stay.id, "google"));
  assert.equal(capNoticeDue(`friend:${stay.id}`), false);
  assert.equal(openItems(`tenant:${stay.id}`).length, 1);
  assert.ok(T.tenantById(stay.id));
  // again: nothing left; the owner and odd ids are refused
  assert.deepEqual((await forgetFriend(gone.id, { attachmentsDir: attachments }))?.removed, []);
  assert.equal(await forgetFriend("owner"), undefined);
  assert.equal(await forgetFriend("../x"), undefined);
  assert.equal(existsSync(instancePaths().tenants), true);
});

// ---- the command ----

const run = (args: string[], dataDir: string) => spawnSync(process.execPath, ["--conditions=workspace-source", "scripts/forget.ts", ...args], { cwd: ROOT, env: { ...process.env, HARNESS_DATA_DIR: dataDir, OPENBAO_ADDR: "https://127.0.0.1:1", OPENBAO_TIMEOUT_SECONDS: "1" }, encoding: "utf8", timeout: 60_000 }); // (no secret store here: refused at once)

test("npm run forget: usage, a group by folder name or name, the owner and odd ids refused; idempotent; an old data folder refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "forget-cli-"));
  const conv = groupConvId("Zm9yZ2V0LUU=");
  mkdirSync(join(dir, "conversations", conv, "notes"), { recursive: true });
  writeFileSync(join(dir, "conversations", conv, "meta.json"), JSON.stringify({ id: "Zm9yZ2V0LUU=", name: "Eve group" }));
  writeFileSync(join(dir, "conversations", conv, "notes", "a.md"), "x");
  mkdirSync(join(dir, "instance"), { recursive: true });
  writeFileSync(join(dir, "instance", "layout-version"), "3\n");
  assert.equal(run([], dir).status, 1);
  assert.match(run(["group"], dir).stdout, /usage: npm run forget/);
  const byName = run(["group", "eve group"], dir);
  assert.equal(byName.status, 0, byName.stderr);
  assert.match(byName.stdout, new RegExp(`${conv} \\(Eve group\\): removed .*folder`));
  assert.equal(existsSync(join(dir, "conversations", conv)), false);
  const again = run(["group", conv], dir);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /nothing left to remove/);
  assert.equal(run(["group", "nobody"], dir).status, 1);
  assert.equal(run(["friend", "owner"], dir).status, 1);
  assert.equal(run(["friend", "../x"], dir).status, 1);
  // (a friend by the command waits for the secret store to come up, 30 s when there is none: the flow is tested above with the store handed in)
  // an old data folder is refused, like every tool
  const oldDir = mkdtempSync(join(tmpdir(), "forget-old-"));
  mkdirSync(join(oldDir, "tenants", "zed-1"), { recursive: true });
  const o = run(["group", conv], oldDir);
  assert.equal(o.status, 1);
  assert.match(o.stderr, /old layout/);
});
