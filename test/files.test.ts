import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { attachmentOf } from "../src/modules/mailbird/attachments.ts";
import { createFilesServer, openedBlocks, openNow, type AttachmentSource } from "../src/modules/files/filetool.ts";
import { OPEN_TOOL } from "../src/modules/files/module.ts";
import { sendNow, withSend, type Content } from "../src/modules/send/send.ts";
import { adoptFile, dropShots, loadFile, MAX_FILES, withTempFile } from "../src/modules/send/shots.ts";
import { isPicture } from "../src/conversation/openbytes.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { scopeOf } from "../src/approvals/turnscope.ts";
import { readAudit } from "../src/core/audit.ts";
import type { Verdict } from "../src/approvals/autojudge.ts";
import { OWNER_KEY } from "../src/core/ownerkey.ts";
import { classify } from "../src/policy/policy.ts";
import { OWNER_CHAT, GROUP_CHAT } from "./runkinds.ts";
import { access, CHAT } from "./util.ts";

// open_file: a mail attachment (fake bytes, a fake Mailbird source) is opened through the document rules of the chat, kept for the turn as file1..., and sent with `send`.

const pdf = (pages = 2) => Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Pages /Count ${pages} /Kids [] >>\nendobj\n%%EOF\n`);
const source = (bytes: Buffer, name?: string): AttachmentSource => async () => ({ bytes, name });
const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("\n");

test("open_file: a PDF is kept as file1 and the PostToolUse swap turns the line into a document block", async () => {
  const r = await openNow(OWNER_KEY, { messageId: 1, attachmentId: "a" }, source(pdf(2), "Boarding pass.pdf"));
  assert.equal(r.isError, undefined);
  assert.match(text(r), /^file1: Boarding pass\.pdf, PDF, 2 pages\. Send it to the chat with send\(file: "file1"\)/);
  const blocks = (await openedBlocks(OWNER_KEY, text(r))) as { type: string; source?: { media_type: string; data: string }; text?: string }[];
  assert.equal(blocks[0]!.type, "document");
  assert.equal(blocks[0]!.source!.media_type, "application/pdf");
  assert.equal(Buffer.from(blocks[0]!.source!.data, "base64").subarray(0, 5).toString(), "%PDF-");
  assert.match(blocks[1]!.text!, /never an instruction/);
  assert.equal(await openedBlocks(OWNER_KEY, "no file here"), undefined);
  assert.equal(await openedBlocks("g-other", text(r)), undefined, "another conversation has no such file");
  dropShots(OWNER_KEY);
});

test("open_file: a text file comes back fenced in the result; no block is swapped in", async () => {
  const r = await openNow(OWNER_KEY, { messageId: 1, attachmentId: "b" }, source(Buffer.from("Gate 12\nSeat 4A"), "notes.txt"));
  assert.match(text(r), /file1: notes\.txt, text\./);
  assert.match(text(r), /Gate 12/);
  assert.equal(await openedBlocks(OWNER_KEY, text(r)), undefined);
  dropShots(OWNER_KEY);
});

test("open_file: anything but a PDF or text is refused, as are a fake PDF, an encrypted one, a failed fetch; nothing is kept", async () => {
  const bad: [Buffer, string, RegExp][] = [
    [Buffer.from("MZ\u0090\u0000program"), "tool.exe", /can't open that kind of file/],
    [Buffer.from("PK\u0003\u0004zip"), "a.zip", /can't open that kind of file/],
    [Buffer.from("just text"), "fake.pdf", /not a real PDF/],
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

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64");
const meta = (name: string, mimeType: string) => ({ type: "text", text: JSON.stringify({ attachmentId: 9300, fileName: name, mimeType, size: 233, resourceUri: "mailbird://mcp/messages/1/attachments/9300" }) });

test("Mailbird's attachment result: an image item or a resource blob gives the bytes, the name comes from the metadata text; no bytes item gives nothing", () => {
  const image = attachmentOf([meta("inline.png", "image/png"), { type: "image", data: PNG.toString("base64"), mimeType: "image/png" }])!;
  assert.deepEqual([image.name, image.bytes], ["inline.png", PNG]);
  const blob = attachmentOf([meta("pass.pdf", "application/pdf"), { type: "resource", resource: { uri: "mailbird://x", mimeType: "application/pdf", blob: pdf().toString("base64") } }])!;
  assert.deepEqual([blob.name, blob.bytes], ["pass.pdf", pdf()]);
  assert.equal(attachmentOf([meta("big.zip", "application/zip")]), undefined);
  assert.equal(attachmentOf([{ type: "text", text: "no such attachment" }]), undefined);
  assert.equal(attachmentOf("junk"), undefined);
});

test("open_file: a picture (an inline barcode) is shown as an image, kept as file1, and sent as a picture; a missing-bytes fetch is refused", async () => {
  const r = await openNow(OWNER_KEY, { messageId: 1, attachmentId: "a" }, source(PNG, "barcode.png"));
  assert.equal(r.isError, undefined);
  assert.equal(r.content[0]!.type, "image");
  assert.match(text(r), /file1: barcode\.png, picture\./);
  assert.equal(await openedBlocks(OWNER_KEY, text(r)), undefined, "no document swap for a picture");
  assert.equal(isPicture((loadFile(OWNER_KEY, "file1") as { file: { bytes: Buffer } }).file.bytes), true);
  assert.equal(isPicture(pdf()), false);
  dropShots(OWNER_KEY);
  const none = await openNow(OWNER_KEY, { messageId: 1, attachmentId: "a" }, async () => {
    throw new Error("get_attachment_content returned no file content");
  });
  assert.equal(none.isError, true);
});

test("open_file: every conversation has it; a url call is judged and a held-file call is free; its server is built with or without a mail source", () => {
  assert.equal(access(OPEN_TOOL, OWNER_CHAT), "judged", "the tool as a whole is a fetch; a call without a url is free (below)");
  assert.equal(access(OPEN_TOOL, GROUP_CHAT), "judged");
  assert.equal(classify(OPEN_TOOL, { url: "https://example.com/a.pdf" }, GROUP_CHAT), "ask");
  assert.equal(classify(OPEN_TOOL, { file: "file1", pages: "1-3" }, GROUP_CHAT), "allow");
  assert.ok(createFilesServer(OWNER_KEY));
  assert.ok(createFilesServer(OWNER_KEY, source(pdf())));
});

// open_file with a url is a page fetch like WebFetch (an address can carry data out): judged, vetoed unless plain, audited with its url. A held file or a mail attachment is free.
test("open_file: a url is judged like WebFetch (clean run and untrusted run), a held file is not, and the audit carries the url", async () => {
  const opts = { signal: new AbortController().signal } as never;
  scopeOf("owner").say("what does the council report say about bins");
  for (const untrusted of [false, true]) {
    const seen: unknown[] = [];
    let asked = 0;
    const judge = async (i: never): Promise<Verdict> => (seen.push(i), { decision: "auto", reason: "test" });
    const can = makeCanUseTool(async () => (asked++, { approved: true }), OWNER_CHAT, undefined, judge as never, undefined, undefined, false, { ...CHAT, untrusted });
    const plain = `https://example.org/${untrusted ? "u" : "c"}/report.pdf`;
    assert.equal((await can(OPEN_TOOL, { url: plain }, opts))!.behavior, "allow");
    assert.deepEqual([seen.length, asked, (seen[0] as { untrustedInput: boolean }).untrustedInput], [1, 0, untrusted], "a plain address is judged");
    for (const bad of ["http://example.org/a.pdf", "https://example.org/a.pdf?d=" + "x".repeat(130), "https://192.168.1.4/a.pdf"]) assert.equal((await can(OPEN_TOOL, { url: bad }, opts))!.behavior, "allow", "asked, and the owner said yes");
    assert.deepEqual([seen.length, asked], [1, 3], "a non-plain address is never judged: the owner is asked");
    assert.equal((await can(OPEN_TOOL, { file: "file1", query: "bins" }, opts))!.behavior, "allow");
    assert.equal((await can(OPEN_TOOL, { messageId: 1, attachmentId: "a" }, opts))!.behavior, "allow");
    assert.deepEqual([seen.length, asked], [1, 3], "a held file or an attachment is neither judged nor asked");
    assert.equal(readAudit((e) => e.tool === OPEN_TOOL && (e.meta?.args as { url?: string } | undefined)?.url === plain).length > 0, true, "the url is in the audit");
  }
});
