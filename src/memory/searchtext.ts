// Text handling for the search (pure): the one normalisation both the index and the query go through, so they always agree.
//   case and accents:  NFD, marks dropped, lower case, "ß" as "ss" ("Café" finds "cafe", "Straße" finds "strasse")
//   words:             runs of letters and digits in any script
//   stems:             a few suffix rules for English and German-ish endings ("booking", "booked", "books" -> "book"; "Gesprächen" ->
//                      "gesprach"); deliberately crude: both sides are stemmed the same way, so a wrong stem still matches itself

export const fold = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ß/g, "ss");

const RULES: readonly (readonly [string, string, number])[] = [
  ["ies", "y", 2], ["sses", "ss", 2], ["ing", "", 3], ["ed", "", 3], ["en", "", 3], ["es", "", 3], ["s", "", 3], ["e", "", 3],
]; // [ending, replacement, shortest stem left]

export function stem(w: string): string {
  if (w.length < 4 || /^\d/.test(w)) return w;
  for (const [end, rep, min] of RULES) {
    if (end === "s" && w.endsWith("ss")) continue;
    if (w.endsWith(end) && w.length - end.length >= min) return w.slice(0, w.length - end.length) + rep;
  }
  return w;
}

const STOP = new Set(
  ("a an and are as at be but by for from had has have he her his i in is it its me my of on or our she so that the their them there they this to was we were what when where which who will with you your " +
    "about after again all also any been before can did do does just more not now only other out over some such than then these those very would " +
    "aber als am auch auf aus bei bin das dass dein der die dir du ein eine einen er es für hat hier ich ihr im ist ja kein mal mit nach nicht noch nur oder sie sind so und uns von war was wir wie wird zu").split(" "),
);
export const isStop = (stemmed: string): boolean => STOP.has(stemmed);

const WORD = /[\p{L}\p{N}]+/gu;

// Every word of `text`, folded and stemmed, in order (stop words included: phrase and near matching count positions).
export const stems = (text: string): string[] => (fold(text).match(WORD) ?? []).map(stem);

// A query's words without the little ones; unique, in order.
export const queryStems = (text: string): string[] => [...new Set(stems(text).filter((w) => !STOP.has(w) && w.length > 1))];

// Sentences (or lines) of a text, with their start offsets.
export function sentences(text: string): { s: string; at: number }[] {
  const out: { s: string; at: number }[] = [];
  const re = /[^.!?\n]+(?:[.!?]+(?=\s|$)|\n|$)\s*/g;
  for (let m = re.exec(text); m && m[0]; m = re.exec(text)) if (m[0].trim()) out.push({ s: m[0].trim(), at: m.index });
  return out.length ? out : [{ s: text.trim(), at: 0 }];
}
