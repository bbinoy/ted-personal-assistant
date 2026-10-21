import { appendRow, type HeartbeatRow } from "../looks.ts";
import type { Event, Sink } from "../events.ts";

// The metrics sink: the `looks` table of instance.db, one row of counts per heartbeat look (core/looks.ts). Counts and flags only, never a word.

// Pure: the metrics rows an event stands for.
export const project = (e: Event): HeartbeatRow[] => (e.type === "look" ? [e.row] : []);

export const metricsSink: Sink = {
  name: "metrics",
  handle(e) {
    for (const r of project(e)) appendRow(r); // (never throws: a look's record is a nicety)
  },
};
