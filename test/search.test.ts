import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordMessage } from "../src/core/messages.ts";
import { settings } from "../src/core/settings.ts";
import { dataPath } from "../src/core/state.ts";
import { bm25Ranker, nearFactor, parseQuery, searchConversation, snippet, type Ranker, type Scope } from "../src/memory/search.ts";
import { SearchIndex } from "../src/memory/searchindex.ts";
import { fold, stem, stems } from "../src/memory/searchtext.ts";

// Ranked search over one conversation's log and notes: the real log writer, the real index (SQLite FTS5), temporary folders.

const NOW = Date.parse("2026-10-20T12:00:00Z");
let n = 0;
function rig(name = "a") {
  const dir = mkdtempSync(join(tmpdir(), "search-"));
  const notesDir = join(dir, "notes");
  mkdirSync(notesDir);
  const logFile = `logs/search-${name}-${++n}.jsonl`;
  const scope: Scope = { logFile, notesDir, indexPath: join(dir, "search.sqlite") };
  let ts = 1_700_000_000_000;
  const say = (kind: Parameters<typeof recordMessage>[0], text: string, extra: { by?: string; of?: number; day?: string; ts?: number } = {}) => {
    const t = extra.ts ?? ++ts;
    recordMessage(kind, t, text, new Date(`${extra.day ?? "2026-10-10"}T10:00:00Z`), logFile, { by: extra.by, of: extra.of });
    return t;
  };
  const find = (args: Parameters<typeof searchConversation>[1], ranker?: Ranker) => searchConversation(scope, args, { now: NOW, ranker });
  return { dir, scope, notesDir, logFile, say, find };
}

test("search text: accents, case and a few suffixes fold together; German endings too", () => {
  assert.equal(fold("Café STRASSE Straße"), "cafe strasse strasse");
  assert.deepEqual(stems("Booking booked books book"), ["book", "book", "book", "book"]);
  assert.equal(stem("mentioned"), stem("mentions"));
  assert.equal(stem("Gesprächen".normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()), stem("gesprache"));
  assert.deepEqual(parseQuery('the "exact phrase" Keeley', ["dinner", "the"]).phrases, ["exact phrase"]);
  const q = parseQuery("restaurant Keeley", ["trattoria", "restaurants"]);
  assert.equal(q.terms.find((t) => t.w === "restaurant")!.weight, 1); // the model's own word keeps full weight over its alsoTry copy
  assert.equal(q.terms.find((t) => t.w === "trattoria")!.weight, 0.6);
  assert.ok(nearFactor([{ pos: 3, w: "a" }, { pos: 4, w: "b" }], 2) > nearFactor([{ pos: 3, w: "a" }, { pos: 30, w: "b" }], 2));
});

test("search: 'that restaurant Keeley mentioned' is found through alsoTry although the word restaurant never appears", () => {
  const r = rig();
  r.say("owner", "Lunch on Thursday?");
  r.say("member", "Keeley: you have to try Luca's trattoria, best dinner in town. Book a table early!", { by: "+1555" });
  r.say("member", "Keeley: see you at the match", { by: "+1555" });
  r.say("member", "Dan: the restaurant bill was too high last time", { by: "+1666" });
  r.say("chat", "Noted, I will remember the weather forecast.");
  const plain = r.find({ query: "restaurant Keeley mentioned" });
  assert.match(plain, /bill was too high/); // without help only the line with the word is a candidate (and Keeley's other line)
  assert.doesNotMatch(plain.split("\n")[1]!, /trattoria/);
  const helped = r.find({ query: "restaurant Keeley mentioned", alsoTry: ["dinner", "trattoria", "booking", "table"] });
  assert.match(helped.split("\n")[1]!, /Keeley: .*trattoria/, helped); // the best hit is her line, with her name as the author
  assert.match(helped, /#17000000000\d\d/);
  assert.match(helped, /2026-10-10 10:00Z/);
});

test("search: a quoted phrase must appear exactly; no query gives the latest lines, newest last", () => {
  const r = rig();
  r.say("owner", "the blue house is for sale");
  r.say("owner", "a house that is blue");
  r.say("owner", "something else entirely");
  const out = r.find({ query: '"blue house"' });
  assert.match(out, /^1 match/);
  assert.match(out, /blue house is for sale/);
  const latest = r.find({ limit: 2 });
  assert.match(latest, /the latest, newest last/);
  assert.ok(latest.indexOf("a house that is blue") < latest.indexOf("something else"), latest);
  assert.doesNotMatch(latest, /blue house is for sale/);
  assert.match(latest, /1 more not shown/);
});

test("search: author and date filters", () => {
  const r = rig();
  r.say("member", "Keeley: the cafe on Main Street is lovely", { day: "2026-09-01" });
  r.say("member", "Dan: the cafe near the station is lovely", { day: "2026-09-02" });
  r.say("member", "Keeley: the cafe in Berlin is lovely", { day: "2026-10-05" });
  r.say("owner", "which cafe was it?", { day: "2026-10-06" });
  r.say("chat", "The cafe you liked was in Berlin.", { day: "2026-10-06" });
  const byKeeley = r.find({ query: "cafe", who: "keeley" });
  assert.match(byKeeley, /^2 matches/);
  assert.doesNotMatch(byKeeley, /Dan|station/);
  assert.match(r.find({ query: "cafe", who: "owner" }), /^1 match.*\n.*owner: which cafe/);
  assert.match(r.find({ query: "cafe", who: "assistant" }), /^1 match.*\n.*you liked/);
  const sept = r.find({ query: "cafe", since: "2026-09-01", until: "2026-09-01" }); // a bare until-date covers the whole day
  assert.match(sept, /^1 match/);
  assert.match(sept, /Main Street/);
  assert.match(r.find({ query: "cafe", since: "2026-10-01", until: "2026-10-05" }), /^1 match.*Berlin/s);
  assert.match(r.find({ query: "cafe", sinceHours: 24 * 16 }), /^3 matches/); // 16 days before NOW reach back to the 4th of October, not to September
  assert.match(r.find({ query: "cafe", since: "last week" }), /dates like/);
});

test("search: recency breaks ties, and a line with more of the query ranks above one with less", () => {
  const r = rig();
  r.say("owner", "the dentist said to come back", { day: "2026-03-01" });
  r.say("owner", "the dentist said to come back", { day: "2026-10-18" });
  const out = r.find({ query: "dentist" });
  assert.ok(out.indexOf("2026-10-18") < out.indexOf("2026-03-01"), out);
  const r2 = rig();
  r2.say("owner", "Keeley called");
  r2.say("owner", "Keeley recommended the trattoria for dinner");
  const out2 = r2.find({ query: "Keeley", alsoTry: ["trattoria", "dinner"] });
  assert.match(out2.split("\n")[1]!, /recommended the trattoria/);
});

test("search: memory notes are found by their whole text and by their name, expired ones are not", () => {
  const r = rig();
  writeFileSync(join(r.notesDir, "people-keeley.md"), "---\nname: Keeley\n---\nKeeley lives in Lisbon. She loves the Tasca do Chico for fado evenings.\n");
  writeFileSync(join(r.notesDir, "context-trip.md"), "---\nexpires: 2026-10-01\n---\nPacking list for the Madeira trip: wetsuit.\n");
  writeFileSync(join(r.notesDir, "MEMORY.md"), "- [Keeley](people-keeley.md) index line only\n");
  r.say("owner", "hello");
  const out = r.find({ query: "fado" });
  assert.match(out, /note:people-keeley\.md.*Tasca do Chico/);
  assert.match(r.find({ query: "keeley lisbon" }), /note:people-keeley\.md/);
  assert.match(r.find({ query: "wetsuit" }), /^No matching/); // past its expires: day
  assert.doesNotMatch(r.find({ query: "index line" }), /index line only/); // the index is not a note
  writeFileSync(join(r.notesDir, "people-keeley.md"), "Keeley moved to Porto.\n"); // a changed note replaces the old text
  assert.match(r.find({ query: "porto" }), /people-keeley/);
  assert.match(r.find({ query: "fado" }), /^No matching/);
});

test("search: another conversation's log and notes are never reached, only the scope handed in", () => {
  const a = rig("a");
  const b = rig("b");
  a.say("member", "Eve: the secret code is pomegranate");
  writeFileSync(join(a.notesDir, "context-a.md"), "Pomegranate orchard in the south.\n");
  b.say("member", "Zed: nothing here about fruit");
  assert.match(a.find({ query: "pomegranate" }), /^2 matches/);
  assert.match(b.find({ query: "pomegranate" }), /^No matching/);
  assert.match(b.find({ query: "pomegranate", alsoTry: ["secret", "code", "orchard"] }), /^No matching/);
  assert.notEqual(a.scope.indexPath, b.scope.indexPath);
});

test("search: deleted messages are left out, an edited one shows its newest text and only that", () => {
  const r = rig();
  const keep = r.say("member", "Eve: lunch at the harbour grill");
  const gone = r.say("member", "Eve: my password hint is walrus", { by: "+1" });
  r.say("delete", "x", { of: gone, by: "+1" });
  const orig = r.say("member", "Eve: meet at the old pier", { by: "+1" });
  const e1 = r.say("edit", "Eve: meet at the new pier", { of: orig, by: "+1" });
  r.say("edit", "Eve: meet at the south jetty", { of: e1, by: "+1" }); // an edit of an edit
  assert.match(r.find({ query: "walrus" }), /^No matching/);
  assert.match(r.find({ query: "harbour" }), new RegExp(`#${keep}`));
  const pier = r.find({ query: "pier" });
  assert.match(pier, /^No matching/); // both old wordings are gone
  const jetty = r.find({ query: "south jetty" });
  assert.match(jetty, /^1 match/);
  assert.match(jetty, new RegExp(`#${orig}`)); // listed under the original message, with the newest text
  assert.match(jetty, /Eve: meet at the south jetty|Eve: .*jetty/);
  const latest = r.find({});
  assert.doesNotMatch(latest, /walrus|old pier|new pier/);
});

test("search index: appended lines are read incrementally, a replaced log starts over, a damaged file is rebuilt", () => {
  const r = rig();
  for (let i = 0; i < 50; i++) r.say("owner", `line number ${i} about zebras`);
  const idx = SearchIndex.open(r.scope.indexPath);
  assert.equal(idx.syncLog(r.logFile), 50);
  assert.equal(idx.syncLog(r.logFile), 0); // nothing new: nothing read
  r.say("owner", "one more about giraffes");
  r.say("reaction", "👍"); // not indexed, but its bytes are passed
  assert.equal(idx.syncLog(r.logFile), 1);
  const path = dataPath(r.logFile);
  appendFileSync(path, '{"ts":1,"at":"2026-10-10T10:00:00.000Z","kind":"owner","text":"half a li'); // a torn last line waits
  assert.equal(idx.syncLog(r.logFile), 0);
  appendFileSync(path, 'ne about okapis"}\n');
  assert.equal(idx.syncLog(r.logFile), 1);
  idx.close();
  assert.match(r.find({ query: "okapis" }), /half a line/);
  // compaction rewrites the file: shorter, another start
  writeFileSync(path, readFileSync(path, "utf8").split("\n").slice(-4).join("\n"));
  assert.match(r.find({ query: "giraffes" }), /^1 match/);
  assert.match(r.find({ query: "zebras" }), /^No matching/);
  // a damaged index file is deleted and built again, silently
  writeFileSync(r.scope.indexPath, "this is not a database at all".repeat(200));
  assert.match(r.find({ query: "okapis" }), /half a line/);
  writeFileSync(r.scope.indexPath, readFileSync(r.scope.indexPath).subarray(0, 5000)); // truncated
  assert.match(r.find({ query: "giraffes" }), /^1 match/);
  assert.ok(statSyncMode(r.scope.indexPath) === 0o600, "owner-only");
});

const statSyncMode = (p: string) => statSync(p).mode & 0o777;

test("search: the old exact-word behaviour stays reachable, the snippet is the sentence around the match, and the reply is capped", () => {
  const long = `${"Filler words go here and there. ".repeat(20)}The trattoria on Via Roma had amazing pasta. ${"More filler sentences follow after it. ".repeat(20)}`;
  const s = snippet(long, parseQuery("pasta"));
  assert.match(s, /trattoria on Via Roma had amazing pasta/);
  assert.ok(s.length < 400);
  const r = rig();
  for (let i = 0; i < 20; i++) r.say("owner", `note ${i}: ${"padding ".repeat(30)} wombat ${i}`);
  const out = r.find({ query: "wombat", limit: 20, maxChars: 800 });
  assert.ok(out.length < 1500, String(out.length));
  assert.match(out, /more not shown/);
  assert.match(r.find({ query: "xylophone" }), /Try again with alsoTry/);
  assert.doesNotMatch(r.find({ query: "xylophone", alsoTry: ["marimba"] }), /Try again with alsoTry/);
});

test("search: a different Ranker can be plugged in (the seam for a local embedding ranker)", () => {
  const r = rig();
  r.say("owner", "alpha first");
  r.say("owner", "alpha second");
  const reverse: Ranker = { name: "reverse", score: (_q, docs) => docs.map((d) => (d.text.includes("first") ? 2 : 1)) };
  assert.match(r.find({ query: "alpha" }, reverse).split("\n")[1]!, /first/);
  assert.equal(bm25Ranker.name, "bm25");
});

test("search: 20k lines, indexed once, then queries and incremental updates are fast", () => {
  const r = rig("big");
  const words = "meeting lunch dinner flight train hotel dentist invoice birthday garden kite surf weather mortgage Anna Ben Carla Dmitri Eve Frank trattoria cafe tickets".split(" ");
  const lines: string[] = [];
  let seed = 7;
  const rnd = (k: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % k);
  for (let i = 0; i < 20_000; i++) {
    const text = Array.from({ length: 14 }, () => words[rnd(words.length)]).join(" ");
    lines.push(JSON.stringify({ ts: 1_700_000_000_000 + i, at: new Date(NOW - (20_000 - i) * 60_000).toISOString(), kind: i % 3 ? "owner" : "chat", text }));
  }
  lines.push(JSON.stringify({ ts: 1_800_000_000_000, at: new Date(NOW - 5000).toISOString(), kind: "member", by: "+1", text: "Keeley: we had the best zabaglione at Luca's osteria" }));
  writeFileSync(dataPath(r.logFile), `${lines.join("\n")}\n`);
  const t0 = performance.now();
  const first = r.find({ query: "zabaglione" });
  const build = performance.now() - t0;
  assert.match(first, /osteria/);
  const t1 = performance.now();
  for (let i = 0; i < 5; i++) r.find({ query: "dinner Anna", alsoTry: ["trattoria", "cafe", "lunch"] });
  const query = (performance.now() - t1) / 5;
  appendFileSync(dataPath(r.logFile), `${JSON.stringify({ ts: 1_800_000_000_001, at: new Date(NOW).toISOString(), kind: "owner", text: "brand new platypus line" })}\n`);
  const t2 = performance.now();
  assert.match(r.find({ query: "platypus" }), /platypus/);
  const incremental = performance.now() - t2;
  console.log(`search perf, 20k lines (${(statSync(dataPath(r.logFile)).size / 1e6).toFixed(1)} MB log): first build ${build.toFixed(0)} ms, query ${query.toFixed(1)} ms, after one appended line ${incremental.toFixed(1)} ms`);
  assert.ok(query < 400, `query took ${query} ms`);
  assert.ok(incremental < 400, `incremental update + query took ${incremental} ms`);
  assert.ok(settings.assistant);
});
