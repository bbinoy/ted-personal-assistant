import { readAudit } from "./audit.ts";
import { readTriageSince } from "./digest.ts";
import { newMailSource, triageCheck } from "./heartbeat.ts";
import { mailSlot } from "./modules/index.ts";
import { mailRuntime } from "./modules/runtime.ts";
import { localTime } from "./pause.ts";
import { doctor } from "./doctor.ts";
import { settings } from "./settings.ts";
import { agreement } from "./autojudge.ts";
import { APPROVAL_DECISIONS, approvalLines } from "./approvalreport.ts";

// Small operator tools:
//   npm run report [hours]        what the heartbeat archived / alerted / queued (default 24h)
//   npm run restore <id>          put an archived conversation back in the inbox
//   npm run doctor                is everything the agent depends on in place?
//   npm run triage-check [n]      how the heartbeat would classify the newest n emails (acts on nothing)


// What the approval judge (src/autojudge.ts) did: the actions it let through without asking the owner (newest last), and how its "ask" verdicts
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

async function report(hours: number) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = readTriageSince(since);
  if (rows.length === 0) {
    console.log(`Nothing triaged in the last ${hours}h.`);
    judgeSummary(hours);
    return approvalSummary(hours);
  }
  const note = mailSlot()?.reportNote();
  if (note) console.log(note);
  const order = ["archived", "would-archive", "alerted", "kept-no-handler", "covered-by-brief", "queued-for-handler", "archive-deferred", "archive-failed", "alert-failed", "handler-queue-failed", "kept"];
  const decisions = [...order, ...new Set(rows.map((e) => e.decision).filter((d) => !order.includes(d)))];
  for (const decision of decisions) {
    const set = rows.filter((e) => e.decision === decision);
    if (set.length === 0) continue;
    console.log(`\n${decision} (${set.length})`);
    for (const e of set) {
      console.log(`  ${localTime(e.ts)}  ${(e.meta?.from ?? "").slice(0, 28).padEnd(28)} ${(e.meta?.subject ?? "").slice(0, 60).padEnd(60)} [${e.meta?.kind}] ${decision === "archived" ? e.meta?.id : ""}`);
    }
  }
  judgeSummary(hours);
  approvalSummary(hours);
}

// How an archived mail is put back is the mail provider's (its module, src/modules): it prints what happened and returns the exit code.
async function restore(id: string) {
  process.exit(await mailRuntime()!.restore(id)); // (mail off is refused below)
}

const [cmd, arg] = process.argv.slice(2);
if (!settings.mail && (cmd === "restore" || cmd === "triage-check")) {
  console.error(`${cmd} needs mail, and mail is off (MAIL_PROVIDER=none).`);
  process.exit(1);
}
if (cmd === "report") await report(Number(arg ?? 24));
else if (cmd === "restore" && arg) await restore(arg);
else if (cmd === "doctor") await doctor();
else if (cmd === "triage-check") {
  const rows = await triageCheck(newMailSource(), Number(arg ?? 10));
  for (const r of rows) console.log(`${r.action.padEnd(8)} ${r.label.padEnd(10)} ${r.kind.padEnd(16)} ${r.from.slice(0, 24).padEnd(24)} ${r.subject.slice(0, 50).padEnd(50)} ${r.reason}`);
}
else console.log("usage: npm run report [hours] | npm run restore <conversationId> | npm run doctor | npm run triage-check [n]");
process.exit(0);
