import { LIMITS } from "./sanitize.ts";
import { providerReady, qwenReady } from "@ted-personal-assistant/signal/tts";
import { voiceReady } from "@ted-personal-assistant/signal/voice";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spentToday } from "./budget.ts";
import { inQuietHours } from "./actions.ts";
import { mailRuntime } from "./modules/runtime.ts";
import type { DoctorLine, MailRuntime } from "./modules/types.ts";
import { ownerSkills } from "./skills.ts";
import { isPaused, localTime } from "./pause.ts";
import { browseStatus, PLAYWRIGHT_MCP_VERSION, type BrowseStatus } from "./browseserver.ts";
import { killSwitch } from "./card.ts";
import { macKeychain, type Keychain } from "./keychain.ts";
import { baseUrlProblem, connectionState } from "./intakelinks.ts";
import { clientRegistered } from "./notionoauth.ts";
import { connectionSummary } from "./connections.ts";
import { readDone } from "./intakelinks.ts";
import { INTAKE_ROLE } from "./openbaoadmin.ts";
import { BaoError, type OpenBao } from "./openbao.ts";
import { appBao, keychainNames, looksLikeApiKey, OWNER } from "./secrets.ts";
import { invites, listTenants, OWNER_ID, pausedUntil, people, readConsent, tenantContext } from "./tenants.ts";
import { Ledger } from "./payments.ts";
import { messengerDoctor } from "./messenger.ts";
import { settings } from "./settings.ts";
import { disconnected, NAMES, readConnectors } from "./connectors.ts";
import { missingSetup, readNotes } from "./notes.ts";
import { dataPath, readJson, readText } from "./state.ts";

type Line = DoctorLine;

// The mail check. MAIL_PROVIDER=none is a valid setup, not a failure: nothing is connected and nothing is expected. Otherwise it is the mail provider's own
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

// The intake page (intakeserver.ts): is it configured (INTAKE_BASE_URL, https), is its token write-only (create and update on profile and card items, no
// read, list or delete, nothing else), and is the process answering on its loopback port. Off is a valid setup: no setup links are offered.
export async function intakeCheck(line: Line, o: { cfg?: typeof settings.intake; bao?: () => OpenBao; keychain?: Keychain; probe?: (port: number) => Promise<boolean>; prefix?: string } = {}): Promise<void> {
  const cfg = o.cfg ?? settings.intake;
  const what = "intake page";
  const keychain = o.keychain ?? macKeychain;
  const problem = baseUrlProblem(cfg);
  const hasToken = await keychain.get(keychainNames(o.prefix ?? settings.openbao.keychainPrefix).intake).then((t) => !!t, () => false);
  if (!cfg.baseUrl) line(true, `${what}: off`, "INTAKE_BASE_URL is not set: friends are told setup links are not available yet (the owner can still use npm run intake -- link owner profile)");
  else if (problem) return line(false, what, problem);
  else line(true, what, `links point to ${new URL(cfg.baseUrl).origin}`);
  if (!hasToken) return cfg.baseUrl ? line("warn", "intake write-only token", "this Mac's Keychain has none: npm run openbao -- setup") : undefined;
  try {
    const bao = (o.bao ?? (() => appBao({ keychain, as: "intake", ...(o.prefix ? { cfg: { ...settings.openbao, keychainPrefix: o.prefix } } : {}) })))();
    const t = await bao.lookupSelf();
    const w = (kind: string) => `data/tenants/x/${kind}/y`;
    const caps = await bao.capabilities([w("profile"), w("card"), w("google"), w("notion"), w("other"), "metadata/tenants/x/profile", "metadata/tenants/x/card", "metadata/tenants/x/google", "metadata/tenants/x/notion"]);
    const has = (p: string, c: string) => (caps[p] ?? []).includes(c) || (caps[p] ?? []).includes("root");
    const problems: string[] = [];
    if (t.policies.includes("root") || t.policies.some((p) => p !== "default" && p !== INTAKE_ROLE)) problems.push(`the token has policies besides ${INTAKE_ROLE}`);
    for (const kind of ["profile", "card", "google", "notion"]) {
      if (!has(w(kind), "create") || !has(w(kind), "update")) problems.push(`the token cannot write ${kind} items`);
      if (["read", "delete", "list"].some((c) => has(w(kind), c)) || ["read", "list", "delete", "update"].some((c) => has(`metadata/tenants/x/${kind}`, c))) problems.push(`the token can do more than write ${kind} items`);
    }
    if ((caps[w("other")] ?? []).some((c) => c !== "deny")) problems.push("the token reaches beyond profile, card, google and notion items");
    if (problems.length) line(false, "intake write-only token", `${problems.join("; ")}: npm run openbao -- setup repairs it`);
    else line(true, "intake write-only token", `policy ${INTAKE_ROLE}: create and update of profile, card, google and notion items, no read, list or delete`);
  } catch (e) {
    line("warn", "intake write-only token", e instanceof BaoError ? e.message.slice(0, LIMITS.reason) : "the check failed");
  }
  if (cfg.baseUrl) {
    const probe = o.probe ?? (async (port: number) => (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) })).ok);
    const up = await probe(cfg.port).catch(() => false);
    line(up ? true : "warn", "intake page process", up ? `answering on 127.0.0.1:${cfg.port}` : `not answering on 127.0.0.1:${cfg.port}: start it with npm run intake (docs/SETUP.md "The intake page")`);
  }
}

// Google for friends (modules/google.ts): only when some friend has the `google` capability. Is the OAuth client set up (never its value), is the page that signs
// her in there (INTAKE_BASE_URL), is the pinned server's command on this Mac's PATH, and per friend: connected (since when) or not yet, and the mail and calendar
// capabilities that make the connection useful. The status is the intake page's own record (names and lengths); no token is read for this.
export function googleCheck(line: Line, o: { cfg?: typeof settings.google; baseUrl?: string | undefined; onPath?: (command: string) => boolean; friends?: ReturnType<typeof people>; done?: typeof readDone } = {}): void {
  const cfg = o.cfg ?? settings.google;
  const friends = (o.friends ?? people()).filter((r) => r.id !== OWNER_ID && r.capabilities.includes("google"));
  if (!friends.length) return;
  const what = "google for friends";
  const missing = [!cfg.clientId && "GOOGLE_OAUTH_CLIENT_ID", !cfg.clientSecret && "GOOGLE_OAUTH_CLIENT_SECRET", !(o.baseUrl ?? settings.intake.baseUrl) && "INTAKE_BASE_URL"].filter(Boolean);
  if (missing.length) return line(false, what, `${friends.length} friend(s) have the google capability but ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not set (docs/SETUP.md "Google for friends")`);
  const onPath = o.onPath ?? ((c: string) => c.includes("/") ? existsSync(c) : (process.env.PATH ?? "").split(":").some((d) => d && existsSync(`${d}/${c}`)));
  if (!onPath(cfg.command)) line("warn", `${what}: server command`, `${cfg.command} was not found on the PATH (brew install uv); friends' Google tools fail until it is`);
  else line(true, `${what}: server command`, `${cfg.command} ${cfg.args[0] ?? ""} (pinned by GOOGLE_MCP_ARGS)`);
  const done = o.done ?? readDone;
  for (const r of friends) {
    const d = done(r.id, "google");
    const tools = ["mail", "calendar"].filter((c) => r.capabilities.includes(c as never));
    line(d ? true : "warn", `${what}: ${r.id}`, `${d ? `connected since ${d.at.slice(0, 10)}` : "has not connected yet (she asks the assistant for a Google link)"}; tools: ${tools.join(", ") || "none (grant mail and calendar)"}`);
  }
}

// Notion for friends (modules/notionhosted.ts): only when some friend has the `notion` capability. Is the page that signs her in there (INTAKE_BASE_URL, https), is the
// instance's one client registered with Notion yet (it registers itself on the first Connect Notion; its id is no secret and is not printed), and per friend: connected
// (since when), not yet, or needing to connect again (her permission expired or was withdrawn). Nothing is read from her secrets for this and nothing is sent to Notion.
export function notionCheck(line: Line, o: { baseUrl?: string | undefined; registered?: boolean; friends?: ReturnType<typeof people>; state?: typeof connectionState } = {}): void {
  const friends = (o.friends ?? people()).filter((r) => r.id !== OWNER_ID && r.capabilities.includes("notion"));
  if (!friends.length) return;
  const what = "notion for friends";
  const base = "baseUrl" in o ? o.baseUrl : settings.intake.baseUrl;
  const problem = baseUrlProblem({ baseUrl: base, allowHttpLoopback: settings.intake.allowHttpLoopback });
  if (problem) return line(false, what, `${friends.length} friend(s) have the notion capability but ${problem} (docs/SETUP.md "Notion for friends")`);
  const registered = o.registered ?? clientRegistered(base);
  line(true, `${what}: client`, registered ? `registered with Notion for ${new URL(base!).origin}` : "not registered yet: it registers itself the first time a friend opens a Connect Notion link");
  const state = o.state ?? connectionState;
  for (const r of friends) {
    const c = state(r.id, "notion");
    line(c.state === "connected" ? true : "warn", `${what}: ${r.id}`, c.state === "connected" ? `connected since ${(c.at ?? "").slice(0, 10)}` : c.state === "reconnect" ? `Notion no longer accepts her connection (since ${(c.at ?? "").slice(0, 10)}); she is told to reconnect and gets a new link when she asks` : "has not connected yet (she asks the assistant for a Notion link)");
  }
}

// The tenants (TENANTS=on): the instance key (set or not; never its value), who is there, what state each is in, what she spent today against her own limit,
// and whether she is paused (a limit, no credit, refused: written by the running agent, since this is another process). Never a key, never a word she said.
export function tenantCheck(line: Line, o: { on?: boolean; key?: string | undefined; now?: number } = {}): void {
  const on = o.on ?? settings.tenants;
  if (!on) return line(true, "tenants: off", "TENANTS=off: one person, as always");
  const now = o.now ?? Date.now();
  const key = "key" in o ? o.key : settings.tenantApiKey;
  line(key ? (looksLikeApiKey(key) ? true : "warn") : "warn", "tenant API key", key ? (looksLikeApiKey(key) ? "TENANT_ANTHROPIC_API_KEY is set; it must be a separate Console workspace key with a spend limit, never your own" : "TENANT_ANTHROPIC_API_KEY is set but does not look like an Anthropic API key") : "TENANT_ANTHROPIC_API_KEY is not set: friends are told the assistant is not set up for them (set a separate Console workspace key with a spend limit)");
  const all = listTenants();
  const count = (s: string) => all.filter((t) => t.status === s).length;
  line(true, "tenants", `${all.length} (${count("active")} active, ${count("invited")} invited, ${count("suspended")} suspended); ${invites().count(now)} invite code(s) open`);
  for (const rec of all) {
    const ctx = tenantContext(rec);
    const spent = spentToday(ctx.costFile);
    const paused = pausedUntil(ctx, now);
    const problems = [
      !readConsent(ctx) ? "age/region not confirmed yet" : "",
      spent >= ctx.dailyBudgetUsd ? "today's budget is spent" : "",
      paused ? `paused until ${localTime(new Date(paused).toISOString())}` : "",
    ].filter(Boolean);
    line(rec.status === "suspended" || problems.length === 0 ? true : "warn", `tenant ${rec.id}`, `${rec.status}; capabilities ${rec.capabilities.join(", ") || "none"}${connectionSummary(rec) ? `; ${connectionSummary(rec)}` : ""}; today $${spent.toFixed(2)} of $${ctx.dailyBudgetUsd}${problems.length ? `; ${problems.join("; ")}` : ""}`);
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

// What the heartbeat line says after "last tick": mail is only mentioned when there is mail.
export const heartbeatDetail = (beat: { lastTickAt?: string; lastNewMailAt?: string }, ageMin: number, quiet: boolean, mail: boolean, localTime: (iso: string) => string): string =>
  beat.lastTickAt ? `last tick ${Math.round(ageMin)} min ago${quiet ? ", night idle now" : ""}${mail ? `; last new mail ${beat.lastNewMailAt ? localTime(beat.lastNewMailAt) : "none yet"}` : "; mail off"}` : "no tick recorded yet";

// `npm run doctor`: is everything this agent depends on in place? Prints no secrets.
export async function doctor() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  let bad = 0;
  const line = (ok: boolean | "warn", what: string, detail = "") => {
    if (ok === false) bad++;
    console.log(`${ok === true ? "ok  " : ok === "warn" ? "warn" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
  };
  const run = (cmd: string, args: string[]) => {
    try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return undefined; }
  };

  const major = Number(process.versions.node.split(".")[0]);
  line(major >= 24, "Node 24+ (runs TypeScript directly)", process.versions.node);

  const envPath = `${root}.env`;
  if (!existsSync(envPath)) line(false, ".env present");
  else {
    const mode = (statSync(envPath).mode & 0o777).toString(8);
    line(mode === "600", ".env is owner-only (600)", `mode ${mode}`);
    const env = await readFile(envPath, "utf8");
    line(/^SIGNAL_OWNER_NUMBER=\+\d+/m.test(env), "SIGNAL_OWNER_NUMBER set");
    line(!/^ANTHROPIC_API_KEY=./m.test(env) || settings.credential === "api-key" ? true : "warn", "no API key shadowing the stored login", "API key lines override login mode only if HARNESS_AUTH=api-key");
  }

  // The chat platform (MESSENGER): its own checks come from its package (for Signal: the mode, signal-cli installed and linked, the daemon reachable).
  for (const l of await messengerDoctor(settings.signalOwnAccount)) line(l.ok, l.what, l.detail);

  await mailCheck(line, settings.mail);

  const auth = run("claude", ["auth", "status"]);
  line(!!auth && !/not logged in|logged out/i.test(auth), "Claude login valid (needed for Notion/Calendar/Gmail connectors)");

  const lc = run("launchctl", ["list", settings.launchdLabel]);
  line(lc ? (/"PID"/.test(lc) ? true : "warn") : false, `launchd job ${settings.launchdLabel} loaded and running`, lc ? "" : "not loaded");

  // The skills ship with the repo (plugin/skills), so there is nothing to install. What each
  // one still needs about the owner lives in memory notes, and the chat sets those up.
  for (const skill of requiredSkills(settings.mail)) {
    line(existsSync(`${settings.pluginDir}/skills/${skill}/SKILL.md`), `skill ${skill} (bundled)`);
  }
  const conn = readConnectors();
  if (conn) {
    for (const k of ["notion", "calendar"] as const) line(conn[k] ? true : "warn", `${NAMES[k]} connector`, conn[k] ? "" : `not available in the last run (${localTime(conn.at)}): add it in your Claude account (Settings, Connectors)`);
  }
  const gaps = missingSetup(readNotes(), disconnected(conn), settings.mail);
  line(gaps.length === 0 ? true : "warn", "setup notes", gaps.length ? `not set up yet: ${gaps.join("; ")}. Message the assistant "set up".` : settings.mail ? "calendars, tasks, meetings and writing voice are set up" : "calendars, tasks and meetings are set up");

  for (const [name, dir] of [["state", settings.stateDir], ["logs", settings.logsDir], ["memory", settings.memoryDir]] as const) {
    if (!existsSync(dir)) continue;
    const loose = readdirSync(dir).filter((f) => (statSync(`${dir}/${f}`).mode & 0o077) !== 0 && statSync(`${dir}/${f}`).isFile());
    line((statSync(dir).mode & 0o077) === 0, `${name}/ directory is owner-only`);
    line(loose.length === 0 ? true : "warn", `${name}/ files are owner-only`, loose.length ? `group/world-readable: ${loose.join(", ")}` : "");
  }
  line(true, "memory/notes/", `${readNotes().length} active note(s)`); // the count only, never the notes

  const voice = voiceReady(settings.whisperModel);
  line(voice.ok ? true : "warn", "voice messages", voice.ok ? "transcribed locally with whisper.cpp" : `not available, missing: ${voice.missing.join("; ")}`);

  const tts = providerReady(settings.tts);
  const remote = settings.tts.provider === "elevenlabs" || settings.tts.provider === "http";
  const qwen = settings.tts.provider === "qwen" ? qwenReady(settings.tts.qwen) : undefined;
  const where = settings.tts.provider === "elevenlabs" ? "ElevenLabs (spoken text is sent to elevenlabs.io)" : settings.tts.provider === "http" ? `your own server at ${new URL(settings.tts.http.url).host} (spoken text is sent there)` : settings.tts.provider === "qwen" ? (qwen!.ok ? `local cloned voice (Qwen3-TTS ${settings.tts.qwen.model.split("/").pop()}; reference: ${qwenReference(settings.tts.qwen)}); fallback: ${settings.tts.fallback}` : `Qwen voice not ready (${qwen!.missing.join(", ")}); ${tts.ok ? "Kokoro speaks instead" : "no fallback"}`) : `local Kokoro, voice ${settings.tts.kokoro.voice}`;
  line(tts.ok && (!qwen || qwen.ok) || !settings.voiceReplies ? true : "warn", "spoken replies", !settings.voiceReplies ? "off (VOICE_REPLIES=off)" : tts.ok ? `${where}${remote ? `; fallback: ${settings.tts.fallback}` : ""}${process.env.SIGNAL_ACCOUNT ? "" : " (needs the assistant's own Signal account)"}` : `not set up, missing: ${tts.missing.join(", ")} (${remote ? "install ffmpeg" : qwen ? "npm run setup:tts-qwen (optionally set TTS_REF_AUDIO and TTS_REF_TEXT for your own voice)" : "run scripts/setup-tts.sh"})`);

  const dream = readJson<{ lastRunAt?: string }>("state/dream.json", {});
  line(true, "nightly dream", settings.dream ? `once a day before the brief; last run ${dream.lastRunAt ? localTime(dream.lastRunAt) : "not yet"}` : "off (DREAM=off)");

  browseCheck(line, settings.browse, browseStatus());
  await openbaoCheck(line);
  await intakeCheck(line);
  tenantCheck(line);
  googleCheck(line);
  notionCheck(line);

  line(true, "proactive radar", settings.proactive ? `chosen by your chat's gate, about every ${settings.radarMinutes} min (its "[radar] ran" lines are in the log)` : "off (PROACTIVE=off)");

  const beat = readJson<{ lastTickAt?: string; lastNewMailAt?: string }>("state/heartbeat.json", {});
  const ageMin = beat.lastTickAt ? (Date.now() - Date.parse(beat.lastTickAt)) / 60_000 : Infinity;
  const quiet = inQuietHours(new Date(), settings.quietStartHour, settings.quietEndHour);
  line(
    ageMin <= 2 * settings.heartbeatMinutes + 1 || quiet ? true : "warn",
    "heartbeat is ticking",
    heartbeatDetail(beat, ageMin, quiet, settings.mail, localTime),
  );

  const spent = spentToday();
  line(spent < settings.dailyBudgetUsd, "daily spend guard", `$${spent.toFixed(2)} of $${settings.dailyBudgetUsd} today (notional)`);
  line(isPaused() ? "warn" : true, "not paused", isPaused() ? `${dataPath("state/paused")} exists` : "");
  const cardOff = killSwitch.off();
  const unconfirmed = new Ledger().rows().filter((r) => r.status === "unconfirmed").length;
  line(unconfirmed ? "warn" : true, "card payments", `${cardOff ? `OFF (${cardOff}); switch on: npm run card -- enable` : "not switched off (npm run card -- list shows the card, if one is saved)"}${unconfirmed ? `; ${unconfirmed} payment(s) unconfirmed: npm run card -- payments` : ""}`);
  const log = readText("logs/agent.log") ?? "";
  const hourAgo = new Date(Date.now() - 3600_000);
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const recentErrors = log.split("\n").filter((l) => l.includes(" ERR ") && l.slice(0, 5) >= hhmm(hourAgo)).length;
  line(recentErrors === 0 ? true : "warn", "no errors in the log in the last hour", recentErrors ? `${recentErrors} error line(s) in logs/agent.log` : "");

  console.log(bad === 0 ? "\nAll required checks passed." : `\n${bad} check(s) failed.`);
  process.exit(bad === 0 ? 0 : 1);
}
