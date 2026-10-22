import { liveConvDb, peekConvDb } from "../core/convdb.ts";
import { convIdOfKey } from "../core/convpaths.ts";
import type { Db } from "../core/db.ts";
import { emitRecord } from "../core/events.ts";
import { ledgerEntries } from "../core/messages.ts";
import { settings } from "../core/settings.ts";
import { readNotes } from "../memory/notes.ts";
import { parseShadowReply } from "./shadowparse.ts";
import type { Proposed } from "./shadowgate.ts";

// THE GENTLE FIRST WEEK. A fresh install must not archive mail on the model's judgement before the person has said a word about what she wants archived: one wrong archive on day one and people switch
// the assistant off. So while a conversation is new, an unattended look (the heartbeat run, for the owner and for a friend's own mail) PROPOSES its archives instead of making them:
//   * the floor is shadowgate.ts, asked by permissions.ts: an archive call in such a look is not executed; it is collected (one call per mail, with the subject and sender lines code reads from the
//     connector's results) and refused with a sentence for the model. A chat turn's archive ("archive all newsletters": she asked) never goes through it.
//   * the look's end offers everything collected as ONE message, "I'd archive these 14: 👍 to archive all, or reply '3,5 keep'" (offerShadow). Which message listed which mail is written down here
//     (shadow_proposals in the conversation's assistant.db). Then CODE, not a model, reads the answer (conversation/shadowreplies.ts, shadowparse.ts): a 👍 archives every listed mail, "3,5 keep"
//     leaves those and archives the rest. The archives run EXACTLY as the look recorded them, in one small follow-up run whose permission layer allows those calls and no others (shadowexec.ts,
//     run/shadowrun.ts), like the approval inbox's replay: the model never re-creates a call.
//   * WHEN IT ENDS (SHADOW_MODE=auto): when 3 days have passed since the conversation's first message AND the person has at least one confirmed triage note ("what to archive": the thing the first
//     week exists to collect), and at the latest after 14 days whatever the notes say. Once ended it stays ended (it is written down, deleting notes does not bring it back) and the person is told
//     once. SHADOW_MODE=on never ends, off never starts. An install that is already past its first week (a mail log, or a conversation older than 14 days) is adopted silently, as ended.

export const SHADOW_MIN_DAYS = 3;
export const SHADOW_MAX_DAYS = 14;
const DAY = 86_400_000;
const PROPOSAL_DAYS = 7; // a proposal nobody answers lapses after this (nothing is archived)
const KEEP_ROWS_DAYS = 60;
const RUN_CALLS = 40; // the most archive calls one follow-up run is given

export const SHADOW_ENDED_TEXT = "From now on I'll archive these kinds of mail myself; you'll see them in /today.";

/** The parts of a Conversation this file needs. */
export interface ShadowConv {
  readonly kind: "owner" | "group" | "tenant";
  readonly key: string;
  readonly convId: string;
  readonly notesDir: string;
  readonly logFile: string;
}

/** What main.ts gives it: the conversation's chat, whether it is being left alone now (quiet hours), and the follow-up run. */
export interface ShadowRuntime {
  send(conv: ShadowConv, text: string): Promise<number>;
  holding(conv: ShadowConv, now: Date): boolean;
  /** Run exactly these calls (run/shadowrun.ts). `ran[i]`: the i-th call succeeded. `refused`: the run gate said not now (pause, budget...): nothing was tried. */
  execute(conv: ShadowConv, calls: readonly { tool: string; input: Record<string, unknown> }[]): Promise<{ ran: boolean[]; refused?: string }>;
}
let rt: ShadowRuntime | undefined;
export const setShadowRuntime = (r: ShadowRuntime | undefined): void => void (rt = r);

// ---- when it is on ----

// Pure: has the first week ended? `triageNotes`: the person's own (confirmed, not inferred) triage notes.
export function shadowEnded(o: { since: number; now: number; triageNotes: number }): boolean {
  const age = o.now - o.since;
  return age >= SHADOW_MAX_DAYS * DAY || (age >= SHADOW_MIN_DAYS * DAY && o.triageNotes > 0);
}

interface StateRow {
  since: number;
  ended_at: number | null;
  told: number;
}
const stateOf = (db: Db): StateRow | undefined => db.get<StateRow>("SELECT since, ended_at, told FROM shadow_state WHERE id = 1");

// The first message of the conversation (the first thing in its log that is conversation, not ledger), else undefined.
const firstMessageAt = (file: string): number | undefined => {
  const first = ledgerEntries(file).find((e) => e.kind !== "action" && e.kind !== "wake" && e.kind !== "journal");
  const at = first ? Date.parse(first.at) : NaN;
  return Number.isFinite(at) ? at : undefined;
};

const triageNotes = (conv: ShadowConv, now: Date): number => readNotes(now, conv.notesDir).filter((n) => n.category === "triage" && !n.inferred).length;

/**
 * Is this conversation's look in shadow mode? Counted from the conversation's first message (the first look when it has none), written down at the first answer so the weeks do not restart.
 * An install that was already triaging mail (a seen-mail log) or whose conversation is older than the longest first week is adopted as ended, and not told (nothing changes for it).
 * Called once at the start of a look; false when the database is not usable (background work is refused then anyway).
 */
export function shadowActive(conv: ShadowConv, now: Date = new Date()): boolean {
  const mode = settings.shadowMode;
  if (mode === "off") return false;
  if (mode === "on") return true;
  const db = liveConvDb(convIdOfKey(conv.key));
  if (!db) return false;
  const t = now.getTime();
  let st = stateOf(db);
  if (!st) {
    const since = Math.min(firstMessageAt(conv.logFile) ?? t, t);
    const past = db.num("SELECT COUNT(*) FROM seen_mail") > 0 || t - since >= SHADOW_MAX_DAYS * DAY;
    db.run("INSERT INTO shadow_state (id, since, ended_at, told) VALUES (1, ?, ?, ?)", since, past ? t : null, past ? 1 : 0);
    if (past) emitRecord("shadow", "adopted-ended", "background", { conv: conv.key });
    st = stateOf(db)!;
  }
  if (st.ended_at != null) return false;
  if (!shadowEnded({ since: st.since, now: t, triageNotes: triageNotes(conv, now) })) return true;
  db.run("UPDATE shadow_state SET ended_at = ? WHERE id = 1 AND ended_at IS NULL", t);
  emitRecord("shadow", "ended", "background", { conv: conv.key, days: Math.floor((t - st.since) / DAY) });
  return false;
}

/** Shadow mode has ended and the person has not been told yet: say it once (not in quiet hours; the next look does). Never throws. */
export async function tellShadowEnded(conv: ShadowConv, now: Date = new Date()): Promise<"sent" | "held" | "none"> {
  try {
    if (settings.shadowMode !== "auto" || !rt) return "none";
    const db = peekConvDb(convIdOfKey(conv.key));
    const st = db && stateOf(db);
    if (!db || !st || st.ended_at == null || st.told) return "none";
    if (rt.holding(conv, now)) return "held";
    await rt.send(conv, SHADOW_ENDED_TEXT);
    db.run("UPDATE shadow_state SET told = 1 WHERE id = 1");
    return "sent";
  } catch (e) {
    console.error("shadow: could not say that the first week is over:", (e as Error).message);
    return "none";
  }
}

// ---- offering ----

interface Row {
  seq: number;
  tool: string;
  input: string;
  mail_id: string;
  line: string;
  at: number;
  state: "collected" | "asked" | "archiving" | "archived" | "kept" | "failed" | "expired";
  msg_ts: number | null;
  n: number | null;
}
const COLS = "seq, tool, input, mail_id, line, at, state, msg_ts, n";

/** The proposal message: the mail by number, one code-rendered line each. */
export function shadowMessage(lines: readonly string[]): string {
  const one = lines.length === 1;
  return [
    one ? "📥 I'm still getting to know your inbox, so I only suggest for now. I'd archive this one (nothing was touched):" : `📥 I'm still getting to know your inbox, so I only suggest for now. I'd archive these ${lines.length} (nothing was touched):`,
    ...lines.map((l, i) => `${i + 1}. ${l}`),
    "",
    one ? "👍 to archive it, or reply 'keep' to leave it." : "👍 to archive them all, or reply e.g. '3,5 keep' to leave those in your inbox.",
  ].join("\n");
}

const claimed = new Set<number>(); // message timestamps whose archives THIS process is running

/**
 * The end of a look: remember what it proposed and offer everything not yet offered as ONE message (the numbers are per message). Quiet hours keep it for the next look. Never throws: the look is
 * over, a failed send is tried again at the next look.
 */
export async function offerShadow(conv: ShadowConv, proposed: readonly Proposed[], now: Date = new Date()): Promise<"sent" | "held" | "none"> {
  try {
    const db = proposed.length > 0 ? liveConvDb(convIdOfKey(conv.key)) : peekConvDb(convIdOfKey(conv.key));
    if (!db) return "none";
    const t = now.getTime();
    db.tx(() => {
      db.run("UPDATE shadow_proposals SET state = 'asked' WHERE state = 'archiving' AND msg_ts NOT IN (" + ([...claimed].join(",") || "0") + ")"); // (the process stopped mid-run: she can answer again)
      db.run("UPDATE shadow_proposals SET state = 'expired' WHERE state IN ('collected', 'asked') AND at < ?", t - PROPOSAL_DAYS * DAY);
      db.run("DELETE FROM shadow_proposals WHERE state IN ('archived', 'kept', 'failed', 'expired') AND at < ?", t - KEEP_ROWS_DAYS * DAY);
      for (const p of proposed) {
        if (db.get("SELECT 1 FROM shadow_proposals WHERE mail_id = ? AND state IN ('collected', 'asked', 'archiving', 'kept')", p.id)) continue; // (the next look sees the same mail again until she has answered)
        db.run("INSERT INTO shadow_proposals (tool, input, mail_id, line, at) VALUES (?, ?, ?, ?, ?)", p.tool, JSON.stringify(p.input), p.id, p.line, t);
      }
    });
    const rows = db.all<Row>(`SELECT ${COLS} FROM shadow_proposals WHERE state = 'collected' ORDER BY seq LIMIT ?`, settings.archiveMaxPerRun);
    if (rows.length === 0 || !rt) return "none";
    if (rt.holding(conv, now)) return "held";
    const ts = await rt.send(conv, shadowMessage(rows.map((r) => r.line)));
    db.tx(() => rows.forEach((r, i) => db.run("UPDATE shadow_proposals SET state = 'asked', msg_ts = ?, n = ? WHERE seq = ?", ts, i + 1, r.seq)));
    emitRecord("shadow", "proposed", "background", { conv: conv.key, count: rows.length });
    return "sent";
  } catch (e) {
    console.error("shadow: could not offer the proposals:", (e as Error).message);
    return "none";
  }
}

// ---- answering ----

export interface Listed {
  n: number;
  line: string;
  state: Row["state"];
}
/** The mail a message listed (any state), numbered as it was shown. Empty: no such proposal message. */
export function listedBy(key: string, ts: number): Listed[] {
  return peekConvDb(convIdOfKey(key))?.all<Row>(`SELECT ${COLS} FROM shadow_proposals WHERE msg_ts = ? ORDER BY n`, ts).map((r) => ({ n: r.n!, line: r.line, state: r.state })) ?? [];
}
export const isShadowMessage = (key: string, ts: number): boolean => listedBy(key, ts).length > 0;

export interface Settled {
  reply: string;
  kept: Listed[]; // what was left in the inbox (the reply layer may offer to remember it)
}

const chains = new Map<string, Promise<void>>();
export const idle = (): Promise<void> => Promise.all([...chains.values()]).then(() => undefined); // tests

const numbers = (ns: readonly number[]): string => ns.map((n) => `#${n}`).join(", ");

/**
 * Apply an answer to the message `ts` listed: `keep` are left in the inbox (their numbers), the rest of what is still waiting is archived, EXACTLY the calls the look made, in one follow-up run
 * whose result is told in chat when it ends. What was already settled is left alone. Returns the immediate reply, or undefined when the message lists nothing.
 */
export function settleShadow(conv: ShadowConv, ts: number, keep: readonly number[], how: string): Settled | undefined {
  const db = peekConvDb(convIdOfKey(conv.key));
  const rows = db?.all<Row>(`SELECT ${COLS} FROM shadow_proposals WHERE msg_ts = ? ORDER BY n`, ts) ?? [];
  if (!db || rows.length === 0) return undefined;
  const waiting = rows.filter((r) => r.state === "asked");
  if (waiting.length === 0) return { reply: "Those were already handled.", kept: [] };
  const left = waiting.filter((r) => keep.includes(r.n!));
  const go = waiting.filter((r) => !keep.includes(r.n!));
  db.tx(() => {
    for (const r of left) db.run("UPDATE shadow_proposals SET state = 'kept' WHERE seq = ? AND state = 'asked'", r.seq);
    for (const r of go) db.run("UPDATE shadow_proposals SET state = 'archiving' WHERE seq = ? AND state = 'asked'", r.seq); // (claimed: a second 👍 finds nothing to do)
  });
  for (const r of left) emitRecord("shadow", "kept", "chat", { conv: conv.key, how });
  const kept = left.map((r) => ({ n: r.n!, line: r.line, state: "kept" as const }));
  const said = [go.length ? `On it: archiving ${go.length === 1 ? "that one" : `${go.length}`}.` : "", left.length ? `Leaving ${left.length === 1 ? "that one" : `${numbers(left.map((r) => r.n!))}`} in your inbox.` : ""].filter(Boolean).join(" ");
  if (go.length) run(conv, ts, go);
  return { reply: said, kept };
}

// One follow-up run at a time per conversation. Never throws; the result is told in the chat.
function run(conv: ShadowConv, ts: number, go: readonly Row[]): void {
  claimed.add(ts);
  const next = (chains.get(conv.key) ?? Promise.resolve()).then(async () => {
    const db = peekConvDb(convIdOfKey(conv.key));
    let ran: boolean[] = [];
    let refused: string | undefined;
    let failure: string | undefined;
    try {
      if (!rt) throw new Error("not available");
      const calls = go.map((g) => ({ tool: g.tool, input: JSON.parse(g.input) as Record<string, unknown> }));
      const size = Math.max(1, Math.min(RUN_CALLS, settings.archiveMaxPerRun)); // (a run's archive cap applies to the follow-up run too: a big answer is several runs)
      for (let i = 0; i < calls.length && refused === undefined; i += size) {
        const r = await rt.execute(conv, calls.slice(i, i + size));
        ran.push(...calls.slice(i, i + size).map((_, k) => !!r.ran[k]));
        refused = r.refused;
      }
    } catch (e) {
      failure = (e as Error).message || "the run failed";
    }
    const done = go.filter((_, i) => ran[i]);
    const lost = go.filter((_, i) => !ran[i]);
    if (db) {
      db.tx(() => {
        for (const r of done) db.run("UPDATE shadow_proposals SET state = 'archived' WHERE seq = ?", r.seq);
        // The run gate said not now (pause, budget, cooldown): back to waiting, so the same message can be answered again. A run that failed: failed, not retried by itself.
        for (const r of lost) db.run("UPDATE shadow_proposals SET state = ? WHERE seq = ?", refused !== undefined ? "asked" : "failed", r.seq);
      });
    }
    claimed.delete(ts);
    emitRecord("shadow", failure || refused !== undefined ? "archive-failed" : "archived", "chat", { conv: conv.key, archived: done.length, failed: lost.length });
    const text =
      refused !== undefined ? `I can't archive those right now (${refused}). Reply again once that's sorted and I'll do it.`
      : failure ? `⚠️ I could not archive those (${failure}). Nothing else was touched.`
      : lost.length === 0 ? `✅ Archived ${done.length === 1 ? "1 mail" : `${done.length} mails`}. They are in your archive, not deleted.`
      : `Archived ${done.length} of ${go.length}; ${lost.length} could not be archived (${lost.slice(0, 3).map((r) => r.line).join("; ")}${lost.length > 3 ? "; ..." : ""}).`;
    try {
      await rt?.send(conv, text);
    } catch (e) {
      console.error("shadow: could not report the archives:", (e as Error).message);
    }
  });
  chains.set(conv.key, next);
  void next.finally(() => chains.get(conv.key) === next && chains.delete(conv.key));
}

/** Read the words of a reply to the message `ts` and apply them. undefined: the message lists nothing here, or the words are no answer (an ordinary message). */
export function answerShadow(conv: ShadowConv, text: string, ts: number): Settled | { reply: string; kept: [] } | undefined {
  const listed = listedBy(conv.key, ts);
  if (listed.length === 0) return undefined;
  const p = parseShadowReply(text, listed.length);
  if (p.kind === "none") return undefined;
  if (p.kind === "clarify") return { reply: p.why, kept: [] };
  const all = listed.map((l) => l.n);
  return settleShadow(conv, ts, p.kind === "all" ? [] : p.kind === "nothing" ? all : p.keep, "a reply to the proposal");
}

/** A reaction on the message `ts`: 👍 archives everything listed that is still waiting, 👎 leaves it all. undefined: the message lists nothing here. */
export function reactShadow(conv: ShadowConv, up: boolean, ts: number): Settled | undefined {
  const listed = listedBy(conv.key, ts);
  if (listed.length === 0) return undefined;
  return settleShadow(conv, ts, up ? [] : listed.map((l) => l.n), up ? "a 👍 on the proposal" : "a 👎 on the proposal");
}
