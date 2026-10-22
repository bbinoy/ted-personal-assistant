// Reading a reply to a shadow-mode proposal ("3,5 keep", "keep 2-4", "yes", "all except 7", "no"), in CODE, with no model. Pure. Like the approval inbox's grammar (pendingparse.ts) it is deliberately small:
// a message is an answer only when EVERY word of it belongs to the vocabulary; anything else is an ordinary message for the chat. What it can say: archive them all, leave all of them, or leave the named
// ones and archive the rest. A number list with a plain yes ("1,2 yes") is ambiguous (just those? all of them?) and is asked again, never guessed.

export type ShadowReply =
  | { kind: "none" } // not an answer: an ordinary message
  | { kind: "all" } // archive everything listed
  | { kind: "nothing" } // leave everything listed in the inbox
  | { kind: "keep"; keep: number[] } // leave these, archive the rest
  | { kind: "clarify"; why: string };

const YES = new Set(["yes", "y", "yep", "yeah", "yup", "ok", "okay", "sure", "archive", "approve", "confirm", "do", "go", "ahead", "👍", "✅"]);
const NO = new Set(["no", "n", "nope", "nah", "none", "nothing", "cancel", "👎", "❌"]);
const KEEP = new Set(["keep", "except", "but", "skip", "leave", "exclude", "not", "dont", "excluding", "without"]);
const FILLER = new Set(["all", "them", "it", "the", "rest", "others", "other", "ones", "those", "these", "please", "pls", "and", "just", "number", "numbers", "item", "items", "nr", "everything", "of", "to", "in", "inbox", "mail", "mails", "emails", "email", "that", "this", "one", "else"]);

type Tok = { t: "num"; n: number } | { t: "yes" } | { t: "no" } | { t: "keep" } | { t: "all" };

function tokens(text: string): Tok[] | undefined {
  const flat = text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/(\d)\s*[-–]\s*(\d)/g, "$1 to_ $2")
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
        if (m < n || m - n > 60) return undefined;
        for (let k = n; k <= m; k++) out.push({ t: "num", n: k });
        i += 2;
        continue;
      }
      out.push({ t: "num", n });
    } else if (w === "all" || w === "everything") out.push({ t: "all" });
    else if (YES.has(w)) out.push({ t: "yes" });
    else if (NO.has(w)) out.push({ t: "no" });
    else if (KEEP.has(w)) out.push({ t: "keep" });
    else if (FILLER.has(w)) continue;
    else return undefined;
  }
  return out;
}

const ASK = "Say 'keep 3,5' to leave those in your inbox and archive the rest, 'all' (or 👍) to archive them all, or 'no' to leave them all. Nothing was done.";

// `n`: how many are listed (their numbers are 1..n).
export function parseShadowReply(text: string, n: number): ShadowReply {
  const toks = tokens(text);
  if (!toks || toks.length === 0) return { kind: "none" };
  const nums = toks.flatMap((t) => (t.t === "num" ? [t.n] : []));
  const yes = toks.some((t) => t.t === "yes");
  const no = toks.some((t) => t.t === "no");
  const keep = toks.some((t) => t.t === "keep");
  const all = toks.some((t) => t.t === "all");
  if (!yes && !no && !keep && !all) return { kind: "none" }; // numbers alone are a number in a chat; "all" alone is not a verb
  const bad = nums.filter((k) => k < 1 || k > n);
  if (bad.length) return { kind: "clarify", why: `There is no #${[...new Set(bad)].sort((a, b) => a - b).join(", #")} in that list (1 to ${n}). Nothing was done.` };
  const named = [...new Set(nums)].sort((a, b) => a - b);
  if (yes && (no || (keep && named.length === 0 && !all))) return { kind: "clarify", why: ASK };
  if (named.length === 0) {
    if (keep && !yes && !all && n === 1) return { kind: "nothing" }; // "keep" on a one-mail proposal: leave it
    if (no || (keep && all)) return { kind: "nothing" }; // "no", "none", "keep all", "leave them all"
    if (yes || all) return { kind: "all" }; // "yes", "archive all", "all", "do it"
    return { kind: "clarify", why: ASK };
  }
  // numbers named: they are the ones to keep ("3,5 keep", "keep 3", "all except 7", "yes except 2", "3 keep"); a plain yes or no with numbers and no keep word is ambiguous
  if (!keep && no) return { kind: "clarify", why: "Say '2 keep' to leave #2 in your inbox and archive the rest, or 'no' to leave them all. Nothing was done." }; // ("2 no" would read differently in the approval inbox)
  if (keep) return named.length >= n ? { kind: "nothing" } : { kind: "keep", keep: named };
  return { kind: "clarify", why: ASK };
}
