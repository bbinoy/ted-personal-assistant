import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The heartbeat run is ONE mechanism for the owner, a group and a friend (agent.ts heartbeatOptions): what differs is data from the conversation's capability set.
// Here, for a friend and a group: the options of the run (isolation, her key and ledger, her tools, her notes as data and none of the owner's, the experts only
// where she has something to read), the text it is told, and the permission path it passes (her approver, the never-allowed set, nothing outside her tools).
const dir = mkdtempSync(join(tmpdir(), "heartbeat-conv-"));
process.env.HARNESS_DATA_DIR = dir;
process.env.GOOGLE_OAUTH_CLIENT_ID = "fake-client-id.example";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "fake-client-secret-not-real";
process.env.CLAUDE_CODE_OAUTH_TOKEN = "owner-oauth-token"; // the instance's own login, which a friend's run must never carry
process.env.TENANTS = "on";

const { settings } = await import("../src/core/settings.ts");
const T = await import("../src/tenants/tenants.ts");
const { heartbeatOptions } = await import("../src/run/agent.ts");
const { buildOptions } = await import("../src/run/agentrun.ts");
const { group, owner, tenant } = await import("../src/conversation/conversation.ts");
const { LOGIN } = await import("../src/tenants/payer.ts");
const { lookerOf, hasSomethingToLookAt, unattendedTools } = await import("../src/run/scope.ts");
const { lookInstruction } = await import("../src/heartbeat/look.ts");
const { NOTES_DIR } = await import("../src/memory/notes.ts");
const { GOOGLE_MAIL_TOOL } = await import("../src/modules/google/module.ts");
const { groupTools } = await import("../src/policy/capabilities.ts");

const on = settings as unknown as Record<string, unknown>;
// Every friend has her own Google once the instance has the OAuth client; one "without Google" is a friend on an instance that has none.
const googleCfg = settings.google as { clientId?: string };
const withoutGoogle = <R,>(fn: () => R): R => {
  const was = googleCfg.clientId;
  googleCfg.clientId = undefined;
  try {
    return fn();
  } finally {
    googleCfg.clientId = was;
  }
};
on.tenants = true;
const KEY = "instance-key-not-real";
const NOW = new Date(2026, 9, 14, 14, 0, 0);
const signal = new AbortController().signal;

let n = 0;
function friend(name: string): string {
  const rec = T.addTenant({ aci: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, name })!;
  T.provision(rec);
  return rec.id;
}
const payerOf = (id: string) => ({ kind: "instance" as const, id, apiKey: KEY, ledger: T.tenantContext(T.tenantById(id)!).ledger });
const note = (id: string, file: string, text: string) => writeFileSync(join(T.tenantContext(T.tenantById(id)!).notesDir, file), text);
const system = (o: { systemPrompt: string }) => o.systemPrompt;

test("a friend with Google: an isolated, fresh run on her key and ledger, with her tools only, her notes as data, and the expert", () => {
  const id = friend("Ana");
  note(id, "people-sister.md", "Her sister is called Eve.");
  mkdirSync(NOTES_DIR, { recursive: true });
  writeFileSync(join(NOTES_DIR, "context-ben-secret.md"), "The owner's private fact.");
  const conv = tenant(id);
  const o = heartbeatOptions(conv, payerOf(id), { provenance: { kind: "standing", task: "THE LOOK" } }, NOW);
  assert.equal(o.source, "group", "the isolated policy source: none of the owner's data");
  assert.deepEqual([o.sessionFile, o.memory, o.seenAt], [undefined, undefined, undefined], "a fresh session, no auto-memory: a run that reads mail cannot write notes");
  assert.equal(o.model, settings.heartbeatModel);
  assert.ok(o.outputFormat);
  assert.deepEqual(o.provenance?.(), { kind: "standing", task: "THE LOOK" });
  assert.equal(o.conversation, `tenant:${id}`);
  assert.deepEqual([o.tenant?.id, o.tenant?.apiKey, o.tenant?.ledger], [id, KEY, T.tenantContext(T.tenantById(id)!).ledger], "her ledger: what the run costs is hers");
  assert.ok(o.maxBudgetUsd <= T.tenantContext(T.tenantById(id)!).maxBudgetUsdPerRun, "held to her own per-run ceiling");
  const tools = [...(o.tools ?? [])];
  assert.ok(tools.includes(GOOGLE_MAIL_TOOL), "her own mail");
  assert.ok(tools.every((t) => !/^mcp__(claude_ai|mailbird)/.test(t)), "none of the owner's connectors");
  assert.ok(!tools.some((t) => ["Read", "Write", "Edit"].includes(t)), "no file tools: her notes are in the prompt");
  assert.ok(tools.includes("mcp__send__send"), "the chat's own send is hers too");

  const b = buildOptions(async () => ({ approved: false }), o, undefined);
  assert.equal(b.strictMcpConfig, true);
  assert.deepEqual(b.settingSources, []);
  const servers = Object.keys(b.mcpServers as object);
  assert.ok(servers.includes("google") && servers.includes("send"));
  assert.ok(!servers.includes("status") && !servers.includes("memory") && !servers.includes("mailbird"), servers.join(","));
  assert.ok((b.tools as string[]).includes("Agent") && b.agents && Object.keys(b.agents).includes("expert"), "she can read mail: she may delegate heavy work");
  assert.equal(b.hooks!.PreToolUse!.length, 1);
  const env = b.env as Record<string, string | undefined>;
  assert.equal(env.ANTHROPIC_API_KEY, KEY);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, "never the owner's login");

  const prompt = system(o);
  assert.match(prompt, /chatting privately on Signal with Ana/);
  assert.match(prompt, /Her sister is called Eve/, "her notes, as data");
  assert.doesNotMatch(prompt, /private fact/, "nothing of the owner's notes");
  assert.doesNotMatch(prompt, new RegExp(`${settings.owner}'s personal assistant`));
  assert.match(system({ systemPrompt: (o.experts!.setup.agents.expert as { prompt: string }).prompt }), /working for Ana/, "the expert is told whom it works for, with the same notes");
  assert.match((o.experts!.setup.agents.expert as { prompt: string }).prompt, /Her sister is called Eve/);
  assert.ok(!Object.keys(o.experts!.setup.agents).some((a) => /daily-brief/.test(a)), "the brief is the owner's skill");
});

test("a friend's run passes the same permission path: her approver, outside her tools nothing, the never-allowed set stays denied", async () => {
  const id = friend("Bea");
  const o = heartbeatOptions(tenant(id), payerOf(id), { provenance: { kind: "standing", task: "T" } }, NOW);
  const asked: string[] = [];
  const b = buildOptions(async (d) => (asked.push(d), { approved: false }), o, undefined);
  const can = b.canUseTool! as unknown as (tool: string, input: Record<string, unknown>, opts: unknown) => Promise<{ behavior: string }>;
  const was = settings.autoApprove;
  on.autoApprove = "off";
  try {
    assert.equal((await can("mcp__google__search_gmail_messages", { query: "is:unread" }, { signal } as never)).behavior, "allow", "a read is free");
    const send = await can("mcp__google__send_gmail_message", { to: "carl@example.org", subject: "s", body: "b" }, { signal } as never);
    assert.equal(send.behavior, "deny", "she declined in this stub");
    assert.equal(asked.length, 1, "the question goes to the approver of the run (hers), with the recipient shown");
    assert.match(asked[0]!, /carl@example\.org/);
    assert.equal((await can("mcp__google__modify_gmail_message_labels", { message_id: "m", add_label_ids: ["TRASH"] }, { signal } as never)).behavior, "deny", "trash is never allowed");
    assert.equal((await can("mcp__mailbird__send_message_now", {}, { signal } as never)).behavior, "deny", "not a tool of hers");
    assert.equal((await can("Write", { file_path: join(T.tenantContext(T.tenantById(id)!).notesDir, "people-x.md"), content: "x" }, { signal } as never)).behavior, "deny", "no note writes in a run that reads mail");
    assert.equal(asked.length, 1);
  } finally {
    on.autoApprove = was;
  }
});

test("a friend on an instance without Google has no expert and no mail in her instruction; a group the same, in its own words", () => {
  const id = friend("Cy");
  const looker = withoutGoogle(() => lookerOf(tenant(id)));
  assert.deepEqual([looker.reads, looker.mail, looker.experts, looker.brief, looker.own, looker.group], [false, false, false, false, false, false]);
  const o = withoutGoogle(() => heartbeatOptions(tenant(id), payerOf(id), {}, NOW));
  assert.equal(o.experts, undefined);
  const b = withoutGoogle(() => buildOptions(async () => ({ approved: false }), o, undefined));
  assert.ok(!(b.tools as string[]).includes("Agent"));
  assert.equal(b.agents, undefined);
  assert.equal(b.hooks!.PreToolUse, undefined);
  const text = lookInstruction(NOW, undefined, looker);
  assert.match(text, /Cy's local time/);
  assert.match(text, /do nothing unprompted/);
  assert.doesNotMatch(text, /expert|archive|calendar for the next 36 hours|status-brief/i);

  const g = group("hb-conv-group-0123456789abcd");
  const gl = lookerOf(g);
  assert.deepEqual([gl.who, gl.group, gl.reads, gl.experts], ["the group", true, false, false]);
  const go = heartbeatOptions(g, LOGIN, {}, NOW);
  assert.equal(go.source, "group");
  assert.equal(go.groupId, g.groupId, "its send and its questions go to the group");
  assert.deepEqual([...go.tools!].sort(), [...unattendedTools(groupTools())].sort(), "the group's capability set, less the notes' file tools");
  assert.deepEqual([go.sessionFile, go.memory, go.tenant], [undefined, undefined, undefined]);
  assert.ok(go.maxBudgetUsd <= 0.5);
  assert.match(system(go), /in a group chat on Signal/);
  const gb = buildOptions(async () => ({ approved: false }), go, undefined);
  assert.ok(Object.keys(gb.mcpServers as object).includes("send"), "it may speak in its own group");
  assert.match(lookInstruction(NOW, undefined, gl), /The group can override this/);
});

test("the owner's run is unchanged by all of it: the login, the background source, every connector, the status note", () => {
  const o = heartbeatOptions(owner(), LOGIN, {}, NOW);
  assert.equal(o.source, "background");
  assert.equal(o.tools, undefined, "no isolation: the owner's whole set of connectors");
  assert.equal(o.tenant, undefined);
  assert.ok(o.experts);
  const l = lookerOf(owner());
  assert.deepEqual([l.own, l.reads, l.mail, l.experts, l.brief], [true, true, true, true, true]);
  assert.match(l.sources, /^the inbox mail you have not looked at yet \(see below\), the calendar for the next 36 hours, tasks, and your notes and their schedules$/);
});

test("something to look at: mail or a calendar (her own Google, once the instance has the OAuth client), or a note; nothing else opens a look", () => {
  const plain = friend("Di");
  const google = friend("Ed");
  assert.equal(withoutGoogle(() => hasSomethingToLookAt(tenant(plain), NOW)), false, "no Google set up on the instance: no mail, nothing to look at");
  assert.equal(hasSomethingToLookAt(tenant(google), NOW), true, "her own Google: there is mail and a calendar to look at");
  note(plain, "scheduling-fact.md", "Post a fun fact every morning.");
  assert.equal(hasSomethingToLookAt(tenant(plain), NOW), true, "a note");
  note(plain, "context-old.md", "---\nexpires: 2026-10-13\n---\nOld news.");
  const expired = friend("Flo");
  note(expired, "context-old.md", "---\nexpires: 2026-10-13\n---\nOld news.");
  assert.equal(withoutGoogle(() => hasSomethingToLookAt(tenant(expired), NOW)), false, "an expired note is no note");
  assert.equal(hasSomethingToLookAt(owner(), NOW), true);
  assert.equal(hasSomethingToLookAt(group("hb-conv-empty-0123456789abcdef"), NOW), false);
});
