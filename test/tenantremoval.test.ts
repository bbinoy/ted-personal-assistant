import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Removing a friend takes all of her data, not only her folder: voices, voice-note index and audio, intake marks, secret-store items. Idempotent, and a
// secret store that refuses is a printed admin command, never a failed removal.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "removal-test-"));

const { settings } = await import("../src/core/settings.ts");
const T = await import("../src/tenants/tenants.ts");
const { adminCommand } = await import("../src/tenants/removal.ts");
const { removeFriend: removeTenant } = await import("../src/conversation/tenantremoval.ts");
const { saveVoice, scopeRoot } = await import("@ted-assistant/speech/tts");
const { conversationsDir, friendConvId } = await import("../src/core/convpaths.ts");
const { holdVoiceNote, voiceNotes, resetVoiceNotes } = await import("../src/modules/voice/voicenote.ts");
const { recordDone, markNeedsReconnect, readDone, connectionState } = await import("../src/intake/intakelinks.ts");
const { deleteTenantItems } = await import("../src/secrets/secrets.ts");
const { addPending, openItems } = await import("../src/approvals/pending.ts");
const { dataPath } = await import("../src/core/state.ts");
const { tenantKey } = await import("../src/core/ownerkey.ts");
const { OpenBao } = await import("../src/secrets/openbao.ts");

(settings as { tenants: boolean }).tenants = true;
const ACI = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111`;
const voiceRoot = conversationsDir();
const attachmentsDir = mkdtempSync(join(tmpdir(), "att-"));

function friend(name: string, n: number) {
  const rec = T.addTenant({ aci: ACI(n), name })!;
  const key = tenantKey(rec.id);
  saveVoice(scopeRoot(voiceRoot, friendConvId(rec.id)), "her-voice", { wav: new Uint8Array([1, 2]), text: "hi", meta: { created: "x", source: "voice note", seconds: 3 } }, 5);
  writeFileSync(join(attachmentsDir, `${rec.id}-note.aac`), "audio");
  holdVoiceNote(key, { ts: Date.now(), id: `${rec.id}-note.aac`, size: 5, by: ACI(n), snippet: "secret words" });
  recordDone(rec.id, "google", [{ name: "token", chars: 3 }]);
  markNeedsReconnect(rec.id, "notion");
  addPending(key, { tool: "mcp__mail__send", input: { to: "a@example.com" }, label: "mail", question: "q", footer: "", source: "background" }, 1000);
  return { rec, key };
}

test("removal: her folder (voices, pending approvals), voice-note index and audio, intake marks and registry entry all go; another friend's stay", async () => {
  resetVoiceNotes();
  const gone = friend("Gina", 1);
  const stay = friend("Hal", 2);
  const items: string[] = [];
  const r = await removeTenant(gone.rec.id, { attachmentsDir, secrets: [async (id) => (items.push(id), 2)] });
  assert.ok(r?.registry);
  assert.deepEqual(items, [gone.rec.id]);
  assert.equal(r?.manual, undefined);
  assert.equal(existsSync(scopeRoot(voiceRoot, friendConvId(gone.rec.id))), false, "her cloned voices");
  assert.equal(existsSync(convPaths(friendConvId(gone.rec.id)).db), false, "her assistant.db (session, pending approvals, voice-note snippets, bookkeeping) went with the folder, closed first");
  assert.equal(existsSync(convPaths(friendConvId(gone.rec.id)).dir), false);
  assert.equal(existsSync(join(attachmentsDir, `${gone.rec.id}-note.aac`)), false, "the audio signal-cli saved");
  assert.equal(readDone(gone.rec.id, "google"), undefined);
  assert.equal(connectionState(gone.rec.id, "notion").state, "none");
  assert.equal(T.tenantById(gone.rec.id), undefined);
  assert.ok(r?.removed.some((x) => /voice-note index/.test(x)) && r.removed.some((x) => /secret-store items \(2\)/.test(x)));
  // the other friend is untouched
  assert.ok(existsSync(scopeRoot(voiceRoot, friendConvId(stay.rec.id))));
  assert.equal(voiceNotes(stay.key).length, 1);
  assert.ok(existsSync(join(attachmentsDir, `${stay.rec.id}-note.aac`)));
  assert.ok(readDone(stay.rec.id, "google"));
  assert.equal(openItems(stay.key).length, 1, "her pending approvals");
  assert.ok(T.tenantById(stay.rec.id));
});

test("removal: idempotent, the owner and odd ids refused, a refusing secret store gives the admin command and does not fail the removal", async () => {
  const f = friend("Ivy", 3);
  const refuse = async () => {
    throw new Error("403");
  };
  const first = await removeTenant(f.rec.id, { attachmentsDir, secrets: [refuse] });
  assert.ok(first?.registry);
  assert.equal(first?.manual?.includes(adminCommand(f.rec.id)), true);
  assert.equal(existsSync(scopeRoot(voiceRoot, friendConvId(f.rec.id))), false, "the rest still happened");
  // again, now the second source (the admin's root) works: the leftover is removed, nothing else is claimed
  const again = await removeTenant(f.rec.id, { attachmentsDir, secrets: [refuse, async () => 1] });
  assert.equal(again?.registry, false);
  assert.equal(again?.manual, undefined);
  assert.deepEqual(again?.removed, ["her secret-store items (1)"]);
  assert.deepEqual((await removeTenant(f.rec.id, { attachmentsDir }))?.removed, []);
  assert.equal(await removeTenant("owner"), undefined);
  assert.equal(await removeTenant("../x"), undefined);
});

test("deleteTenantItems: lists every kind under tenants/<id>/ and deletes each item; the owner's folder is refused", async () => {
  const store = new Map<string, unknown>([["tenants/zed/google/oauth", {}], ["tenants/zed/notion/oauth", {}], ["tenants/other/google/oauth", {}]]);
  const bao = new OpenBao({
    addr: "http://127.0.0.1:1",
    mount: "ted",
    token: async () => "t",
    fetcher: async (url, init) => {
      const path = new URL(url).pathname.replace("/v1/ted/", "");
      if (init.method === "GET" && path.startsWith("metadata/") && url.includes("list=true")) {
        const p = path.slice("metadata/".length) + "/";
        const keys = [...store.keys()].filter((k) => k.startsWith(p)).map((k) => k.slice(p.length));
        return { status: keys.length ? 200 : 404, text: async () => JSON.stringify({ data: { keys } }) };
      }
      const p = path.replace(/^(metadata|data)\//, "");
      if (init.method === "GET") return { status: store.has(p) ? 200 : 404, text: async () => "{}" };
      if (init.method === "DELETE") return store.delete(p), { status: 204, text: async () => "" };
      return { status: 500, text: async () => "" };
    },
  });
  assert.equal(await deleteTenantItems(bao, "zed"), 2);
  assert.deepEqual([...store.keys()], ["tenants/other/google/oauth"]);
  await assert.rejects(deleteTenantItems(bao, "owner"));
});
