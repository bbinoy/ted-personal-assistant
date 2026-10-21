import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// A data folder as it was before layout version 2, with every kind of file: the owner, two friends, two groups (and one with no id, one history with no folder), cloned voices, voice-note
// sources, pending approvals, the process-wide files and some things that belong to nobody. The names are written out here ON PURPOSE (not taken from core/convpaths.ts): the test
// checks the migration against what the old code really wrote.

export const GID_A = "Zm9vLWdyb3VwLUE=";
export const GID_B = "Zm9vLWdyb3VwLUI=";
export const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
export const key12 = (id: string): string => sha(id).slice(0, 12);
export const hash16 = (s: string): string => sha(s).slice(0, 16);
export const FRIENDS = ["anna-1a2b", "bo-3c4d"] as const;
export const UNKNOWN_HASH = "0123456789abcdef";

export interface Old {
  root: string;
  put: (rel: string, text: string) => void;
}

export function buildOld(root: string): Old {
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const day = "2026-10-20";
  // the owner
  put("memory/notes/MEMORY.md", "- [style](style-x.md)\n");
  put("memory/notes/style-x.md", "---\nname: x\n---\nshort\n");
  put("state/session.json", '{"sessionId":"owner-s"}');
  put("state/held-posts.json", '{"day":"d","posted":0,"held":[]}');
  put("state/seen-mail.json", '{"ids":["m1"]}');
  put("state/dream.json", '{"day":"d"}');
  put("state/quiet.json", "");
  put("state/pending-owner.json", '{"next":2,"items":[],"expired":[],"blocked":[]}');
  put("state/search.sqlite", "SQLITE-OWNER");
  put("state/search.sqlite-journal", "JOURNAL");
  put("state/notes-backup/2026-01-01/a.md", "old note\n");
  put("logs/messages.jsonl", '{"ts":1,"at":"2026-10-20T10:00:00.000Z","kind":"owner","text":"hello"}\n');
  put("logs/messages.jsonl.corrupt-2026-01-01T00-00-00-000Z", "broken\n");
  // process-wide
  put("state/tenants.json", JSON.stringify({ tenants: FRIENDS.map((id) => ({ id })) }));
  put("state/tenants.json.corrupt-2026-01-01T00-00-00-000Z", "{");
  put("state/registrations.json", "{}");
  put("state/intake/abc123.json", "{}");
  put("state/intake-status.json", "{}");
  put("state/intake-problems.json", "{}");
  put("state/cap-notices.json", JSON.stringify({ day, keys: [`group:${GID_A}`, "friend:anna-1a2b", "owner:instance", `group-budget:${GID_B}`], at: { [`warn:${GID_A}`]: 1, "warn:owner": 2, "warn:tenant:anna-1a2b": 3, "key:expired": 4 } }));
  put("state/cost.json", `{"day":"${day}","usd":1.5}`);
  put("state/key-cost.json", `{"day":"${day}","usd":0.5}`);
  put("state/group-cost.json", JSON.stringify({ day, usd: { [GID_A]: 1.5, [GID_B]: 2 } }));
  put("state/heartbeat.json", '{"lastTickAt":"2026-10-20T10:00:00.000Z"}');
  put("state/heartbeat.jsonl", '{"at":"2026-10-20T10:00:00.000Z"}\n');
  put("state/heartbeat.jsonl.1", '{"at":"2026-10-19T10:00:00.000Z"}\n');
  put("state/connectors.json", '{"at":"x"}');
  put("state/tools-seen.json", '["a"]');
  put("state/notion-client.json", '{"client_id":"c"}');
  put("state/payments.jsonl", '{"id":"p1"}\n');
  put("state/card.disabled", "off\n");
  put("state/paused", "");
  put("state/shore/1.0000_2.0000.json", "[]");
  put("state/browse/run-1/page.md", "a page");
  put("state/browse/shots/run-1/shot1.jpg", "jpeg");
  // installed software stays; the default voice's reference clip is the user's own file
  put("state/openbao/config.hcl", "listener");
  put("state/openbao/data/vault.db", "db");
  put("state/tts-qwen/venv/pyvenv.cfg", "home = /x");
  put("state/voice/ref.wav", "RIFF-DEFAULT");
  put("state/voice/ref.txt", "the default words");
  // voices: the owner's library, a group's, a friend's, one of nobody's
  put("state/voice/active.json", '{"name":"mine"}');
  put("state/voice/voices/mine/ref.wav", "RIFF-MINE");
  put("state/voice/voices/mine/ref.txt", "mine words");
  put("state/voice/voices/mine/meta.json", '{"created":"x"}');
  put(`state/voice/groups/${hash16(GID_A)}/active.json`, '{"name":"kid"}');
  put(`state/voice/groups/${hash16(GID_A)}/voices/kid/ref.wav`, "RIFF-KID");
  put(`state/voice/groups/${hash16(GID_A)}/voices/kid/ref.txt`, "kid words");
  put(`state/voice/groups/${hash16("tenant:anna-1a2b")}/voices/her/ref.wav`, "RIFF-HER");
  put(`state/voice/groups/${hash16("tenant:anna-1a2b")}/voices/her/ref.txt`, "her words");
  put("state/voice/groups/deadbeefdeadbeef/voices/x/ref.wav", "RIFF-NOBODY");
  put("state/voice/sources.json", JSON.stringify({
    notes: { owner: [{ ts: 1, id: "o.aac" }], [GID_A]: [{ ts: 2, id: "ga.aac" }], "tenant:anna-1a2b": [{ ts: 3, id: "an.aac" }], "gone-group": [{ ts: 4, id: "gone.aac" }] },
    quotes: { owner: { "10": 1 }, [GID_A]: { "20": 2 }, "gone-group": { "30": 4 } },
  }));
  // pending approvals: a friend's, a group's, and one of a conversation that is not here
  put(`state/pending-${hash16("tenant:anna-1a2b")}.json`, '{"next":3,"items":[],"expired":[],"blocked":[]}');
  put(`state/pending-${hash16(GID_A)}.json`, '{"next":4,"items":[],"expired":[],"blocked":[]}');
  put(`state/pending-${UNKNOWN_HASH}.json`, '{"next":9,"items":[],"expired":[],"blocked":[]}');
  put("state/mystery.txt", "nobody knows");
  // groups
  for (const [id, name] of [[GID_A, "Alpha"], [GID_B, "Beta"]] as const) {
    const k = key12(id);
    put(`memory/groups/${k}/meta.json`, JSON.stringify({ id, name }));
    put(`memory/groups/${k}/notes/MEMORY.md`, `- ${name} note\n`);
    put(`memory/groups/${k}/notes/context-g.md`, `---\nname: g\n---\n${name} likes tea\n`);
    put(`memory/groups/${k}/backup/2026-01-01/context-g.md`, `${name} older\n`);
    for (const f of ["session.json", "dream.json", "seen-mail.json", "held-posts.json", "quiet.json"]) put(`memory/groups/${k}/${f}`, `{"of":"${name}"}`);
    put(`logs/group-${k}.jsonl`, `{"ts":5,"at":"2026-10-20T10:00:00.000Z","kind":"member","text":"${name} says hi"}\n`);
  }
  put("memory/groups/ffffffffffff/notes/lost.md", "a group whose meta has no id\n");
  put("memory/groups/ffffffffffff/meta.json", '{"name":"No id"}');
  put("logs/group-ffffffffffff.jsonl", "history of the group with no id\n");
  put("logs/group-aaaaaaaaaaaa.jsonl", "history with no folder at all\n");
  put("memory/stray.txt", "stray");
  // friends
  for (const id of FRIENDS) {
    put(`tenants/${id}/tenant.json`, `{"language":"${id}"}`);
    put(`tenants/${id}/meta.json`, `{"disclosedAt":"x","of":"${id}"}`);
    put(`tenants/${id}/cost.json`, `{"day":"d","usd":0.1}`);
    put(`tenants/${id}/session.json`, `{"sessionId":"${id}-s"}`);
    put(`tenants/${id}/messages.jsonl`, `{"ts":7,"at":"2026-10-20T10:00:00.000Z","kind":"owner","text":"${id} says hi"}\n`);
    put(`tenants/${id}/notes/MEMORY.md`, `- ${id} note\n`);
    put(`tenants/${id}/notes/context-p.md`, `${id} likes coffee\n`);
    put(`tenants/${id}/backup/2026-01-01/context-p.md`, `${id} older\n`);
    for (const f of ["dream.json", "seen-mail.json", "held-posts.json", "quiet.json"]) put(`tenants/${id}/${f}`, `{"of":"${id}"}`);
  }
  put("tenants/notafolder.txt", "a file among the friends");
  // logs that stay
  put("logs/audit.jsonl", '{"ts":"x"}\n');
  put("logs/agent.log", "log line\n");
  put("logs/signal-daemon.log", "daemon\n");
  put("logs/launchd-stderr.log", "stderr\n");
  return { root, put };
}

/** Every file under a folder: relative path -> content (a folder is a "/" entry). For comparing two trees. */
export function snapshot(root: string, dir = root, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { out[`${relative(root, p)}/`] = ""; snapshot(root, p, out); } else out[relative(root, p)] = readFileSync(p, "utf8");
  }
  return out;
}
