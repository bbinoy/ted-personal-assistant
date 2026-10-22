import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const dir = mkdtempSync(join(tmpdir(), "people-"));
process.env.HARNESS_DATA_DIR = dir;

const { contactsIn, fromContactsText, fromNote, findPerson, rank, matchScore } = await import("../src/modules/people/people.ts");
const { parseNote } = await import("../src/memory/notes.ts");
const { RUNTIME } = await import("../src/modules/runtime.ts");
const { searchContacts } = await import("../src/modules/google/googlemcp.ts");
const { classify } = await import("../src/policy/policy.ts");
const { toolsFor, groupTools } = await import("../src/policy/capabilities.ts");
const { CAPABILITIES, FRIEND_CAPABILITIES } = await import("../src/tenants/tenants.ts");
const { readsUntrusted, isFree } = await import("../src/policy/toolmanifest.ts");
const { recipientsOutside } = await import("../src/approvals/autojudge.ts");
const { loadSettings } = await import("../src/core/settings.ts");
const { hiddenTools } = await import("../src/policy/policy.ts");
const { reportable } = await import("../src/modules/connectors.ts");
const { GOOGLE_PREFIX, GOOGLE_TOOLS } = await import("../src/modules/google/module.ts");

// find_person (src/modules/people): the address book of ONE conversation. Ranking and dedupe by address, the notes-only path, sources that are down reported and never failing,
// isolation (a group has its notes only; a friend never sees the owner's; each conversation its own), and approvals that do not care where an address came from.

const note = (file: string, body: string, inferred = false) => parseNote(file, `${inferred ? "---\norigin: inferred\n---\n" : ""}${body}`)!;
const notesDir = (files: Record<string, string>): string => {
  const d = mkdtempSync(join(dir, "notes-"));
  mkdirSync(d, { recursive: true });
  for (const [f, t] of Object.entries(files)) writeFileSync(join(d, f), t);
  return d;
};
const CONTACTS = `Search Results for 'sam' (2 found):

Contact ID: c1
Name: Sam Carter
Emails:
  - Sam.Carter@Example.com (work)
  - sam@home.example
Phone: +44 7700 900123 (mobile)

Contact ID: c2
Name: Samantha Reyes
Email: samantha@example.org
`;

test("people: addresses and phones are read out of a note's text, a date is no phone number", () => {
  assert.deepEqual(contactsIn("Sam, mail Sam.Carter@Example.com. Born 2026-10-21, call +44 7700 900123 or phone: 020 7946 0000."), { emails: ["sam.carter@example.com"], phones: ["+44 7700 900123", "020 7946 0000"] });
  assert.deepEqual(contactsIn("Lives in Lisbon. Birthday 14 March, due 2026-11-02."), { emails: [], phones: [] });
});

test("people: a note names the person by its first words, else by its file; only people notes are people", () => {
  assert.equal(fromNote(note("people-anna-silva.md", "Anna Silva. Lives in: Lisbon. anna@silva.example"))?.name, "Anna Silva");
  assert.equal(fromNote(note("people-rui.md", "Lives in Porto, close friend. rui@example.pt"))?.name, "Rui", "an opening that does not carry the file's name is not the name");
  assert.equal(fromNote(note("style-short.md", "Keep it short. a@b.example")), undefined);
});

test("people: Google Contacts text becomes candidates with every address and phone", () => {
  const c = fromContactsText(CONTACTS);
  assert.deepEqual(c.map((x) => x.name), ["Sam Carter", "Samantha Reyes"]);
  assert.deepEqual(c[0]!.emails, ["sam.carter@example.com", "sam@home.example"]);
  assert.deepEqual(c[0]!.phones, ["+44 7700 900123"]);
  assert.deepEqual(c[1]!.emails, ["samantha@example.org"]);
  assert.deepEqual(fromContactsText("No contacts found matching 'zed' for anna@example.com."), []);
});

test("people: ranking and dedupe by address, confirmed before inferred, a person in two sources is one candidate with both", () => {
  const found = [
    fromNote(note("people-sam-lee.md", "Sam Lee. sam.lee@example.net", true))!,
    ...fromContactsText(CONTACTS),
    fromNote(note("people-sam-carter.md", "Sam Carter. Close friend. sam.carter@example.com"))!,
    fromNote(note("people-bob.md", "Bob Stone. bob@example.com"))!,
  ];
  const r = rank(found, "sam");
  assert.deepEqual(r.map((c) => c.name), ["Sam Carter", "Samantha Reyes", "Sam Lee"], "bob does not match; Sam Carter is one person, found twice; the inferred-only note comes last");
  assert.deepEqual(r[0]!.from.map((f) => f.source).sort(), ["contacts", "notes"]);
  assert.deepEqual(r[0]!.emails, ["sam.carter@example.com", "sam@home.example"]);
  assert.equal(r[2]!.from[0]!.confirmed, false, "the inferred one stays marked");
  assert.deepEqual(rank(found, "sam carter").map((c) => c.name), ["Sam Carter"]);
  assert.deepEqual(rank(found, "SAM.CARTER@example.com").map((c) => c.name), ["Sam Carter"], "an address finds its person");
  assert.ok(matchScore(r[0]!, "sam carter") > matchScore(r[1]!, "sam"));
});

test("people: the notes-only path says what it used and what it could not, and marks an inferred note", async () => {
  const d = notesDir({ "people-sam-carter.md": "Sam Carter. Lives in Leeds. sam.carter@example.com", "people-sam-lee.md": "---\norigin: inferred\n---\nSam Lee. sam.lee@example.net", "style-x.md": "Short. x@y.example" });
  const out = await findPerson("sam", { notesDir: d, contactsWhy: "a group has no contacts of its own" });
  assert.match(out, /Sources used: people notes \(2\)\./);
  assert.match(out, /Not available: Google Contacts \(a group has no contacts of its own\)\./);
  assert.match(out, /Not available: recent correspondents in mail/);
  assert.match(out, /1\. Sam Carter: sam\.carter@example\.com\. From: people-sam-carter\.md\./);
  assert.match(out, /2\. Sam Lee: sam\.lee@example\.net\. From: people-sam-lee\.md \(inferred, not confirmed\)\./);
  assert.match(out, /More than one person fits: show these and ask which/);
  assert.doesNotMatch(out, /x@y\.example/, "only people notes");
  const none = await findPerson("zed", { notesDir: d, contactsWhy: "n/a" });
  assert.match(none, /No one matching "zed"[\s\S]*do not guess an address/);
});

test("people: a source that fails is reported unavailable, the others still answer", async () => {
  const d = notesDir({ "people-sam-carter.md": "Sam Carter. sam.carter@example.com" });
  const out = await findPerson("sam", { notesDir: d, contactsWhy: "", contacts: async () => Promise.reject(new Error("she has not connected Google, or her permission expired")) });
  assert.match(out, /Not available: Google Contacts \(she has not connected Google, or her permission expired\)\./);
  assert.match(out, /1\. Sam Carter: sam\.carter@example\.com/);
  const ok = await findPerson("sam", { notesDir: d, contactsWhy: "", contacts: async () => CONTACTS });
  assert.match(ok, /Sources used: people notes \(1\), Google Contacts\./);
  assert.match(ok, /1\. Sam Carter: sam\.carter@example\.com, sam@home\.example, tel \+44 7700 900123\. From: people-sam-carter\.md; Google Contacts\./);
  assert.match(ok, /Samantha Reyes: samantha@example\.org/);
});

// The tool as a run sees it: the server runtime.ts builds for a conversation, called over an in-memory transport.
async function ask(ctx: Record<string, unknown>, name: string): Promise<string> {
  const cfg = RUNTIME.people!.server!(ctx as never) as unknown as { instance: { connect: (t: unknown) => Promise<void> } };
  const [a, b] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(b);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(a);
  const res = (await client.callTool({ name: "find_person", arguments: { name } })) as { content: { text: string }[] };
  await client.close();
  return res.content[0]!.text;
}
const base = { source: "chat", browsing: false, mode: "owner", offers: () => false, browseRun: async () => ({}) };

test("people: isolation, a group has its own notes only, the owner has hers and no Google Contacts, nobody sees another conversation's", async () => {
  const ownerNotes = notesDir({ "people-sam-owner.md": "Sam Owner. sam@owner.example" });
  const groupNotes = notesDir({ "people-sam-group.md": "Sam Group. sam@group.example" });
  const friendNotes = notesDir({ "people-sam-friend.md": "Sam Friend. sam@friend.example" });
  const o = await ask({ ...base, memory: { dir: ownerNotes } }, "sam");
  assert.match(o, /sam@owner\.example/);
  assert.doesNotMatch(o, /sam@group\.example|sam@friend\.example/);
  assert.match(o, /Not available: Google Contacts \(the Google connectors on the owner's login have no contacts tool\)/);
  const g = await ask({ ...base, source: "group", mode: "group", groupId: "g1", memory: { dir: groupNotes, groupId: "g1" }, offers: () => true }, "sam"); // (even a set that offers everything: a group has no tenant, so no Google)
  assert.match(g, /sam@group\.example/);
  assert.doesNotMatch(g, /sam@owner\.example|sam@friend\.example/);
  assert.match(g, /Not available: Google Contacts \(a group has no contacts of its own\)/);
  const f = await ask({ ...base, source: "group", mode: "group", tenant: { id: "t-anna" }, memory: { dir: friendNotes } }, "sam"); // (her set has no Google: no contacts at all)
  assert.match(f, /sam@friend\.example/);
  assert.doesNotMatch(f, /sam@owner\.example|sam@group\.example/);
  assert.match(f, /Not available: Google Contacts \(she has not connected Google\)/);
});

test("people: a friend's contacts are searched through HER session, with HER address put in last", async () => {
  const seen: { tenant: string; tool: string; args: Record<string, unknown> }[] = [];
  const hubOf = (addr: string) => ({
    session: (tenant: string) => ({ prepare: async () => {}, address: addr, tools: async () => [], call: async (tool: string, args: Record<string, unknown>) => (seen.push({ tenant, tool, args }), { text: CONTACTS, isError: false, content: [] }) }),
  });
  assert.equal(await searchContacts("t-anna", "sam", hubOf("anna@example.com") as never), CONTACTS);
  assert.deepEqual(seen, [{ tenant: "t-anna", tool: "search_contacts", args: { query: "sam", page_size: 10, user_google_email: "anna@example.com" } }]);
  const failing = { session: () => ({ prepare: async () => {}, address: "a@b.example", tools: async () => [], call: async () => ({ text: "denied", isError: true, content: [] }) }) };
  await assert.rejects(searchContacts("t-anna", "sam", failing as never), /connect Google again to allow contacts/);
});

test("people: the tool is in a group's and a friend's set and the owner's; read-only, free, and what it reads is untrusted text", () => {
  const T = "mcp__people__find_person";
  assert.ok(groupTools().has(T));
  assert.ok(toolsFor(new Set(FRIEND_CAPABILITIES)).has(T));
  assert.ok(toolsFor(new Set(CAPABILITIES)).has(T));
  assert.equal(classify(T, { name: "sam" }, "chat"), "allow");
  assert.equal(classify(T, { name: "sam" }, "group"), "allow");
  assert.equal(readsUntrusted(T), true, "contact data is third-party text: a run that read it is a tainted run");
  assert.equal(isFree(T), true);
});

test("people: an address found by Ted is no looser than any other, a send still asks and the floor still names it outside", () => {
  const send = "mcp__claude_ai_Gmail__send_message";
  assert.equal(classify(send, { to: ["sam@example.com"], subject: "hi", body: "hi" }, "chat"), "ask");
  assert.equal(classify("mcp__mailbird__send_message_now", { messageId: "m" }, "chat"), "ask");
  assert.equal(classify("mcp__claude_ai_Google_Calendar__create_event", { attendees: ["sam@example.com"] }, "chat"), "ask");
  // The person typed "send it to Sam": the address Ted found is not in their words, so it is outside (the owner is asked, never the judge).
  const view = { action: "send", to: ["sam.carter@example.com"], cc: [], bcc: [] } as never;
  assert.deepEqual(recipientsOutside(view, {}, { kind: "owner", message: "send it to Sam" } as never), ["sam.carter@example.com"]);
  assert.deepEqual(recipientsOutside(view, {}, { kind: "owner", message: "send it to sam.carter@example.com" } as never), []);
});

test("drive and docs: visible by default for the owner, hidden again by the setting, policy rows as before", () => {
  const defaults = loadSettings({});
  assert.ok(!defaults.hiddenConnectors.some((c) => /Google_(Drive|Docs)/.test(c)));
  assert.ok(defaults.hiddenConnectors.includes("mcp__claude_ai_Claude_Docs"), "Claude Docs stays hidden by default");
  const seen = ["mcp__claude_ai_Google_Drive__search_files", "mcp__claude_ai_Google_Docs__read_doc"];
  const hidden = hiddenTools(seen, loadSettings({}));
  assert.ok(!hidden.includes("mcp__claude_ai_Google_Drive") && !hidden.includes("mcp__claude_ai_Google_Docs"));
  const again = hiddenTools(seen, loadSettings({ HIDDEN_CONNECTORS: "mcp__claude_ai_Google_Drive,mcp__claude_ai_Google_Docs" }));
  assert.ok(again.includes("mcp__claude_ai_Google_Drive") && again.includes("mcp__claude_ai_Google_Docs"));
  const D = "mcp__claude_ai_Google_Drive__";
  const DOC = "mcp__claude_ai_Google_Docs__";
  for (const t of [`${D}search_files`, `${D}read_file_content`, `${D}list_recent_files`, `${D}get_file_permissions`, `${DOC}read_doc`]) assert.equal(classify(t, {}, "chat"), "allow", t);
  for (const t of [`${D}create_file`, `${D}update_file`, `${D}copy_file`, `${D}share_file`, `${D}trash_file`, `${DOC}update_doc`]) assert.equal(classify(t, {}, "chat"), "ask", t);
  for (const t of [`${D}search_files`, `${D}share_file`, `${DOC}read_doc`]) assert.equal(classify(t, {}, "group"), "deny", `${t}: never a group's`);
});

test("drive and docs: the connectors are reported to the owner while down, now that she sees them", () => {
  const keys = reportable().map((r) => r.key);
  assert.ok(keys.includes("drive") && keys.includes("docs"), keys.join(","));
});

test("a friend's Drive is read-only: search, read, list; the server's writes and shares are not offered, and her contacts are reached only through find_person", () => {
  const set = toolsFor(new Set(FRIEND_CAPABILITIES));
  for (const t of ["search_drive_files", "get_drive_file_content", "list_drive_items"]) {
    assert.ok(set.has(GOOGLE_PREFIX + t), t);
    assert.ok(GOOGLE_TOOLS.includes(t));
  }
  for (const t of ["create_drive_file", "update_drive_file", "manage_drive_access", "set_drive_file_permissions", "copy_drive_file", "search_contacts", "manage_contact"]) {
    assert.ok(!set.has(GOOGLE_PREFIX + t), `${t} is not a friend's tool`);
    assert.equal(classify(GOOGLE_PREFIX + t, {}, "group", undefined, set), "deny", t);
  }
  assert.equal(classify(`${GOOGLE_PREFIX}search_drive_files`, { query: "x" }, "group", undefined, set), "allow");
  assert.ok(![...toolsFor(new Set(FRIEND_CAPABILITIES))].some((t) => t.startsWith("mcp__claude_ai_Google_Drive")), "the owner's Drive connector is never a friend's");
});

test("settings: a friend's server loads the contacts and drive tools and asks their read-only scopes by default", () => {
  const s = loadSettings({}).google;
  assert.deepEqual(s.args.slice(s.args.indexOf("--tools")), ["--tools", "gmail", "calendar", "contacts", "drive"]);
  assert.ok(s.scopes.includes("https://www.googleapis.com/auth/contacts.readonly") && s.scopes.includes("https://www.googleapis.com/auth/drive.readonly"));
  assert.ok(!s.scopes.some((x) => /auth\/(contacts|drive)$/.test(x)), "no write scope for contacts or Drive");
});
