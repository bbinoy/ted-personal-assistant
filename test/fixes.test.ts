import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { AuthError, causeOf, failure, FIXES, InstanceKeyError, noticeFor, RateLimitError, type Cause } from "../src/tenants/errors.ts";
import { RunTimeout } from "../src/run/ceiling.ts";
import { KEY_FACTS } from "../src/tenants/keynotice.ts";

process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "fixes-test-"));
const { appendRow } = await import("../src/core/looks.ts");
const { failingLooksFact } = await import("../src/heartbeat/facts.ts");
const { instanceDb } = await import("../src/core/instancedb.ts");
const resetLooks = () => void instanceDb().run("DELETE FROM looks");

const CAUSES = Object.keys(FIXES) as Cause[];
const SAMPLES: Record<Cause, unknown> = {
  login: new AuthError("x"),
  limit: new RateLimitError("x"),
  billing: new InstanceKeyError("billing"),
  refused: new InstanceKeyError("refused"),
  timeout: new RunTimeout(60_000),
  connector: new Error("MCP server notion failed to connect"),
  reconnect: new Error("her Google permission expired or was withdrawn"),
  other: new Error("agent turn ended with error_during_execution"),
};
// A next step names a command in backticks, a setting in .env, or a place in the Claude app, or says plainly that it needs none.
const STEP = /`[^`]+`|\b[A-Z][A-Z_]{5,}\b|Settings > Connectors|lifts by itself|message me/;
const SECRETS = /sk-ant|Bearer|token=|password|https?:\/\/|\/i\/[A-Za-z0-9_-]{8,}/i;

test("every cause maps to one fix, and each cause is recognised from its error", () => {
  assert.deepEqual(CAUSES.slice().sort(), ["billing", "connector", "limit", "login", "other", "reconnect", "refused", "timeout"]);
  for (const c of CAUSES) {
    assert.equal(causeOf(SAMPLES[c]), c, c);
    assert.match(FIXES[c].fix, STEP, `${c} names its step`);
    assert.match(FIXES[c].fix, /[.)]$/, `${c} is one finished sentence`);
    assert.doesNotMatch(FIXES[c].what + FIXES[c].fix, SECRETS, `${c} holds no secret or link`);
  }
  assert.match(FIXES.login.fix, /claude auth login/);
  assert.match(FIXES.connector.fix, /Settings > Connectors/);
  assert.match(FIXES.reconnect.fix, /reconnect Google/);
  assert.equal(causeOf(new Error("she has not connected Notion yet")), "reconnect");
});

test("the failing-looks fact carries the cause's what and fix, for the owner only; one failure or a good look after it gives none", () => {
  const row = (outcome: "failed" | "silent", cause?: string, n = 0) => ({ at: new Date(2026, 9, 14, 12, n).toISOString(), kind: "owner" as const, night: false, message: false, nextCheckMinutes: 30, costUsd: 0, toolCalls: 0, archived: 0, delegations: 0, outcome, ...(cause ? { cause } : {}) });
  const owner = { kind: "owner" } as never;
  for (const c of CAUSES) {
    resetLooks();
    appendRow(row("failed", c, 1));
    assert.equal(failingLooksFact(owner), "", "one failure is not a fact");
    appendRow(row("failed", c, 2));
    const fact = failingLooksFact(owner);
    assert.ok(fact.includes(FIXES[c].what) && fact.includes(FIXES[c].fix), `${c}: ${fact}`);
    assert.equal(failingLooksFact({ kind: "group" } as never), "");
    appendRow(row("silent", undefined, 3));
    assert.equal(failingLooksFact(owner), "", "a look that works ends it");
  }
  assert.match(FIXES.timeout.fix, /RUN_MAX_MINUTES_CHAT/, "the one ceiling of every run");
});

test("the owner's chat failure notices end with the step for their cause; friends and groups are sent to no terminal", () => {
  for (const c of CAUSES) {
    if (c === "timeout") continue; // (a chat turn's own ceiling, below)
    if (c === "reconnect") continue; // (a friend's broken connection is a fact for her next look, systemstatus.test.ts)
    const text = noticeFor("owner")(SAMPLES[c])!;
    if (c === "other") assert.ok(text.endsWith(FIXES.other.fix), text);
    else assert.ok(text.endsWith(FIXES[c].fix), `${c}: ${text}`);
    assert.doesNotMatch(text, SECRETS);
    for (const a of ["friend", "group"] as const) assert.doesNotMatch(noticeFor(a)(SAMPLES[c]) ?? "", /npm run|claude auth|\.env|Settings > Connectors/, `${c} for ${a}`);
  }
  assert.match(noticeFor("owner")(SAMPLES.timeout)!, /RUN_MAX_MINUTES_CHAT in \.env and restart/);
});

test("the shared-key facts each end with the exact setting", () => {
  const told = [KEY_FACTS.refused, KEY_FACTS.missing];
  assert.match(told[0]!, /check TENANT_ANTHROPIC_API_KEY in \.env, then restart\.$/);
  assert.match(told[1]!, /and restart\.$/);
  for (const t of told) assert.doesNotMatch(t, SECRETS);
});

test("authentication_failed on the login payer is the login cause; a sleeping look is skipped when counting failures; an unknown cause still counts", () => {
  assert.equal(causeOf(failure("authentication_failed", "error_during_execution")), "login");
  resetLooks();
  const at = (n: number) => new Date(2026, 9, 14, 12, n).toISOString();
  const base = { kind: "owner" as const, night: false, message: false, nextCheckMinutes: 30, costUsd: 0, toolCalls: 0, archived: 0, delegations: 0 };
  appendRow({ ...base, at: at(1), outcome: "failed", cause: "login" });
  appendRow({ ...base, at: at(2), outcome: "failed", cause: "slept" });
  assert.equal(failingLooksFact({ kind: "owner" } as never), "", "the sleep is neither a failure nor an end: one failure");
  appendRow({ ...base, at: at(3), outcome: "failed", cause: "something-new" });
  const fact = failingLooksFact({ kind: "owner" } as never);
  assert.match(fact, /failed 2 times in a row/);
  assert.match(fact, /unknown/);
});
