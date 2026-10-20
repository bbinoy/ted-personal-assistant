import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOptions } from "../src/agentrun.ts";
import { drawNow } from "../src/modules/draw/drawtool.ts";
import { classify } from "../src/policy/policy.ts";
import { ownerSkills } from "../src/skills.ts";
import { sendNow, withSend, type Content } from "../src/send.ts";
import { OWNER_KEY } from "../src/ownerkey.ts";
import { settings } from "../src/settings.ts";
import { adoptDrawing, adoptShots, loadShot, MAX_DRAWINGS, MAX_PICTURE_BYTES } from "../src/shots.ts";
import { access } from "./util.ts";

// draw: the model's SVG becomes a PNG kept for the turn (img1...), looked at, then sent with `send` like a screenshot.

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100"><rect x="10" y="10" width="80" height="40" fill="#3b6fb6"/><text x="10" y="80" font-size="16">Plan</text></svg>`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);

test("draw: the model gets the PNG back as image content with an id, and nothing is sent yet", async () => {
  const sent: Content[] = [];
  await withSend(OWNER_KEY, async (c) => (sent.push(c), "ok"), async () => {
    const r = await drawNow(OWNER_KEY, { svg: SVG, caption: "A plan" });
    assert.equal(r.isError, undefined);
    const [img, text] = r.content;
    assert.equal(img!.type, "image");
    const data = Buffer.from((img as { data: string }).data, "base64");
    assert.deepEqual([...data.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal((img as { mimeType: string }).mimeType, "image/png");
    assert.match((text as { text: string }).text, /Drawn as img1 \(800x400\)/);
    assert.match((text as { text: string }).text, /not been sent yet/);
    assert.deepEqual(sent, []);
    assert.match(((await drawNow(OWNER_KEY, { svg: SVG })).content.at(-1) as { text: string }).text, /Drawn as img2/);
    // then send delivers it as a picture, with the PNG file
    assert.equal(await sendNow(OWNER_KEY, { picture: "img1", caption: "Here" }), "ok");
    const c = sent[0] as Extract<Content, { kind: "picture" }>;
    assert.deepEqual([c.kind, c.id, c.file.endsWith("img1.png"), c.size > 0, c.caption], ["picture", "img1", true, true, "Here"]);
  });
});

test("draw: a bad drawing gives a short message the model can act on, no id", async () => {
  await withSend(OWNER_KEY, async () => "ok", async () => {
    const r = await drawNow(OWNER_KEY, { svg: `<svg viewBox="0 0 0 0" width="0" height="0"><rect width="5" height="5"/></svg>` });
    assert.equal(r.isError, true);
    assert.match((r.content[0] as { text: string }).text, /^Not drawn: .{10,200}Fix the SVG and call draw again\.$/);
    assert.match(await sendNow(OWNER_KEY, { picture: "img1" }), /No screenshot/);
    const hostile = await drawNow(OWNER_KEY, { svg: `<svg viewBox="0 0 10 10" width="10" height="10"><script>x()</script><rect width="5" height="5"/></svg>` });
    assert.match((hostile.content.at(-1) as { text: string }).text, /removed \(script\)/);
  });
});

test("send: a PNG id of this turn is sent; a path, an unknown id, another conversation's id and a non-image file are refused", async () => {
  const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "secret.png");
  writeFileSync(outside, PNG);
  await withSend("g-a", async () => "ok", async () => {
    const a = adoptDrawing("g-a", PNG, "x")!;
    const b = adoptDrawing("g-a", PNG)!;
    const c = adoptDrawing("g-a", PNG)!;
    assert.deepEqual([a.id, b.id, c.id], ["img1", "img2", "img3"]);
    assert.ok("shot" in loadShot("g-a", "img1"));
    for (const bad of ["img9", "../img1", "/etc/passwd", "img1.png", outside, "IMG1", "img0"]) assert.match(await sendNow("g-a", { picture: bad }), /No screenshot/, bad);
    writeFileSync(b.file, "GIF89a not a png");
    assert.match(await sendNow("g-a", { picture: "img2" }), /not a jpeg or png/);
    writeFileSync(c.file, Buffer.alloc(MAX_PICTURE_BYTES + 1, 0x89));
    assert.match(await sendNow("g-a", { picture: "img3" }), /cannot be used/);
    await withSend("g-b", async () => assert.fail("must not send"), async () => {
      assert.match(await sendNow("g-b", { picture: "img1" }), /No screenshot available/);
      const own = adoptDrawing("g-b", PNG)!;
      assert.ok("shot" in loadShot("g-b", "img1"));
      assert.notEqual(own.file, a.file, "each conversation has its own folder");
    });
  });
  // a symlink in place of the file
  await withSend(OWNER_KEY, async () => assert.fail("must not send"), async () => {
    const s = adoptDrawing(OWNER_KEY, PNG)!;
    const { rmSync } = await import("node:fs");
    rmSync(s.file);
    symlinkSync(outside, s.file);
    assert.match(await sendNow(OWNER_KEY, { picture: "img1" }), /cannot be used/);
  });
});

test("shots: drawings and screenshots count separately, both kinds can be PNG or JPEG, a turn's drawings have a limit, the files go with the turn", async () => {
  let file = "";
  await withSend(OWNER_KEY, async (c) => (c.kind === "picture" && (file = c.file), "ok"), async () => {
    const d = adoptDrawing(OWNER_KEY, PNG)!;
    const tmp = join(mkdtempSync(join(tmpdir(), "shotsrc-")), "a.jpg");
    writeFileSync(tmp, JPEG);
    const [s] = adoptShots(OWNER_KEY, [{ id: "shot1", file: tmp, size: JPEG.length }], {});
    assert.deepEqual([d.id, s!.id], ["img1", "shot1"]);
    assert.equal(await sendNow(OWNER_KEY, { picture: "shot1" }), "ok");
    assert.equal(adoptDrawing(OWNER_KEY, JPEG), undefined, "only PNG bytes are kept as a drawing");
    for (let i = 1; i < MAX_DRAWINGS; i++) assert.ok(adoptDrawing(OWNER_KEY, PNG));
    assert.equal(adoptDrawing(OWNER_KEY, PNG), undefined);
    assert.match(((await drawNow(OWNER_KEY, { svg: SVG })).content[0] as { text: string }).text, /too many drawings/);
    assert.ok(existsSync(d.file));
  });
  assert.equal(existsSync(file), false);
});

test("draw: manifest and policy: free in chat and group, nowhere else", () => {
  assert.equal(access("mcp__draw__draw", "chat"), "free");
  assert.equal(access("mcp__draw__draw", "group"), "free");
  for (const source of ["handler", "brief", "radar", "browse", "background", "heartbeat", "dream"] as const) assert.equal(access("mcp__draw__draw", source), undefined, source);
  assert.equal(classify("mcp__draw__draw", { svg: SVG }, "chat"), "allow");
  assert.equal(classify("mcp__draw__draw", { svg: SVG }, "group"), "allow");
  for (const source of ["brief", "radar", "handler", "browse"] as const) assert.equal(classify("mcp__draw__draw", { svg: SVG }, source), "deny", source);
  assert.equal(classify("mcp__draw__nothing", {}, "group"), "deny");
});

test("draw: the server exists for chat and group runs only, and the skill is offered with DRAW=on", () => {
  const servers = (o: Parameters<typeof buildOptions>[1]) => Object.keys(buildOptions(async () => ({ approved: true }), o, undefined).mcpServers ?? {});
  const base = { systemPrompt: "x", maxTurns: 1, maxBudgetUsd: 1 };
  assert.ok(servers({ ...base, source: "chat", memory: { dir: "/tmp/n" } }).includes("draw"));
  assert.ok(servers({ ...base, source: "group", memory: { dir: "/tmp/n", groupId: "g" } }).includes("draw"));
  for (const source of ["brief", "radar", "handler", "background"] as const) assert.ok(!servers({ ...base, source }).includes("draw"), source);
  assert.equal(ownerSkills(true).includes("ted-personal-assistant:draw"), settings.draw);
});

test("policy: the weather tools are allowed in a group run, other weather names are not", async () => {
  const { classify } = await import("../src/policy/policy.ts");
  for (const t of ["search_places", "get_forecast", "get_marine_forecast", "get_spot_info", "get_distance"]) assert.equal(classify(`mcp__weather__${t}`, {}, "group"), "allow");
  assert.equal(classify("mcp__weather__set_alert", {}, "group"), "deny");
});
