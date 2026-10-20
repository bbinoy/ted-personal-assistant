// Manual smoke test of the browse tool against real public pages (costs a little: two model runs). Not part of npm test.
//   npm run browse:smoke            runs the first two (example, form); also: submit, big
//   npm run browse:smoke -- example only the first
// Commit steps are DECLINED here (the approval callback says no), so the form is filled but never submitted.
import { browseRunner } from "../src/run/agentrun.ts";
import { readAudit } from "../src/core/audit.ts";
import { browse } from "../src/modules/browse/browse.ts";
import { browseStatus } from "../src/modules/browse/browseserver.ts";
import { settings } from "../src/core/settings.ts";

const status = browseStatus();
if (!status.ok) {
  console.error(`browse is not set up: ${status.reason}`);
  process.exit(1);
}

const TASKS: Record<string, string> = {
  example: "Open https://example.com and tell me the page's heading and the target of its only link. Then stop.",
  form: "Open https://httpbin.org/forms/post. Fill in the pizza order form with customer name Ann Example, telephone 555-0101 (a made-up number), e-mail ann@example.org, size Medium and the topping Mushroom, then STOP before submitting: do not press the submit button. Report which fields you filled and what the submit button is called.",
  submit: "Open https://httpbin.org/forms/post, fill in customer name Ann Example and the size Medium, and submit the order.", // the submit click is a commit step: asked, declined here
  big: "Open https://en.wikipedia.org/wiki/List_of_countries_by_population_(United_Nations) and tell me the population of Iceland in the table. Use browser_find if the page view is cut.", // a big page view
};
const which = process.argv[2] ? [process.argv[2]] : ["example", "form"];

const approvals: string[] = [];
const decline = async (description: string) => {
  approvals.push(description);
  console.log(`\n--- ASKED (declined by the smoke script) ---\n${description}\n---`);
  return { approved: false };
};

for (const name of which) {
  const task = TASKS[name];
  if (!task) throw new Error(`unknown task ${name}`);
  const since = new Date().toISOString();
  const t0 = Date.now();
  const text = await browse({ mode: "owner", run: browseRunner("owner", decline) }, task);
  const seconds = Math.round((Date.now() - t0) / 1000);
  const rows = readAudit((e) => e.ts >= since && e.source === "browse");
  const views = rows.filter((r) => r.tool === "browse_view").map((r) => r.meta?.chars as number);
  const run = rows.filter((r) => r.tool === "browse_run").pop();
  console.log(`\n=== ${name}: ${seconds}s, ${rows.filter((r) => r.tool === "browse_step").length} browser step(s), cost $${Number(run?.meta?.costUsd ?? 0).toFixed(3)}, status ${run?.decision} ===`);
  console.log("tools used:", [...new Set(rows.filter((r) => r.tool === "browse_step").map((r) => r.meta?.tool))].join(", "));
  console.log("page views (chars):", views.join(", ") || "none", `(max ${Math.max(0, ...views)}; ~${Math.round(Math.max(0, ...views) / 4)} tokens)`);
  console.log("asked:", approvals.length, "| denied steps:", rows.filter((r) => r.decision === "deny").length);
  console.log(text);
}
console.log(`\nmodel: ${settings.model}`);
process.exit(0); // the approval judge keeps a warm process: end explicitly
