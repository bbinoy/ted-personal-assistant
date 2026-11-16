import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BrowseGuard } from "../src/modules/browse/browseguard.ts";
import { fileCaptions } from "../src/modules/browse/browse.ts";
import { browserServer } from "../src/modules/browse/browseserver.ts";
import { HIDDEN_BROWSER_TOOLS, isAllowedBrowserTool } from "../src/modules/browse/browserules.ts";
import { adoptFile, dropShots, heldPath, MAX_FILES } from "../src/modules/send/shots.ts";

// The worker saves a page as a PDF (browser_pdf_save) and keeps a PDF a site downloads; code chooses the name, reads the bytes back, keeps real PDFs only.

const B = "mcp__browser__browser_";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n");
const guard = (outDir: string) => new BrowseGuard({ mode: "owner", task: "get the receipt", outDir, resolver: async () => ["93.184.216.34"] });

test("pdf_save is allowed, its file name is chosen by code inside the run folder", async () => {
  assert.equal(isAllowedBrowserTool(`${B}pdf_save`), true);
  assert.ok(!HIDDEN_BROWSER_TOOLS.includes(`${B}pdf_save`));
  const out = join(tmpdir(), "run-pdf");
  const g = guard(out);
  for (const filename of [undefined, "../../etc/x.pdf", "/etc/cron.d/x"]) {
    const d = await g.decide(`${B}pdf_save`, filename === undefined ? {} : { filename });
    assert.equal(d.kind, "defer");
    assert.equal(dirname(String(d.input?.filename)), out);
    assert.match(String(d.input?.filename), /page\d+\.pdf$/);
  }
});

test("the server is started with the pdf capability", () => {
  const cfg = browserServer({ ok: true, cli: "cli.js", exe: "chrome" }, mkdtempSync(join(tmpdir(), "srv-")), undefined, { cdpPort: 1, unproxiedForTest: true });
  assert.ok((cfg as { args: string[] }).args.includes("vision,pdf"));
});

test("a saved page and a download are kept as bytes; non-PDF bytes, other folders and links outside the run folder are not", async () => {
  const out = mkdtempSync(join(tmpdir(), "run-keep-"));
  try {
    const g = guard(out);
    const saved = join(out, "page1.pdf");
    writeFileSync(saved, PDF);
    const shaped = g.shape(`${B}pdf_save`, {}, `### Result\n- [Page as pdf](${saved})`);
    assert.match(shaped ?? "", /This is pdf1/);
    assert.equal(g.pdfs.length, 1);
    assert.deepEqual(g.pdfs[0]!.bytes, PDF);
    const dl = join(out, "receipt.pdf");
    writeFileSync(dl, PDF);
    g.shape(`${B}click`, {}, `### Events\n- Downloaded file receipt.pdf to "${dl}"`);
    assert.equal(g.pdfs.length, 2);
    assert.equal(g.pdfs[1]!.name, "receipt.pdf");
    g.shape(`${B}click`, {}, `### Events\n- Downloaded file receipt.pdf to "${dl}"`);
    assert.equal(g.pdfs.length, 2, "the same file is not kept twice");
    const fake = join(out, "fake.pdf");
    writeFileSync(fake, "<html>not a pdf</html>");
    g.shape(`${B}click`, {}, `### Events\n- Downloaded file fake.pdf to "${fake}"`);
    const outside = join(tmpdir(), "outside-run.pdf");
    writeFileSync(outside, PDF);
    g.shape(`${B}pdf_save`, {}, `### Result\n- [Page as pdf](${outside})`);
    g.shape(`${B}pdf_save`, {}, `### Result\n- [Page as pdf](../outside-run.pdf)`);
    rmSync(outside);
    assert.equal(g.pdfs.length, 2, "only real PDFs inside the run folder");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("the per-run count is the turn's file cap", async () => {
  const g = guard(join(tmpdir(), "run-cap"));
  for (let i = 0; i < MAX_FILES; i++) assert.equal((await g.decide(`${B}pdf_save`, {})).kind, "defer", String(i));
  assert.equal((await g.decide(`${B}pdf_save`, {})).kind, "deny");
});

test("adoption: kept PDFs become file ids of the conversation's turn, listed ones only, and a draft's file id becomes a path inside the turn folder", () => {
  const key = "g-pdf-adopt";
  try {
    assert.deepEqual(fileCaptions({ files: [{ id: "pdf2", caption: "The receipt" }, { id: "../x", caption: "bad" }] }), { pdf2: "The receipt" });
    const held = adoptFile(key, PDF, "Receipt (BK-1).pdf")!;
    assert.equal(held.id, "file1");
    const path = heldPath(key, "file1")!;
    assert.deepEqual(readFileSync(path), PDF);
    assert.equal(heldPath("g-other", "file1"), undefined, "another conversation's turn has no such file");
    assert.equal(heldPath(key, "file9"), undefined);
    dropShots(key);
    assert.equal(existsSync(path), false, "gone with the turn");
  } finally {
    dropShots(key);
  }
});
