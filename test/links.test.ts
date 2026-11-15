import { test } from "node:test";
import assert from "node:assert/strict";
import { brokenLinks, linksOf, orphans, pageFacts, samePerson } from "../src/memory/links.ts";
import { INDEX_MAX_CHARS, parseNote, type Note } from "../src/memory/notes.ts";
import { dreamPrompt } from "../src/conversation/dream.ts";

// What the dream is told about how the pages hang together: facts computed by code, pure, over invented pages.

const page = (file: string, text: string, person?: string): Note => parseNote(file, person ? `---\nperson: ${JSON.stringify(person)}\n---\n${text}` : text)!;

test("links: a [[link]] is a page stem, with a label, a folder or .md tolerated, each once, lower case", () => {
  assert.deepEqual(linksOf("See [[Mara-Silva]], [[people/mara-silva.md]], [[lisbon-trip|the trip]] and [[ ]]."), ["mara-silva", "lisbon-trip"]);
  assert.deepEqual(linksOf("no links, [single] brackets"), []);
});

test("links: a link to no page, or to a stem two folders share, is broken; a status record is no page", () => {
  const notes = [
    page("mara-silva.md", "Joins the [[lisbon-trip]] and [[nowhere]]."),
    page("trips/lisbon-trip.md", "See [[mara-silva]]."),
    page("a/x.md", "x"),
    page("b/x.md", "x, and [[x]]."),
    page("status/brief.md", "mentions [[ghost]]"),
  ];
  assert.deepEqual(brokenLinks(notes), [{ from: "mara-silva.md", target: "nowhere", pages: [] }, { from: "b/x.md", target: "x", pages: ["a/x.md", "b/x.md"] }]);
});

test("links: a page nothing links to or names is an orphan; the pages code reads by name are not", () => {
  const notes = [
    page("mara-silva.md", "Joins the [[lisbon-trip]]."),
    page("lisbon-trip.md", "Flights booked."),
    page("camper-van.md", "Inspection in June."),
    page("garden.md", "The mara silva page says more."),
    page("style.md", "- short"),
    page("hard-names.md", "Okafor"),
    page("routines/brief.md", "do it"),
  ];
  assert.deepEqual(orphans(notes), ["camper-van.md", "garden.md"], "mara-silva is named in garden.md, lisbon-trip is linked, style and hard-names are read by name, a routine is no page");
});

test("links: pages about the same person are grouped, case and spacing aside", () => {
  const notes = [page("mara.md", "a", "Mara Silva"), page("people/mara-silva.md", "b", "mara  silva"), page("rui.md", "c", "Rui Alves")];
  assert.deepEqual(samePerson(notes), [{ person: "Mara Silva", pages: ["mara.md", "people/mara-silva.md"] }]);
});

test("links: the facts are lines for the prompt, empty when all is well, and name an index over its budget", () => {
  const fine = [page("a.md", "See [[b]]."), page("b.md", "See [[a]].")];
  assert.deepEqual(pageFacts(fine), []);
  const lines = pageFacts([page("a.md", "See [[ghost]]."), page("b.md", "x", "Rui Alves"), page("c.md", "y", "Rui Alves")]);
  assert.match(lines.join("\n"), /does not exist: \[\[ghost\]\] in a\.md/);
  assert.match(lines.join("\n"), /nothing links to or names: .*b\.md/);
  assert.match(lines.join("\n"), /same person: Rui Alves \(b\.md, c\.md\)/);
  const big = Array.from({ length: 200 }, (_, i) => page(`p${i}.md`, "x", undefined)).map((n) => ({ ...n, description: "d".repeat(150), text: `[[p${(Number(n.file.slice(1, -3)) + 1) % 200}]]` }));
  assert.match(pageFacts(big).join("\n"), new RegExp(`budget is ${INDEX_MAX_CHARS}`));
});

test("dream: the prompt carries the facts as fenced data, and nothing when there are none", () => {
  const raw = (text: string) => `---\nname: x\n---\n${text}\n`;
  const p = dreamPrompt(new Date("2026-05-03T10:00:00Z"), "the owner", [{ file: "a.md", raw: raw("See [[ghost]].") }], ["[10:00] the owner: hi"]);
  assert.match(p, /Facts about these pages, worked out by code[\s\S]*<page_facts>[\s\S]*\[\[ghost\]\] in a\.md/);
  const quiet = dreamPrompt(new Date("2026-05-03T10:00:00Z"), "the owner", [{ file: "a.md", raw: raw("See [[b]].") }, { file: "b.md", raw: raw("See [[a]].") }], ["[10:00] the owner: hi"]);
  assert.doesNotMatch(quiet, /Facts about these pages/);
});
