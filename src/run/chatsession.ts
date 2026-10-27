import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { gated } from "../core/rungate.ts";
import { emitRecord } from "../core/events.ts";
import { withCeiling } from "./ceiling.ts";
import { failure, isApiRefusal } from "../tenants/errors.ts";
import type { Conversation } from "../conversation/conversationmodel.ts";
import { charge, envFor, isRefusal, LOGIN, mayRun, observe, succeeded, type MayRunOptions, type Payer } from "../tenants/payer.ts";
import { OWNER_CONV, type ConvId } from "../core/convpaths.ts";
import { readSession, writeSession, type Track } from "./sessionstore.ts";
import type { Source } from "../core/audit.ts";
import { auditSource, type Who } from "../core/runkind.ts";
import { planSession, type ChatSession, type CompactMode } from "./session.ts";
import { settings } from "../core/settings.ts";
import { forgetShown } from "./turncontext.ts";

// Every conversation (the owner's chat, each group, each friend) persists across restarts, with the hygiene rules in
// session.ts (fresh after idle, compacted when large). total_cost_usd is cumulative across a resumed
// session, so we keep the running total and report each turn's delta. A conversation has two sessions, one per `track` (sessionstore.ts, core/convdb.ts): its chat, and its looks (the background
// checks, on their own model). The same rules and the same code serve both; they never mix.

export interface Resume {
  resume?: string; // session to continue (chat only)
  previousCost: number; // total_cost_usd is cumulative across a resumed session
  seenAt?: string;
}

// When a chat session is compacted (session.ts planSession). The SDK only compacts near the context limit, so a long-lived session would re-send an ever-growing history on every turn.
const COMPACT_GROWTH_TOKENS = 100_000; // the conversation itself (context minus tools, skills and prompts) this big: compact afterwards, owner and groups alike
const COMPACT_TOKENS = 150_000; // fallback for a session saved before the baseline was recorded: a turn this big: compact afterwards (tools and skills alone are ~50k)
const COMPACT_QUIET_MINUTES = 5; // a grown conversation is compacted in the background once its last turn is this old
const COMPACT_MAX_MINUTES = 10; // a compaction that takes longer is abandoned (the failure backoff in session.ts applies)
const chatPlanOpts = (mode: CompactMode) => ({ compactTokens: COMPACT_TOKENS, compactGrowth: COMPACT_GROWTH_TOKENS, quietMinutes: COMPACT_QUIET_MINUTES, mode });

// A conversation continues its saved session unless session.ts says to start fresh.
export function chatResume(conv: ConvId = OWNER_CONV, track: Track = "chat"): Resume {
  const saved = readSession(conv, track);
  // A fresh session starts its cost total at zero, so the previous total must not be subtracted.
  if (planSession(saved, new Date(), chatPlanOpts("off")) === "fresh") return { previousCost: 0 };
  return { resume: saved.sessionId, previousCost: saved.costUsd, seenAt: saved.seenAt };
}

// The options of the /compact run. A group's session was built under the group's isolation (buildOptions: no user settings,
// no connectors, only the tools and shared skills of its capabilities, auto-memory = its own notes folder), and its compaction must load nothing more than
// that: it is the same session, resumed. The owner's compaction is unchanged.
export function compactOptions(sessionId: string | undefined, isolated: boolean, notesDir?: string, payer: Payer = LOGIN, track: Track = "chat"): Options {
  return {
    model: track === "look" ? settings.heartbeatModel : settings.model, // (a session is compacted on the model it runs on)
    ...(payer.kind === "instance" ? { env: envFor(payer, { ...process.env }) } : {}), // a friend's compaction is on the instance key, like her turns'

    resume: sessionId,
    tools: [],
    settingSources: [],
    ...(isolated ? { strictMcpConfig: true, settings: notesDir ? { autoMemoryEnabled: true, autoMemoryDirectory: notesDir } : { autoMemoryEnabled: false } } : {}),
    maxTurns: 2,
    maxBudgetUsd: 1.0,
    canUseTool: async () => ({ behavior: "deny", message: "No tools during compaction." }),
  };
}

// Is a quiet-time compaction due for this session? A cheap read of the session row, for the heartbeat to ask before it queues anything.
export function compactDue(conv: ConvId = OWNER_CONV, now: Date = new Date()): boolean {
  return TRACKS.some((t) => planSession(readSession(conv, t), now, chatPlanOpts("quiet")) === "resume then compact");
}
const TRACKS: readonly Track[] = ["chat", "look"];

// Compact a conversation's session (`conv`) in place by sending the SDK's own /compact command on the resumed session, if
// session.ts says so for this `mode`: "urgent" right after a reply that left the context far past the limit (the caller waits),
// "quiet" from the heartbeat once the conversation has been still for COMPACT_QUIET_MINUTES. Always called from the conversation's
// serial queue, so a message that arrives meanwhile waits behind it and nothing else touches the record. Never throws.
export async function compactChatIfNeeded(conv: ConvId = OWNER_CONV, who: Who = "owner", notesDir?: string, mode: "quiet" | "urgent" = "urgent", payer: Payer = LOGIN, track: Track = "chat"): Promise<void> {
  const source = auditSource({ who, attended: track === "chat" }); // (the audit label)
  const isolated = who !== "owner";
  try {
    const saved = readSession(conv, track);
    if (planSession(saved, new Date(), chatPlanOpts(mode)) !== "resume then compact") return;
    console.log(`${source}: context is ${saved.lastContextTokens} tokens, compacting (${mode})`);
    // Bounded in time like every run (ceiling.ts): it runs inside the conversation's queue, and a hung one would block it.
    // It runs inside the conversation's queue, where a message may be waiting, so it never waits for a place in the run gate (rungate.ts) but takes one; the quiet one is started only when a place is free (wake.ts).
    await gated("chat", () => withCeiling(COMPACT_MAX_MINUTES * 60_000, async (c) => {
      let boundary: { pre_tokens: number; post_tokens?: number } | undefined;
      let lastError: string | undefined;
      for await (const message of query({ prompt: "/compact", options: { ...compactOptions(saved.sessionId, isolated, track === "chat" ? notesDir : undefined, payer, track), abortController: c.controller } })) {
        if (message.type === "system" && message.subtype === "compact_boundary") boundary = message.compact_metadata;
        observe(payer, message);
        if (message.type === "assistant" && message.error) lastError = message.error;
        if (message.type !== "result") continue;
        charge(payer, message.total_cost_usd - saved.costUsd, "compact");
        if (!boundary) {
          // A compaction that failed is reported like any other call on its payer (errors.ts failure: the cooldown, the owner's one notice about a refused instance key).
          const refused = failure(lastError, message.subtype, payer);
          throw isApiRefusal(refused) ? refused : new Error(`/compact produced no compact_boundary (${message.subtype})`);
        }
        if (!lastError) succeeded(payer);
        const { compactFailedAt: _cleared, untrustedIn: _held, ...rest } = saved;
        writeSession(conv, { ...rest, sessionId: message.session_id, costUsd: message.total_cost_usd, lastContextTokens: boundary.post_tokens, ...carriedTaint(saved, message.session_id) }, track); // (a compaction continues the session: its summary may still hold the untrusted text)
        forgetShown(conv, track); // the summary may have lost what the session was last told at the start of a turn (turncontext.ts)
        console.log(`${source}: compacted ${boundary.pre_tokens} -> ${boundary.post_tokens ?? "?"} tokens (${mode})`);
        emitRecord("chat_session", "compacted", source);
        return;
      }
      throw new Error("compaction stream ended without a result");
    }));
  } catch (e) {
    console.error(`${source}: compaction failed:`, (e as Error).message);
    emitRecord("chat_session", "compact-failed", source);
    writeSession(conv, { ...readSession(conv, track), compactFailedAt: new Date().toISOString() }, track);
  }
}

// Compaction of a conversation's sessions (the urgent one after a reply: its chat; the quiet one from the tick: either): like any call it asks payer.ts mayRun first, so a friend's runs on
// the instance key and is billed to her, and waits while she is blocked (the key in a cooldown, her day's budget spent), urgent or quiet. The owner's and a group's urgent
// one is never held back (somebody's next message waits for it); their quiet one stops with the pause switch, the cooldown and the budget.
export async function compactConversation(conv: Pick<Conversation, "kind" | "tenantId" | "convId" | "notesDir">, mode: "quiet" | "urgent", o: MayRunOptions = {}): Promise<void> {
  const payer = mayRun(conv, "compaction", { chat: mode === "urgent", ...o });
  if (isRefusal(payer)) return;
  for (const track of mode === "urgent" ? (["chat"] as const) : TRACKS) await compactChatIfNeeded(conv.convId, conv.kind, conv.notesDir, mode, payer, track);
}

// A conversation never starts fresh just because time passed: its recent history is kept across days and compaction keeps it small.
// The one exception is a session the SDK can no longer resume (expired or deleted): forget its id, so the next message starts a fresh
// one instead of failing the same way for ever. Returns whether it did.
export function forgetUnresumable(conv: ConvId, e: unknown, source: Source, track: Track = "chat"): boolean {
  if (!/no conversation found|session id.*not found|could not (resume|find) (the )?(session|conversation)/i.test((e as Error)?.message ?? "")) return false;
  const { sessionId: _gone, baseTokens: _base, lastContextTokens: _ctx, untrustedIn: _tainted, ...rest } = readSession(conv, track);
  writeSession(conv, { ...rest, costUsd: 0 }, track);
  console.error(`${source}: the saved session can no longer be resumed, the next message starts a fresh one`);
  emitRecord("chat_session", "unresumable-reset", source);
  return true;
}

// ---- the untrusted-input flag of a session ----
// A session that has read raw mail or a web page still holds that text in its context on every later turn, so the approval judge must be told "untrusted input in
// this run" from then on, not just in the turn that read it. The flag lives in the session record (ChatSession.untrustedIn, the id of the session) and follows the
// session: a fresh session starts clean (consume() carries it only for the session that held it), a compaction CONTINUES the session and its summary may still
// contain the text, so it stays set (compactChatIfNeeded carries it); it is cleared only when a new session starts (or the saved one can no longer be resumed).
export interface Taint {
  read(): boolean; // does the session this run continues, or this run itself, hold untrusted input?
  mark(): void; // this run has read some: kept in the record for the turns after it
}

export function sessionTaint(conv: ConvId | undefined, resume: string | undefined, track: Track = "chat"): Taint {
  let here = false; // this run
  return {
    read: () => here || (!!conv && !!resume && readSession(conv, track).untrustedIn === resume),
    mark: () => {
      here = true;
      if (conv) writeSession(conv, { ...readSession(conv, track), untrustedIn: resume ?? "pending" }, track); // (a fresh run does not know its session id yet: consume() fills it in)
    },
  };
}

// The flag of the session record after a turn that ended in session `id`: kept for the session that held it (or that this turn started and marked), dropped for any other.
export function carriedTaint(before: ChatSession, id: string): { untrustedIn?: string } {
  const held = before.untrustedIn;
  return held !== undefined && (held === "pending" || held === before.sessionId) ? { untrustedIn: id } : {};
}
