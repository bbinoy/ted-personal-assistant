// Reading a numbered answer to the approval inbox ("1,3 yes", "all yes", "2 no", "yes to 1 and 3", "1 yes 2 no"), in CODE, with no model. Pure.
// The grammar is deliberately small. A message is an answer only when EVERY word of it belongs to the vocabulary (numbers, "all", yes/no words and a few fillers): anything
// else ("2 no wait, what about Thursday") is a normal message, or, quoted, a free-text reply for the answer model. Inside the vocabulary the shape must be exact:
//   subject-first   (numbers|all)+ verb, repeated      "1,3 yes"   "all no"   "1 yes 2 no"
//   verb-first      verb (numbers|all)+, repeated      "yes to 1 and 3"   "no 2"   "approve all"
// A number twice with opposite verbs, a number that is not open, a verb with no subject or a mix of the two shapes resolves NOTHING and gets a short clarification.

export type Parsed =
  | { kind: "none" } // not an answer: an ordinary message
  | { kind: "bare"; yes: boolean } // a lone yes / no: it answers a batch only when the message quotes it and exactly one item is open (decided by the caller)
  | { kind: "answer"; yes: number[]; no: number[] }
  | { kind: "clarify"; why: string };

const YES = new Set(["yes", "y", "yep", "yeah", "yup", "ok", "okay", "k", "sure", "approve", "approved", "confirm", "do", "👍", "✅"]);
const NO = new Set(["no", "n", "nope", "nah", "deny", "denied", "decline", "reject", "skip", "drop", "cancel", "👎", "❌"]);
const FILLER = new Set(["to", "for", "on", "and", "please", "pls", "item", "items", "number", "numbers", "nr", "the", "ones", "just", "it", "them", "those", "these", "all", "of", "both", "is", "are"]);

type Tok = { t: "num"; n: number } | { t: "all" } | { t: "yes" } | { t: "no" };

// Words and numbers; "1,3" "1 & 3" "#1" "1-3" are numbers. Returns undefined when any word is outside the vocabulary.
function tokens(text: string): Tok[] | undefined {
  const flat = text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/(\d)\s*[-–]\s*(\d)/g, "$1 to_ $2") // a range, expanded below
    .replace(/[.,!?;:&/()+#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return undefined;
  const out: Tok[] = [];
  const words = flat.split(" ");
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (/^\d{1,3}$/.test(w)) {
      const n = Number(w);
      if (words[i + 1] === "to_" && /^\d{1,3}$/.test(words[i + 2] ?? "")) {
        const m = Number(words[i + 2]);
        if (m < n || m - n > 50) return undefined;
        for (let k = n; k <= m; k++) out.push({ t: "num", n: k });
        i += 2;
        continue;
      }
      out.push({ t: "num", n });
    } else if (w === "all" || w === "everything") out.push({ t: "all" });
    else if (YES.has(w)) out.push({ t: "yes" });
    else if (NO.has(w)) out.push({ t: "no" });
    else if (FILLER.has(w)) continue;
    else return undefined;
  }
  return out;
}

const CLARIFY = "I could not tell which ones you mean. Say e.g. '1,3 yes', 'all yes' or '2 no'; nothing was done.";

// `open`: the numbers that exist; `all`: what the word "all" stands for (the items the owner was shown, or the batch her reply quotes: never more than that). A message that is not an answer is { kind: "none" }.
export function parseNumbered(text: string, open: readonly number[], all: readonly number[] = open): Parsed {
  const toks = tokens(text);
  if (!toks || toks.length === 0) return { kind: "none" };
  const verbs = toks.filter((t) => t.t === "yes" || t.t === "no").length;
  const subjects = toks.filter((t) => t.t === "num" || t.t === "all").length;
  if (verbs === 0) return { kind: "none" }; // numbers alone ("3") are a number in a chat
  if (subjects === 0) return verbs === 1 && toks.length === 1 ? { kind: "bare", yes: toks[0]!.t === "yes" } : { kind: "none" };
  // Group into (subjects, verb) clauses, subject-first or verb-first, never mixed.
  const clauses: { subjects: Tok[]; yes: boolean }[] = [];
  const subjectFirst = toks[0]!.t === "num" || toks[0]!.t === "all";
  let cur: Tok[] = [];
  let verbSeen: boolean | undefined; // verb-first: the verb of the clause being filled
  for (const t of toks) {
    const isVerb = t.t === "yes" || t.t === "no";
    if (subjectFirst) {
      if (isVerb) {
        if (cur.length === 0) return { kind: "clarify", why: CLARIFY }; // "1 yes no"
        clauses.push({ subjects: cur, yes: t.t === "yes" });
        cur = [];
      } else cur.push(t);
    } else if (isVerb) {
      if (verbSeen !== undefined && cur.length === 0) return { kind: "clarify", why: CLARIFY }; // "yes no 1"
      if (verbSeen !== undefined) clauses.push({ subjects: cur, yes: verbSeen });
      verbSeen = t.t === "yes";
      cur = [];
    } else cur.push(t);
  }
  if (subjectFirst ? cur.length > 0 : verbSeen === undefined || cur.length === 0) return { kind: "clarify", why: CLARIFY }; // "1 yes 2" / "yes"
  if (!subjectFirst) clauses.push({ subjects: cur, yes: verbSeen! });
  const yes = new Set<number>();
  const no = new Set<number>();
  for (const c of clauses) {
    if (c.subjects.some((s) => s.t === "all") && c.subjects.length > 1) return { kind: "clarify", why: CLARIFY }; // "all 2 yes"
    const ns = c.subjects[0]!.t === "all" ? [...all] : c.subjects.flatMap((s) => (s.t === "num" ? [s.n] : []));
    for (const n of ns) (c.yes ? yes : no).add(n);
  }
  if (clauses.some((c) => c.subjects[0]!.t === "all") && clauses.length > 1) return { kind: "clarify", why: CLARIFY }; // "all yes 2 no" is a contradiction
  const unknown = [...yes, ...no].filter((n) => !open.includes(n));
  if (unknown.length) return { kind: "clarify", why: `There is no #${unknown.sort((a, b) => a - b).join(", #")} waiting${open.length ? ` (open: ${open.join(", ")})` : ""}. Nothing was done.` };
  if ([...yes].some((n) => no.has(n))) return { kind: "clarify", why: CLARIFY };
  if (yes.size + no.size === 0) return { kind: "clarify", why: CLARIFY };
  return { kind: "answer", yes: [...yes].sort((a, b) => a - b), no: [...no].sort((a, b) => a - b) };
}
