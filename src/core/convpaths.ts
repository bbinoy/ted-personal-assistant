import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { dataDirOf } from "./paths.ts";

// THE one place that knows where anything lives under the data root. Every reader and writer asks here; test/convpaths.test.ts greps src/ and scripts/ for the file names
// and folders below spelled out anywhere else, so a new store cannot scatter again. The layout (layout version 2; docs/ARCHITECTURE.md "Where the data lives"):
//
//   <data>/instance/                 process-wide: the friends list, registrations, intake links and marks, cost ledgers, heartbeat rows, connectors, the card switch...
//   <data>/conversations/<convId>/   ONE folder per conversation, the same shape for the owner, each friend and each group (ConvPaths below)
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
export const LAYOUT_VERSION = 2;

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
  messages: string; // the conversation's history (jsonl, size-bounded)
  notes: string; // its notes (the SDK's auto-memory folder, MEMORY.md); the only place its file tools reach
  notesBackup: string; // snapshots of the notes made by the dream
  session: string; // the resumed SDK session pointer
  dream: string; // when the dream last ran
  heldPosts: string; // posts held back by quiet hours
  seenMail: string; // the mail ids its heartbeat run has worked through
  quiet: string; // its /quiet switch
  pending: string; // the approval inbox
  search: string; // the search index (a cache, rebuilt when wrong)
  voices: string; // cloned voices (<voices>/<name>/, active.json: packages/speech scopeRoot) and the voice-note sources
  voiceSources: string; // the voice notes received here (src/modules/voice/voicenote.ts)
  tenantJson: string; // a friend's typed overrides
  meta: string; // a friend's bookkeeping (first greeting, notice times), a group's id and name
  cost: string; // what a friend spent today on the instance key
}

export interface InstancePaths {
  dir: string;
  layoutVersion: string;
  migrationPlan: string;
  migrationOrphans: string;
  migrationBackup: string; // byte-identical copies of the files the migration REWRITES (not the ones it moves), under a timestamped folder
  migrationLock: string;
  tenants: string; // the friends list (the registry)
  registrations: string;
  intakeDir: string;
  intakeStatus: string;
  intakeProblems: string;
  capNotices: string;
  cost: string; // the owner's day (the guard for background work)
  keyCost: string; // all friends together on the instance key
  groupCost: string; // per group (keyed by convId)
  heartbeat: string; // last tick, for `npm run doctor`
  heartbeatRows: string;
  connectors: string;
  toolsSeen: string;
  notionClient: string;
  notionClientLock: string;
  payments: string;
  cardDisabled: string;
  paused: string;
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

/** Pure: every path under a data root. The bound accessors below use the process's data root; the migration and tests give their own. */
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
      migrationPlan: join(inst, "migration-plan.json"),
      migrationOrphans: join(inst, "migration-orphans"),
      migrationBackup: join(inst, "migration-backup"),
      migrationLock: join(inst, "migration.lock"),
      tenants: join(inst, "tenants.json"),
      registrations: join(inst, "registrations.json"),
      intakeDir: join(inst, "intake"),
      intakeStatus: join(inst, "intake-status.json"),
      intakeProblems: join(inst, "intake-problems.json"),
      capNotices: join(inst, "cap-notices.json"),
      cost: join(inst, "cost.json"),
      keyCost: join(inst, "key-cost.json"),
      groupCost: join(inst, "group-cost.json"),
      heartbeat: join(inst, "heartbeat.json"),
      heartbeatRows: join(inst, "heartbeat.jsonl"),
      connectors: join(inst, "connectors.json"),
      toolsSeen: join(inst, "tools-seen.json"),
      notionClient: join(inst, "notion-client.json"),
      notionClientLock: join(inst, "notion-client.lock"),
      payments: join(inst, "payments.jsonl"),
      cardDisabled: join(inst, "card.disabled"),
      paused: join(inst, "paused"),
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
        messages: join(dir, "messages.jsonl"),
        notes: join(dir, "notes"),
        notesBackup: join(dir, "notes-backup"),
        session: join(dir, "session.json"),
        dream: join(dir, "dream.json"),
        heldPosts: join(dir, "held-posts.json"),
        seenMail: join(dir, "seen-mail.json"),
        quiet: join(dir, "quiet.json"),
        pending: join(dir, "pending.json"),
        search: join(dir, "search.sqlite"),
        voices: join(dir, "voices"),
        voiceSources: join(dir, "voices", "sources.json"),
        tenantJson: join(dir, "tenant.json"),
        meta: join(dir, "meta.json"),
        cost: join(dir, "cost.json"),
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

// ---- the layout before version 2: ONLY for the migration (src/core/migrate.ts), so that this file stays the one that spells a path out ----
//
//   state/            session.json held-posts.json seen-mail.json dream.json quiet.json pending-<owner|hash>.json search.sqlite notes-backup/ (the owner's)
//                     tenants.json registrations.json intake/ intake-status.json intake-problems.json cap-notices.json cost.json key-cost.json group-cost.json
//                     heartbeat.json heartbeat.jsonl connectors.json tools-seen.json notion-client.json payments.jsonl card.disabled paused shore/ browse/ openbao/ tts-qwen/
//                     voice/ (active.json voices/<name>/ sources.json groups/<hash of the key>/{active.json,voices/<name>/}; the default voice's reference clip may be here too)
//   memory/           notes/ (the owner's), groups/<first 12 hex of sha256(group id)>/{notes,backup,meta.json,session.json,dream.json,held-posts.json,seen-mail.json,quiet.json}
//   tenants/<id>/     tenant.json notes/ backup/ messages.jsonl session.json cost.json meta.json dream.json held-posts.json seen-mail.json quiet.json
//   logs/             messages.jsonl (the owner's) group-<12 hex>.jsonl audit.jsonl agent.log signal-daemon.log launchd-stderr.log intake-launchd-stderr.log

export interface LegacyLayout {
  state: string;
  memory: string;
  tenants: string;
  logs: string;
  groupsDir: string;
  groupLog: (key12: string) => string;
  groupMeta: (key12: string) => string; // memory/groups/<key>/meta.json: the group's id and name, the only place its id is written down
  registry: string; // state/tenants.json: the friends list
  /** The owner's own files in state/, memory/ and logs/, each with where it goes (folders and sqlite's side files included). */
  owner: { from: string; to: string }[];
  /** Process-wide files and folders of state/, each with where it goes in instance/ (and the optional rewrite of its keys: group ids to folder names). */
  instance: { from: string; to: string; rekey?: "group-cost" | "cap-notices" }[];
  /** state/ entries that stay where they are: installed software, whose paths are baked in, and the voice folder (its default reference clip is yours, named in .env). */
  staysInState: string[];
  /** A conversation folder's old names that changed: [old, new] relative to the folder (the rest keeps its name). */
  renamedInFolder: [string, string][];
  pendingOwner: string;
  pendingOf: (hash16: string) => string;
  voice: { dir: string; active: string; library: string; sources: string; groups: string };
}

export function legacyLayout(root: string): LegacyLayout {
  const r = resolve(root);
  const state = join(r, "state");
  const memory = join(r, "memory");
  const logs = join(r, "logs");
  const L = layout(r);
  const o = L.conv(OWNER_CONV);
  const i = L.instance;
  const withSide = (from: string, to: string) => ["", "-journal", "-wal", "-shm"].map((x) => ({ from: from + x, to: to + x }));
  const s = (name: string) => join(state, name);
  return {
    state,
    memory,
    tenants: join(r, "tenants"),
    logs,
    groupsDir: join(memory, "groups"),
    groupLog: (key12) => join(logs, `group-${key12}.jsonl`),
    groupMeta: (key12) => join(memory, "groups", key12, "meta.json"),
    registry: s("tenants.json"),
    owner: [
      { from: join(memory, "notes"), to: o.notes },
      { from: s("session.json"), to: o.session },
      { from: s("held-posts.json"), to: o.heldPosts },
      { from: s("seen-mail.json"), to: o.seenMail },
      { from: s("dream.json"), to: o.dream },
      { from: s("quiet.json"), to: o.quiet },
      { from: s("notes-backup"), to: o.notesBackup },
      ...withSide(s("search.sqlite"), o.search),
      { from: join(logs, "messages.jsonl"), to: o.messages },
    ],
    instance: [
      { from: s("tenants.json"), to: i.tenants },
      { from: s("registrations.json"), to: i.registrations },
      { from: s("intake"), to: i.intakeDir },
      { from: s("intake-status.json"), to: i.intakeStatus },
      { from: s("intake-problems.json"), to: i.intakeProblems },
      { from: s("cap-notices.json"), to: i.capNotices, rekey: "cap-notices" },
      { from: s("cost.json"), to: i.cost },
      { from: s("key-cost.json"), to: i.keyCost },
      { from: s("group-cost.json"), to: i.groupCost, rekey: "group-cost" },
      { from: s("heartbeat.json"), to: i.heartbeat },
      { from: s("heartbeat.jsonl"), to: i.heartbeatRows },
      { from: s("connectors.json"), to: i.connectors },
      { from: s("tools-seen.json"), to: i.toolsSeen },
      { from: s("notion-client.json"), to: i.notionClient },
      { from: s("notion-client.lock"), to: i.notionClientLock },
      { from: s("payments.jsonl"), to: i.payments },
      { from: s("card.disabled"), to: i.cardDisabled },
      { from: s("paused"), to: i.paused },
      { from: s("shore"), to: i.shore },
      { from: s("browse"), to: i.browse },
    ],
    staysInState: [s("openbao"), s("tts-qwen"), s("voice")],
    renamedInFolder: [["backup", "notes-backup"]],
    pendingOwner: s("pending-owner.json"),
    pendingOf: (hash16) => s(`pending-${hash16}.json`),
    voice: { dir: s("voice"), active: join(state, "voice", "active.json"), library: join(state, "voice", "voices"), sources: join(state, "voice", "sources.json"), groups: join(state, "voice", "groups") },
  };
}
