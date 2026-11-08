import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, PDFHexString, PDFName, StandardFonts } from "pdf-lib";
import { documentNote, prepareFile, type AudioTools } from "../src/conversation/document.ts";
import { PDF_WINDOW_PAGES } from "../src/conversation/pdfdoc.ts";
import { createFilesServer, keepLargePdfs, openedBlocks, openNow } from "../src/modules/files/filetool.ts";
import { fetchPublic, type Fetch } from "../src/modules/files/webfile.ts";
import { dropShots, loadFile } from "../src/modules/send/shots.ts";
import { userInput } from "../src/run/image.ts";

// open_file for every source and size of PDF: PDFs are generated here with pdf-lib (no fixtures). A short one is read whole, a long one gives facts, a search and page ranges.

const KEY = "g-pdf";
const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("\n");

// `pages` pages, page i saying lines[i] (a page without a line is blank: like a scan), with an outline of [title, page] entries.
async function makePdf(pages: number, lines: Record<number, string> = {}, outline: [string, number][] = []): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage();
    if (lines[i]) page.drawText(lines[i]!, { x: 40, y: 700, font, size: 12 });
  }
  if (outline.length) {
    const ctx = doc.context;
    const refs = doc.getPages().map((p) => p.ref);
    const items = outline.map(() => ctx.nextRef());
    const root = ctx.nextRef();
    outline.forEach(([title, page], i) =>
      ctx.assign(items[i]!, ctx.obj({ Title: PDFHexString.fromText(title), Parent: root, Dest: [refs[page - 1]!, PDFName.of("Fit")], ...(i > 0 ? { Prev: items[i - 1]! } : {}), ...(i < outline.length - 1 ? { Next: items[i + 1]! } : {}) })),
    );
    ctx.assign(root, ctx.obj({ Type: "Outlines", First: items[0]!, Last: items[items.length - 1]!, Count: outline.length }));
    doc.catalog.set(PDFName.of("Outlines"), root);
  }
  return Buffer.from(await doc.save());
}
const pageCount = async (b: Buffer) => (await PDFDocument.load(b)).getPageCount();
const web = (bytes: Buffer, name = "report.pdf") => async () => ({ name, bytes });

const LONG = 60;
const longLines: Record<number, string> = { 7: "Intro to the committee findings", 33: "Appendix on Cooking Fuel use in rural kitchens", 34: "More on kitchen stoves and cooking" };
const longPdf = () => makePdf(LONG, longLines, [["Introduction", 7], ["Annex B Energy", 33]]);

test("a short PDF is read whole, as before: one line, then the swap gives the whole document", async () => {
  const r = await openNow(KEY, { url: "https://example.org/small.pdf" }, undefined, web(await makePdf(3, { 1: "hello" }), "small.pdf"));
  assert.match(text(r), /^file1: small\.pdf, PDF, 3 pages\. Send it/);
  const blocks = (await openedBlocks(KEY, text(r))) as { type: string; source?: { data: string } }[];
  assert.equal(await pageCount(Buffer.from(blocks[0]!.source!.data, "base64")), 3);
  dropShots(KEY);
});

test("a long PDF gives facts and an outline, not the document; nothing is swapped in", async () => {
  const r = await openNow(KEY, { url: "https://example.org/report.pdf" }, undefined, web(await longPdf()));
  const t = text(r);
  assert.match(t, /^file1 is a large PDF.*"report\.pdf", 60 pages/);
  assert.match(t, /Text layer: on 3 of 60 pages/);
  assert.match(t, /Introduction - page 7/);
  assert.match(t, /Annex B Energy - page 33/);
  assert.match(t, /<pdf_outline>/);
  assert.equal(await openedBlocks(KEY, t), undefined);
  dropShots(KEY);
});

test("search finds the right pages, case-insensitive, several words, capped, with snippets fenced", async () => {
  await openNow(KEY, { url: "https://example.org/report.pdf" }, undefined, web(await longPdf()));
  const one = text(await openNow(KEY, { file: "file1", query: "COOKING" }));
  assert.match(one, /2 pages match/);
  assert.match(one, /page 33: .*Cooking Fuel/);
  assert.match(one, /page 34: /);
  assert.doesNotMatch(one, /page 7:/);
  assert.match(one, /<pdf_hits>/);
  const two = text(await openNow(KEY, { file: "file1", query: "cooking fuel" }));
  assert.match(two, /1 page match/);
  assert.match(text(await openNow(KEY, { file: "file1", query: "submarine" })), /No page has all of: submarine/);
  const wide = await makePdf(40, Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i + 1, "the word tea"])));
  await openNow(KEY, { url: "https://example.org/w.pdf" }, undefined, web(wide));
  assert.match(text(await openNow(KEY, { file: "file2", query: "tea" })), /40 pages match, the best 15 shown/);
  dropShots(KEY);
});

test("a page range returns a document of only those pages; bad ranges are refused", async () => {
  await openNow(KEY, { url: "https://example.org/report.pdf" }, undefined, web(await longPdf()));
  const r = await openNow(KEY, { file: "file1", pages: "33-35" });
  assert.match(text(r), /^file1 pages 33-35: /);
  const blocks = (await openedBlocks(KEY, text(r))) as { type: string; source?: { data: string } }[];
  const cut = Buffer.from(blocks[0]!.source!.data, "base64");
  assert.equal(await pageCount(cut), 3);
  const again = await openNow(KEY, { file: "file1", pages: "7" });
  assert.equal(await pageCount(Buffer.from(((await openedBlocks(KEY, text(again))) as { source: { data: string } }[])[0]!.source.data, "base64")), 1);
  for (const bad of ["0-3", "5-2", "58-61", "abc", `1-${PDF_WINDOW_PAGES + 1}`]) assert.equal((await openNow(KEY, { file: "file1", pages: bad })).isError, true, bad);
  assert.equal((await openNow(KEY, { file: "file9", pages: "1" })).isError, true, "no such file");
  dropShots(KEY);
});

test("a scanned-like PDF (no text) says so, and a search says to read page ranges", async () => {
  const r = await openNow(KEY, { url: "https://example.org/scan.pdf" }, undefined, web(await makePdf(PDF_WINDOW_PAGES + 5)));
  assert.match(text(r), /Text layer: none \(scanned/);
  assert.match(text(await openNow(KEY, { file: "file1", query: "anything" })), /no text layer/);
  dropShots(KEY);
});

test("the word search and pages only work on a PDF", async () => {
  await openNow(KEY, { url: "https://example.org/n.txt" }, undefined, web(Buffer.from("plain words"), "n.txt"));
  assert.match(text(await openNow(KEY, { file: "file1", query: "plain" })), /not a PDF/);
  dropShots(KEY);
});

// ---- the web ----

const answer = (status: number, body: Uint8Array | string = "", headers: Record<string, string> = {}) => new Response(body as never, { status, headers });
const resolver = (map: Record<string, string[]>) => async (host: string) => map[host] ?? ["93.184.216.35"];

test("web: a public https address is fetched, and the name comes from the path", async () => {
  const bytes = await makePdf(2);
  const seen: string[] = [];
  const fetch: Fetch = async (url) => (seen.push(url), answer(200, bytes));
  const got = await fetchPublic("https://files.example.org/a/Annual%20report.pdf", { fetch, resolve: resolver({}) });
  assert.equal(got.name, "Annual report.pdf");
  assert.deepEqual(got.bytes, bytes);
});

test("web: plain http, a private address, a local name, an IP literal and a bad port are refused before any request", async () => {
  let calls = 0;
  const fetch: Fetch = async () => (calls++, answer(200, "x"));
  const cases: [string, string[]?][] = [["http://example.org/a.pdf"], ["https://intranet.example.org/a.pdf", ["10.0.0.5"]], ["https://example.org/a.pdf", ["127.0.0.1"]], ["https://example.org/a.pdf", ["93.184.216.35", "192.168.1.9"]], ["https://192.168.1.4/a.pdf"], ["https://localhost/a.pdf"], ["https://example.org:22/a.pdf"], ["ftp://example.org/a.pdf"], ["https://user:pw@example.org/a.pdf"]];
  for (const [url, ips] of cases) await assert.rejects(fetchPublic(url, { fetch, resolve: async () => ips ?? ["93.184.216.35"] }), /Cannot open that address/, url);
  assert.equal(calls, 0);
});

test("web: a redirect is followed, and one to a private address or plain http is refused", async () => {
  const bytes = Buffer.from("%PDF-1.4 ok");
  const hops: Record<string, Response> = {
    "https://example.org/a": answer(302, "", { location: "/b" }),
    "https://example.org/b": answer(200, bytes),
    "https://example.org/c": answer(302, "", { location: "https://inside.example.org/secret" }),
    "https://example.org/d": answer(301, "", { location: "http://example.org/plain" }),
  };
  const fetch: Fetch = async (url) => hops[url]!;
  const resolve = resolver({ "inside.example.org": ["10.1.2.3"] });
  assert.equal((await fetchPublic("https://example.org/a", { fetch, resolve })).name, "b");
  await assert.rejects(fetchPublic("https://example.org/c", { fetch, resolve }), /private address/);
  await assert.rejects(fetchPublic("https://example.org/d", { fetch, resolve }), /only https/);
  const loop: Fetch = async () => answer(302, "", { location: "https://example.org/again" });
  await assert.rejects(fetchPublic("https://example.org/start", { fetch: loop, resolve }), /too many times/);
});

test("web: a file over 20 MB is refused, by its declared size or while streaming; an error status is said", async () => {
  const resolve = resolver({});
  await assert.rejects(fetchPublic("https://example.org/big", { resolve, fetch: async () => answer(200, "x", { "content-length": "30000000" }) }), /over 20 MB/);
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      c.enqueue(new Uint8Array(5_000_000));
    },
  });
  await assert.rejects(fetchPublic("https://example.org/endless", { resolve, fetch: async () => new Response(stream, { status: 200 }) }), /over 20 MB/);
  await assert.rejects(fetchPublic("https://example.org/gone", { resolve, fetch: async () => answer(404) }), /answered 404/);
});

test("open_file by address: a refused address is an error result, nothing is kept", async () => {
  const r = await openNow(KEY, { url: "http://example.org/a.pdf" }, undefined, (u) => fetchPublic(u, { resolve: resolver({}), fetch: async () => answer(200, "x") }));
  assert.equal(r.isError, true);
  assert.match(text(r), /only https/);
  assert.equal("problem" in loadFile(KEY, "file1"), true);
});

// ---- a PDF sent in the chat ----

const audio: AudioTools = { probe: async () => "not audio", transcribe: async () => "" };
const onDisk = (b: Buffer) => {
  const f = join(mkdtempSync(join(tmpdir(), "pdf-")), "att");
  writeFileSync(f, b);
  return f;
};

test("chat: a PDF over the window is not put in the prompt; it becomes file1 with the summary, and is searched like any other", async () => {
  const doc = await prepareFile(onDisk(await longPdf()), "Report.pdf", audio);
  assert.equal(doc.kind, "pdf");
  assert.ok(doc.kind === "pdf" && doc.large && doc.pages === LONG);
  assert.match(documentNote(doc), /60 pages: too long to attach.*file for this turn/);
  const told = await keepLargePdfs(KEY, [doc]);
  assert.match(told, /^file1 is a large PDF.*"Report\.pdf", 60 pages/);
  assert.match(text(await openNow(KEY, { file: "file1", query: "stoves" })), /page 34/);
  const input = userInput("question", [], [doc]);
  assert.equal(input, "question", "no document block");
  dropShots(KEY);
});

test("chat: a short PDF still goes whole into the prompt, and keepLargePdfs leaves it alone", async () => {
  const doc = await prepareFile(onDisk(await makePdf(3, { 1: "hi" })), "Short.pdf", audio);
  assert.ok(doc.kind === "pdf" && !doc.large && doc.data.length > 0);
  assert.equal(await keepLargePdfs(KEY, [doc]), "");
  assert.notEqual(typeof userInput("q", [], [doc]), "string");
  assert.equal("problem" in loadFile(KEY, "file1"), true);
});

test("the tool offers the mail attachment parameters only to a run that has a mail source (a group or a friend cannot name a message)", () => {
  const keys = (s?: Parameters<typeof createFilesServer>[1]) => Object.keys((createFilesServer(KEY, s).instance as unknown as { _registeredTools: Record<string, { inputSchema: { shape: object } }> })._registeredTools.open_file!.inputSchema.shape).sort();
  assert.deepEqual(keys(), ["file", "pages", "query", "url"]);
  assert.deepEqual(keys(async () => ({ bytes: Buffer.from("x") })), ["attachmentId", "file", "messageId", "pages", "query", "url"]);
});
