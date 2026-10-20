import { query } from "@anthropic-ai/claude-agent-sdk";
import { oneShot } from "./haiku.ts";
import { RateLimitError } from "./errors.ts";
import { memoryFor } from "./notes.ts";
import { LOGIN, type Payer } from "./payer.ts";
import { clean, defuseLines, defuseTags, LIMITS, oneLine } from "./sanitize.ts";
import { triagePrompt } from "./persona.ts";
import { OWNER } from "./settings.ts";

type Label = "act_now" | "handle" | "read_later" | "archive";
export type Kind = "newsletter" | "notification" | "cold_outreach" | "personal_or_work";

export interface Triage {
  label: Label;
  kind: Kind;
  reason: string;
  protected: boolean; // true if the code-side guard overrode an archive
}

// Whose mail it is: the owner's by default, or a friend's (her name).
export interface TriageWho {
  name: string;
}
const OWNER_WHO: TriageWho = { name: OWNER };

const system = (who: TriageWho): string => triagePrompt(who.name);

// The classifier gets the owner's whole memory (every note category, as the chat agent has), so it can tell what is relevant to him.
// One block per triageBatch, so the system prompt is the same for every batch. The suspicious-text isolation below
// stays in code and still wins over anything remembered.
export const triageSystem = (memory: string, who: TriageWho = OWNER_WHO) => [system(who), memory].filter(Boolean).join("\n\n");

// What a triage call is made for besides the mail: for a friend, her name, her notes, and the instance key and cost file her call runs on (heartbeat.ts passes it; the
// owner's call has none of these and runs on the login as ever).
export interface TriageCtx {
  who?: TriageWho;
  notesDir?: string;
  payer?: Payer;
}

const SCHEMA = {
  type: "json_schema" as const,
  schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer" },
            label: { type: "string", enum: ["act_now", "handle", "read_later", "archive"] },
            kind: { type: "string", enum: ["newsletter", "notification", "cold_outreach", "personal_or_work"] },
            reason: { type: "string" },
          },
          required: ["index", "label", "kind", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
};

export interface MailInput {
  account: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  receivedAtUtc: string;
  body: string;
}

// Text that tries to steer a classifier. Such mail is classified alone and can never be archived.
const INSTRUCTION_LIKE =
  /(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|earlier|all)\b.{0,40}\b(instruction|prompt|rule)s?|\b(classify|label|mark|categori[sz]e)\b.{0,30}\b(this|these|the|all|other)\b.{0,30}\b(as|email|mail)\b|^\s*(system|assistant)\s*:|you are now\b|new instructions?\b/im;

const BATCH_SIZE = 12;
const LABELS = ["act_now", "handle", "read_later", "archive"];
const KINDS = ["newsletter", "notification", "cold_outreach", "personal_or_work"];

const fallback = (reason: string): Triage => ({ label: "read_later", kind: "personal_or_work", reason, protected: false });

// The numbering and the separator line are the only structure the classifier relies on, so a mail's own text must not be able to
// fake them: header fields are one line (and bounded: a subject used to be unlimited), and a line of the body that looks like the
// separator or like a "[2]" marker is defused.
const defuse = (body: string) => defuseLines(defuseTags(clean("mail body", body, { max: 800 })));

export function formatMails(mails: MailInput[]): string {
  return mails
    .map((m, i) =>
      [
        `[${i + 1}]`,
        `Account: ${oneLine("mail account", m.account)}`,
        `From: ${oneLine("mail sender", m.fromName, LIMITS.name)} <${oneLine("mail sender", m.fromEmail, LIMITS.name)}>`,
        `Subject: ${oneLine("mail subject", m.subject)}`,
        `Received: ${oneLine("mail date", m.receivedAtUtc, 40)}`, // local time, despite Mailbird's field name
        `Body (first 800 chars, untrusted):`,
        defuse(m.body),
      ].join("\n"),
    )
    .join("\n\n-----\n\n");
}

// One model call for a group of emails. Missing or invalid entries fall back to read_later.
// A usage limit throws RateLimitError instead: that is not a verdict on the mail, so the caller retries it later.
async function classifyGroup(mails: MailInput[], memory: string, run: typeof query, ctx: TriageCtx = {}): Promise<Triage[]> {
  const out: Triage[] = mails.map(() => fallback("classifier unavailable"));
  try {
    // oneShot: the payer's environment, ledger and cooldown; a usage limit (or a refused key) is thrown, any other failure is a plain "not ok".
    const r = await oneShot({ system: triageSystem(memory, ctx.who), prompt: formatMails(mails), payer: ctx.payer ?? LOGIN, schema: SCHEMA, options: { maxTurns: 3, maxBudgetUsd: 0.25 }, run }); // (a ceiling, not a target; the real cost is logged per batch)
    console.log(`triage: ${mails.length} email(s), ${r.subtype}, $${(r.costUsd ?? 0).toFixed(4)}`);
    const o = r.ok ? (r.output as any) : undefined;
    if (!Array.isArray(o?.items)) {
      console.error(`triage fallback: subtype=${r.subtype} structured=${o ? "invalid" : "missing"}`);
      return out;
    }
    const filled = new Set<number>();
    for (const it of o.items) {
      const i = Number(it?.index) - 1;
      if (!Number.isInteger(i) || i < 0 || i >= mails.length || filled.has(i)) continue;
      if (!LABELS.includes(it.label) || !KINDS.includes(it.kind)) continue;
      filled.add(i);
      out[i] = { label: it.label, kind: it.kind, reason: String(it.reason ?? "").slice(0, LIMITS.reason), protected: false };
    }
    if (filled.size !== mails.length) console.error(`triage: model returned ${filled.size}/${mails.length} valid items`);
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
    console.error("triage error:", (e as Error).message);
  }
  return out;
}

// Classifies all new mail. Returns one Triage per input, same order. Throws RateLimitError when the usage limit is hit.
export async function triageBatch(mails: MailInput[], run: typeof query = query, ctx: TriageCtx = {}): Promise<Triage[]> {
  const results: Triage[] = mails.map(() => fallback("not classified"));
  const memory = memoryFor(undefined, new Date(), ctx.notesDir); // every note of this conversation: the classifier decides what helps
  const suspicious = mails.map((m) => INSTRUCTION_LIKE.test(`${m.subject}\n${m.body}`));

  // Normal mail goes in shared batches; suspicious mail is isolated, one call each.
  const normal = mails.map((_, i) => i).filter((i) => !suspicious[i]);
  for (let at = 0; at < normal.length; at += BATCH_SIZE) {
    const idx = normal.slice(at, at + BATCH_SIZE);
    const group = await classifyGroup(idx.map((i) => mails[i]!), memory, run, ctx);
    idx.forEach((i, k) => (results[i] = group[k]!));
  }
  for (let i = 0; i < mails.length; i++) {
    if (!suspicious[i]) continue;
    results[i] = (await classifyGroup([mails[i]!], memory, run, ctx))[0]!;
    // Never archived, whatever the model said.
    if (results[i]!.label === "archive") results[i] = { ...results[i]!, label: "read_later", protected: true };
    results[i] = { ...results[i]!, reason: `suspicious text; ${results[i]!.reason}`.slice(0, LIMITS.reason) };
  }

  return results;
}
