import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOptions } from "../src/run/agentrun.ts";
import { drawNow } from "../src/modules/draw/drawtool.ts";
import { classify } from "../src/policy/policy.ts";
import { ownerSkills } from "../src/modules/skills.ts";
import { sendNow, withSend, type Content } from "../src/modules/send/send.ts";
import { OWNER_KEY } from "../src/core/ownerkey.ts";
import { settings } from "../src/core/settings.ts";
import { listHeld, MAX_FILES } from "../src/modules/send/shots.ts";
import { access, dropFiles } from "./util.ts";
import { BROWSE_RUN, GROUP_CHAT, GROUP_LOOK, OWNER_CHAT, OWNER_LOOK } from "./runkinds.ts";

// draw: the model's SVG becomes a PNG a held file (file1...), looked at, then sent with `send` as a picture.

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100"><rect x="10" y="10" width="80" height="40" fill="#3b6fb6"/><text x="10" y="80" font-size="16">Plan</text></svg>`;
const svgN = (n: number) => SVG.replace("Plan", `Plan ${n}`);

test("draw: the model gets the PNG back as image content with a file id, a drawing is a held file, and nothing is sent yet", async () => {
  const sent: Content[] = [];
  try {
    await withSend(OWNER_KEY, async (c) => (sent.push(c), "ok"), async () => {
      const r = await drawNow(OWNER_KEY, { svg: SVG });
      assert.equal(r.isError, undefined);
      const [img, text] = r.content;
      assert.equal(img!.type, "image");
      const data = Buffer.from((img as { data: string }).data, "base64");
      assert.deepEqual([...data.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
      assert.equal((img as { mimeType: string }).mimeType, "image/png");
      assert.match((text as { text: string }).text, /Drawn as file1 \(800x400\)/);
      assert.match((text as { text: string }).text, /not been sent yet/);
      assert.deepEqual(sent, []);
      assert.match(((await drawNow(OWNER_KEY, { svg: svgN(2) })).content.at(-1) as { text: string }).text, /Drawn as file2/);
      assert.deepEqual(listHeld(OWNER_KEY).map((h) => [h.id, h.name]), [["file1", "drawing.png"], ["file2", "drawing-2.png"]]);
      // then send delivers it as a picture, from the held file, and a later turn can still send it
      assert.equal(await sendNow(OWNER_KEY, { file: "file1", caption: "Here" }), "ok");
      const c = sent[0] as Extract<Content, { kind: "file" }>;
      assert.deepEqual([c.kind, c.id, c.held.name, c.size > 0, c.caption, c.held.bytes.equals(data)], ["file", "file1", "drawing.png", true, "Here", true]);
    });
    await withSend(OWNER_KEY, async (c) => (sent.push(c), "ok"), async () => assert.equal(await sendNow(OWNER_KEY, { file: "file2" }), "ok"));
  } finally {
    dropFiles(OWNER_KEY);
  }
});

test("draw: a bad drawing gives a short message the model can act on, no id", async () => {
  await withSend(OWNER_KEY, async () => "ok", async () => {
    const r = await drawNow(OWNER_KEY, { svg: `<svg viewBox="0 0 0 0" width="0" height="0"><rect width="5" height="5"/></svg>` });
    assert.equal(r.isError, true);
    assert.match((r.content[0] as { text: string }).text, /^Not drawn: .{10,200}Fix the SVG and call draw again\.$/);
    assert.match(await sendNow(OWNER_KEY, { file: "file1" }), /No file/);
    const hostile = await drawNow(OWNER_KEY, { svg: `<svg viewBox="0 0 10 10" width="10" height="10"><script>x()</script><rect width="5" height="5"/></svg>` });
    assert.match((hostile.content.at(-1) as { text: string }).text, /removed \(script\)/);
  });
});

test("draw: another conversation cannot reach a drawing, and a drawing-heavy turn stops at the turn's file cap", async () => {
  try {
    await withSend("g-a", async () => "ok", async () => {
      await drawNow("g-a", { svg: SVG });
      await withSend("g-b", async () => assert.fail("must not send"), async () => assert.match(await sendNow("g-b", { file: "file1" }), /No file/));
      for (let i = 2; i <= MAX_FILES; i++) assert.match(((await drawNow("g-a", { svg: svgN(i) })).content.at(-1) as { text: string }).text, /Drawn as/);
      assert.match(((await drawNow("g-a", { svg: svgN(99) })).content[0] as { text: string }).text, /too many files/);
    });
  } finally {
    dropFiles("g-a");
  }
});

test("draw: manifest and policy: free in every run of a conversation that has the capability (a look too), not in the browse worker", () => {
  for (const run of [OWNER_CHAT, OWNER_LOOK, GROUP_CHAT, GROUP_LOOK]) assert.equal(access("mcp__draw__draw", run), "free");
  assert.equal(access("mcp__draw__draw", BROWSE_RUN), "free", "the row exists everywhere: which conversation has it is its capability set, the browse worker has no such server");
  assert.equal(classify("mcp__draw__draw", { svg: SVG }, OWNER_CHAT), "allow");
  assert.equal(classify("mcp__draw__draw", { svg: SVG }, OWNER_LOOK), "allow");
  assert.equal(classify("mcp__draw__draw", { svg: SVG }, GROUP_CHAT), "allow");
  assert.equal(classify("mcp__draw__nothing", {}, GROUP_CHAT), "deny");
});

test("draw: the server exists for the owner's and a group's runs alike, look or chat (its capability), and the skill is offered with DRAW=on", () => {
  const servers = (o: Parameters<typeof buildOptions>[1]) => Object.keys(buildOptions(async () => ({ approved: true }), o, undefined).mcpServers ?? {});
  const base = { systemPrompt: "x", maxTurns: 1, maxBudgetUsd: 1 };
  assert.ok(servers({ ...base, conversation: "owner", kind: OWNER_CHAT, memory: { dir: "/tmp/n" } }).includes("draw"));
  assert.ok(servers({ ...base, kind: GROUP_CHAT, memory: { dir: "/tmp/n", groupId: "g" } }).includes("draw"));
  assert.ok(servers({ ...base, conversation: "owner", kind: OWNER_LOOK }).includes("draw"), "the owner's look has draw, like a group's look");
  assert.ok(servers({ ...base, kind: GROUP_LOOK, groupId: "g" }).includes("draw"));
  assert.ok(!servers({ ...base, kind: BROWSE_RUN }).includes("draw"));
  assert.equal(ownerSkills(true).includes("ted-personal-assistant:draw"), settings.draw);
});

test("policy: the weather tools are allowed in a group run, other weather names are not", async () => {
  const { classify } = await import("../src/policy/policy.ts");
  for (const t of ["search_places", "get_forecast", "get_marine_forecast", "get_spot_info", "get_distance"]) assert.equal(classify(`mcp__weather__${t}`, {}, GROUP_CHAT), "allow");
  assert.equal(classify("mcp__weather__set_alert", {}, GROUP_CHAT), "deny");
});
