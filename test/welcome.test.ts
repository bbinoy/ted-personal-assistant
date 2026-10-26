import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The welcome (src/core/welcome.ts): a fact for the owner's first run on a fresh data folder, handed over once.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "welcome-test-"));

const { instanceDb, kvGet } = await import("../src/core/instancedb.ts");
const W = await import("../src/core/welcome.ts");

test("welcome: a fresh data folder hands the owner's first run ONE fact (name-free, the commands, the setup offer); never again", () => {
  const fresh = { messages: 0, spend: 0, looks: 0 };
  W.welcomeStart(() => fresh);
  assert.equal(kvGet<{ state: string }>(W.WELCOME_KEY, { state: "" }).state, "pending");
  const fact = W.takeWelcome();
  assert.match(fact, /fresh install/);
  for (const c of ["/status", "/pause 2h", "/today"]) assert.ok(fact.includes(c), c);
  assert.match(fact, /set up/);
  assert.match(fact, /restore 3/);
  assert.equal(W.takeWelcome(), "", "handed over once");
  W.welcomeStart(() => fresh);
  assert.equal(kvGet<{ state: string }>(W.WELCOME_KEY, { state: "" }).state, "told", "a later start does not bring it back");
  instanceDb().run("DELETE FROM kv WHERE key = ?", W.WELCOME_KEY);
});

test("welcome: an install with history, spend, looks is never welcomed, not even later", () => {
  for (const [name, facts] of [["history", { messages: 3, spend: 0, looks: 0 }], ["spend", { messages: 0, spend: 2, looks: 0 }], ["looks", { messages: 0, spend: 0, looks: 1 }]] as const) {
    instanceDb().run("DELETE FROM kv WHERE key = ?", W.WELCOME_KEY);
    W.welcomeStart(() => facts);
    assert.equal(W.takeWelcome(), "", name);
    W.welcomeStart(() => ({ messages: 0, spend: 0, looks: 0 }));
    assert.equal(W.takeWelcome(), "", `${name}: even if the history is deleted afterwards`);
  }
  instanceDb().run("DELETE FROM kv WHERE key = ?", W.WELCOME_KEY);
});

test("welcome: the real facts of an empty data folder are fresh (nothing said, spent or looked at)", () => {
  assert.equal(W.isFresh(W.welcomeFacts()), true);
  assert.equal(W.isFresh({ messages: 1, spend: 0, looks: 0 }), false);
});

// ---- when shadow mode is on, and when it ends ----
