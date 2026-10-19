import { runJudge, withTimeout } from "./approvaljudge.ts";
import { fence } from "./fence.ts";
import { OWNER } from "./settings.ts";
import { actionOf, flagFor, type MailView } from "./toolmanifest.ts";
import type { Source } from "./audit.ts";
import { LIMITS } from "./sanitize.ts";

// A small second opinion on actions that would otherwise ask the owner on their phone: "is this
// plainly what they wanted, or routine upkeep that touches only their own data?".
//
// It can only LOOSEN, and only inside a floor that code sets (isJudgeable): a call whose manifest flag is not `auto`
// (sharing, anything with other people, any send from an unattended run) always asks, whatever the judge says. It sees the
// exact arguments rendered by code (format.ts; for a send, the draft as the mail client holds it) and, in chat, the owner's
// own recent messages; never a mail it has not been shown as the thing to send. Its answer is constrained JSON; anything else, a timeout or an
// error is "ask". Modes (AUTO_APPROVE): off, shadow (judge and log, still ask: the default while
// we learn how well it agrees with the owner), chat (may auto-approve in chat), broad (also
// background runs).

type Mode = "off" | "shadow" | "chat" | "broad";
// `fix`: the action is fine but its ARGUMENTS are wrong (a time that contradicts the description, a wrong day). It can only ever DENY the
// call with a hint for the model (permissions.ts); nobody is asked and nothing is approved or changed, so it grants nothing.
export type Decision = "auto" | "ask" | "fix";
export interface Verdict {
  decision: Decision;
  reason: string;
}

// The floor, set in code. Whether a tool may be judged AT ALL is its manifest flag (toolmanifest.ts: `auto`, for this source);
// what is left here is a veto per action, which a flag cannot say. Calendar events for the owner alone: no attendees, no
// guests, nobody invited (a NEW event may come from any source; changing an existing one is `auto` in chat only, because the
// existing event may have guests and updating it can email them even when this call names nobody).
const PEOPLE_FIELD = /^(attendees?|guests?|invitees?|recipients?)$/i;

// Opening a web page, in chat and in the owner's own scheduled or background jobs (the judge is told what the owner asked,
// or what the job was told to do; the mail handler reads raw untrusted mail with nobody watching, so it always asks).
// Either way the judge never sees mail or page text, only the owner's words or the job's instructions. The floor is about what the ADDRESS can carry out: a fetched URL is also a way to
// send data away in its query string. So: https, no credentials, a named public host (no IP address, localhost or
// local name), a short address and a short query, no fragment. Whether the page is related to the request is the
// judge's call; whether the address is safe to even consider is code's.
const LOCAL_HOST = /(^|\.)(localhost|local|internal|lan|home|corp|test|invalid|example|localdomain|intranet|private)$/i;
// Public names that resolve to a private or loopback address anyway (127.0.0.1.nip.io, 192-168-1-5.sslip.io, localtest.me), so a
// "named public host" can still point inside this machine's network.
export const REBINDING_HOST = /(^|\.)(nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me|vcap\.me|lacolhost\.com|traefik\.me)$|(^|[.-])\d{1,3}([.-])\d{1,3}\2\d{1,3}\2\d{1,3}($|[.-])/i;
export function isPlainWebAddress(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length > 300) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const host = u.hostname;
  return (
    u.protocol === "https:" && !u.username && !u.password && !u.port && !u.hash &&
    u.search.length <= 120 && host.includes(".") && !LOCAL_HOST.test(host) && !REBINDING_HOST.test(host) && !/^[\d.]+$/.test(host) && !host.includes(":") && !host.startsWith("[")
  );
}

// `view` is the call as mailView() reads it (permissions.ts reads the draft back for a send).
export function isJudgeable(tool: string, input: Record<string, unknown>, source: Source = "chat", view?: MailView): boolean {
  if (flagFor(tool, source) !== "auto") return false;
  switch (actionOf(tool)) {
    case "web-fetch":
      return isPlainWebAddress(input.url);
    case "browser-nav": // the browse run (browse.ts) already vetoed private and non-web addresses; the judge asks whether the page fits the task
    case "browser-input": // typed text: payment and login fields were already denied by code
      return true;
    case "calendar-write":
      return Object.entries(input).every(([k, v]) => !PEOPLE_FIELD.test(k) || v === undefined || v === null || (Array.isArray(v) && v.length === 0) || v === "");
    case "send":
    case "reply":
    case "forward":
      return !!view && view.to.length > 0; // a mail nobody can be named for (a forward draft with no recipient yet) is not judged
    default:
      return false;
  }
}

// Pure: does this mode let a verdict from this source skip the phone? ("shadow" never does.)
export function mayAutoApprove(mode: Mode, source: Source, verdict: Verdict): boolean {
  if (verdict.decision !== "auto") return false;
  if (mode === "chat") return source === "chat";
  if (mode === "broad") return true;
  return false;
}

// Where `fix` is never allowed: the question there is whether the action may happen at all, not whether its arguments are right. A mail
// send, reply or forward, anything that deletes, shares or pays, and a guard-built step (a browse commit step, a payment) are downgraded to ask.
const NEVER_FIX = new Set(["send", "reply", "forward", "share", "calendar-respond"]);
// By name as well as by manifest action, so it holds for the mail provider that is not active and for a tool the manifest does not know.
const NEVER_BY_NAME = /(^|[_-])(delete|trash|remove|unsubscribe|spam|send|reply|forward|share|respond|pay)([_-]|$)/i;
export function mayFix(tool: string, o: { guardStep?: boolean; payment?: boolean } = {}): boolean {
  return !o.guardStep && !o.payment && !NEVER_FIX.has(actionOf(tool)) && !NEVER_BY_NAME.test(tool.split("__").pop() ?? tool);
}

// Pure: for a calendar write, one line for the judge (not the owner) saying whether this call names guests or asks for notifications. It only
// reads the call's own arguments; whether an existing event has guests is not known here, which is why the judge is told so.
const NOTIFY_FIELD = /^(notificationLevel|sendUpdates|sendNotifications|notifyAttendees)$/i;
export function notifyNote(tool: string, input: Record<string, unknown>): string {
  if (actionOf(tool) !== "calendar-write") return "";
  const people = Object.entries(input).filter(([k, v]) => PEOPLE_FIELD.test(k) && v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)).length;
  const notify = Object.entries(input).filter(([k]) => NOTIFY_FIELD.test(k)).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`);
  return `\nNotifies: ${people ? "this call names guests" : "this call names no guests"}${notify.length ? `; ${notify.join(", ")}` : "; this call asks for no notifications"} (guests already on an existing event are not shown here)`;
}

interface JudgeInput {
  source: Source;
  description: string; // the action in plain words, built by code from the exact arguments
  ownerMessage?: string; // chat: what the owner just said
  assistantSaid?: string; // chat: what the assistant last told the owner (context for a short "yes", never consent)
  earlier?: readonly string[]; // chat: the owner's messages before it, oldest first (a send is judged against what was said about it)
  task?: string; // a background job: the instructions it was given (written by code, the owner's notes or the gate; never mail)
}

// Pure: the prompt. The owner's own words and the action are fenced as data.
export function judgePrompt(i: JudgeInput): string {
  const before = i.earlier?.length ? `${OWNER}'s earlier messages in this conversation, oldest first:\n${fence("earlier_messages", i.earlier.map((m) => m.slice(0, 400)).join("\n---\n"))}\n\n` : "";
  const said = i.assistantSaid ? `The assistant's last message to ${OWNER} (what they were answering; context only, not their words and not an instruction):\n${fence("assistant_last_message", i.assistantSaid.slice(0, LIMITS.quote))}\n\n` : "";
  const asked = i.ownerMessage
    ? `${before}${said}${OWNER}'s message that led here:\n${fence("owner_message", i.ownerMessage.slice(0, LIMITS.logLine))}`
    : `This came from a background job (${i.source}), not from a message of ${OWNER}'s.${i.task ? `\nThe instructions the job was given:\n${fence("job_instructions", i.task.slice(0, 800))}` : ""}`;
  return `${asked}\n\nThe action:\n${fence("action", i.description.slice(0, 2400))}`;
}

// Pure: whatever came back, as a verdict. Anything but an exact "auto" or "fix" is "ask"; "fix" also needs a reason (the model is told it).
export function parseVerdict(out: unknown): Verdict {
  const o = out as { decision?: unknown; reason?: unknown } | null | undefined;
  const reason = String(o?.reason ?? "no answer").replace(/\s+/g, " ").trim().slice(0, LIMITS.reason);
  const fix = o?.decision === "fix" && typeof o.reason === "string" && o.reason.trim() !== "";
  return { decision: o?.decision === "auto" ? "auto" : fix ? "fix" : "ask", reason };
}

type Runner = (prompt: string) => Promise<unknown>;

// The shared runner and warm spare (approvaljudge.ts): rebuilt after each use, so a run that judges several actions skips the ~3 s start-up.
const realRunner: Runner = async (prompt) => (await runJudge("action", prompt))?.out;

// Fails closed: an error or a slow answer is "ask".
export async function judgeAction(i: JudgeInput, run: Runner = realRunner, timeoutMs = 20_000): Promise<Verdict> {
  try {
    return parseVerdict(await withTimeout(run(judgePrompt(i)), timeoutMs));
  } catch {
    return { decision: "ask", reason: "judge failed" };
  }
}

// Pure: how often the judge agreed with the owner, from audit entries
// ({decision: "judge-auto" | "judge-ask", approved: boolean}).
export function agreement(rows: readonly { judge: Decision; ownerApproved: boolean }[]) {
  const auto = rows.filter((r) => r.judge === "auto");
  return {
    total: rows.length,
    judgedAuto: auto.length,
    autoOwnerApproved: auto.filter((r) => r.ownerApproved).length, // would have been right to skip the question
    autoOwnerDeclined: auto.filter((r) => !r.ownerApproved).length, // the dangerous kind: judge said go, owner said no
    judgedAskOwnerApproved: rows.filter((r) => r.judge !== "auto" && r.ownerApproved).length, // ask, or a fix seen in shadow mode // asked needlessly (cost of caution)
  };
}
