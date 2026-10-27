import { convDb, peekConvDb } from "../core/convdb.ts";
import type { ConvRef } from "../core/convpaths.ts";
import type { ChatSession } from "./session.ts";

// The conversation's resumed-session pointers, cost and taint: the `session` row of its assistant.db (core/convdb.ts), which replaced session.json, and the `look_session` row beside it. A conversation has
// two sessions, one per `track`: its chat (the messages, on the chat model) and its looks (the background checks, on the look model); they never mix. Whole-record reads and writes, like the file
// was: a caller reads the record, changes it, writes it back (the pipeline runs one turn of a conversation at a time). No row = a fresh session: { costUsd: 0 }.
export type Track = "chat" | "look";
const TABLES: Record<Track, string> = { chat: "session", look: "look_session" };

interface Row {
  session_id: string | null;
  cost_usd: number;
  last_turn_at: string | null;
  last_context_tokens: number | null;
  compact_failed_at: string | null;
  base_tokens: number | null;
  seen_at: string | null;
  untrusted_in: string | null;
}

export function readSession(conv: ConvRef, track: Track = "chat"): ChatSession {
  const r = peekConvDb(conv)?.get<Row>(`SELECT session_id, cost_usd, last_turn_at, last_context_tokens, compact_failed_at, base_tokens, seen_at, untrusted_in FROM ${TABLES[track]} WHERE id = 1`);
  if (!r) return { costUsd: 0 };
  return {
    ...(r.session_id !== null ? { sessionId: r.session_id } : {}),
    costUsd: r.cost_usd,
    ...(r.last_turn_at !== null ? { lastTurnAt: r.last_turn_at } : {}),
    ...(r.last_context_tokens !== null ? { lastContextTokens: r.last_context_tokens } : {}),
    ...(r.compact_failed_at !== null ? { compactFailedAt: r.compact_failed_at } : {}),
    ...(r.base_tokens !== null ? { baseTokens: r.base_tokens } : {}),
    ...(r.seen_at !== null ? { seenAt: r.seen_at } : {}),
    ...(r.untrusted_in !== null ? { untrustedIn: r.untrusted_in } : {}),
  };
}

const n = (v: number | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function writeSession(conv: ConvRef, s: ChatSession, track: Track = "chat"): void {
  convDb(conv).run(
    `INSERT INTO ${TABLES[track]} (id, session_id, cost_usd, last_turn_at, last_context_tokens, compact_failed_at, base_tokens, seen_at, untrusted_in) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET session_id = excluded.session_id, cost_usd = excluded.cost_usd, last_turn_at = excluded.last_turn_at, last_context_tokens = excluded.last_context_tokens,
       compact_failed_at = excluded.compact_failed_at, base_tokens = excluded.base_tokens, seen_at = excluded.seen_at, untrusted_in = excluded.untrusted_in`,
    s.sessionId ?? null, n(s.costUsd) ?? 0, s.lastTurnAt ?? null, n(s.lastContextTokens), s.compactFailedAt ?? null, n(s.baseTokens), s.seenAt ?? null, s.untrustedIn ?? null,
  );
}
