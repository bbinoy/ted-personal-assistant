import { test } from "node:test";
import assert from "node:assert/strict";
import { tick } from "./util.ts";
import { JudgeSpare } from "../src/judgespare.ts";
import { settings } from "../src/settings.ts";

const setWarm = (v: boolean) => ((settings as { warm: boolean }).warm = v);
const result = (outcome: string) => ({ type: "result", subtype: "success", is_error: false, structured_output: { task: "answer", target: "A1", outcome } }) as any;
async function* one(msg: unknown, log: string[], tag: string) {
  log.push(tag);
  yield msg;
}
// Warm processes that say which one answered, and a cold query that says "cold".
function rig(verdictOf = (tag: string) => tag) {
  const log: string[] = [];
  let n = 0;
  return {
    log,
    started: () => n,
    io: {
      start: (async () => {
        const tag = `warm${++n}`;
        return { query: () => one(result(verdictOf(tag)), log, tag), close() {} };
      }) as any,
      query: (() => one(result(verdictOf("cold")), log, "cold")) as any,
    },
  };
}
const drain = async (p: ReturnType<JudgeSpare["run"]>) => {
  const { messages, warm } = await p;
  for await (const _ of messages);
  return warm;
};

test("judge spare: cold without a spare, warm with one, and a spare serves one query", async () => {
  const was = settings.warm;
  setWarm(true);
  try {
    const r = rig();
    const s = new JudgeSpare("t", { model: "haiku" });
    assert.equal(await drain(s.run("p", r.io)), false);
    s.prepare(r.io);
    s.prepare(r.io); // already warm: no second process
    assert.equal(r.started(), 1);
    assert.equal(await drain(s.run("p", r.io)), true);
    assert.equal(await drain(s.run("p", r.io)), false); // used up
    assert.deepEqual(r.log, ["cold", "warm1", "cold"]);
  } finally {
    setWarm(was);
  }
});

test("judge spare: WARM=off starts nothing", async () => {
  const was = settings.warm;
  setWarm(false);
  try {
    const r = rig();
    const s = new JudgeSpare("t", { model: "haiku" });
    s.prepare(r.io);
    assert.equal(r.started(), 0);
    assert.equal(await drain(s.run("p", r.io)), false);
  } finally {
    setWarm(was);
  }
});

test("judge spare: a dead spare falls back to a cold call", async () => {
  const was = settings.warm;
  setWarm(true);
  try {
    const log: string[] = [];
    const io = {
      start: (async () => ({ query: () => { throw new Error("ProcessTransport is not ready for writing"); }, close() {} })) as any,
      query: (() => one(result("other"), log, "cold")) as any,
    };
    const s = new JudgeSpare("t", { model: "haiku" });
    s.prepare(io);
    await drain(s.run("p", io));
    assert.deepEqual(log, ["cold"]);
    // a spare that never came up
    s.prepare({ ...io, start: (() => Promise.reject(new Error("spawn failed"))) as any });
    await tick();
    assert.equal(await drain(s.run("p", io)), false);
  } finally {
    setWarm(was);
  }
});

test("judge spare: its own idle: an unused spare is dropped after it, while the default is the chat's WARM_IDLE_MINUTES", async () => {
  const was = settings.warm;
  setWarm(true);
  try {
    const r = rig();
    const short = new JudgeSpare("short", { model: "haiku" }, () => 0.00005); // 3 ms
    short.prepare(r.io);
    await new Promise((res) => setTimeout(res, 40));
    assert.equal(await drain(short.run("p", r.io)), false, "gone after its idle");
    const dflt = new JudgeSpare("dflt", { model: "haiku" });
    dflt.prepare(r.io);
    await new Promise((res) => setTimeout(res, 40));
    assert.equal(await drain(dflt.run("p", r.io)), true, "an hour by default");
  } finally {
    setWarm(was);
  }
  assert.equal(settings.judgeIdleMinutes, 10);
  assert.ok(settings.judgeIdleMinutes < settings.warmIdleMinutes);
});

test("judge spare: each judge keeps its own spare; one prepared for another purpose is never used", async () => {
  const was = settings.warm;
  setWarm(true);
  try {
    const r = rig();
    const a = new JudgeSpare("a", { model: "haiku", systemPrompt: "A" });
    const b = new JudgeSpare("b", { model: "haiku", systemPrompt: "B" });
    a.prepare(r.io);
    assert.equal(await drain(b.run("p", r.io)), false); // b has none, a's is left alone
    assert.equal(await drain(a.run("p", r.io)), true);
  } finally {
    setWarm(was);
  }
});
