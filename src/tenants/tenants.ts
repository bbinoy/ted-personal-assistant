import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { emitRecord } from "../core/events.ts";
import { FILE as OWNER_LOG, type Summarize } from "../core/messages.ts";
import { NOTES_DIR } from "../memory/notes.ts";
import { clean, LIMITS, oneLine } from "../core/sanitize.ts";
import { TENANT_ID } from "../secrets/secrets.ts";
import { convPaths, friendConvId, instancePaths, OWNER_CONV, type ConvId } from "../core/convpaths.ts";
import { OWNER, settings } from "../core/settings.ts";
import { dataPath, parseJson, writeFileAtomic, writeJson } from "../core/state.ts";
import { convDb, peekConvDb, removeConvDir } from "../core/convdb.ts";
import { isZone, systemZone } from "../core/timezone.ts";
import { directOf, directTarget, type Target } from "@ted-assistant/messenger";

// Tenants: the people other than the owner who use this instance. The owner is the tenant "owner" (her conversation folder is conversations/owner/); a friend is a tenant with a
// conversation folder of her own, conversations/friend-<id>/ (core/convpaths.ts, the same shape for everyone):
//   tenant.json    her typed overrides (TenantConfig)
//   notes/         her notes (the SDK's auto-memory); the only place her file tools reach
//   notes-backup/  snapshots of her notes
//   messages.jsonl everything said in her chat, size-bounded (no summary model: that would run on the owner's login)
//   assistant.db   her small mutable state (core/convdb.ts): her resumed SDK session, first greeting done, notice times, cooldown, held posts, approvals, voice notes
//   (her spend is rows of the spend table in instance.db, keyed by her convId: core/budget.ts)
// Of conversations/ the owner's chat may read only conversations/owner/ (policy.ts): the owner does not read a friend's
// notes or history through the assistant. The host's admin can, of course: the files are on the owner's Mac (docs/SAFETY.md).
// The registry instance/tenants.json holds ONE record per person, the owner included (role admin, every capability, her folder is the owner's: pathsOf):
// id, name, sender account ids (ACI), role, status and the credential source, never a key. Tenants run on the instance key
// (settings.tenantApiKey, from TENANT_ANTHROPIC_API_KEY), the owner on the login.
// The registry and tenant.json are files, read and written synchronously (state.ts); her small mutable state is her assistant.db (core/convdb.ts).

export const OWNER_ID = "owner";
export const REGISTRY = instancePaths().tenants;
const REGISTRY_LABEL = "the friends list (tenants.json in the instance folder)"; // (what a message or a log line calls it: never the data folder's absolute path)

export type TenantStatus = "active" | "suspended";
export const STATUSES: readonly TenantStatus[] = ["active", "suspended"];

// admin: the instance's powers (invites, suspending, the doctor); member: everybody else. It changes only through the local CLI (setAdmin, scripts/tenants.ts).
export type Role = "admin" | "member";
export const ROLES: readonly Role[] = ["admin", "member"];

// What a person may use. Nothing about it is stored: the owner has all of them, a friend has all of them but OWNER_ONLY (FRIEND_CAPABILITIES), so a new capability
// reaches every friend by being added to CAPABILITIES. What narrows that is readiness (a service with no OAuth client or INTAKE_BASE_URL has no tools, no skill, no prompt
// text), the instance's .env switches and her tenant.json switches (browse, voice): tenants/capabilityset.ts. To stop a friend altogether the admin suspends or removes her.
// Each tool of the manifest (toolmanifest.ts) and each shared skill (skills.ts) names the capability that gates it; capabilities.ts turns a set of them into tools and skills.
export const CAPABILITIES = ["chat", "browse", "voice", "heartbeat", "dream", "wake", "mail", "calendar", "notion", "profile", "card", "notes", "intake", "weather", "draw", "tasks", "google", "drive", "admin", "login"] as const;
export type Capability = (typeof CAPABILITIES)[number];
// What needs the instance's own Claude login (its connectors, its card and saved details, the admin's powers, the owner's Google Drive and Docs connectors): only the owner's
// conversation is on the login, so a friend never has these, and nobody can grant them. (`drive` is the owner's connectors, a capability of its own: a friend's own Google,
// `google`, never carries it. `login` is the login itself: every claude.ai connector row needs it besides its own capability, and so do the owner's private skills.) The one list
// of it: everything else is hers.
export const OWNER_ONLY: readonly Capability[] = ["profile", "card", "admin", "drive", "login"];
export const FRIEND_CAPABILITIES: readonly Capability[] = CAPABILITIES.filter((c) => !OWNER_ONLY.includes(c));

// Whose model credential her runs use: the instance's Claude login (the owner), or the instance key TENANT_ANTHROPIC_API_KEY (tenants).
export type Credential = "login" | "instance-key";
export const CREDENTIALS: readonly Credential[] = ["login", "instance-key"];

export interface TenantRecord {
  id: string;
  name: string; // what she is called (from her Signal profile, or what the owner said); one line
  acis: string[]; // her stable account id(s) on the messenger (Signal: the ACI): the identity (a number can change hands; the ACI does not)
  number?: string; // the owner's phone number: the seed of her record until her account id is learned (a friend's number is not known)
  role: Role;
  status: TenantStatus;
  credential: Credential;
  created: string; // ISO time
}

// Her Signal account id, a UUID.
export const ACI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- typed overrides (tenant.json) ----

export interface TenantConfig {
  language?: string; // the language she writes in, as a hint ("German")
  persona?: string; // how she would like the assistant to talk, in her words (data for the prompt, never rules)
  timeZone?: string; // her time zone ("Europe/Lisbon"): the clock of her heartbeat run and the day her notes expire on; absent: the owner's, the Mac's (timezone.ts)
  // Her own switches (capabilityset.ts resolveCapabilities; they only ever take away): a tenant.json that says false never offers the tool.
  browse?: boolean; // false switches the browse tool off for her (it can never be switched on beyond BROWSE)
  voice?: boolean; // false switches the voice tool off for her
}

const KNOWN: readonly string[] = ["language", "persona", "timeZone", "browse", "voice"];

// Pure. Whatever is in the file, the result is a valid config and `problems` says what was left out. Never throws.
export function parseTenantConfig(raw: unknown): { config: TenantConfig; problems: string[] } {
  const problems: string[] = [];
  const config: TenantConfig = {};
  if (raw === undefined) return { config, problems };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { config, problems: ["tenant.json is not an object"] };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!KNOWN.includes(k)) problems.push(`unknown setting ${oneLine("setting", k, 40)}`);
  const text = (k: "language" | "persona", max: number, line: boolean) => {
    if (r[k] === undefined) return;
    if (typeof r[k] !== "string") return void problems.push(`${k} must be text`);
    const v = line ? oneLine(k, r[k] as string, max) : clean(k, r[k] as string, { max });
    if (v) config[k] = v;
  };
  text("language", LIMITS.name, true);
  text("persona", LIMITS.brief, false);
  if (r.timeZone !== undefined) {
    if (!isZone(r.timeZone)) problems.push("timeZone must be a time zone like Europe/Lisbon");
    else config.timeZone = (r.timeZone as string).trim();
  }
  for (const k of ["browse", "voice"] as const) {
    if (r[k] === undefined) continue;
    if (typeof r[k] !== "boolean") problems.push(`${k} must be true or false`);
    else config[k] = r[k] as boolean;
  }
  return { config, problems };
}

// ---- what a run for a tenant is ----

export interface TenantContext {
  id: string;
  name: string;
  senders: string[]; // her sender ids (ACI)
  status: TenantStatus;
  target: string; // the conversation target to send to her (the messenger's directTarget of her account id)
  dir: string;
  notesDir: string;
  backupDir: string;
  logFile: string;
  ledger: ConvId; // her spend rows in instance.db are those with this convId (core/budget.ts)
  configFile: string;
  convId: ConvId; // her folder and her assistant.db (core/convdb.ts)
  role: Role;
  credential: Credential;
  config: TenantConfig;
  language?: string;
  persona?: string;
}


// Where a person's files are: the owner's are her conversation folder (conversations/owner/) and the instance's own ledger; a friend's are in hers.
export interface Paths {
  root: string;
  notesDir: string;
  logFile: string;
  ledger: ConvId; // whose spend rows count as hers: the owner's day, or the friend's own (core/budget.ts)
}
export const pathsOf = (rec: Pick<TenantRecord, "id">): Paths =>
  rec.id === OWNER_ID
    ? { root: settings.dataDir, notesDir: NOTES_DIR, logFile: OWNER_LOG, ledger: OWNER_CONV }
    : (({ dir, notes, messages }) => ({ root: dir, notesDir: notes, logFile: messages, ledger: friendConvId(rec.id) }))(convPaths(friendConvId(rec.id)));

export function tenantContext(rec: TenantRecord): TenantContext {
  const p = convPaths(friendConvId(rec.id));
  const dir = p.dir;
  const paths = pathsOf(rec);
  const configFile = p.tenantJson;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configFile, "utf8"));
  } catch {
    raw = undefined; // none yet, or damaged: the defaults
  }
  const { config } = parseTenantConfig(raw);
  return {
    id: rec.id,
    name: rec.name,
    senders: [...rec.acis],
    status: rec.status,
    target: directTarget(rec.acis[0] ?? ""),
    dir,
    notesDir: paths.notesDir,
    backupDir: p.notesBackup,
    logFile: paths.logFile,
    ledger: paths.ledger,
    configFile,
    convId: friendConvId(rec.id),
    role: rec.role,
    credential: rec.credential,
    config,
    language: config.language,
    persona: config.persona,
  };
}

// ---- the registry ----

interface Registry {
  tenants: unknown[];
}

const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

// One stored record, checked: a missing role or credential is the least privileged one (a member on the instance key), so nobody becomes an admin or spends the owner's login by omission. Undefined: not a usable record.
function normalise(x: unknown): TenantRecord | undefined {
  if (!isRecord(x)) return undefined;
  const { id, name, acis, created } = x;
  const status = x.status;
  if (typeof id !== "string" || !TENANT_ID.test(id) || typeof name !== "string" || typeof created !== "string") return undefined;
  if (!Array.isArray(acis) || !acis.every((a) => typeof a === "string" && ACI.test(a)) || !STATUSES.includes(status as TenantStatus)) return undefined;
  const role = x.role ?? "member";
  const credential = x.credential ?? "instance-key";
  if (!ROLES.includes(role as Role) || !CREDENTIALS.includes(credential as Credential)) return undefined;
  if (x.number !== undefined && typeof x.number !== "string") return undefined;
  return { id, name, acis: [...(acis as string[])], ...(typeof x.number === "string" && x.number ? { number: x.number } : {}), role: role as Role, status: status as TenantStatus, credential: credential as Credential, created };
}

// Everybody: the owner (once seeded) and every tenant.
// An unreadable registry fails closed for the FRIENDS only: the owner is still known (from the seed `ensureOwner` was given: her settings, not the file), so she is routed and served;
// no tenant is. Nothing is written over the file.
export const people = (): TenantRecord[] => {
  const all = registry().map(normalise).filter((r): r is TenantRecord => !!r);
  return cached?.corrupt !== undefined && ownerSeed && !all.some((r) => r.id === OWNER_ID) ? [ownerFrom(ownerSeed, new Date(0))] : all;
};
let ownerSeed: { number: string; aci?: string } | undefined; // (set by ensureOwner at start)
const ownerFrom = (s: { number: string; aci?: string }, now: Date): TenantRecord => ({ id: OWNER_ID, name: settings.owner, acis: s.aci && ACI.test(s.aci) ? [s.aci] : [], ...(s.number ? { number: s.number } : {}), role: "admin", status: "active", credential: "login", created: now.toISOString() });
// Why the friends list is unusable (the parse error), or undefined when it is fine. For the start-up notice and `npm run doctor`.
export const registryProblem = (): string | undefined => (registry(), cached?.corrupt);
export const REGISTRY_NOTICE = `The friends list (tenants.json in the instance folder) can't be read, so friends are paused. It's kept as is; repair or move it, then restart.`;

// `allows`, `tenantById` and every routing question read the registry, on every message and every tick. The file is read and parsed again only when it changed (its
// stat: size, modification time in ns, inode: a write is a rename to a new file, also another process's, `npm run tenants`) and not after this process's own
// write (`save` forgets it). The parsed JSON is shared, the records made from it (`normalise`) are new objects each time.
let cached: { sig: string; tenants: unknown[]; corrupt?: string } | undefined;
let reads = 0;
export const registryReads = (): number => reads; // (tests)
function registry(): unknown[] {
  let sig: string | undefined;
  try {
    const path = dataPath(REGISTRY);
    const s = statSync(path, { bigint: true });
    sig = `${path}:${s.ino}:${s.size}:${s.mtimeNs}`;
  } catch {
    /* no registry yet */
  }
  if (sig && cached?.sig === sig) return cached.tenants;
  reads++;
  // An unreadable registry is NOT an empty one: nobody is routed (fail closed) and `save` refuses, so the next change cannot erase every tenant from defaults. The file is left in place for a human.
  const r = parseJson<Partial<Registry>>(REGISTRY);
  const corrupt = "corrupt" in r ? r.corrupt : undefined;
  if (corrupt !== undefined) console.error(`tenants: ${REGISTRY_LABEL} is unreadable (${corrupt}); no one is routed and nothing will be saved until it is repaired or removed`);
  const tenants = (("value" in r ? r.value?.tenants : undefined) ?? []) as unknown[];
  cached = sig ? { sig, tenants, ...(corrupt !== undefined ? { corrupt } : {}) } : undefined;
  return tenants;
}
function refuseIfUnreadable(): void {
  registry(); // (re)reads when the file changed
  if (cached?.corrupt !== undefined) throw new Error(`tenants: ${REGISTRY_LABEL} exists but cannot be read (${cached.corrupt}); refusing to overwrite it. Repair or move the file, then try again.`);
}
// The tenants: everybody but the owner. What the invitations, routing, suspension and removal work on; none of it can reach the owner's record.
export const listTenants = (): TenantRecord[] => people().filter((r) => r.id !== OWNER_ID);
const save = (all: TenantRecord[]) => (refuseIfUnreadable(), writeJson(REGISTRY, { tenants: all }), (cached = undefined));
const update = (id: string, change: (r: TenantRecord) => TenantRecord): TenantRecord | undefined => {
  const all = people();
  const at = all.findIndex((t) => t.id === id);
  if (at < 0) return undefined;
  all[at] = change(all[at]!);
  save(all);
  return all[at];
};

export const tenantById = (id: string): TenantRecord | undefined => listTenants().find((t) => t.id === id);
const hasAci = (r: TenantRecord, aci: string) => r.acis.some((a) => a.toLowerCase() === aci.toLowerCase());
export const tenantByAci = (aci: string | undefined): TenantRecord | undefined => (aci && ACI.test(aci) ? listTenants().find((t) => hasAci(t, aci)) : undefined);
// The conversation target of a tenant (to send to her), for the outbound path.
export const targetOf = (id: string): string | undefined => {
  const t = tenantById(id);
  return t?.acis[0] ? directTarget(t.acis[0]) : undefined;
};
export const tenantByTarget = (target: Target): TenantRecord | undefined => tenantByAci(directOf(target));

// ---- who is who: identity is the account id; the owner's number is the seed and the fallback ----

// The owner's record, made on first start from SIGNAL_OWNER_NUMBER (and SIGNAL_OWNER_ACI when set): admin, every capability, the existing files.
// Idempotent; an existing record is kept as it is (what was learned or changed stays).
export function ensureOwner(seed: { number: string; aci?: string }, now = new Date()): TenantRecord {
  ownerSeed = seed;
  const have = people().find((r) => r.id === OWNER_ID); // unreadable registry: the stand-in made from the seed, and nothing is saved over the file
  if (have) return have;
  const rec = ownerFrom(seed, now);
  save([rec, ...people()]);
  return rec;
}

// The record a sender is: by account id when she has one that is known, else by number (the owner's, until her account id is learned).
export function resolveSender(who: { number?: string; aci?: string }): TenantRecord | undefined {
  const all = people();
  if (who.aci && ACI.test(who.aci)) {
    const byAci = all.find((r) => hasAci(r, who.aci!));
    if (byAci) return byAci;
  }
  return who.number ? all.find((r) => !!r.number && r.number === who.number) : undefined;
}

// The owner's first message carries her account id: the pair (number, account id) is written to the record once, and logged. Never through chat or
// the model; later messages are matched by the account id. Nothing is learned when the record has an id already or the id belongs to someone else.
export function learnOwnerAci(who: { number: string; aci?: string }): boolean {
  if (!who.aci || !ACI.test(who.aci) || registryProblem() !== undefined) return false; // (nothing is written to an unreadable registry)
  const rec = people().find((r) => r.id === OWNER_ID);
  if (!rec || rec.acis.length || !rec.number || rec.number !== who.number || people().some((r) => hasAci(r, who.aci!))) return false;
  update(OWNER_ID, (r) => ({ ...r, acis: [who.aci!] }));
  emitRecord("owner_aci", "learned", "chat");
  console.log(`tenants: the owner's Signal account id (${who.aci.slice(0, 8)}...) was learned from the first message from her number and recorded once (tenants.json in the instance folder)`);
  return true;
}

// ---- the admin role: changed only by the local CLI (scripts/tenants.ts); no tool, no chat path, no model ----

// The admin role moves to this record: the previous admin(s) become members, so there is exactly one. Undefined: no such record.
export function setAdmin(id: string): TenantRecord | undefined {
  if (!people().some((r) => r.id === id)) return undefined;
  const all = people().map((r) => ({ ...r, role: (r.id === id ? "admin" : "member") as Role }));
  save(all);
  return all.find((r) => r.id === id);
}

// A new id from her name: lower case, a short random tail so two Annas never collide.
export function newTenantId(name: string, taken: ReadonlySet<string> = new Set(listTenants().map((t) => t.id))): string {
  const base = (name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "") || "friend").slice(0, 20).replace(/-+$/, "") || "friend";
  for (;;) {
    const id = `${base}-${Math.random().toString(16).slice(2, 6)}`;
    if (!taken.has(id) && TENANT_ID.test(id)) return id;
  }
}

// Folders and files of a tenant, owner-only. Idempotent.
export function provision(rec: TenantRecord): TenantContext {
  const ctx = tenantContext(rec);
  mkdirSync(ctx.notesDir, { recursive: true, mode: 0o700 });
  mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });
  if (!existsSync(ctx.configFile)) writeFileAtomic(ctx.configFile, "{}\n");
  return tenantContext(rec);
}

// A person the owner approved (registration.ts: her yes in the owner's chat, `npm run tenants -- approve`, or a hello the owner sent her first) becomes a tenant,
// active at once (no question); provisioned at once. Undefined: not an account id, or she already is one.
export function addTenant(who: { aci: string; name?: string }, now = Date.now()): TenantRecord | undefined {
  if (!ACI.test(who.aci) || tenantByAci(who.aci)) return undefined;
  const all = people();
  const name = oneLine("tenant name", (who.name || "a friend").replace(/[<>"]/g, " "), LIMITS.name) || "a friend";
  const id = newTenantId(name, new Set(all.map((t) => t.id)));
  const rec: TenantRecord = { id, name, acis: [who.aci.toLowerCase()], role: "member", status: "active", credential: "instance-key", created: new Date(now).toISOString() };
  save([...all, rec]);
  provision(rec);
  console.log(`tenants: ${id} joined`);
  return rec;
}

export const setStatus = (id: string, status: TenantStatus): TenantRecord | undefined => (id === OWNER_ID ? undefined : update(id, (r) => ({ ...r, status })));

// Remove a tenant and her data: the registry entry and her conversation folder (notes, history, session, cost, voices). True: she was a tenant.
// What the host already holds elsewhere (the SDK's own transcript of her sessions under ~/.claude, backups of the Mac) is not reached: docs/SAFETY.md.
export function deleteTenant(id: string, o: { drop?: (id: string) => void } = {}): boolean {
  if (!tenantById(id)) return false;
  save(people().filter((t) => t.id !== id)); // first: from this moment she is nobody
  o.drop?.(id);
  removeConvDir(friendConvId(id)); // (its assistant.db connection is closed first)
  console.log(`tenants: ${id} deleted`);
  return true;
}

// Her time zone, in tenant.json (the other typed overrides stay as they are); undefined removes it (the owner's zone again). Only the local CLI calls this
// (scripts/tenants.ts timezone). Undefined: no such tenant.
export function setTimeZone(id: string, zone: string | undefined): TenantRecord | undefined {
  const rec = tenantById(id);
  if (!rec || rec.id === OWNER_ID) return undefined;
  if (zone !== undefined && !isZone(zone)) throw new Error("not a time zone (like Europe/Lisbon)");
  const ctx = provision(rec);
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(ctx.configFile, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    /* none yet, or damaged: start from the defaults */
  }
  if (zone === undefined) delete raw.timeZone;
  else raw.timeZone = zone.trim();
  writeFileAtomic(ctx.configFile, `${JSON.stringify(raw, null, 2)}\n`);
  return rec;
}

// ---- first greeting, cooldown: the `friend` table of her assistant.db ----

type Who = Pick<TenantContext, "convId">;
interface FriendRow {
  paused_until: number | null;
  disclosed_at: string | null;
}
const friend = (ctx: Who): FriendRow | undefined => peekConvDb(ctx.convId)?.get<FriendRow>("SELECT paused_until, disclosed_at FROM friend WHERE id = 1");
// disclosed_at: when she had her first reply (the first-contact hint is given until then); paused_until: her cooldown (cooldown.ts keeps it in memory; this is for `npm run doctor`, a separate process)
export const wasDisclosed = (ctx: Who): boolean => !!friend(ctx)?.disclosed_at;
export const markDisclosed = (ctx: Who): void =>
  void convDb(ctx.convId).run("INSERT INTO friend (id, disclosed_at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET disclosed_at = excluded.disclosed_at", new Date().toISOString());
export const pausedUntil = (ctx: Who, now = Date.now()): number | undefined => {
  const u = friend(ctx)?.paused_until;
  return typeof u === "number" && u > now ? u : undefined;
};
export function setPaused(ctx: Who, until: number | undefined): void {
  const was = friend(ctx)?.paused_until;
  if (until !== undefined || (was !== null && was !== undefined)) convDb(ctx.convId).run("INSERT INTO friend (id, paused_until) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET paused_until = excluded.paused_until", until ?? null);
}

// Her history is bounded like every log, but never summarised by a model: that call would run on the owner's login, over her words.
export const plainSummary: Summarize = async (_previous, old) => `${old.length} earlier messages (older history is not kept in full)`;

// Who the person in a private chat is called in the prompts built for it: the owner as always, a tenant by her name. (Takes any conversation's tenantId.)
export const speakerOf = (conv: { readonly tenantId?: string }): string => (conv.tenantId ? (tenantById(conv.tenantId)?.name ?? "a friend") : OWNER);

// The time zone a conversation's clock runs in (core/timezone.ts): a friend's own if her tenant.json names one, else the owner's, the Mac's (a group's included).
export function zoneOf(conv: { readonly tenantId?: string }): string {
  const rec = conv.tenantId ? tenantById(conv.tenantId) : undefined;
  return (rec && tenantContext(rec).config.timeZone) || systemZone();
}
