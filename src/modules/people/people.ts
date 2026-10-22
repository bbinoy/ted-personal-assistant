import { readNotes, type Note } from "../../memory/notes.ts";

// find_person's logic, pure but for the notes folder and the one injected Google lookup: who might "Sam" be, with an address, from the sources THIS conversation may use.
//   notes     the conversation's own people-* notes (a confirmed note before an inferred one, which is marked)
//   contacts  a friend's own Google Contacts, through her own server (tenants only; a group or the owner has none: the owner's Google connectors have no contacts tool)
// Candidates are ranked, deduped by address and each carries its sources. An address found here is a SUGGESTION: it does not make a send safer or freer (approvals still show the
// recipients as code reads them from the call, and the recipient floor still asks for an address the owner did not type: docs/SAFETY.md "Finding people").

export type SourceName = "notes" | "contacts";

export interface Candidate {
  name: string;
  emails: string[];
  phones: string[];
  from: { source: SourceName; detail: string; confirmed: boolean }[]; // detail: the note's file, or "Google Contacts"
}

export interface SourceReport {
  source: string; // what the person would call it
  used: boolean;
  why?: string; // for an unavailable one: why, in plain words
}

const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// A phone number only with its marker (+ or a label) so that a date or a count is never taken for one.
const PHONE = /(?:\+|\b00)\d[\d\s().-]{5,}\d|(?:phone|tel|mobile|cell|number)\s*:?\s*(\+?\d[\d\s().-]{5,}\d)/gi;

const norm = (s: string): string => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}@.\s-]/gu, " ").replace(/\s+/g, " ").trim();
const tokens = (s: string): string[] => norm(s).split(/[\s-]+/).filter(Boolean);
const digits = (p: string): string => p.replace(/\D/g, "");

// Pure: the addresses and phone numbers in free text (lower-cased addresses, deduped; phones as written, trimmed).
export function contactsIn(text: string): { emails: string[]; phones: string[] } {
  const emails = [...new Set((text.match(EMAIL) ?? []).map((e) => e.toLowerCase().replace(/[.']+$/, "")))];
  const phones: string[] = [];
  for (const m of text.matchAll(PHONE)) {
    const p = (m[1] ?? m[0]).trim();
    if (!phones.some((q) => digits(q) === digits(p))) phones.push(p);
  }
  return { emails, phones };
}

// Pure: a people note as a candidate (nothing for any other note; a note with no address still names the person). The name is the one the note starts with ("Anna Silva. Lives in ..."), else the file's.
export function fromNote(n: Note): Candidate | undefined {
  if (n.category !== "people") return undefined;
  const slug = n.file.replace(/^people-/, "").replace(/\.md$/, "").replace(/-/g, " ");
  const first = n.text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const lead = /^([^.:;,\n]{2,60}?)(?:\.|:|;|,| - |$)/.exec(first)?.[1]?.trim();
  const head = tokens(slug)[0];
  const spelled = slug.replace(/\b\p{L}/gu, (c) => c.toUpperCase()); // people-anna-silva.md -> Anna Silva
  const name = lead && tokens(lead).length <= 5 && !/@/.test(lead) && (!head || tokens(lead).some((w) => w.startsWith(head))) ? lead : spelled; // (the opening words only when they carry the file's name: "Lives in Porto" is not one)
  const { emails, phones } = contactsIn(n.text);
  return { name: name || spelled, emails, phones, from: [{ source: "notes", detail: n.file, confirmed: !n.inferred }] };
}

// Pure: a friend's Google Contacts answer (workspace-mcp's search_contacts text: blocks of "Contact ID:", "Name:", "Email:" or "Emails:" with "  - " lines, "Phone(s):") as candidates.
export function fromContactsText(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    if (!/^\s*Contact ID:/m.test(block)) continue;
    let name = "";
    const emails: string[] = [];
    const phones: string[] = [];
    let list: "email" | "phone" | undefined;
    for (const raw of block.split("\n")) {
      const line = raw.trim();
      let m: RegExpExecArray | null;
      if ((m = /^Name:\s*(.+)$/.exec(line))) name = m[1]!.trim();
      else if ((m = /^Emails?:\s*(.*)$/.exec(line))) {
        list = "email";
        if (m[1]) emails.push(...contactsIn(m[1]).emails);
      } else if ((m = /^Phones?:\s*(.*)$/.exec(line))) {
        list = "phone";
        if (m[1]) phones.push(m[1].replace(/\s*\([^)]*\)\s*$/, "").trim());
      } else if (line.startsWith("- ") && list === "email") emails.push(...contactsIn(line).emails);
      else if (line.startsWith("- ") && list === "phone") phones.push(line.slice(2).replace(/\s*\([^)]*\)\s*$/, "").trim());
      else list = undefined;
    }
    if (name || emails.length) out.push({ name: name || emails[0]!, emails: [...new Set(emails)], phones: phones.filter(Boolean), from: [{ source: "contacts", detail: "Google Contacts", confirmed: true }] });
  }
  return out;
}

// How well a candidate matches the query: 3 the full name or an address, 2 every query word starts a name word, 1 every word appears somewhere in the name or address, 0 no match.
export function matchScore(c: Candidate, query: string): number {
  const q = tokens(query);
  if (!q.length) return 0;
  const name = tokens(c.name);
  if (norm(c.name) === norm(query) || c.emails.some((e) => e === norm(query))) return 3;
  if (q.every((w) => name.some((n) => n.startsWith(w)))) return 2;
  const hay = norm(`${c.name} ${c.emails.join(" ")}`);
  return q.every((w) => hay.includes(w)) ? 1 : 0;
}

const confirmedOf = (c: Candidate): boolean => c.from.some((f) => f.confirmed);

// Pure: two candidates are the same person when they share an address, or (one has no address) the same normalised name.
const same = (a: Candidate, b: Candidate): boolean => a.emails.some((e) => b.emails.includes(e)) || ((!a.emails.length || !b.emails.length) && norm(a.name) === norm(b.name));

// Pure: ranked and deduped by address. Order: better match, then a confirmed source before an inferred-only one, then notes before contacts, then name. A person found in two sources is one candidate with both.
export function rank(found: readonly Candidate[], query: string, limit = 8): Candidate[] {
  const merged: Candidate[] = [];
  for (const c of found) {
    const hit = merged.find((m) => same(m, c));
    if (!hit) {
      merged.push({ ...c, emails: [...c.emails], phones: [...c.phones], from: [...c.from] });
      continue;
    }
    for (const e of c.emails) if (!hit.emails.includes(e)) hit.emails.push(e);
    for (const p of c.phones) if (!hit.phones.some((q) => digits(q) === digits(p))) hit.phones.push(p);
    hit.from.push(...c.from);
    if (c.name.length > hit.name.length) hit.name = c.name; // (the fuller name wins)
  }
  const src = (c: Candidate) => (c.from.some((f) => f.source === "notes" && f.confirmed) ? 0 : c.from.some((f) => f.source === "contacts") ? 1 : 2);
  return merged
    .map((c) => ({ c, s: matchScore(c, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || src(a.c) - src(b.c) || Number(confirmedOf(b.c)) - Number(confirmedOf(a.c)) || a.c.name.localeCompare(b.c.name))
    .slice(0, limit)
    .map((x) => x.c);
}

const label = (f: Candidate["from"][number]): string => (f.source === "notes" ? `${f.detail}${f.confirmed ? "" : " (inferred, not confirmed)"}` : f.detail);

// Pure: the answer as text (the tool fences it): which sources were used, which were not and why, then the candidates, or the reason there are none.
export function render(query: string, found: readonly Candidate[], reports: readonly SourceReport[]): string {
  const lines: string[] = [];
  const used = reports.filter((r) => r.used).map((r) => r.source);
  lines.push(`Sources used: ${used.length ? used.join(", ") : "none"}.`);
  for (const r of reports.filter((r) => !r.used)) lines.push(`Not available: ${r.source}${r.why ? ` (${r.why})` : ""}.`);
  if (!found.length) {
    lines.push(`No one matching "${query}" was found in those sources. Say so; do not guess an address. Ask the person for it, or look in the mail itself if you may.`);
    return lines.join("\n");
  }
  lines.push(`${found.length} candidate${found.length === 1 ? "" : "s"} for "${query}", best first:`);
  found.forEach((c, i) => {
    const reach = [...c.emails, ...c.phones.map((p) => `tel ${p}`)].join(", ") || "no address or phone on record";
    lines.push(`${i + 1}. ${c.name}: ${reach}. From: ${c.from.map(label).join("; ")}.`);
  });
  lines.push(found.length > 1 ? "More than one person fits: show these and ask which, do not choose." : "One match: use it, saying whose address it is, unless the request was about someone else.");
  lines.push("These are suggestions from stored data. Nothing is sent by finding an address: a send still asks, and an address the owner did not type is asked about.");
  return lines.join("\n");
}

// What a conversation may use. The caller (peopletool.ts) builds it from the run; this file decides nothing about who may.
export interface Lookup {
  notesDir: string;
  zone?: string;
  now?: Date;
  contacts?: (query: string) => Promise<string>; // a friend's Google Contacts text, or a throw saying why not; absent: this conversation has none
  contactsWhy: string; // when `contacts` is absent: why, in plain words
}

// The lookup: every source of this conversation, never another's. A source that throws is reported unavailable and the others still answer.
export async function findPerson(query: string, o: Lookup): Promise<string> {
  const reports: SourceReport[] = [];
  const found: Candidate[] = [];
  const notes = readNotes(o.now, o.notesDir, o.zone).filter((n) => n.category === "people");
  reports.push({ source: `people notes (${notes.length})`, used: true });
  found.push(...notes.flatMap((n) => fromNote(n) ?? []));
  if (o.contacts) {
    try {
      found.push(...fromContactsText(await o.contacts(query)));
      reports.push({ source: "Google Contacts", used: true });
    } catch (e) {
      reports.push({ source: "Google Contacts", used: false, why: e instanceof Error ? e.message : "it did not answer" });
    }
  } else reports.push({ source: "Google Contacts", used: false, why: o.contactsWhy });
  reports.push({ source: "recent correspondents in mail", used: false, why: "not looked up here: if there is no match, search the mail for the name yourself, and treat what you find as a suggestion" });
  return render(query, rank(found, query), reports);
}
