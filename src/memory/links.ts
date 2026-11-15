import { HARD_NAMES_NOTE, INDEX_MAX_CHARS, indexOf, stemOf, STYLE_NOTE, type Note } from "./notes.ts";

// Facts about how the pages of one conversation hang together, computed by code and handed to the nightly dream (dream.ts) and the doctor: which `[[links]]` lead nowhere, which pages nothing refers to, which
// pages are about the same person, and whether the index no longer fits its budget. Pure; code decides nothing from them (CLAUDE.md §1: facts, not decisions): the dream repairs, links and merges.
// A page's identity for a link is its file stem (`people/mara-silva.md` is `mara-silva`), compared without case.

const LINK = /\[\[([^\]\n]+)\]\]/g;

/** The pages a text links to, as stems (a `|label`, a folder and `.md` dropped; lower case; each once). */
export const linksOf = (text: string): string[] => [...new Set([...text.matchAll(LINK)].map((m) => stemOf(m[1]!.split("|")[0]!.trim()).toLowerCase()).filter(Boolean))];

export interface BrokenLink { from: string; target: string; pages: string[] } // pages: the files the stem could mean (none: no page; several: ambiguous)

const stemIndex = (notes: readonly Note[]): Map<string, string[]> => {
  const by = new Map<string, string[]>();
  for (const n of notes) if (n.class !== "status") by.set(stemOf(n.file).toLowerCase(), [...(by.get(stemOf(n.file).toLowerCase()) ?? []), n.file]);
  return by;
};

/** Every `[[link]]` of a page (not a status record) that leads to no page, or to more than one (two folders holding the same stem). */
export function brokenLinks(notes: readonly Note[]): BrokenLink[] {
  const by = stemIndex(notes);
  return notes.filter((n) => n.class !== "status").flatMap((n) => linksOf(n.text).flatMap((target) => ((by.get(target)?.length ?? 0) === 1 ? [] : [{ from: n.file, target, pages: by.get(target) ?? [] }])));
}

/** Pages that no other page links to nor names in its text (the two pages code reads by name are left out). */
export function orphans(notes: readonly Note[]): string[] {
  const pages = notes.filter((n) => n.class === "page" && n.file !== STYLE_NOTE && n.file !== HARD_NAMES_NOTE);
  return pages.filter((p) => {
    const stem = stemOf(p.file).toLowerCase();
    const words = stem.replace(/-/g, " ");
    return !notes.some((o) => o.file !== p.file && o.class !== "status" && (linksOf(o.text).includes(stem) || o.text.toLowerCase().includes(words) || o.text.toLowerCase().includes(stem)));
  }).map((p) => p.file);
}

/** Groups of pages whose `person:` names the same person (case and spacing aside). */
export function samePerson(notes: readonly Note[]): { person: string; pages: string[] }[] {
  const by = new Map<string, { person: string; pages: string[] }>();
  for (const n of notes) if (n.person && n.class === "page") {
    const key = n.person.toLowerCase().replace(/\s+/g, " ").trim();
    by.set(key, { person: by.get(key)?.person ?? n.person, pages: [...(by.get(key)?.pages ?? []), n.file] });
  }
  return [...by.values()].filter((g) => g.pages.length > 1);
}

const MAX_LISTED = 15;
const list = (xs: readonly string[]): string => `${xs.slice(0, MAX_LISTED).join(", ")}${xs.length > MAX_LISTED ? `, and ${xs.length - MAX_LISTED} more` : ""}`;

/** The facts as lines for the dream's prompt; empty when the pages hang together and the index fits. */
export function pageFacts(notes: readonly Note[]): string[] {
  const out: string[] = [];
  const missing = brokenLinks(notes).filter((b) => !b.pages.length);
  const several = brokenLinks(notes).filter((b) => b.pages.length > 1);
  if (missing.length) out.push(`[[links]] to a page that does not exist: ${list(missing.map((b) => `[[${b.target}]] in ${b.from}`))}`);
  if (several.length) out.push(`[[links]] that could mean several pages (the same name in two folders): ${list(several.map((b) => `[[${b.target}]] in ${b.from} is ${b.pages.join(" or ")}`))}`);
  const lone = orphans(notes);
  if (lone.length) out.push(`pages nothing links to or names: ${list(lone)}`);
  const twice = samePerson(notes);
  if (twice.length) out.push(`pages about the same person: ${list(twice.map((g) => `${g.person} (${g.pages.join(", ")})`))}`);
  const size = indexOf(notes.filter((n) => n.class !== "status"), Infinity).length;
  if (size > INDEX_MAX_CHARS) out.push(`the index, MEMORY.md, would be ${size} characters and its budget is ${INDEX_MAX_CHARS}: fewer, larger pages and short descriptions keep every page in it`);
  return out;
}
