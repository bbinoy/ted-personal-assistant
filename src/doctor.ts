import { LIMITS } from "./core/sanitize.ts";
import { providerReady, qwenReady } from "@ted-assistant/speech/tts";
import { voiceReady } from "@ted-assistant/speech/voice";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { ROOT } from "./core/paths.ts";
import { spentToday } from "./core/budget.ts";
import { lastLookAt, readRows, type HeartbeatRow } from "./core/looks.ts";
import { HEARTBEAT_KEY } from "./heartbeat/heartbeat.ts";
import { kvGet, openInstanceDbAt } from "./core/instancedb.ts";
import { mailRuntime } from "./modules/runtime.ts";
import type { DoctorLine, MailRuntime } from "./modules/types.ts";
import { ownerSkills } from "./modules/skills.ts";
import { isPaused, localTime, pauseText } from "./core/pause.ts";
import { errorLinesSince } from "./core/logwindow.ts";
import { browseStatus, PLAYWRIGHT_MCP_VERSION, type BrowseStatus } from "./modules/browse/browseserver.ts";
import { killSwitch } from "./modules/browse/card.ts";
import { macKeychain, type Keychain } from "./secrets/keychain.ts";
import { baseUrlProblem, connectionState } from "./intake/intakelinks.ts";
import { clientRegistered } from "./intake/notionoauth.ts";
import { connectionSummary } from "./tenants/connections.ts";
import { capabilitiesOfRecord } from "./policy/capabilities.ts";
import { PURPOSES } from "./intake/intakepurposes.ts";
import { INTAKE_ROLE } from "./secrets/openbaoadmin.ts";
import { BaoError, type OpenBao } from "./secrets/openbao.ts";
import { appBao, ITEM_KINDS, keychainNames, looksLikeApiKey, OWNER } from "./secrets/secrets.ts";
import { openRequests } from "./tenants/registration.ts";
import { listTenants, OWNER_ID, pausedUntil, people, registryProblem, tenantContext } from "./tenants/tenants.ts";
import { Ledger } from "./modules/browse/payments.ts";
import { messengerDoctor } from "./conversation/messenger.ts";
import { settings } from "./core/settings.ts";
import { disconnected, readConnectors, readSeen, reportable } from "./modules/connectors.ts";
import { readNotes } from "./memory/notes.ts";
import { missingSetup } from "./modules/index.ts";
import { dataPath, readText } from "./core/state.ts";
import { checkConvDbFile, damagedConvs } from "./core/convdb.ts";
import { readDream } from "./modules/memory/dreamscope.ts";
import { conversationsDir, dataRoot, instancePaths, isConvId, LAYOUT_VERSION, layout, logPaths, OWNER_CONV } from "./core/convpaths.ts";
import { layoutState, readVersion, refusal, stragglers } from "./core/migrate.ts";
import { readRetentionState, retentionSummary } from "./core/retention.ts";
import { staleForReview } from "./heartbeat/retentionrules.ts";
import { noCalendarData } from "./tasks/meetings.ts";

type Line = DoctorLine;

// The mail provider check. MAIL_PROVIDER=none is a valid setup, not a failure: nothing is connected and nothing is expected. Otherwise it is the mail provider's own
// checks (its module, src/modules: Mailbird reachable; for Gmail the own address, the connector, the archive mode).
export async function mailCheck(line: Line, mail: boolean, check: MailRuntime["check"] | undefined = mailRuntime()?.check): Promise<void> {
  if (!mail) return line(true, "mail: off", "MAIL_PROVIDER=none, chat only");
  await check?.(line);
}

// The browse tool (BROWSE=on by default) needs the pinned @playwright/mcp (npm install) and its browser (npm run setup:browse). Off is a valid setup.
// The OpenBao checks: the store of the saved profile and the card. Reachable, unsealed, and the app's token is the narrow one it should be: it
// has the owner's policy and no other, may use the owner's folder, and may NOT use another tenant's or the system paths. With no token in the
// Keychain the store is not set up (a warning: only saved details and card payments need it); once there is a token, a store that does
// not answer is a failure. `bao` and `keychain` are given by tests.
export async function openbaoCheck(line: Line, o: { bao?: () => OpenBao; keychain?: Keychain; cfg?: typeof settings.openbao } = {}): Promise<void> {
  const cfg = o.cfg ?? settings.openbao;
  const what = "OpenBao (secret store)";
  const keychain = o.keychain ?? macKeychain;
  const hasToken = await keychain.get(keychainNames(cfg.keychainPrefix).token).then((t) => !!t, () => false);
  const down = (detail: string) => line(hasToken ? false : "warn", what, hasToken ? detail : `not set up (${detail}); saved details and card payments need it: npm run openbao -- setup`);
  let bao: OpenBao;
  try {
    bao = (o.bao ?? (() => appBao({ keychain, cfg })))();
  } catch (e) {
    return down((e as Error).message.slice(0, LIMITS.reason));
  }
  try {
    const h = await bao.health();
    if (!h.initialized) return down("the server is running but not initialised");
    if (h.sealed) return line(false, what, "SEALED: nothing can be read. After a reboot the unseal job does it at login; by hand: npm run openbao -- unseal");
    if (!hasToken) return line("warn", what, "unsealed, but this Mac's Keychain has no app token: npm run openbao -- setup");
    const t = await bao.lookupSelf();
    const mine = `data/tenants/${OWNER}/profile/x`;
    const caps = await bao.capabilities([mine, `metadata/tenants/${OWNER}/profile`, `data/tenants/${OWNER}-other/profile/x`, "data/tenants/friend/profile/x", "data/other/x"]);
    const has = (p: string, c: string) => (caps[p] ?? []).includes(c) || (caps[p] ?? []).includes("root");
    const problems: string[] = [];
    if (t.policies.includes("root")) problems.push("the token is a ROOT token");
    if (t.policies.some((p) => p !== "default" && p !== cfg.role)) problems.push(`the token has policies besides ${cfg.role}`);
    if (!["read", "create", "update"].every((c) => has(mine, c))) problems.push("the token cannot read and write the owner's folder");
    if (!has(`metadata/tenants/${OWNER}/profile`, "list")) problems.push("the token cannot list the owner's folder");
    for (const other of [`data/tenants/${OWNER}-other/profile/x`, "data/tenants/friend/profile/x", "data/other/x"]) if ((caps[other] ?? []).some((c) => c !== "deny")) problems.push("the token reaches beyond the owner's folder");
    if (problems.length) return line(false, what, `${problems.join("; ")}: npm run openbao -- setup repairs it`);
    const days = t.ttlSeconds / 86_400;
    line(days < 3 ? "warn" : true, what, `v${h.version ?? "?"} unsealed, token limited to tenants/${OWNER}/ (policy ${cfg.role}), expires in ${days >= 1 ? `${Math.floor(days)} day(s)` : "under a day"}${days < 3 ? "; renew: npm run openbao -- renew" : ""}`);
  } catch (e) {
    down(e instanceof BaoError ? e.message.slice(0, LIMITS.reason) : "the check failed");
  }
}

// "profile, card, google and notion"
const list = (names: readonly string[]): string => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? ""));

// The intake page (intakeserver.ts): is it configured (INTAKE_BASE_URL, https), is its token write-only (create and update on the items of every kind, no
// read, list or delete, nothing else), and is the process answering on its loopback port. Off is a valid setup: no setup links are offered.
export async function intakeCheck(line: Line, o: { cfg?: typeof settings.intake; bao?: () => OpenBao; keychain?: Keychain; probe?: (port: number) => Promise<boolean>; prefix?: string } = {}): Promise<void> {
  const cfg = o.cfg ?? settings.intake;
  const what = "intake page";
  const keychain = o.keychain ?? macKeychain;
  const problem = baseUrlProblem(cfg);
  const hasToken = await keychain.get(keychainNames(o.prefix ?? settings.openbao.keychainPrefix).intake).then((t) => !!t, () => false);
  if (!cfg.baseUrl) line(true, `${what}: off`, "INTAKE_BASE_URL is not set: friends are told setup links are not available yet (the owner sets her own details with npm run profile and npm run card)");
  else if (problem) return line(false, what, problem);
  else line(true, what, `links point to ${new URL(cfg.baseUrl).origin}`);
  if (!hasToken) return cfg.baseUrl ? line("warn", "intake write-only token", "this Mac's Keychain has none: npm run openbao -- setup") : undefined;
  try {
    const bao = (o.bao ?? (() => appBao({ keychain, as: "intake", ...(o.prefix ? { cfg: { ...settings.openbao, keychainPrefix: o.prefix } } : {}) })))();
    const t = await bao.lookupSelf();
    const w = (kind: string) => `data/tenants/x/${kind}/y`;
    const caps = await bao.capabilities([...ITEM_KINDS.map(w), w("other"), ...ITEM_KINDS.map((k) => `metadata/tenants/x/${k}`)]);
    const has = (p: string, c: string) => (caps[p] ?? []).includes(c) || (caps[p] ?? []).includes("root");
    const problems: string[] = [];
    if (t.policies.includes("root") || t.policies.some((p) => p !== "default" && p !== INTAKE_ROLE)) problems.push(`the token has policies besides ${INTAKE_ROLE}`);
    for (const kind of ITEM_KINDS) {
      if (!has(w(kind), "create") || !has(w(kind), "update")) problems.push(`the token cannot write ${kind} items`);
      if (["read", "delete", "list"].some((c) => has(w(kind), c)) || ["read", "list", "delete", "update"].some((c) => has(`metadata/tenants/x/${kind}`, c))) problems.push(`the token can do more than write ${kind} items`);
    }
    if ((caps[w("other")] ?? []).some((c) => c !== "deny")) problems.push(`the token reaches beyond ${list(ITEM_KINDS)} items`);
    if (problems.length) line(false, "intake write-only token", `${problems.join("; ")}: npm run openbao -- setup repairs it`);
    else line(true, "intake write-only token", `policy ${INTAKE_ROLE}: create and update of ${list(ITEM_KINDS)} items, no read, list or delete`);
  } catch (e) {
    line("warn", "intake write-only token", e instanceof BaoError ? e.message.slice(0, LIMITS.reason) : "the check failed");
  }
  if (cfg.baseUrl) {
    const probe = o.probe ?? (async (port: number) => (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) })).ok);
    const up = await probe(cfg.port).catch(() => false);
    line(up ? true : "warn", "intake page process", up ? `answering on 127.0.0.1:${cfg.port}` : `not answering on 127.0.0.1:${cfg.port}: start it with npm run intake (docs/SETUP.md "The intake page")`);
  }
}

// The services a friend connects herself (the OAuth purposes of the intake page, intakepurposes.ts: Google, Notion), ONE check for all of them: only while some friend exists.
// Every friend has them in principle; a service that is not set up is simply not offered (no tools, no skill, no connect link), which is no failure. Is what the service needs set up (never its value) and the page that signs her in there (INTAKE_BASE_URL, https), then what is particular to the
// service (Google: the pinned server's command on this Mac's PATH; Notion: whether the instance's one client is registered yet), and per friend: connected (since when),
// not yet, or needing to connect again (her permission expired or was withdrawn). The status is the intake page's own record (names and times); no token is read for this
// and nothing is sent to the service.
type ServiceExtra = (line: Line, o: ServicesOptions) => void;
export interface ServicesOptions {
  friends?: ReturnType<typeof people>;
  baseUrl?: string | undefined;
  state?: typeof connectionState;
  needs?: Readonly<Record<string, readonly string[]>>; // by purpose: the settings that are missing (tests; otherwise the purpose says)
  onPath?: (command: string) => boolean; // google: is the server's command there?
  registered?: boolean; // notion: has the instance's client been registered with Notion?
}
const SERVICE_EXTRA: Readonly<Record<string, ServiceExtra>> = {
  google: (line, o) => {
    const cfg = settings.google;
    const onPath = o.onPath ?? ((c: string) => (c.includes("/") ? existsSync(c) : (process.env.PATH ?? "").split(":").some((d) => d && existsSync(`${d}/${c}`))));
    if (!onPath(cfg.command)) line("warn", "google for friends: server command", `${cfg.command} was not found on the PATH (brew install uv); friends' Google tools fail until it is`);
    else line(true, "google for friends: server command", `${cfg.command} ${cfg.args[0] ?? ""} (pinned by GOOGLE_MCP_ARGS)`);
  },
  notion: (line, o) => {
    const base = "baseUrl" in o ? o.baseUrl : settings.intake.baseUrl;
    const registered = o.registered ?? clientRegistered(base);
    line(true, "notion for friends: client", registered ? `registered with Notion for ${new URL(base!).origin}` : "not registered yet: it registers itself the first time a friend opens a Connect Notion link");
  },
};

export function servicesCheck(line: Line, o: ServicesOptions = {}): void {
  const everyone = o.friends ?? people();
  for (const [id, purpose] of Object.entries(PURPOSES)) {
    if (!purpose.oauth) continue;
    const friends = everyone.filter((r) => r.id !== OWNER_ID);
    if (!friends.length) continue;
    const what = `${id} for friends`;
    const base = "baseUrl" in o ? o.baseUrl : settings.intake.baseUrl;
    const missing = [...(o.needs?.[id] ?? purpose.needs())];
    const problems = [...(missing.length ? [`${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not set`] : []), ...[baseUrlProblem({ baseUrl: base, allowHttpLoopback: settings.intake.allowHttpLoopback })].filter((x): x is string => !!x)];
    if (problems.length) {
      line(true, what, `not set up (${problems.join("; ")}): friends are not offered it, no tools and no connect link (docs/SETUP.md "${purpose.title.replace(/^Connect /, "")} for friends")`);
      continue;
    }
    SERVICE_EXTRA[id]?.(line, o);
    const state = o.state ?? connectionState;
    for (const r of friends) {
      const c = state(r.id, id);
      const tools = id === "google" ? `; tools: ${["mail", "calendar"].filter((k) => capabilitiesOfRecord(r).has(k as never)).join(", ") || "none"}` : "";
      const service = purpose.title.replace(/^Connect /, "");
      line(
        c.state === "connected" ? true : "warn",
        `${what}: ${r.id}`,
        `${c.state === "connected" ? `connected since ${(c.at ?? "").slice(0, 10)}` : c.state === "reconnect" ? `${service} no longer accepts her connection (since ${(c.at ?? "").slice(0, 10)}); she is told to reconnect and gets a new link when she asks` : `has not connected yet (she asks the assistant for a ${service} link)`}${tools}`,
      );
    }
  }
}

// The tenants (TENANTS=on): the instance key (set or not; never its value), who is there, what state each is in, what she spent today against her own limit,
// and whether she is paused (a limit, no credit, refused: written by the running agent, since this is another process). Never a key, never a word she said.
export function tenantCheck(line: Line, o: { on?: boolean; key?: string | undefined; now?: number; broken?: string | undefined } = {}): void {
  const on = o.on ?? settings.tenants;
  const broken = "broken" in o ? o.broken : registryProblem();
  if (broken !== undefined) line(false, "friends list", `tenants.json in the instance folder can't be read (${broken}); friends are paused, the owner is unaffected. It is kept as is: repair or move it, then restart`);
  if (!on) return line(true, "tenants: off", "TENANTS=off: one person, as always");
  const now = o.now ?? Date.now();
  const key = "key" in o ? o.key : settings.tenantApiKey;
  line(key ? (looksLikeApiKey(key) ? true : "warn") : "warn", "tenant API key", key ? (looksLikeApiKey(key) ? "TENANT_ANTHROPIC_API_KEY is set; it must be a separate Console workspace key with a spend limit, never your own" : "TENANT_ANTHROPIC_API_KEY is set but does not look like an Anthropic API key") : "TENANT_ANTHROPIC_API_KEY is not set: friends are told the assistant is not set up for them (set a separate Console workspace key with a spend limit)");
  const all = listTenants();
  const count = (s: string) => all.filter((t) => t.status === s).length;
  line(true, "tenants", `${all.length} (${count("active")} active, ${count("suspended")} suspended); ${openRequests(now).length} registration request(s) waiting for your answer`);
  for (const rec of all) {
    const ctx = tenantContext(rec);
    const spent = spentToday(ctx.ledger);
    const paused = pausedUntil(ctx, now);
    const problems = [
      spent >= ctx.dailyBudgetUsd ? "today's budget is spent" : "",
      paused ? `paused until ${localTime(new Date(paused).toISOString())}` : "",
    ].filter(Boolean);
    line(rec.status === "suspended" || problems.length === 0 ? true : "warn", `tenant ${rec.id}`, `${rec.status}; capabilities ${[...capabilitiesOfRecord(rec)].join(", ") || "none"}${connectionSummary(rec) ? `; ${connectionSummary(rec)}` : ""}; today $${spent.toFixed(2)} of $${ctx.dailyBudgetUsd}${problems.length ? `; ${problems.join("; ")}` : ""}`);
  }
}

export function browseCheck(line: Line, on: boolean, status: BrowseStatus): void {
  if (!on) return line(true, "browse: off", "BROWSE=off");
  line(status.ok, "browse: browser tool ready", status.ok ? `@playwright/mcp ${PLAYWRIGHT_MCP_VERSION}, headless Chromium; the tool is offered but reports "not set up" until this passes` : `${status.reason}; until then the browse tool tells the user it is not set up`);
}

// The skills that must ship with the repo for the configured setup.
/** Which reference recording the local cloned voice uses, for the doctor. */
export const qwenReference = (q: { builtIn?: boolean; refAudio: string }): string => (q.builtIn ? "built-in sample voice" : `your own file ${q.refAudio}`);

export const requiredSkills = (mail: boolean, provider: string = settings.mailProvider): string[] => ownerSkills(mail, provider, { required: true });

// What the heartbeat line says: the last tick, and the heartbeat run's last look (the looks table of instance.db).
export const heartbeatDetail = (beat: { lastTickAt?: string }, ageMin: number, lastLookAt: string | undefined, localTime: (iso: string) => string): string =>
  beat.lastTickAt ? `last tick ${Math.round(ageMin)} min ago; last look ${lastLookAt ? localTime(lastLookAt) : "none yet"}` : "no tick recorded yet";

// Can the laptop sleep under the assistant? A Mac on battery sleeps with the lid closed (and `caffeinate` only holds off IDLE sleep, not lid-close sleep): every sleep cuts the model
// calls of the heartbeat off and the looks, the scheduled messages and the daily brief come late or not at all. A warning on battery only; on power the lid can still sleep it, which
// is said. `pmset`: `pmset -g batt` and `pmset -g` as text, or undefined (tests; not a Mac). Nothing here changes a system setting.
export function sleepCheck(line: Line, pmset: (args: string[]) => string | undefined = (args) => { try { return execFileSync("pmset", args, { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }); } catch { return undefined; } }): void {
  const batt = pmset(["-g", "batt"]);
  if (batt === undefined) return; // not a Mac, or pmset is not there: nothing to say
  const name = "laptop can sleep";
  const disabled = /\bSleepDisabled\s+1\b/.test(pmset(["-g"]) ?? ""); // `sudo pmset -a disablesleep 1`
  if (!/InternalBattery/.test(batt)) return line(true, name, "no battery (a desktop Mac): it sleeps only when idle sleep is on");
  if (/'Battery Power'/.test(batt)) {
    return line(disabled ? true : "warn", name, disabled ? "on battery power with sleep switched off (disablesleep 1): it keeps running with the lid closed, and drains the battery" : "on battery power: the Mac sleeps when the lid is closed (and caffeinate does not prevent that), so looks fail and scheduled messages come late. Plug it in; for a closed lid see docs/SETUP.md \"Keep it running\"");
  }
  line(true, name, disabled ? "on power, sleep switched off (disablesleep 1)" : "on power; closing the lid still sleeps it unless an external display is attached (clamshell mode) or sleep is switched off (docs/SETUP.md \"Keep it running\")");
}

export const FAILED_LOOKS_WARN = 3; // this many failed or timed-out looks in the window is a warning
export const FAILED_LOOKS_HOURS = 6;

// The heartbeat's own record says the looks are failing: counts from the looks table only, no words.
export function failedLooksCheck(line: Line, rows: readonly HeartbeatRow[], now: Date = new Date()): void {
  const since = now.getTime() - FAILED_LOOKS_HOURS * 3600_000;
  const recent = rows.filter((r) => Date.parse(r.at) >= since);
  const failed = recent.filter((r) => r.outcome === "failed" || r.outcome === "timeout");
  const timeouts = failed.filter((r) => r.outcome === "timeout").length;
  const what = `looks failing in the last ${FAILED_LOOKS_HOURS} hours`;
  if (failed.length < FAILED_LOOKS_WARN) return line(true, what, `${failed.length} of ${recent.length} look(s) failed`);
  line("warn", what, `${failed.length} of ${recent.length} look(s) failed or timed out${timeouts ? ` (${timeouts} timed out)` : ""}; likely causes: the Mac sleeping, no network, or the usage limit (npm run heartbeat-report; docs/SETUP.md "Keep it running")`);
}

// instance.db opens, is in WAL mode, has the schema this code knows, and passes SQLite's quick check; the row counts say whether the ledgers are there (never what is in them).
/** The conversations' databases (assistant.db): a damaged one FAILS with the file's name and what to do; the healthy ones are one line. Reads each read-only, never opens one the normal way (which would set a damaged one aside). */
export function convDbCheck(line: Line, root: string = dataRoot()): void {
  const L = layout(root);
  const names = existsSync(L.conversations) ? readdirSync(L.conversations).filter(isConvId) : [];
  const damaged = new Map(damagedConvs(root).map((d) => [d.conv, d]));
  let ok = 0;
  for (const conv of names) {
    const p = L.conv(conv);
    const marker = damaged.get(conv);
    const verdict = existsSync(p.db) ? checkConvDbFile(p.db) : "ok";
    if (marker) line(false, `conversation database ${conv}`, `was damaged${marker.at ? ` at ${localTime(marker.at)}` : ""} and set aside as ${marker.keptAs || "assistant.db.corrupt-*"}${marker.salvaged ? ` (the mail already handled${marker.salvaged.session ? " and the session" : ""} were copied into the fresh one: ${marker.salvaged.seenMail} id(s))` : ""}; its background work (looks, dream, approvals) is stopped, chat goes on with a fresh start${marker.pendingLost?.length ? `; approvals that were waiting and are NOT restored: ${marker.pendingLost.map((x) => `#${x.n}${x.label ? ` ${x.label}` : ""}`).join("; ")}` : ""}. Restore the set-aside file with the agent stopped (or sqlite3 .recover), then run: npm run convdb -- accept ${conv}; accepting without restoring keeps the fresh start (the first look then skips what is in the inbox, it does not triage it again)`);
    else if (verdict !== "ok") line(false, `conversation database ${conv}`, `${verdict}; restore ${p.db} from your backup with the agent stopped, or the agent will set it aside at its next use`);
    else if (existsSync(p.db)) {
      ok++;
      const late = lateReminders(p.db);
      if (late) line("warn", `reminders sent late in ${conv}`, `${late} in the last 7 days (the Mac asleep or the agent down at their time; npm run heartbeat-report, docs/SETUP.md "Keep it running")`);
      if (conv === OWNER_CONV) prepLine(line, p.db);
      const lost = lostApprovals(p.db);
      if (lost.length) line("warn", `approvals not restored in ${conv}`, `${lost.map((x) => `#${x.n}${x.label ? ` ${x.label}` : ""}`).join("; ")}; they are not run, ask again if wanted (listed for 30 days)`);
    }
  }
  if (ok > 0 || names.length === 0) line(true, "conversation databases", `${ok} assistant.db file(s), quick_check ok`);
}

/** Meeting prep (heartbeat/preptick.ts) is on but the look has recorded no meetings for over a day: the calendar is not connected, or the look does not run. Read-only like the checks around it. */
function prepLine(line: Line, path: string): void {
  if (settings.prepMinutes <= 0) return;
  let raw: DatabaseSync | undefined;
  let at: number | undefined;
  try {
    raw = new DatabaseSync(path, { readOnly: true });
    at = (raw.prepare("SELECT at FROM meeting_calls WHERE id = 1").get() as { at: number } | undefined)?.at;
  } catch {
    /* an older schema has no such table: no data */
  } finally {
    try { raw?.close(); } catch { /* closed */ }
  }
  let age = 0;
  try { age = Date.now() - statSync(path).birthtimeMs; } catch { /* unknown: not blamed */ }
  if (noCalendarData({ enabled: true, lastNoted: at, dbAgeMs: age, now: Date.now() })) line("warn", "meeting prep: no calendar data", `${at ? `the look last recorded meetings ${localTime(new Date(at).toISOString())}` : "the look has never recorded any meetings"}; check that the Google Calendar connector is connected and the heartbeat is running (set PREP_MINUTES=0 to switch prep off)`);
  else if (at !== undefined) line(true, "meeting prep", `${settings.prepMinutes} min before meetings with other people; the look last reported ${localTime(new Date(at).toISOString())}`);
}

/** How many reminders went out late (after a sleep or a restart) in the last 7 days: read-only, never opens the database the normal way. */
function lateReminders(path: string): number {
  let raw: DatabaseSync | undefined;
  try {
    raw = new DatabaseSync(path, { readOnly: true });
    return Number((raw.prepare("SELECT COUNT(*) AS n FROM reminders WHERE late = 1 AND at > ?").get(Date.now() - 7 * 86_400_000) as { n: number }).n);
  } catch {
    return 0; // (an older schema has no such table)
  } finally {
    try { raw?.close(); } catch { /* closed */ }
  }
}

/** The approvals that could not be restored into this database (a late pending.json, a damaged file): read-only, never opens it the normal way. */
function lostApprovals(path: string): { n: number; label: string }[] {
  let raw: DatabaseSync | undefined;
  try {
    raw = new DatabaseSync(path, { readOnly: true });
    return (raw.prepare("SELECT n, label FROM pending_lost ORDER BY seq").all() as { n: number; label: string }[]).slice(0, 20);
  } catch {
    return [];
  } finally {
    try { raw?.close(); } catch { /* closed */ }
  }
}

export function dbCheck(line: Line, path: string = instancePaths().db): boolean {
  try {
    const db = openInstanceDbAt(path);
    const verdict = db.check(true);
    const count = (t: string) => db.num(`SELECT COUNT(*) FROM ${t}`);
    line(verdict === "ok" && db.journalMode === "wal", "instance database", `${db.journalMode} mode, schema ${db.version}, integrity_check ${verdict}; ${count("spend")} spend, ${count("payments")} payment, ${count("looks")} look row(s)${verdict === "ok" ? "" : "; restore it from a backup (docs/SETUP.md)"}`);
    return verdict === "ok";
  } catch (e) {
    line(false, "instance database", (e as Error).message);
    return false;
  }
}

// `npm run doctor`: is everything this agent depends on in place? Prints no secrets.
export async function doctor() {
  const root = `${ROOT}/`;
  let bad = 0;
  const line = (ok: boolean | "warn", what: string, detail = "") => {
    if (ok === false) bad++;
    console.log(`${ok === true ? "ok  " : ok === "warn" ? "warn" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
  };
  const run = (cmd: string, args: string[]) => {
    try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return undefined; }
  };

  const major = Number(process.versions.node.split(".")[0]);
  line(major >= 24, "Node 24+ (runs TypeScript directly)", major >= 24 ? process.versions.node : `${process.versions.node}; install Node 24 or newer`);

  const envPath = `${root}.env`;
  if (!existsSync(envPath)) line(false, ".env present", "copy .env.example to .env and fill in SIGNAL_OWNER_NUMBER");
  else {
    const mode = (statSync(envPath).mode & 0o777).toString(8);
    line(mode === "600", ".env is owner-only (600)", mode === "600" ? `mode ${mode}` : `mode ${mode}; fix: chmod 600 .env`);
    const env = await readFile(envPath, "utf8");
    line(/^SIGNAL_OWNER_NUMBER=\+\d+/m.test(env), "SIGNAL_OWNER_NUMBER set", /^SIGNAL_OWNER_NUMBER=\+\d+/m.test(env) ? "" : "add SIGNAL_OWNER_NUMBER=+<your number> to .env");
    line(!/^ANTHROPIC_API_KEY=./m.test(env) || settings.credential === "api-key" ? true : "warn", "no API key shadowing the stored login", "API key lines override login mode only if HARNESS_AUTH=api-key");
  }

  // The chat platform (MESSENGER): its own checks come from its package (for Signal: the mode, signal-cli installed and linked, the daemon reachable).
  for (const l of await messengerDoctor(settings.signalOwnAccount)) line(l.ok, l.what, l.detail);

  await mailCheck(line, settings.mail);

  const auth = run("claude", ["auth", "status"]);
  line(!!auth && !/not logged in|logged out/i.test(auth), "Claude login valid (needed for Notion/Calendar/Gmail connectors)", !!auth && !/not logged in|logged out/i.test(auth) ? "" : "fix: claude auth login");

  const lc = run("launchctl", ["list", settings.launchdLabel]);
  line(lc ? (/"PID"/.test(lc) ? true : "warn") : false, `launchd job ${settings.launchdLabel} loaded and running`, lc ? "" : "not loaded; fix: scripts/install-launchd.sh");

  // The skills ship with the repo (plugin/skills), so there is nothing to install. What each
  // one still needs about the owner lives in memory notes, and the chat sets those up.
  for (const skill of requiredSkills(settings.mail)) {
    line(existsSync(`${settings.pluginDir}/skills/${skill}/SKILL.md`), `skill ${skill} (bundled)`);
  }
  // On an old data folder doctor still runs (it is what one reaches for when things look wrong): the layout line fails and says what to do, and only the checks that read the new layout are skipped.
  const legacy = refusal(layoutState(settings.dataDir)) !== null;
  if (!legacy) convDbCheck(line);
  const dbOk = !legacy && dbCheck(line); // (instance.db: spend, payments, looks, notices, intake marks, connectors; a damaged one skips the checks that read it)
  const conn = dbOk ? readConnectors() : undefined;
  if (conn) {
    // Every connector module the owner uses (src/modules: Notion, Calendar, Drive and Docs once unhidden, ...); the mail provider's own is the mail check above.
    const seen = readSeen();
    for (const r of reportable().filter((x) => !x.mail)) {
      if (r.optional && conn[r.key] === false && !seen.includes(r.key)) line(true, `${r.label} connector`, "not connected (optional)");
      else line(conn[r.key] !== false ? true : "warn", `${r.label} connector`, conn[r.key] !== false ? "" : `not available in the last run (${localTime(conn.at)}): add it in your Claude account (Settings, Connectors); without it: ${r.skipped}`);
    }
  }
  const gaps = legacy ? [] : missingSetup(readNotes(), disconnected(conn), settings.mail);
  if (!legacy) line(gaps.length === 0 ? true : "warn", "setup notes", gaps.length ? `not set up yet: ${gaps.join("; ")}. Message the assistant "set up".` : settings.mail ? "calendars, tasks, meetings and writing voice are set up" : "calendars, tasks and meetings are set up");

  const layoutVersion = readVersion(settings.dataDir);
  if (legacy) line(false, "data layout", "old data layout: start the agent once or run `npm run migrate`; `npm run migrate -- --dry-run` shows the plan. Checks that need the new layout are skipped");
  else line(layoutVersion === LAYOUT_VERSION ? true : "warn", "data layout", layoutVersion === LAYOUT_VERSION ? `version ${layoutVersion}: instance/, conversations/<id>/, logs/` : "not stamped yet: the first start does it (or run npm run migrate)");
  if (!legacy) {
    const late = stragglers(settings.dataDir).map((o) => o.from.slice(settings.dataDir.length + 1));
    if (late.length) line(false, "files in the old places", `${late.length} path(s) an older version wrote after the move (${late.slice(0, 5).join(", ")}); restart the agent: it merges the logs and sets the rest aside in instance/migration-orphans/`);
  }
  for (const [name, dir] of [["instance", instancePaths().dir], ["conversations", conversationsDir()], ["logs", logPaths().dir]] as const) {
    if (legacy || !existsSync(dir)) continue;
    const loose = readdirSync(dir).filter((f) => (statSync(`${dir}/${f}`).mode & 0o077) !== 0 && statSync(`${dir}/${f}`).isFile());
    line((statSync(dir).mode & 0o077) === 0, `${name}/ directory is owner-only`, (statSync(dir).mode & 0o077) === 0 ? "" : `fix: chmod 700 ${dir}`);
    line(loose.length === 0 ? true : "warn", `${name}/ files are owner-only`, loose.length ? `group/world-readable: ${loose.join(", ")}` : "");
  }
  if (!legacy) line(true, "the owner's notes", `${readNotes().length} active note(s)`); // the count only, never the notes

  const voice = voiceReady(settings.whisperModel);
  line(voice.ok ? true : "warn", "voice messages", voice.ok ? "transcribed locally with whisper.cpp" : `not available, missing: ${voice.missing.join("; ")}`);

  const tts = providerReady(settings.tts);
  const remote = settings.tts.provider === "elevenlabs" || settings.tts.provider === "http";
  const qwen = settings.tts.provider === "qwen" ? qwenReady(settings.tts.qwen) : undefined;
  const where = settings.tts.provider === "elevenlabs" ? "ElevenLabs (spoken text is sent to elevenlabs.io)" : settings.tts.provider === "http" ? `your own server at ${new URL(settings.tts.http.url).host} (spoken text is sent there)` : settings.tts.provider === "qwen" ? (qwen!.ok ? `local cloned voice (Qwen3-TTS ${settings.tts.qwen.model.split("/").pop()}; reference: ${qwenReference(settings.tts.qwen)}); fallback: ${settings.tts.fallback}` : `Qwen voice not ready (${qwen!.missing.join(", ")}); ${tts.ok ? "Kokoro speaks instead" : "no fallback"}`) : `local Kokoro, voice ${settings.tts.kokoro.voice}`;
  line(tts.ok && (!qwen || qwen.ok) || !settings.voiceReplies ? true : "warn", "spoken replies", !settings.voiceReplies ? "off (VOICE_REPLIES=off)" : tts.ok ? `${where}${remote ? `; fallback: ${settings.tts.fallback}` : ""}${process.env.SIGNAL_ACCOUNT ? "" : " (needs the assistant's own Signal account)"}` : `not set up, missing: ${tts.missing.join(", ")} (${remote ? "install ffmpeg" : qwen ? "npm run setup:tts-qwen (optionally set TTS_REF_AUDIO and TTS_REF_TEXT for your own voice)" : "run scripts/setup-tts.sh"})`);

  const dream = legacy ? {} : readDream(OWNER_CONV);
  if (!legacy) line(true, "nightly dream", settings.dream ? `once a day from ${String(settings.dreamHour).padStart(2, "0")}:00 (DREAM_HOUR); last run ${dream.lastRunAt ? localTime(dream.lastRunAt) : "not yet"}` : "off (DREAM=off)");

  if (!legacy) {
    const r = retentionSummary(readRetentionState(instancePaths().retention), settings.retention, localTime);
    line(r.ok, "retention", r.detail);
    const old = staleForReview(layout(dataRoot()), new Date(), settings.migrationReviewDays);
    if (old.length) line("warn", "old migration copies", `${old.length} entr${old.length === 1 ? "y" : "ies"} in instance/migration-backup or migration-orphans older than ${settings.migrationReviewDays} days (${old.slice(0, 3).map((o) => o.name).join(", ")}): review and delete them by hand, nothing removes them`);
  }

  browseCheck(line, settings.browse, browseStatus());
  await openbaoCheck(line);
  if (dbOk) {
    await intakeCheck(line);
    tenantCheck(line);
  }
  servicesCheck(line);

  if (dbOk) {
  const beat = kvGet<{ lastTickAt?: string }>(HEARTBEAT_KEY, {});
  const ageMin = beat.lastTickAt ? (Date.now() - Date.parse(beat.lastTickAt)) / 60_000 : Infinity;
  line(
    ageMin <= 2 * settings.heartbeatMinutes + 1 ? true : "warn",
    "heartbeat is ticking",
    heartbeatDetail(beat, ageMin, lastLookAt(), localTime),
  );
  sleepCheck(line);
  failedLooksCheck(line, readRows(1));
  line(true, "heartbeat run", `every conversation's look (owner, groups, friends with wake) at its chat and what it can read, on ${settings.heartbeatModel}, about every ${settings.heartbeatDayMinutes} min in the day (npm run heartbeat-report)`);

  const spent = spentToday();
  line(spent < settings.dailyBudgetUsd, "daily spend guard", `$${spent.toFixed(2)} of $${settings.dailyBudgetUsd} today (notional)${spent < settings.dailyBudgetUsd ? "" : `: background work is paused until midnight; to change it set DAILY_BUDGET_USD in .env and restart`}`);
  line(isPaused() ? "warn" : true, "not paused", isPaused() ? `${pauseText() ?? "paused"} (${dataPath(instancePaths().paused)}); to resume say /resume in your chat or delete that file` : "");
  const cardOff = killSwitch.off();
  const unconfirmed = new Ledger().rows().filter((r) => r.status === "unconfirmed").length;
  line(unconfirmed ? "warn" : true, "card payments", `${cardOff ? `OFF (${cardOff}); switch on: npm run card -- enable` : "not switched off (npm run card -- list shows the card, if one is saved)"}${unconfirmed ? `; ${unconfirmed} payment(s) unconfirmed: npm run card -- payments` : ""}`);
  }
  const logFile = dataPath(logPaths().agent);
  const recentErrors = existsSync(logFile) ? errorLinesSince(readText(logFile) ?? "", statSync(logFile).mtimeMs, Date.now() - 3600_000) : 0; // (log lines have a time but no date: logwindow.ts)
  line(recentErrors === 0 ? true : "warn", "no errors in the log in the last hour", recentErrors ? `${recentErrors} error line(s) in logs/agent.log; look at them with: grep " ERR " ${logFile} | tail -n 20` : "");

  console.log(bad === 0 ? "\nAll required checks passed." : `\n${bad} check(s) failed.`);
  process.exit(bad === 0 ? 0 : 1);
}
