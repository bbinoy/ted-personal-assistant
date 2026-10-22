import { localDay } from "../core/pause.ts";
import type { HeartbeatRow } from "../core/looks.ts";

// `npm run heartbeat-report [days]`: what the heartbeat run did for every conversation, from its rows (the looks table of instance.db): counts and dollars, never words or names.

const BUCKETS: readonly (readonly [string, number, number])[] = [["10-14 min", 10, 14], ["15-29 min", 15, 29], ["30-59 min", 30, 59], ["60-120 min", 60, 120]];
const usd = (n: number) => `$${n.toFixed(2)}`;

// Pure: the report for the rows of the last `days` days (local days), as lines.
export function heartbeatReport(rows: readonly HeartbeatRow[], now: Date, days = 7): string[] {
  const since = new Date(now);
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));
  const mine = rows.filter((r) => Date.parse(r.at) >= since.getTime());
  if (mine.length === 0) return [`No heartbeat looks in the last ${days} day(s).`];

  const byDay = new Map<string, HeartbeatRow[]>();
  for (const r of mine) byDay.set(localDay(new Date(r.at)), [...(byDay.get(localDay(new Date(r.at))) ?? []), r]);
  const sum = (rs: readonly HeartbeatRow[], f: (r: HeartbeatRow) => number) => rs.reduce((n, r) => n + f(r), 0);
  const lines = [`Heartbeat run, last ${days} day(s): ${mine.length} look(s) on ${byDay.size} day(s)`, "", "day         looks  msgs  night  failed  tools  archived  cost"];
  for (const [day, rs] of [...byDay].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const n = (f: (r: HeartbeatRow) => boolean) => rs.filter(f).length;
    lines.push(`${day}  ${String(rs.length).padStart(5)}  ${String(n((r) => r.message)).padStart(4)}  ${String(n((r) => r.message && r.night)).padStart(5)}  ${String(n((r) => r.outcome === "failed" || r.outcome === "timeout")).padStart(6)}  ${String(sum(rs, (r) => r.toolCalls)).padStart(5)}  ${String(sum(rs, (r) => r.archived)).padStart(8)}  ${usd(sum(rs, (r) => r.costUsd))}`);
  }
  const cost = sum(mine, (r) => r.costUsd);
  lines.push("", `cost: ${usd(cost)} in total, ${usd(cost / byDay.size)} per day with looks`);
  lines.push(`messages: ${mine.filter((r) => r.message).length} sent (${mine.filter((r) => r.message && r.night).length} at night), ${(mine.filter((r) => r.message).length / byDay.size).toFixed(1)} per day`);
  lines.push(`delegations: ${sum(mine, (r) => r.delegations)}; mail archived: ${sum(mine, (r) => r.archived)}; tool calls: ${sum(mine, (r) => r.toolCalls)}`);
  const timeouts = mine.filter((r) => r.outcome === "timeout").length;
  if (timeouts > 0) lines.push(`failed looks: ${mine.filter((r) => r.outcome === "failed").length + timeouts}, of which ${timeouts} timed out (the run was aborted at HEARTBEAT_TIMEOUT_MINUTES / EXPERT_TIMEOUT_MINUTES and the look retried on the next ticks)`);
  const kinds = (["owner", "group", "tenant"] as const).map((k) => [k, mine.filter((r) => (r.kind ?? "owner") === k)] as const).filter(([, rs]) => rs.length > 0);
  if (kinds.length > 1) lines.push(`by conversation: ${kinds.map(([k, rs]) => `${k === "tenant" ? "friends" : k === "group" ? "groups" : "owner"} ${rs.length} look(s), ${rs.filter((r) => r.message).length} message(s), ${usd(sum(rs, (r) => r.costUsd))}`).join("; ")}`);
  lines.push("", "the next look it chose:");
  for (const [label, lo, hi] of BUCKETS) lines.push(`  ${label.padEnd(10)} ${mine.filter((r) => r.nextCheckMinutes >= lo && r.nextCheckMinutes <= hi).length}`);
  return lines;
}
