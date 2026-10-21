import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthError, causeOf, FIXES, InstanceKeyError, noticeFor, RateLimitError, type Cause } from "../src/tenants/errors.ts";
import { RunTimeout } from "../src/run/ceiling.ts";
import { createFailureTracker, budgetText } from "../src/heartbeat/notices.ts";
import { ownerCapText } from "../src/core/capnotice.ts";
import { createKeyNotices } from "../src/tenants/keynotice.ts";

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

test("the failing-looks notice ends with the cause's fix, for the owner, a group and (as a count) friends", () => {
  const T = 1_000_000_000_000;
  for (const c of CAUSES) {
    const t = createFailureTracker({ count: 2 });
    t.observe("k", "owner", true, c, T);
    const said = t.observe("k", "owner", true, c, T + 1);
    assert.equal(said.length, 1, c);
    assert.ok(said[0]!.endsWith(FIXES[c].fix), `${c}: ${said[0]}`);
    assert.ok(said[0]!.includes(FIXES[c].what));
    const f = createFailureTracker({ count: 2 });
    f.observe("tenant:anna", "tenant", true, c, T);
    const fr = f.observe("tenant:anna", "tenant", true, c, T + 1);
    assert.ok(fr[0]!.endsWith(FIXES[c].fix), c);
    assert.doesNotMatch(fr[0]!, /anna/i);
  }
});

test("the owner's chat failure notices end with the step for their cause; friends and groups are sent to no terminal", () => {
  for (const c of CAUSES) {
    if (c === "timeout") continue; // (a chat turn's own ceiling, below)
    const text = noticeFor("owner")(SAMPLES[c]);
    if (c === "other") assert.ok(text.endsWith(FIXES.other.fix), text);
    else assert.ok(text.endsWith(FIXES[c].fix), `${c}: ${text}`);
    assert.doesNotMatch(text, SECRETS);
    for (const a of ["friend", "group"] as const) assert.doesNotMatch(noticeFor(a)(SAMPLES[c]), /npm run|claude auth|\.env|Settings > Connectors/, `${c} for ${a}`);
  }
  assert.match(noticeFor("owner")(SAMPLES.timeout), /RUN_MAX_MINUTES_CHAT in \.env and restart/);
});

test("the budget, the shared cap and the shared-key notices each end with the exact setting", () => {
  assert.match(budgetText(), /raise DAILY_BUDGET_USD in \.env and restart\.$/);
  assert.match(ownerCapText(5), /raise INSTANCE_KEY_DAILY_USD in \.env and restart\.$/);
  const told: string[] = [];
  const k = createKeyNotices();
  k.sendTo((t) => told.push(t));
  k.report("refused");
  k.report("missing");
  assert.match(told[0]!, /check TENANT_ANTHROPIC_API_KEY in \.env, then restart\.$/);
  assert.match(told[1]!, /and restart\.$/);
  for (const t of [budgetText(), ownerCapText(5), ...told]) assert.doesNotMatch(t, SECRETS);
});
