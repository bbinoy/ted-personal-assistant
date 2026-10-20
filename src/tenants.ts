import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { audit } from "./audit.ts";
import { isInside } from "./contain.ts";
import { OneTimeCodes } from "./onetime.ts";
import { FILE as OWNER_LOG, type Summarize } from "./messages.ts";
import { NOTES_DIR } from "./notes.ts";
import { clean, LIMITS, oneLine } from "./sanitize.ts";
import { TENANT_ID } from "./secrets.ts";
import { OWNER_SESSION_FILE } from "./session.ts";
import { settings } from "./settings.ts";
import { dataPath, readJson, writeJson } from "./state.ts";
import { directOf, directTarget, type Target } from "@ted-personal-assistant/messenger";

// Tenants: the people other than the owner who use this instance. The owner is the tenant "owner" (the folders and files the
// instance has always had, unchanged); a friend is a tenant with a folder of her own:
//   tenants/<id>/tenant.json    her typed overrides (TenantConfig)
//   tenants/<id>/notes/         her notes (the SDK's auto-memory); the only place her file tools reach
//   tenants/<id>/backup/        snapshots of her notes
//   tenants/<id>/messages.jsonl everything said in her chat, size-bounded (no summary model: that would run on the owner's login)
//   tenants/<id>/session.json   her resumed SDK session
//   tenants/<id>/cost.json      what she spent today on the instance key
//   tenants/<id>/consent.json   the one-time age/region confirmation
//   tenants/<id>/meta.json      small bookkeeping (disclosure shown, notice times)
// The folder is outside logs/, state/ and memory/, which are what the owner's chat may read (policy.ts): the owner does not read a friend's
// notes or history through the assistant. The host's admin can, of course: the files are on the owner's Mac (docs/SAFETY.md).
// The registry state/tenants.json holds ONE record per person, the owner included (role admin, every capability, the files above unchanged: pathsOf):
// id, name, sender account ids (ACI), role, status, capabilities and the credential source, never a key. Tenants run on the instance key
// (settings.tenantApiKey, from TENANT_ANTHROPIC_API_KEY), the owner on the login.
// Everything is files, read and written synchronously (state.ts); SQLite is for later.

export const OWNER_ID = "owner";
export const REGISTRY = "state/tenants.json";
export const INVITES = "state/invites.json";

export type TenantStatus = "invited" | "active" | "suspended";
export const STATUSES: readonly TenantStatus[] = ["invited", "active", "suspended"];

// admin: the instance's powers (invites, suspending, the doctor); member: everybody else. It changes only through the local CLI (setAdmin, scripts/tenants.ts).
export type Role = "admin" | "member";
export const ROLES: readonly Role[] = ["admin", "member"];

// What a person may use; everything else about her is data. The owner has all of them, a friend starts with FRIEND_DEFAULTS. Each tool of the manifest
// (toolmanifest.ts) and each shared skill (skills.ts) names the capability that gates it; capabilities.ts turns a set of them into tools and skills.
// weather and draw are free (public data, a sanitised render), so they are on by default; every other capability a friend gets is granted.
export const CAPABILITIES = ["chat", "browse", "voice", "heartbeat", "dream", "wake", "mail", "calendar", "notion", "profile", "card", "notes", "intake", "weather", "draw", "google", "drive", "admin"] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const FRIEND_DEFAULTS: readonly Capability[] = ["chat", "browse", "voice", "heartbeat", "dream", "weather", "draw"];
export const isCapability = (x: unknown): x is Capability => (CAPABILITIES as readonly unknown[]).includes(x);

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
  capabilities: Capability[];
  credential: Credential;
  created: string; // ISO time
}

// Her Signal account id, a UUID.
export const ACI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- typed overrides (tenant.json) ----

export interface TenantConfig {
  language?: string; // the language she writes in, as a hint ("German")
  persona?: string; // how she would like the assistant to talk, in her words (data for the prompt, never rules)
  dailyBudgetUsd?: number; // her own daily ceiling on the instance key
  maxTurns?: number; // per run
  maxBudgetUsdPerRun?: number; // per run
  // DEPRECATED, still honoured (capabilities.ts resolveCapabilities, and it only ever takes away): the general way to switch a tool off for her is her capability set
  // (`npm run tenants -- revoke <id> browse`). These two stay because a tenant.json that says false must not quietly start offering the tool.
  browse?: boolean; // false switches the browse tool off for her (it can never be switched on beyond BROWSE)
  voice?: boolean; // false switches the voice tool off for her
}

const KNOWN: readonly string[] = ["language", "persona", "dailyBudgetUsd", "maxTurns", "maxBudgetUsdPerRun", "browse", "voice"];

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
  const num = (k: "dailyBudgetUsd" | "maxTurns" | "maxBudgetUsdPerRun", min: number, max: number) => {
    if (r[k] === undefined) return;
    if (typeof r[k] !== "number" || !Number.isFinite(r[k]) || (r[k] as number) < min || (r[k] as number) > max) return void problems.push(`${k} must be a number from ${min} to ${max}`);
    config[k] = r[k] as number;
  };
  num("dailyBudgetUsd", 0, 1000);
  num("maxTurns", 1, 40);
  num("maxBudgetUsdPerRun", 0.01, 20);
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
  sessionFile: string;
  logFile: string;
  costFile: string;
  configFile: string;
  consentFile: string;
  metaFile: string;
  role: Role;
  capabilities: readonly Capability[];
  credential: Credential;
  config: TenantConfig;
  dailyBudgetUsd: number;
  maxTurns: number;
  maxBudgetUsdPerRun: number;
  language?: string;
  persona?: string;
}

const dirOf = (id: string): string => {
  if (!TENANT_ID.test(id) || id === OWNER_ID) throw new Error("not a tenant id");
  return join(settings.tenantsDir, id);
};

// Where a person's files are: the owner's are the places the instance has always used (nothing is moved); a friend's are in her folder.
export interface Paths {
  root: string;
  notesDir: string;
  logFile: string;
  sessionFile: string;
  costFile: string;
}
export const pathsOf = (rec: Pick<TenantRecord, "id">): Paths =>
  rec.id === OWNER_ID
    ? { root: settings.dataDir, notesDir: NOTES_DIR, logFile: OWNER_LOG, sessionFile: OWNER_SESSION_FILE, costFile: "state/cost.json" }
    : { root: dirOf(rec.id), notesDir: join(dirOf(rec.id), "notes"), logFile: join(dirOf(rec.id), "messages.jsonl"), sessionFile: join(dirOf(rec.id), "session.json"), costFile: join(dirOf(rec.id), "cost.json") };

export function tenantContext(rec: TenantRecord): TenantContext {
  const dir = dirOf(rec.id);
  const paths = pathsOf(rec);
  const configFile = join(dir, "tenant.json");
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
    backupDir: join(dir, "backup"),
    sessionFile: paths.sessionFile,
    logFile: paths.logFile,
    costFile: paths.costFile,
    configFile,
    consentFile: join(dir, "consent.json"),
    metaFile: join(dir, "meta.json"),
    role: rec.role,
    capabilities: [...rec.capabilities],
    credential: rec.credential,
    config,
    dailyBudgetUsd: config.dailyBudgetUsd ?? settings.tenantDailyBudgetUsd,
    maxTurns: config.maxTurns ?? 12,
    maxBudgetUsdPerRun: config.maxBudgetUsdPerRun ?? 0.5,
    language: config.language,
    persona: config.persona,
  };
}

// The one tool of a tenant's run that is no feature: her one-time age and region confirmation (tenanttools.ts), the only tool before she has given it.
export const TENANT_CONSENT_TOOL = "mcp__tenant__record_consent";

// ---- the registry ----

interface Registry {
  tenants: unknown[];
}

const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

// One stored record, checked and completed: a field a registry written before roles existed lacks gets the safe value (a member with the friend
// defaults), so an old file keeps working and nobody becomes an admin by omission. Undefined: not a usable record.
function normalise(x: unknown): TenantRecord | undefined {
  if (!isRecord(x)) return undefined;
  const { id, name, acis, status, created } = x;
  if (typeof id !== "string" || !TENANT_ID.test(id) || typeof name !== "string" || typeof created !== "string") return undefined;
  if (!Array.isArray(acis) || !acis.every((a) => typeof a === "string" && ACI.test(a)) || !STATUSES.includes(status as TenantStatus)) return undefined;
  const isOwner = id === OWNER_ID;
  const role = x.role === undefined ? (isOwner ? "admin" : "member") : x.role;
  const credential = x.credential === undefined ? (isOwner ? "login" : "instance-key") : x.credential;
  if (!ROLES.includes(role as Role) || !CREDENTIALS.includes(credential as Credential)) return undefined;
  if (x.capabilities !== undefined && !(Array.isArray(x.capabilities) && x.capabilities.every(isCapability))) return undefined;
  const capabilities = x.capabilities === undefined ? (isOwner ? [...CAPABILITIES] : [...FRIEND_DEFAULTS]) : [...new Set(x.capabilities as Capability[])];
  if (x.number !== undefined && typeof x.number !== "string") return undefined;
  return { id, name, acis: [...(acis as string[])], ...(typeof x.number === "string" && x.number ? { number: x.number } : {}), role: role as Role, status: status as TenantStatus, capabilities, credential: credential as Credential, created };
}

// Everybody: the owner (once seeded) and every tenant.
export const people = (): TenantRecord[] => registry().map(normalise).filter((r): r is TenantRecord => !!r);

// `allows`, `tenantById` and every routing question read the registry, on every message and every tick. The file is read and parsed again only when it changed (its
// stat: size, modification time in ns, inode: a write is a rename to a new file, also another process's, `npm run tenants`) and not after this process's own
// write (`save` forgets it). The parsed JSON is shared, the records made from it (`normalise`) are new objects each time.
let cached: { sig: string; tenants: unknown[] } | undefined;
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
  const tenants = readJson<Partial<Registry>>(REGISTRY, {}).tenants ?? [];
  cached = sig ? { sig, tenants } : undefined;
  return tenants;
}
// The tenants: everybody but the owner. What the invitations, routing, suspension and removal work on; none of it can reach the owner's record.
export const listTenants = (): TenantRecord[] => people().filter((r) => r.id !== OWNER_ID);
const save = (all: TenantRecord[]) => (writeJson(REGISTRY, { tenants: all }), (cached = undefined));
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
  const have = people().find((r) => r.id === OWNER_ID);
  if (have) return have;
  const acis = seed.aci && ACI.test(seed.aci) ? [seed.aci] : [];
  const rec: TenantRecord = { id: OWNER_ID, name: settings.owner, acis, ...(seed.number ? { number: seed.number } : {}), role: "admin", status: "active", capabilities: [...CAPABILITIES], credential: "login", created: now.toISOString() };
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
  if (!who.aci || !ACI.test(who.aci)) return false;
  const rec = people().find((r) => r.id === OWNER_ID);
  if (!rec || rec.acis.length || !rec.number || rec.number !== who.number || people().some((r) => hasAci(r, who.aci!))) return false;
  update(OWNER_ID, (r) => ({ ...r, acis: [who.aci!] }));
  audit("owner_aci", "learned", "chat");
  console.log(`tenants: the owner's Signal account id (${who.aci.slice(0, 8)}...) was learned from the first message from her number and recorded once (state/tenants.json)`);
  return true;
}

// ---- roles and capabilities: changed only by the local CLI (scripts/tenants.ts); no tool, no chat path, no model ----

// The admin role moves to this record: the previous admin(s) become members, so there is exactly one. Undefined: no such record.
export function setAdmin(id: string): TenantRecord | undefined {
  if (!people().some((r) => r.id === id)) return undefined;
  const all = people().map((r) => ({ ...r, role: (r.id === id ? "admin" : "member") as Role }));
  save(all);
  return all.find((r) => r.id === id);
}
export const grant = (id: string, capability: Capability): TenantRecord | undefined => update(id, (r) => ({ ...r, capabilities: [...new Set([...r.capabilities, capability])] }));
export const revoke = (id: string, capability: Capability): TenantRecord | undefined => update(id, (r) => ({ ...r, capabilities: r.capabilities.filter((c) => c !== capability) }));

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
  if (!existsSync(ctx.configFile)) writeFileSync(ctx.configFile, "{}\n", { mode: 0o600 });
  return tenantContext(rec);
}

export interface Invite {
  note?: string; // what the owner called it ("for Anna")
}
export const invites = (): OneTimeCodes<Invite> => new OneTimeCodes<Invite>(INVITES);

// The owner's: a single-use code, valid for INVITE_TTL_HOURS. Undefined: too many are open.
export function mintInvite(note?: string, now = Date.now()): { code: string; expiresAt: number } | undefined {
  const ttl = settings.inviteTtlHours * 3600_000;
  const code = invites().mint({ note: note ? oneLine("invite note", note, LIMITS.name) : undefined }, ttl, now);
  return code ? { code, expiresAt: now + ttl } : undefined;
}

// A new sender with a valid code becomes a tenant, 'invited' until she has confirmed age and region; provisioned at once.
// Undefined: the code is not valid (unknown, used, expired).
export function redeemInvite(code: string, who: { aci: string; name?: string }, now = Date.now()): TenantRecord | undefined {
  if (!ACI.test(who.aci)) return undefined;
  if (tenantByAci(who.aci)) return undefined; // she already is one
  const invite = invites().redeem(code, now);
  if (!invite) return undefined;
  const all = people();
  const name = oneLine("tenant name", (who.name || invite.note || "a friend").replace(/[<>"]/g, " "), LIMITS.name) || "a friend";
  const id = newTenantId(name, new Set(all.map((t) => t.id)));
  const rec: TenantRecord = { id, name, acis: [who.aci], role: "member", status: "invited", capabilities: [...FRIEND_DEFAULTS], credential: "instance-key", created: new Date(now).toISOString() };
  save([...all, rec]);
  provision(rec);
  console.log(`tenants: ${id} joined with an invitation`);
  return rec;
}

export const setStatus = (id: string, status: TenantStatus): TenantRecord | undefined => (id === OWNER_ID ? undefined : update(id, (r) => ({ ...r, status })));

// Remove a tenant and her data: the registry entry and her folder (notes, history, session, cost, consent). True: she was a tenant.
// What the host already holds elsewhere (the SDK's own transcript of her sessions under ~/.claude, backups of the Mac) is not reached: docs/SAFETY.md.
export function deleteTenant(id: string, o: { drop?: (id: string) => void } = {}): boolean {
  if (!tenantById(id)) return false;
  save(people().filter((t) => t.id !== id)); // first: from this moment she is nobody
  o.drop?.(id);
  const dir = dirOf(id);
  if (isInside(dir, settings.tenantsDir)) rmSync(dir, { recursive: true, force: true });
  console.log(`tenants: ${id} deleted`);
  return true;
}

// ---- consent, disclosure, notice times: small files in her folder ----

export interface Consent {
  at: string;
  ageConfirmed: true; // she said she is 18 or older
  region: string; // where she lives, as she said it
  version: 1;
}
export const readConsent = (ctx: Pick<TenantContext, "consentFile">): Consent | undefined => {
  const c = readJson<Partial<Consent> | undefined>(ctx.consentFile, undefined);
  return c && c.ageConfirmed === true && typeof c.region === "string" ? (c as Consent) : undefined;
};
export function recordConsent(ctx: Pick<TenantContext, "consentFile" | "id">, region: string, now = new Date()): Consent {
  const c: Consent = { at: now.toISOString(), ageConfirmed: true, region: oneLine("region", region, LIMITS.name), version: 1 };
  writeJson(ctx.consentFile, c);
  const rec = tenantById(ctx.id);
  if (rec && rec.status === "invited") setStatus(ctx.id, "active");
  return c;
}

interface Meta {
  disclosedAt?: string;
  noticeAt?: Record<string, string>;
  pausedUntil?: number; // her cooldown (cooldown.ts keeps it in memory; this is for `npm run doctor`, a separate process)
}
const meta = (ctx: Pick<TenantContext, "metaFile">): Meta => readJson<Meta>(ctx.metaFile, {});
export const wasDisclosed = (ctx: Pick<TenantContext, "metaFile">): boolean => !!meta(ctx).disclosedAt;
export const markDisclosed = (ctx: Pick<TenantContext, "metaFile">): void => writeJson(ctx.metaFile, { ...meta(ctx), disclosedAt: new Date().toISOString() });
export const pausedUntil = (ctx: Pick<TenantContext, "metaFile">, now = Date.now()): number | undefined => {
  const u = meta(ctx).pausedUntil;
  return typeof u === "number" && u > now ? u : undefined;
};
export function setPaused(ctx: Pick<TenantContext, "metaFile">, until: number | undefined): void {
  const { pausedUntil: _old, ...rest } = meta(ctx);
  if (until !== undefined || _old !== undefined) writeJson(ctx.metaFile, until !== undefined ? { ...rest, pausedUntil: until } : rest);
}
// A fixed notice (not set up, budget, cooldown) at most every TENANT_NOTICE_MINUTES: true when it may be sent now (and is marked).
export function mayNotice(ctx: Pick<TenantContext, "metaFile">, kind: string, now = Date.now()): boolean {
  const m = meta(ctx);
  const last = Date.parse(m.noticeAt?.[kind] ?? "");
  if (Number.isFinite(last) && now - last < settings.tenantNoticeMinutes * 60_000) return false;
  writeJson(ctx.metaFile, { ...m, noticeAt: { ...m.noticeAt, [kind]: new Date(now).toISOString() } });
  return true;
}

// Her history is bounded like every log, but never summarised by a model: that call would run on the owner's login, over her words.
export const plainSummary: Summarize = async (_previous, old) => `${old.length} earlier messages (older history is not kept in full)`;
