import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isSafeUrl, type TtsProviderConfig } from "@ted-personal-assistant/signal/tts";

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

function oneOf<T extends string>(env: Env, name: string, fallback: T, allowed: readonly T[]): T {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!(allowed as readonly string[]).includes(raw)) throw new Error(`${name} must be one of ${allowed.join(", ")} (got "${raw}")`);
  return raw as T;
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
    // The reference recording and its text are yours and stay outside the repo (state/ is ignored). TTS_REF_TEXT is the words
    // themselves or the path of a text file; a missing file or text is reported by `npm run doctor`, and Ted then speaks with Kokoro.
    const path = (v: string | undefined) => (v?.trim() ? resolve(dataDir, v.trim().replace(/^~(?=\/)/, env.HOME ?? "")) : "");
    const textRaw = env.TTS_REF_TEXT?.trim() ?? "";
    const textFile = textRaw && !textRaw.includes("\n") ? path(textRaw) : "";
    const isFile = textFile !== "" && (() => { try { return statSync(textFile).isFile(); } catch { return false; } })();
    const idleMs = num(env, "WARM_IDLE_MINUTES", 60, 1, 1440) * 60_000;
    // With neither set, the synthetic sample that ships in the repo (assets/voices/, no real person behind it) is the reference.
    // It is resolved from the repo, not the data dir. Setting either one means your own recording: no mixing with the sample.
    const builtIn = !env.TTS_REF_AUDIO?.trim() && !textRaw;
    const sampleDir = fileURLToPath(new URL("../assets/voices/", import.meta.url));
    return {
      provider, fallback, kokoro,
      qwen: {
        dir: path(env.TTS_QWEN_DIR) || join(dataDir, "state/tts-qwen"),
        model: env.TTS_QWEN_MODEL?.trim() || "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit",
        refAudio: builtIn ? join(sampleDir, "default.wav") : path(env.TTS_REF_AUDIO),
        refText: builtIn ? (() => { try { return readFileSync(join(sampleDir, "default.txt"), "utf8").trim(); } catch { return ""; } })() : isFile ? readFileSync(textFile, "utf8").trim() : textRaw,
        builtIn,
        voiceRoot: join(dataDir, "state/voice"), // the voice library (a cloned voice per conversation, voices.ts); the reference above is its default voice
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
  const kokoro = {
    dir: env.TTS_DIR || `${env.HOME ?? ""}/.cache/ted-personal-assistant/kokoro`,
    voice: env.TTS_VOICE || "am_onyx",
    speed: num(env, "TTS_SPEED", 0.95, 0.5, 2),
  };
  // Where mail comes from. none: chat only, no mail client anywhere (heartbeat, brief, prompts and doctor all leave mail out).
  // gmail: the claude.ai Gmail connector, inherited from the Claude login like Notion (src/gmail.ts, plugin/skills/gmail).
  const mailProvider = oneOf(env, "MAIL_PROVIDER", "mailbird", ["none", "mailbird", "gmail"] as const);
  // The owner's own address (Gmail only): the one place the brief may be emailed to. Checked by shape here, used by code in gmailrules.ts.
  const mailSelf = (env.MAIL_SELF_ADDRESS ?? "").trim().toLowerCase();
  if (mailSelf && !/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(mailSelf)) throw new Error("MAIL_SELF_ADDRESS must be a plain email address (no name, no angle brackets)");
  // The data root holds three folders: state/ (bookkeeping), logs/ and memory/ (what the
  // model reads). Overridable so tests never touch the real data.
  const dataDir = env.HARNESS_DATA_DIR ? resolve(env.HARNESS_DATA_DIR) : resolve(fileURLToPath(new URL("../", import.meta.url)));
  return {
    // Who the agent works for and what it is called. Neutral defaults keep the repo impersonal.
    owner: env.OWNER_NAME || "the owner",
    assistant: env.ASSISTANT_NAME || "Assistant",

    // "sonnet" is an alias the SDK resolves to the current Sonnet, so new releases are
    // picked up automatically. Pin a full model id if you prefer stability.
    model: env.HARNESS_MODEL || "sonnet",

    mailProvider,
    mailSelfAddress: mailSelf || undefined,
    // Gmail only. The first week the heartbeat only LOGS what it would archive (GMAIL_ARCHIVE_LIVE=true turns archiving on): the same switch
    // governs a model run's archive calls (policy.ts). Mailbird is not affected.
    gmailArchiveLive: oneOf(env, "GMAIL_ARCHIVE_LIVE", "false", ["true", "false"] as const) === "true",
    // Gmail only: email the brief to MAIL_SELF_ADDRESS as well as the Signal summary. Off: the brief is the Signal message alone.
    briefEmail: oneOf(env, "BRIEF_EMAIL", "off", ["on", "off"] as const) === "on",
    mail: mailProvider !== "none", // is there any mail to look at? Every mail-only path asks this, never the provider's name

    heartbeatMinutes: num(env, "HEARTBEAT_MINUTES", 15, 1, 240),
    heartbeatLive: oneOf(env, "HEARTBEAT_ACTIONS", "live", ["live", "log"] as const) === "live",
    maxArchivesPerTick: num(env, "HEARTBEAT_MAX_ARCHIVES", 25, 0, 500),
    quietStartHour: num(env, "QUIET_START_HOUR", 22, 0, 23),
    quietEndHour: num(env, "QUIET_END_HOUR", 7, 0, 23),

    // The radar: while the owner is awake, a model looks at calendar and mail every few hours and
    // writes to them only when something deserves it (src/radar.ts).
    proactive: oneOf(env, "PROACTIVE", "on", ["on", "off"] as const) === "on",
    radarMinutes: num(env, "RADAR_MINUTES", 180, 30, 720),
    maxProactivePerDay: num(env, "MAX_PROACTIVE_PER_DAY", 8, 0, 50),

    // How long an approval waits before it counts as declined: one asked in a chat turn, and one asked by an unattended run.
    approvalTimeoutMinutes: num(env, "APPROVAL_TIMEOUT_MINUTES", 15, 1, 1440),
    backgroundApprovalTimeoutMinutes: num(env, "BACKGROUND_APPROVAL_TIMEOUT_MINUTES", 120, 1, 2880),

    // The longest one model run may take on the wall clock (src/ceiling.ts), so a hung turn cannot block its conversation until a
    // restart. Chat: the owner's chat and every group. Background: gate tasks, brief, radar, mail handler; the time a background run
    // spends waiting for an approval is not counted, so BACKGROUND_APPROVAL_TIMEOUT_MINUTES never cuts into it.
    compactMaxMinutes: num(env, "COMPACT_MAX_MINUTES", 10, 1, 120), // a compaction that takes longer is abandoned (chatsession.ts); the failure backoff applies
    runMaxMinutesChat: num(env, "RUN_MAX_MINUTES_CHAT", 40, 1, 1440),
    runMaxMinutesBackground: num(env, "RUN_MAX_MINUTES_BACKGROUND", 180, 1, 2880),

    // The browser sub-task (src/browse.ts): a separate run that opens pages, reads them and fills forms for the owner's chat, background
    // jobs and groups. Pages are untrusted; the run holds no mail, calendar or notes. A commit step (book, buy, send...) asks the owner,
    // payment and login fields are never filled. A group asks in the group, with the same limits. BROWSE=off turns it all off.
    browse: oneOf(env, "BROWSE", "on", ["on", "off"] as const) === "on",
    browseMaxTurns: num(env, "BROWSE_MAX_TURNS", 40, 3, 200),
    browseMaxUsd: num(env, "BROWSE_MAX_USD", 1.5, 0.05, 50),
    browseMaxMinutes: num(env, "BROWSE_MAX_MINUTES", 10, 1, 120),
    browseMaxCommits: num(env, "BROWSE_MAX_COMMITS", 8, 0, 20),
    // Paying with the owner's dedicated debit card (src/card.ts, browseguard.ts): only the owner's chat run, only after a typed YES. These caps are
    // ours, in code and in the card's currency, independent of the card issuer's own limit. 0 turns card payments off.
    cardCapPurchase: num(env, "CARD_CAP_PURCHASE", 25, 0, 10_000), // the most one payment may be
    cardCapDay: num(env, "CARD_CAP_DAY", 50, 0, 100_000), // the most paid in one local day (clicked, confirmed and unconfirmed payments count)
    browseMaxPayments: num(env, "BROWSE_MAX_PAYMENTS", 1, 0, 3), // card payments one browse run may start
    // OpenBao, the secret store (src/openbao.ts, docs/SETUP.md): the saved profile, the card and later tokens and keys. None of these is a secret;
    // the app's token is in the macOS Keychain, never in .env.
    openbao: {
      addr: env.OPENBAO_ADDR?.trim() || "https://127.0.0.1:8200", // loopback only (checked by the client)
      mount: env.OPENBAO_MOUNT?.trim() || "ted", // the KV v2 mount; items are at <mount>/tenants/<id>/...
      dir: resolve(dataDir, env.OPENBAO_HOME?.trim() || "state/openbao"), // binary, config, data, audit log and certificate (0700, ignored by git)
      caCert: resolve(dataDir, env.OPENBAO_CACERT?.trim() || join(env.OPENBAO_HOME?.trim() || "state/openbao", "tls/cert.pem")), // the pinned certificate
      role: env.OPENBAO_ROLE?.trim() || "ted-owner", // the policy and token role of the owner's tenant
      keychainPrefix: env.OPENBAO_KEYCHAIN_PREFIX?.trim() || "ted-openbao", // names of this Mac's Keychain items for the token and the unseal shares
      timeoutMs: num(env, "OPENBAO_TIMEOUT_SECONDS", 5, 1, 60) * 1000,
      cacheMs: num(env, "OPENBAO_CACHE_SECONDS", 30, 0, 300) * 1000, // how long profile reads may be served from memory (the card is never cached)
    },
    // Screenshot vision for the browse worker (src/browsevision.ts), an experiment, off by default. read: screenshots reach the model, clicks stay by ref.
    // click: also clicks by coordinates, which the guard resolves to the element under the point itself (a debugging port on loopback, browsecdp.ts).
    browseVision: oneOf(env, "BROWSE_VISION", "off", ["off", "read", "click"] as const),
    browseLocale: env.BROWSE_LOCALE?.trim() || "en-GB", // the browser's language (Accept-Language, navigator.language): an ordinary one, not the headless default en-US
    browseBrowserPath: env.BROWSE_BROWSER_PATH?.trim() || undefined, // advanced: a Chromium or Chrome executable instead of the one npm run setup:browse installs

    // A small model's second opinion on approvals (src/autojudge.ts). It may skip the question for
    // whatever the manifest marks `auto` (toolmanifest.ts): calendar events that only touch you, plain web pages, and in chat a
    // send you asked for (broad: any source the flag allows, chat: only in chat); shadow: it judges
    // and logs, you still decide; off: never.
    autoApprove: oneOf(env, "AUTO_APPROVE", "broad", ["off", "shadow", "chat", "broad"] as const),

    briefStartHour: num(env, "BRIEF_START_HOUR", 7, 0, 23), // only what the gate's default rules say ("from this hour")
    briefMaxAttempts: num(env, "BRIEF_MAX_ATTEMPTS", 3, 1, 10),
    // The owner's gate (src/gate.ts, wake.ts) decides WHEN the brief and the radar run, by its default rules and the notes; code
    // keeps the HOW and a deterministic backstop for the brief.
    briefBackstopHour: num(env, "BRIEF_BACKSTOP_HOUR", 9, 0, 24), // no brief logged today by this hour (local): run it anyway. 24: never

    // What the model can see (policy.ts, hiddenTools): every tool it sees is re-sent on every
    // model call, so hide what your skills never use. A skill that needs a hidden tool will
    // fail, so list it here. Connectors: tool-name prefixes. Notion and Mailbird: the tools to keep.
    // Without mail the Mailbird server is hidden whole (none of its tools is sent to the model), whatever HIDDEN_CONNECTORS says.
    hiddenConnectors: [
      ...list(
        env,
        "HIDDEN_CONNECTORS",
        ["mcp__claude_ai_Interactive_Brokers_IBKR", ...(mailProvider === "gmail" ? [] : ["mcp__claude_ai_Gmail"]), "mcp__claude_ai_Google_Drive", "mcp__claude_ai_Google_Docs", "mcp__claude_ai_Claude_Docs"],
        /^mcp__[\w-]+$/,
        "a tool-name prefix like mcp__claude_ai_Gmail",
      ),
      ...(mailProvider !== "mailbird" ? ["mcp__mailbird"] : []),
    ],
    // The Gmail connector tools kept visible (the rest of the connector is hidden, policy.ts hiddenTools). Only used with MAIL_PROVIDER=gmail.
    gmailTools: list(
      env,
      "GMAIL_TOOLS",
      ["search_threads", "get_thread", "get_message", "get_draft", "list_drafts", "list_labels", "create_draft", "update_draft", "reply", "forward", "send_message", "unlabel_thread", "label_thread"],
      /^[a-z_]+$/,
      "a Gmail tool name like get_thread",
    ),
    mailbirdTools: list(
      env,
      "MAILBIRD_TOOLS",
      [
        "summarize_all_inboxes", "list_accounts", "list_folders", "list_conversations", "search_conversations", "get_message", "get_conversation",
        "list_attachments", "get_attachment_content", "archive_conversation", "select_conversation", "reply_to_conversation",
        "reply_all_to_conversation", "create_draft", "update_draft", "forward_conversation", "send_message_now", "get_send_status", "send_self_briefing",
      ],
      /^[a-z_]+$/,
      "a Mailbird tool name like get_message",
    ),
    notionTools: list(env, "NOTION_TOOLS", ["notion-search", "notion-fetch", "notion-create-pages", "notion-update-page"], /^notion-[\w-]+$/, "a Notion tool name like notion-fetch"),

    // The log of messages the assistant sent (messages.ts) is bounded by size; older messages become one summary.
    messageLogMb: num(env, "MESSAGE_LOG_MB", 1, 0.01, 100),
    groupLogMb: num(env, "GROUP_LOG_MB", 0.5, 0.01, 100), // per group, the same size-bounding
    summaryWords: num(env, "SUMMARY_WORDS", 60, 10, 400),

    // What background runs may read of the owner's notes (chat reads them as files, on demand), and the
    // nightly "dream" that keeps them up to date (dream.ts).
    memoryMaxNotes: num(env, "MEMORY_MAX_NOTES", 150, 10, 1000), // the one memory limit: how many notes a run reads (each is cut at MAX_NOTE_CHARS)
    dream: oneOf(env, "DREAM", "on", ["on", "off"] as const) === "on",

    // Wake-ups (src/gate.ts, src/wake.ts): on every heartbeat tick a small model looks at each conversation whose
    // "next look" has come and decides whether to do something unprompted ("every morning post a fun fact").
    wakeups: oneOf(env, "WAKEUPS", "on", ["on", "off"] as const) === "on",

    dailyBudgetUsd: num(env, "DAILY_BUDGET_USD", 20, 0, 10_000),

    // Several people on one instance (src/tenants.ts, docs/ARCHITECTURE.md "Tenancy"). Off: nothing changes, an unknown sender is ignored as always.
    // On: an unknown sender gets a fixed invitation reply (no model call), the owner can mint invite codes, and each friend is a tenant with
    // her own folder, her own Anthropic API key (OpenBao) and her own limits. The bot never writes first to anybody.
    tenants: oneOf(env, "TENANTS", "off", ["on", "off"] as const) === "on",
    weather: oneOf(env, "WEATHER", "on", ["on", "off"] as const) === "on", // forecast and spot tools with the surf-conditions skill (weathertools.ts)
    tenantDailyBudgetUsd: num(env, "TENANT_DAILY_BUDGET_USD", 2, 0, 10_000), // each tenant's own daily ceiling on her own key (tenant.json may lower or raise it)
    inviteTtlHours: num(env, "INVITE_TTL_HOURS", 72, 1, 24 * 90), // how long a minted invite code works
    tenantNoticeMinutes: num(env, "TENANT_NOTICE_MINUTES", 30, 0, 1440), // a fixed setup, limit or invitation reply to one person at most this often
    tenantWarmMax: num(env, "TENANT_WARM_MAX", 2, 0, 10), // warm model processes kept for tenants (the most recently active ones); 0: none

    signalHost: "127.0.0.1", // never anything else: signal-cli's socket is unauthenticated
    signalPort: num(env, "SIGNAL_PORT", 7583, 1024, 65_535),

    // Voice notes are transcribed on this Mac with whisper.cpp (src/transcribe.ts); nothing leaves it.
    whisperModel: env.WHISPER_MODEL || `${env.HOME ?? ""}/.cache/ted-personal-assistant/ggml-small.bin`,
    transcribeConcurrency: num(env, "TRANSCRIBE_CONCURRENCY", 2, 1, 8), // voice notes transcribed at the same time; the rest wait their turn (main.ts, limiter.ts)
    // Spoken replies to voice messages (src/voicereply.ts): local text to speech with Kokoro (scripts/setup-tts.sh).
    voiceReplies: oneOf(env, "VOICE_REPLIES", "on", ["on", "off"] as const) === "on",
    ttsLanguages: parseLanguages(env.TTS_LANGUAGES), // languages the voice speaks (default en); a reply in another one goes out as text (src/lang.ts)
    // Optional remote speech (docs/REMOTE-TTS.md): sends the spoken words to a third party or to your own server.
    tts: ttsProvider(env, kokoro, dataDir),
    // Group chats (own-account mode, src/group.ts): it takes part in any group the owner is in, speaking only
    // when it fits (see PARTICIPATION in persona.ts).
    groupParticipation: oneOf(env, "GROUP_PARTICIPATION", "auto", ["auto", "tagged"] as const), // auto: the assistant judges every message; tagged: only when @mentioned or replied to
    // Every conversation, the owner's chat and each group: wait this long after a message for a burst to end, then answer all of
    // it as one turn.
    settleSeconds: num(env, "SETTLE_SECONDS", 2, 0, 60),
    settleMaxSeconds: num(env, "SETTLE_MAX_SECONDS", 10, 1, 120), // the longest a burst waits since its first message, so continuous chatter cannot postpone the answer forever
    // Warm model processes (src/agent.ts, src/gate.ts): a process started ahead of the next message skips the ~3 s start-up. At most
    // three exist: the owner's chat, the group that spoke last, and one small Haiku process for the participation gate. Each costs
    // about 150 to 200 MB resident and no tokens, and is dropped after WARM_IDLE_MINUTES without use. WARM=off: every turn starts cold.
    warm: oneOf(env, "WARM", "on", ["on", "off"] as const) === "on",
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
    warmRefreshMinutes: num(env, "WARM_REFRESH_MINUTES", 25, 1, 1440), // the owner's warm process is renewed this often, so it is still fresh after a quiet hour (main.ts)
    briefRetryGapMinutes: num(env, "BRIEF_RETRY_GAP_MINUTES", 10, 1, 240), // an incomplete brief is retried after this long (tasks.ts)
    briefPendingGraceHours: num(env, "BRIEF_PENDING_GRACE_HOURS", 3, 0, 12), // with the backstop off: urgent mail waits for the brief this long after BRIEF_START_HOUR (tasks.ts)
    seenMailDays: num(env, "SEEN_MAIL_DAYS", 14, 1, 365), // how long the heartbeat remembers it has seen a mail (heartbeat.ts)
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
    pluginDir: resolve(fileURLToPath(new URL("../plugin", import.meta.url))),

    dataDir,
    stateDir: join(dataDir, "state"), // bookkeeping the model never reads
    logsDir: join(dataDir, "logs"), // agent.log, audit.jsonl, daemon and launchd output
    memoryDir: join(dataDir, "memory"), // what the model reads: notes/ (the SDK auto-memory) and last-brief.md
    tenantsDir: join(dataDir, "tenants"), // one folder per tenant (notes, history, session, cost, tenant.json): outside logs/, state/ and memory/, so the owner's chat does not read it (policy.ts)
  } as const;
}

export const settings = loadSettings(process.env);
// The speech keys were read into `settings` above. Nothing the agent starts (Claude Code and its MCP servers, ffmpeg, signal-cli)
// needs them, and they are inherited by every child process unless dropped here.
for (const name of ["ELEVENLABS_API_KEY", "TTS_HTTP_TOKEN"]) delete process.env[name];
export const OWNER = settings.owner;
export const ASSISTANT = settings.assistant;
