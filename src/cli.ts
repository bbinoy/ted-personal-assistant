import "./core/requirelayout.ts"; // first: an old or newer data folder stops the tool with a sentence (npm run migrate)
import { readAudit } from "./core/audit.ts";
import { entryFor } from "./policy/toolmanifest.ts";
import { mailRuntime } from "./modules/runtime.ts";
import { localTime } from "./core/pause.ts";
import { doctor } from "./doctor.ts";
import { settings } from "./core/settings.ts";
import { agreement } from "./approvals/autojudge.ts";
import { APPROVAL_DECISIONS, approvalLines } from "./approvals/approvalreport.ts";

// Small operator tools:
//   npm run report [hours]        what was archived, which actions the judge let through, how approvals went (default 24h)
//   npm run restore <id>          put an archived conversation back in the inbox
//   npm run doctor                is everything the agent depends on in place?
//   npm run heartbeat-report [d]  what the heartbeat run did in the last d days (scripts/heartbeat-report.ts)


// What the approval judge (src/approvals/autojudge.ts) did: the actions it let through without asking the owner (newest last), and how its "ask" verdicts
// compared with the owner's own answers.
function judgeSummary(hours: number) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const skipped = readAudit((e) => e.decision === "auto-approved" && e.ts > since);
  const rows = readAudit((e) => e.decision === "judge-vs-owner" && e.ts > since).map((e) => ({ judge: e.meta?.judge as "auto" | "ask", ownerApproved: Boolean(e.meta?.ownerApproved) }));
  if (rows.length === 0 && skipped.length === 0) return;
  console.log(`\nApproval judge (AUTO_APPROVE=${settings.autoApprove}), last ${hours}h:`);
  if (skipped.length) {
    console.log(`  ${skipped.length} action(s) went ahead without asking you:`);
    for (const e of skipped.slice(-15)) console.log(`    ${localTime(e.ts)}  ${e.source}  ${e.tool.split("__").pop()}  ${String(e.meta?.reason ?? "").slice(0, 100)}`);
  }
  if (rows.length) {
    const a = agreement(rows);
    console.log(`  ${a.total} question(s) were put to you; you approved ${a.judgedAskOwnerApproved} of the ones it flagged (asked needlessly), and ${a.autoOwnerDeclined} it would have let through you declined`);
  }
}

function approvalSummary(hours: number) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const lines = approvalLines(readAudit((e) => e.ts > since && APPROVAL_DECISIONS.includes(e.decision)));
  if (lines.length) console.log(`\nApprovals: question vs arguments (last ${hours}h)\n${lines.join("\n")}`);
}

// Mail the assistant archived (the heartbeat run, a chat turn, the brief): read from the audit log, which records the id of every archive call. `npm run restore <id>` puts one back.
function archiveSummary(hours: number) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = readAudit((e) => e.ts > since && ["allow", "auto-approved", "ask-approved"].includes(e.decision) && entryFor(e.tool)?.action === "archive");
  if (rows.length === 0) return console.log(`Nothing archived in the last ${hours}h.`);
  console.log(`Archived in the last ${hours}h (${rows.length}); npm run restore <id> puts one back:`);
  for (const e of rows) console.log(`  ${localTime(e.ts)}  ${e.source}  ${String((e.meta?.ids as { conversationId?: unknown } | undefined)?.conversationId ?? "(id not recorded)")}`);
}

async function report(hours: number) {
  archiveSummary(hours);
  judgeSummary(hours);
  approvalSummary(hours);
}

// How an archived mail is put back is the mail provider's (its module, src/modules): it prints what happened and returns the exit code.
async function restore(id: string) {
  process.exit(await mailRuntime()!.restore(id)); // (mail off is refused below)
}

const [cmd, arg] = process.argv.slice(2);
if (!settings.mail && cmd === "restore") {
  console.error(`${cmd} needs mail, and mail is off (MAIL_PROVIDER=none).`);
  process.exit(1);
}
if (cmd === "report") await report(Number(arg ?? 24));
else if (cmd === "restore" && arg) await restore(arg);
else if (cmd === "doctor") await doctor();
else console.log("usage: npm run report [hours] | npm run restore <conversationId> | npm run doctor");
process.exit(0);
