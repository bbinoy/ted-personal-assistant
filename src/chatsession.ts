import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { audit, type Source } from "./audit.ts";
import { withCeiling } from "./ceiling.ts";
import { failure, isApiRefusal } from "./errors.ts";
import type { Conversation } from "./conversationmodel.ts";
import { charge, envFor, isRefusal, LOGIN, mayRun, observe, succeeded, type MayRunOptions, type Payer } from "./payer.ts";
import { OWNER_SESSION_FILE, planSession, type ChatSession, type CompactMode } from "./session.ts";
import { settings } from "./settings.ts";
import { readJson, writeJson } from "./state.ts";

// Every conversation (the owner's chat, each group) persists across restarts, with the hygiene rules in
// session.ts (fresh after idle, compacted when large). total_cost_usd is cumulative across a resumed
// session, so we keep the running total and report each turn's delta. The owner's session pointer is
// state/session.json; a group's is session.json in its own folder (conversation.ts).

export interface Resume {
  resume?: string; // session to continue (chat only)
  previousCost: number; // total_cost_usd is cumulative across a resumed session
  seenAt?: string;
}

const chatPlanOpts = (mode: CompactMode) => ({ compactTokens: settings.chatCompactTokens, compactGrowth: settings.chatCompactGrowthTokens, quietMinutes: settings.compactQuietMinutes, mode });

// A conversation continues its saved session unless session.ts says to start fresh.
export function chatResume(file: string = OWNER_SESSION_FILE): Resume {
  const saved = readJson<ChatSession>(file, { costUsd: 0 });
  // A fresh session starts its cost total at zero, so the previous total must not be subtracted.
  if (planSession(saved, new Date(), chatPlanOpts("off")) === "fresh") return { previousCost: 0 };
  return { resume: saved.sessionId, previousCost: saved.costUsd, seenAt: saved.seenAt };
}

// The options of the /compact run. A group's session was built under the group's isolation (buildOptions: no user settings,
// no connectors, only the tools and shared skills of its capabilities, auto-memory = its own notes folder), and its compaction must load nothing more than
// that: it is the same session, resumed. The owner's compaction is unchanged.
export function compactOptions(sessionId: string | undefined, source: Source, notesDir?: string, payer: Payer = LOGIN): Options {
  const isolated = source === "group";
  return {
    model: settings.model,
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

// Is a quiet-time compaction due for this session? A cheap read of the session file, for the heartbeat to ask before it queues anything.
export function compactDue(file: string = OWNER_SESSION_FILE, now: Date = new Date()): boolean {
  return planSession(readJson<ChatSession>(file, { costUsd: 0 }), now, chatPlanOpts("quiet")) === "resume then compact";
}

// Compact a conversation's session (`file`) in place by sending the SDK's own /compact command on the resumed session, if
// session.ts says so for this `mode`: "urgent" right after a reply that left the context far past the limit (the caller waits),
// "quiet" from the heartbeat once the conversation has been still for COMPACT_QUIET_MINUTES. Always called from the conversation's
// serial queue, so a message that arrives meanwhile waits behind it and nothing else touches the file. Never throws.
export async function compactChatIfNeeded(file: string = OWNER_SESSION_FILE, source: Source = "chat", notesDir?: string, mode: "quiet" | "urgent" = "urgent", payer: Payer = LOGIN): Promise<void> {
  try {
    const saved = readJson<ChatSession>(file, { costUsd: 0 });
    if (planSession(saved, new Date(), chatPlanOpts(mode)) !== "resume then compact") return;
    console.log(`${source}: context is ${saved.lastContextTokens} tokens, compacting (${mode})`);
    // Bounded in time like every run (ceiling.ts): it runs inside the conversation's queue, and a hung one would block it.
    await withCeiling(settings.compactMaxMinutes * 60_000, async (c) => {
      let boundary: { pre_tokens: number; post_tokens?: number } | undefined;
      let lastError: string | undefined;
      for await (const message of query({ prompt: "/compact", options: { ...compactOptions(saved.sessionId, source, notesDir, payer), abortController: c.controller } })) {
        if (message.type === "system" && message.subtype === "compact_boundary") boundary = message.compact_metadata;
        observe(payer, message);
        if (message.type === "assistant" && message.error) lastError = message.error;
        if (message.type !== "result") continue;
        charge(payer, message.total_cost_usd - saved.costUsd);
        if (!boundary) {
          // A compaction that failed is reported like any other call on its payer (errors.ts failure: the cooldown, the owner's one notice about a refused instance key).
          const refused = failure(lastError, message.subtype, payer);
          throw isApiRefusal(refused) ? refused : new Error(`/compact produced no compact_boundary (${message.subtype})`);
        }
        if (!lastError) succeeded(payer);
        const { compactFailedAt: _cleared, ...rest } = saved;
        writeJson(file, { ...rest, sessionId: message.session_id, costUsd: message.total_cost_usd, lastContextTokens: boundary.post_tokens });
        console.log(`${source}: compacted ${boundary.pre_tokens} -> ${boundary.post_tokens ?? "?"} tokens (${mode})`);
        audit("chat_session", "compacted", source);
        return;
      }
      throw new Error("compaction stream ended without a result");
    });
  } catch (e) {
    console.error(`${source}: compaction failed:`, (e as Error).message);
    audit("chat_session", "compact-failed", source);
    writeJson(file, { ...readJson<ChatSession>(file, { costUsd: 0 }), compactFailedAt: new Date().toISOString() });
  }
}

// Compaction of a conversation's session (the urgent one after a reply, the quiet one from the tick): like any call it asks payer.ts mayRun first, so a friend's runs on
// the instance key and is billed to her, and waits while she is blocked (the key in a cooldown, her day's budget spent), urgent or quiet. The owner's and a group's urgent
// one is never held back (somebody's next message waits for it); their quiet one stops with the pause switch, the cooldown and the budget.
export async function compactConversation(conv: Pick<Conversation, "kind" | "tenantId" | "sessionFile" | "source" | "notesDir">, mode: "quiet" | "urgent", o: MayRunOptions = {}): Promise<void> {
  const payer = mayRun(conv, "compaction", { chat: mode === "urgent", ...o });
  if (!isRefusal(payer)) await compactChatIfNeeded(conv.sessionFile, conv.source, conv.notesDir, mode, payer);
}

// A conversation never starts fresh just because time passed: its recent history is kept across days and compaction keeps it small.
// The one exception is a session the SDK can no longer resume (expired or deleted): forget its id, so the next message starts a fresh
// one instead of failing the same way for ever. Returns whether it did.
export function forgetUnresumable(file: string, e: unknown, source: Source): boolean {
  if (!/no conversation found|session id.*not found|could not (resume|find) (the )?(session|conversation)/i.test((e as Error)?.message ?? "")) return false;
  const { sessionId: _gone, baseTokens: _base, lastContextTokens: _ctx, ...rest } = readJson<ChatSession>(file, { costUsd: 0 });
  writeJson(file, { ...rest, costUsd: 0 });
  console.error(`${source}: the saved session can no longer be resumed, the next message starts a fresh one`);
  audit("chat_session", "unresumable-reset", source);
  return true;
}
