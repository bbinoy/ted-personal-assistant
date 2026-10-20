import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { MAX_SIDE, preparePicture, sniff, userInput } from "../src/run/image.ts";

// A solid-colour PNG made by hand (a few KB however large it is).
function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const rows = Buffer.alloc((w * 3 + 1) * h); // each row: filter byte 0, then black
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
const file = (b: Buffer, name = "p") => {
  const f = join(mkdtempSync(join(tmpdir(), "img-")), name);
  writeFileSync(f, b);
  return f;
};

test("image: the bytes decide what a file is, not its name", () => {
  assert.equal(sniff(png(2, 2)), "image/png");
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniff(Buffer.from("GIF89a")), "image/gif");
  assert.equal(sniff(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniff(Buffer.from("\0\0\0\x18ftypheic")), "heic");
  assert.equal(sniff(Buffer.from("<svg xmlns=...")), undefined);
  assert.equal(sniff(Buffer.from("%PDF-1.7")), undefined);
});

test("image: a small picture passes through untouched; something that is not a picture is refused with a sentence", async () => {
  const small = png(40, 30);
  const p = await preparePicture(file(small, "photo.jpg"));
  assert.deepEqual([p.mediaType, p.data], ["image/png", small.toString("base64")]);
  await assert.rejects(preparePicture(file(Buffer.from("#!/bin/sh\necho hi"), "evil.jpg")), /JPEG, PNG, WebP, GIF or HEIC/);
});

test("image: a large photo is shrunk before it goes to the model", { skip: process.platform !== "darwin" }, async () => {
  const big = png(4000, 3000);
  const p = await preparePicture(file(big));
  assert.equal(p.mediaType, "image/jpeg");
  const out = Buffer.from(p.data, "base64");
  assert.ok(sniff(out) === "image/jpeg");
  // sips wrote it at no more than MAX_SIDE on the long side: the JPEG's SOF0/SOF2 marker holds the size
  const sof = out.findIndex((v, i) => v === 0xff && (out[i + 1] === 0xc0 || out[i + 1] === 0xc2));
  assert.ok(Math.max(out.readUInt16BE(sof + 5), out.readUInt16BE(sof + 7)) <= MAX_SIDE);
});

test("image: the file itself is checked: too large, a symlink, or claiming more pixels than the limit is refused with a sentence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "img-limits-"));
  const huge = join(dir, "huge");
  writeFileSync(huge, "");
  truncateSync(huge, 21_000_000); // a sparse file: over the 20 MB limit whatever Signal said
  await assert.rejects(preparePicture(huge), /too large, or not a plain file/);
  const real = join(dir, "real.png");
  writeFileSync(real, png(8, 8));
  symlinkSync(real, join(dir, "link"));
  await assert.rejects(preparePicture(join(dir, "link")), /not a plain file/);
  await preparePicture(real); // the plain file is fine
  if (process.platform === "darwin") await assert.rejects(preparePicture(file(png(4000, 3000)), 10_000_000), /too many pixels/); // 12 MP against a 10 MP limit (needs sips for the size)
});

test("image: with pictures the prompt is one user message of image blocks then the text; without, plain text", async () => {
  assert.equal(userInput("hi"), "hi");
  const input = userInput("what is this?", [{ mediaType: "image/jpeg", data: "QUJD" }]);
  const got = [];
  for await (const m of input as AsyncIterable<any>) got.push(m);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].message.content, [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } }, { type: "text", text: "what is this?" }]);
});
