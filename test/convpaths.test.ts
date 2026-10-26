import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ROOT } from "../src/core/paths.ts";
import {
  convDir, convIdOf, convIdOfKey, convOfPath, convPaths, friendConvId, groupConvId, hashOf, instancePaths, isConvId, layout, logPaths, OWNER_CONV, tenantIdOfConv, useDataRoot,
} from "../src/core/convpaths.ts";
import { scopeRoot } from "@ted-assistant/speech/tts";

// core/convpaths.ts is THE one place that builds a path under the data folder. These tests pin its shape and, below, grep the sources so nothing else spells one out.

const GROUP_ID = "Zm9vYmFyLWdyb3VwLWlkLXdpdGgtc2VjcmV0cw==";

test("convId: owner, friend-<tenant id>, group-<16 hex of sha256(group id)>; filesystem-safe, a group's not reversible", () => {
  assert.equal(OWNER_CONV, "owner");
  assert.equal(friendConvId("anna-1a2b"), "friend-anna-1a2b");
  const g = groupConvId(GROUP_ID);
  assert.match(g, /^group-[0-9a-f]{16}$/);
  assert.equal(g, `group-${hashOf(GROUP_ID)}`);
  assert.ok(!g.includes(GROUP_ID) && !g.includes("secrets"));
  assert.notEqual(g, groupConvId(`${GROUP_ID}x`));
  for (const ok of ["owner", "friend-a", "friend-anna_b-1", g]) assert.equal(isConvId(ok), true, ok);
  for (const bad of ["", "Owner", "friend-", "friend-Anna", "friend-../x", "group-xyz", "group-0123456789abcde", "group-0123456789abcdef0", "x", "../owner", "owner/x", "tenant:a", "friend-" + "a".repeat(33)]) assert.equal(isConvId(bad), false, bad);
  assert.throws(() => friendConvId("owner"), /not a tenant id/);
  assert.throws(() => friendConvId("../x"), /not a tenant id/);
  assert.throws(() => convPaths("../x"), /not a conversation id/);
  assert.equal(tenantIdOfConv("friend-anna-1a2b"), "anna-1a2b");
  assert.equal(tenantIdOfConv("owner"), undefined);
});

test("convId of a key or a conversation: the owner, tenant:<id>, and anything else is an opaque group key (hashed)", () => {
  assert.equal(convIdOfKey("owner"), "owner");
  assert.equal(convIdOfKey("tenant:anna-1a2b"), "friend-anna-1a2b");
  assert.equal(convIdOfKey(GROUP_ID), groupConvId(GROUP_ID));
  assert.equal(convIdOfKey("tenant:../x"), groupConvId("tenant:../x"), "a key that is not a tenant is hashed, never put in a path");
  assert.equal(convIdOf({ kind: "owner" }), "owner");
  assert.equal(convIdOf({ kind: "tenant", tenantId: "anna-1a2b" }), "friend-anna-1a2b");
  assert.equal(convIdOf({ kind: "group", groupId: GROUP_ID }), groupConvId(GROUP_ID));
  assert.equal(convIdOf({ kind: "group", convId: "group-0123456789abcdef" }), "group-0123456789abcdef");
  assert.throws(() => convIdOf({ kind: "group" }), /not a conversation/);
});

test("layout: every conversation has the same files in one folder; instance and logs are apart; nothing holds a raw group id", () => {
  const L = layout("/data");
  const names = (id: string) => Object.entries(L.conv(id)).map(([k, v]) => [k, relative(L.conv(id).dir, v)]);
  for (const id of ["owner", "friend-anna", groupConvId(GROUP_ID)]) {
    assert.equal(L.conv(id).dir, join("/data/conversations", id));
    assert.deepEqual(names(id), names("owner"), "the same layout for everyone");
    for (const [k, v] of Object.entries(L.conv(id))) assert.ok(v === L.conv(id).dir || v.startsWith(L.conv(id).dir + sep), `${k} is inside the conversation's folder`);
    assert.ok(!Object.values(L.conv(id)).some((p) => p.includes(GROUP_ID)));
  }
  assert.deepEqual(Object.fromEntries(names("owner")), {
    dir: "", db: "assistant.db", dbDamaged: "assistant.db.damaged", messages: "messages.jsonl", notes: "notes", notesBackup: "notes-backup", search: "search.sqlite", voices: "voices",
    tenantJson: "tenant.json", meta: "meta.json",
  });
  for (const [k, v] of Object.entries(L.instance)) if (!["installed", "openbao", "ttsQwen"].includes(k)) assert.ok(v === L.instance.dir || v.startsWith(L.instance.dir + sep), `${k} is in instance/`);
  assert.deepEqual([L.instance.installed, L.instance.openbao, L.instance.ttsQwen], ["/data/state", "/data/state/openbao", "/data/state/tts-qwen"], "installed software keeps its folder: its paths are baked into its config and plist");
  assert.deepEqual(Object.values(L.logs).map((p) => relative("/data/logs", p)).sort(), ["", "agent.log", "audit.jsonl", "intake-launchd-stderr.log", "launchd-stderr.log", "signal-daemon.log"]);
});

test("the speech package and the app agree on where a conversation's cloned voices are (the package learns no conversation, only a root and a folder name)", () => {
  const L = layout("/data");
  for (const id of ["owner", "friend-anna", groupConvId(GROUP_ID)]) assert.equal(scopeRoot(L.conversations, id), L.conv(id).voices);
});

test("bound accessors follow the data root the settings registered; convOfPath names the conversation a path is in", () => {
  useDataRoot("/somewhere/data");
  try {
    assert.equal(convDir("owner"), "/somewhere/data/conversations/owner");
    assert.equal(convPaths("friend-anna").db, "/somewhere/data/conversations/friend-anna/assistant.db");
    assert.equal(instancePaths().tenants, "/somewhere/data/instance/tenants.json");
    assert.equal(logPaths().audit, "/somewhere/data/logs/audit.jsonl");
    assert.equal(convOfPath("/somewhere/data/conversations/friend-anna/notes/x.md"), "friend-anna");
    assert.equal(convOfPath("/somewhere/data/conversations/friend-anna"), "friend-anna");
    assert.equal(convOfPath("/somewhere/data/conversations"), undefined);
    assert.equal(convOfPath("/somewhere/data/conversations/junk/x"), undefined);
    assert.equal(convOfPath("/somewhere/data/instance/x"), undefined);
    assert.equal(convOfPath("/somewhere/data/conversations/../instance/x"), undefined);
  } finally {
    useDataRoot(process.env.HARNESS_DATA_DIR!);
  }
});

// ---- nothing else builds a path ----

// The string literals of a TypeScript source, comments left out (a small scanner: quotes, template literals, // and /* */).
function literals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") i = src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
    else if (c === "/" && src[i + 1] === "*") i = src.indexOf("*/", i + 2) < 0 ? src.length : src.indexOf("*/", i + 2) + 2;
    else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let text = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") { text += src[j + 1] ?? ""; j += 2; continue; }
        if (c !== "`" && src[j] === "\n") break;
        text += src[j]!;
        j++;
      }
      out.push(text);
      i = j + 1;
    } else i++;
  }
  return out;
}

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|sh)$/.test(name)) out.push(p);
  }
  return out;
};

// The folders and the per-conversation and instance file names. A literal that IS one of them, or ends with "/<one of them>", or starts with a folder of the layout, is a path being built by hand.
const NAMES = [
  "messages.jsonl", "session.json", "dream.json", "held-posts.json", "seen-mail.json", "quiet.json", "pending.json", "assistant.db", "assistant.db.damaged", "search.sqlite", "notes-backup", "tenant.json", "meta.json", "cost.json",
  "tenants.json", "registrations.json", "intake-status.json", "intake-problems.json", "cap-notices.json", "key-cost.json", "group-cost.json", "heartbeat.json", "heartbeat.jsonl",
  "connectors.json", "tools-seen.json", "instance.db", "notion-client.json", "notion-client.lock", "payments.jsonl", "card.disabled", "layout-version",
  "retention.json", "audit.jsonl", "agent.log", "signal-daemon.log", "launchd-stderr.log", "intake-launchd-stderr.log",
];
const FOLDERS = ["state", "instance", "conversations", "memory", "logs"];
const isPathBuilding = (lit: string, file: string): string | undefined => {
  if (/^(\.{1,2}\/|node:|@|https?:)/.test(lit) || /\.(ts|js)$/.test(lit)) return undefined; // an import or a URL
  const l = lit.replace(/\.\d+$/, ""); // (a rotated generation)
  for (const n of NAMES) if (l === n || l.endsWith(`/${n}`)) return n;
  for (const f of FOLDERS) if (lit.startsWith(`${f}/`)) return `${f}/`;
  if (/^tenants\//.test(lit) && !file.includes(`${sep}secrets${sep}`) && !file.includes(`${sep}intake${sep}`)) return "tenants/"; // (tenants/<id>/<kind> is also an OpenBao item path: src/secrets, the intake store)
  return undefined;
};

test("grep: src/ and scripts/ spell out no per-conversation or instance path outside core/convpaths.ts (so a new store cannot scatter again)", () => {
  const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "scripts"))].filter((f) => !f.endsWith(`${sep}convpaths.ts`));
  const found: string[] = [];
  for (const f of files) {
    if (f.endsWith(".sh")) {
      for (const [n, line] of readFileSync(f, "utf8").split("\n").entries()) if (/(^|[^\w.])(state|memory|tenants)\/[\w.-]/.test(line.replace(/#.*/, "")) && !/tts-qwen|ROOT\/state/.test(line)) found.push(`${relative(ROOT, f)}:${n + 1}: ${line.trim().slice(0, 100)}`);
      continue;
    }
    for (const lit of literals(readFileSync(f, "utf8"))) {
      const hit = isPathBuilding(lit, f);
      if (hit) found.push(`${relative(ROOT, f)}: "${lit.slice(0, 80)}" (${hit})`);
    }
  }
  assert.deepEqual(found, [], "build the path with core/convpaths.ts (convPaths(conv).<file>, instancePaths().<file>, logPaths().<file>) and add a new store there");
});

test("grep: the scanner itself sees a hand-built path and ignores comments", () => {
  assert.deepEqual(literals(`const a = "state/x.json"; // "session.json" in a comment\n/* "dream.json" */ const b = \`logs/\${n}.jsonl\`;`), ["state/x.json", "logs/${n}.jsonl"]);
  assert.equal(isPathBuilding("state/x.json", "f.ts"), "state/");
  assert.equal(isPathBuilding("session.json", "f.ts"), "session.json");
  assert.equal(isPathBuilding("x/messages.jsonl.1", "f.ts"), "messages.jsonl");
  assert.equal(isPathBuilding("/tmp/x", "f.ts"), undefined);
  assert.equal(isPathBuilding("https://claude.ai/state/x", "f.ts"), undefined);
});
