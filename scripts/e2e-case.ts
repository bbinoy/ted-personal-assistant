// One end-to-end case, one run, in its own process (scripts/e2e-eval.ts starts it with its own temporary HARNESS_DATA_DIR): the application reads its data folder and clock zone when it is loaded, so cases
// that run side by side must not share a process. The result goes to the file named by the last argument.
//   node --conditions=workspace-source scripts/e2e-case.ts <case id> <result file>
// Environment: HARNESS_DATA_DIR (the eval's temporary folder; refused otherwise), EVAL_FAKE=perfect (no model: a scripted run that tests the grading), EVAL_NOW (an ISO time to freeze the clock at; default: now, to the minute).
import { writeFileSync } from "node:fs";

process.env.TZ = "Europe/London"; // (before anything is loaded: the owner's conversation takes its zone from it)
process.env.ENABLE_CLAUDEAI_MCP_SERVERS = "false"; // the owner's claude.ai connectors (Gmail, Calendar, Notion, Drive) stay off; the SDK's start-up message is checked as well (e2e/guard.ts)

const [id, out] = process.argv.slice(2);
if (!id || !out) throw new Error("usage: e2e-case.ts <case id> <result file>");
const { CASES } = await import("./e2e/cases.ts");
const { play } = await import("./e2e/play.ts");
const c = CASES.find((x) => x.id === id);
if (!c) throw new Error(`no case ${id}`);
const now = process.env.EVAL_NOW ? new Date(process.env.EVAL_NOW) : new Date(Math.floor(Date.now() / 60_000) * 60_000);
const result = await play(c, { now, zone: "Europe/London", perfect: process.env.EVAL_FAKE === "perfect" });
writeFileSync(out, JSON.stringify({ ...result, now: now.toISOString() }, null, 1));
process.exit(0);
