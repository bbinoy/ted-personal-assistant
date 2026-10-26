import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { dataDirOf } from "./paths.ts";

// THE one place that knows where anything lives under the data root. Every reader and writer asks here; test/convpaths.test.ts greps src/ and scripts/ for the file names
// and folders below spelled out anywhere else, so a new store cannot scatter again. The layout (layout version 4; docs/ARCHITECTURE.md "Where the data lives"):
//
//   <data>/instance/                 process-wide: the friends list, registrations, intake links, the card switch... and instance.db (SQLite: spend, notices, heartbeat looks, payments, intake marks, kv)
//   <data>/conversations/<convId>/   ONE folder per conversation, the same shape for the owner, each friend and each group (ConvPaths below): assistant.db (its small mutable state, layout 4), messages.jsonl, notes/...
//   <data>/logs/                     audit.jsonl, agent.log, signal-daemon.log and launchd's stderr files, nothing else
//   <data>/state/                    only software installed with absolute paths baked in (OpenBao, the Qwen voice's Python environment): not moved, see InstancePaths.installed
//
// A conversation is named by its convId: "owner", "friend-<tenant id>", "group-<first 16 hex of sha256(group id)>". It is filesystem-safe, stable, and for a group not reversible: a raw group
// id or phone number is never part of a path, and never a key in a process-wide file (the cost ledger, the notice marks): those use the convId too. Forgetting a conversation is deleting
// its folder (plus its few instance-level keys: src/conversation/forget.ts).
//
// This file imports nothing but node and paths.ts, so settings.ts can use it for its defaults without a cycle (settings.ts tells it the data root: useDataRoot).

export type ConvId = string;
export const OWNER_CONV: ConvId = "owner";
export const LAYOUT_VERSION = 4;

const TENANT_ID = /^[a-z][a-z0-9_-]{0,31}$/; // (the same pattern as secrets.ts TENANT_ID, which this file may not import)
const CONV_ID = /^(?:owner|friend-[a-z][a-z0-9_-]{0,31}|group-[0-9a-f]{16})$/;
export const isConvId = (x: unknown): x is ConvId => typeof x === "string" && CONV_ID.test(x);

/** A short stable hash of an opaque key (a group id): 16 hex characters. The voice library, the pending file and the folder of a group all used (or now use) this one. */
export const hashOf = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 16);

export const friendConvId = (tenantId: string): ConvId => {
  if (!TENANT_ID.test(tenantId) || tenantId === "owner") throw new Error("not a tenant id");
  return `friend-${tenantId}`;
};
export const groupConvId = (groupId: string): ConvId => `group-${hashOf(groupId)}`;

/** The convId of a conversation key as the pipeline uses it (Conversation.key): "owner", "tenant:<id>", or a raw group id. */
export function convIdOfKey(key: string): ConvId {
  if (key === OWNER_CONV) return OWNER_CONV;
  const id = key.startsWith("tenant:") ? key.slice("tenant:".length) : undefined;
  if (id !== undefined && TENANT_ID.test(id) && id !== OWNER_CONV) return friendConvId(id);
  return groupConvId(key); // (anything else is an opaque key, hashed: a path never holds it)
}

/** The convId of anything that says what it is (a Conversation, or just its kind and ids). */
export function convIdOf(c: { readonly kind: string; readonly tenantId?: string; readonly groupId?: string; readonly convId?: ConvId }): ConvId {
  if (c.convId) return c.convId;
  if (c.kind === "owner") return OWNER_CONV;
  if (c.kind === "tenant" && c.tenantId) return friendConvId(c.tenantId);
  if (c.kind === "group" && c.groupId) return groupConvId(c.groupId);
  throw new Error("convIdOf: not a conversation");
}

/** The tenant id a friend's convId names, or undefined. */
export const tenantIdOfConv = (conv: ConvId): string | undefined => (conv.startsWith("friend-") && isConvId(conv) ? conv.slice("friend-".length) : undefined);

export type ConvRef = ConvId | { readonly convId: ConvId };
const idOf = (c: ConvRef): ConvId => {
  const id = typeof c === "string" ? c : c.convId;
  if (!isConvId(id)) throw new Error(`not a conversation id: ${String(id).slice(0, 40)}`);
  return id;
};

export interface ConvPaths {
  dir: string;
  db: string; // assistant.db: SQLite, WAL (core/convdb.ts): the conversation's small mutable state (session pointer, dream day, held posts, seen mail, /quiet, voice-note sources, a friend's bookkeeping)
  dbDamaged: string; // written when assistant.db was damaged and set aside: the conversation's background work stops until a person looks (core/convdb.ts)
  messages: string; // the conversation's history (jsonl, size-bounded)
  notes: string; // its notes (the SDK's auto-memory folder, MEMORY.md); the only place its file tools reach
  notesBackup: string; // snapshots of the notes made by the dream
  search: string; // the search index (a cache, rebuilt when wrong)
  voices: string; // cloned voices (<voices>/<name>/, active.json: packages/speech scopeRoot)
  tenantJson: string; // a friend's typed overrides
  meta: string; // a GROUP's id and name: the only place the raw id is written (the folder name is its hash); identity, not state, so it stays a file when assistant.db is set aside
}

export interface InstancePaths {
  dir: string;
  layoutVersion: string;
  db: string; // instance.db: SQLite, WAL (core/db.ts, core/instancedb.ts): spend, cap notices, heartbeat looks, payments, intake marks, kv (heartbeat tick, connectors, tools seen)
  tenants: string; // the friends list (the registry)
  registrations: string;
  intakeDir: string;
  notionClient: string;
  notionClientLock: string;
  cardDisabled: string;
  paused: string;
  retention: string; // when each retention rule last ran and what it freed (core/retention.ts)
  shore: string;
  browse: string;
  browsers: string; // the downloaded Chromium (npm run setup:browse), inside browse
  installed: string; // software installed with absolute paths baked in: OpenBao (a launchd service whose plist and config name its folder) and the Qwen voice's Python environment
  openbao: string;
  ttsQwen: string;
}

export interface LogPaths {
  dir: string;
  audit: string;
  agent: string;
  signalDaemon: string;
  launchdStderr: string;
  intakeLaunchdStderr: string;
}

export interface Layout {
  root: string;
  instance: InstancePaths;
  logs: LogPaths;
  conversations: string;
  conv: (c: ConvRef) => ConvPaths;
}

/** Pure: every path under a data root. The bound accessors below use the process's data root; tests give their own. */
export function layout(root: string): Layout {
  const r = resolve(root);
  const inst = join(r, "instance");
  const conversations = join(r, "conversations");
  const logs = join(r, "logs");
  const installed = join(r, "state");
  return {
    root: r,
    conversations,
    instance: {
      dir: inst,
      layoutVersion: join(inst, "layout-version"),
      db: join(inst, "instance.db"),
      tenants: join(inst, "tenants.json"),
      registrations: join(inst, "registrations.json"),
      intakeDir: join(inst, "intake"),
      notionClient: join(inst, "notion-client.json"),
      notionClientLock: join(inst, "notion-client.lock"),
      cardDisabled: join(inst, "card.disabled"),
      paused: join(inst, "paused"),
      retention: join(inst, "retention.json"),
      shore: join(inst, "shore"),
      browse: join(inst, "browse"),
      browsers: join(inst, "browse", "browsers"),
      installed,
      openbao: join(installed, "openbao"),
      ttsQwen: join(installed, "tts-qwen"),
    },
    logs: {
      dir: logs,
      audit: join(logs, "audit.jsonl"),
      agent: join(logs, "agent.log"),
      signalDaemon: join(logs, "signal-daemon.log"),
      launchdStderr: join(logs, "launchd-stderr.log"),
      intakeLaunchdStderr: join(logs, "intake-launchd-stderr.log"),
    },
    conv(c) {
      const dir = join(conversations, idOf(c));
      return {
        dir,
        db: join(dir, "assistant.db"),
        dbDamaged: join(dir, "assistant.db.damaged"),
        messages: join(dir, "messages.jsonl"),
        notes: join(dir, "notes"),
        notesBackup: join(dir, "notes-backup"),
        search: join(dir, "search.sqlite"),
        voices: join(dir, "voices"),
        tenantJson: join(dir, "tenant.json"),
        meta: join(dir, "meta.json"),
      };
    },
  };
}

// The process's data root: the one settings.ts loaded (it registers it here, so every path agrees with settings.dataDir even in a test that changes HARNESS_DATA_DIR late); before that, or in
// a script that never loads the settings, HARNESS_DATA_DIR from the environment, else the repo.
let registered: string | undefined;
export const useDataRoot = (root: string): void => void (registered = resolve(root));
const here = (): Layout => layout(registered ?? dataDirOf(process.env));

/** Which conversation's folder a path is in (the first folder under conversations/), or undefined. Pure on the path's text: no link is followed. */
export function convOfPath(path: string, root: string = dataRoot()): ConvId | undefined {
  const rel = relative(layout(root).conversations, resolve(path));
  const first = rel.split(sep)[0] ?? "";
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) || !isConvId(first) ? undefined : first;
}

export const dataRoot = (): string => here().root;
export const instancePaths = (): InstancePaths => here().instance;
export const logPaths = (): LogPaths => here().logs;
export const conversationsDir = (): string => here().conversations;
export const convPaths = (conv: ConvRef): ConvPaths => here().conv(conv);
export const convDir = (conv: ConvRef): string => here().conv(conv).dir;

// ---- the layout guard (core/requirelayout.ts for the tools, core/agentstart.ts for the agent) ----

const OLDER = "This data folder uses an older layout. Check out the git tag last-migration, run `npm run migrate`, then come back to this version.";

/** The sentence that says why this code must not use the data folder, or null when it may: layout version 4, or a new folder with no stamp yet and nothing of an older layout in it. */
export function layoutProblem(root: string): string | null {
  const L = layout(root);
  const filled = (d: string): boolean => existsSync(d) && readdirSync(d).length > 0;
  let v: number | undefined;
  try { v = Number(readFileSync(L.instance.layoutVersion, "utf8").trim()); } catch { /* no stamp */ }
  if (v === undefined) return filled(L.conversations) || filled(join(L.root, "memory")) || filled(join(L.root, "tenants")) || existsSync(L.instance.tenants) || existsSync(join(L.root, "state", "tenants.json")) ? OLDER : null;
  if (v > LAYOUT_VERSION) return `This data folder is in a newer layout (version ${v}) than this code understands (${LAYOUT_VERSION}): update the code; it will not touch the data.`;
  return v === LAYOUT_VERSION ? null : OLDER;
}

/** A new, empty data folder gets the current layout version (an already stamped one is left alone). */
export function stampLayout(root: string): void {
  const f = layout(root).instance;
  if (existsSync(f.layoutVersion)) return;
  mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  writeFileSync(f.layoutVersion, `${LAYOUT_VERSION}\n`, { mode: 0o600 });
}
