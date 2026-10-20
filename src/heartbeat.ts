import { formatAlert, inQuietHours, planActions } from "./actions.ts";
import { mailBody } from "./mailtext.ts";
import { LIMITS, oneLine } from "./sanitize.ts";
import type { HandleItem } from "./handler.ts";
import type { GmailMail } from "./gmail.ts";
import type { Mailbird } from "./mailbird.ts";
import { isPaused } from "./pause.ts";
import { settings } from "./settings.ts";
import { readJson, writeJson } from "./state.ts";
import { RateLimitError } from "./errors.ts";
import type { MailInput, Triage } from "./triage.ts";

// The heartbeat tick: a free timer (no model call) that starts the tick-driven jobs (wake-ups, dream, brief, the friends' mail checks).
// The owner's own proactive work is the heartbeat run (src/heartbeat/look.ts, started from wake.ts), not a mail check.
//
// The mail check below is ONE function for each FRIEND who has mail through her own Google (mailloops.ts): the heartbeat lists her inbox with NO model call, and only when
// something new arrived does a model classify it (one batch); then the pure rules in actions.ts decide what to archive, alert on or hand to her handler. What differs per friend
// is a MailContext: where its state files are, how its triage call is made (the instance key, her notes), how a decision is recorded, whether there is a handler and what a
// usage limit means for it.

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

// What one friend's mail check does with what it finds: tell her in her own chat, queue mail for her handler.
export interface MailHooks {
  alert: (text: string) => Promise<void>; // tell the person something (plain text)
  handle: (items: HandleItem[]) => void; // queue mail for the handler
}

interface HeartbeatHooks {
  onTick: () => void; // tick-driven jobs (wake-ups, dream, brief, the friends' mail checks): independent of each other, never awaited
}

// What differs between the conversations that have a mail check.
export interface MailContext {
  files: { seen: string; liveness: string }; // where its seen-mail memory and its last tick are kept (a friend's: her folder)
  triage: (mails: MailInput[]) => Promise<Triage[]>; // the small model's classification: on the instance key with her notes
  record: (decision: string, row: Record<string, unknown>) => void; // what was decided about one mail (a friend's: her own file, wordless in the audit log)
  handler: () => boolean; // a background handler exists for this conversation (it drafts replies with its own tools); without one the mail is kept for the brief
  blocked: (what: string) => boolean; // she may not run a model now (payer.ts mayRun: the key and her own budget): no model call this tick
}

// What the mail check needs of the mail client (Mailbird, the Gmail relay, or a fake in tests).
export type MailSource = (Pick<Mailbird, "inboxes" | "call" | "close"> | Pick<GmailMail, "inboxes" | "call" | "close">) & { getMessages?: GmailMail["getMessages"] };

// Starts every tick-driven job (wake-ups, dream, brief, the friends' mail checks): each in its own try/catch, none awaited, so a job that throws
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

// The cheap pre-check. Returns conversations whose latest message is new. Nothing is marked seen until the caller commits.
async function checkMail(mb: MailSource, seenFile: string) {
  const seen = readJson<Seen>(seenFile, { keys: {} });
  const seeding = !seen.seededAt; // first run ever: record a baseline, triage nothing
  const now = Date.now();
  const fresh: NewMail[] = [];

  for (const inbox of await mb.inboxes()) {
    const rows = await mb.call<Row[]>("list_conversations", { folderId: inbox.folderId, limit: 100 });
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
    if (!(e instanceof RateLimitError)) throw e; // (the cooldown was noted where the call failed: errors.ts failure)
    console.error("heartbeat: usage limit hit, the mail stays unseen and is retried next tick");
    return fresh;
  }
  const plan = planActions(results, { maxArchives: settings.maxArchivesPerTick });
  const decision: string[] = results.map(() => "kept");
  const extra: Record<number, Record<string, unknown>> = {};

  for (const i of plan.archive) {
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

  // act_now: ONE batched message per tick.
  if (plan.alert.length > 0) {
    const text = formatAlert(plan.alert.map((i) => ({ from: fresh[i]!.from, subject: fresh[i]!.subject, reason: results[i]!.reason })));
    const ok = await hooks
      .alert(text)
      .then(() => true, (e) => (console.error("heartbeat: alert failed:", (e as Error).message), false));
    for (const i of plan.alert) decision[i] = ok ? "alerted" : "alert-failed";
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

// The mail check of ONE friend, as a function to call on every tick (mailloops.ts).
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
      const mail = await checkMail(mb, ctx.files.seen);
      failing = false;
      if (mail.seeding) {
        console.log("heartbeat: baseline recorded, existing inbox treated as seen");
      } else {
        if (mail.fresh.length > 0) for (const m of ctx.blocked("mail triage") ? mail.fresh : await processNewMail(mb, mail.fresh, hooks, ctx)) mail.unsee(m); // usage limit: no model call, the mail waits unseen (cooldown.ts)
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

// The tick: a free timer. `env` is for tests: fake timers.
export function startHeartbeat(hooks: HeartbeatHooks, env: { setTimeout?: (f: () => void, ms: number) => unknown; setInterval?: (f: () => void, ms: number) => unknown } = {}) {
  const tick = () => {
    try {
      hooks.onTick(); // starts its jobs without waiting for them
    } catch (e) {
      console.error("heartbeat: tick jobs failed to start:", (e as Error).message);
    }
    if (!isPaused()) writeJson(OWNER_LIVENESS, { lastTickAt: new Date().toISOString() }); // proof of life, so `doctor` sees the heartbeat ticking
  };

  (env.setTimeout ?? setTimeout)(tick, 20_000); // first tick shortly after start
  (env.setInterval ?? setInterval)(tick, settings.heartbeatMinutes * 60_000);
  console.log(`heartbeat: a free tick every ${settings.heartbeatMinutes} min; the owner's heartbeat run looks about every ${settings.heartbeatDayMinutes} min in the day on ${settings.heartbeatModel}`);
  return { tick };
}
