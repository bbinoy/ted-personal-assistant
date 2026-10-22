// The identity of a tool call: its tool and its arguments with the keys sorted at every depth, so the same call written in another key order is the same call. Used by the anti-repeat
// state (approvals/permissions.ts) and by the journal, which pairs a decision (why) with the call's success (what) by it (core/events.ts).
// Keys sorted at every depth. (A JSON.stringify key-list replacer also filters NESTED keys, so two events that differ only
// in start.dateTime had the same key and the second was refused as "already done".)
const stable = (v: unknown): unknown => (Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, stable(x)])) : v);
export const callKey = (tool: string, input: Record<string, unknown>) => `${tool} ${JSON.stringify(stable(input))}`;
