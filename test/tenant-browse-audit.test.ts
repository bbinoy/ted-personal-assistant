import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAudit } from "../src/core/audit.ts";
import type { Verdict } from "../src/approvals/autojudge.ts";
import { browse } from "../src/modules/browse/browse.ts";
import { BrowseGuard } from "../src/modules/browse/browseguard.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { settings } from "../src/core/settings.ts";
import { BROWSE_RUN } from "./runkinds.ts";

// A tenant's browse run: the audit log is the admin's, so its rows carry no words.

const opts = { signal: new AbortController().signal } as never;
type Seen = { description: string; provenance: { kind: string; by?: string; text?: string; message?: string; task?: string; browseTask?: string; assistantSaid?: string }; untrustedInput?: boolean };
const fake = (decision: Verdict["decision"] = "auto", reason = "test") => {
  const seen: Seen[] = [];
  return { seen, fn: (async (i: Seen): Promise<Verdict> => (seen.push(i), { decision, reason })) as never };
};
const setAuto = (mode: "auto" | "off") => void ((settings as { autoApprove: string }).autoApprove = mode);

const FORM = `### Page
- Page URL: https://clinic-secret.example/booking
### Snapshot
\`\`\`yaml
- generic [ref=e2]:
  - form "Booking" [ref=e70]:
    - textbox "Patient Anneliese" [ref=e5]
    - button "Book Dr Strange" [ref=e71]
\`\`\``;

test("a tenant's browse run: no host, control name, task or error text in the audit log (lengths only); the owner's rows are unchanged", async () => {
  setAuto("auto");
  const start = new Date().toISOString();
  const resolver = async () => ["93.184.216.34"];
  const sentinel = ["clinic-secret.example", "Book Dr Strange", "Anneliese", "root canal", "tooth-pain-task"];
  const run = async (tenant: boolean) => {
    const g = new BrowseGuard({ mode: "group", tenant, task: "book a root canal at Dr Strange for Anneliese tooth-pain-task", outDir: join(tmpdir(), "nope"), resolver });
    g.shape("mcp__browser__browser_snapshot", {}, FORM);
    const j = fake("ask", "Anneliese wants a root canal at clinic-secret.example");
    const can = makeCanUseTool(async () => ({ approved: false }), BROWSE_RUN, undefined, j.fn, g, undefined, tenant, { provenance: () => ({ kind: "member", message: "book a root canal for Anneliese" }), browseTask: g.task, untrusted: true });
    await can("mcp__browser__browser_navigate", { url: "https://clinic-secret.example/booking" }, opts);
    await can("mcp__browser__browser_click", { target: "e71" }, opts); // a commit step: the judge, then the question
    await can("mcp__browser__browser_navigate", { url: "http://127.0.0.1/admin" }, opts); // a refusal with the address in it
  };
  await run(true);
  const mine = readAudit((e) => e.ts >= start);
  assert.ok(mine.some((e) => e.tool === "browse_step"), "the guard's rows exist");
  assert.ok(mine.some((e) => e.decision.startsWith("judge-")), "and the judge's");
  const text = JSON.stringify(mine);
  for (const word of sentinel) assert.ok(!text.includes(word), `"${word}" is in the audit log`);
  assert.match(text, /"hostChars":\d+/);
  assert.match(text, /"nameChars":\d+/);
  // browse.ts: the failure of a tenant's run
  const before = new Date().toISOString();
  await browse({ mode: "group", groupId: "g-t", tenant: true, run: async () => Promise.reject(new Error("could not reach clinic-secret.example")) }, "book a root canal for Anneliese", { status: { ok: true, cli: "cli.js", exe: "chrome" }, resolver });
  const after = JSON.stringify(readAudit((e) => e.ts >= before));
  assert.ok(!after.includes("clinic-secret"), "the error text is a length");
  assert.match(after, /"errorChars":\d+/);
  // the owner's rows keep their words (the owner reads her own log)
  const ownerStart = new Date().toISOString();
  await run(false);
  assert.match(JSON.stringify(readAudit((e) => e.ts >= ownerStart)), /clinic-secret\.example/);
});
