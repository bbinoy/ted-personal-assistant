import "../src/core/requirelayout.ts";
import { heartbeatReport } from "../src/heartbeat/report.ts";
import { readRows } from "../src/heartbeat/rows.ts";

// npm run heartbeat-report [days]: what the owner's heartbeat run did (looks, messages by day and night, held ones, dollars, the next looks it chose), from
// the looks table of instance.db. Counts only: it holds no words.
const days = Number(process.argv[2] ?? 7);
if (!Number.isInteger(days) || days < 1 || days > 365) {
  console.error("usage: npm run heartbeat-report [days]");
  process.exit(1);
}
console.log(heartbeatReport(readRows(), new Date(), days).join("\n"));
