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
  rewrite(url: string): string | undefined; // the local address that serves this page, or undefined: the case has no such page
  close(): Promise<void>;
}

export async function startFakeWeb(pages: Record<string, string>): Promise<FakeWeb> {
  const dir = mkdtempSync(join(tmpdir(), "ted-e2e-web-"));
  const keyFile = join(dir, "key.pem");
  const certFile = join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const urls = Object.keys(pages);
  const hits: string[] = [];
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
    rewrite: (url) => {
      const i = urls.indexOf(url.split("#")[0]!);
      return i < 0 ? undefined : `https://127.0.0.1:${port}/p${i}`;
    },
    close: () => new Promise<void>((resolve) => (server.close(() => (rmSync(dir, { recursive: true, force: true }), resolve())), server.closeAllConnections())),
  };
}
