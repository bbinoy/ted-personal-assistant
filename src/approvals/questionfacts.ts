// The one cheap check on a model-written approval question: the facts that decide what will run
// must appear in it verbatim. No second model call. Pure.
//
// Required, taken from the exact arguments (and the code-rendered details, which for a mail send are read back from the mail client):
// every email address and URL in a structured field, ids, titles/subjects, the time zone, every start and end time (HH:MM) and
// date (D Mon), amounts, and the words Cc / Bcc when there are such recipients. The question may mention other addresses and URLs (the
// owner's own, the page's): the real ones must be in it, so an extra one cannot hide or replace a recipient. What this CANNOT check: what the question says about the action in words ("replace" vs "add",
// "send" vs "save a draft"), or whether it repeats a claim from the email body as fact. Those rest on the writer prompt.

// Free text (a message body, notes, page content): shown in the question as a summary, not required verbatim.
const LONG_TEXT = new Set(["body", "description", "message", "text", "content", "markdownBody", "new_str", "note", "prompt", "old_str"]);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
const AMOUNT = /\d[\d.,]*\s?(?:€|EUR|USD|GBP|CHF|\$|£)/g;
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ID_KEY = /(^id$|Id$|_id$)/;
const TITLE_KEYS = new Set(["summary", "title", "subject"]);

export interface Facts {
  must: string[]; // appear verbatim (case-insensitive for addresses and words)
  words: RegExp[]; // role words that must appear (Cc, Bcc)
}

function walk(v: unknown, key: string, f: (key: string, value: string | number) => void, depth = 0): void {
  if (depth > 6) return;
  if (typeof v === "string" || typeof v === "number") return f(key, v);
  if (Array.isArray(v)) return v.forEach((x) => walk(x, key, f, depth + 1));
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k, f, depth + 1);
}

const add = (xs: string[], x: string) => void (x && !xs.some((y) => y.toLowerCase() === x.toLowerCase()) && xs.push(x));
const trimUrl = (u: string) => u.replace(/[.,;:!?]+$/, "");

export function factsOf(args: Record<string, unknown>, details: string): Facts {
  const must: string[] = [];
  const words: RegExp[] = [];
  const roles = new Set<string>();
  let amounts = 0;
  walk(args, "", (key, value) => {
    const s = String(value);
    for (const m of s.matchAll(EMAIL)) {
      if (!LONG_TEXT.has(key)) add(must, m[0]);
    }
    for (const m of s.matchAll(URL_RE)) {
      if (!LONG_TEXT.has(key)) add(must, trimUrl(m[0]));
    }
    if (/^(cc|bcc)$/i.test(key) && s.trim()) roles.add(key.toLowerCase());
    if (ID_KEY.test(key) && key !== "calendarId" && s !== "primary" && s.length <= 80) add(must, s);
    if (TITLE_KEYS.has(key) && s.length <= 120 && s.trim()) add(must, s.trim());
    if (/^time_?zone$/i.test(key) && s) add(must, s);
    if (!LONG_TEXT.has(key)) {
      const t = ISO.exec(s);
      if (t) {
        add(must, `${Number(t[3])} ${MONTHS[Number(t[2]) - 1]}`);
        if (t[4] !== undefined) add(must, `${t[4]}:${t[5]}`);
      }
    }
    for (const m of s.matchAll(AMOUNT)) if (amounts++ < 5) add(must, m[0].trim());
  });
  // The details are ground truth for what code read back (a mail send's draft): their address lines count too.
  // A browse step after saved details were typed (browseguard.ts commitText): the site, each profile KEY, the masked tail of a sensitive
  // value and the page's total (when code found one) must be in the question. Values are never in the details, so they cannot be in it.
  if (details.includes("Profile fields filled in this run")) {
    const site = /^Site: (\S+)$/m.exec(details)?.[1];
    if (site) add(must, site);
    for (const line of details.split("\n")) {
      const p = /^• .+ ← ([a-z][a-z0-9._-]*): (.*)$/.exec(line);
      if (p) {
        add(must, p[1]!);
        const masked = /••••\S{4}/.exec(p[2]!)?.[0];
        if (masked) add(must, masked);
      }
      const t = /^Total \(read from the page[^)]*\): (.+)$/.exec(line)?.[1];
      if (t) add(must, t.trim());
    }
  }
  // A card payment (browseguard.ts payAsk): the shop, where the card is typed, the total with its currency, the card's last four digits, the
  // approval id and the typed YES it needs must be in the question, all read from the details code wrote. No card number is ever in them.
  if (details.includes("Card payment approval")) {
    for (const line of details.split("\n")) {
      const v = /^(Merchant|Card typed on|Approval id): (.+)$/.exec(line);
      if (v) for (const part of v[1] === "Card typed on" ? v[2]!.split(", ") : [v[2]!]) add(must, part.trim());
      const t = /^Total \(read from the page[^)]*\): (.+)$/.exec(line)?.[1];
      if (t) add(must, t.trim());
      const last4 = /^Card: .*••••(\d{4})/.exec(line)?.[1];
      if (last4) add(must, last4);
    }
    add(must, "YES");
  }
  // A call on an object by its id (describe.ts): the object's title must be in the question, not only its id.
  const named = /^Named: .*?“(.+?)”/m.exec(details)?.[1];
  if (named) add(must, named);
  // The call was declined a moment ago (declined.ts): the question must say how long ago, so the owner knows why they are asked again.
  const gone = /^The owner declined this action (\d+) minutes? ago\.$/m.exec(details)?.[1];
  if (gone) add(must, `${gone} min`);
  for (const line of details.split("\n")) {
    const h =/^(To|Cc|Bcc|With|Address|Where):\s*(.*)$/.exec(line);
    if (!h) continue;
    if (/^cc$/i.test(h[1]!) && h[2]!.trim()) roles.add("cc");
    if (/^bcc$/i.test(h[1]!) && h[2]!.trim()) roles.add("bcc");
    for (const m of h[2]!.matchAll(EMAIL)) add(must, m[0]);
    for (const m of h[2]!.matchAll(URL_RE)) add(must, trimUrl(m[0]));
  }
  if (roles.has("bcc")) words.push(/\bbcc\b|blind/i);
  if (roles.has("cc")) words.push(/\bcc\b|carbon/i);
  return { must, words };
}

// Undefined when the question carries every fact; else the first thing wrong (for the audit log).
export function validateQuestion(text: string, facts: Facts): string | undefined {
  const lower = text.toLowerCase();
  for (const m of facts.must) if (!lower.includes(m.toLowerCase())) return `missing "${m.slice(0, 80)}"`;
  for (const w of facts.words) if (!w.test(text)) return `does not say who is on ${w.source.includes("bcc") ? "Bcc" : "Cc"}`;
  return undefined;
}
