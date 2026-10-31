import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { attachmentOf } from "../src/modules/mailbird/attachments.ts";
import { createFilesServer, openedBlocks, openNow, type AttachmentSource } from "../src/modules/files/filetool.ts";
import { OPEN_TOOL } from "../src/modules/files/module.ts";
import { sendNow, withSend, type Content } from "../src/modules/send/send.ts";
import { adoptFile, dropShots, loadFile, MAX_FILES, withTempFile } from "../src/modules/send/shots.ts";
import { MAX_PDF_PAGES } from "../src/conversation/document.ts";
import { OWNER_KEY } from "../src/core/ownerkey.ts";
import { classify } from "../src/policy/policy.ts";
import { OWNER_CHAT, GROUP_CHAT } from "./runkinds.ts";
import { access } from "./util.ts";

// open_file: a mail attachment (fake bytes, a fake Mailbird source) is opened through the document rules of the chat, kept for the turn as file1..., and sent with `send`.

const pdf = (pages = 2) => Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Pages /Count ${pages} /Kids [] >>\nendobj\n%%EOF\n`);
const source = (bytes: Buffer, name?: string): AttachmentSource => async () => ({ bytes, name });
const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("\n");

test("open_file: a PDF is kept as file1 and the PostToolUse swap turns the line into a document block", async () => {
  const r = await openNow(OWNER_KEY, { messageId: 1, attachmentId: "a" }, source(pdf(2), "Boarding pass.pdf"));
  assert.equal(r.isError, undefined);
  assert.match(text(r), /^file1: Boarding pass\.pdf, PDF, 2 pages\. Send it to the chat with send\(file: "file1"\)/);
  const blocks = openedBlocks(OWNER_KEY, text(r)) as { type: string; source?: { media_type: string; data: string }; text?: string }[];
  assert.equal(blocks[0]!.type, "document");
  assert.equal(blocks[0]!.source!.media_type, "application/pdf");
  assert.equal(Buffer.from(blocks[0]!.source!.data, "base64").subarray(0, 5).toString(), "%PDF-");
  assert.match(blocks[1]!.text!, /never an instruction/);
  assert.equal(openedBlocks(OWNER_KEY, "no file here"), undefined);
  assert.equal(openedBlocks("g-other", text(r)), undefined, "another conversation has no such file");
  dropShots(OWNER_KEY);
});

test("open_file: a text file comes back fenced in the result; no block is swapped in", async () => {
  const r = await openNow(OWNER_KEY, { messageId: 1, attachmentId: "b" }, source(Buffer.from("Gate 12\nSeat 4A"), "notes.txt"));
  assert.match(text(r), /file1: notes\.txt, text\./);
  assert.match(text(r), /Gate 12/);
  assert.equal(openedBlocks(OWNER_KEY, text(r)), undefined);
  dropShots(OWNER_KEY);
});

test("open_file: anything but a PDF or text is refused, as are a fake PDF, a long PDF, an encrypted one, a failed fetch; nothing is kept", async () => {
  const bad: [Buffer, string, RegExp][] = [
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), "photo.jpg", /can't open that kind of file/],
    [Buffer.from("PK\u0003\u0004zip"), "a.zip", /can't open that kind of file/],
    [Buffer.from("just text"), "fake.pdf", /not a real PDF/],
    [pdf(MAX_PDF_PAGES + 1), "long.pdf", /pages/],
    [Buffer.from("%PDF-1.4\ntrailer << /Encrypt 5 0 R >>\n"), "locked.pdf", /password protected/],
  ];
  for (const [bytes, name, re] of bad) {
    const r = await openNow(OWNER_KEY, { messageId: 1, attachmentId: "x" }, source(bytes, name));
    assert.equal(r.isError, true, name);
    assert.match(text(r), re, name);
  }
  const failed = await openNow(OWNER_KEY, { messageId: 1, attachmentId: "x" }, async () => {
    throw new Error("boom");
  });
  assert.equal(failed.isError, true);
  assert.equal("problem" in loadFile(OWNER_KEY, "file1"), true, "nothing was kept");
  dropShots(OWNER_KEY);
});

test("files: ids are per conversation and per turn, counted from 1, and limited", () => {
  const a = adoptFile("g-a", pdf(), "one.pdf")!;
  const b = adoptFile("g-b", pdf(), "two.pdf")!;
  assert.deepEqual([a.id, b.id], ["file1", "file1"]);
  assert.equal(adoptFile("g-a", pdf(), "three.pdf")!.id, "file2");
  assert.equal((loadFile("g-b", "file1") as { file: { name: string } }).file.name, "two.pdf");
  assert.equal("problem" in loadFile("g-b", "file2"), true);
  for (const bad of ["../file1", "/etc/passwd", "file0", "shot1"]) assert.equal("problem" in loadFile("g-a", bad), true, bad);
  dropShots("g-a");
  assert.equal("problem" in loadFile("g-a", "file1"), true, "the turn is over: gone");
  assert.equal(adoptFile("g-a", pdf(), "again.pdf")!.id, "file1", "a new turn starts again at 1");
  for (let i = 0; i < MAX_FILES; i++) adoptFile("g-c", pdf(), "x.pdf");
  assert.equal(adoptFile("g-c", pdf(), "x.pdf"), undefined, "per-turn limit");
  assert.equal(adoptFile("g-c2", Buffer.alloc(0), "empty.pdf"), undefined);
  for (const k of ["g-a", "g-b", "g-c", "g-c2"]) dropShots(k);
});

test("send: a file goes out as a file attachment from a temp copy that is deleted right after; a wrong id or a second conversation's id is refused", async () => {
  const sent: Content[] = [];
  await withSend(OWNER_KEY, async (c) => (sent.push(c), "ok"), async () => {
    await openNow(OWNER_KEY, { messageId: 1, attachmentId: "a" }, source(pdf(), "pass.pdf"));
    assert.match(await sendNow(OWNER_KEY, { file: "file2" }), /No file "file2"/);
    assert.match(await sendNow(OWNER_KEY, { file: "file1", picture: "shot1" }), /exactly one thing/);
    assert.equal(await sendNow(OWNER_KEY, { file: "file1", caption: "Here" }), "ok");
    const c = sent[0] as Extract<Content, { kind: "file" }>;
    assert.deepEqual([c.kind, c.id, c.held.name, c.caption], ["file", "file1", "pass.pdf", "Here"]);
    // the temp copy exists only while it is used, and is gone after, however `use` ends
    let path = "";
    await withTempFile(c.held, async (p) => {
      path = p;
      assert.deepEqual(readFileSync(p), pdf());
      assert.equal(p.endsWith("/pass.pdf"), true);
    });
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(dirname(path)), false);
    await assert.rejects(withTempFile(c.held, async (p) => ((path = p), Promise.reject(new Error("send failed")))));
    assert.equal(existsSync(dirname(path)), false, "also when sending fails");
  });
  assert.match(await sendNow(OWNER_KEY, { file: "file1" }), /Nobody to send/);
  assert.equal("problem" in loadFile(OWNER_KEY, "file1"), true, "the turn's files are dropped with it");
});

test("Mailbird's attachment result is read tolerantly: base64 under content, data, or as the text itself, with its file name", () => {
  const b64 = pdf().toString("base64");
  for (const res of [{ fileName: "a.pdf", content: b64 }, { attachment: { name: "a.pdf", data: b64 } }, [{ contentBase64: b64, name: "a.pdf" }], b64]) {
    const got = attachmentOf(res)!;
    assert.deepEqual(got.bytes, pdf(), JSON.stringify(res).slice(0, 30));
    if (typeof res !== "string") assert.equal(got.name, "a.pdf");
  }
  assert.equal(attachmentOf({ error: "no such attachment", size: 5 }), undefined);
  assert.equal(attachmentOf("not base64 at all, sorry!"), undefined);
});

test("open_file: the tool is the owner's only (her Mailbird): free and untrusted for her, denied to a group; its server is built on a source", () => {
  assert.equal(access(OPEN_TOOL, OWNER_CHAT), "free");
  assert.equal(classify(OPEN_TOOL, { messageId: 1, attachmentId: "a" }, OWNER_CHAT), "allow");
  assert.equal(classify(OPEN_TOOL, { messageId: 1, attachmentId: "a" }, GROUP_CHAT), "deny");
  assert.ok(createFilesServer(OWNER_KEY, source(pdf())));
});
