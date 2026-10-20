import { formatAlert, inQuietHours, planActions } from "./actions.ts";
import { mailBody } from "./mailtext.ts";
import { mailAlertRequest, type NoticeWriter } from "./notice.ts";
import { LIMITS, oneLine } from "./sanitize.ts";
import { audit } from "./audit.ts";
import type { HandleItem } from "./handler.ts";
import type { GmailMail } from "./gmail.ts";
import type { Mailbird } from "./mailbird.ts";
import { mailSlot } from "./modules/index.ts";
import { mailRuntime } from "./modules/runtime.ts";
import { noteRateLimit, skipForCooldown } from "./cooldown.ts";
import { isPaused } from "./pause.ts";
import { settings } from "./settings.ts";
import { readJson, writeJson } from "./state.ts";
import { RateLimitError } from "./errors.ts";
import { triageBatch, type MailInput, type Triage } from "./triage.ts";

// The heartbeat: every few minutes (not at night), list the inboxes with NO model call.
// Only when something new arrived does a model classify it (one batch), and then the
// pure rules in actions.ts decide what to archive, alert on or hand to the handler.
//
// The mail check is ONE function for every conversation that has mail (createMailCheck): the owner's (with her mail provider's client, her files, her chat) and each
// friend's with the `mail` and `google` capabilities (mailloops.ts: her Google client, her folder, her chat). What differs is a MailContext: where its state files are, how
// its triage call is made (login or instance key, whose notes), how a decision is recorded, whether there is a handler and what a usage limit means for it. The
// owner is one conversation among others; nothing here knows a friend by name.

const OWNER_SEEN = "state/seen.json";
const OWNER_LIVENESS = "state/heartbeat.json"; // last tick, for `npm run doctor`
const SEEN_TTL_MS = settings.seenMailDays * 24 * 3600_000;
const BRIEF_SUBJECT = /^\s*[☀🌙]/u; // our own briefs: never triaged
const FETCH_CONCURRENCY = 4;

interface Seen {
  seededAt?: string;
  keys: Record<string, number>; // "conversationId:lastMessageId" -> first seen (epoch ms)
}

interface Row {
  conversationId: string;
  subject: string;
  lastSender: string;
  receivedAtUtc: string; // despite the name, Mailbird reports local time (only used for ordering)
  lastMessageId: number | string; // Gmail's ids are strings
}

interface NewMail {
  accountEmail: string;
  conversationId: string;
  messageId: number | string;
  from: string;
  subject: string;
  receivedAtUtc: string;
}

// What one conversation's mail check does with what it finds: tell its person (the owner, or the friend in her own chat), queue mail for its handler.
export interface MailHooks {
  alert: (text: string) => Promise<void>; // tell the person something (plain text)
  write?: NoticeWriter; // writes the alert from the facts (notice.ts); absent: the template text (tests, and friends: the writer runs on the owner's login)
  handle: (items: HandleItem[]) => void; // queue mail for the handler
  briefDue: () => boolean; // today's brief is still due: it will report urgent mail itself
}

interface HeartbeatHooks extends MailHooks {
  onTick: () => void; // tick-driven jobs (wake-ups, dream, brief, radar): independent of the mail check, never awaited
}

// What differs between the conversations that have a mail check.
export interface MailContext {
  files: { seen: string; liveness: string }; // where its seen-mail memory and its last tick are kept (the owner's: state/; a friend's: her folder)
  triage: (mails: MailInput[]) => Promise<Triage[]>; // the small model's classification: on the login for the owner, on the instance key with her notes for a friend
  record: (decision: string, row: Record<string, unknown>) => void; // what was decided about one mail (the owner's: the audit log; a friend's: her own file, wordless in the audit log)
  archiveLogOnly: () => boolean; // classify and log "would-archive" but archive nothing
  handler: () => boolean; // a background handler exists for this conversation (it drafts replies with its own tools); without one the mail is kept for the brief
  skipForCooldown: (what: string) => boolean; // a usage limit is on: no model call this tick (the owner's: the shared cooldown; a friend's: hers)
  onRateLimit: () => void; // the triage call hit the limit
  tidyOwnBriefs: boolean; // older copies of the briefs mailed to oneself are archived (the owner's brief; a friend has none)
}

// What the mail check needs of the mail client (Mailbird, the Gmail relay, or a fake in tests).
export type MailSource = (Pick<Mailbird, "inboxes" | "call" | "close"> | Pick<GmailMail, "inboxes" | "call" | "close">) & { getMessages?: GmailMail["getMessages"] };

// The mail provider's source (the heartbeat and `npm run triage-check` start from here): the loaded mail module's (src/modules).
export function newMailSource(): MailSource & { connect?: () => Promise<void> } {
  const mail = mailRuntime();
  if (!mail) throw new Error("there is no mail provider (MAIL_PROVIDER=none)");
  return mail.source();
}

// Gmail's first week: the heartbeat classifies and logs "would-archive" but archives nothing (GMAIL_ARCHIVE_LIVE=true ends it).
const archiveLogOnly = () => mailSlot()?.archiveLogOnly() ?? false;

// Starts every tick-driven job (wake-ups, dream, brief, radar): each in its own try/catch, none awaited, so a job that throws
// (even synchronously) or hangs never keeps another from starting.
export function startJobs(jobs: Record<string, () => unknown>): void {
  for (const [name, f] of Object.entries(jobs)) {
    try {
      void Promise.resolve(f()).catch((e) => console.error(`${name}: tick failed:`, (e as Error).message));
    } catch (e) {
      console.error(`${name}: tick failed:`, (e as Error).message);
    }
  }
}

const newMail = (inbox: { email: string }, row: Row): NewMail => ({
  accountEmail: inbox.email,
  conversationId: row.conversationId,
  messageId: row.lastMessageId,
  from: oneLine("mail sender", row.lastSender ?? "", LIMITS.name), // cleaned where the mail enters: audit, digest, alerts and prompts all start from this
  subject: oneLine("mail subject", row.subject ?? ""),
  receivedAtUtc: row.receivedAtUtc,
});

const seenKey = (m: { conversationId: string; lastMessageId?: number | string; messageId?: number | string }) =>
  `${m.conversationId}:${m.lastMessageId ?? m.messageId}`;

// The cheap pre-check. Returns conversations whose latest message is new, plus older copies
// of our own brief to tidy away. Nothing is marked seen until the caller commits.
async function checkMail(mb: MailSource, seenFile: string, tidyOwnBriefs: boolean) {
  const seen = readJson<Seen>(seenFile, { keys: {} });
  const seeding = !seen.seededAt; // first run ever: record a baseline, triage nothing
  const now = Date.now();
  const fresh: NewMail[] = [];
  const staleBriefs: string[] = [];

  for (const inbox of await mb.inboxes()) {
    const rows = await mb.call<Row[]>("list_conversations", { folderId: inbox.folderId, limit: 100 });
    // Keep only the newest of our own briefs. "Own" = brief subject AND this account's own name.
    const own = !tidyOwnBriefs ? [] : rows
      .filter((r) => BRIEF_SUBJECT.test(r.subject) && r.lastSender === inbox.senderName)
      .sort((a, b) => b.receivedAtUtc.localeCompare(a.receivedAtUtc));
    staleBriefs.push(...own.slice(1).map((r) => r.conversationId));

    for (const row of rows) {
      const key = seenKey(row);
      if (seen.keys[key]) continue;
      seen.keys[key] = now;
      if (seeding || BRIEF_SUBJECT.test(row.subject)) continue;
      fresh.push(newMail(inbox, row));
    }
  }
  for (const [key, ts] of Object.entries(seen.keys)) if (now - ts > SEEN_TTL_MS) delete seen.keys[key];
  if (seeding) seen.seededAt = new Date().toISOString();

  return {
    fresh,
    staleBriefs,
    seeding,
    // Mail we chose not to finish with (archive cap reached) stays unseen: the next tick retries it.
    unsee: (m: NewMail) => void delete seen.keys[seenKey(m)],
    commit: () => writeJson(seenFile, seen),
  };
}

// Runs `fn` over `items` with at most `limit` in flight, keeping order.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const short = (res: unknown) => String(typeof res === "string" ? res : JSON.stringify(res)).replace(/\s+/g, " ").slice(0, 120);

type Fetched = { body?: string; from?: { displayName?: string; email?: string } };

async function fetchInputs(mb: MailSource, mails: NewMail[]): Promise<MailInput[]> {
  // Gmail answers every message of the tick in one relay run (a model run each would be the cost of a busy inbox).
  const batch = mb.getMessages ? await mb.getMessages(mails.map((m) => m.messageId)) : undefined;
  return mapLimit(mails, FETCH_CONCURRENCY, async (m, i): Promise<MailInput> => {
    const got = batch?.[i];
    if (got instanceof Error) throw got;
    const msg = got ?? (await mb.call<Fetched>("get_message", { messageId: m.messageId }));
    return {
      account: m.accountEmail,
      fromName: oneLine("mail sender", msg.from?.displayName ?? m.from, LIMITS.name),
      fromEmail: oneLine("mail sender", msg.from?.email ?? "", LIMITS.name),
      subject: m.subject,
      receivedAtUtc: m.receivedAtUtc,
      body: mailBody(msg.body ?? ""),
    };
  });
}

// Classify all new mail in one batch, act on the plan, record every decision.
// Returns mail that should be retried next tick. Once the batch is classified nothing here
// throws: every side effect is guarded, so a failure can never cause a repeat alert.
async function processNewMail(mb: MailSource, fresh: NewMail[], hooks: MailHooks, ctx: MailContext): Promise<NewMail[]> {
  console.log(`heartbeat: ${fresh.length} new conversation(s)`);

  let results: Triage[];
  try {
    results = await ctx.triage(await fetchInputs(mb, fresh));
  } catch (e) {
    if (!(e instanceof RateLimitError)) throw e;
    ctx.onRateLimit();
    console.error("heartbeat: usage limit hit, the mail stays unseen and is retried next tick");
    return fresh;
  }
  const plan = planActions(results, { maxArchives: settings.maxArchivesPerTick });
  const decision: string[] = results.map((t) => (settings.heartbeatLive ? "kept" : `would-${t.label}`));
  const extra: Record<number, Record<string, unknown>> = {};

  if (settings.heartbeatLive) {
    for (const i of plan.archive) {
      if (ctx.archiveLogOnly()) {
        decision[i] = "would-archive";
        continue;
      }
      try {
        // Mailbird may assign a new id on archive: the response is kept so `npm run restore` can find it.
        extra[i] = { result: short(await mb.call("archive_conversation", { conversationId: fresh[i]!.conversationId })) };
        decision[i] = "archived";
      } catch (e) {
        decision[i] = "archive-failed";
        extra[i] = { error: (e as Error).message.slice(0, 100) };
      }
    }
    for (const i of plan.deferred) decision[i] = "archive-deferred";

    // act_now: ONE batched message per tick. While today's brief is still due (e.g. the first
    // tick after the night), the brief reports these itself, so no separate alert is sent.
    if (plan.alert.length > 0) {
      if (hooks.briefDue()) {
        for (const i of plan.alert) decision[i] = "covered-by-brief";
      } else {
        const items = plan.alert.map((i) => ({ from: fresh[i]!.from, subject: fresh[i]!.subject, reason: results[i]!.reason }));
        const template = formatAlert(items);
        // Written by a model from the facts, plain text; any failure sends the template, so an alert is never lost.
        const text = hooks.write ? await hooks.write(mailAlertRequest(items, template)).catch(() => template) : template;
        const ok = await hooks
          .alert(text)
          .then(() => true, (e) => (console.error("heartbeat: alert failed:", (e as Error).message), false));
        for (const i of plan.alert) decision[i] = ok ? "alerted" : "alert-failed";
      }
    }

    if (plan.handle.length > 0 && !ctx.handler()) {
      // A provider without the background handler (Gmail: it drafts replies with Mailbird's tools and shows them as Mailbird drafts). The mail stays in the inbox and the brief lists it.
      for (const i of plan.handle) decision[i] = "kept-no-handler";
    } else if (plan.handle.length > 0) {
      try {
        hooks.handle(
          plan.handle.map((i) => {
            const m = fresh[i]!;
            return { account: m.accountEmail, conversationId: m.conversationId, messageId: String(Number(m.messageId)) === String(m.messageId) ? Number(m.messageId) : String(m.messageId), from: m.from, subject: m.subject }; // (Mailbird's ids are numbers; another provider's stay as they are)
          }),
        );
        for (const i of plan.handle) decision[i] = "queued-for-handler";
      } catch (e) {
        console.error("heartbeat: could not queue for the handler:", (e as Error).message);
        for (const i of plan.handle) decision[i] = "handler-queue-failed";
      }
    }
  }

  const counts: Record<string, number> = {};
  fresh.forEach((m, i) => {
    const t = results[i]!;
    counts[decision[i]!] = (counts[decision[i]!] ?? 0) + 1;
    ctx.record(decision[i]!, {
      id: m.conversationId,
      messageId: m.messageId,
      from: m.from,
      subject: m.subject,
      account: m.accountEmail,
      label: t.label,
      kind: t.kind,
      reason: t.reason,
      protected: t.protected,
      ...extra[i],
    });
  });
  console.log(`heartbeat: triaged ${fresh.length} (${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")})`);
  return plan.deferred.map((i) => fresh[i]!);
}

// Older copies of our own brief: archived, keeping the newest one per account.
async function archiveStaleBriefs(mb: MailSource, ids: string[]) {
  for (const id of ids.slice(0, 5)) {
    try {
      await mb.call("archive_conversation", { conversationId: id });
      audit("heartbeat_stale_brief", "archived", "heartbeat", { id });
    } catch (e) {
      console.error("heartbeat: could not archive an old brief:", (e as Error).message);
    }
  }
}

// The mail check of ONE conversation, as a function to call on every tick: the same code for the owner (startHeartbeat below) and for each friend (mailloops.ts).
// It never overlaps itself, rests in the night and while paused, reads the mailbox with no model call, hands only NEW mail to the small model, acts on the plan, and
// writes its last tick. A failing mailbox is reported once per outage and reconnected on the next tick.
export function createMailCheck(mb: MailSource, ctx: MailContext, hooks: MailHooks): () => Promise<void> {
  let running = false;
  let failing = false;
  return async () => {
    if (running || isPaused()) return; // mail ticks never overlap
    // Night: no mail work at all (no mailbox calls, no model turns). Everything that arrived
    // is picked up together by the first tick after quietEndHour.
    if (inQuietHours(new Date(), settings.quietStartHour, settings.quietEndHour)) return;
    running = true;
    try {
      const mail = await checkMail(mb, ctx.files.seen, ctx.tidyOwnBriefs);
      failing = false;
      if (mail.seeding) {
        console.log("heartbeat: baseline recorded, existing inbox treated as seen");
      } else {
        if (mail.fresh.length > 0) for (const m of ctx.skipForCooldown("mail triage") ? mail.fresh : await processNewMail(mb, mail.fresh, hooks, ctx)) mail.unsee(m); // usage limit: no model call, the mail waits unseen (cooldown.ts)
        if (settings.heartbeatLive && !ctx.archiveLogOnly() && mail.staleBriefs.length > 0) await archiveStaleBriefs(mb, mail.staleBriefs);
      }
      mail.commit(); // only now are these messages "seen"
      const prev = readJson<{ lastNewMailAt?: string }>(ctx.files.liveness, {});
      writeJson(ctx.files.liveness, { lastTickAt: new Date().toISOString(), lastNewMailAt: mail.fresh.length ? new Date().toISOString() : prev.lastNewMailAt });
    } catch (e) {
      if (!failing) console.error("heartbeat error:", (e as Error).message); // once per outage
      failing = true;
      await mb.close().catch(() => {}); // reconnect on the next tick
    } finally {
      running = false;
    }
  };
}

// The owner's context: her provider's client, state/, the audit log, the login, the shared cooldown.
export function ownerMailContext(triage: MailContext["triage"] = (mails) => triageBatch(mails)): MailContext {
  return {
    files: { seen: OWNER_SEEN, liveness: OWNER_LIVENESS },
    triage,
    record: (decision, row) => audit("heartbeat_triage", decision, "heartbeat", row),
    archiveLogOnly,
    handler: () => mailSlot()?.handler !== false,
    skipForCooldown: (what) => skipForCooldown(what),
    onRateLimit: () => noteRateLimit(),
    tidyOwnBriefs: true,
  };
}

// `env` is for tests: a fake mail source (or the factory that would make the real one) and fake timers.
export function startHeartbeat(hooks: HeartbeatHooks, env: { triage?: typeof triageBatch; mail?: MailSource; newMail?: () => MailSource; setTimeout?: (f: () => void, ms: number) => unknown; setInterval?: (f: () => void, ms: number) => unknown } = {}) {
  // MAIL_PROVIDER=none: no mail client is made, let alone connected. Only the liveness line is kept (mailOff below).
  const mb = settings.mail ? (env.mail ?? (env.newMail ?? newMailSource)()) : undefined;
  const { onTick, ...mailHooks } = hooks;
  const mailCheck = mb ? createMailCheck(mb, ownerMailContext(env.triage && ((mails) => env.triage!(mails))), mailHooks) : undefined;

  // Without mail the "check" is just proof of life, so `doctor` sees the heartbeat ticking. Same pause and night rules, no calls, no log lines.
  const mailOff = async () => {
    if (isPaused() || inQuietHours(new Date(), settings.quietStartHour, settings.quietEndHour)) return;
    const prev = readJson<{ lastNewMailAt?: string }>(OWNER_LIVENESS, {});
    writeJson(OWNER_LIVENESS, { lastTickAt: new Date().toISOString(), lastNewMailAt: prev.lastNewMailAt });
  };
  const tick = () => {
    try {
      onTick(); // starts its jobs without waiting for them
    } catch (e) {
      console.error("heartbeat: tick jobs failed to start:", (e as Error).message);
    }
    void (mailCheck ?? mailOff)().catch((e) => console.error("heartbeat: mail check failed:", (e as Error).message));
  };

  (env.setTimeout ?? setTimeout)(tick, 20_000); // first tick shortly after start
  (env.setInterval ?? setInterval)(tick, settings.heartbeatMinutes * 60_000);
  console.log(
    `heartbeat: every ${settings.heartbeatMinutes} min, idle ${settings.quietStartHour}:00-${settings.quietEndHour}:00, actions ${settings.heartbeatLive ? "LIVE" : "log-only"}`,
  );
  if (!mb) console.log("mail: off (MAIL_PROVIDER=none)");
  return { tick, mailCheck: mailCheck ?? mailOff };
}

// `npm run triage-check`: classify the newest inbox mail exactly as the heartbeat would, and
// show what it would do. Acts on nothing, writes nothing: a safe way to check the classifier.
export async function triageCheck(mb: MailSource, count: number) {
  const mails: NewMail[] = [];
  for (const inbox of await mb.inboxes()) {
    const rows = await mb.call<Row[]>("list_conversations", { folderId: inbox.folderId, limit: count });
    for (const r of rows) {
      if (BRIEF_SUBJECT.test(r.subject)) continue;
      mails.push(newMail(inbox, r));
    }
  }
  mails.sort((a, b) => b.receivedAtUtc.localeCompare(a.receivedAtUtc)).splice(count);
  const results = await triageBatch(await fetchInputs(mb, mails));
  const plan = planActions(results, { maxArchives: settings.maxArchivesPerTick });
  const action = (i: number) =>
    plan.archive.includes(i) ? "archive" : plan.alert.includes(i) ? "alert" : plan.handle.includes(i) ? "handler" : plan.deferred.includes(i) ? "defer" : "keep";
  return mails.map((m, i) => ({ ...m, ...results[i]!, action: action(i) }));
}
