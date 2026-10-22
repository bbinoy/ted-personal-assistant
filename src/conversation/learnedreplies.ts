import { forgetNote } from "../memory/notes.ts";
import { confirmInferredNote } from "../memory/inferred.ts";
import { memoryNoticeText } from "../memory/memorynotice.ts";
import { emitRecord } from "../core/events.ts";
import { askOf, batchFor, isGroupConv, isStillInferred, settleChange } from "../memory/learned.ts";
import type { Conversation, Held } from "./conversationmodel.ts";

// Answering the "🧠 Learned overnight" list (memory/learned.ts), in code, before any model: "confirm 2" turns inferred note 2 into a confirmed one (announced like any note change, with its undo
// line, memorynotice.ts); "undo 2" takes the change back: an inferred note is the assistant's own guess and is simply forgotten; a change the nightly dream made can only be undone with the whole night
// (the dream's snapshot is per run), so the reply says so and points at "undo the dream" rather than guess. The numbers belong to a list: the one a reply QUOTES (a friend's message), else the latest
// one told in the last day or two (the brief's section, which has no message of its own). A bare "undo" is ambiguous, so it asks, but only straight after a list or when it quotes one; anywhere else
// it is an ordinary message (the model's undo_dream and forget_note do the rest). A group has no list. true: handled here.

const WITHIN_MS = 48 * 3_600_000; // the brief's list: a reply still counts for two days
const RIGHT_AFTER_MS = 15 * 60_000; // a bare "undo" with no quote is only taken to be about the list for this long
const CMD = /^\s*(undo|confirm)\s+#?(\d{1,2}(?:\s*(?:,|and|&|\+)?\s*#?\d{1,2})*)\s*[.!]?\s*$/i;
const BARE = /^\s*(undo|confirm)\s*[.!]?\s*$/i;

export type LearnedSay = (text: string) => Promise<unknown>;

/** Pure: "undo 2", "confirm 1 and 3", "undo #1, 2" -> the verb and the numbers; a bare verb -> no numbers; anything else undefined. */
export function parseLearned(text: string): { verb: "undo" | "confirm"; nums: number[] } | undefined {
  const m = CMD.exec(text);
  if (m) return { verb: m[1]!.toLowerCase() as "undo" | "confirm", nums: [...new Set([...m[2]!.matchAll(/\d+/g)].map((x) => Number(x[0])))] };
  const b = BARE.exec(text);
  return b ? { verb: b[1]!.toLowerCase() as "undo" | "confirm", nums: [] } : undefined;
}

export async function learnedReply(conv: Pick<Conversation, "kind" | "convId" | "notesDir">, m: Pick<Held, "text" | "quote" | "picture" | "document" | "edit">, say: LearnedSay, now = Date.now()): Promise<boolean> {
  if (conv.kind === "group" || isGroupConv(conv.convId) || m.picture || m.document || m.edit) return false;
  const cmd = parseLearned(m.text);
  if (!cmd) return false;
  const ts = m.quote && m.quote.timestamp !== 0 ? m.quote.timestamp : undefined;
  const batch = batchFor(conv.convId, ts, now, cmd.nums.length ? WITHIN_MS : RIGHT_AFTER_MS);
  if (!batch) return false; // no list it could be about (or a quote of some other message): an ordinary message
  if (!cmd.nums.length) {
    await say(`${cmd.verb === "undo" ? "Undo" : "Confirm"} which one? Say e.g. '${cmd.verb} 1'. Nothing was done.`);
    return true;
  }
  const out: string[] = [];
  const notice: string[] = [];
  let dreamNote = false;
  for (const n of cmd.nums) {
    const a = askOf(conv.convId, batch.id, n);
    if (!a) {
      out.push(`#${n} is not on that list.`);
      continue;
    }
    const c = a.change;
    const label = `${n}. ${c.file.replace(/\.md$/, "")}`;
    if (c.outcome) {
      out.push(`${label} was already ${c.outcome === "gone" ? "settled" : c.outcome}.`);
      continue;
    }
    if (cmd.verb === "confirm") {
      if (c.source !== "inferred" && !isStillInferred(conv.notesDir, c.file)) {
        out.push(`${label} is already part of your notes; nothing to confirm.`);
        continue;
      }
      const r = confirmInferredNote(c.file, conv.notesDir, new Date(now));
      if (!r.ok) {
        out.push(`${label}: ${r.error}.`);
        continue;
      }
      settleChange(conv.convId, c.seq, "confirmed");
      emitRecord("memory_note", "confirmed", "chat", { file: c.file.slice(0, 80) });
      notice.push(`✅ confirmed ${c.file}: ${r.gist}`);
      continue;
    }
    if (c.source === "inferred") {
      if (!isStillInferred(conv.notesDir, c.file)) {
        out.push(`${label} is not a guess of mine any more (you confirmed it, or it is gone); tell me to forget it if you want it removed.`);
        continue;
      }
      const r = forgetNote(c.file, conv.notesDir);
      if (!r.ok) {
        out.push(`${label}: ${r.error}`);
        continue;
      }
      settleChange(conv.convId, c.seq, "undone");
      emitRecord("memory_note", "inferred-undone", "chat", { file: c.file.slice(0, 80) });
      out.push(`🗑 Forgot ${c.file.replace(/\.md$/, "")} (it was my own guess).`);
      continue;
    }
    dreamNote = true;
    out.push(`${label} came from the nightly dream.`);
  }
  if (dreamNote) out.push("The dream can only be undone as a whole night (it puts every note back as it was before it ran). Say 'undo the dream' if you want that.");
  if (notice.length) await say(memoryNoticeText(notice));
  if (out.length) await say(out.join("\n"));
  return true;
}
