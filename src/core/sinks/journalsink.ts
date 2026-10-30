import { callKey } from "../callkey.ts";
import { convIdOfKey, convPaths } from "../convpaths.ts";
import { recordMessage } from "../messages.ts";
import { OWNER_KEY } from "../ownerkey.ts";
import { clip } from "../sanitize.ts";
import { settings } from "../settings.ts";
import { stepOf } from "../eventstep.ts";
import type { Event, Sink, Why } from "../events.ts";

// The journal sink: one readable line per ACTION in the log of the conversation it happened in (kind "journal", messages.ts), so the person can ask "what did you do today, and why?" and get
// the answer from what was recorded, not from the model's memory. Reads never get a line. A friend's lines are in HER log (her own words are fine there, never in the audit log), a group's in its own.
//
// A line is written when a call SUCCEEDED (the "done" event, from the SDK's PostToolUse), with the why the permission layer recorded when it let the call run (the "tool" event of the allow,
// auto-approved or approved step). So a call that was refused, declined, or failed after being allowed leaves no line: the journal says what was done, the audit log what was decided.

const ARM_TTL_MS = 30 * 60_000; // an allowed call that never reports success (it failed, the run ended) is forgotten after this
const MAX_ARMED = 50;
interface Armed {
  tool: string;
  keys: string[];
  why: Why;
  at: number;
}
const armed = new Map<string, Armed[]>(); // by conversation key and run: one run's why never attaches to another run's success
const slot = (conv: string, run: string | undefined): string => `${conv}\u0000${run ?? ""}`;

export const forgetArmed = (): void => armed.clear(); // tests
export const armedCount = (): number => [...armed.values()].reduce((n, l) => n + l.length, 0); // tests

/** A run is over: what it armed and never reported is dropped (the call failed or was never made). */
export function endRun(run: string): void {
  for (const k of [...armed.keys()]) if (k.endsWith(`\u0000${run}`)) armed.delete(k);
}

function arm(conv: string, run: string | undefined, tool: string, inputs: readonly Record<string, unknown>[], why: Why, now = Date.now()): void {
  const list = (armed.get(slot(conv, run)) ?? []).filter((a) => now - a.at < ARM_TTL_MS);
  list.push({ tool, keys: inputs.map((i) => callKey(tool, i)), why, at: now });
  armed.set(slot(conv, run), list.slice(-MAX_ARMED));
}

// The why recorded for this very call (same tool and arguments) in this run, else for the oldest allowed call of the same tool in the same run not yet reported (the owner edited the arguments, or code narrowed them).
function take(conv: string, run: string | undefined, tool: string, input: Record<string, unknown>, now = Date.now()): Why | undefined {
  const list = (armed.get(slot(conv, run)) ?? []).filter((a) => now - a.at < ARM_TTL_MS);
  const key = callKey(tool, input);
  const i = list.findIndex((a) => a.tool === tool && a.keys.includes(key));
  const j = i >= 0 ? i : list.findIndex((a) => a.tool === tool);
  const hit = j >= 0 ? list[j] : undefined;
  if (j >= 0) list.splice(j, 1);
  armed.set(slot(conv, run), list);
  return hit?.why;
}

// A journal line's timestamp is the moment it was written, made unique (two actions in one millisecond must not share a search reference, "#<ts>").
let lastStamp = 0;
const stamp = (): number => (lastStamp = Math.max(Date.now(), lastStamp + 1));

export interface JournalLine {
  conv: string; // the Conversation.key whose log it goes into
  cat: string;
  text: string;
}

const flat = (s: string, n: number): string => {
  const t = clip(s, 1_000_000).replace(/\b(Why|Undo)\s*:/gi, "$1 -"); // (controls, bidi and invisible characters out, one line; a mail subject cannot fake the Why: or Undo: part of a line)
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// Pure: the sentence of a journal line: what happened, why, and the undo where one exists. Third-party words (a subject, a title) are one line and clipped.
export function journalText(p: { what: string; why?: Why; undo?: string }): string {
  const stop = (s: string): string => (/[.!?…]$/.test(s) ? s : `${s}.`);
  return [
    stop(flat(p.what, 240)),
    p.why ? `Why: ${stop(flat(p.why.text, 200))}` : "",
    p.why?.reason ? `${settings.assistant}'s reason: “${flat(p.why.reason, 160)}”.` : "",
    p.undo ? `Undo: ${stop(flat(p.undo, 200))}` : "",
  ].filter(Boolean).join(" ");
}

const NO_WHY: Why = { text: "no reason was recorded for this call" };

// Pure (given the lookup of recorded whys): the journal lines an event stands for.
export function project(e: Event, why: (conv: string, run: string | undefined, tool: string, input: Record<string, unknown>) => Why | undefined = () => undefined): JournalLine[] {
  switch (e.type) {
    case "look":
      return e.unjournaled && e.conv !== undefined ? [{ conv: e.conv, cat: "other", text: journalText({ what: `Looked and took ${e.unjournaled} step${e.unjournaled === 1 ? "" : "s"} that leave no line of their own (browser steps or bookkeeping)`, why: { text: "a periodic look at your accounts, on its standing instructions" } }) }] : [];
    case "done": {
      if (e.conv === undefined) return [];
      const w = e.why ?? why(e.conv, e.run, e.tool, e.input);
      if (e.cat === "browse" && !w?.asked) return []; // the browser's every click and page is no action worth a line; a step somebody was asked about (or the judge) is
      return [{ conv: e.conv, cat: e.cat, text: journalText({ what: e.what, why: w ?? NO_WHY, undo: e.undo }) }];
    }
    case "dream":
      return e.result === "changed" && e.conv !== undefined ? [{ conv: e.conv, cat: "dream", text: journalText({ what: e.text ?? "Tidied my notes in the nightly dream", why: { text: "the nightly dream, which keeps notes up to date from what was said" }, undo: "say 'undo the dream'" }) }] : [];
    case "notice":
      if (e.conv === undefined) return [];
      if (e.state === "dropped") return [{ conv: e.conv, cat: "notice", text: journalText({ what: flat(e.text, 160), why: { text: "they were held overnight and are not sent as they were written; nothing here can say them again in today's words" } }) }];
      return e.state === "held" ? [{ conv: e.conv, cat: "notice", text: journalText({ what: `Held a message for later: ${flat(e.text, 160)}`, why: { text: "quiet hours or today's limit of unprompted messages" } }) }] : [];
    case "expired":
      return e.conv !== undefined ? [{ conv: e.conv, cat: "approval", text: journalText({ what: `Asked about ${flat(e.label, 160)}; no answer within ${e.wait}, so nothing was done`, why: { text: "a question nobody answered lapses on its own, without a message" } }) }] : [];
    case "payment":
      return e.conv !== undefined ? [{ conv: e.conv, cat: "payment", text: journalText({ what: `Card payment ${e.status}: ${e.text}` }) }] : [];
    case "removal":
      return [{ conv: OWNER_KEY, cat: "removal", text: journalText({ what: e.text, why: { text: "you asked for it" } }) }]; // (the removed conversation's own log goes with it: the record is the owner's)
    case "task":
      return e.conv !== undefined && !e.viaTool ? [{ conv: e.conv, cat: "task", text: journalText({ what: e.text, why: e.why ?? NO_WHY }) }] : []; // (a tool call's line is its `done` event's, which has the run's why)
    case "triage":
      return e.conv !== undefined ? [{ conv: e.conv, cat: "triage", text: journalText({ what: e.what, why: { text: e.why } }) }] : [];
    default:
      return [];
  }
}

// Which steps let a call run: the ones whose why the journal keeps for the success.
const LETS_RUN = new Set(["allow", "auto-approved", "approved"]);

export const journalSink: Sink = {
  name: "journal",
  handle(e) {
    if (e.type === "tool") {
      const step = stepOf(e.decision);
      if (e.call && e.why && step && LETS_RUN.has(step)) arm(e.conv ?? OWNER_KEY, e.run, e.tool, e.call.final ? [e.call.input, e.call.final] : [e.call.input], e.why);
      return;
    }
    for (const l of project(e, take)) recordMessage("journal", stamp(), l.text, new Date(), convPaths(convIdOfKey(l.conv)).messages, { cat: l.cat });
  },
};
