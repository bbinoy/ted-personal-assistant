import { oneShot } from "../tenants/haiku.ts";
import { LOGIN } from "../tenants/payer.ts";
import { fence } from "../core/fence.ts";
import { SUMMARY_WORDS, type Sent, type Summarize } from "../core/messages.ts";
import { summarySystem } from "../run/persona.ts";
import { OWNER } from "../core/settings.ts";
import { LIMITS } from "../core/sanitize.ts";

// The small model that folds old messages into the log's one-line summary (messages.ts).

// A fold is ~30% of the log (messages.ts): at 1 MB about 750 messages. This keeps all of them in view (~75k tokens, well inside Haiku's window).
const MAX_INPUT_CHARS = 300_000;

const summaryPrompt = (previous: string | undefined, old: readonly Sent[], words: number): string =>
  [
    `Summarize in at most ${words} words. ${OWNER} is the owner.`,
    previous ? `Previous summary:\n${fence("previous_summary", previous)}` : "",
    `Messages now folded in (oldest first):\n${fence("messages", old.map((m) => `[${m.at.slice(0, 16)} ${m.kind}] ${m.text.slice(0, LIMITS.preview).replace(/\s+/g, " ")}`).join("\n").slice(0, MAX_INPUT_CHARS))}`,
  ]
    .filter(Boolean)
    .join("\n\n");

export const summarizeWithHaiku: Summarize = async (previous, old) => {
  const r = await oneShot({ system: summarySystem(), prompt: summaryPrompt(previous?.text, old, SUMMARY_WORDS), payer: LOGIN, options: { maxTurns: 1, maxBudgetUsd: 0.05 } });
  if (!r.ok || !r.text.trim()) throw new Error("no summary returned");
  return r.text;
};
