// The fake open web of the end-to-end eval, for the built-in WebFetch: a local HTTPS server that serves the case's made-up pages. The run (the model, the floor, the judge) sees the page's public-looking address; only when
// the call is allowed does the guard (guard.ts) swap the address for this server's, so the real WebFetch tool runs end to end and reaches nothing but this process. A page the case does not have is refused, never
// fetched from the internet. The certificate is made for the run (openssl) and trusted by the run's process through NODE_EXTRA_CA_CERTS.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeWeb {
  certFile: string;
  hits: string[]; // the original addresses that were fetched
  searches: string[]; // the queries of the web searches the run made
  search(query: string): string; // what a web search answers: the case's own pages (title, address, snippet) that share a word with the query
  open(url: string): string | undefined; // a page opened without the network (a scripted perfect run), counted as a fetch
  rewrite(url: string): string | undefined; // the local address that serves this page, or undefined: the case has no such page
  close(): Promise<void>;
}

const textOf = (html: string) => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const SKIP = new Set(["the", "and", "for", "with", "that", "this", "from", "about", "check", "out", "all", "there", "website", "site", "page"]);

// The web search of the fake web. The built-in WebSearch runs at the provider and cannot be pointed at a local server, so the guard answers it from here (guard.ts): the case's pages that share a word with the query, best first.
export function searchPages(pages: Record<string, string>, query: string): string {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((w) => !SKIP.has(w));
  const found = Object.entries(pages)
    .map(([url, html]) => ({ url, title: /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? url, body: textOf(html) }))
    .map((p) => ({ ...p, score: words.filter((w) => `${p.title} ${p.url} ${p.body}`.toLowerCase().includes(w)).length }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  if (!found.length) return `No results for "${query}".`;
  return `Web search results for "${query}":\n\n${found.map((p, i) => `${i + 1}. ${p.title}\n${p.url}\n${p.body.slice(0, 160)}...`).join("\n\n")}`;
}

export async function startFakeWeb(pages: Record<string, string>): Promise<FakeWeb> {
  const dir = mkdtempSync(join(tmpdir(), "ted-e2e-web-"));
  const keyFile = join(dir, "key.pem");
  const certFile = join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const urls = Object.keys(pages);
  const hits: string[] = [];
  const searches: string[] = [];
  const server: Server = createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (req, res) => {
    const original = urls[Number(/^\/p(\d+)/.exec(req.url ?? "")?.[1])];
    if (original === undefined) return void res.writeHead(404).end("not found");
    hits.push(original);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(pages[original]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    certFile,
    hits,
    searches,
    search: (query) => (searches.push(query), searchPages(pages, query)),
    open: (url) => (pages[url] === undefined ? undefined : (hits.push(url), pages[url])),
    rewrite: (url) => {
      const i = urls.indexOf(url.split("#")[0]!);
      return i < 0 ? undefined : `https://127.0.0.1:${port}/p${i}`;
    },
    close: () => new Promise<void>((resolve) => (server.close(() => (rmSync(dir, { recursive: true, force: true }), resolve())), server.closeAllConnections())),
  };
}
