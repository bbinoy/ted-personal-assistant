import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serversFor } from "../src/modules/runtime.ts";
import { OWNER_CHAT } from "./runkinds.ts";

// Context is a budget: every tool an owner run always loads is paid on every call; the rest is not pinned (Ted's runs have no ToolSearch, so every tool is in the prompt anyway; the pin is the SDK's alwaysLoad flag). The set of always-loaded
// tools is pinned here, so adding a tool to it is a decision, not a side effect.

interface Registered { _meta?: Record<string, unknown> }
interface Sdk { type: string; alwaysLoad?: boolean; instance: { _registeredTools: Record<string, Registered> } }

test("the owner's chat always loads only send, draw and voice; every other in-process tool is deferred", () => {
  const ctx = { kind: OWNER_CHAT, browsing: false, key: "owner", mode: "owner" as const, offers: () => true, memory: { dir: mkdtempSync(join(tmpdir(), "loading-")) }, browseRun: async () => ({ text: "", costUsd: 0 }) };
  const always: string[] = [];
  for (const [server, cfg] of Object.entries(serversFor(ctx as never) as unknown as Record<string, Sdk>)) {
    if (cfg.type !== "sdk") continue;
    for (const [name, t] of Object.entries(cfg.instance._registeredTools)) if (cfg.alwaysLoad || t._meta?.["anthropic/alwaysLoad"]) always.push(`${server}.${name}`);
  }
  assert.deepEqual(always.sort(), ["draw.draw", "send.send", "voice.voice"]);
});
