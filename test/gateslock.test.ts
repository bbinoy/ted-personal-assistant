import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquire, tryAcquire } from "../scripts/gates-lock.ts";

const fresh = () => join(mkdtempSync(join(tmpdir(), "gateslock-")), "lock");

test("a held lock reports its holder, release frees it", () => {
  const dir = fresh();
  const a = tryAcquire(dir);
  assert.ok("release" in a);
  const b = tryAcquire(dir);
  assert.ok("holder" in b);
  assert.equal(b.holder?.pid, process.pid);
  a.release();
  assert.equal(existsSync(dir), false);
  assert.ok("release" in tryAcquire(dir));
});

test("a lock whose pid is gone is taken over", () => {
  const dir = fresh();
  mkdirSync(dir);
  writeFileSync(join(dir, "holder.json"), JSON.stringify({ pid: 2 ** 22 + 12345, started: Date.now() - 1000 }));
  const r = tryAcquire(dir);
  assert.ok("release" in r);
  r.release();
});

test("acquire waits for a live holder and tells once", async () => {
  const dir = fresh();
  const first = tryAcquire(dir);
  assert.ok("release" in first);
  let told = 0;
  setTimeout(() => first.release(), 60);
  const release = await acquire({ dir, pollMs: 10, onWait: () => told++ });
  assert.equal(told, 1);
  release();
});
