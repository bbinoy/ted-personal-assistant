import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tick as settle } from "./util.ts";
import { FRIEND_CHAT, GROUP_CHAT, OWNER_CHAT, OWNER_LOOK } from "./runkinds.ts";

// The admin is the owner's chat: its powers are the instance's (invites, suspend and remove with approval, groups, logs of the instance), not a
// person's. Nobody reaches another person's folder through the assistant, the admin included: the tenant's notes, history, session and ledger are not
// readable or writable from the owner's chat, every other conversation folder, `instance/` and `state/openbao/` are shut to every tool, and the audit log (the admin's search_logs)
// holds no word of a tenant's chat. The host's own administrator can of course read the files on the Mac (docs/SAFETY.md).
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "admin-isolation-"));

const { settings } = await import("../src/core/settings.ts");
const { convPaths, conversationsDir, friendConvId, instancePaths, OWNER_CONV } = await import("../src/core/convpaths.ts");
const T = await import("../src/tenants/tenants.ts");
const { resolveCapabilities, toolsFor: toolsForCaps } = await import("../src/policy/capabilities.ts");
const tenantCapabilities = (ctx: { config: any }) => resolveCapabilities(T.FRIEND_CAPABILITIES, { own: ctx.config }); // (a context not in the registry: the pure step of capabilitiesOf)
const tenantTools = (ctx: { config: any }) => toolsForCaps(tenantCapabilities(ctx), FRIEND_CHAT);
const { classify, isReadableData } = await import("../src/policy/policy.ts");
const { NOTES_DIR } = await import("../src/memory/notes.ts");
const MANIFEST = (await import("../src/policy/toolmanifest.ts")).allRows();
const { searchLogs } = await import("../src/core/logsearch.ts");
const { describeTenants } = await import("../src/tenants/tenanttools.ts");
const approvals = await import("../src/approvals/approvals.ts");
const { makeApprove } = await import("../src/approvals/approvalask.ts");
const { makeCanUseTool } = await import("../src/approvals/permissions.ts");
const { buildOptions } = await import("../src/run/agentrun.ts");

const CANARY = "CANARY-ANN-4242";
const rec = T.addTenant({ aci: "00000000-0000-4000-8000-000000000001", name: "Ann" })!;
const ann = T.tenantContext(rec);
const annDb = convPaths(ann.convId).db; // her assistant.db: a private file of hers like the rest
const ownerNotes = join(NOTES_DIR, "context-own.md");
mkdirSync(NOTES_DIR, { recursive: true });
writeFileSync(ownerNotes, "the owner's own note");
for (const [dir, file] of [[ann.notesDir, "people-eve.md"], [ann.dir, "tenant.json"], [ann.dir, "meta.json"], [ann.dir, "cost.json"]] as const) writeFileSync(join(dir, file), `{"text":"${CANARY}"}`);
writeFileSync(ann.logFile, `{"ts":1,"kind":"owner","text":"${CANARY}"}\n`);
(await import("../src/core/convdb.ts")).convDb(ann.convId).run("INSERT INTO session (id, session_id, cost_usd) VALUES (1, ?, 0)", CANARY); // (a real database: a junk file would be a damaged one)
const bao = instancePaths().openbao;
mkdirSync(join(bao, "tls"), { recursive: true });
writeFileSync(join(bao, "tls", "key.pem"), "private");
writeFileSync(join(bao, "config.hcl"), "listener");
mkdirSync(instancePaths().dir, { recursive: true });
writeFileSync(instancePaths().registrations, "{}");
// links from the places the owner's file tools do reach, into hers and into the secret store
mkdirSync(convPaths(OWNER_CONV).dir, { recursive: true });
mkdirSync(settings.logsDir, { recursive: true });
symlinkSync(ann.dir, join(NOTES_DIR, "to-ann"));
symlinkSync(ann.notesDir, join(convPaths(OWNER_CONV).dir, "to-ann-notes"));
symlinkSync(bao, join(instancePaths().installed, "to-bao"));

const HERS = [
  join(ann.notesDir, "people-eve.md"), ann.logFile, annDb, join(ann.dir, "tenant.json"), join(ann.dir, "meta.json"), join(ann.dir, "cost.json"),
  ann.dir, ann.notesDir, conversationsDir(), join(conversationsDir(), "tenants.json"),
  join(NOTES_DIR, "..", "..", friendConvId(ann.id), "notes", "people-eve.md"), // out of the notes with ..
  join(NOTES_DIR, "to-ann", "tenant.json"), join(NOTES_DIR, "to-ann", "notes", "people-eve.md"), join(convPaths(OWNER_CONV).dir, "to-ann-notes", "people-eve.md"), // through a link
];
mkdirSync(settings.intake.dir, { recursive: true }); // (the open links, hashed: the real folder is instance/intake/, not a file)
writeFileSync(join(settings.intake.dir, "0123abcd.json"), "{}");
const SECRETS = [settings.intake.dir, join(settings.intake.dir, "0123abcd.json"), bao, join(bao, "tls", "key.pem"), join(bao, "config.hcl"), instancePaths().registrations, instancePaths().tenants, join(instancePaths().installed, "to-bao", "tls", "key.pem")];

test("the admin's file tools: Read, Write and Edit reach none of a tenant's files, `tenants/` or the secret store", () => {
  for (const path of [...HERS, ...SECRETS]) {
    for (const tool of ["Read", "Write", "Edit"]) assert.equal(classify(tool, { file_path: path }, OWNER_CHAT), "deny", `${tool} ${path}`);
    assert.equal(isReadableData(path), false, path);
  }
  // her own folder is as it always was
  assert.equal(classify("Write", { file_path: join(NOTES_DIR, "context-new.md") }, OWNER_CHAT), "allow");
  assert.equal(classify("Read", { file_path: ownerNotes }, OWNER_CHAT), "allow");
  assert.equal(classify("Read", { file_path: instancePaths().tenants }, OWNER_CHAT), "deny", "the registry holds every friend's name and account id");
});

test("no run of the instance has Glob, Grep or Bash (they could list and read any folder): the built-in file tools are Read, Write and Edit, each confined by path", () => {
  const probes: [string, Record<string, unknown>][] = [
    ["Glob", { pattern: "**/*", path: conversationsDir() }],
    ["Grep", { pattern: CANARY, path: conversationsDir() }],
    ["Bash", { command: `cat ${join(ann.notesDir, "people-eve.md")}` }],
    ["Bash", { command: `ls ${conversationsDir()} ${bao}` }],
    ["NotebookEdit", { notebook_path: join(ann.notesDir, "x.ipynb") }],
  ];
  // not offered to the model at all (agentrun.ts builtinTools), and a group's or a tenant's classify refuses them outright
  const ownerOpts = { conversation: "owner", systemPrompt: "x", sessionConv: OWNER_CONV, maxTurns: 3, maxBudgetUsd: 1 };
  const runs = [
    buildOptions(() => Promise.resolve({ approved: false }), { ...ownerOpts, kind: OWNER_CHAT, memory: { dir: NOTES_DIR } }, undefined),
    buildOptions(() => Promise.resolve({ approved: false }), { ...ownerOpts, kind: OWNER_LOOK }, undefined),
    buildOptions(() => Promise.resolve({ approved: false }), { ...ownerOpts, kind: GROUP_CHAT, memory: { dir: ann.notesDir }, tenant: undefined }, undefined),
  ];
  for (const o of runs) assert.ok((o.tools as string[]).every((t) => ["Skill", "Read", "Write", "Edit", "WebSearch", "WebFetch"].includes(t)), String(o.tools));
  for (const [tool, input] of probes) assert.equal(classify(tool, input, GROUP_CHAT, ann.notesDir, tenantTools(ann)), "deny", tool);
  for (const [tool, input] of probes) assert.notEqual(classify(tool, input, OWNER_CHAT), "allow", tool);
  assert.deepEqual([...new Set(MANIFEST.filter((e) => !e.tool.startsWith("mcp__")).map((e) => e.tool))].sort(), ["Edit", "Read", "Skill", "WebFetch", "WebSearch", "Write"]);
});

test("the admin's powers are the instance's: invites, list, suspend, resume and remove, and nothing that reads what a tenant said", () => {
  const admin = MANIFEST.filter((e) => e.tool.startsWith("mcp__tenants__")).map((e) => e.tool.split("__")[2]).sort();
  assert.deepEqual(admin, ["invite_person", "list_tenants", "remove_tenant", "resume_tenant", "suspend_tenant"]);
  assert.equal(classify("mcp__tenants__suspend_tenant", { id: ann.id }, OWNER_CHAT), "ask");
  assert.equal(classify("mcp__tenants__remove_tenant", { id: ann.id }, OWNER_CHAT), "ask");
  assert.equal(classify("mcp__tenants__invite_person", { recipient: "+15555550114" }, OWNER_CHAT), "ask", "the first hello to a person always asks the owner");
  // what list_tenants shows is the record: no note, no history line
  const listed = describeTenants().join("\n");
  assert.match(listed, new RegExp(ann.id));
  assert.doesNotMatch(listed, new RegExp(CANARY));
  assert.doesNotMatch(listed, /people-eve|region/i);
});

const call = { tool: "WebSearch", input: { query: `${CANARY} dentist` } };
const search = (dir = settings.logsDir) => searchLogs(dir, { query: CANARY });

test("search_logs for the admin: a tenant's approvals, replies, searches and judge reasons leave no word in the audit log; the owner's own rows are unchanged", async () => {
  // a tenant's run: a web search (its query is logged for the owner's runs) and an approval answered in her chat
  const tenantRun = makeCanUseTool(async () => ({ approved: true }), GROUP_CHAT, ann.notesDir, undefined, undefined, tenantTools(ann), true);
  await tenantRun("WebSearch", call.input, { signal: new AbortController().signal } as never);
  let ts = 100;
  const ask = (scope: string, source: "chat" | "group") => {
    const approve = makeApprove(async () => ++ts, { scope, source, compose: async () => ({ text: `Create the event ${CANARY}?`, ms: 1 }) });
    return approve(`Create the event ${CANARY}`, { tool: "mcp__x__y", input: { summary: CANARY } }, new AbortController().signal);
  };
  const hers = ask(`tenant:${ann.id}`, "group");
  await settle();
  assert.equal(approvals.answerReaction("🤷", ts, `tenant:${ann.id}`), "ignored");
  assert.deepEqual(await approvals.answer(`yes ${CANARY}`, () => {}, undefined, { judge: async () => undefined, recent: () => [] }, { scope: `tenant:${ann.id}`, by: "ann" }), { outcome: "feedback" }); // the judge failed: her words come back as feedback
  assert.equal((await hers).approved, false);
  const again = ask(`tenant:${ann.id}`, "group");
  await settle();
  assert.deepEqual(await approvals.answer("yes", () => {}, undefined, {}, { scope: `tenant:${ann.id}`, by: "ann" }), { outcome: "approved" });
  await again;
  assert.equal(search(), "No matching lines.", "nothing of hers is in logs/");
  assert.match(searchLogs(settings.logsDir, { query: "approval-asked" }), /approval-asked/, "the rows are there, without her words");
  // the same calls in the owner's chat keep their content: nothing about the owner's rows changed
  const mine = ask("owner", "chat");
  await settle();
  assert.deepEqual(await approvals.answer("yes", () => {}, undefined, {}, { scope: "owner", by: "me" }), { outcome: "approved" });
  await mine;
  assert.match(search(), new RegExp(CANARY));
  // and search_logs of the admin reads logs/ only: her history, session and notes are not in it
  assert.doesNotMatch(searchLogs(settings.logsDir, { query: "people-eve" }), /people-eve/);
});
