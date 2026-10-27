import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { dataDirOf, PLUGIN_DIR, VOICES_DIR } from "./paths.ts";
import { layout, useDataRoot } from "./convpaths.ts";
import { presetFor } from "./preset.ts";
import { isSafeUrl, type TtsProviderConfig } from "@ted-assistant/speech/tts";

// Every tunable in one place, read from the environment (see .env.example) and validated
// when the agent starts. A typo fails loudly instead of silently becoming NaN: an interval
// of NaN would make the heartbeat fire every millisecond.

type Env = Record<string, string | undefined>;

function num(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be a number from ${min} to ${max} (got "${raw}")`);
  }
  return n;
}

// QUIET_HOURS="22:00-07:00" (or "22-7"): the whole hours the owner's quiet window runs from and to; it wins over QUIET_START_HOUR / QUIET_END_HOUR. Minutes other than :00 are refused.
function quietHours(env: Env, from: number, to: number): { from: number; to: number } {
  const raw = env.QUIET_HOURS?.trim();
  if (!raw) return { from, to };
  const m = /^(\d{1,2})(?::00)?\s*-\s*(\d{1,2})(?::00)?$/.exec(raw);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 23) throw new Error(`QUIET_HOURS must look like 22:00-07:00, whole hours (got "${raw}")`);
  return { from: Number(m[1]), to: Number(m[2]) };
}

// TASK_DEFAULT_REMIND="08:30": the clock time (the conversation's own zone) of the default ping on the morning of a due date, for an open task with a due and no reminder of its own. "off" = no default pings.
export function remindTime(raw: string | undefined): string | "off" {
  const t = raw?.trim();
  if (t === undefined || t === "") return "08:30";
  if (t.toLowerCase() === "off") return "off";
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(t);
  if (!m || Number(m[1]) > 23 || Number(m[2] ?? 0) > 59) throw new Error(`TASK_DEFAULT_REMIND must look like 08:30 (a clock time, or "off"; got "${t}")`);
  return `${m[1]!.padStart(2, "0")}:${m[2] ?? "00"}`;
}

function oneOf<T extends string>(env: Env, name: string, fallback: T, allowed: readonly T[]): T {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!(allowed as readonly string[]).includes(raw)) throw new Error(`${name} must be one of ${allowed.join(", ")} (got "${raw}")`);
  return raw as T;
}

// AUTO_APPROVE: `auto` (the approval judge decides which actions skip the owner's phone; the default) or `off` (everything that is not a plain read asks).
// Any other value stops the agent at start-up and says what to write.
export function autoApprove(env: Env): "off" | "auto" {
  const raw = env.AUTO_APPROVE?.trim();
  if (raw === undefined || raw === "" || raw === "auto") return "auto";
  if (raw === "off") return "off";
  throw new Error(`AUTO_APPROVE must be "auto" or "off" (got "${raw}"). Write AUTO_APPROVE=auto (or remove the line) for the approval judge, or AUTO_APPROVE=off to be asked about everything.`);
}

// ARCHIVE (and its old forms HEARTBEAT_ACTIONS, GMAIL_ARCHIVE_LIVE, GOOGLE_ARCHIVE_LIVE) is gone: archiving is always live. A line still in .env stops the agent at start-up,
// so a trial week someone relied on is not silently ended.
const GONE_ARCHIVE_SWITCHES = ["ARCHIVE", "HEARTBEAT_ACTIONS", "GMAIL_ARCHIVE_LIVE", "GOOGLE_ARCHIVE_LIVE"] as const;
function rejectArchiveSwitches(env: Env): void {
  for (const old of GONE_ARCHIVE_SWITCHES) {
    if (env[old]?.trim()) throw new Error(`${old} is gone: archiving is always live now (an archive is reversible: npm run restore). Remove ${old} from .env.`);
  }
}

// <MODULE>_TOOLS: the tools of one module's connector that stay visible to the model, one setting per module, named after it (NOTION_TOOLS for the module "notion"). Only the
// ones that are set are returned (by module name); the module's own default applies to the rest (hiddenTools). Each name is checked against the module's pattern at start-up
// (modules/index.ts checkHideSettings).
export function visibleTools(env: Env): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const name of Object.keys(env)) {
    const m = /^([A-Z][A-Z0-9]*)_TOOLS$/.exec(name);
    if (m && env[name]?.trim()) out[m[1]!.toLowerCase()] = list(env, name, [], /^[a-z][\w-]*$/, "a tool name like get_message");
  }
  return out;
}

// Which credential the SDK uses, chosen explicitly via HARNESS_AUTH:
//   login (default) - your stored `claude auth login`. The only mode that can see claude.ai connectors (Notion, Calendar, Gmail...).
//   token           - CLAUDE_CODE_OAUTH_TOKEN. Long-lived, but inference-only: no connectors.
//   api-key         - ANTHROPIC_API_KEY. Metered billing, also no connectors.
export function credentialMode(env: Env): "login" | "token" | "api-key" {
  const mode = oneOf(env, "HARNESS_AUTH", "login", ["login", "token", "api-key"] as const);
  if (mode === "token" && !env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error("Missing required env var CLAUDE_CODE_OAUTH_TOKEN (HARNESS_AUTH=token)");
  if (mode === "api-key" && !env.ANTHROPIC_API_KEY) throw new Error("Missing required env var ANTHROPIC_API_KEY (HARNESS_AUTH=api-key)");
  return mode;
}

// A setting that is a list of words separated by spaces (a command's arguments, OAuth scopes).
function words(env: Env, name: string, fallback: readonly string[]): string[] {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return [...fallback];
  return raw.trim().split(/\s+/);
}

function list(env: Env, name: string, fallback: readonly string[], valid: RegExp, hint: string): string[] {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return [...fallback];
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = items.find((s) => !valid.test(s));
  if (bad) throw new Error(`${name}: "${bad}" is not ${hint}`);
  return items;
}

// The speech engine (TTS_PROVIDER): the local Qwen voice (Kokoro stands in when it is not set up), or an optional remote one. Remote settings are checked at start-up:
// a missing key or a plain-http address to another machine stops the agent instead of leaking text or failing later.
function ttsProvider(env: Env, kokoro: { dir: string; voice: string; speed: number }, dataDir: string): TtsProviderConfig {
  const provider = oneOf(env, "TTS_PROVIDER", "qwen", ["kokoro", "elevenlabs", "http", "qwen"] as const);
  // The local cloned voice falls back to the local Kokoro by default (nothing leaves the Mac); a remote one never switches unless asked.
  const fallback = oneOf(env, "TTS_FALLBACK", provider === "qwen" ? "kokoro" : "none", ["none", "kokoro"] as const);
  const timeoutMs = num(env, "TTS_TIMEOUT_SECONDS", 60, 5, 300) * 1000;
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`${name} is required with TTS_PROVIDER=${provider}`);
    return v;
  };
  if (provider === "elevenlabs") {
    return { provider, fallback, kokoro, elevenlabs: { apiKey: need("ELEVENLABS_API_KEY"), voiceId: need("ELEVENLABS_VOICE_ID"), modelId: env.ELEVENLABS_MODEL_ID?.trim() || "eleven_multilingual_v2", timeoutMs } };
  }
  if (provider === "http") {
    const url = need("TTS_HTTP_URL");
    if (!isSafeUrl(url)) throw new Error("TTS_HTTP_URL must be an https:// address (http:// only for localhost)");
    return { provider, fallback, kokoro, http: { url, token: env.TTS_HTTP_TOKEN?.trim() || undefined, voice: env.TTS_HTTP_VOICE?.trim() || undefined, referenceId: env.TTS_HTTP_REFERENCE_ID?.trim() || undefined, timeoutMs } };
  }
  if (provider === "qwen") {
    // The reference recording and its text are yours and stay outside the repo (the data folders are ignored by version control). TTS_REF_TEXT is the words
    // themselves or the path of a text file; a missing file or text is reported by `npm run doctor`, and Ted then speaks with Kokoro.
    const path = (v: string | undefined) => (v?.trim() ? resolve(dataDir, v.trim().replace(/^~(?=\/)/, env.HOME ?? "")) : "");
    const textRaw = env.TTS_REF_TEXT?.trim() ?? "";
    const textFile = textRaw && !textRaw.includes("\n") ? path(textRaw) : "";
    const isFile = textFile !== "" && (() => { try { return statSync(textFile).isFile(); } catch { return false; } })();
    const idleMs = num(env, "WARM_IDLE_MINUTES", 60, 1, 1440) * 60_000;
    // With neither set, the synthetic sample that ships in the repo (assets/voices/, no real person behind it) is the reference.
    // It is resolved from the repo, not the data dir. Setting either one means your own recording: no mixing with the sample.
    const builtIn = !env.TTS_REF_AUDIO?.trim() && !textRaw;
    const sampleDir = VOICES_DIR;
    return {
      provider, fallback, kokoro,
      qwen: {
        dir: path(env.TTS_QWEN_DIR) || layout(dataDir).instance.ttsQwen,
        model: env.TTS_QWEN_MODEL?.trim() || "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit",
        refAudio: builtIn ? join(sampleDir, "default.wav") : path(env.TTS_REF_AUDIO),
        refText: builtIn ? (() => { try { return readFileSync(join(sampleDir, "default.txt"), "utf8").trim(); } catch { return ""; } })() : isFile ? readFileSync(textFile, "utf8").trim() : textRaw,
        builtIn,
        voiceRoot: layout(dataDir).conversations, // the folder of the conversations: each has its own voices/ library (voices.ts scopeRoot); the reference above is the default voice
        timeoutMs,
        idleMs,
      },
    };
  }
  return { provider, fallback, kokoro };
}

// The configured list, e.g. "en, de" -> ["en","de"]. Region suffixes are dropped ("en-US" -> "en"). Empty means en.
export const parseLanguages = (raw: string | undefined): string[] => {
  const l = (raw ?? "").split(",").map((s) => s.trim().toLowerCase().split(/[-_]/)[0]!).filter(Boolean);
  return l.length ? [...new Set(l)] : ["en"];
};

export function loadSettings(env: Env) {
  // The rhythm (when the heartbeat ticks, the quiet hours, the daily brief's words, the dream) has its defaults in the assistant preset (preset.ts); each env variable below still overrides its own.
  rejectArchiveSwitches(env);
  const rhythm = presetFor(env).rhythm;
  const quiet = quietHours(env, num(env, "QUIET_START_HOUR", rhythm.heartbeat.quietFromHour, 0, 23), num(env, "QUIET_END_HOUR", rhythm.heartbeat.quietToHour, 0, 23));
  const kokoro = {
    dir: env.TTS_DIR || `${env.HOME ?? ""}/.cache/ted-personal-assistant/kokoro`,
    voice: env.TTS_VOICE || "am_onyx",
    speed: num(env, "TTS_SPEED", 0.95, 0.5, 2),
  };
  // Where mail comes from. none: chat only, no mail client anywhere (heartbeat, brief, prompts and doctor all leave mail out).
  // gmail: the claude.ai Gmail connector, inherited from the Claude login like Notion (src/modules/gmail/gmail.ts, plugin/skills/gmail).
  const mailProvider = oneOf(env, "MAIL_PROVIDER", "mailbird", ["none", "mailbird", "gmail"] as const);
  // The owner's own address (Gmail only): the one place the brief may be emailed to. Checked by shape here, used by code in gmailrules.ts.
  const mailSelf = (env.MAIL_SELF_ADDRESS ?? "").trim().toLowerCase();
  if (mailSelf && !/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(mailSelf)) throw new Error("MAIL_SELF_ADDRESS must be a plain email address (no name, no angle brackets)");
  // The data root holds instance/ (process-wide), conversations/<id>/ (one folder per conversation) and logs/ (core/convpaths.ts). Overridable so tests never touch the real data.
  const dataDir = dataDirOf(env);
  return {
    // Who the agent works for and what it is called. Neutral defaults keep the repo impersonal.
    owner: env.OWNER_NAME || "the owner",
    assistant: env.ASSISTANT_NAME || "Assistant",

    // "sonnet" is an alias the SDK resolves to the current Sonnet, so new releases are
    // picked up automatically. Pin a full model id if you prefer stability.
    model: env.HARNESS_MODEL || "sonnet",
    // The model of `expert-opus`, the stronger expert any run may delegate to (run/delegation.ts); an alias like the above.
    opusModel: env.OPUS_MODEL?.trim() || "opus",
    credential: credentialMode(env),

    mailProvider,
    mailSelfAddress: mailSelf || undefined,
    // Gmail only: email the brief to MAIL_SELF_ADDRESS as well as the Signal summary. Off: the brief is the Signal message alone.
    briefEmail: oneOf(env, "BRIEF_EMAIL", "off", ["on", "off"] as const) === "on",
    // Scheduled skills (a `schedule:` in plugin/skills/<name>/SKILL.md, planned by tasks/routines.ts): ROUTINES_OFF=evening-wrap,weekly-review switches some off.
    routinesOff: list(env, "ROUTINES_OFF", [], /^[a-z][a-z0-9-]*$/, "skill names like evening-wrap"),
    routineCatchUpHours: num(env, "ROUTINE_CATCHUP_HOURS", 4, 1, 24), // a routine (scheduled skill or routine note) the Mac slept through still runs on waking within this many hours of its time, else that period is skipped
    mail: mailProvider !== "none", // is there any mail to look at? Every mail-only path asks this, never the provider's name

    heartbeatMinutes: num(env, "HEARTBEAT_MINUTES", rhythm.heartbeat.everyMinutes, 1, 240),
    // Quiet hours (code holds the heartbeat's unprompted posts in them, heartbeat/notices.ts): the preset's window, else 22:00-07:00; QUIET_HOURS or the two hours override it.
    quietStartHour: quiet.from,
    quietEndHour: quiet.to,
    maxUnpromptedPerDay: num(env, "MAX_UNPROMPTED_PER_DAY", 6, 1, 100), // unprompted heartbeat posts per conversation per day; past it they are held for the next day's one combined message (urgent ones are exempt)
    taskDefaultRemind: remindTime(env.TASK_DEFAULT_REMIND), // the morning ping for a task due that day with no reminder of its own (tasks/remind.ts)
    mailBacklogDays: num(env, "MAIL_BACKLOG_DAYS", 7, 0, 3650), // first run only: inbox mail older than this is marked seen without triage (seenmail.ts)
    // Timely meeting prep (heartbeat/preptick.ts): PREP_MINUTES before a meeting with other people (the look records upcoming meetings, modules/meetings), the look is made due and says ONE short prep message; 0 = off.
    prepMinutes: num(env, "PREP_MINUTES", 15, 0, 120),
    prepOnlyExternal: oneOf(env, "PREP_ONLY_EXTERNAL", "off", ["on", "off"] as const) === "on", // on: only meetings with someone outside your own e-mail domain

    // The owner's heartbeat run (src/heartbeat/look.ts): on every look a model (HEARTBEAT_MODEL: haiku, sonnet, or a full model id) reads the chat, mail, calendar and
    // tasks and acts or stays silent. It chooses its next look itself (10 to 120 minutes; `dayMinutes` is the default in the day). How quiet it is at night is its instruction's business, not code's.
    heartbeatModel: env.HEARTBEAT_MODEL?.trim() || "haiku",
    // The approval judge and the reply classifier (src/approvals/approvaljudge.ts: whether an action may skip the question, what a free-text reply to a question means, the question's wording)
    // run on JUDGE_MODEL: sonnet, opus, haiku or a full model id. It is the safety net and it writes to the owner, so it does not run on the smallest model by default.
    judgeModel: env.JUDGE_MODEL?.trim() || "sonnet",
    heartbeatDayMinutes: rhythm.heartbeat.dayMinutes,
    // The most messages or conversations one run (one look, one chat turn) may archive, for every mail provider (src/modules/archivecap.ts); the rest waits for the next look.
    // The most characters of ONE tool result the model reads (toolclean.ts, in the PostToolUse path of every tool, MCP results included); the rest is cut with a hint to narrow the query.
    toolOutputMaxChars: num(env, "TOOL_OUTPUT_MAX_CHARS", 60_000, 1000, 1_000_000),
    archiveMaxPerRun: num(env, "ARCHIVE_MAX_PER_RUN", 25, 1, 500),

    // How long a question asked in a chat turn waits before it lapses (silently: a journal line, approvals.ts). Unattended runs ask nobody; a stranger's registration waits a day.
    approvalTimeoutMinutes: num(env, "APPROVAL_TIMEOUT_MINUTES", 15, 1, 1440),

    // The longest one model run may take on the wall clock (src/run/ceiling.ts), so a hung turn cannot block its conversation until a
    // restart. The same for every run of a conversation, a look included.
    compactMaxMinutes: num(env, "COMPACT_MAX_MINUTES", 10, 1, 120), // a compaction that takes longer is abandoned (chatsession.ts); the failure backoff applies
    runMaxMinutesChat: num(env, "RUN_MAX_MINUTES_CHAT", 40, 1, 1440),

    // The browser sub-task (src/modules/browse/browse.ts): a separate run that opens pages, reads them and fills forms for the owner's chat, background
    // jobs and groups. Pages are untrusted; the run holds no mail, calendar or notes. A commit step (book, buy, send...) asks the owner,
    // payment and login fields are never filled. A group asks in the group, with the same limits. BROWSE=off turns it all off.
    browse: oneOf(env, "BROWSE", "on", ["on", "off"] as const) === "on",
    browseMaxTurns: num(env, "BROWSE_MAX_TURNS", 40, 3, 200),
    browseMaxUsd: num(env, "BROWSE_MAX_USD", 1.5, 0.05, 50),
    browseMaxMinutes: num(env, "BROWSE_MAX_MINUTES", 10, 1, 120),
    browseMaxCommits: num(env, "BROWSE_MAX_COMMITS", 8, 0, 20),
    browseMaxConcurrent: num(env, "BROWSE_MAX_CONCURRENT", 2, 1, 8), // browse runs at once (the owner and friends share them; one per conversation, the rest wait up to a minute)
    // Paying with the owner's dedicated debit card (src/modules/browse/card.ts, browseguard.ts): only the owner's chat run, only after a typed YES. These caps are
    // ours, in code and in the card's currency, independent of the card issuer's own limit. 0 turns card payments off.
    cardCapPurchase: num(env, "CARD_CAP_PURCHASE", 25, 0, 10_000), // the most one payment may be
    cardCapDay: num(env, "CARD_CAP_DAY", 50, 0, 100_000), // the most paid in one local day (clicked, confirmed and unconfirmed payments count)
    paymentsKeepYears: num(env, "PAYMENTS_KEEP_YEARS", 0, 0, 100), // 0 (default): the payment ledger is kept for ever. N >= 2: settled payments older than N years may be pruned by the retention job (payments.ts prunePayments); never fewer than 2
    browseMaxPayments: num(env, "BROWSE_MAX_PAYMENTS", 1, 0, 3), // card payments one browse run may start
    // OpenBao, the secret store (src/secrets/openbao.ts, docs/SETUP.md): the saved profile, the card and later tokens and keys. None of these is a secret;
    // the app's token is in the macOS Keychain, never in .env.
    openbao: {
      addr: env.OPENBAO_ADDR?.trim() || "https://127.0.0.1:8200", // loopback only (checked by the client)
      mount: env.OPENBAO_MOUNT?.trim() || "ted", // the KV v2 mount; items are at <mount>/tenants/<id>/...
      dir: env.OPENBAO_HOME?.trim() ? resolve(dataDir, env.OPENBAO_HOME.trim()) : layout(dataDir).instance.openbao, // binary, config, data, audit log and certificate (0700, not versioned); it stays under state/ (convpaths.ts: installed)
      caCert: resolve(dataDir, env.OPENBAO_CACERT?.trim() || join(env.OPENBAO_HOME?.trim() ? resolve(dataDir, env.OPENBAO_HOME.trim()) : layout(dataDir).instance.openbao, "tls/cert.pem")), // the pinned certificate
      role: env.OPENBAO_ROLE?.trim() || "ted-owner", // the policy and token role of the owner's tenant
      keychainPrefix: env.OPENBAO_KEYCHAIN_PREFIX?.trim() || "ted-openbao", // names of this Mac's Keychain items for the token and the unseal shares
      timeoutMs: num(env, "OPENBAO_TIMEOUT_SECONDS", 5, 1, 60) * 1000,
      cacheMs: num(env, "OPENBAO_CACHE_SECONDS", 30, 0, 300) * 1000, // how long profile reads may be served from memory (the card is never cached)
    },
    // The intake page (src/intake/intakeserver.ts, docs/SETUP.md "The intake page"): a separate process on loopback where a tenant types a saved detail or a card
    // instead of telling it to the chat. Off until INTAKE_BASE_URL (the public https address a tunnel gives it) is set; without it no setup link is offered.
    intake: {
      baseUrl: env.INTAKE_BASE_URL?.trim().replace(/\/+$/, "") || undefined,
      port: num(env, "INTAKE_PORT", 8787, 1024, 65_535), // the page listens on 127.0.0.1 and nowhere else
      allowHttpLoopback: oneOf(env, "INTAKE_ALLOW_HTTP_LOOPBACK", "off", ["on", "off"] as const) === "on", // tests only: lets INTAKE_BASE_URL be an http://127.0.0.1 address
      linkMinutes: num(env, "INTAKE_LINK_MINUTES", 15, 1, 60), // how long a setup link works (once)
      // The request header that carries the visitor's address behind a tunnel, for the page's rate limits: x-forwarded-for (its last entry) unless the tunnel sets another, like cf-connecting-ip for Cloudflare Tunnel.
      clientIpHeader: (env.INTAKE_CLIENT_IP_HEADER?.trim().toLowerCase() || "x-forwarded-for").replace(/[^a-z0-9-]/g, "") || "x-forwarded-for",
      dir: layout(dataDir).instance.intakeDir, // the open links (hashed) and what was stored (lengths only)
    },
    // Google for friends (src/modules/google/googlemcp.ts, src/intake/googleoauth.ts, docs/SETUP.md "Google for friends"): a friend (every friend has the `google` capability once the OAuth client is set) connects her own Google
    // account on the intake page (OAuth, offline) and her mail and calendar tools are served by a pinned third-party MCP server that THIS process starts for her, with
    // her refresh token from her own OpenBao path. Off until the OAuth client is set. The client secret is a secret like TENANT_ANTHROPIC_API_KEY: in .env, dropped from
    // process.env below, handed only to her server process. The server's command and arguments are plain settings (pinned by version or commit, never auto-updated).
    google: {
      clientId: env.GOOGLE_OAUTH_CLIENT_ID?.trim() || undefined,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || undefined,
      command: env.GOOGLE_MCP_COMMAND?.trim() || "uvx",
      // `--exclude-newer <the pin date>`: uv resolves the transitive dependencies to what existed on that day, so the pin of the top package is not undone by a newer
      // dependency release. It reduces the supply-chain risk and does not remove it (docs/SAFETY.md).
      args: words(env, "GOOGLE_MCP_ARGS", ["--exclude-newer", "2026-10-20T00:00:00Z", "workspace-mcp==2.1.0", "--single-user", "--tools", "gmail", "calendar", "contacts", "drive"]),
      authUrl: env.GOOGLE_OAUTH_AUTH_URL?.trim() || "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: env.GOOGLE_OAUTH_TOKEN_URL?.trim() || "https://oauth2.googleapis.com/token", // tests point this at a fake
      scopes: words(env, "GOOGLE_OAUTH_SCOPES", ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.compose", "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/contacts.readonly", "https://www.googleapis.com/auth/drive.readonly"]),
      // A friend's server process is closed after this long unused (started again on demand: OpenBao read, temp folder, Python start, token refresh). The default is
      // the heartbeat interval plus a margin (at least 20), so a look within the hour finds her server running; the price is one resident Python process per friend
      // with Google while the heartbeat ticks (it stops after the last tick, at night, and with the app).
      idleMinutes: num(env, "GOOGLE_MCP_IDLE_MINUTES", Math.max(20, num(env, "HEARTBEAT_MINUTES", rhythm.heartbeat.everyMinutes, 1, 240) + 5), 1, 240),
      callSeconds: num(env, "GOOGLE_MCP_CALL_SECONDS", 60, 5, 600), // one tool call
    },
    // Notion for friends (src/intake/notionoauth.ts, src/modules/notion/notionmcp.ts, docs/SETUP.md "Notion for friends"): a friend (every friend has the `notion` capability once INTAKE_BASE_URL is set) connects her own Notion on the
    // intake page (OAuth with PKCE against Notion's hosted MCP server) and her Notion tools are that hosted server, called by THIS process with her token through the
    // same credentialed proxy as Google. Nothing to set up but the tunnel: the instance registers itself once (RFC 7591) and remembers the client in instance/notion-client.json.
    notion: {
      mcpUrl: env.NOTION_MCP_URL?.trim() || "https://mcp.notion.com/mcp", // tests point this at a fake
      refreshMarginSeconds: num(env, "NOTION_REFRESH_MARGIN_SECONDS", 300, 0, 3600), // an access token this close to its end is renewed first
      idleMinutes: num(env, "NOTION_MCP_IDLE_MINUTES", 10, 1, 240), // a friend's connection to the hosted server is closed after this long unused
      callSeconds: num(env, "NOTION_MCP_CALL_SECONDS", 60, 5, 600), // one tool call
    },
    // Screenshot vision for the browse worker (src/modules/browse/browsevision.ts), an experiment, off by default. read: screenshots reach the model, clicks stay by ref.
    // click: also clicks by coordinates, which the guard resolves to the element under the point itself (a debugging port on loopback, browsecdp.ts).
    browseVision: oneOf(env, "BROWSE_VISION", "off", ["off", "read", "click"] as const),
    browseLocale: env.BROWSE_LOCALE?.trim() || "en-GB", // the browser's language (Accept-Language, navigator.language): an ordinary one, not the headless default en-US
    browseBrowserPath: env.BROWSE_BROWSER_PATH?.trim() || undefined, // advanced: a Chromium or Chrome executable instead of the one npm run setup:browse installs

    // The one switch for the approval judge (src/approvals/autojudge.ts): auto (default) lets it skip the question for what follows from your request
    // or your standing tasks, inside the floor that code sets; off asks you about everything that is not a plain read.
    autoApprove: autoApprove(env),


    // What the model can see (policy.ts, hiddenTools): every tool it sees is re-sent on every model call, so hide what your skills never use. A skill that needs a
    // hidden tool will fail, so list it here. HIDDEN_CONNECTORS: tool-name prefixes of whole connectors (Google Drive and Google Docs are shown by default: find a file, read it; list them here to hide them again. The Gmail one is shown while MAIL_PROVIDER=gmail, and the mail
    // connector that is not in use is hidden whatever this says). <MODULE>_TOOLS (NOTION_TOOLS, MAILBIRD_TOOLS, GMAIL_TOOLS, DRIVE_TOOLS, DOCS_TOOLS: the module's name in capitals): the tools
    // of that module's connector to keep, replacing the default list the module declares (src/modules/*.ts `hide`); checked against the module by checkHideSettings.
    hiddenConnectors: list(
      env,
      "HIDDEN_CONNECTORS",
      ["mcp__claude_ai_Interactive_Brokers_IBKR", "mcp__claude_ai_Gmail", "mcp__claude_ai_Claude_Docs"],
      /^mcp__[\w-]+$/,
      "a tool-name prefix like mcp__claude_ai_Gmail",
    ),
    visibleTools: visibleTools(env),

    // The log of messages the assistant sent (messages.ts) is bounded by size; older messages become one summary.
    messageLogMb: num(env, "MESSAGE_LOG_MB", 1, 0.01, 100),
    groupLogMb: num(env, "GROUP_LOG_MB", 0.5, 0.01, 100), // per group, the same size-bounding
    summaryWords: num(env, "SUMMARY_WORDS", 60, 10, 400),
    journalKeepDays: num(env, "JOURNAL_KEEP_DAYS", 90, 1, 3650), // journal lines (what the assistant DID, core/events.ts) survive log compaction verbatim this long; older ones go without a summary (messages.ts)

    // What background runs may read of the owner's notes (chat reads them as files, on demand), and the
    // nightly "dream" that keeps them up to date (dream.ts).
    memoryMaxNotes: num(env, "MEMORY_MAX_NOTES", 2000, 10, 20000), // how many notes a run reads (each is cut at MAX_NOTE_CHARS); far above normal use, so it only guards against runaway growth
    dream: oneOf(env, "DREAM", rhythm.dream.enabled ? "on" : "off", ["on", "off"] as const) === "on",
    dreamHour: num(env, "DREAM_HOUR", rhythm.dream.hour, 0, 23), // the dream runs on the first tick at or after this local hour, once a day (dream.ts dreamTrigger)
    feedbackOffersPerDay: num(env, "FEEDBACK_OFFERS_PER_DAY", 3, 0, 20), // learning from feedback (conversation/feedback.ts): at most this many notes a day saved from a 👎 or "less of this" per conversation (0: off)

    // The retention job (core/retention.ts): once a day from 03:30 it removes what has outlived its window. RETENTION=off disables all of it; each window is a setting (0 where noted: that rule off).
    retention: oneOf(env, "RETENTION", "on", ["on", "off"] as const) === "on",
    auditRetentionDays: num(env, "AUDIT_RETENTION_DAYS", 90, 1, 3650), // rotated audit generations lose lines older than this; the current file is never touched
    signalAttachmentDays: num(env, "SIGNAL_ATTACHMENT_DAYS", process.platform === "darwin" ? 30 : 0, 0, 3650), // signal-cli's saved attachments older than this (0: off, the default off the owner's Mac)
    expiredNoteDeleteDays: num(env, "EXPIRED_NOTE_DELETE_DAYS", 30, 1, 3650), // an expired note is set aside in notes-backup/expired/; deleted for good this many days after its expiry
    notesBackupKeep: num(env, "NOTES_BACKUP_KEEP", 7, 1, 100), // dream snapshots kept per conversation
    openbaoLogMb: num(env, "OPENBAO_LOG_MB", 20, 1, 1000), // OpenBao's audit, server and keeper logs are rotated at this size (2 generations kept)
    openbaoBackupKeep: num(env, "OPENBAO_BACKUP_KEEP", 7, 1, 100), // raft snapshots kept
    looksKeepDays: num(env, "LOOKS_KEEP_DAYS", 400, 7, 3650), // heartbeat look rows (instance.db) older than this are pruned by the retention job
    spendKeepDays: num(env, "SPEND_KEEP_DAYS", 400, 2, 3650), // spend ledger rows of days older than this are pruned (the budgets look at today only)
    shoreCacheKeep: num(env, "SHORE_CACHE_KEEP", 50, 1, 10000), // cached shore outlines kept (newest by mtime)
    tmpSweepHours: num(env, "TMP_SWEEP_HOURS", 24, 1, 720), // temporary folders of picture, voice and Google work older than this are swept

    // Wake-ups (src/conversation/gate.ts, src/heartbeat/wake.ts): on every heartbeat tick a small model looks at each conversation whose
    // "next look" has come and decides whether to do something unprompted ("every morning post a fun fact").
    wakeups: oneOf(env, "WAKEUPS", "on", ["on", "off"] as const) === "on",

    dailyBudgetUsd: num(env, "DAILY_BUDGET_USD", 20, 0, 10_000),
    // One group's day on the owner's login (src/core/budget.ts): a noisy group stops itself before it spends the owner's whole day (and with it her brief). Default a quarter of DAILY_BUDGET_USD.
    groupDailyBudgetUsd: num(env, "GROUP_DAILY_BUDGET_USD", num(env, "DAILY_BUDGET_USD", 20, 0, 10_000) * 0.25, 0, 10_000),

    // Several people on one instance (src/tenants/tenants.ts, docs/ARCHITECTURE.md "Tenancy"). Off: nothing changes, an unknown sender is ignored as always.
    // On: an unknown sender gets one fixed line (no model call) and the owner is asked in her chat whether to let her in, and each friend is a tenant with
    // her own folder, her own limits, and runs on the instance key below. The bot never writes first to anybody.
    tenants: oneOf(env, "TENANTS", "off", ["on", "off"] as const) === "on",
    weather: oneOf(env, "WEATHER", "on", ["on", "off"] as const) === "on", // forecast and spot tools with the surf-conditions skill (weathertools.ts)
    draw: oneOf(env, "DRAW", "on", ["on", "off"] as const) === "on", // the draw tool and skill: an SVG the model writes, rendered to a PNG (drawtool.ts)
    // The key tenants' runs use: a separate Anthropic Console workspace key with a spend limit, never the owner's login or key. It is handed to a tenant's
    // run only, as ANTHROPIC_API_KEY in that run's environment (tenanttools.ts tenantEnv), and dropped from process.env below. Unset: tenants get a plain "not set up".
    tenantApiKey: env.TENANT_ANTHROPIC_API_KEY?.trim() || undefined,
    tenantDailyBudgetUsd: num(env, "TENANT_DAILY_BUDGET_USD", 2, 0, 10_000), // each tenant's own daily ceiling on the instance key (tenant.json may lower or raise it)
    instanceKeyDailyUsd: num(env, "INSTANCE_KEY_DAILY_USD", 10, 0, 100_000), // ALL tenants together on the instance key per day (each also has her own ceiling above; tenant.json may raise those, this one it cannot)
    tenantNoticeMinutes: num(env, "TENANT_NOTICE_MINUTES", 30, 0, 1440), // a fixed setup, limit or cooldown notice to one person at most this often
    tenantReplyNoticeMinutes: num(env, "TENANT_REPLY_NOTICE_MINUTES", 5, 0, 1440), // a failure notice in HER chat (she is waiting for an answer): told promptly, but not once per message of a flood
    tenantKeyNoticeMinutes: num(env, "TENANT_KEY_NOTICE_MINUTES", 180, 0, 10_080), // the owner hears of a refused or missing instance key at most this often (keynotice.ts)
    tenantWarmMax: num(env, "TENANT_WARM_MAX", 2, 0, 10), // warm model processes kept for tenants (the most recently active ones); 0: none

    // Which chat platform the assistant talks on: the package @ted-assistant/<name> (packages/messenger loads it by name). Only signal exists so far.
    messenger: env.MESSENGER?.trim() || "signal",
    // Signal's own settings, handed to its package as options (src/conversation/messenger.ts). The owner's number is required by whoever starts the chat (signalIdentity below), not by every
    // command that reads the settings.
    signalOwnerNumber: env.SIGNAL_OWNER_NUMBER?.trim() || undefined,
    signalOwnAccount: env.SIGNAL_ACCOUNT?.trim() || undefined, // the assistant's OWN account (a number, or an account key from Signal Login); unset: a linked device of the owner's, talking in Note to Self
    signalOwnerAci: env.SIGNAL_OWNER_ACI?.trim() || undefined, // only if Signal hides the owner's number from the assistant
    signalHost: "127.0.0.1", // never anything else: signal-cli's socket is unauthenticated
    signalPort: num(env, "SIGNAL_PORT", 7583, 1024, 65_535),

    // Voice notes are transcribed on this Mac with whisper.cpp (src/transcribe.ts); nothing leaves it.
    whisperModel: env.WHISPER_MODEL || `${env.HOME ?? ""}/.cache/ted-personal-assistant/ggml-small.bin`,
    maxConcurrentRuns: num(env, "MAX_CONCURRENT_RUNS", 3, 1, 16), // model processes running at once, all kinds together (rungate.ts); chat turns and small helper calls never wait for a place, looks and dreams do
    groupWarmSlots: num(env, "GROUP_WARM_SLOTS", 2, 0, 10), // warm model processes kept for the most recently active groups (agentwarm.ts); 0: none
    transcribeConcurrency: num(env, "TRANSCRIBE_CONCURRENCY", 2, 1, 8), // voice notes transcribed at the same time; the rest wait their turn (main.ts, limiter.ts)
    // Spoken replies to voice messages (src/conversation/voicereply.ts): local text to speech with Kokoro (scripts/setup-tts.sh).
    voiceReplies: oneOf(env, "VOICE_REPLIES", "on", ["on", "off"] as const) === "on",
    voiceTimeoutSeconds: num(env, "VOICE_TIMEOUT_SECONDS", 75, 20, 600), // ONE deadline for a whole voice reply, from the start of the synthesis to the hand-over to the messenger; over it the reply goes out as text (src/conversation/delivery.ts)
    ttsLanguages: parseLanguages(env.TTS_LANGUAGES), // languages the voice speaks (default en); a reply in another one goes out as text (src/conversation/lang.ts)
    // Optional remote speech (docs/REMOTE-TTS.md): sends the spoken words to a third party or to your own server.
    tts: ttsProvider(env, kokoro, dataDir),
    // Group chats (own-account mode, src/conversation/group.ts): it takes part in any group the owner is in, speaking only
    // when it fits (see PARTICIPATION in persona.ts).
    groupParticipation: oneOf(env, "GROUP_PARTICIPATION", "auto", ["auto", "tagged"] as const), // auto: the assistant judges every message; tagged: only when @mentioned or replied to
    // Every conversation, the owner's chat and each group: wait this long after a message for a burst to end, then answer all of
    // it as one turn.
    settleSeconds: num(env, "SETTLE_SECONDS", 2, 0, 60),
    settleMaxSeconds: num(env, "SETTLE_MAX_SECONDS", 10, 1, 120), // the longest a burst waits since its first message, so continuous chatter cannot postpone the answer forever
    // Warm model processes (src/run/agent.ts, src/conversation/gate.ts): a process started ahead of the next message skips the ~3 s start-up. At most
    // three exist: the owner's chat, the group that spoke last, and one small Haiku process for the participation gate. Each costs
    // about 150 to 200 MB resident and no tokens, and is dropped after WARM_IDLE_MINUTES without use. WARM=off: every turn starts cold.
    warm: oneOf(env, "WARM", "on", ["on", "off"] as const) === "on",
    judgeIdleMinutes: num(env, "JUDGE_WARM_IDLE_MINUTES", 10, 1, 1440), // the approval judge's spare (a small model process, JUDGE_MODEL) is dropped this long after its last use: approvals come in bursts
    warmIdleMinutes: num(env, "WARM_IDLE_MINUTES", 60, 1, 1440),
    // The participation gate may ask for a pause before answering an untagged message, to seem natural. "typing…" shows meanwhile,
    // so a long pause only makes the answer late: whatever the gate asks for is cut to this many seconds (0: never wait).
    gateMaxDelaySeconds: num(env, "GATE_MAX_DELAY_SECONDS", 4, 0, 120),
    // Timing constants that used to be hard-coded in the files that use them (defaults unchanged). Raise or lower them in .env.
    groupStickyMinutes: num(env, "GROUP_STICKY_MINUTES", 30, 1, 1440), // a direct address that could not be answered (paused, over budget) is dropped after this long (group.ts)
    groupNoticeMinutes: num(env, "GROUP_NOTICE_MINUTES", 10, 0, 1440), // a failure is reported in a group at most this often (conversation.ts; 0: always)
    groupMemberCacheMinutes: num(env, "GROUP_MEMBER_CACHE_MINUTES", 5, 0, 1440), // how long "the owner is in this group" is remembered (group.ts)
    slowReplySeconds: num(env, "SLOW_REPLY_SECONDS", 20, 0, 600), // an answer later than this is threaded under the message (quote.ts)
    echoWindowMinutes: num(env, "ECHO_WINDOW_MINUTES", 5, 1, 60), // our own sent text coming back within this long is an echo, not the owner (outbound.ts)
    replayMinutes: num(env, "REPLAY_MINUTES", 30, 0, 1440), // at start, an owner or friend message younger than this that was never answered (the restart lost it) is answered now (replay.ts; 0: off)
    warmRefreshMinutes: num(env, "WARM_REFRESH_MINUTES", 25, 1, 1440), // the owner's warm process is renewed this often, so it is still fresh after a quiet hour (main.ts)
    noticeAgeHours: num(env, "NOTICE_AGE_HOURS", 24, 1, 168), // what the assistant sent on its own stays "recent" for the chat this long (messages.ts)
    compactBackoffMinutes: num(env, "COMPACT_BACKOFF_MINUTES", 60, 1, 1440), // after a failed compaction, no new try for this long (session.ts)
    compactQuietMinutes: num(env, "COMPACT_QUIET_MINUTES", 5, 1, 240), // a grown conversation is compacted in the background once its last turn is this old (session.ts, wake.ts)
    signalAttachmentsDir: `${env.HOME ?? ""}/.local/share/signal-cli/attachments`,

    launchdLabel: env.LAUNCHD_LABEL || `com.${env.USER ?? "user"}.ted-personal-assistant`,

    // Chat session hygiene: the SDK only compacts near the context limit, so a long-lived
    // session would re-send an ever-growing history on every turn.
    chatCompactGrowthTokens: num(env, "CHAT_COMPACT_GROWTH_TOKENS", 100_000, 5_000, 400_000), // the conversation itself (context minus tools, skills and prompts) this big: compact afterwards, owner and groups alike
    chatCompactTokens: num(env, "CHAT_COMPACT_TOKENS", 150_000, 10_000, 500_000), // fallback for a session saved before the baseline was recorded: a turn this big: compact afterwards (tools and skills alone are ~50k)

    // The bundled skills (plugin/skills) are loaded straight from the repo: nothing to install.
    pluginDir: PLUGIN_DIR,

    dataDir,
    logsDir: layout(dataDir).logs.dir, // audit.jsonl, agent.log, signal-daemon.log and launchd's stderr files; where everything else lives is core/convpaths.ts
  } as const;
}

export const settings = loadSettings(process.env);
useDataRoot(settings.dataDir); // (core/convpaths.ts builds every path under the same root)
// The speech keys and the tenants' instance key were read into `settings` above. Nothing the agent starts (Claude Code and its MCP servers, ffmpeg, signal-cli)
// needs them, and they are inherited by every child process unless dropped here (the owner's runs never see the tenants' key).
for (const name of ["ELEVENLABS_API_KEY", "TTS_HTTP_TOKEN", "TENANT_ANTHROPIC_API_KEY", "GOOGLE_OAUTH_CLIENT_SECRET"]) delete process.env[name];
// Is the instance's Google OAuth client set up? The one answer: without it nobody gets Google tools or a sign-in page for it.
export const googleReady = (cfg: { clientId?: string; clientSecret?: string } = settings.google): boolean => !!cfg.clientId && !!cfg.clientSecret;
// The agent calls this once when it starts: the SDK picks whatever credential is in the environment, so the ones HARNESS_AUTH did not choose are removed from this process
// (a command that only reads the settings keeps its environment as it is).
export function applyCredentialMode(): void {
  if (settings.credential !== "token") delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (settings.credential !== "api-key") delete process.env.ANTHROPIC_API_KEY;
}

// Who the chat is with and on which account (Signal): the owner's number is required to start it.
export function signalIdentity(s: Pick<typeof settings, "signalOwnerNumber" | "signalOwnAccount" | "signalOwnerAci"> = settings): { ownerNumber: string; account: string; ownerAci: string | undefined } {
  if (!s.signalOwnerNumber) throw new Error("Missing required env var SIGNAL_OWNER_NUMBER");
  return { ownerNumber: s.signalOwnerNumber, account: s.signalOwnAccount || s.signalOwnerNumber, ownerAci: s.signalOwnerAci };
}
// Numbers never go to logs in full.
export function mask(number: string | undefined): string {
  return number ? `+***${number.slice(-2)}` : "(none)";
}
export const OWNER = settings.owner;
export const ASSISTANT = settings.assistant;
