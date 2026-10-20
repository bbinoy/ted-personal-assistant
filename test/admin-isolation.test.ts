import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tick as settle } from "./util.ts";

// The admin is the owner's chat: its powers are the instance's (invites, suspend and remove with approval, groups, logs of the instance), not a
// person's. Nobody reaches another person's folder through the assistant, the admin included: the tenant's notes, history, session and ledger are not
// readable or writable from the owner's chat, `tenants/` and `state/openbao/` are shut to every tool, and the audit log (the admin's search_logs)
// holds no word of a tenant's chat. The host's own administrator can of course read the files on the Mac (docs/SAFETY.md).
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "admin-isolation-"));

const { settings } = await import("../src/settings.ts");
const T = await import("../src/tenants.ts");
const { tenantTools } = await import("../src/capabilities.ts");
const { classify, isReadableData } = await import("../src/policy.ts");
const { NOTES_DIR } = await import("../src/notes.ts");
const MANIFEST = (await import("../src/toolmanifest.ts")).allRows();
const { searchLogs } = await import("../src/logsearch.ts");
const { describeTenants } = await import("../src/tenanttools.ts");
const approvals = await import("../src/approvals.ts");
const { makeApprove } = await import("../src/approvalask.ts");
const { makeCanUseTool } = await import("../src/permissions.ts");
const { buildOptions } = await import("../src/agentrun.ts");

const CANARY = "CANARY-ANN-4242";
const made = T.mintInvite()!;
const rec = T.redeemInvite(made.code, { aci: "00000000-0000-4000-8000-000000000001", name: "Ann" })!;
const ann = T.tenantContext(rec);
const ownerNotes = join(NOTES_DIR, "context-own.md");
mkdirSync(NOTES_DIR, { recursive: true });
writeFileSync(ownerNotes, "the owner's own note");
for (const [dir, file] of [[ann.notesDir, "people-eve.md"], [ann.dir, "tenant.json"], [ann.dir, "consent.json"], [ann.dir, "cost.json"]] as const) writeFileSync(join(dir, file), `{"text":"${CANARY}"}`);
writeFileSync(ann.logFile, `{"ts":1,"kind":"owner","text":"${CANARY}"}\n`);
writeFileSync(ann.sessionFile, `{"id":"${CANARY}"}`);
const bao = join(settings.stateDir, "openbao");
mkdirSync(join(bao, "tls"), { recursive: true });
writeFileSync(join(bao, "tls", "key.pem"), "private");
writeFileSync(join(bao, "config.hcl"), "listener");
writeFileSync(join(settings.stateDir, "invites.json"), "{}");
// links from the places the owner's file tools do reach, into hers and into the secret store
mkdirSync(settings.memoryDir, { recursive: true });
mkdirSync(settings.logsDir, { recursive: true });
symlinkSync(ann.dir, join(NOTES_DIR, "to-ann"));
symlinkSync(ann.notesDir, join(settings.memoryDir, "to-ann-notes"));
symlinkSync(bao, join(settings.stateDir, "to-bao"));

const HERS = [
  join(ann.notesDir, "people-eve.md"), ann.logFile, ann.sessionFile, join(ann.dir, "tenant.json"), join(ann.dir, "consent.json"), join(ann.dir, "cost.json"),
  ann.dir, ann.notesDir, settings.tenantsDir, join(settings.tenantsDir, "tenants.json"),
  join(NOTES_DIR, "..", "..", "tenants", ann.id, "notes", "people-eve.md"), // out of the notes with ..
  join(NOTES_DIR, "to-ann", "tenant.json"), join(NOTES_DIR, "to-ann", "notes", "people-eve.md"), join(settings.memoryDir, "to-ann-notes", "people-eve.md"), // through a link
];
const SECRETS = [bao, join(bao, "tls", "key.pem"), join(bao, "config.hcl"), join(settings.stateDir, "invites.json"), join(settings.stateDir, "to-bao", "tls", "key.pem")];

test("the admin's file tools: Read, Write and Edit reach none of a tenant's files, `tenants/` or the secret store", () => {
  for (const path of [...HERS, ...SECRETS]) {
    for (const tool of ["Read", "Write", "Edit"]) assert.equal(classify(tool, { file_path: path }, "chat"), "deny", `${tool} ${path}`);
    assert.equal(isReadableData(path), false, path);
  }
  // her own folder is as it always was
  assert.equal(classify("Write", { file_path: join(NOTES_DIR, "context-new.md") }, "chat"), "allow");
  assert.equal(classify("Read", { file_path: ownerNotes }, "chat"), "allow");
  assert.equal(classify("Read", { file_path: join(settings.stateDir, "tenants.json") }, "chat"), "allow", "the registry holds ids and status, no words");
});

test("no run of the instance has Glob, Grep or Bash (they could list and read any folder): the built-in file tools are Read, Write and Edit, each confined by path", () => {
  const probes: [string, Record<string, unknown>][] = [
    ["Glob", { pattern: "**/*", path: settings.tenantsDir }],
    ["Grep", { pattern: CANARY, path: settings.tenantsDir }],
    ["Bash", { command: `cat ${join(ann.notesDir, "people-eve.md")}` }],
    ["Bash", { command: `ls ${settings.tenantsDir} ${bao}` }],
    ["NotebookEdit", { notebook_path: join(ann.notesDir, "x.ipynb") }],
  ];
  // not offered to the model at all (agentrun.ts builtinTools), and a group's or a tenant's classify refuses them outright
  const ownerOpts = { systemPrompt: "x", sessionFile: "state/session.json", maxTurns: 3, maxBudgetUsd: 1 };
  const runs = [
    buildOptions(() => Promise.resolve({ approved: false }), { ...ownerOpts, source: "chat", memory: { dir: NOTES_DIR } }, undefined),
    ...(["background", "brief", "handler", "radar", "dream", "heartbeat"] as const).map((source) => buildOptions(() => Promise.resolve({ approved: false }), { ...ownerOpts, source }, undefined)),
    buildOptions(() => Promise.resolve({ approved: false }), { ...ownerOpts, source: "group", memory: { dir: ann.notesDir }, tenant: undefined }, undefined),
  ];
  for (const o of runs) assert.ok((o.tools as string[]).every((t) => ["Skill", "Read", "Write", "Edit", "WebSearch", "WebFetch"].includes(t)), String(o.tools));
  for (const [tool, input] of probes) assert.equal(classify(tool, input, "group", ann.notesDir, tenantTools(ann)), "deny", tool);
  for (const [tool, input] of probes) assert.notEqual(classify(tool, input, "chat"), "allow", tool);
  assert.deepEqual([...new Set(MANIFEST.filter((e) => !e.tool.startsWith("mcp__")).map((e) => e.tool))].sort(), ["Edit", "Read", "Skill", "WebFetch", "WebSearch", "Write"]);
});

test("the admin's powers are the instance's: invites, list, suspend, resume and remove, and nothing that reads what a tenant said", () => {
  const admin = MANIFEST.filter((e) => e.tool.startsWith("mcp__tenants__")).map((e) => e.tool.split("__")[2]).sort();
  assert.deepEqual(admin, ["create_invite", "list_tenants", "remove_tenant", "resume_tenant", "suspend_tenant"]);
  assert.equal(classify("mcp__tenants__suspend_tenant", { id: ann.id }, "chat"), "ask");
  assert.equal(classify("mcp__tenants__remove_tenant", { id: ann.id }, "chat"), "ask");
  // what list_tenants shows is the record: no note, no history line, no consent region
  const listed = describeTenants().join("\n");
  assert.match(listed, new RegExp(ann.id));
  assert.doesNotMatch(listed, new RegExp(CANARY));
  assert.doesNotMatch(listed, /people-eve|region/i);
});

const call = { tool: "WebSearch", input: { query: `${CANARY} dentist` } };
const search = (dir = settings.logsDir) => searchLogs(dir, { query: CANARY });

test("search_logs for the admin: a tenant's approvals, replies, searches and judge reasons leave no word in the audit log; the owner's own rows are unchanged", async () => {
  // a tenant's run: a web search (its query is logged for the owner's runs) and an approval answered in her chat
  const tenantRun = makeCanUseTool(async () => ({ approved: true }), "group", ann.notesDir, undefined, undefined, tenantTools(ann), true);
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
